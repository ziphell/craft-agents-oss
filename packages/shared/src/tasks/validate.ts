/**
 * Graph-level validation for task.yaml.
 *
 * Zod (schema.ts) covers field shapes; this covers the *graph*: acyclicity,
 * dangling depends_on, unresolved ${…} references, unknown models, loop caps,
 * and generous size backstops. Returns the shared ValidationResult so it feeds
 * the same linter surface as config validation.
 *
 * Two layers use this (architecture §7): generation-time (reject an over-limit
 * generated plan before any session spawns) and runtime (the Conductor refuses
 * to run an invalid hand-edited yaml).
 */
import type { ValidationIssue, ValidationResult } from '../config/validators.ts';
import { getModelById } from '../config/models.ts';
import { extractRefs } from './refs.ts';
import { parseWhen } from './conditions.ts';
import { CONSOLIDATED_WRITER, isValidWriterId } from '../prototypes/types.ts';
import { parseTaskSpec, nodeDeps, APPROVAL_VERDICT_FIELD, type TaskSpec, type TaskNode } from './schema.ts';

/** Generous structural backstops. Rarely bind; surface "too large — simplify", never silently truncate. */
export const TASK_CAPS = {
  maxNodes: 64,
  maxDepth: 24,
  maxWidth: 24,
  /** Hard ceiling on a loop's `max` (schema requires the field; this bounds it). */
  maxLoopIterations: 50,
} as const;

const TASK_FILE = 'task.yaml';

