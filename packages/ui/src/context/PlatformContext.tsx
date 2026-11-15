/**
 * PlatformContext - Abstraction layer for platform-specific actions
 *
 * This context allows UI components to work in both Electron and web environments.
 * Electron provides actual implementations, web viewer provides no-ops or alternatives.
 *
 * Pattern: Dependency injection via context
 * - Components call usePlatform() to get actions
 * - Actions are optional - components check before calling
 * - Web viewer can provide inline modals instead of new windows
 */

import { createContext, useContext, type ReactNode } from 'react'

/**
 * Platform-specific actions that components may need
 * All actions are optional - platforms only implement what they support
 */
export interface PlatformActions {
  /**
   * Open a file in the default application (Electron: shell.openPath)
   * Web: Could show file contents inline or provide download
   */
  onOpenFile?: (path: string) => void

  /**
   * Open a file directly in the system editor, bypassing the link interceptor.
   * Used by overlay header badges — when already viewing a file, "Open" should
   * launch an external editor, not re-trigger the in-app preview.
   */
  onOpenFileExternal?: (path: string) => void

  /**
   * Open a URL in the default browser (Electron: shell.openExternal)
   * Web: window.open or navigation
   */
  onOpenUrl?: (url: string) => void

  /**
   * Open this HTML in a browser — as a tab, at the file's own address.
   *
   * What a preview draws is a document, not a browsing context: its frame was handed the text, so
   * it has no address, and nothing that needs one — a relative reference, a script, a `fetch` —
   * works inside it. This is the same file opened for real, in a browser, where a tab shows a page
   * at an address and all of that does.
   *
   * *Which* browser is not this component's question: the host answers it from the person's own
   * setting (the app's own browser window by default, their system browser when they asked for
   * that), which is why this takes a path and nothing else.
   *
   * Absent where there is no such window to open (a browser client: a tab there is already the
   * person's own browser).
   */
  onOpenFileInBrowser?: (path: string) => void

  /**
   * Open a code preview in a new window (Electron: opens Monaco window)
   * Web: Could show inline modal with syntax highlighting
   */
  onOpenCodePreview?: (sessionId: string, toolUseId: string) => void

  /**
   * Open a terminal output preview (Electron: opens terminal window)
   * Web: Could show inline modal with monospace output
   */
  onOpenTerminalPreview?: (sessionId: string, toolUseId: string) => void

  /**
   * Open a markdown preview window
   * Web: Could show fullscreen modal
   */
  onOpenMarkdownPreview?: (content: string) => void

  /**
   * Open a multi-file diff view
   * Web: Could show inline diff viewer
   */
  onOpenMultiFileDiff?: (sessionId: string, turnId: string) => void

  /**
   * Copy text to clipboard
   * Works in both environments via navigator.clipboard
   */
  onCopyToClipboard?: (text: string) => Promise<void>

  /**
   * Open turn details in a new window/modal
   */
  onOpenTurnDetails?: (sessionId: string, turnId: string) => void

  /**
   * Open activity details in a new window/modal
   */
  onOpenActivityDetails?: (sessionId: string, activityId: string) => void

  /**
   * Read a file's contents as UTF-8 string (Electron: fs.readFile via IPC)
   * Used by datatable/spreadsheet/html-preview blocks to load file-backed content
   */
  onReadFile?: (path: string) => Promise<string>

  /**
   * Write a file's contents as UTF-8 string (Electron: fs.writeFile via IPC).
   * Resolves with the absolute path that was written.
   *
   * The host's boundary is **the one that let it show the file**: whatever it can read out to
   * this component, it can save back — a file shown and then refused would be the one case this
   * exists for. That is deliberately not the agent's write policy (tools are bounded
   * separately, and this does not widen them). Refusals come back as refusals; do not pre-check
   * the boundary, or the check becomes a second description of it.
   */
  onWriteFile?: (path: string, content: string) => Promise<{ path: string }>

  /**
   * Hand part of a file over to the conversation.
   *
   * Deliberately data rather than a finished sentence: the host owns the input and
   * knows how this app quotes things into it, and a shared component inventing that
   * phrasing would be a second answer to a question the host already answers.
   *
   * Two shapes because two editors have two things to hand over: a page hands its markup
   * (`html`, quoted as HTML), a document hands the paragraph the person selected (`text`).
   * Both name the file so the agent can open it.
   *
   * Absent on hosts with no conversation to hand anything to.
   */
  /**
   * Hand a selection to the conversation, with **where it is**.
   *
   * `start`/`end` are offsets in the file's own text and `hash` is a short digest of the version
   * they belong to: without them the agent knows *what* was selected but not *which occurrence*,
   * and a document that says a sentence twice is exactly where that matters. A selection with no
   * offsets (an office document's text) is still useful — it just cannot be addressed.
   */
  onSendToChat?: (payload: {
    path: string
    html?: string
    text?: string
    start?: number
    end?: number
    hash?: string
    /**
     * What those offsets count.
     *
     * `file` — characters of the file itself (markdown, html): a writer can act on them directly.
     * `editor` — positions inside the editor's own document (the office editors): exact, but in a
     * coordinate system the file does not share. Saying which one is the difference between an
     * address and a number that looks like one.
     */
    coords?: 'file' | 'editor'
  }) => void

