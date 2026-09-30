/**
 * The answers every host in this app gives, so they give them the same way.
 *
 * A host serves documents from disk, and the responses are the same shape: a file with the
 * content type its extension names, a plain text refusal for the paths nobody can
 * act on, and no caching anywhere, because everything here is edited constantly and
 * a cached document would show an earlier state with no hint that it is stale.
 */

import { stat } from 'fs/promises'

/**
 * Hand a request back to Chromium's own network stack.
 *
 * `bypassCustomProtocolHandlers` is what keeps the handler from answering itself,
 * and it makes the request Chromium would have made anyway.
 */
export type PassThrough = (request: Request) => Promise<Response>

/**
 * The piece of `Electron.Session` these hosts need.
 *
 * Structural on purpose: the routing is the interesting part and it has to be
 * testable without an Electron runtime (and without `electron` being imported at
 * all, which in a plain Node/Bun process is a path string rather than the API).
 */
export interface ProtocolHostSession {
  protocol: {
    handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void
  }
}

/** A body and the content type it is answered with. */
export interface LocalPayload {
  body: Buffer | Uint8Array
  contentType: string
  /**
   * Extra headers, for the answers whose policy is their own — a synthesized page
   * that carries a content-security policy, say. The three below are always set and
   * cannot be overridden here: they are what every host in this app agrees on.
   */
  headers?: Record<string, string>
}

/** Is this path a file on disk? (A directory, or nothing at all, is not.) */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * A plain-text response, for refusals and errors.
 *
 * Plain text on purpose: these are read by a person or a log rather than rendered,
 * and they are the one thing on our origins that is not the author's to style.
 */
export function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

/** A document or asset, as the answer to `request`. */
export function fileResponse(request: Request, payload: LocalPayload): Response {
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(payload.body), {
    status: 200,
    headers: {
      'content-type': payload.contentType,
      'cache-control': 'no-store',
      // The document is ours, but it may embed third-party snapshots; keep it
      // from claiming the privileges of the app shell.
      'x-content-type-options': 'nosniff',
      ...payload.headers,
    },
  })
}
