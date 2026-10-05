/**
 * Decision layer — types.
 *
 * A "decision" is one call to a System One decision model (Jev by TypeSafe AI,
 * or any server speaking the same wire format: TypeSafe, OpenRouter, Vercel AI
 * Gateway, self-hosted clones). The model reads a `state` and answers typed
 * `questions` with probabilities. It never produces text.
 *
 * Invariants (also summarised in packages/shared/CLAUDE.md → "Decision layer"):
 * 1. A decision never grants authority. No code path may turn a permission
 *    prompt into an allow because of a decision answer.
 * 2. Fail closed: any failure, timeout or low confidence yields the behaviour
 *    the app had before the decision layer existed.
 * 3. State is never logged. Records carry a sha256 digest and a byte count.
 * 4. The model id is pinned per provider; the model the server reports is
 *    recorded on every call.
 * 5. Every call writes a decision record (see records.ts).
 *
 * Wire format (verified against docs.typesafe.ai on 2026-09-25):
 *   POST {baseUrl}/v1/systemone
 *   { model, state, questions: { key: { type, instructions, criteria? } } }
 *   → { model, answers: { key: {...} }, usage: { input_tokens, output_tokens } }
 */

// ============================================================
// Providers
// ============================================================

/**
 * Where the decision model is hosted. The wire format is identical everywhere.
 * `laya` is the open-source (Apache 2.0) Jev-compatible model served locally by
 * `laya-serve`; `custom` is any other Jev-compatible endpoint.
 */
export type DecisionProviderId = 'typesafe' | 'openrouter' | 'vercel-ai-gateway' | 'laya' | 'custom';

export const DECISION_PROVIDER_IDS: readonly DecisionProviderId[] = [
  'typesafe',
  'openrouter',
  'vercel-ai-gateway',
  'laya',
  'custom',
] as const;

export function isDecisionProviderId(value: unknown): value is DecisionProviderId {
  return typeof value === 'string' && (DECISION_PROVIDER_IDS as readonly string[]).includes(value);
}

// ============================================================
// Questions (request side)
// ============================================================

/** Instructions may be a sentence or a small structured object (question/focus/...). */
export type DecisionInstructions = string | Record<string, unknown>;

/** A choice option description: sentence, structured object, or null for self-explanatory keys. */
export type DecisionCriterionDescription = string | null | Record<string, unknown>;

/** Pick exactly one option. 2..255 options. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: DecisionInstructions;
  criteria: Record<string, DecisionCriterionDescription>;
}

/** Place the state on an ordered rubric. 2..10 levels, lowest first. */
export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionInstructions;
  criteria: Array<string | Record<string, unknown>>;
}

/** Yes/no probability. */
export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionInstructions;
  criteria?: { true?: string; false?: string };
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type DecisionQuestionType = DecisionQuestion['type'];

/** Text, a JSON object, or an array of text values. Images/audio are not supported. */
export type DecisionState = string | Record<string, unknown> | unknown[];

export interface DecisionRequest {
  state: DecisionState;
  /** Non-empty map of question key → question. */
  questions: Record<string, DecisionQuestion>;
  /** Override the pinned model id for this call (tests, experiments). */
  model?: string;
  /** Wall-clock budget for the HTTP call. Defaults to the client's deadline. */
  deadlineMs?: number;
}

// ============================================================
// Answers (response side)
// ============================================================

export interface ChoiceAnswer {
  type: 'choice';
  /** Option key with the highest probability. */
  choice: string;
  /** 0..1, how concentrated the distribution is on one option. */
  confidence: number;
  /** Option key → probability, sums to ~1. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected level: Σ(level index × probability), 0..(levels-1). */
  score: number;
  confidence: number;
  /** Level index (as string) → probability. */
  probabilities: Record<string, number>;
  /** Level index (as string) → the criterion text/object sent in the request. */
  legend?: Record<string, unknown>;
}

