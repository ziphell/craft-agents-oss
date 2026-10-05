import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { SystemOneClient, prepareDecisionState, validateDecisionRequest, parseSystemOneResponse, clampDecisionDeadline } from './client.ts';
import { DecisionError, DECISION_MAX_DEADLINE_MS, DECISION_MIN_DEADLINE_MS, type DecisionFailureKind, type DecisionRequest } from './types.ts';

const API_KEY = 'sk-test-SECRET-1234567890';

const REQUEST: DecisionRequest = {
  state: 'My running shoes arrived in the wrong size. Can I swap them for a size 10?',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { returns: 'Exchanges, wrong or damaged items', shipping: 'Delivery problems', billing: 'Charges' },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the issue?',
      criteria: ['Cosmetic', 'Degraded with workaround', 'Blocking'],
    },
    wants_human: { type: 'noul', instructions: 'Is the customer asking for a human agent?' },
  },
};

const RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    department: { type: 'choice', choice: 'returns', confidence: 0.9, probabilities: { returns: 0.93, shipping: 0.05, billing: 0.02 } },
    severity: { type: 'score', score: 1.24, confidence: 0.64, legend: { '0': 'Cosmetic', '1': 'Degraded with workaround', '2': 'Blocking' }, probabilities: { '0': 0.0, '1': 0.76, '2': 0.24 } },
    wants_human: { type: 'noul', noul: 0.07 },
  },
  usage: { input_tokens: 328, output_tokens: 34 },
};

type Captured = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchStub(handler: (captured: Captured) => Response | Promise<Response>): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return handler(captured);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof SystemOneClient>[0]> = {}): SystemOneClient {
  return new SystemOneClient({ baseUrl: 'https://api.typesafe.ai', apiKey: API_KEY, model: 'jev-1.13.0', fetch: fetchImpl, ...overrides });
}

async function expectDecisionError(promise: Promise<unknown>, kind: DecisionFailureKind): Promise<DecisionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).kind).toBe(kind);
    return error as DecisionError;
  }
  throw new Error(`expected DecisionError(${kind})`);
}

