/**
 * The contract between the app and the frame that renders a GenOffice document.
 *
 * The frame runs someone else's application (the GenOffice editor bundle), served as it is:
 * it knows nothing about this app, and speaks only the `window.desktop` API its own preload
 * would have provided. So the bridge has two layers, and only the outer one is ours:
 *
 * - **inside the frame**, `shim.ts` defines `window.desktop` and forwards every call here;
 * - **across the boundary**, this file: one envelope, one kind of call, one kind of reply.
 *
 * Bytes travel in the messages rather than over a URL. A `blob:` URL only resolves in the
 * origin that made it, and in Electron the frame's origin (`craft-local://…`) is not the
 * app's — so a document handed over as a URL would 404 in exactly the host that matters.
 * An `ArrayBuffer` rides the structured clone instead, and the shim makes its own URL.
 *
 * **This module has no imports, on purpose.** Both ends of the bridge need the same
 * protocol string, and a second copy would drift — the same rule `drawio/types.ts` states.
 */

/** Bumped only when a message shape changes in a way an older frame cannot answer. */
export const OFFICE_PROTOCOL = 'craft-office/1'

/** The editors this app can host. One per GenOffice app bundle. */
export type OfficeApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'

export const OFFICE_APPS: readonly OfficeApp[] = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']

/** The script the host injects into the editor's `index.html` (see `shim.ts`). */
export const OFFICE_SHIM_PATH = '/__craft/office-shim.js'

/** Which document to open, and the bytes to open it with. */
export interface OfficeOpenRequest {
  /** Stable identity for this document inside the frame's lifetime. */
  id: string
  /** Absolute path on the machine that owns the file (may be empty for an unsaved draft). */
  path: string
  /** What to show in a title bar / save dialog default. */
  name: string
  /** The document bytes. Transferred, not copied, when the sender can spare them. */
  bytes: ArrayBuffer
  /** The app's content digest, when the caller already has one (the editor does not require it). */
  hash?: string
  /** True when the file is encrypted and the caller has already handled the password. */
  encrypted?: boolean
}

/** Frame → host. */
export type OfficeFrameMessage =
  | { protocol: typeof OFFICE_PROTOCOL; type: 'ready' }
  | { protocol: typeof OFFICE_PROTOCOL; type: 'call'; id: number; method: string; args: unknown[] }
  /**
   * The editor's answer to one `edit` request.
   *
   * `ok: false` is a refusal the person deserves to read — a stale selection, an IME mid-composition,
   * a read-only document — so the message travels with it rather than being flattened to a boolean.
   */
  | { protocol: typeof OFFICE_PROTOCOL; type: 'editResult'; id: number; ok: boolean; message?: string }
  /**
   * The selection inside the editor, whenever it changes.
   *
   * Sent rather than asked for: the frame is another document, so the host cannot read its
   * selection, and a cross-origin frame raises no `selectionchange` the host could listen to.
   * The alternative — a button that asks on click — cannot tell "nothing selected" from "the
   * user does not know this exists", which is exactly the state worth showing.
   */
  | {
      protocol: typeof OFFICE_PROTOCOL
      type: 'selection'
      text: string
      /**
       * Where the selection is, as the editor counts it (document characters), or null when the
       * editor has no such notion (sheets, slides, pdf).
       *
       * The text alone cannot say *which* occurrence was selected, and a request to change that
       * passage is ambiguous without it.
       */
      from?: number | null
      to?: number | null
      /** Top-level block indexes the selection touches, when the editor reports them. */
      blocks?: number[] | null
    }

/** Host → frame. */
export type OfficeHostMessage =
  | { protocol: typeof OFFICE_PROTOCOL; type: 'open'; file: OfficeOpenRequest }
  /**
   * Replace one span of the open document, if it still holds what the host was told it holds.
   *
   * It travels host→frame because the **person** asks for it: an offer from the conversation is
   * applied by them, never by a tool. That is what keeps the editor the only writer — the change
   * lands as one step of its own history, and one press of undo takes it back.
   */
  | {
      protocol: typeof OFFICE_PROTOCOL
      type: 'edit'
      id: number
      /** The editor's own command, field for field — a document span or a workbook range. */
      edit: Record<string, unknown>
    }
  | { protocol: typeof OFFICE_PROTOCOL; type: 'result'; id: number; ok: true; value: unknown }
  | { protocol: typeof OFFICE_PROTOCOL; type: 'result'; id: number; ok: false; error: string }
  /**
   * A push the editor subscribed to (`pdfApi.onSaveAsRequest`, `onSaveAsFlow`, …).
   *
   * The other direction of the same bridge: most calls are the editor asking, these are the host
   * telling — a path it was given in a dialog, a flow starting and ending.
   */
  | { protocol: typeof OFFICE_PROTOCOL; type: 'event'; channel: string; payload: unknown }

