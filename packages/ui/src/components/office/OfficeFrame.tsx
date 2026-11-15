/**
 * A GenOffice editor, hosted in a frame and given the host it expects.
 *
 * The shape: an `<iframe>` at the office origin (a `craft-local://` label in Electron, a path
 * on the hub in the Web UI — the caller knows which) plus this component answering the calls
 * its shim forwards. Nothing native, nothing layered: the frame is a DOM box, so z-order,
 * scroll and resize are the browser's problems rather than ours.
 *
 * Three rules the code below is built around:
 *
 * - **The frame is a page, not a peer.** Every message is checked against
 *   `event.source === iframe.contentWindow` before it is looked at, and its shape against
 *   `isOfficeFrameMessage`. A page served from our origin is still a page.
 * - **Every call gets an answer.** The shim resolves `undefined` after 30 s otherwise, and an
 *   editor that waits 30 s on a getter mounts blank. Unknown methods are answered here too.
 * - **Transport is the caller's.** Reading and writing bytes is passed in, so the same
 *   component works over IPC in Electron and over the hub's RPC in the Web UI — the one thing
 *   that actually differs between the two hosts.
 *
 * Bytes travel both ways over the bridge rather than a URL: a `blob:` URL made by the host is
 * not readable from a frame on another origin, which is exactly the Electron case.
 */

import * as React from 'react'
import {
  isOfficeFrameMessage,
  type OfficeApp,
  type OfficeHostMessage,
  type OfficeOpenRequest,
} from '@craft-agent/shared/office/types'

export interface OfficeFrameFile {
  /** Stable identity for this document inside the frame's lifetime. */
  id: string
  /** Absolute path on the machine that owns the file. */
  path: string
  /** Title / save-dialog default. */
  name: string
  /** The app's content digest, when the caller has one. */
  hash?: string
}

export interface OfficeFrameLabels {
  /** A `Lang` code the editor knows: 'en', 'zh', 'zh-TW', … (`zh-Hans` is *not* one). */
  language?: string
  /** Chrome theme. */
  theme?: 'light' | 'dark'
  /** Page theme — what the document is drawn as. */
  documentTheme?: 'light' | 'dark'
  autoSave?: boolean
  author?: string
}

/**
 * What an in-editor edit asks for — one shape per editor, because the anchor is what differs.
 *
 * A document is addressed by **character offsets**, a workbook by **A1 range**. Both carry a
 * fingerprint the editor checks before writing: the thing the caller was told about has to still be
 * there, or the edit is refused rather than landing somewhere else.
 */
export type OfficeFrameEdit =
  | { from: number; to: number; expectedText: string; text: string }
  /** A markdown document: one occurrence, found in the live document (see `editors/text-edits.ts`). */
  | { kind: 'markdown'; expectedText: string; text: string }
  /** An html document: the same request, answered by the editor showing the page. */
  | { kind: 'html'; expectedText: string; text: string }
  | {
      /** Sheet name; omitted means the active sheet. */
      sheet?: string
      range: string
      /** The common fingerprint: the block must be blank. */
      expectEmpty?: boolean
      /** The explicit fingerprint: the block must hold exactly this. */
      expected?: unknown[][]
      values: unknown[][]
    }
  | { slide: number; find: string; replace: string; expectCount: number; elementId?: string }

/** The answer: `ok` with nothing else, or the editor's own reason for refusing. */
export interface OfficeFrameEditResult {
  ok: boolean
  message?: string
}

/** What a caller can ask of a mounted frame. */
export interface OfficeFrameProps {
  /** The office origin: `craft-local://office-…` in Electron, `/office` on the hub. */
  origin: string
  app: OfficeApp
  file: OfficeFrameFile
  /** Bytes for a path — `readBinary` in Electron, `file:readBinary` over RPC in the Web UI. */
  readBytes: (path: string) => Promise<Uint8Array>
  /** Commit bytes for a path — the host owns the disk, the frame never does. */
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>
  labels?: OfficeFrameLabels
  className?: string
  /** The editor mounted and took its document. */
  onReady?: () => void
  /**
   * The text selected in the editor, as it changes (empty when nothing is selected).
   *
   * The frame cannot be read from outside — it is another document — so the editor reports this
   * itself. A host that offers "continue in the conversation" hangs it off this.
   */
  onSelectionChange?: (selection: { text: string; from?: number | null; to?: number | null }) => void
  /**
   * A preview that cannot write: the editor still draws the real document, but every save is
   * refused inside the frame. What a block in a conversation wants — a look, not a place where a
   * stray keystroke changes somebody's file.
   */
  readOnly?: boolean

  /** The pdf door: same shape, its renderer edits the bytes and the host writes them. */
  onOfficePdf?: (method: string, args: unknown[]) => Promise<unknown>
  /**
   * "Give me this document as a PDF" — the editor's own Export button.
   *
   * Printing needs a Chromium with the editor as its top document, which only the main process has
   * (`office-export.ts` re-opens the file in a hidden window and prints it there). A frame cannot
   * print itself: `window.print()` inside an iframe prints the page it sits in, chrome and all.
   */
  onOfficeExportPdf?: (path: string, outPath?: string) => Promise<{ path?: string } | null>
  /**
   * Something worth saying **without changing what is on screen** — an i18n key the host words.
   *
   * Not `onError`: that one replaces the editor with a sentence, which is right when the document
   * cannot be shown and wrong for a remark about how a show will run.
   */
  onNotice?: (key: string) => void
  /**
   * Put a file the host produced in front of the person.
   *
   * The desktop saves it; a browser downloads it. Either way the frame is what turns a host's
   * `downloads` answer into something a person can open — a hub can write the bytes but cannot know
   * where the person's files are.
   */
  onSaveProducedFile?: (download: { id: string; name: string; size: number; mime: string }) => Promise<unknown>
  /** Ask the client for a file to read (Insert Image). An empty list means "nothing chosen". */
  onOpenFileDialog?: () => Promise<string[]>
  /** Ask the client for a folder (export these images here). `null` means "nothing chosen". */
  onPickDirectory?: () => Promise<string | null>

