/**
 * decide tool handler — typed judgments from the decision model (Jev / TypeSafe
 * System One).
 *
 * Single mode: one `state`, up to 20 questions. Batch mode: `items[]`, every
 * item judged as its own state with the same questions, under bounded
 * concurrency, results in input order. Network, validation, gating and
 * decision records all live behind ctx.decide (server-core) — this package
 * never talks to a provider.
 *
 * The output is advice for the agent. Nothing here grants authority, changes
 * session state, or runs anything.
 */

import type {
  SessionToolContext,
  DecisionToolAnswer,
  DecisionToolError,
  DecisionToolQuestion,
  DecisionToolResult,
  DecisionToolState,
  DecisionToolUsage,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export const DECIDE_UNAVAILABLE =
  'Decision model is not enabled. The user can enable it in Settings > AI > Decision model (Jev).';
export const DECIDE_MAX_QUESTIONS = 20;
export const DECIDE_MAX_ITEMS = 200;
export const DECIDE_BATCH_CONCURRENCY = 8;
/** The agent waits on this call, so the budget is generous compared to background features. */
export const DECIDE_DEFAULT_DEADLINE_MS = 10_000;
/**
 * Wall-clock cap for one batch. Items not started by then are reported as
 * failed instead of keeping the tool (and the provider bill) running for
 * minutes against an unresponsive endpoint.
 */
export const DECIDE_MAX_BATCH_WALL_MS = 120_000;
const PREVIEW_CHARS = 80;

export type DecideItem = string | Record<string, unknown>;

export interface DecideArgs {
  state?: DecisionToolState;
  items?: DecideItem[];
  questions: Record<string, DecisionToolQuestion>;
  deadlineMs?: number;
}

// ============================================================
// Helpers
// ============================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) out[key] = round(value);
  return out;
}

/** Trim precision and drop the legend (the agent already knows its own criteria). */
export function compactDecisionAnswers(answers: Record<string, DecisionToolAnswer>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, answer] of Object.entries(answers)) {
    switch (answer.type) {
      case 'choice':
        out[key] = { type: 'choice', choice: answer.choice, confidence: round(answer.confidence), probabilities: roundRecord(answer.probabilities) };
        break;
      case 'score':
        out[key] = { type: 'score', score: round(answer.score), confidence: round(answer.confidence), probabilities: roundRecord(answer.probabilities) };
        break;
      case 'noul':
        out[key] = { type: 'noul', noul: round(answer.noul) };
        break;
    }
  }
  return out;
}

export function formatDecisionError(error: DecisionToolError): string {
  const base = `Decision model error (${error.kind}): ${error.message}`;
  switch (error.kind) {
    case 'disabled':
    case 'unconfigured':
      return `${base}. The user can fix this in Settings > AI > Decision model (Jev).`;
    case 'rate_limited':
      return `${base}. Wait a moment and retry with a smaller batch.`;
    case 'timeout':
      return `${base}. Retry with a larger deadlineMs or a smaller state.`;
    default:
      return base;
  }
}

function previewOf(item: DecideItem): string {
  const text = typeof item === 'string' ? item : JSON.stringify(item);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Once `shouldStop()`
 * turns true, no further item is started; those get `onSkipped()` instead.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldStop?: () => boolean; onSkipped?: (item: T, index: number) => R },
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      if (options?.shouldStop?.() && options.onSkipped) {
        results[index] = options.onSkipped(items[index]!, index);
        continue;
      }
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function validateQuestions(questions: unknown): string | null {
  if (!isPlainObject(questions)) return 'questions must be an object keyed by question name.';
  const keys = Object.keys(questions);
  if (keys.length === 0) return 'questions must contain at least one question.';
  if (keys.length > DECIDE_MAX_QUESTIONS) return `questions exceeds the limit (${keys.length} > ${DECIDE_MAX_QUESTIONS}). Split them across calls.`;
  return null;
}

