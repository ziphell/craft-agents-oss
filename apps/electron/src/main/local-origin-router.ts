/**
 * The one handler for the app's own scheme.
 *
 * A protocol handler is registered per **scheme, per session**, and a second
 * `handle` for a scheme replaces the first without a word — the symptom being a
 * feature that quietly stopped being served. So every feature that lives on
 * `craft-local` is routed from here, and each feature answers only for the labels
 * it handed out (returning `null` for the rest).
 *
 * Installed on the app's own session only: that is the boundary that keeps a
 * design's files away from the workspace browser (see design-preview-host).
 */

import { LOCAL_ORIGIN_SCHEME } from '@craft-agent/shared/local-origin'
import { serveDrawioRequest } from './drawio-host'
import { serveDesignPreviewRequest } from './design-preview-host'
import { textResponse, type ProtocolHostSession } from './local-http'

/** Sessions this is already installed on (see the guard below). */
const installed = new WeakSet<object>()

export function registerLocalOriginHandler(ses: ProtocolHostSession): void {
  // Idempotent per session: a second `handle` for a scheme replaces the first, and
  // the callers are per-window setups that would otherwise re-install it.
  if (installed.has(ses)) return
  installed.add(ses)

  ses.protocol.handle(LOCAL_ORIGIN_SCHEME, async (request) => {
    const response =
      (await serveDrawioRequest(request)) ?? (await serveDesignPreviewRequest(request))
    return response ?? textResponse(404, `Nothing is served at ${request.url}.`)
  })
}
