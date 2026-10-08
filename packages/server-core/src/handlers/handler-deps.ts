import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type { DesignRenderExportRequest } from '@craft-agent/shared/designs/types'

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
   * Produce a design's PDF / per-slide PNG / motion video with the host's own
   * renderer.
   *
   * Those formats need a real engine, which only the desktop app has (a hidden
   * `BrowserWindow` — see apps/electron/src/main/design-exporter.ts). A
   * headless/standalone server leaves this absent, and the export handler
   * refuses PDF/PNG/video there. HTML/ZIP need no renderer and work regardless.
   */
  designExportRender?: (req: DesignRenderExportRequest) => Promise<string[]>
}