function addUsage(total: DecisionToolUsage, usage: DecisionToolUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

// ============================================================
// Handler
// ============================================================

export async function handleDecide(ctx: SessionToolContext, args: DecideArgs): Promise<ToolResult> {
  if (!ctx.decide) return errorResponse(DECIDE_UNAVAILABLE);

  const questionError = validateQuestions(args.questions);
  if (questionError) return errorResponse(questionError);

  const hasState = args.state !== undefined && args.state !== null;
  const hasItems = args.items !== undefined && args.items !== null;
  if (hasState && hasItems) return errorResponse('Provide either state (one item) or items (batch), not both.');
  if (!hasState && !hasItems) return errorResponse('Provide state (one item) or items (batch).');

  const deadlineMs = typeof args.deadlineMs === 'number' && Number.isFinite(args.deadlineMs) ? args.deadlineMs : DECIDE_DEFAULT_DEADLINE_MS;
  const decide = ctx.decide;

  if (hasItems) {
    const items = args.items;
    if (!Array.isArray(items)) return errorResponse('items must be an array of strings or objects.');
    if (items.length === 0) return errorResponse('items must not be empty.');
    if (items.length > DECIDE_MAX_ITEMS) return errorResponse(`items exceeds the batch limit (${items.length} > ${DECIDE_MAX_ITEMS}). Split the batch.`);

    const startedAt = Date.now();
    const toolError = (error: unknown): DecisionToolResult => ({
      ok: false,
      error: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) },
    });
    let results: DecisionToolResult[];
    try {
      results = await mapWithConcurrency<DecideItem, DecisionToolResult>(
        items,
        DECIDE_BATCH_CONCURRENCY,
        async (item, index) => {
          try {
            return await decide.decide({ state: item, questions: args.questions, deadlineMs, meta: { batch: true, index, total: items.length } });
          } catch (error) {
            return toolError(error);
          }
        },
        {
          shouldStop: () => Date.now() - startedAt > DECIDE_MAX_BATCH_WALL_MS,
          onSkipped: () => ({ ok: false, error: { kind: 'timeout', message: `batch budget of ${DECIDE_MAX_BATCH_WALL_MS / 1000}s exhausted before this item started` } }),
        },
      );
    } catch (error) {
      const failed = toolError(error);
      return errorResponse(formatDecisionError(failed.ok ? { kind: 'unavailable', message: 'unknown error' } : failed.error));
    }

    const usage: DecisionToolUsage = { inputTokens: 0, outputTokens: 0 };
    let model: string | undefined;
    let succeeded = 0;
    let truncatedItems = 0;
    let firstError: DecisionToolError | undefined;
    const rows = results.map((result, index) => {
      const preview = previewOf(items[index]!);
      if (result.ok) {
        succeeded += 1;
        model ??= result.model;
        addUsage(usage, result.usage);
        if (result.truncated) truncatedItems += 1;
        return { index, preview, answers: compactDecisionAnswers(result.answers), ...(result.truncated ? { truncated: true } : {}) };
      }
      firstError ??= result.error;
      return { index, preview, error: `${result.error.kind}: ${result.error.message}` };
    });

    if (succeeded === 0 && firstError) {
      return errorResponse(`${formatDecisionError(firstError)} (all ${items.length} items failed)`);
    }

    return successResponse(JSON.stringify({
      model,
      total: items.length,
      succeeded,
      failed: items.length - succeeded,
      ...(truncatedItems > 0 ? { truncatedItems, note: `${truncatedItems} item(s) were cut to the size limit before judging.` } : {}),
      usage,
      results: rows,
    }, null, 2));
  }

  let result: DecisionToolResult;
  try {
    result = await decide.decide({ state: args.state as DecisionToolState, questions: args.questions, deadlineMs });
  } catch (error) {
    return errorResponse(formatDecisionError({ kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }));
  }
  if (!result.ok) return errorResponse(formatDecisionError(result.error));

  return successResponse(JSON.stringify({
    model: result.model,
    answers: compactDecisionAnswers(result.answers),
    usage: result.usage,
    latencyMs: result.latencyMs,
    ...(result.truncated ? { truncated: true, note: 'The state was cut to the size limit before judging.' } : {}),
  }, null, 2));
}
