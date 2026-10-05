import { describe, it, expect } from 'bun:test';
import { handleDecide, DECIDE_MAX_QUESTIONS, DECIDE_BATCH_CONCURRENCY, compactDecisionAnswers, formatDecisionError } from './decide.ts';
import type { SessionToolContext, DecisionToolCallbacks, DecisionToolRequest, DecisionToolResult, DecisionToolQuestion } from '../context.ts';

const QUESTIONS: Record<string, DecisionToolQuestion> = {
  topic: { type: 'choice', instructions: 'Which topic?', criteria: { billing: 'money', shipping: 'delivery', other: null } },
  urgent: { type: 'noul', instructions: 'Is it urgent?' },
};

function okResult(state: unknown): DecisionToolResult {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  const billing = text.includes('charge') ? 0.91234 : 0.05;
  return {
    ok: true,
    model: 'jev-1.13.0',
    answers: {
      topic: { type: 'choice', choice: billing > 0.5 ? 'billing' : 'shipping', confidence: 0.87654, probabilities: { billing, shipping: 1 - billing - 0.01, other: 0.01 } },
      urgent: { type: 'noul', noul: 0.33333 },
    },
    usage: { inputTokens: 100, outputTokens: 10 },
    latencyMs: 120,
    truncated: false,
  };
}

function createCtx(impl?: (request: DecisionToolRequest) => Promise<DecisionToolResult>): { ctx: SessionToolContext; requests: DecisionToolRequest[] } {
  const requests: DecisionToolRequest[] = [];
  const decide: DecisionToolCallbacks = {
    decide: async (request) => {
      requests.push(request);
      return impl ? impl(request) : okResult(request.state);
    },
  };
  return { ctx: { decide } as unknown as SessionToolContext, requests };
}

describe('decide handler', () => {
  it('degrades gracefully without the callback', async () => {
    const result = await handleDecide({} as unknown as SessionToolContext, { state: 'x', questions: QUESTIONS });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not enabled');
    expect(result.content[0]!.text).toContain('Settings > AI');
  });

  it('validates arguments before calling the model', async () => {
    const { ctx, requests } = createCtx();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ state: 'x', items: ['y'], questions: QUESTIONS }, 'not both'],
      [{ questions: QUESTIONS }, 'Provide state'],
      [{ state: 'x', questions: {} }, 'at least one'],
      [{ state: 'x', questions: Object.fromEntries(Array.from({ length: DECIDE_MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, QUESTIONS.urgent])) }, 'exceeds the limit'],
      [{ items: [], questions: QUESTIONS }, 'must not be empty'],
      [{ items: Array.from({ length: 201 }, () => 'x'), questions: QUESTIONS }, 'batch limit'],
    ];
    for (const [args, expected] of cases) {
      const result = await handleDecide(ctx, args as never);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(expected);
    }
    expect(requests).toHaveLength(0);
  });

  it('judges a single state and returns compact answers', async () => {
    const { ctx, requests } = createCtx();
    const result = await handleDecide(ctx, { state: 'Why was my card charged twice?', questions: QUESTIONS, deadlineMs: 2500 });
    expect(result.isError).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ state: 'Why was my card charged twice?', questions: QUESTIONS, deadlineMs: 2500 });

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.model).toBe('jev-1.13.0');
    expect(parsed.answers.topic).toEqual({ type: 'choice', choice: 'billing', confidence: 0.877, probabilities: { billing: 0.912, shipping: 0.078, other: 0.01 } });
    expect(parsed.answers.urgent).toEqual({ type: 'noul', noul: 0.333 });
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(parsed.latencyMs).toBe(120);
    expect(parsed.truncated).toBeUndefined();
  });

  it('uses the default deadline and flags truncation', async () => {
    const { ctx, requests } = createCtx(async (request) => ({ ...okResult(request.state), truncated: true } as DecisionToolResult));
    const result = await handleDecide(ctx, { state: { text: 'hello' }, questions: QUESTIONS });
    expect(requests[0]!.deadlineMs).toBe(10_000);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain('cut');
  });

  it('surfaces model failures with actionable hints', async () => {
    const { ctx } = createCtx(async () => ({ ok: false, error: { kind: 'unconfigured', message: 'no API key stored for OpenRouter' } }));
    const result = await handleDecide(ctx, { state: 'x', questions: QUESTIONS });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unconfigured');
    expect(result.content[0]!.text).toContain('Settings > AI');

    const thrown = createCtx(async () => { throw new Error('socket hang up'); });
    const thrownResult = await handleDecide(thrown.ctx, { state: 'x', questions: QUESTIONS });
    expect(thrownResult.isError).toBe(true);
    expect(thrownResult.content[0]!.text).toContain('socket hang up');
  });

  it('judges batches with bounded concurrency, in input order, tolerating partial failures', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 23 }, (_, i) => (i === 7 ? 'fail me' : i === 9 ? 'throw me' : i % 2 === 0 ? `charge ${i}` : { note: `delivery ${i}` }));
    const { ctx, requests } = createCtx(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      if (request.state === 'fail me') return { ok: false, error: { kind: 'timeout', message: 'too slow' } };
      if (request.state === 'throw me') throw new Error('socket hang up');
      if (request.state === 'charge 2') return { ...okResult(request.state), truncated: true } as DecisionToolResult;
      return okResult(request.state);
    });

    const result = await handleDecide(ctx, { items, questions: QUESTIONS });
    expect(result.isError).toBe(false);
    expect(requests).toHaveLength(23);
    expect(maxInFlight).toBeLessThanOrEqual(DECIDE_BATCH_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(requests.every(r => r.meta?.batch === true && r.meta?.total === 23)).toBe(true);

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.total).toBe(23);
    expect(parsed.succeeded).toBe(21);
    expect(parsed.failed).toBe(2);
    expect(parsed.model).toBe('jev-1.13.0');
    expect(parsed.usage).toEqual({ inputTokens: 2100, outputTokens: 210 });
    expect(parsed.truncatedItems).toBe(1);
    expect(parsed.results[2].truncated).toBe(true);
    expect(parsed.results[0].truncated).toBeUndefined();
    expect(parsed.results[9].error).toBe('unavailable: socket hang up');
    expect(parsed.results.map((r: { index: number }) => r.index)).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(parsed.results[0].answers.topic.choice).toBe('billing');
    expect(parsed.results[1].answers.topic.choice).toBe('shipping');
    expect(parsed.results[1].preview).toBe('{"note":"delivery 1"}');
    expect(parsed.results[7].error).toBe('timeout: too slow');
    expect(parsed.results[7].answers).toBeUndefined();
  });

  it('reports an error when every item in a batch fails', async () => {
    const { ctx } = createCtx(async () => ({ ok: false, error: { kind: 'rate_limited', message: 'slow down' } }));
    const result = await handleDecide(ctx, { items: ['a', 'b'], questions: QUESTIONS });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('rate_limited');
    expect(result.content[0]!.text).toContain('all 2 items failed');
  });

  it('compacts answers and drops the legend', () => {
    const compact = compactDecisionAnswers({
      sev: { type: 'score', score: 1.23456, confidence: 0.5, probabilities: { '0': 0.11111, '1': 0.88889 }, legend: { '0': 'a', '1': 'b' } },
    });
    expect(compact.sev).toEqual({ type: 'score', score: 1.235, confidence: 0.5, probabilities: { '0': 0.111, '1': 0.889 } });
    expect(formatDecisionError({ kind: 'timeout', message: 'x' })).toContain('deadlineMs');
  });
});