function err(path: string, message: string, suggestion?: string): ValidationIssue {
  return { file: TASK_FILE, path, message, severity: 'error', ...(suggestion ? { suggestion } : {}) };
}
function warn(path: string, message: string, suggestion?: string): ValidationIssue {
  return { file: TASK_FILE, path, message, severity: 'warning', ...(suggestion ? { suggestion } : {}) };
}
function result(errors: ValidationIssue[], warnings: ValidationIssue[]): ValidationResult {
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate an already-parsed TaskSpec's graph. Use validateTaskInput() if you
 * still hold raw (unparsed) data.
 */
export function validateTaskSpec(spec: TaskSpec): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const byId = new Map<string, TaskNode>();
  for (const node of spec.nodes) byId.set(node.id, node);

  const declaredParams = new Set((spec.params ?? []).map((p) => p.name));

  /** writer identity (lowercased) → the node that declared it, so one run never has two. */
  const seenWriters = new Map<string, string>();

  // Materialized dependency edges (explicit depends_on ∪ ref targets), for cycle + metrics.
  const deps = materializeDeps(spec);

  for (const node of spec.nodes) {
    const path = `nodes.${node.id}`;

    // Explicit depends_on.
    for (const dep of nodeDeps(node)) {
      if (dep === node.id) {
        errors.push(err(`${path}.depends_on`, `Node "${node.id}" depends on itself`));
        continue;
      }
      if (!byId.has(dep)) {
        errors.push(err(`${path}.depends_on`, `Node "${node.id}" depends on unknown node "${dep}"`));
        continue;
      }
    }

    // References in prompt + inputs → materialized edges + dangling-ref checks.
    const refStrings: string[] = [];
    if (node.prompt) refStrings.push(node.prompt);
    for (const ref of Object.values(node.inputs ?? {})) {
      refStrings.push(typeof ref === 'string' ? ref : ref.from);
    }
    for (const text of refStrings) {
      for (const ref of extractRefs(text)) {
        if (ref.kind === 'node') {
          if (ref.nodeId === node.id) {
            errors.push(err(`${path}.inputs`, `Node "${node.id}" references its own output`));
            continue;
          }
          if (!byId.has(ref.nodeId)) {
            errors.push(err(`${path}.inputs`, `Reference ${ref.raw} points to unknown node "${ref.nodeId}"`));
            continue;
          }
          if (ref.field) {
            // A structured reference resolves against the upstream node's `NodeOutput.params`,
            // which is exactly the set of fields that node declares in `outputs`. An undeclared
            // field can never be produced, so the token would reach the next prompt as a literal
            // "${…}" — refuse it here instead of at dispatch.
            const declared = new Set((byId.get(ref.nodeId)?.outputs ?? []).map((o) => o.name));
            if (!declared.has(ref.field)) {
              errors.push(
                err(
                  `${path}.inputs`,
                  `Reference ${ref.raw} reads field "${ref.field}", which node "${ref.nodeId}" does not declare`,
                  `Declare it under ${ref.nodeId}.outputs, or read the whole output with \${nodes.${ref.nodeId}.output}`,
                ),
              );
            }
          }
          if (!nodeDeps(node).includes(ref.nodeId)) {
            warnings.push(
              warn(
                `${path}.depends_on`,
                `Node "${node.id}" references "${ref.nodeId}" output but does not list it in depends_on`,
                `Add "${ref.nodeId}" to ${node.id}.depends_on so the edge is explicit`,
              ),
            );
          }
        } else if (!declaredParams.has(ref.name)) {
          errors.push(err(`${path}.inputs`, `Reference ${ref.raw} uses undeclared task param "${ref.name}"`));
        }
      }
    }

    // `when:` — a branch test over declared upstream fields. Parsed here so a malformed
    // condition is refused before any session spawns (a silently-false branch would run a node
    // nobody asked for), and its references are checked like any other reference.
    if (node.when) {
      const parsed = parseWhen(node.when, `${path}.when`);
      if (typeof parsed === 'string') {
        errors.push(err(`${path}.when`, parsed));
      } else {
        for (const ref of parsed.refs) {
          if (ref.nodeId === node.id) {
            errors.push(err(`${path}.when`, `Node "${node.id}" tests its own output`));
            continue;
          }
          const upstream = byId.get(ref.nodeId);
          if (!upstream) {
            errors.push(
              err(`${path}.when`, `Condition reads ${ref.nodeId}.${ref.field}, but there is no node "${ref.nodeId}"`),
            );
            continue;
          }
          if (!(upstream.outputs ?? []).some((o) => o.name === ref.field)) {
            errors.push(
              err(
                `${path}.when`,
                `Condition reads ${ref.nodeId}.${ref.field}, but node "${ref.nodeId}" does not declare that output`,
                `Declare it under ${ref.nodeId}.outputs`,
              ),
            );
          }
        }
      }
    }

    // A gate node (`kind: 'approval'`): a person answers it, so it needs a question to ask,
    // and its answer has a fixed shape — flagging the mismatches here beats discovering them
    // when a run is already parked waiting for someone.
    if (node.kind === 'approval') {
      if (!node.prompt?.trim()) {
        errors.push(
          err(`${path}.prompt`, `Approval node "${node.id}" has no prompt — it is the question put to the person`),
        );
      }
      for (const decl of node.outputs ?? []) {
        if (decl.name !== APPROVAL_VERDICT_FIELD) {
          errors.push(
            err(
              `${path}.outputs`,
              `Approval node "${node.id}" declares output "${decl.name}", but a gate only ever produces "${APPROVAL_VERDICT_FIELD}"`,
              `Read the decision downstream as \${nodes.${node.id}.output.${APPROVAL_VERDICT_FIELD}}`,
            ),
          );
        }
      }
    }
    if (node.approval !== undefined) {
      errors.push(
        err(
          `${path}.approval`,
          `\`approval:\` is not a way to declare a gate — nothing reads it`,
          `Use kind: approval on node "${node.id}"`,
        ),
      );
    }

    // A node's write identity (`writes:`, plan §3.6): the prefix its patches will claim. Three
    // things can be wrong, and the third is the real rule — two nodes declaring one identity
    // would make "who owns this file" unanswerable, which is what the declaration is for.
    if (node.writes !== undefined) {
      const writer = node.writes.trim();
      if (!isValidWriterId(writer)) {
        errors.push(
          err(
            `${path}.writes`,
            `"${node.writes}" is not usable as a writer identity`,
            'Use a slug that does not end in -<digits> (that would make a patch name ambiguous), e.g. checkout-ui',
          ),
        );
      } else if (writer.toUpperCase() === CONSOLIDATED_WRITER) {
        errors.push(
          err(
            `${path}.writes`,
            `"${writer}" is reserved for a prototype's folded changes`,
            'Pick another identity — the consolidator is written by the control plane only',
          ),
        );
      } else {
        const owner = seenWriters.get(writer.toLowerCase());
        if (owner) {
          errors.push(
            err(
              `${path}.writes`,
              `Node "${node.id}" declares the same writer identity as node "${owner}" ("${writer}")`,
              'Two nodes writing as one identity means neither owns its files — give them different ones',
            ),
          );
        } else {
          seenWriters.set(writer.toLowerCase(), node.id);
        }
      }
    }

    // Unknown model — warning, not error: custom/Pi models are discovered at
    // runtime and are absent from MODEL_REGISTRY, so a hard fail would be wrong.
    const model = node.model ?? spec.defaults?.model;
    if (model && !getModelById(model)) {
      warnings.push(
        warn(
          `${path}.model`,
          `Model "${model}" is not a known built-in model`,
          'Ensure an LLM connection provides this model, or use a built-in id',
        ),
      );
    }

    // Loop caps.
    if (node.loop && node.loop.max > TASK_CAPS.maxLoopIterations) {
      errors.push(err(`${path}.loop.max`, `Loop max ${node.loop.max} exceeds the cap of ${TASK_CAPS.maxLoopIterations}`));
    }
    if (node.loop?.else && !byId.has(node.loop.else)) {
      errors.push(err(`${path}.loop.else`, `loop.else points to unknown node "${node.loop.else}"`));
    }
  }

  // Task-level outputs: refs must resolve.
  for (const [name, refStr] of Object.entries(spec.outputs ?? {})) {
    for (const ref of extractRefs(refStr)) {
      if (ref.kind === 'node' && !byId.has(ref.nodeId)) {
        errors.push(err(`outputs.${name}`, `Output "${name}" references unknown node "${ref.nodeId}"`));
      }
      if (ref.kind === 'node' && byId.has(ref.nodeId) && ref.field) {
        // Same rule as node-level refs: the field has to be declared by the node that produces it.
        const declared = new Set((byId.get(ref.nodeId)?.outputs ?? []).map((o) => o.name));
        if (!declared.has(ref.field)) {
          errors.push(
            err(
              `outputs.${name}`,
              `Output "${name}" reads field "${ref.field}", which node "${ref.nodeId}" does not declare`,
              `Declare it under ${ref.nodeId}.outputs, or read the whole output with \${nodes.${ref.nodeId}.output}`,
            ),
          );
        }
      }
      if (ref.kind === 'param' && !declaredParams.has(ref.name)) {
        errors.push(err(`outputs.${name}`, `Output "${name}" references undeclared param "${ref.name}"`));
      }
    }
  }

  // Acyclicity + size metrics (depth/width meaningful only when acyclic).
  const cycle = findCycle(spec.nodes, deps);
  if (cycle) {
    errors.push(err('nodes', `Dependency cycle detected: ${cycle.join(' -> ')}`));
  } else {
    const { depth, width } = graphMetrics(spec.nodes, deps);
    if (depth > TASK_CAPS.maxDepth) {
      errors.push(err('nodes', `Graph depth ${depth} exceeds cap ${TASK_CAPS.maxDepth} — simplify the chain`));
    }
    if (width > TASK_CAPS.maxWidth) {
      errors.push(err('nodes', `Graph width ${width} exceeds cap ${TASK_CAPS.maxWidth} — reduce parallel fan-out`));
    }
  }

  if (spec.nodes.length > TASK_CAPS.maxNodes) {
    errors.push(
      err('nodes', `Task has ${spec.nodes.length} nodes, exceeding the cap of ${TASK_CAPS.maxNodes} — simplify the graph`),
    );
  }

  return result(errors, warnings);
}