  /**
   * The origin the app's bundled drawio editor is served at.
   *
   * Rejects when the bundle is not installed or the host cannot serve an origin at
   * all — both of which are things the reader needs told, so the message is shown
   * rather than swallowed. Used by `drawio-preview` blocks, which put their frame
   * there and speak the bridge in `@craft-agent/shared/drawio/types` to it.
   */
  onGetDrawioOrigin?: () => Promise<string>

  /**
   * The origin the vendored office editors are served at, and where `OfficeFrame` points.
   *
   * Absent on a host that cannot serve an origin at all, and rejecting when the build is not
   * installed — the reader is told which of the two it is, the same way drawio's answer is.
   * The Web UI answers with a path on the hub (`/office`); Electron answers with the
   * `craft-local://` label its own host handed out.
   */
  onGetOfficeOrigin?: () => Promise<string>

  /**
   * Write bytes to a file — the office editors' save path.
   *
   * The host owns the disk, never the frame: a document built in the editor comes back as
   * bytes, and this is the only way they reach a file. Same boundary as `writeFile`.
   */
  /**
   * Write bytes to a file the app is showing.
   *
   * `overwrite` is the person's answer after a save was refused because the file changed on disk
   * (`FileSaveStatus` asks, main refuses). It is a parameter rather than a second method so that a
   * caller cannot write "the other way" without saying so.
   */
  onWriteFileBinary?: (path: string, data: Uint8Array, overwrite?: boolean) => Promise<void>

  /**
   * Put a file the host produced in front of the person: the desktop saves it, a browser downloads
   * it. Same action a design export uses — a host that produces bytes it cannot place needs one
   * delivery path, not one per feature.
   */
  onSaveProducedFile?: (download: { id: string; name: string; size: number; mime: string }) => Promise<unknown>