  /** The deck door: `(method, args)` — see `PlatformContext.onOfficeDeck`. */
  onOfficeDeck?: (method: string, args: unknown[]) => Promise<unknown>
  /** The workbook door: same shape, its document lives in a sidecar process. */
  onOfficeWorkbook?: (method: string, args: unknown[]) => Promise<unknown>
  /** Something the caller should say out loud (a failed save, an unreadable file). */
  onError?: (message: string) => void
  /** A copy the editor just wrote — its path, and its first page as a data URL. */
  onCopySaved?: (copy: { path: string; png: string }) => void
  /**
   * The editor gained or lost unsaved changes.
   *
   * Reported because a write under a *clean* editor is harmless — it notices, says the file changed,
   * and one press reloads it — while a write under unsaved work takes that work with it. The
   * difference has to leave this frame for the agent's write guard to ask the right question.
   */
  onDirtyChange?: (dirty: boolean) => void
  /**
   * Where a copy should go — the platform action of the same name.
   *
   * The editor asks for it when it has to write a *new* file: its own Save As, and the copy a
   * permanent redaction produces. Absent (a host with no native dialog), the request is refused in
   * words rather than written somewhere the person did not choose.
   */
  onSaveFileDialog?: (spec: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | null>
}

/** `Uint8Array` → a transferred `ArrayBuffer` the frame can read as-is. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer)
}

/** Anything the editor sends may be a `Uint8Array`, an `ArrayBuffer`, or a view of one. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

/**
 * What the overlay needs to close honestly: whether there is anything to save, and a way to ask
 * the editor to save it before the frame goes away.
 */
export interface OfficeFrameHandle {
  /** The editor's own answer, as last reported through `setDirty`. */
  isDirty(): boolean
  /** Ask the editor to save, and resolve when it has (or when waiting longer stops being kind). */
  flushAndClose(): Promise<void>
  /**
   * Replace one span of the open document, if it still holds what the caller was told it holds.
   *
   * The **person** asks for this: an offer from the conversation is applied by them, and the change
   * lands as one step of the editor's own history. That is the whole reason it is here rather than
   * in a tool — nothing outside this frame writes the document.
   */
  applyEdit: (edit: OfficeFrameEdit) => Promise<OfficeFrameEditResult>
}

/** Long enough for a write to finish on a slow disk, short enough that closing a window is not a wait. */
const CLOSE_SAVE_TIMEOUT_MS = 8000

/**
 * The marker a copied deck payload rides on, inside the OS clipboard's HTML.
 *
 * Browsers only expose the standard clipboard types (`text/plain`, `text/html`, images), so a
 * custom MIME type — which is how GenOffice carries a slide between its own windows — is invisible
 * here. HTML is not: the payload goes in a `data-` attribute, which clipboard implementations
 * preserve, and reads back as text.
 */
const DECK_CLIPBOARD_MARKER = 'data-craft-deck'

interface DeckClipboardPayload {
  kind: 'elements' | 'slides'
  items?: unknown[]
  bundles?: unknown[]
  pngs?: string[]
}

/** base64 of the UTF-8 bytes: `btoa` takes latin1 and slide XML is anything but. */
function encodePayload(payload: DeckClipboardPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodePayload(base64: string): DeckClipboardPayload | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DeckClipboardPayload
    return parsed && (parsed.kind === 'elements' || parsed.kind === 'slides') ? parsed : null
  } catch {
    return null
  }
}

/** Put a payload where another window (and a later run) can find it. */
async function writeDeckClipboard(payload: DeckClipboardPayload): Promise<void> {
  try {
    const html = `<meta charset="utf-8"><div ${DECK_CLIPBOARD_MARKER}="${encodePayload(payload)}"></div>`
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([' '], { type: 'text/plain' }),
      }),
    ])
  } catch {
    // No permission, or a clipboard that refuses HTML: the copy still works in this window,
    // because the host kept its own.
  }
}

/** The payload another window put on the clipboard, or null when it is not ours. */
async function readDeckClipboard(): Promise<DeckClipboardPayload | null> {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      if (!item.types.includes('text/html')) continue
      const html = await (await item.getType('text/html')).text()
      const match = new RegExp(`${DECK_CLIPBOARD_MARKER}="([^"]+)"`).exec(html)
      if (!match?.[1]) continue
      const payload = decodePayload(match[1])
      if (payload) return payload
    }
  } catch {
    // A clipboard that cannot be read is not an error: the host's own copy is still there.
  }
  return null
}