describe('SystemOneClient.decide', () => {
  it('posts the System One wire format and returns typed answers', async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse(RESPONSE));
    const result = await client(fetch).decide(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toBe(REQUEST.state);
    expect(body.questions).toEqual(REQUEST.questions);

    expect(result.model).toBe('jev-1.13.0');
    expect(result.modelReported).toBe(true);
    expect(result.requestedModel).toBe('jev-1.13.0');
    expect(result.usage).toEqual({ inputTokens: 328, outputTokens: 34 });
    expect(result.answers.department).toEqual({ type: 'choice', choice: 'returns', confidence: 0.9, probabilities: { returns: 0.93, shipping: 0.05, billing: 0.02 } });
    expect(result.answers.severity).toMatchObject({ type: 'score', score: 1.24, confidence: 0.64, probabilities: { '0': 0, '1': 0.76, '2': 0.24 } });
    expect(result.answers.wants_human).toEqual({ type: 'noul', noul: 0.07 });
    expect(result.state.truncated).toBe(false);
    expect(result.state.sha256).toBe(createHash('sha256').update(REQUEST.state as string).digest('hex'));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends object state as JSON, adds preset headers, and honours a per-call model override', async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse({ ...RESPONSE, model: 'typesafe/jev-1.13' }));
    const c = client(fetch, { baseUrl: 'https://openrouter.ai/api/', model: 'typesafe/jev-1.13', extraHeaders: { 'X-Title': 'Craft Agents' } });
    const result = await c.decide({ ...REQUEST, state: { message: 'hi', order: { id: 'A-1' } }, model: 'typesafe/jev-1.13' });

    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Title']).toBe('Craft Agents');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.state).toEqual({ message: 'hi', order: { id: 'A-1' } });
    expect(result.model).toBe('typesafe/jev-1.13');
  });

  it('omits the Authorization header when no key is configured (local servers)', async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse(RESPONSE));
    await client(fetch, { apiKey: undefined, baseUrl: 'http://localhost:8080' }).decide(REQUEST);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('maps a deadline overrun to timeout', async () => {
    const { fetch } = fetchStub(({ init }) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const error = await expectDecisionError(client(fetch).decide({ ...REQUEST, deadlineMs: DECISION_MIN_DEADLINE_MS }), 'timeout');
    expect(error.message).toContain(`${DECISION_MIN_DEADLINE_MS} ms`);
    expect(error.state?.bytes).toBeGreaterThan(0);
  });

  it('maps HTTP statuses to failure kinds', async () => {
    const cases: Array<[number, DecisionFailureKind]> = [[401, 'auth'], [403, 'auth'], [402, 'auth'], [429, 'rate_limited'], [422, 'invalid_request'], [400, 'invalid_request'], [413, 'invalid_request'], [404, 'unavailable'], [529, 'unavailable'], [500, 'unavailable']];
    for (const [status, kind] of cases) {
      const { fetch } = fetchStub(() => jsonResponse({ error: { message: 'nope' } }, status));
      const error = await expectDecisionError(client(fetch).decide(REQUEST), kind);
      expect(error.status).toBe(status);
    }
  });

  it('never leaks the API key, and keeps provider text (which may echo the state) out of the recorded failure', async () => {
    const { fetch } = fetchStub(() => jsonResponse({ error: { message: `bad key ${API_KEY} for state ${REQUEST.state}` } }, 401));
    const error = await expectDecisionError(client(fetch).decide(REQUEST), 'auth');
    // Base message: fixed text, safe for records
    expect(error.message).toBe('Decision provider rejected the API key (HTTP 401)');
    // Provider detail: key scrubbed, state may be present — agents/users see it, records do not
    expect(error.detail).toBeDefined();
    expect(error.detail).not.toContain(API_KEY);
    expect(error.detail).toContain('[REDACTED]');
    expect(error.toFailure()).toEqual({ kind: 'auth', message: `${error.message}: ${error.detail}`, status: 401 });
    expect(error.toFailure({ includeDetail: false })).toEqual({ kind: 'auth', message: error.message, status: 401 });
    expect(error.toFailure({ includeDetail: false }).message).not.toContain(REQUEST.state as string);
  });

  it('caps server-controlled values echoed into details', async () => {
    const long = 'x'.repeat(500);
    const { fetch } = fetchStub(() => jsonResponse({
      ...RESPONSE,
      answers: { ...RESPONSE.answers, department: { ...RESPONSE.answers.department, choice: long } },
    }));
    const error = await expectDecisionError(client(fetch).decide(REQUEST), 'unavailable');
    expect(error.message).toContain('not offered');
    expect(error.message).not.toContain(long);
    expect(error.detail!.length).toBeLessThanOrEqual(80);
  });

  it('reports non-serializable state as invalid_request', async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse(RESPONSE));
    await expectDecisionError(client(fetch).decide({ ...REQUEST, state: { big: 10n } as unknown as Record<string, unknown> }), 'invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('maps network failures to unavailable', async () => {
    const { fetch } = fetchStub(() => { throw new TypeError('fetch failed'); });
    const error = await expectDecisionError(client(fetch).decide(REQUEST), 'unavailable');
    expect(error.message).toContain('Could not reach');
  });

  it('rejects malformed bodies, missing answers and unknown options as unavailable', async () => {
    const malformed = fetchStub(() => new Response('not json', { status: 200 }));
    await expectDecisionError(client(malformed.fetch).decide(REQUEST), 'unavailable');

    const missing = fetchStub(() => jsonResponse({ ...RESPONSE, answers: { department: RESPONSE.answers.department } }));
    const missingError = await expectDecisionError(client(missing.fetch).decide(REQUEST), 'unavailable');
    expect(missingError.message).toContain("no answer for question 'severity'");

    const unknownOption = fetchStub(() => jsonResponse({
      ...RESPONSE,
      answers: { ...RESPONSE.answers, department: { ...RESPONSE.answers.department, choice: 'legal' } },
    }));
    await expectDecisionError(client(unknownOption.fetch).decide(REQUEST), 'unavailable');

    const badNoul = fetchStub(() => jsonResponse({ ...RESPONSE, answers: { ...RESPONSE.answers, wants_human: { type: 'noul', noul: 'yes' } } }));
    await expectDecisionError(client(badNoul.fetch).decide(REQUEST), 'unavailable');
  });

  it('validates requests before sending anything', async () => {
    const { fetch, calls } = fetchStub(() => jsonResponse(RESPONSE));
    const c = client(fetch);
    await expectDecisionError(c.decide({ ...REQUEST, questions: {} }), 'invalid_request');
    await expectDecisionError(c.decide({ ...REQUEST, state: '   ' }), 'invalid_request');
    await expectDecisionError(c.decide({ state: 'x', questions: { q: { type: 'choice', instructions: 'pick', criteria: { only: null } } } }), 'invalid_request');
    await expectDecisionError(c.decide({ state: 'x', questions: { q: { type: 'score', instructions: 'rate', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) } } }), 'invalid_request');
    await expectDecisionError(c.decide({ state: 'x', questions: { q: { type: 'noul', instructions: '' } } }), 'invalid_request');
    await expectDecisionError(c.decide({ state: 'x', questions: { q: { type: 'maybe', instructions: 'x' } as never } }), 'invalid_request');
    expect(calls).toHaveLength(0);
  });
});

