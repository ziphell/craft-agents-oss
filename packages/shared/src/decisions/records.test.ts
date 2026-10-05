import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionRecorder, buildDecisionRecord, summarizeDecisionAnswers } from './records.ts';
import { DecisionError, type DecisionQuestion, type DecisionResult } from './types.ts';

const STATE_TEXT = 'The customer asked for a refund and mentioned their card number 4111 1111 1111 1111';

const QUESTIONS: Record<string, DecisionQuestion> = {
  route: { type: 'choice', instructions: 'Where?', criteria: { billing: null, returns: null } },
  angry: { type: 'noul', instructions: 'Angry?' },
};

const RESULT: DecisionResult = {
  model: 'jev-1.13.0',
  modelReported: true,
  requestedModel: 'jev-1.13.0',
  answers: {
    route: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, returns: 0.1 } },
    angry: { type: 'noul', noul: 0.2 },
  },
  usage: { inputTokens: 100, outputTokens: 10 },
  latencyMs: 210,
  state: { sha256: 'abc', bytes: STATE_TEXT.length, truncated: false },
};

describe('decision records', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'craft-decisions-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes one JSON line per decision with digests, numbers and option keys — never the state', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') });
    await recorder.record({
      feature: 'decide_tool',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      questions: QUESTIONS,
      result: RESULT,
      sessionId: 'sess-1',
      meta: { items: 3, apiKey: 'should-not-appear', authorization: 'Bearer x' },
    });

    const lines = readFileSync(recorder.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.ok).toBe(true);
    expect(record.feature).toBe('decide_tool');
    expect(record.provider).toBe('typesafe');
    expect(record.model).toBe('jev-1.13.0');
    expect(record.responseModel).toBe('jev-1.13.0');
    expect(record.questions).toEqual({ route: 'choice', angry: 'noul' });
    expect(record.state).toEqual({ sha256: 'abc', bytes: STATE_TEXT.length, truncated: false });
    expect(record.answers.route).toEqual({ type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, returns: 0.1 } });
    expect(record.answers.angry).toEqual({ type: 'noul', noul: 0.2 });
    expect(record.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(record.sessionId).toBe('sess-1');
    expect(record.meta).toEqual({ items: 3, apiKey: '[REDACTED]', authorization: '[REDACTED]' });
    expect(lines[0]).not.toContain('refund');
    expect(lines[0]).not.toContain('4111');
    expect(lines[0]).not.toContain('should-not-appear');
  });

  it('omits responseModel when the server did not name the model', () => {
    const record = buildDecisionRecord({ feature: 'x', provider: 'custom', model: 'm', questions: QUESTIONS, result: { ...RESULT, modelReported: false } });
    expect(record.responseModel).toBeUndefined();
    expect(record.model).toBe('m');
  });

  it('records failures without provider detail (a gateway may echo the state in its error body)', () => {
    const leaky = new DecisionError('invalid_request', 'Decision provider rejected the request (HTTP 422)', {
      status: 422,
      detail: `Invalid value for state: ${STATE_TEXT}`,
    });
    const leakyRecord = buildDecisionRecord({ feature: 'decide_tool', provider: 'openrouter', model: 'typesafe/jev-1.13', questions: QUESTIONS, error: leaky });
    expect(leakyRecord.error).toEqual({ kind: 'invalid_request', message: 'Decision provider rejected the request (HTTP 422)', status: 422 });
    expect(JSON.stringify(leakyRecord)).not.toContain('refund');
    // ...while agents and users still get the detail
    expect(leaky.toFailure().message).toContain('Invalid value for state');
  });

  it('records failures with the failure kind and the state digest carried by the error', () => {
    const error = new DecisionError('timeout', 'Decision model did not answer within 1500 ms', {
      state: { sha256: 'def', bytes: 42, truncated: false },
    });
    const record = buildDecisionRecord({ feature: 'task_verdict', provider: 'openrouter', model: 'typesafe/jev-1.13', questions: QUESTIONS, error, latencyMs: 1500 });
    expect(record.ok).toBe(false);
    expect(record.error).toEqual({ kind: 'timeout', message: 'Decision model did not answer within 1500 ms' });
    expect(record.state).toEqual({ sha256: 'def', bytes: 42, truncated: false });
    expect(record.latencyMs).toBe(1500);
    expect(record.answers).toBeUndefined();

    const plain = buildDecisionRecord({ feature: 'x', provider: 'custom', model: 'm', questions: QUESTIONS, error: new Error('boom') });
    expect(plain.error).toEqual({ kind: 'unavailable', message: 'boom' });
    expect(plain.state).toBeNull();
  });

  it('rotates the log once it exceeds the size cap', async () => {
    const path = join(dir, 'decisions.jsonl');
    const recorder = new DecisionRecorder({ path, maxBytes: 200 });
    for (let i = 0; i < 3; i++) {
      await recorder.record({ feature: 'settings_test', provider: 'typesafe', model: 'jev-1.13.0', questions: QUESTIONS, result: RESULT });
    }
    expect(existsSync(join(dir, 'decisions.prev.jsonl'))).toBe(true);
    const current = readFileSync(path, 'utf8').trim().split('\n');
    expect(current.length).toBeGreaterThanOrEqual(1);
    expect(current.length).toBeLessThan(3);
  });

  it('never throws when the log cannot be written', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'a-file-not-a-dir', 'x', 'decisions.jsonl') });
    // Make the parent a file so mkdir fails
    await Bun.write(join(dir, 'a-file-not-a-dir'), 'x');
    await expect(recorder.record({ feature: 'x', provider: 'typesafe', model: 'm', questions: QUESTIONS, result: RESULT })).resolves.toBeDefined();
  });

  it('summarizes score answers without the legend text', () => {
    const summary = summarizeDecisionAnswers({
      sev: { type: 'score', score: 1.2, confidence: 0.6, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 }, legend: { '0': 'Cosmetic' } },
    });
    expect(summary.sev).toEqual({ type: 'score', score: 1.2, confidence: 0.6, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 } });
  });
});
