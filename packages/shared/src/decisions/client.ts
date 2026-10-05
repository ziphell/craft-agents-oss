/**
 * Decision layer — System One HTTP client.
 *
 * One method: `decide(request)` → typed answers or a thrown `DecisionError`.
 * The client validates the request before sending, bounds the state size,
 * enforces a wall-clock deadline, validates the response shape with zod, and
 * maps HTTP failures to `DecisionFailureKind`. It never puts the API key or the
 * state into an error message.
 *
 * Network proxy: the client uses the host's global `fetch`. In the Electron
 * main process that already goes through the user's proxy — see
 * `apps/electron/src/main/network-proxy.ts` (`setGlobalDispatcher`) — so
 * decision traffic needs no proxy plumbing of its own. Headless Bun hosts
 * follow whatever their runtime does for `fetch`.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { buildSystemOneEndpoint } from './providers.ts';
import {
  DecisionError,
  DECISION_CHOICE_MAX_OPTIONS,
  DECISION_CHOICE_MIN_OPTIONS,
  DECISION_DEFAULT_DEADLINE_MS,
  DECISION_MAX_DEADLINE_MS,
  DECISION_MAX_QUESTIONS_PER_CALL,
  DECISION_MAX_STATE_BYTES,
  DECISION_MIN_DEADLINE_MS,
  DECISION_SCORE_MAX_LEVELS,
  DECISION_SCORE_MIN_LEVELS,
  type ChoiceAnswer,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
  type DecisionState,
  type DecisionStateDigest,
  type DecisionUsage,
  type NoulAnswer,
  type ScoreAnswer,
} from './types.ts';

export interface SystemOneClientOptions {
  /** Provider base URL; `/v1/systemone` is appended. */
  baseUrl: string;
  /** Bearer token. Optional only for self-hosted servers without auth. */
  apiKey?: string;
  /** Pinned model id. */
  model: string;
  defaultDeadlineMs?: number;
  maxStateBytes?: number;
  extraHeaders?: Record<string, string>;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

const TRUNCATION_MARKER = '\n…[state truncated by Craft Agents]';
const MAX_ERROR_BODY_CHARS = 2_000;
const MAX_ERROR_DETAIL_CHARS = 240;
/** Cap on any server-controlled value echoed into an error detail. */
const MAX_ECHOED_VALUE_CHARS = 80;

// ============================================================
// Request validation
// ============================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): DecisionError {
  return new DecisionError('invalid_request', message);
}

function validateInstructions(key: string, instructions: unknown): void {
  if (typeof instructions === 'string') {
    if (!instructions.trim()) throw invalid(`Question '${key}': instructions must not be empty`);
    return;
  }
  if (isPlainObject(instructions) && Object.keys(instructions).length > 0) return;
  throw invalid(`Question '${key}': instructions must be a non-empty string or object`);
}

/**
 * Validate a request against the documented System One limits.
 * Throws `DecisionError('invalid_request')` with a message safe to show.
 */
