import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseTaskSpec, nodeDeps, nodeTitle, type TaskSpec } from './schema.ts';
import { extractRefs, interpolateRefs } from './refs.ts';
import { validateTaskSpec, validateTaskInput, materializeDeps, TASK_CAPS } from './validate.ts';
import { buildGeneratorPrompt, buildRepairPrompt } from './generator-prompt.ts';
import {
  parseTaskYaml,
  serializeTaskYaml,
  saveTaskSpec,
  loadTaskSpec,
  appendRunLog,
  readRunLog,
  writeNodeOutput,
  readNodeOutput,
  listTaskSlugs,
  type RunLogEntry,
} from './storage.ts';

/** A valid 3-node chain: audit → design → impl (the V1 acceptance shape). */
const CHAIN = {
  id: 'demo',
  title: 'Demo chain',
  goal: 'audit then design then implement',
  nodes: [
    { id: 'audit', prompt: 'Audit the code' },
    { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
    { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
  ],
  outputs: { result: '${nodes.impl.output}' },
};

function parsed(): TaskSpec {
  const r = parseTaskSpec(CHAIN);
  if (!r.success) throw new Error('fixture should parse');
  return r.data;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('parses a valid chain and applies defaults', () => {
    const r = parseTaskSpec(CHAIN);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.runner).toBe('conduct');
    expect(r.data.nodes[0]!.kind).toBe('session');
    expect(nodeDeps(r.data.nodes[1]!)).toEqual(['audit']);
    expect(nodeTitle(r.data.nodes[0]!)).toBe('audit'); // title falls back to id
  });

  it('normalizes the legacy `type` alias onto `kind`', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [{ id: 'dyn', type: 'orchestrator', prompt: 'expand' }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.nodes[0]!.kind).toBe('orchestrator');
    expect((r.data.nodes[0] as Record<string, unknown>).type).toBeUndefined();
  });

  it('requires a prompt on session nodes', () => {
    const r = parseTaskSpec({ id: 'x', title: 'X', goal: 'g', nodes: [{ id: 'a' }] });
    expect(r.success).toBe(false);
  });

  it('accepts an optional acceptance_criteria rubric', () => {
    const r = parseTaskSpec({ ...CHAIN, acceptance_criteria: 'The implementation must pass all tests.' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.acceptance_criteria).toBe('The implementation must pass all tests.');
  });

  it('accepts max_iterations at the cap and at zero, rejects above the cap', () => {
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 10 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 0 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 11 }).success).toBe(false);
  });

  it('accepts optional task-level sources and skills, rejecting empty slugs', () => {
    const r = parseTaskSpec({ ...CHAIN, sources: ['github', 'linear'], skills: ['commit'] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sources).toEqual(['github', 'linear']);
    expect(r.data.skills).toEqual(['commit']);
    expect(parseTaskSpec({ ...CHAIN, sources: [''] }).success).toBe(false);
  });

  it('rejects duplicate node ids', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'a', prompt: 'q' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid slug id', () => {
    const r = parseTaskSpec({ id: 'Bad Id', title: 'X', goal: 'g', nodes: [{ id: 'a', prompt: 'p' }] });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

describe('refs', () => {
  it('extracts node, field, and param references', () => {
    const refs = extractRefs('use ${nodes.audit.output} and ${nodes.design.output.score} with ${params.env}');
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ kind: 'node', nodeId: 'audit' });
    expect(refs[1]).toMatchObject({ kind: 'node', nodeId: 'design', field: 'score' });
    expect(refs[2]).toMatchObject({ kind: 'param', name: 'env' });
  });

  it('interpolates text, fields, and params; leaves unknown refs raw', () => {
    const out = interpolateRefs(
      'A=${nodes.a.output} B=${nodes.a.output.score} P=${params.env} M=${nodes.missing.output}',
      { nodeOutputs: { a: { text: 'hello', params: { score: 7 } } }, params: { env: 'prod' } },
    );
    expect(out).toBe('A=hello B=7 P=prod M=${nodes.missing.output}');
  });

  it('supports an onMissing fallback', () => {
    const out = interpolateRefs('X=${nodes.ghost.output}', { nodeOutputs: {} }, { onMissing: () => '<none>' });
    expect(out).toBe('X=<none>');
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('accepts a valid chain with no errors or warnings', () => {
    const res = validateTaskSpec(parsed());
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it('flags dangling depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['ghost'] }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('flags an unresolved node reference', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'see ${nodes.ghost.output}' }],
    });
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('warns when a referenced node is not listed in depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', prompt: 'uses ${nodes.a.output}' }, // no depends_on
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('does not list it in depends_on'))).toBe(true);
  });

  /**
   * A node's `writes:` is the prefix its patches will claim (plan §3.6), and the whole reason to
   * declare it is that two nodes in one run must not claim the same one: "who owns this file" is
   * what the write guard answers, and it cannot answer for an identity two nodes share.
   */
  it('accepts distinct writer identities, and refuses one that would make a patch name ambiguous', () => {
    const distinct = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'ui', prompt: 'p', writes: 'checkout-ui' },
        { id: 'api', prompt: 'p', writes: 'checkout-api' },
      ],
    });
    expect(distinct.errors).toHaveLength(0);

    // `ui-2` reads as writer `ui` plus a second patch with order 2: a name nobody can parse back.
    const ambiguous = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'ui', prompt: 'p', writes: 'ui-2' }],
    });
    expect(ambiguous.valid).toBe(false);
    expect(ambiguous.errors.some((e) => e.message.includes('not usable as a writer identity'))).toBe(true);
  });

  it('refuses the consolidator identity, which only a folded change layer writes', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'ui', prompt: 'p', writes: 'z' }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes("reserved for a prototype's folded changes"))).toBe(true);
  });

  it('refuses two nodes claiming one identity, however it is spelled', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'ui', prompt: 'p', writes: 'checkout-ui' },
        { id: 'ui-again', prompt: 'p', writes: 'Checkout-UI' },
      ],
    });
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.message.includes('declares the same writer identity as node "ui"')),
    ).toBe(true);
  });

  it('errors on an undeclared param reference but accepts a declared one', () => {
    const bad = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(bad.errors.some((e) => e.message.includes('undeclared task param "env"'))).toBe(true);

    const ok = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      params: [{ name: 'env' }],
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(ok.errors).toHaveLength(0);
  });

  it('errors when a reference reads a field the upstream node does not declare', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', depends_on: ['a'], prompt: 'uses ${nodes.a.output.score}' },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('does not declare'))).toBe(true);
  });

  it('accepts a structured reference the upstream node declares (node-level and task-level)', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p', outputs: [{ name: 'score', type: 'number' }] },
        { id: 'b', depends_on: ['a'], prompt: 'uses ${nodes.a.output.score}' },
      ],
      outputs: { final: '${nodes.a.output.score}' },
    });
    expect(res.errors).toHaveLength(0);
  });

  it('validates `when`: parses it, checks its references, and materializes them as edges', () => {
    const ok = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'review', prompt: 'p', outputs: [{ name: 'verdict' }] },
        { id: 'act', prompt: 'q', when: "review.verdict === 'approved'" }, // no depends_on on purpose
      ],
    });
    expect(ok.errors).toHaveLength(0);
    // Reading a node's field IS a dependency — the edge is materialized, not left to the author.
    expect(materializeDeps(ok.spec!).get('act')).toEqual(new Set(['review']));

    const unparsable = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', when: 'verdict approved' }],
    });
    expect(unparsable.errors.some((e) => e.message.includes('is not a condition'))).toBe(true);

    const undeclared = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'review', prompt: 'p' },
        { id: 'act', prompt: 'q', when: "review.verdict === 'approved'" },
      ],
    });
    expect(undeclared.errors.some((e) => e.message.includes('does not declare that output'))).toBe(true);

    const unknown = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'act', prompt: 'q', when: "ghost.verdict === 'approved'" }],
    });
    expect(unknown.errors.some((e) => e.message.includes('there is no node "ghost"'))).toBe(true);
  });

  it('requires a gate node to ask something, and to produce only the verdict', () => {
    const ok = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'draft', prompt: 'p' },
        { id: 'signoff', kind: 'approval', depends_on: ['draft'], prompt: 'Ship it?', outputs: [{ name: 'verdict' }] },
      ],
    });
    expect(ok.errors).toHaveLength(0);

    const noPrompt = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'signoff', kind: 'approval' }],
    });
    expect(noPrompt.errors.some((e) => e.message.includes('the question put to the person'))).toBe(true);

    const foreignOutput = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'signoff', kind: 'approval', prompt: 'Ship it?', outputs: [{ name: 'summary' }] }],
    });
    expect(foreignOutput.errors.some((e) => e.message.includes('a gate only ever produces "verdict"'))).toBe(true);
  });

  it('refuses the `approval:` flag instead of ignoring it', () => {
    // The flag used to parse and do nothing, which reads as a gate that never gates.
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', approval: true }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.suggestion?.includes('kind: approval'))).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p', depends_on: ['b'] },
        { id: 'b', prompt: 'q', depends_on: ['a'] },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['a'] }],
    });
    expect(res.errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  it('errors when loop.max exceeds the cap', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', loop: { until: 'DONE', max: TASK_CAPS.maxLoopIterations + 1 } }],
    });
    expect(res.errors.some((e) => e.message.includes('exceeds the cap'))).toBe(true);
  });

  it('warns on an unknown model', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', model: 'gpt-imaginary-9' }],
    });
    expect(res.warnings.some((w) => w.message.includes('not a known built-in model'))).toBe(true);
  });

  it('errors when the node count exceeds the cap', () => {
    const nodes = Array.from({ length: TASK_CAPS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, prompt: 'p' }));
    const res = validateTaskInput({ id: 'x', title: 'X', goal: 'g', nodes });
    expect(res.errors.some((e) => e.message.includes('exceeding the cap'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

describe('storage', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tasks-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a spec through task.yaml', () => {
    const spec = parsed();
    saveTaskSpec(root, spec);

    expect(listTaskSlugs(root)).toEqual(['demo']);

    const loaded = loadTaskSpec(root, 'demo');
    expect(loaded?.valid).toBe(true);
    expect(loaded?.spec?.id).toBe('demo');
    expect(loaded?.spec?.nodes.map((n) => n.id)).toEqual(['audit', 'design', 'impl']);
    expect(nodeDeps(loaded!.spec!.nodes[1]!)).toEqual(['audit']);
  });

  it('serializes to parseable yaml', () => {
    const yaml = serializeTaskYaml(parsed());
    const reparsed = parseTaskYaml(yaml);
    expect(reparsed.valid).toBe(true);
    expect(reparsed.spec?.title).toBe('Demo chain');
  });

  it('reports invalid yaml without throwing', () => {
    const res = parseTaskYaml(':\n  - [unbalanced');
    expect(res.valid).toBe(false);
    expect(res.errors[0]?.message).toContain('Invalid YAML');
  });

  it('appends and reads the run log in order', () => {
    const entries: RunLogEntry[] = [
      { t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: 'demo', runId: 'r1' },
      { t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'audit' },
      { t: '2026-06-07T00:00:02.000Z', kind: 'node-spawned', nodeId: 'audit', sessionId: 's-audit' },
      { t: '2026-06-07T00:00:03.000Z', kind: 'node-finished', nodeId: 'audit', sessionId: 's-audit', state: 'done' },
    ];
    for (const e of entries) appendRunLog(root, 'demo', 'r1', e);
    expect(readRunLog(root, 'demo', 'r1')).toEqual(entries);
  });

  it('writes and reads per-node output', () => {
    writeNodeOutput(root, 'demo', 'r1', 'audit', { text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'missing')).toBeNull();
  });
});

describe('generator-prompt', () => {
  it('instructs the model that every reference must resolve to a declared node', () => {
    const prompt = buildGeneratorPrompt('Decompose the goal', 'My task');
    expect(prompt).toContain('${nodes.<id>.output} reference MUST point to an `id` that you actually declare');
    expect(prompt).toContain('Goal: Decompose the goal');
    expect(prompt).toContain('Working title: My task');
  });

  it('tells the generator to give concurrent prototype writers distinct identities', () => {
    const prompt = buildGeneratorPrompt('Build two prototypes at once');

    expect(prompt).toContain('distinct `writes:` slug');
    expect(prompt).toContain('writes: checkout-ui');
  });

  it('points the critic at the brief, not only at the prototype checks', () => {
    const prompt = buildGeneratorPrompt('Produce the requirements for a checkout redesign');

    expect(prompt).toContain('reads the brief for itself');
    expect(prompt).toContain('about: requirement R-003');
    expect(prompt).toContain('no objection to the brief is left standing');
  });

  it('repair prompt lists each validation error and re-asserts the YAML-only contract', () => {
    const prompt = buildRepairPrompt([
      { path: 'nodes.design.inputs', message: 'Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"' },
      { path: 'root', message: 'second problem' },
    ]);
    expect(prompt).toContain('- nodes.design.inputs: Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"');
    expect(prompt).toContain('- root: second problem');
    expect(prompt).toContain('Output ONLY the YAML');
  });
});
