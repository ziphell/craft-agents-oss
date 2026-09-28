/**
 * The one `http` handler this app installs, and the host it answers.
 *
 * A protocol handler is registered per **scheme** on a **session**, so there is
 * exactly one of these per session — and the call below is the whole integration:
 * the host is asked first and answers only for the labels it has handed an address
 * out for, and a request it does not claim goes back to Chromium untouched.
 *
 * Two things about the interception are worth knowing before adding another host:
 *
 * - only `http` is handled. Our host is `http://…localhost`, so all `https`
 *   traffic of real sites keeps its original path;
 * - `*.localhost` is full of real dev servers, so an *unclaimed* label must pass
 *   through rather than 404 — which is why the host here answers "not mine" with
 *   null instead of a response.
 *
 * ## Which sessions
 *
 * One handler per session, and the app has two that matter:
 *
 * - the **browser windows'** session (`persist:browser-pane`), where a website
 *   opened in a tab is looked at;
 * - the **app's own** session, because the offscreen website-thumbnail window is
 *   created without a partition of its own and so renders there.
 *
 * Registering on the app's own session does mean every `http` request the renderer
 * makes passes through this handler first — including its own document in
 * development. That is why the pass-through is the first-class answer here: it is
 * the same request Chromium would have made, only observed.
 */

import { serveWebsiteRequest } from './website-host'
import { serveDrawioRequest } from './drawio-host'
import type { PassThrough, ProtocolHostSession } from './local-http'

/**
 * Route one `http` request: the first host that claims the label answers it, and
 * everything else is Chromium's.
 *
 * Each host answers only for labels it has handed an address out for, so the order
 * here is not a precedence rule — no two of them can claim the same label. Adding a
 * host means adding a line, not a decision.
 */
export async function handleLocalHostRequest(
  request: Request,
  passThrough: PassThrough,
): Promise<Response> {
  return (
    (await serveWebsiteRequest(request)) ?? (await serveDrawioRequest(request)) ?? passThrough(request)
  )
}

/**
 * Install the handler on a session. Call it once per session the app renders on:
 * a host is only reachable from a session that has this installed.
 */
export function registerLocalHostHandler(ses: ProtocolHostSession, passThrough: PassThrough): void {
  ses.protocol.handle('http', (request) => handleLocalHostRequest(request, passThrough))
}