export const OfficeFrame = React.forwardRef<OfficeFrameHandle, OfficeFrameProps>(function OfficeFrame({
  origin,
  app,
  file,
  readBytes,
  writeBytes,
  labels,
  className,
  onReady,
  onSelectionChange,
  onOfficeDeck,
  onOfficeWorkbook,
  onOfficePdf,
  onSaveProducedFile,
  onSaveFileDialog,
  onOpenFileDialog,
  onPickDirectory,
  onOfficeExportPdf,
  onNotice,
  readOnly,
  onError,
  onCopySaved,
  onDirtyChange,
}, ref) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const [failed, setFailed] = React.useState<string | null>(null)
  /** Whether the editor has unsaved changes — every one of the four reports this through `setDirty`. */
  const dirtyRef = React.useRef(false)
  /** Methods this host answered with `undefined` — said once each, because each one stalls a boot. */
  const unansweredRef = React.useRef<Set<string>>(new Set())
  /** The editor's answer to "save, we are closing", while one is pending. */
  const closeWaiterRef = React.useRef<((saved: boolean) => void) | null>(null)
  /** Where the copy went, so success can be turned into a look at the file itself. */
  const lastSaveAsTarget = React.useRef<string | null>(null)

  // The editor is long-lived: callbacks change identity on every render, and a listener that
  // captured the first ones would answer with stale props forever.
  const handlers = React.useRef({ file, readBytes, writeBytes, labels, onReady, onSelectionChange, onOfficeDeck, onOfficeWorkbook, onOfficePdf, onOfficeExportPdf, onNotice, onSaveProducedFile, onSaveFileDialog, onOpenFileDialog, onPickDirectory, onError, onCopySaved, onDirtyChange })
  handlers.current = { file, readBytes, writeBytes, labels, onReady, onSelectionChange, onOfficeDeck, onOfficeWorkbook, onOfficePdf, onOfficeExportPdf, onNotice, onSaveProducedFile, onSaveFileDialog, onOpenFileDialog, onPickDirectory, onError, onCopySaved, onDirtyChange }

  const post = React.useCallback((message: OfficeHostMessage) => {
    const target = frameRef.current?.contentWindow
    // The frame's origin differs from the app's in Electron (`craft-local://…`), so the target
    // origin is the frame's own — never '*', which would address anything it navigated to.
    target?.postMessage(message, '*')
  }, [])

  /**
   * Ask the frame to replace one span, and answer when it has (or when it plainly will not).
   *
   * The **person** asks for this — an offer from the conversation is applied by them — which is why
   * it lives on the frame rather than in a tool: nothing outside the frame writes the document, so
   * the change is one step in the editor's own history and one press of undo takes it back.
   */
  const applyEdit = React.useCallback(
    (edit: OfficeFrameEdit) =>
      new Promise<OfficeFrameEditResult>((resolve) => {
        const target = frameRef.current?.contentWindow
        if (!target) {
          resolve({ ok: false, message: 'the editor is not on screen' })
          return
        }
        const id = ++editSeq.current
        pendingEdits.current.set(id, resolve)
        post({ protocol: 'craft-office/1', type: 'edit', id, edit })
        // A frame that never answers must not hang its caller — a crashed editor, or a bundle
        // built before this message existed.
        window.setTimeout(() => {
          const waiting = pendingEdits.current.get(id)
          if (!waiting) return
          pendingEdits.current.delete(id)
          waiting({ ok: false, message: 'the editor did not answer' })
        }, 5000)
      }),
    [post],
  )

  /** Edits in flight: the frame answers by id, so a late answer is still matched to its call. */
  const pendingEdits = React.useRef(new Map<number, (result: OfficeFrameEditResult) => void>())
  const editSeq = React.useRef(0)


  /** Load a document (once at mount, and again if the editor asks for another path). */
  const sendOpen = React.useCallback(
    async (next: OfficeFrameFile) => {
      try {
        /**
         * The deck editor is the one that does not take bytes: `consumePendingOpen` is answered by
         * the host door with a **parsed deck** (its renderer sets `slides` from it), and the file it
         * parses is the one on disk. Reading a multi-megabyte pptx here only to post it into a frame
         * that will not look at it is a copy of the file per open, so it is skipped.
         */
        const bytes = app === 'slides' ? new Uint8Array() : await handlers.current.readBytes(next.path)
        const request: OfficeOpenRequest = {
          id: next.id,
          path: next.path,
          name: next.name,
          bytes: toBuffer(bytes),
          hash: next.hash,
        }
        post({ protocol: 'craft-office/1', type: 'open', file: request })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setFailed(message)
        handlers.current.onError?.(message)
      }
    },
    [post],
  )

  /**
   * Host → frame, the direction the shim answers through its `on*` subscriptions.
   *
   * `payload` is the **single argument** the editor's callback receives — the shim does
   * `listeners[i](data.payload)`. A path is a string, not `[string]`; passing an array here is how
   * `saveAsTo` gets handed a list instead of a path and writes nowhere.
   */
  const pushEvent = React.useCallback(
    (channel: string, payload: unknown) => {
      post({ protocol: 'craft-office/1', type: 'event', channel, payload })
    },
    [post],
  )

  const answer = React.useCallback(
    async (id: number, method: string, args: unknown[]) => {
      const current = handlers.current
      const unanswered = unansweredRef.current
      const reply = (value: unknown) => post({ protocol: 'craft-office/1', type: 'result', id, ok: true, value })

      switch (method) {
        // ---- what the editor needs before it can draw ----
        case 'getLanguage':
          return reply(current.labels?.language ?? 'en')
        case 'getSystemLocale':
          return reply(current.labels?.language ?? 'en')
        case 'getTheme':
          return reply(current.labels?.theme ?? 'light')
        case 'getDocumentTheme':
          return reply(current.labels?.documentTheme ?? 'light')
        case 'getAutoSaveDefault':
          return reply(current.labels?.autoSave ?? false)
        case 'getAuthorName':
          return reply(current.labels?.author ?? '')
        case 'getAiPanelPrefs':
          // Answered as a switched-off AI panel: an object, not undefined, or the panel mounts.
          return reply({ open: false })

        // ---- opening another document in the same frame ----
        case 'openDocxPath': {
          const path = typeof args[0] === 'string' ? args[0] : ''
          const name = path.split(/[\\/]/).pop() || path
          if (path) await sendOpen({ id: path, path, name })
          return reply(null)
        }

        // ---- saving: the host owns the disk ----
        case 'saveDocx':
        case 'saveDocxTo': {
          const path = typeof args[0] === 'string' && args[0] ? args[0] : current.file.path
          const bytes = toBytes(args[1])
          if (!bytes) return post({ protocol: 'craft-office/1', type: 'result', id, ok: false, error: 'no bytes to save' })
          try {
            await current.writeBytes(path, bytes)
            return reply({ ok: true, path })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return post({ protocol: 'craft-office/1', type: 'result', id, ok: false, error: message })
          }
        }

        case 'saveDocxAs':
        case 'saveDocxNew':
          // A dialog the host does not have yet. Refusing is honest; a silent `undefined` would
          // leave the editor's dirty flag set with no explanation.
          return post({ protocol: 'craft-office/1', type: 'result', id, ok: false, error: 'Save As is not available here' })

        /**
         * Printing is the **window's**, in both hosts.
         *
         * The editor's own print stylesheet lays the document out one page per sheet, and the
         * document is this frame — so the browser that is already showing it can print it
         * (`window.print()` on the frame's own window). A hub has no Chromium to print with and a
         * desktop could print a temp PDF, but neither is needed: this is the shortest path and it
         * behaves the same in a window and in a tab.
         */
        /**
         * Where a copy goes: the redaction copy, and any other Save As the editor asks for.
         *
         * The editor cannot pick a path — it is a page, and the disk belongs to whoever is looking
         * at it. So the question comes here, the answer goes back as an **event**
         * (`onSaveAsRequest`), and the editor writes to it through the ordinary `save` door (a
         * redaction is allowed precisely because that target is not the open file). `onSaveAsFlow`
         * brackets the whole thing so the editor's autosave stays out of the way.
         *
         * A cancelled dialog is not an error: the editor is told nothing, its flags clear, and no
         * file appears.
         */
        case 'requestRedactionCopy': {
          if (app !== 'pdf') return reply(undefined)
          const source = current.file.path
          const name = (source.split(/[\\/]/).pop() ?? 'document').replace(/\.[^.]+$/, '') || 'document'
          const ask = current.onSaveFileDialog
          pushEvent('onSaveAsFlow', true)
          let target: string | null = null
          if (ask) {
            try {
              target = await ask({
                title: 'Save the redacted copy',
                defaultPath: `${source.slice(0, source.length - name.length - 4)}${name} (redacted).pdf`,
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
              })
            } catch {
              target = null
            }
          } else {
            /**
             * No native dialog — a browser tab attached to a hub.
             *
             * Refusing here would be wrong: the file lives on the hub, the hub's paths are ones the
             * person can see (they are the workspace's own files), and a redaction that cannot be
             * saved is a feature that does not exist. So the copy goes beside the document, named
             * with the minute it was made: a sibling cannot be confused with the original, and the
             * timestamp keeps a second copy from overwriting the first.
             */
            const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
            target = `${source.slice(0, source.length - name.length - 4)}${name} (redacted ${stamp}).pdf`
          }
          if (!target) {
            pushEvent('onSaveAsFlow', false)
            return reply({ ok: true })
          }
          lastSaveAsTarget.current = target
          pushEvent('onSaveAsRequest', target)
          return reply({ ok: true })
        }

        /** The editor reports how `saveAsTo` went. Nothing is left for the host to do but close
         *  the bracket opened above — the file is on disk, or the editor already said why not. */
        case 'sendSaveAsResult': {
          pushEvent('onSaveAsFlow', false)
          /**
           * The copy is on disk — so show it.
           *
           * A redaction cannot be previewed beforehand from out here: the marks live inside the
           * editor and leave it only in a `save` request. What can be shown is the result, and that
           * is the honest question anyway — not "is a box drawn" but "is the text gone". The page
           * comes back from the host's own pdfium, so what is on screen is the file, not a claim
           * about it.
           */
          const written = args[0] === true ? lastSaveAsTarget.current : null
          lastSaveAsTarget.current = null
          if (written && current.onCopySaved) {
            void current.onOfficePdf?.('renderPagePng', [written, { pageIndex: 0, pxWidth: 720 }])
              .then((answer) => {
                const png = (answer as { png?: string } | null)?.png
                if (png) current.onCopySaved?.({ path: written, png })
              })
              .catch(() => undefined)
          }
          return reply(undefined)
        }

        // ---- how dirty it is, and saving on the way out ----
        // All four editors report their own dirtiness; the two names below are the same answer.
        // (The pdf app says `sendCloseSaveResult`, the other three `reportCloseSaveResult`.)
        case 'setDirty': {
          const next = args[0] === true
          const changed = dirtyRef.current !== next
          dirtyRef.current = next
          // The editor telling the host it has unsaved work — the one fact a write guard needs,
          // and the one thing the host cannot see for itself.
          if (changed) handlers.current.onDirtyChange?.(next)
          return reply(undefined)
        }

        case 'reportCloseSaveResult':
        case 'sendCloseSaveResult': {
          // Left in place for the waiter to clear: nulling it here would fail that waiter's own
          // identity check, and closing would sit on the timeout instead of on the answer.
          const waiter = closeWaiterRef.current
          waiter?.(args[0] === true)
          return reply(undefined)
        }

        /**
         * Where exported files go.
         *
         * There is no directory picker in the client bridge, so the person picks a **file name** and
         * the folder it sits in becomes the target — one dialog instead of two, and the name they
         * type still names the first file, which is what a person expects to see happen.
         */
        case 'pickExportDir': {
          // A real folder dialog: the client has had one since the working-directory picker
          // (`dialog:openFolder` → `properties: ['openDirectory', 'createDirectory']`).
          const pickFolder = current.onPickDirectory
          if (pickFolder) {
            try {
              const folder = await pickFolder()
              if (folder) return reply(folder)
              // Cancelled, or a host without a native dialog: fall through to naming a file, which
              // still yields a folder (the one the name is in).
            } catch {
              // no folder dialog here — same fallback
            }
          }
          const ask = current.onSaveFileDialog
          if (!ask) return reply(null)
          const stem = (current.file.path.split(/[\\/]/).pop() ?? 'deck').replace(/\.[^.]+$/, '') || 'deck'
          try {
            const chosen = await ask({
              title: 'Where the exported images go',
              defaultPath: `${stem}-01.png`,
              filters: [{ name: 'PNG', extensions: ['png'] }],
            })
            if (!chosen) return reply(null)
            return reply(chosen.slice(0, chosen.length - (chosen.split(/[\\/]/).pop() ?? '').length).replace(/[\\/]$/, ''))
          } catch {
            return reply(null)
          }
        }

        /** The editor draws the pages; this only puts the files on the person's disk. */
        case 'exportImages': {
          const request = (args[0] ?? {}) as { dir?: unknown; baseName?: unknown; pngsBase64?: unknown }
          const dir = typeof request.dir === 'string' ? request.dir : ''
          const baseName = typeof request.baseName === 'string' && request.baseName ? request.baseName : 'slide'
          const pages = Array.isArray(request.pngsBase64) ? (request.pngsBase64 as string[]) : []
          if (!dir || pages.length === 0) return reply({ ok: false, error: 'nothing to write' })
          const pad = pages.length >= 100 ? 3 : 2
          const separator = dir.includes('\\') ? '\\' : '/'
          const paths: string[] = []
          try {
            for (const [index, base64] of pages.entries()) {
              const name = `${baseName}-${String(index + 1).padStart(pad, '0')}.png`
              const path = `${dir}${separator}${name}`
              const binary = atob(base64)
              const bytes = new Uint8Array(binary.length)
              for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
              await current.writeBytes(path, bytes)
              paths.push(path)
            }
          } catch (error) {
            return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return reply({ ok: true, paths })
        }

        /** One shape as a picture: the editor hands over a PNG, the client names the file. */
        case 'savePicture': {
          const request = (args[0] ?? {}) as { pngBase64?: unknown; defaultName?: unknown }
          const base64 = typeof request.pngBase64 === 'string' ? request.pngBase64 : ''
          if (!base64) return reply({ ok: false })
          const suggested = typeof request.defaultName === 'string' && request.defaultName ? request.defaultName : 'picture'
          let target = `${suggested}.png`
          const ask = current.onSaveFileDialog
          if (ask) {
            try {
              const chosen = await ask({
                title: 'Save the picture',
                defaultPath: target,
                filters: [{ name: 'PNG', extensions: ['png'] }],
              })
              if (!chosen) return reply({ ok: true })
              target = chosen
            } catch {
              // no dialog: written beside the document
            }
          }
          try {
            const binary = atob(base64)
            const bytes = new Uint8Array(binary.length)
            for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
            await current.writeBytes(target, bytes)
            return reply({ ok: true, path: target })
          } catch (error) {
            return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        /**
         * Insert audio or video: the file is the client's, the document is the host's — so the bytes
         * are read here and handed to the deck door as `addMediaBytes`.
         */
        case 'insertMedia': {
          if (app !== 'slides') break
          const pick = current.onOpenFileDialog
          const door = current.onOfficeDeck
          if (!pick || !door) return reply(null)
          const slideIndex = Number(args[0]) || 0
          const kind = args[1] === 'audio' ? 'audio' : 'video'
          const fitWidthPx = Number(args[2]) || 0
          let chosen: string[] = []
          try {
            chosen = await pick()
          } catch {
            return reply(null)
          }
          const path = chosen[0]
          if (!path) return reply(null)
          try {
            const bytes = await current.readBytes(path)
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            const answer = await door('addMediaBytes', [
              {
                slideIndex,
                kind,
                base64: btoa(binary),
                ext: (path.split('.').pop() ?? 'mp4').toLowerCase(),
                name: path.split(/[\\/]/).pop() ?? '',
                fitWidthPx,
              },
            ])
            return reply(answer ?? null)
          } catch (error) {
            return reply({ error: error instanceof Error ? error.message : String(error) })
          }
        }

        /**
         * Copy: the host owns the payload, the client's clipboard is what carries it.
         *
         * The host's clipboard dies with its process, so a copy in one window would be invisible in
         * the next. After a copy succeeds the payload is pulled out and written to the **OS**
         * clipboard as HTML with a marker; a paste in any other window (or after a reload) reads it
         * back and hands it to the door. No new channel, and it works in a browser tab too.
         */
        case 'copyElements': {
          const door = current.onOfficeDeck
          if (!door) return reply(0)
          const count = (await door('copyElements', args)) as number
          if (typeof count === 'number' && count > 0) {
            const payload = (await door('clipboardPayload', [])) as DeckClipboardPayload | null
            if (payload?.kind) await writeDeckClipboard(payload)
          }
          return reply(count)
        }

        case 'copySlides': {
          const door = current.onOfficeDeck
          if (!door) return reply(false)
          const copied = (await door('copySlides', args)) as boolean
          if (copied) {
            const payload = (await door('clipboardPayload', [])) as DeckClipboardPayload | null
            if (payload?.kind) await writeDeckClipboard(payload)
          }
          return reply(copied)
        }

        /** Paste: a payload on the OS clipboard wins; otherwise the host's own copy is used. */
        case 'pasteElements': {
          const door = current.onOfficeDeck
          if (!door) return reply(null)
          const payload = await readDeckClipboard()
          const withItems =
            payload && payload.kind === 'elements'
              ? [{ ...((args[0] ?? {}) as Record<string, unknown>), items: payload.items }, ...args.slice(1)]
              : args
          return reply((await door('pasteElements', withItems)) ?? null)
        }

        case 'pasteSlide': {
          const door = current.onOfficeDeck
          if (!door) return reply(null)
          const payload = await readDeckClipboard()
          const withBundle =
            payload && payload.kind === 'slides'
              ? [
                  {
                    ...((args[0] ?? {}) as Record<string, unknown>),
                    bundles: payload.bundles,
                    ...(payload.pngs?.length ? { png: payload.pngs[0] } : {}),
                  },
                  ...args.slice(1),
                ]
              : args
          return reply((await door('pasteSlide', withBundle)) ?? null)
        }

        /**
         * The OS clipboard's own cut / copy / paste, while a text field is being edited.
         *
         * GenOffice's main calls `webContents.cut()` and friends — "do the native thing to the
         * focused element". Inside a frame that is `document.execCommand`, which Electron allows
         * (the paste included, where a plain page would not) and which acts on the editor's own
         * selection instead of anything this frame would have to reconstruct.
         */
        case 'nativeClipboard': {
          const action = args[0] === 'cut' ? 'cut' : args[0] === 'paste' ? 'paste' : 'copy'
          try {
            return reply(document.execCommand(action))
          } catch {
            return reply(false)
          }
        }

        /** A shape rendered to a PNG lands on the OS clipboard, where the person expects a copy. */
        case 'copyElementsImage': {
          const base64 = typeof args[1] === 'string' ? args[1] : ''
          if (!base64) return reply(false)
          try {
            const binary = atob(base64)
            const bytes = new Uint8Array(binary.length)
            for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
            return reply(true)
          } catch {
            // No clipboard permission (an unfocused frame, a browser without the API): the editor
            // falls back to its own in-app clipboard, which is the right behaviour.
            return reply(false)
          }
        }

        /** Whether the OS clipboard holds something the deck can paste — best effort. */
        case 'clipboardExternal': {
          try {
            const items = await navigator.clipboard.read()
            const hasImage = items.some((item) => item.types.some((type) => type.startsWith('image/')))
            return reply(hasImage ? { kind: 'image' } : null)
          } catch {
            return reply(null)
          }
        }

        /**
         * The docs editor's serializers: **it** produces the text, we only decide where it goes.
         *
         * GenOffice's own main opens a save dialog here. A hosted editor has no dialog of its own,
         * so the client's is asked — and when there is none (a browser tab on a hub) the file goes
         * beside the document under the name the editor suggested, which is a path the person can
         * already see.
         */
        case 'exportHtml':
        case 'exportMarkdown': {
          const extension = method === 'exportHtml' ? 'html' : 'md'
          const body = typeof args[1] === 'string' ? args[1] : ''
          const source = current.file.path
          const fileName = source.split(/[\\/]/).pop() ?? 'document'
          const stem = fileName.replace(/\.[^.]+$/, '') || 'document'
          const beside = `${source.slice(0, source.length - fileName.length)}${stem}.${extension}`
          const ask = current.onSaveFileDialog
          let target = beside
          if (ask) {
            try {
              const chosen = await ask({
                title: method === 'exportHtml' ? 'Export as HTML' : 'Export as Markdown',
                defaultPath: beside,
                filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
              })
              if (!chosen) return reply({ ok: true })
              target = chosen
            } catch {
              target = beside
            }
          }
          try {
            await current.writeBytes(target, new TextEncoder().encode(body))
          } catch (error) {
            return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return reply({ ok: true, path: target })
        }

        /**
         * The editor's Export as PDF, for the formats whose document is only bytes here.
         *
         * (A deck answers this through its own door: its host holds the document and prints it.)
         * What is printed is the **file on disk** — main re-opens it in a hidden window, because
         * that is the only place with the editor as the top document. The editor saves around this
         * call, so the file is the document; a save still in flight would print the version before
         * it, which is why the answer carries the path that was written.
         */
        case 'exportPdf': {
          if (app !== 'docs' && app !== 'sheets') break
          const source = current.file.path
          const fileName = source.split(/[\\/]/).pop() ?? 'document'
          const stem = fileName.replace(/\.[^.]+$/, '') || 'document'
          const beside = `${source.slice(0, source.length - fileName.length)}${stem}.pdf`
          let target = beside
          const ask = current.onSaveFileDialog
          if (ask) {
            try {
              const chosen = await ask({
                title: 'Export as PDF',
                defaultPath: beside,
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
              })
              if (!chosen) return reply({ ok: true })
              target = chosen
            } catch {
              target = beside
            }
          }
          const exportPdf = current.onOfficeExportPdf
          if (!exportPdf) return reply({ ok: false, error: 'This host cannot print documents.' })
          try {
            const written = await exportPdf(source, target)
            return reply({ ok: true, path: written?.path ?? target })
          } catch (error) {
            return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        /**
         * The show, as this host can run it: **in this window**, at full screen, no second screen.
         *
         * GenOffice's presenter opens an audience window of its own and relays slide state to it.
         * That window is a whole second surface (its own page, its own relay), and it is **deferred
         * by decision** — not missing: a second screen would need an `?mode=audience` window plus a
         * same-origin BroadcastChannel relay. What the editor supports for a host without one is
         * `{ audience: false }` — the presenter view runs here and the slides fill this screen.
         */
        case 'presenterStart': {
          // Said once, where the host can say it out loud: the show runs here, and if the person
          // expected it on the projector this line is the difference between "refused" and "broken".
          handlers.current.onNotice?.('preview.presentSingleScreen')
          return reply({ audience: false })
        }

        /** Nothing to relay to, and nothing to stop: the presenter view is this window. */
        case 'presenterEnd':
        case 'presenterSync':
        case 'presenterInk':
        case 'presenterSwap':
          return reply(true)

        /** Only an audience window asks these, and this host never opens one. */
        case 'audienceReady':
        case 'audienceNav':
          return reply(null)

        /** Full screen, from inside the frame — the iframe is granted `fullscreen` for this. */
        case 'setShowFullScreen': {
          const on = args[0] !== false
          try {
            if (on) {
              if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
            } else if (document.fullscreenElement) {
              await document.exitFullscreen()
            }
            return reply(true)
          } catch {
            // No gesture, no permission: the show stays windowed, which is what it did before.
            return reply(false)
          }
        }

        /**
         * Compare: pick the second document here, read its text on the host.
         *
         * The text has to come from **pdfium** on both sides, and only the host runs pdfium — so the
         * client's job is the pick and the door's is the extraction.
         */
        case 'compareReadPdf': {
          if (app !== 'pdf') break
          const pick = current.onOpenFileDialog
          const door = current.onOfficePdf
          if (!pick || !door) return reply({ ok: false, reason: 'no file picker here' })
          let chosen: string[] = []
          try {
            chosen = await pick()
          } catch {
            return reply({ ok: false, canceled: true })
          }
          const pickedPath = chosen[0]
          if (!pickedPath) return reply({ ok: false, canceled: true })
          try {
            const answer = await door('compareReadPdf', [pickedPath])
            return reply(answer ?? { ok: false, reason: 'the host could not read that document' })
          } catch (error) {
            return reply({ ok: false, reason: error instanceof Error ? error.message : String(error) })
          }
        }

        /** The open document's own text, for the other half of the diff. */
        case 'compareReadOpen': {
          if (app !== 'pdf') break
          const door = current.onOfficePdf
          if (!door) return reply({ ok: false, reason: 'no pdf host here' })
          try {
            const requested = typeof args[0] === 'string' && args[0] ? args[0] : current.file.path
            const answer = await door('compareReadOpen', [requested])
            return reply(answer ?? { ok: false, reason: 'the host could not read this document' })
          } catch (error) {
            return reply({ ok: false, reason: error instanceof Error ? error.message : String(error) })
          }
        }

        /**
         * The deck's Insert Image: the deck's document lives on the host, but the **file** is the
         * client's. So the picker and the bytes happen here, and the result goes back through the
         * deck door as `addImageBytes` — the op that already knows how to place a picture.
         */
        case 'insertImage': {
          if (app !== 'slides') break
          const pick = current.onOpenFileDialog
          const door = current.onOfficeDeck
          if (!pick || !door) return reply(null)
          let chosen: string[] = []
          try {
            chosen = await pick()
          } catch {
            return reply(null)
          }
          const path = chosen[0]
          if (!path) return reply(null)
          const extension = (path.split('.').pop() ?? '').toLowerCase()
          if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(extension)) return reply(null)
          try {
            const bytes = await current.readBytes(path)
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            const base64 = btoa(binary)
            // The picture keeps its own size, centred: ask the browser for the pixels it decoded.
            const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
              const image = new Image()
              image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
              image.onerror = () => resolve(null)
              image.src = `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${base64}`
            })
            const slideIndex = Number(args[0]) || 0
            const fitWidthPx = Number(args[1]) || 0
            const answer = await door('addImageBytes', [
              {
                slideIndex,
                base64,
                ext: extension === 'jpeg' ? 'jpg' : extension,
                fitWidthPx,
                ...(size ? { naturalPx: size } : {}),
              },
            ])
            return reply(answer ?? null)
          } catch (error) {
            return reply({ error: error instanceof Error ? error.message : String(error) })
          }
        }

        /**
         * Insert Image: the client picks a file, this side reads it and hands back base64.
         *
         * GenOffice's own main reads the file after a native dialog. A hosted editor has no dialog,
         * so the client's is asked and the bytes are read through the frame's own reader — the same
         * one every open goes through, so the workspace boundary is the same too.
         */
        case 'pickImage': {
          const pick = current.onOpenFileDialog
          if (!pick) return reply(null)
          let chosen: string[] = []
          try {
            chosen = await pick()
          } catch {
            return reply(null)
          }
          const path = chosen[0]
          if (!path) return reply(null)
          const extension = (path.split('.').pop() ?? '').toLowerCase()
          const mime =
            extension === 'png'
              ? 'image/png'
              : extension === 'jpg' || extension === 'jpeg'
                ? 'image/jpeg'
                : extension === 'gif'
                  ? 'image/gif'
                  : null
          if (!mime) return reply(null)
          try {
            const bytes = await current.readBytes(path)
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            return reply({ base64: btoa(binary), mime, name: path.split(/[\\/]/).pop() ?? '' })
          } catch (error) {
            return reply({ error: error instanceof Error ? error.message : String(error) })
          }
        }

        /**
         * Save Image As: the editor hands over a URL (usually a `data:` one it drew), the client
         * names a file, and the bytes are written through the frame's writer.
         */
        case 'saveImageAs': {
          const source = typeof args[0] === 'string' ? args[0] : ''
          if (!source) return reply({ ok: false })
          const ask = current.onSaveFileDialog
          const stem = (current.file.path.split(/[\\/]/).pop() ?? 'image').replace(/\.[^.]+$/, '') || 'image'
          let target = `${stem}.png`
          if (ask) {
            try {
              const chosen = await ask({
                title: 'Save Image As',
                defaultPath: target,
                filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }],
              })
              if (!chosen) return reply({ ok: true })
              target = chosen
            } catch {
              // no dialog (a hub): the file is written beside the document, under its own name
            }
          }
          try {
            const response = await fetch(source)
            const bytes = new Uint8Array(await response.arrayBuffer())
            await current.writeBytes(target, bytes)
            return reply({ ok: true, path: target })
          } catch (error) {
            return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        case 'print': {
          const target = frameRef.current?.contentWindow
          if (!target) return reply({ ok: false, error: 'The document is not on screen.' })
          try {
            target.focus()
            target.print()
            return reply({ ok: true })
          } catch (error) {
            return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }

        default:
          // The deck editor's document lives on the host, so everything it asks about *the
          // document* is one door (`onOfficeDeck`), with the path in front: the frame knows which
          // file it is showing, the renderer only knows method names.
          const door = app === 'slides'
            ? handlers.current.onOfficeDeck
            : app === 'sheets'
              ? handlers.current.onOfficeWorkbook
              : app === 'pdf'
                ? handlers.current.onOfficePdf
                : undefined
          if (door) {
            try {
              const value = await door(method, [current.file.path, ...args])
              /**
               * A file the host produced (split pages, extracted pages, page images) and could not
               * put where the person can reach — a hub, whose disk is not theirs. The host answers
               * with `downloads`; delivering them is this side's job, because only the client knows
               * where the person's files are. The editor is told a name, which is what it shows.
               */
              const produced = value as { downloads?: Array<{ id: string; name: string; size: number; mime: string }> } | null
              if (produced?.downloads?.length) {
                const save = handlers.current.onSaveProducedFile
                if (save) {
                  for (const download of produced.downloads) await save(download)
                  return reply({ ...produced, savedPath: produced.downloads[0]?.name })
                }
              }
              return reply(value)
            } catch (error) {
              return post({
                protocol: 'craft-office/1',
                type: 'result',
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          /**
           * A feature this host does not implement (AI, print, spell check, recents, …) — or, when
           * the editor never draws, the method it was waiting on.
           *
           * Said once per method per mount, because the failure is otherwise silent in the worst
           * way: the shim waits its own 30 s for an answer and the editor sits on "opening…" while
           * the console shows nothing at all. One line names the gap.
           */
          if (!unanswered.has(method)) {
            unanswered.add(method)
            console.info(`[office-frame] ${app} asked "${method}", which this host does not answer`)
          }
          return reply(undefined)
      }
    },
    [post, sendOpen, pushEvent],
  )

  /**
   * Close without losing what has not been written.
   *
   * The direction is the host's, like Save As: the editor never knows the window is going away, so
   * it is told (`onCloseSaveRequest`) and answers when the write is done. A timeout is not
   * politeness — a person pressing Escape must not be held by an editor that never replies.
   */
  React.useImperativeHandle(
    ref,
    () => ({
      applyEdit,
      isDirty: () => dirtyRef.current,
      flushAndClose: () =>
        new Promise<void>((resolve) => {
          if (!dirtyRef.current) return resolve()
          // Either answer ends the wait: a save that failed is a reason to say so, not to trap the
          // person in a window that will not close.
          const settle = () => {
            if (closeWaiterRef.current !== settle) return
            closeWaiterRef.current = null
            resolve()
          }
          closeWaiterRef.current = settle
          // `{ flushAll }` is the pdf app's argument; the other three take none and ignore it.
          pushEvent('onCloseSaveRequest', app === 'pdf' ? { flushAll: true } : undefined)
          setTimeout(() => {
            if (closeWaiterRef.current === settle) {
              closeWaiterRef.current = null
              resolve()
            }
          }, CLOSE_SAVE_TIMEOUT_MS)
        }),
    }),
    [app, pushEvent],
  )

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (!isOfficeFrameMessage(event.data)) return
      if (event.data.type === 'ready') {
        // The editor is up. What a host can get wrong here is invisible on screen — a frame with
        // no box draws nothing and reports nothing — so the two numbers that decide it travel to
        // the log: the frame's own viewport, and the box it was given (`[office-frame]`).
        const box = frameRef.current?.getBoundingClientRect()
        const child = (event.data as { size?: { w: number; h: number } }).size
        ;(window as unknown as { electronAPI?: { debugLog?: (...args: unknown[]) => void } })
          .electronAPI?.debugLog?.(
            '[office-frame]',
            JSON.stringify({
              app,
              box: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
              child: child ?? null,
              window: { w: window.innerWidth, h: window.innerHeight },
            }),
          )
        void sendOpen(handlers.current.file).then(() => handlers.current.onReady?.())
        return
      }
      if (event.data.type === 'editResult') {
        const resolve = pendingEdits.current.get(event.data.id)
        if (resolve) {
          pendingEdits.current.delete(event.data.id)
          resolve({ ok: event.data.ok, message: event.data.message })
        }
        return
      }

      if (event.data.type === 'selection') {
        // The positions travel with the text: a host that offers "change this passage" cannot work
        // from the words alone.
        handlers.current.onSelectionChange?.({
          text: event.data.text,
          from: event.data.from ?? null,
          to: event.data.to ?? null,
        })
        return
      }
      void answer(event.data.id, event.data.method, event.data.args)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [answer, sendOpen])

  // A document switched underneath the frame is a new open, not a reload: reloading would throw
  // away the frames the editor has already built and flash the whole surface.
  React.useEffect(() => {
    if (!file.path) return
    void sendOpen(file)
  }, [file.id, file.path, sendOpen])

  // Read-only is asked for in the address, because the shim is chosen when the document is
  // served: it is the shim that decides whether a save leaves the frame at all.
  const src = `${origin.replace(/\/+$/, '')}/${app}/${readOnly ? '?__craftReadOnly=1' : ''}`

  return (
    <div className={className ?? 'relative h-full w-full'}>
      <iframe
        ref={frameRef}
        src={src}
        title={file.name}
        className="absolute inset-0 h-full w-full border-0"
        // Same-origin in the Web UI and a first-party label in Electron: the editor is our
        // vendored build and needs `localStorage`, workers and its own fetches to run.
        // `clipboard-*` is what the deck's own copy/paste uses; `fullscreen` is what its show mode
        // asks for — without it a presentation would run inside a frame that cannot fill a screen.
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
          {failed}
        </div>
      )}
    </div>
  )
})
