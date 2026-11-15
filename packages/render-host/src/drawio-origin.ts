/**
 * drawio's origin, on a host with no Electron.
 *
 * The desktop drives the engine in a hidden window on an origin it serves itself
 * (`apps/electron/src/main/drawio-host.ts`). A hub has no such window, so the same three addresses
 * are served here over `node:http` and the headless browser loads them:
 *
 *   /__craft/engine.html   the engine document — nothing on screen, one on-demand resident
 *   /__craft/engine.js     the bridge that defines `window.__craftDiagram`
 *   /<anything else>       the vendored app, from `resources/drawio`
 *
 * Both the document and the bridge come from `@craft-agent/shared/drawio/engine-shell`, so this and
 * the desktop serve one protocol rather than two that look alike.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { contentTypeFor, resolveServedPath } from '@craft-agent/shared/local-origin'
import { DRAWIO_EMBED_PARAMS } from '@craft-agent/shared/drawio/types'
import {
  DRAWIO_ENGINE_PATH,
  DRAWIO_ENGINE_SCRIPT_PATH,
  DRAWIO_SHELL_CSP,
  drawioEngineBridgeScript,
  drawioEngineShellDocument,
} from '@craft-agent/shared/drawio/engine-shell'

export interface DrawioOriginOptions {
  /** The vendored webapp: `resources/drawio`, whose `index.html` is the editor. */
  dir: string
}

export class DrawioOrigin {
  #server: Server | null = null
  #baseUrl = ''

  constructor(private readonly options: DrawioOriginOptions) {}

  get baseUrl(): string {
    if (!this.#baseUrl) throw new Error('The drawio origin is not running.')
    return this.#baseUrl
  }

  async start(): Promise<string> {
    if (this.#server) return this.#baseUrl
    const server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        respondText(response, 500, error instanceof Error ? error.message : String(error))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The drawio origin did not bind a port.')
    this.#server = server
    this.#baseUrl = `http://127.0.0.1:${address.port}`
    return this.#baseUrl
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    this.#baseUrl = ''
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.#baseUrl)
    const pathname = decodeURIComponent(url.pathname)

    // Both reserved paths, so a refetch of the vendored directory cannot take our documents with it.
    if (pathname === DRAWIO_ENGINE_PATH) {
      return respond(response, 200, 'text/html; charset=utf-8', drawioEngineShellDocument(), {
        'content-security-policy': DRAWIO_SHELL_CSP,
        'cache-control': 'no-store',
      })
    }
    if (pathname === DRAWIO_ENGINE_SCRIPT_PATH) {
      return respond(response, 200, 'text/javascript; charset=utf-8', drawioEngineBridgeScript(DRAWIO_EMBED_PARAMS), {
        'cache-control': 'no-store',
      })
    }

    const accept = request.headers.accept ?? ''
    const relative = pathname.replace(/^\/+/, '')
    // A navigation with no file behind it is the editor itself: one address a person can open.
    // A path that names a file never falls back — answering a missing script with HTML turns a
    // clear 404 into a parse error.
    const wantsDocument = relative === '' || (relative === 'index.html' && accept.includes('text/html'))
    const target = wantsDocument
      ? resolveServedPath(this.options.dir, 'index.html')
      : resolveServedPath(this.options.dir, relative)
    if (!target) return respondText(response, 403, `Nothing of drawio is reachable at ${pathname}.`)

    let bytes: Buffer
    try {
      bytes = await readFile(target)
    } catch {
      return respondText(response, 404, `Nothing of drawio is at ${pathname}.`)
    }
    respond(response, 200, contentTypeFor(target), bytes, { 'cache-control': 'public, max-age=300' })
  }
}

/** The same shape as `office-origin.ts`: one policy for how this origin answers. */
function respond(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers })
  response.end(body)
}

function respondText(response: ServerResponse, status: number, message: string): void {
  respond(response, status, 'text/plain; charset=utf-8', message)
}