export interface NoulAnswer {
  type: 'noul';
  /** Probability of "yes". Two outcomes, so this describes the distribution completely. */
  noul: number;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What the client knows about the state it sent — never the state itself. */
export interface DecisionStateDigest {
  /** sha256 (hex) of the state text actually sent. */
  sha256: string;
  /** UTF-8 bytes actually sent. */
  bytes: number;
  truncated: boolean;
  /** UTF-8 bytes before truncation; only present when `truncated` is true. */
  originalBytes?: number;
}

export interface DecisionResult {
  /** Model id reported by the server, or the requested id when the server omitted it (see `modelReported`). */
  model: string;
  /** True when the server's response named the model; false when `model` is the requested id echoed back. */
  modelReported: boolean;
  /** Model id that was requested (pinned per provider). */
  requestedModel: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
  latencyMs: number;
  state: DecisionStateDigest;
}

// ============================================================
// Failures
// ============================================================

export type DecisionFailureKind =
  | 'disabled'        // master switch or feature toggle off
  | 'unconfigured'    // no key / no base URL / unknown connection
  | 'timeout'         // deadline exceeded or aborted
  | 'auth'            // 401 / 403
  | 'rate_limited'    // 429
  | 'invalid_request' // 400 / 422 or client-side validation
  | 'unavailable';    // network error, 5xx, 529, malformed body

export interface DecisionFailure {
  kind: DecisionFailureKind;
  /** Safe to show to users and agents: never contains the key or the state. */
  message: string;
  status?: number;
}

export class DecisionError extends Error {
  readonly kind: DecisionFailureKind;
  readonly status?: number;
  /**
   * Untrusted text that came back from the provider (error-body excerpt, an
   * unexpected value). Shown to the agent / the Settings card, but kept OUT
   * of decision records because a validating gateway may echo the state.
   */
  readonly detail?: string;
  /** Digest of the state that was (about to be) sent, when known. */
  state?: DecisionStateDigest;

  constructor(
    kind: DecisionFailureKind,
    message: string,
    options?: { status?: number; cause?: unknown; state?: DecisionStateDigest; detail?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DecisionError';
    this.kind = kind;
    this.status = options?.status;
    this.state = options?.state;
    this.detail = options?.detail?.trim() || undefined;
  }

  /** `includeDetail: false` (records) drops provider text; the default keeps it for agents/users. */
  toFailure(options?: { includeDetail?: boolean }): DecisionFailure {
    const includeDetail = options?.includeDetail ?? true;
    const message = includeDetail && this.detail ? `${this.message}: ${this.detail}` : this.message;
    return this.status !== undefined
      ? { kind: this.kind, message, status: this.status }
      : { kind: this.kind, message };
  }
}

export function isDecisionError(error: unknown): error is DecisionError {
  return error instanceof DecisionError || (error instanceof Error && error.name === 'DecisionError' && 'kind' in error);
}

/** Convert any thrown value into a DecisionFailure without leaking internals. */
export function toDecisionFailure(error: unknown, options?: { includeDetail?: boolean }): DecisionFailure {
  if (isDecisionError(error)) return error.toFailure(options);
  return { kind: 'unavailable', message: error instanceof Error ? error.message : 'Unknown decision error' };
}

// ============================================================
// Limits
// ============================================================

/** Default wall-clock budget for one decision call. Jev answers in 70–500 ms; gateways add a little. */
export const DECISION_DEFAULT_DEADLINE_MS = 1500;
/** Upper bound accepted from settings/callers. */
export const DECISION_MAX_DEADLINE_MS = 60_000;
/** Lower bound accepted from settings/callers. */
export const DECISION_MIN_DEADLINE_MS = 250;
/** State is cut to this many UTF-8 bytes before sending (Jev reads up to 32k tokens). */
export const DECISION_MAX_STATE_BYTES = 96 * 1024;
export const DECISION_CHOICE_MIN_OPTIONS = 2;
export const DECISION_CHOICE_MAX_OPTIONS = 255;
export const DECISION_SCORE_MIN_LEVELS = 2;
export const DECISION_SCORE_MAX_LEVELS = 10;
/** Sanity cap on questions per call; the API documents no maximum. */
export const DECISION_MAX_QUESTIONS_PER_CALL = 64;