export function validateDecisionRequest(request: DecisionRequest): void {
  const state = request.state as unknown;
  if (typeof state === 'string') {
    if (!state.trim()) throw invalid('state must not be empty');
  } else if (isPlainObject(state)) {
    if (Object.keys(state).length === 0) throw invalid('state must not be empty');
  } else if (Array.isArray(state)) {
    if (state.length === 0) throw invalid('state must not be empty');
  } else {
    throw invalid('state must be a string, a JSON object or an array');
  }

  if (!isPlainObject(request.questions)) throw invalid('questions must be an object keyed by question name');
  const keys = Object.keys(request.questions);
  if (keys.length === 0) throw invalid('questions must contain at least one question');
  if (keys.length > DECISION_MAX_QUESTIONS_PER_CALL) {
    throw invalid(`Too many questions in one call (${keys.length} > ${DECISION_MAX_QUESTIONS_PER_CALL})`);
  }

  for (const key of keys) {
    if (!key.trim()) throw invalid('question keys must not be empty');
    const question = request.questions[key] as DecisionQuestion | undefined;
    if (!isPlainObject(question)) throw invalid(`Question '${key}' must be an object`);
    validateInstructions(key, (question as { instructions?: unknown }).instructions);

    switch (question.type) {
      case 'choice': {
        const criteria = (question as { criteria?: unknown }).criteria;
        if (!isPlainObject(criteria)) throw invalid(`Question '${key}': choice criteria must be an object of option → description`);
        const options = Object.keys(criteria);
        if (options.length < DECISION_CHOICE_MIN_OPTIONS || options.length > DECISION_CHOICE_MAX_OPTIONS) {
          throw invalid(`Question '${key}': choice needs ${DECISION_CHOICE_MIN_OPTIONS}–${DECISION_CHOICE_MAX_OPTIONS} options (got ${options.length})`);
        }
        for (const option of options) {
          if (!option.trim()) throw invalid(`Question '${key}': option keys must not be empty`);
          const description = criteria[option];
          if (!(description === null || typeof description === 'string' || isPlainObject(description))) {
            throw invalid(`Question '${key}': option '${option}' description must be a string, an object or null`);
          }
        }
        break;
      }
      case 'score': {
        const criteria = (question as { criteria?: unknown }).criteria;
        if (!Array.isArray(criteria)) throw invalid(`Question '${key}': score criteria must be an ordered array of levels`);
        if (criteria.length < DECISION_SCORE_MIN_LEVELS || criteria.length > DECISION_SCORE_MAX_LEVELS) {
          throw invalid(`Question '${key}': score needs ${DECISION_SCORE_MIN_LEVELS}–${DECISION_SCORE_MAX_LEVELS} levels (got ${criteria.length})`);
        }
        for (const level of criteria) {
          if (!((typeof level === 'string' && level.trim()) || (isPlainObject(level) && Object.keys(level).length > 0))) {
            throw invalid(`Question '${key}': every score level must be a non-empty string or object`);
          }
        }
        break;
      }
      case 'noul': {
        const criteria = (question as { criteria?: unknown }).criteria;
        if (criteria !== undefined) {
          if (!isPlainObject(criteria)) throw invalid(`Question '${key}': noul criteria must be an object with optional 'true' / 'false' descriptions`);
          for (const side of ['true', 'false']) {
            if (side in criteria && typeof criteria[side] !== 'string') {
              throw invalid(`Question '${key}': noul criteria.${side} must be a string`);
            }
          }
        }
        break;
      }
      default:
        throw invalid(`Question '${key}': unknown type '${String((question as { type?: unknown }).type)}' (expected choice, score or noul)`);
    }
  }
}

// ============================================================
// State preparation (size bound + digest)
// ============================================================

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Serialize + bound the state. Objects are sent as JSON unless they must be truncated. */
export function prepareDecisionState(state: DecisionState, maxBytes: number = DECISION_MAX_STATE_BYTES): { state: DecisionState; digest: DecisionStateDigest } {
  let compact: string | undefined;
  try {
    compact = typeof state === 'string' ? state : JSON.stringify(state);
  } catch (error) {
    // BigInt values, circular references
    throw new DecisionError('invalid_request', 'state is not JSON-serializable', { cause: error });
  }
  if (typeof compact !== 'string') throw invalid('state is not JSON-serializable');
  const bytes = Buffer.byteLength(compact, 'utf8');
  if (bytes <= maxBytes) {
    return { state, digest: { sha256: sha256Hex(compact), bytes, truncated: false } };
  }
  const readable = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
  const cut = truncateUtf8(readable, Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8'))) + TRUNCATION_MARKER;
  return {
    state: cut,
    digest: { sha256: sha256Hex(cut), bytes: Buffer.byteLength(cut, 'utf8'), truncated: true, originalBytes: bytes },
  };
}

export function clampDecisionDeadline(deadlineMs: number | undefined): number {
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) return DECISION_DEFAULT_DEADLINE_MS;
  return Math.min(DECISION_MAX_DEADLINE_MS, Math.max(DECISION_MIN_DEADLINE_MS, Math.round(deadlineMs)));
}

