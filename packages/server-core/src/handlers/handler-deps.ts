import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  messagingRegistry?: IMessagingGatewayRegistry

  /**
   * The origin the app's bundled drawio editor is served at, from a host that can
   * serve one.
   *
   * A host with a protocol handler can hand that address out; a standalone server
   * runs no browser session of its own, so it leaves this
   * absent. There is no workspace argument: what is served is a
   * directory that ships with the app, so the answer is install-wide — and null
   * means the bundle is not installed (`bun scripts/fetch-drawio-assets.ts`), which
   * is a state a checkout can legitimately be in.
   */
  drawioOrigin?: () => string | null

  /**
   * The origin the vendored GenOffice editors are served at, from a host that can serve one.
   *
   * Same terms as `drawioOrigin`: install-wide (one directory per editor ships with the app),
   * absent on a host with no protocol handler, null when the build has never been copied in
   * (`bun scripts/build-office-assets.ts`) — a state a checkout or a fresh server can
   * legitimately be in, and the caller says so rather than showing an empty frame.
   */
  officeOrigin?: () => string | null

  /**
   * Print a document to PDF with the host's own renderer.
   *
   * Printing needs a Chromium, and the editor has to be the top document so its own print
   * stylesheet hides the chrome — so this is answered by whoever has a browser, and not by "the
   * desktop": the app opens a hidden window (`webContents.printToPDF`), a hub runs the launcher in
   * `resources/render-host` (`page.pdf()` over Playwright, spawned rather than launched in its own
   * process). Absent only where no renderer is installed, and the handler then says so.
   */
  officeExportPdf?: (input: {
    app: 'docs' | 'sheets' | 'slides' | 'pdf'
    path: string
    bytes: Uint8Array
    outPath: string
  }) => Promise<{ path: string }>

  /**
   * One PNG per page of a document, written into `outDir`.
   *
   * The same two steps everywhere: print the document, then rasterise with pdfium — which is wasm
   * and needs no window, so this is the half a host without a browser could still do. Both hosts
   * hand it to the same `pdf-raster` code.
   */
  officeExportPages?: (input: {
    app: 'docs' | 'sheets' | 'slides' | 'pdf'
    path: string
    bytes: Uint8Array
    outDir: string
  }) => Promise<{ files: string[] }>

  /**
   * The deck editor's method table — the document lives in the host, so its calls land here.
   *
   * Absent on a host that cannot hold a deck (no engine bundle): the editor then opens onto
   * nothing rather than onto a blank frame it cannot explain.
   */
  officeDeck?: (method: string, args: unknown[]) => Promise<unknown>

  /** The workbook editor’s method table — parsed and read by the sidecar process. */
  officeWorkbook?: (method: string, args: unknown[]) => Promise<unknown>

  /** The pdf editor’s method table — the renderer edits bytes, the host writes them. */
  officePdf?: (method: string, args: unknown[]) => Promise<unknown>

  /**
   * The open-document guard: what a file looked like when the app handed it to an editor, and
   * whether a save would now overwrite somebody else's work.
   *
   * A host answers it with `office-guard.ts` in the desktop app, and a host that cannot (a hub with
   * no editor open) simply omits it — a save is then unguarded, which is the state every host was
   * in before this existed and is exactly the shape the other office dependencies take.
   *
   * `record` is called with bytes already in hand (the read that produced them, the save about to
   * write them), so an ordinary save costs one `stat` and no extra read. `check` says `conflict`
   * when the file on disk is no longer the one that was read; the caller decides what to offer,
   * and `overwrite` in the write calls is how the person's "save anyway" comes back in.
   */
  officeDisk?: {
    record(path: string, bytes: Uint8Array): void | Promise<void>
    check(path: string): Promise<'ok' | 'conflict'>
  }

  /**
   * Make (or find) a poster for one creation, and answer the image file's absolute path.
   *
   * A poster is a picture of a document, so it needs a renderer: the desktop app opens a hidden
   * window (and, for office formats, the same editor window an export uses — see
   * `apps/electron/src/main/creation-thumbnailer.ts`). A headless host leaves this absent and the
   * library draws format badges instead, which is the same fallback the export seam gets.
   */
  /**
   * Write one work out as another format, at a destination the person chose.
   *
   * Desktop-only for the same reason every renderer seam is: printing a page and serialising a
   * Word document both need a window. A headless host leaves it absent and the library offers no
   * export actions at all, rather than offering ones that cannot finish.
   */
  creationExport?: (input: {
    workspaceRootPath: string
    path: string
    target: 'pdf' | 'docx' | 'md' | 'html'
    outPath: string
  }) => Promise<string>

  creationThumbnail?: {
    /** Poster path for this version of the file; null when there is none (and none can be made). */
    ensure(input: {
      workspaceRootPath: string
      path: string
      format: string
      mtimeMs: number
      bytes: number
    }): Promise<string | null>
    /** Drop posters whose document the index no longer knows — deleted, moved or renamed files. */
    prune(workspaceRootPath: string, livePaths: readonly string[]): void
  }

  /**
   * Where a work's versions live — the app's own data folder, keyed by workspace.
   *
   * A version is a cache, not a document: nothing of it belongs in the workspace, and a host with
   * no data folder of its own (a hub serving a browser) simply has no versions. Absent here means
   * the library offers none, which is an answer and not a failure.
   */
  creationVersions?: {
    dir(workspaceRootPath: string): string
  }

  /**
   * Where the session index is remembered between launches — a folder of the host's own.
   *
   * The index is derived from the transcripts, and rebuilding it from nothing costs a full parse of
   * every transcript in the workspace (565 ms on a workspace of 133 sessions / 140 MB — see
   * `cache-file.ts`). Remembering it makes the first open of a launch a warm scan (75 ms). What is
   * written is a cache, keyed per session by `(size, mtimeMs)` and by `CREATIONS_INDEX_VERSION`, so
   * an entry is only ever a shortcut to a parse that the filesystem has already agreed to.
   *
   * Absent means memory only: every launch pays one cold scan. That is the old behaviour, and it is
   * what a host with no data folder of its own (a browser client) still gets.
   */
  creationsIndex?: {
    dir(workspaceRootPath: string): string
  }
}