  /**
   * Ask the person where to put a copy, and get the path (or `null` when they cancelled).
   *
   * A document editor's "Save As" and its redaction copy both need one: the host writes to a
   * filesystem, and a copy nobody chose a place for is a copy nobody can find. Absent on a host
   * that cannot show a native dialog — a browser tab — and the editor's Save As is then not
   * offered, which is the honest answer rather than writing it somewhere of our choosing.
   */
  onSaveFileDialog?: (spec: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | null>

  /**
   * Ask the client for a **folder** (the editors' "export these images here").
   *
   * The bridge has had this since the working-directory picker: `dialog:openFolder` arrives at the
   * client as an open dialog with `properties: ['openDirectory', 'createDirectory']`. So a frame can
   * ask for a folder the same way it asks for a file, and the answer is a path, not a path we guessed
   * from a file name.
   */
  onPickDirectory?: () => Promise<string | null>

  /**
   * Ask the client for a file to read (the editors' own Insert Image, for one).
   *
   * `openFileDialog` is a client capability — a hub can read its own disk, but only the person can
   * point at a file they can see.
   */
  onOpenFileDialog?: () => Promise<string[]>

  /**
   * The editor's own Export as PDF.
   *
   * Printing needs a Chromium with the editor as its top document, so the answer comes from the
   * main process (`office-export.ts`); the renderer can only decide where the file goes and ask.
   */
  onOfficeExportPdf?: (path: string, outPath?: string) => Promise<{ path?: string } | null>

  /**
   * The deck editor’s method table — one door, because its document lives on the host.
   *
   * The frame forwards what the slides bundle asks for with the document’s path in front: the
   * frame knows which file it is showing, the renderer only knows method names. Absent on a host
   * that cannot hold a deck (no engine bundle), and the editor then opens onto nothing.
   */
  onOfficeDeck?: (method: string, args: unknown[]) => Promise<unknown>

  /** The workbook editor’s method table: its document is parsed by a sidecar process. */
  onOfficeWorkbook?: (method: string, args: unknown[]) => Promise<unknown>

  /** The pdf editor’s method table: it edits the bytes, the host writes them. */
  onOfficePdf?: (method: string, args: unknown[]) => Promise<unknown>
  /**
   * "An editor of mine is showing this document" / "it is not any more".
   *
   * The agent cannot see an editor, so this is how it learns that a write would land under one.
   * Called by `useFileWriter` and `useOfficeDocument` as they mount and unmount — the two hooks
   * every file surface goes through — so no component has to remember to do it.
   */
  onDocumentOpenChange?: (path: string, open: boolean) => void
  /**
   * "This editor holds changes that are not on disk (or has just saved them)".
   *
   * The question the agent's write guard actually asks: a document nobody has typed in can be
   * written under — the editor notices and reloads — while unsaved work cannot, because the reload
   * that follows would take it. Presence is not the same thing as risk.
   */
  onDocumentDirtyChange?: (path: string, dirty: boolean) => void

  /**
   * Something in the workspace's project files tree changed on disk, whoever wrote it.
   *
   * The event's own payload — which file `fs.watch` happened to name — is deliberately not
   * passed through: it is relative, sometimes spelled with the platform's separator, and
   * null when the watcher does not know. A component that wants to know *what* changed reads
   * the file, which is the authority this workbench is built on; this only says to look.
   *
   * Absent on a host with no watcher, where a component reads once and stays.
   */
  onProjectFilesChanged?: (callback: () => void) => () => void

  /**
   * A document the office hosts wrote — an agent's save, a conversion. Carries an absolute path, so
   * a view can tell whether the file it drew is the one that moved (the project watcher cannot: it
   * only covers the project tree, and its payload is relative).
   */
  onOfficeFileWritten?: (callback: (path: string) => void) => () => void

  /**
   * Read a file as data URL (Electron: fs.readFile via IPC + base64 encode)
   * Used by image-preview blocks and image overlays
   */
  onReadFileDataUrl?: (path: string) => Promise<string>

  /**
   * Read a file as binary Uint8Array (Electron: fs.readFile via IPC)
   * Used by PDF preview blocks that need raw binary data
   */
  onReadFileBinary?: (path: string) => Promise<Uint8Array>

  /**
   * Reveal a file in the system file manager (Electron: shell.showItemInFolder)
   * Web: Not available (menu items hidden when undefined)
   */
  onRevealInFinder?: (path: string) => void

  /**
   * Platform-specific file manager name for display labels.
   * macOS → "Finder", Windows → "Explorer", Linux → "File Manager"
   * Defaults to "Finder" if not provided.
   */
  fileManagerName?: string

  /**
   * Show/hide macOS traffic light buttons (close/minimize/maximize).
   * Used to hide them when fullscreen overlays are open to prevent accidental clicks.
   * No-op on non-macOS platforms or in web viewer.
   */
  onSetTrafficLightsVisible?: (visible: boolean) => void
}

const PlatformContext = createContext<PlatformActions>({})

export interface PlatformProviderProps {
  children: ReactNode
  actions?: PlatformActions
}

/**
 * PlatformProvider - Wraps components with platform-specific actions
 *
 * Usage in Electron:
 * ```tsx
 * <PlatformProvider actions={{
 *   onOpenFile: (path) => window.electronAPI.openFile(path),
 *   onOpenUrl: (url) => window.electronAPI.openUrl(url),
 *   onCopyToClipboard: (text) => navigator.clipboard.writeText(text),
 * }}>
 *   <SessionViewer session={session} />
 * </PlatformProvider>
 * ```
 *
 * Usage in Web Viewer:
 * ```tsx
 * <PlatformProvider actions={{
 *   onOpenUrl: (url) => window.open(url, '_blank'),
 *   onCopyToClipboard: (text) => navigator.clipboard.writeText(text),
 *   // onOpenFile not provided - clicks do nothing or show inline
 * }}>
 *   <SessionViewer session={session} mode="readonly" />
 * </PlatformProvider>
 * ```
 */
export function PlatformProvider({ children, actions = {} }: PlatformProviderProps) {
  return (
    <PlatformContext.Provider value={actions}>
      {children}
    </PlatformContext.Provider>
  )
}

/**
 * usePlatform - Access platform-specific actions in components
 *
 * Components should check if actions exist before calling:
 * ```tsx
 * const { onOpenFile } = usePlatform()
 * const handleClick = () => onOpenFile?.(filePath)
 * ```
 *
 * Or provide fallback behavior:
 * ```tsx
 * const { onOpenCodePreview } = usePlatform()
 * const handleClick = () => {
 *   if (onOpenCodePreview) {
 *     onOpenCodePreview(sessionId, toolUseId)
 *   } else {
 *     setShowInlineModal(true)
 *   }
 * }
 * ```
 */
export function usePlatform(): PlatformActions {
  return useContext(PlatformContext)
}

export default PlatformContext
