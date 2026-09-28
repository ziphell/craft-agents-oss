/**
 * PrototypeNotice — one thing a prototype's report says is wrong.
 *
 * Every verdict and diagnostic this layer produces used to leave as a finished
 * English sentence, because its readers were the agent's status output, the
 * handoff document and the tests. That works for a CLI and fails for a translated
 * panel: the **gate** — the one line a person has to read before handing work over
 * — appeared in English inside a Chinese screen, and the panel had no way to say
 * the same thing in the reader's language without inventing a second wording.
 *
 * So a notice carries both faces:
 *
 * - `code` + `params` are what a reader translates (`t('prototypeNotice.' + code)`);
 * - `text` is the English sentence **derived from those same params**, rendered
 *   here and nowhere else.
 *
 * One rendering is what keeps the promise the panel makes elsewhere: what the
 * screen says and what the agent prints cannot drift apart, because there is one
 * function that turns a code and its params into the sentence, and the panel keeps
 * it beside its translation. (The panel's rule: the translated line is the
 * message, the English line is the record — shown in full where a person hands
 * work over, and as the tooltip where a diagnostic is being read.)
 *
 * Codes are added for the things a **person acts on**: the gate. File-level
 * diagnostics (a review file without a `claim:`, two requirements sharing an id,
 * a finding whose evidence is not on disk) deliberately stay in their own words
 * through {@link rawNotice}: they name files, line contents and ids that
 * translation would only obscure.
 */

/** What a notice is about, as a stable code a reader can translate. */
export type PrototypeNoticeCode =
  /** `briefIssues`: a `@requirement` marker naming an id no document defines. */
  | 'requirement.undefined'
  /** `briefIssues`: a picture in the brief drawn from an earlier state of the diagram beside it. */
  | 'diagram.stale'
  /** `settleBlockers`: a requirement nothing implements. */
  | 'gate.requirementUnmet'
  /** `settleBlockers`: a link whose target is not in the prototype. */
  | 'gate.linkBroken'
  /** A diagnostic that stays in its own words. */
  | 'raw'

/**
 * The values a code's sentence interpolates. See {@link ENGLISH} for which.
 *
 * `null` is allowed because a report value can legitimately be missing, and the sentence has always
 * printed it as it was; a reader that translates has to be able to say the rest of the line.
 */
export type PrototypeNoticeParams = Record<string, string | number | null>

export interface PrototypeNotice {
  code: PrototypeNoticeCode
  params: PrototypeNoticeParams
  /** The English sentence — the one the agent prints, the handoff carries and the tests match. */
  text: string
}

/**
 * The English rendering of every code, from exactly the params the panel gets.
 *
 * The strings here are the ones the status output and the handoff document have
 * always printed, kept byte for byte: they are what an agent quotes back in a
 * conversation.
 */
const ENGLISH: Record<PrototypeNoticeCode, (params: PrototypeNoticeParams) => string> = {
  'requirement.undefined': ({ where, id }) =>
    `${where} refers to ${id}, which no file in this prototype defines.`,
  'diagram.stale': ({ svg, source }) =>
    `${svg} is not what ${source} draws any more — it was exported before the diagram changed.`,
  'gate.requirementUnmet': ({ id, file }) =>
    `${id} is in ${file} but no file refers to it, so nothing implements it.`,
  'gate.linkBroken': ({ from, target }) =>
    `${from} links to ${target}, which is not in this prototype.`,
  raw: ({ text }) => String(text),
}

export function notice(
  code: PrototypeNoticeCode,
  params: PrototypeNoticeParams = {},
): PrototypeNotice {
  return { code, params, text: ENGLISH[code](params) }
}

/**
 * A diagnostic that keeps its own words.
 *
 * For the file-level problems a person fixes by reading the file — nothing about
 * them survives translation: they are file names, ids and the shape a line was
 * expected to have.
 */
export function rawNotice(text: string): PrototypeNotice {
  return notice('raw', { text })
}
