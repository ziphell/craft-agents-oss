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
   * The origin a website is reachable at, from a host that can serve one.
   *
   * A website is rendered at its own origin — `http://<label>.localhost/`, answered
   * from disk by the app that owns it — which means only a host with a protocol
   * handler can hand that address out. Electron is that host, and it supplies this;
   * a standalone server has no way to serve `*.localhost` on someone else's machine,
   * so it leaves this absent and the caller is told there is no address rather than
   * being given one nothing answers.
   */
  websiteOrigin?: (workspaceRootPath: string, websiteSlug: string) => string | null

  /**
   * The origin the app's bundled drawio editor is served at, from a host that can
   * serve one.
   *
   * Same mechanism as `websiteOrigin` and the same reason it is optional, with one
   * difference worth naming: there is no workspace argument. What is served is a
   * directory that ships with the app, so the answer is install-wide — and null
   * means the bundle is not installed (`bun scripts/fetch-drawio-assets.ts`), which
   * is a state a checkout can legitimately be in.
   */
  drawioOrigin?: () => string | null

  /**
   * Told after a workspace's tweaks change: a switch flipped, a tweak deleted.
   *
   * The host that runs tweaks in its own browser window
   * (`apps/electron/src/main/tweaks-injector.ts`) uses this to reach pages that are already
   * open — without it, flipping a switch would sit in `tweak.json` until the next reload,
   * which is not what a switch means. Absent on a host with no browser window, where there
   * is nothing to re-apply.
   */
  onTweaksChanged?: (workspaceId: string) => void
}
