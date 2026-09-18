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
 * Codes are added for the things a **person acts on**: the gate, and the page
 * problems that come from the flow's own table. File-level diagnostics (a review
 * file without a `claim:`, two requirements sharing an id, a config line that
 * cannot be read) deliberately stay in their own words through {@link rawNotice}:
 * they name files, line contents and ids that translation would only obscure.
 */

/** What a notice is about, as a stable code a reader can translate. */
export type PrototypeNoticeCode =
  /** `pageIssues`: a row in the table whose document is not in the directory. */
  | 'page.documentMissing'
  /** `pageIssues`: `patches/<page>/` that matches no page, so nothing replays. */
  | 'page.patchScopeUnmatched'
  /** `briefIssues`: a requirement in the PRD that nothing refers to. */
  | 'requirement.unimplemented'
  /** `briefIssues`: a `@requirement` marker naming an id the PRD does not define. */
  | 'requirement.undefined'
  /** `anchors.issues`: a record nothing declares any more. */
  | 'anchor.orphaned'
  /** `settleBlockers`: a requirement nothing implements. */
  | 'gate.requirementUnmet'
  /** `settleBlockers`: an objection that still stands. */
  | 'gate.disputeStanding'
  /** `settleBlockers`: a check the last round failed. */
  | 'gate.checkFailed'
  /** `settleBlockers`: the PRD declares checks that have never been run. */
  | 'gate.checksNeverRun'
  /** `settleBlockers`: a service's contract declares a faked response that is not on disk. */
  | 'gate.serviceUncovered'
  /** A diagnostic that stays in its own words. */
  | 'raw'

/**
 * The values a code's sentence interpolates. See {@link ENGLISH} for which.
 *
 * `null` is allowed because the report has a few such values — a dispute with no
 * `status:` line, for one — and the sentence has always printed them as they were;
 * a reader that translates has to be able to say the rest of the line.
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
 * conversation, and what a dispute in `reviews/` is written against.
 */
const ENGLISH: Record<PrototypeNoticeCode, (params: PrototypeNoticeParams) => string> = {
  'page.documentMissing': ({ name, file }) =>
    `the page table lists "${name}", but ${file} is not in the prototype directory.`,
  'page.patchScopeUnmatched': ({ name, pages }) =>
    `patches/${name}/ belongs to no page of this prototype, so nothing there is replayed. Pages: ${pages}`,
  'requirement.unimplemented': ({ id, prd }) =>
    `${id} is in ${prd} but no page or patch refers to it, so nothing in this prototype implements it.`,
  'requirement.undefined': ({ where, id, prd }) =>
    `${where} refers to ${id}, which ${prd} does not define.`,
  'anchor.orphaned': ({ target }) =>
    `anchors/${target} was recorded but no patch declares it any more — the patch was edited or removed, and ` +
    `the record outlived it.`,
  'gate.requirementUnmet': ({ id, prd }) =>
    `${id} is in ${prd} but no page or patch refers to it, so nothing implements it.`,
  'gate.disputeStanding': ({ file, about, status }) =>
    `${file} disputes ${about}, and it still stands (${status}).`,
  'gate.checkFailed': ({ check }) => `\`${check}\` failed in the last verification round.`,
  'gate.checksNeverRun': ({ prd }) =>
    `${prd} declares acceptance checks and they have never been run here — \`prototype_tool verify\` is what turns ` +
    `them into an answer.`,
  'gate.serviceUncovered': ({ service, fixtures }) =>
    `${service} declares responses that are not on disk: ${fixtures} — those requests are not faked, so they go ` +
    `to the real backend.`,
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