// ============================================================
// Response parsing
// ============================================================

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const Probability = z.number().transform(clamp01);

const ChoiceAnswerSchema = z.object({
  choice: z.string(),
  confidence: Probability,
  probabilities: z.record(z.string(), Probability),
});

const ScoreAnswerSchema = z.object({
  score: z.number(),
  confidence: Probability,
  probabilities: z.record(z.string(), Probability),
  legend: z.record(z.string(), z.unknown()).optional(),
});

const NoulAnswerSchema = z.object({
  noul: Probability,
});

const EnvelopeSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

function malformed(message: string, state?: DecisionStateDigest, detail?: string): DecisionError {
  return new DecisionError('unavailable', `Decision model returned an unexpected response: ${message}`, {
    state,
    detail: detail !== undefined ? detail.slice(0, MAX_ECHOED_VALUE_CHARS) : undefined,
  });
}

/** Validate a raw System One response against the questions that were asked. */
export function parseSystemOneResponse(
  json: unknown,
  questions: Record<string, DecisionQuestion>,
  state?: DecisionStateDigest,
): { model?: string; answers: Record<string, DecisionAnswer>; usage: DecisionUsage } {
  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) throw malformed('missing answers object', state);

  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const raw = envelope.data.answers[key];
    if (raw === undefined) throw malformed(`no answer for question '${key}'`, state);

    switch (question.type) {
      case 'choice': {
        const parsed = ChoiceAnswerSchema.safeParse(raw);
        if (!parsed.success) throw malformed(`malformed choice answer for '${key}'`, state);
        if (!(parsed.data.choice in question.criteria)) {
          throw malformed(`answer for '${key}' picked an option that was not offered`, state, parsed.data.choice);
        }
        const answer: ChoiceAnswer = { type: 'choice', ...parsed.data };
        answers[key] = answer;
        break;
      }
      case 'score': {
        const parsed = ScoreAnswerSchema.safeParse(raw);
        if (!parsed.success) throw malformed(`malformed score answer for '${key}'`, state);
        const answer: ScoreAnswer = { type: 'score', score: parsed.data.score, confidence: parsed.data.confidence, probabilities: parsed.data.probabilities };
        if (parsed.data.legend) answer.legend = parsed.data.legend;
        answers[key] = answer;
        break;
      }
      case 'noul': {
        const parsed = NoulAnswerSchema.safeParse(raw);
        if (!parsed.success) throw malformed(`malformed noul answer for '${key}'`, state);
        const answer: NoulAnswer = { type: 'noul', noul: parsed.data.noul };
        answers[key] = answer;
        break;
      }
    }
  }

  return {
    model: envelope.data.model,
    answers,
    usage: {
      inputTokens: envelope.data.usage?.input_tokens ?? 0,
      outputTokens: envelope.data.usage?.output_tokens ?? 0,
    },
  };
}

// ============================================================
// Client
// ============================================================

