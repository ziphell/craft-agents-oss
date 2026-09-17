import { describe, it, expect } from 'bun:test';

import { buildOutputsContract, parseDeclaredOutputs, type OutputDecl } from './index.ts';

const verdict: OutputDecl[] = [{ name: 'verdict', type: 'string', enum: ['approved', 'rejected'] }];

describe('structured node outputs', () => {
  it('writes no contract for a node that declares nothing', () => {
    expect(buildOutputsContract(undefined)).toBe('');
    expect(buildOutputsContract([])).toBe('');
  });

  it('describes every declared field in the contract', () => {
    const text = buildOutputsContract([{ name: 'score', type: 'number' }, ...verdict]);
    expect(text).toContain('"score"');
    expect(text).toContain('"verdict"');
    expect(text).toContain('one of: approved, rejected');
  });

  it('leaves an output-less node completely untouched', () => {
    const parsed = parseDeclaredOutputs('just prose', undefined);
    expect(parsed.body).toBe('just prose');
    expect(parsed.params).toBeUndefined();
    expect(parsed.problems).toHaveLength(0);
  });

  it('files the block as params and strips it from the prose', () => {
    const parsed = parseDeclaredOutputs(
      'Looks good to me.\n\n```params\n{"verdict": "approved"}\n```\n',
      verdict,
    );
    expect(parsed.problems).toHaveLength(0);
    expect(parsed.params).toEqual({ verdict: 'approved' });
    expect(parsed.body).toBe('Looks good to me.');
  });

  it('coerces the near-misses a model produces', () => {
    const parsed = parseDeclaredOutputs(
      '```params\n{"score": "7", "ok": "true"}\n```',
      [{ name: 'score', type: 'number' }, { name: 'ok', type: 'boolean' }],
    );
    expect(parsed.params).toEqual({ score: 7, ok: true });
  });

  it('keeps only declared fields, dropping whatever else the model volunteered', () => {
    const parsed = parseDeclaredOutputs('```params\n{"verdict": "approved", "note": "extra"}\n```', verdict);
    expect(parsed.params).toEqual({ verdict: 'approved' });
  });

  it('reports a missing declared field', () => {
    const parsed = parseDeclaredOutputs('prose only', verdict);
    expect(parsed.params).toBeUndefined();
    expect(parsed.problems).toEqual(['no `params` block in the reply']);
  });

  it('reports a field the block left out', () => {
    const parsed = parseDeclaredOutputs(
      '```params\n{"score": 1}\n```',
      [{ name: 'score', type: 'number' }, { name: 'verdict' }],
    );
    expect(parsed.problems).toEqual(['missing declared output "verdict"']);
  });

  it('reports a malformed block and an enum violation', () => {
    expect(parseDeclaredOutputs('```params\n{not json}\n```', verdict).problems).toEqual([
      'the `params` block is not valid JSON',
    ]);
    expect(parseDeclaredOutputs('```params\n{"verdict": "maybe"}\n```', verdict).problems).toEqual([
      'output "verdict" must be one of: approved, rejected',
    ]);
  });

  it('uses the last block and strips the earlier ones too', () => {
    const parsed = parseDeclaredOutputs(
      'first\n\n```params\n{"verdict": "rejected"}\n```\nthen\n\n```params\n{"verdict": "approved"}\n```\n',
      verdict,
    );
    expect(parsed.params).toEqual({ verdict: 'approved' });
    expect(parsed.body).toBe('first\n\n\nthen'); // both blocks gone, the blank line between them left behind
  });
});
