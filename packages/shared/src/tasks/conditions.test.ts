import { describe, it, expect } from 'bun:test';

import { parseWhen } from './conditions.ts';
import type { NodeOutput } from './refs.ts';

const outputs: Record<string, NodeOutput> = {
  review: { text: 'ok', params: { verdict: 'approved', score: 4 } },
  audit: { text: 'fine', params: { ok: true, findings: 0 } },
};

function evaluate(expr: string, ctx: Record<string, NodeOutput> = outputs): boolean | string {
  const parsed = parseWhen(expr);
  if (typeof parsed === 'string') return parsed;
  return parsed.evaluate(ctx);
}

describe('when conditions', () => {
  it('compares a declared field to a literal', () => {
    expect(evaluate("review.verdict === 'approved'")).toBe(true);
    expect(evaluate("review.verdict === 'rejected'")).toBe(false);
    expect(evaluate("review.verdict !== 'rejected'")).toBe(true);
  });

  it('reads a number or boolean field without quotes', () => {
    expect(evaluate('review.score === 4')).toBe(true);
    expect(evaluate('audit.ok === true')).toBe(true);
    expect(evaluate('audit.findings === 0')).toBe(true);
    // No ordering operators: `>` is refused rather than silently misread as something else.
    expect(typeof evaluate('review.score > 3')).toBe('string');
  });

  it('combines with && and ||', () => {
    expect(evaluate("review.verdict === 'approved' && audit.ok === true")).toBe(true);
    expect(evaluate("review.verdict === 'rejected' || audit.ok === true")).toBe(true);
    expect(evaluate("review.verdict === 'rejected' && audit.ok === true")).toBe(false);
  });

  it('treats a bare field as a truthiness test', () => {
    expect(evaluate('audit.ok')).toBe(true);
    expect(evaluate('audit.findings')).toBe(false); // 0 is falsey
    expect(evaluate('!audit.ok')).toBe(false);
  });

  it('honours parentheses', () => {
    expect(evaluate("(review.verdict === 'no' || audit.ok === false) && review.score === 4")).toBe(false);
    expect(evaluate("(review.verdict === 'approved' || audit.ok === false) && review.score === 4")).toBe(true);
  });

  it('reports a missing value as false rather than throwing', () => {
    expect(evaluate("review.verdict === 'approved'", {})).toBe(false);
    expect(evaluate('review.verdict', {})).toBe(false);
    expect(evaluate('ghost.field === true', {})).toBe(false);
  });

  it('lists the fields it reads', () => {
    const parsed = parseWhen("review.verdict === 'approved' || audit.ok");
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') return;
    expect(parsed.refs).toEqual([
      { nodeId: 'review', field: 'verdict' },
      { nodeId: 'audit', field: 'ok' },
    ]);
  });

  it('refuses what it cannot parse instead of guessing a branch', () => {
    expect(evaluate('')).toContain('the condition is empty');
    expect(evaluate("review.verdict = 'approved'")).toContain('is not a comparison');
    expect(evaluate("review.verdict === 'approved")).toContain('unterminated string literal');
    expect(evaluate('review.verdict === ')).toContain('expected a node field or value');
    expect(evaluate('verdict')).toContain('is not a condition');
    expect(evaluate("review.verdict === 'a' and audit.ok")).toContain('is not a condition');
  });

  it('does not execute anything it is handed', () => {
    // The parser produces an AST; nothing here can reach the host. A JS-ish payload is junk:
    // `process.exit` reads as a field reference, and the call that follows it is refused.
    expect(evaluate('process.exit(1)')).toContain('unexpected trailing input');
    expect(evaluate('require("fs")')).toContain('is not a condition');
  });
});