describe('prepareDecisionState', () => {
  it('keeps small states intact and digests the exact text sent', () => {
    const prepared = prepareDecisionState({ a: 1 }, 1024);
    expect(prepared.state).toEqual({ a: 1 });
    expect(prepared.digest).toEqual({ sha256: createHash('sha256').update('{"a":1}').digest('hex'), bytes: 7, truncated: false });
  });

  it('truncates oversized states to a marked string and reports the original size', () => {
    const big = 'é'.repeat(5_000); // 2 bytes each
    const prepared = prepareDecisionState(big, 1_000);
    expect(prepared.digest.truncated).toBe(true);
    expect(prepared.digest.originalBytes).toBe(10_000);
    expect(prepared.digest.bytes).toBeLessThanOrEqual(1_000);
    expect(typeof prepared.state).toBe('string');
    expect(prepared.state as string).toContain('[state truncated by Craft Agents]');
    expect(prepared.state as string).not.toContain('�');

    const object = prepareDecisionState({ text: 'x'.repeat(5_000) }, 500);
    expect(object.digest.truncated).toBe(true);
    expect(typeof object.state).toBe('string');
  });
});

describe('helpers', () => {
  it('clamps deadlines into the supported range', () => {
    expect(clampDecisionDeadline(undefined)).toBe(1500);
    expect(clampDecisionDeadline(1)).toBe(DECISION_MIN_DEADLINE_MS);
    expect(clampDecisionDeadline(10 ** 9)).toBe(DECISION_MAX_DEADLINE_MS);
    expect(clampDecisionDeadline(2_000.4)).toBe(2_000);
  });

  it('parseSystemOneResponse tolerates missing usage and clamps probabilities', () => {
    const parsed = parseSystemOneResponse(
      { answers: { q: { noul: 1.0000001 } } },
      { q: { type: 'noul', instructions: 'x' } },
    );
    expect(parsed.answers.q).toEqual({ type: 'noul', noul: 1 });
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(parsed.model).toBeUndefined();
  });

  it('flags when the server did not name the model', async () => {
    const { fetch } = fetchStub(() => jsonResponse({ answers: RESPONSE.answers }));
    const result = await client(fetch).decide(REQUEST);
    expect(result.model).toBe('jev-1.13.0');
    expect(result.modelReported).toBe(false);
  });

  it('validateDecisionRequest accepts structured instructions and criteria', () => {
    expect(() => validateDecisionRequest({
      state: ['Hi', 'My card was charged twice.'],
      questions: {
        topic: {
          type: 'choice',
          instructions: { question: 'Which topic?', focus: 'the information the customer wants' },
          criteria: { policy: { what: 'Whether an item can be returned' }, status: { what: 'Progress of a return' } },
        },
        repeat: { type: 'noul', instructions: 'Contacted before?', criteria: { true: 'mentions a prior ticket', false: 'no sign of previous contact' } },
      },
    })).not.toThrow();
  });
});
