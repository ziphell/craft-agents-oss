/**
 * The app's bundled drawio editor, addressed.
 *
 * One channel, because the editor has no state of its own to read or write. What a
 * caller needs from this host is the single thing only the host can compute: the
 * origin the vendored directory is served at. Its label carries a hash of the install
 * path (`local-origin.ts`), so a renderer cannot work it out and has to ask.
 *
 * Unlike the website handlers there is no workspace argument and no lookup — one
 * editor ships with the app. Both ways of having no address are errors rather than
 * null, for the same reason as a website's: the renderer has nothing to show either
 * way, and a blank frame says less than a sentence naming which of the two it is.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [RPC_CHANNELS.drawio.GET_ORIGIN] as const

export function registerDrawioHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.drawio.GET_ORIGIN, async () => {
    if (!deps.drawioOrigin) {
      throw new Error(
        'This host cannot serve the editor’s own origin, so there is nowhere to render the diagram.',
      )
    }
    const origin = deps.drawioOrigin()
    if (!origin) {
      throw new Error(
        'The bundled drawio editor is not installed. Run: bun scripts/fetch-drawio-assets.ts',
      )
    }
    return origin
  })
}
