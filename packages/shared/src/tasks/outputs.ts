/**
 * Structured node outputs — the producer half of the param/artifact split.
 *
 * Three modules own the three sides of one deal:
 *  - `schema.ts` — the declaration (`outputs:` on a node);
 *  - `refs.ts` — the consumer grammar (`${nodes.<id>.output.<field>}`) that resolves
 *    against `NodeOutput.params`;
 *  - this module — how a declared field comes to exist. A node that declares `outputs`
 *    is told, in its dispatch prompt, to end its reply with one machine-readable block;
 *    the Conductor parses that block on completion and files it as `params`.
 *
 * The shape of the deal mirrors the orchestrator's VERDICT line (TaskRunner): a
 * machine-readable tail on an otherwise free-form answer, so a node is still a
 * conversation and still prose — but the fields a downstream node (or, later, a `when:`
 * condition) routes on are guaranteed to be there.
 *
 * Strict on purpose (never silently degrade): a declared field that is absent, or fails
 * its declared `enum`/`type`, fails the node — which the existing `retry` policy can pick
 * up — instead of leaving `${nodes.<id>.output.<field>}` unresolved in the next prompt.
 * Undeclared keys the model volunteers are dropped, so `params` is exactly what the spec
 * promised and the validator's "undeclared field" error stays truthful.
 */
import type { OutputDecl } from './schema.ts'

/** The fence tag a node uses to hand back its declared fields. */
export const OUTPUTS_FENCE_TAG = 'params'

export interface ParsedOutputs {
  /** The node's answer with the contract block removed — what a human reads. */
  body: string
  /** Declared fields, present only when every one of them validated. */
  params?: Record<string, unknown>
  /** Why the block was unusable, in words (empty = fine). */
  problems: string[]
}

/** A fenced block tagged `params`; the last one wins (`g` flag drives that). */
function blockRegex(): RegExp {
  return new RegExp('```[ \\t]*' + OUTPUTS_FENCE_TAG + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')
}

/** One declared field as the prompt should describe it. */
function describeField(decl: OutputDecl): string {
  const bits: string[] = []
  if (decl.type) bits.push(decl.type)
  if (decl.enum?.length) bits.push(`one of: ${decl.enum.join(', ')}`)
  return bits.length ? `${decl.name} — ${bits.join('; ')}` : decl.name
}

/**
 * The instruction appended to a node's prompt when it declares `outputs`. Empty string
 * when it declares none — a node with no declaration is dispatched exactly as before.
 */
export function buildOutputsContract(outputs: readonly OutputDecl[] | undefined): string {
  if (!outputs?.length) return ''
  return [
    '---',
    'Structured output — required, in addition to your normal answer:',
    `End your reply with exactly one fenced block tagged \`${OUTPUTS_FENCE_TAG}\` holding a single JSON object:`,
    '',
    '```' + OUTPUTS_FENCE_TAG,
    `{ ${outputs.map((o) => `"${o.name}": <value>`).join(', ')} }`,
    '```',
    '',
    'Fields:',
    ...outputs.map((o) => `- ${describeField(o)}`),
    '',
    'Rules: the block must be valid JSON and the last thing in your reply; every field above must be present;',
    'do not add any other fenced block of this kind. Your prose answer goes above it as usual.',
  ].join('\n')
}

type Coerced = { ok: true; value: unknown } | { ok: false; why: string }

/** Validate a value against a declared `type`, coercing the near-misses a model produces. */
function coerce(value: unknown, type: string | undefined): Coerced {
  switch (type) {
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return { ok: true, value: Number(value) }
      }
      return { ok: false, why: 'expected a number' }
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' }
      return { ok: false, why: 'expected true or false' }
    case 'string':
    case 'text':
      if (typeof value === 'string') return { ok: true, value }
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) }
      return { ok: false, why: 'expected a string' }
    default:
      // No type declared (or an unknown one): `json` and anything else pass through as-is.
      return { ok: true, value }
  }
}

/**
 * Pull a node's declared fields out of its final reply, and return the reply without them.
 *
 * Never throws: everything that can go wrong is reported as a `problem`, because the
 * caller decides what an unusable contract means (the Conductor fails the node).
 */
export function parseDeclaredOutputs(
  text: string,
  outputs: readonly OutputDecl[] | undefined,
): ParsedOutputs {
  if (!outputs?.length) return { body: text, problems: [] }

  // The last tagged block is the contract; any earlier ones are stripped as well so a
  // model that emits the block twice leaves nothing machine-readable in the prose.
  const blocks = [...text.matchAll(blockRegex())]
  const last = blocks.at(-1)
  const body = blocks.reduce((acc, b) => acc.replace(b[0], ''), text).trimEnd()
  if (!last) {
    return { body, problems: [`no \`${OUTPUTS_FENCE_TAG}\` block in the reply`] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(last[1] ?? '')
  } catch {
    return { body, problems: [`the \`${OUTPUTS_FENCE_TAG}\` block is not valid JSON`] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { body, problems: [`the \`${OUTPUTS_FENCE_TAG}\` block must be a JSON object`] }
  }

  const given = raw as Record<string, unknown>
  const params: Record<string, unknown> = {}
  const problems: string[] = []
  for (const decl of outputs) {
    if (!(decl.name in given)) {
      problems.push(`missing declared output "${decl.name}"`)
      continue
    }
    const coerced = coerce(given[decl.name], decl.type)
    if (!coerced.ok) {
      problems.push(`output "${decl.name}": ${coerced.why}`)
      continue
    }
    if (decl.enum?.length && !decl.enum.includes(String(coerced.value))) {
      problems.push(`output "${decl.name}" must be one of: ${decl.enum.join(', ')}`)
      continue
    }
    params[decl.name] = coerced.value
  }

  return problems.length ? { body, problems } : { body, params, problems: [] };
}