/** Parse (Zod) + graph-validate raw data in one call. */
export function validateTaskInput(raw: unknown): ValidationResult & { spec?: TaskSpec } {
  const parsed = parseTaskSpec(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map<ValidationIssue>((issue) => ({
      file: TASK_FILE,
      path: issue.path.join('.') || 'root',
      message: issue.message,
      severity: 'error',
    }));
    return { valid: false, errors, warnings: [] };
  }
  const graph = validateTaskSpec(parsed.data);
  return { ...graph, spec: parsed.data };
}

// ---------------------------------------------------------------------------
// Graph utilities
// ---------------------------------------------------------------------------

/**
 * Build the materialized dependency edges for a spec: for each node, the set of
 * upstream node ids it depends on = explicit `depends_on` ∪ the node ids
 * referenced in its prompt/inputs ∪ the ones its `when` reads. Unknown targets and
 * self-edges are skipped (validation reports those separately). Shared by the validator
 * (cycle/metrics) and the Conductor (scheduling), so an input reference always implies an
 * edge — which for `when` is not a matter of taste: a branch test cannot be evaluated
 * before the node it reads has run.
 */
export function materializeDeps(spec: TaskSpec): Map<string, Set<string>> {
  const ids = new Set(spec.nodes.map((n) => n.id));
  const edges = new Map<string, Set<string>>();
  for (const node of spec.nodes) {
    const set = new Set<string>();
    const add = (dep: string) => {
      if (dep !== node.id && ids.has(dep)) set.add(dep);
    };
    for (const dep of nodeDeps(node)) add(dep);
    const refTexts: string[] = [];
    if (node.prompt) refTexts.push(node.prompt);
    for (const ref of Object.values(node.inputs ?? {})) refTexts.push(typeof ref === 'string' ? ref : ref.from);
    for (const text of refTexts) {
      for (const r of extractRefs(text)) if (r.kind === 'node') add(r.nodeId);
    }
    if (node.when) {
      const parsed = parseWhen(node.when);
      if (typeof parsed !== 'string') for (const ref of parsed.refs) add(ref.nodeId);
    }
    edges.set(node.id, set);
  }
  return edges;
}

/** Detect a cycle in the dependency graph; returns the cycle path or null. */
function findCycle(nodes: TaskNode[], deps: Map<string, Set<string>>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (c === WHITE) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = dfs(n.id);
      if (found) return found;
    }
  }
  return null;
}

/** Longest-chain depth (node count) + max nodes-per-level width. Acyclic graphs only. */
function graphMetrics(nodes: TaskNode[], deps: Map<string, Set<string>>): { depth: number; width: number } {
  const level = new Map<string, number>();
  function levelOf(id: string): number {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    let max = 0;
    for (const dep of deps.get(id) ?? []) max = Math.max(max, levelOf(dep) + 1);
    level.set(id, max);
    return max;
  }
  for (const n of nodes) levelOf(n.id);

  let depth = 0;
  const perLevel = new Map<number, number>();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    depth = Math.max(depth, l);
    perLevel.set(l, (perLevel.get(l) ?? 0) + 1);
  }
  let width = 0;
  for (const c of perLevel.values()) width = Math.max(width, c);
  return { depth: depth + 1, width };
}