/**
 * A message that came from a frame, or null.
 *
 * Shape-checked rather than trusted: the frame is served from this app's origin, but what
 * arrives is still data from a page, and a malformed one must not reach a handler.
 */
export function isOfficeFrameMessage(data: unknown): data is OfficeFrameMessage {
  if (!data || typeof data !== 'object') return false
  const message = data as Record<string, unknown>
  if (message.protocol !== OFFICE_PROTOCOL) return false

  if (message.type === 'ready') return true

  if (message.type === 'editResult') {
    return typeof message.id === 'number' && typeof message.ok === 'boolean'
  }

  if (message.type === 'selection') {
    return (
      typeof message.text === 'string' &&
      (message.from === undefined || message.from === null || typeof message.from === 'number') &&
      (message.to === undefined || message.to === null || typeof message.to === 'number')
    )
  }

  return (
    message.type === 'call' &&
    typeof message.id === 'number' &&
    typeof message.method === 'string' &&
    Array.isArray(message.args)
  )
}

/** A message addressed to a frame, or null. Used by the shim and by tests. */
export function isOfficeHostMessage(data: unknown): data is OfficeHostMessage {
  if (!data || typeof data !== 'object') return false
  const message = data as Record<string, unknown>
  if (message.protocol !== OFFICE_PROTOCOL) return false

  if (message.type === 'open') {
    const file = message.file as Record<string, unknown> | undefined
    return !!file && typeof file.id === 'string' && typeof file.name === 'string' && !!file.bytes
  }

  if (message.type === 'event') return typeof message.channel === 'string'

  return message.type === 'result' && typeof message.id === 'number' && typeof message.ok === 'boolean'
}

/** The address a document of `app` is served at, given the office origin. */
export function officeAppUrl(origin: string, app: OfficeApp): string {
  return `${origin.replace(/\/+$/, '')}/${app}/`
}

/**
 * The app's locale → a language code the editors accept.
 *
 * Measured, not guessed: the editors key their label tables by `Lang` (`en`, `zh`, `zh-TW`, …)
 * and `zh-Hans` — the tag this app's own i18n uses — is *not* one of them. Handing it over
 * leaves `AI_QUEUE_LABELS[lang]` undefined and the AI panel throws while mounting, which reads
 * as a broken editor rather than a wrong tag. Untranslated languages fall back to `en`, which
 * is what the editors themselves do.
 */
export function officeLanguage(tag: string | null | undefined): string {
  const value = (tag ?? '').trim().toLowerCase()
  if (!value) return 'en'
  if (/^zh[-_](tw|hk|mo|hant)/.test(value)) return 'zh-TW'
  if (value === 'zh' || value.startsWith('zh-')) return 'zh'
  const supported = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'th', 'vi', 'id', 'ms', 'pt', 'it', 'nl', 'pl', 'cs', 'ru', 'ar', 'he', 'hi', 'tr', 'hu']
  const base = value.split(/[-_]/)[0] ?? ''
  return supported.includes(base) ? base : 'en'
}

// ── Tables out of a document ────────────────────────────────────────────────────

/**
 * One cell of an extracted table.
 *
 * Three types only, because those are the three a document can state without guessing: text, a
 * number, and an empty cell. Booleans, dates and percentages stay text — see
 * `sheets-from-document.ts` for why guessing them is worse than storing them.
 */
export type CellValue = string | number | null

/** A table lifted out of a markdown or HTML document, with the name it will have as a sheet. */
export interface ExtractedTable {
  /** Already legal for Excel (≤31 chars, no `[]:*?/\`), and unique within the workbook. */
  sheetName: string
  rows: CellValue[][]
  /**
   * The first row is a header — the document said so (a GFM delimiter row, or a `<th>` in row 1).
   *
   * It matters because the workbook gets a frozen header and an AutoFilter from it, and a table
   * whose first row is data would then be sorted with its own data frozen above it.
   */
  headerRow?: boolean
  /** What could not be exported — a nested table, for instance. Absent when nothing was left out. */
  note?: string
}

/**
 * A workbook as `create --from` reads it: sheets, each with a name and a grid.
 *
 * The shape is the engine's, not ours — that is the point: extraction ends where the engine's
 * existing entry point begins, so nothing has to be invented to put the tables on disk.
 */
export interface WorkbookSpec {
  sheets: Array<{ name: string; rows: CellValue[][]; headerRow?: boolean }>
}