export class SystemOneClient {
  readonly endpoint: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly defaultDeadlineMs: number;
  private readonly maxStateBytes: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SystemOneClientOptions) {
    this.endpoint = buildSystemOneEndpoint(options.baseUrl);
    this.model = options.model;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.defaultDeadlineMs = clampDecisionDeadline(options.defaultDeadlineMs);
    this.maxStateBytes = options.maxStateBytes ?? DECISION_MAX_STATE_BYTES;
    this.extraHeaders = { ...(options.extraHeaders ?? {}) };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Ask the decision model. Resolves with typed answers for every question or
   * throws a `DecisionError`. Callers that must fail closed catch the error
   * and keep their pre-decision behaviour.
   */
  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    validateDecisionRequest(request);
    const prepared = prepareDecisionState(request.state, this.maxStateBytes);
    const model = request.model?.trim() || this.model;
    const deadlineMs = clampDecisionDeadline(request.deadlineMs ?? this.defaultDeadlineMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({ model, state: prepared.state, questions: request.questions });
    const timeoutSignal = AbortSignal.timeout(deadlineMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: 'POST', headers, body, signal: combinedSignal });
    } catch (error) {
      throw this.networkError(error, deadlineMs, signal, prepared.digest);
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

    if (!response.ok) {
      throw await this.httpError(response, prepared.digest);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new DecisionError('unavailable', 'Decision model returned a non-JSON body', { cause: error, state: prepared.digest });
    }

    const parsed = parseSystemOneResponse(json, request.questions, prepared.digest);
    return {
      model: parsed.model || model,
      modelReported: Boolean(parsed.model),
      requestedModel: model,
      answers: parsed.answers,
      usage: parsed.usage,
      latencyMs,
      state: prepared.digest,
    };
  }

  private networkError(error: unknown, deadlineMs: number, callerSignal: AbortSignal | undefined, state: DecisionStateDigest): DecisionError {
    const name = error instanceof Error ? error.name : '';
    if (callerSignal?.aborted) {
      return new DecisionError('timeout', 'Decision call was cancelled', { cause: error, state });
    }
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new DecisionError('timeout', `Decision model did not answer within ${deadlineMs} ms`, { cause: error, state });
    }
    const detail = this.scrub(error instanceof Error ? error.message : String(error));
    return new DecisionError('unavailable', `Could not reach the decision model: ${detail || 'network error'}`, { cause: error, state });
  }

  private async httpError(response: Response, state: DecisionStateDigest): Promise<DecisionError> {
    const status = response.status;
    // Provider text is untrusted (a validating gateway may echo the state):
    // it travels as `detail`, which records drop and agents/users see.
    const detail = await this.readErrorDetail(response);
    const options = { status, state, detail };

    if (status === 401 || status === 403) {
      return new DecisionError('auth', `Decision provider rejected the API key (HTTP ${status})`, options);
    }
    if (status === 402) {
      return new DecisionError('auth', 'Decision provider reports the account is out of credit (HTTP 402)', options);
    }
    if (status === 429) {
      return new DecisionError('rate_limited', 'Decision provider rate limit reached (HTTP 429)', options);
    }
    if (status === 408) {
      return new DecisionError('timeout', 'Decision provider timed out (HTTP 408)', options);
    }
    if (status === 400 || status === 422) {
      return new DecisionError('invalid_request', `Decision provider rejected the request (HTTP ${status})`, options);
    }
    if (status === 413) {
      return new DecisionError('invalid_request', 'Decision provider rejected the request as too large (HTTP 413) — fewer questions or a smaller state', options);
    }
    if (status === 404) {
      return new DecisionError('unavailable', 'Decision endpoint not found (HTTP 404) — check the base URL and model id', options);
    }
    return new DecisionError('unavailable', `Decision provider error (HTTP ${status})`, options);
  }

  private async readErrorDetail(response: Response): Promise<string> {
    let text = '';
    try {
      text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    } catch {
      return '';
    }
    if (!text.trim()) return '';

    let detail = '';
    try {
      const parsed = JSON.parse(text) as unknown;
      detail = extractErrorMessage(parsed);
    } catch {
      detail = text;
    }
    return this.scrub(detail.replace(/\s+/g, ' ').trim()).slice(0, MAX_ERROR_DETAIL_CHARS);
  }

  /** Remove the API key from any text that could reach a log or a user. */
  private scrub(text: string): string {
    if (!text) return '';
    return this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text;
  }
}

function extractErrorMessage(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  if (!isPlainObject(parsed)) return '';
  const error = parsed.error;
  if (typeof error === 'string') return error;
  if (isPlainObject(error) && typeof error.message === 'string') return error.message;
  if (typeof parsed.message === 'string') return parsed.message;
  const detail = parsed.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map(item => (isPlainObject(item) && typeof item.msg === 'string' ? item.msg : typeof item === 'string' ? item : ''))
      .filter(Boolean)
      .join('; ');
  }
  return '';
}
