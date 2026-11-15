/**
 * The editors' origin, on a host that has no Electron.
 *
 * Printing a `.docx` cannot be done by opening the file somewhere and photographing it: the Word
 * editor prints **itself** (its `@media print` rules are the reason), so it has to be the top
 * document, and as a top document it has no parent page to ask. The desktop app solves that by
 * opening a hidden window at an origin it serves (`apps/electron/src/main/office-origin.ts`) and
 * answering the editor's questions over `/__craft/office-call/<token>`. This is the same origin,
 * served by `node:http` instead of `protocol.handle`, with one difference that matters:
 *
 * **the print is done from outside the page.** The editors do not rasterise themselves; they lay
 * their pages out and hand the result to their host — the docs editor prints its own window, the
 * spreadsheet hands over a finished HTML print job, the deck hands over one drawing per slide.
 * On the desktop "the host" is the main process, and `webContents.printToPDF` is the call. Here it
 * is the browser driving this page, and `page.pdf()` is the call. Measured before this file was
 * written: printing the page **while it is waiting on the answer that asks for the print** works
 * (21,975 bytes in 160 ms) — which is why the answer handler below can do it inline.
 *
 * The routes are the same five the desktop serves, under the same names, because the shim in the
 * editor is the same shim: `/__craft/office-shim.js`, `/office-file/<token>`, `/office-call/<token>`,
 * `/office-write/<token>`, `/office-done/<token>`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { contentTypeFor, resolveServedPath } from '@craft-agent/shared/local-origin'
import { OFFICE_SHIM_PATH, type OfficeApp } from '@craft-agent/shared/office/types'
import { officeShimScript } from '@craft-agent/shared/office/shim'
import { prepareEditorDocument } from '@craft-agent/shared/office/document'

const FILE_PATH = '/__craft/office-file'
const CALL_PATH = '/__craft/office-call'
const WRITE_PATH = '/__craft/office-write'
const DONE_PATH = '/__craft/office-done'

/** One question from an editor, and the answer it is waiting for. */
export type OfficeAnswer = (method: string, args: unknown[]) => Promise<unknown>

export interface OfficeOriginOptions {
  /** The directory holding `docs/`, `sheets/`, `slides/`, `pdf/`. Defaults to the bundled assets. */
  appsDir: string
  /** How long an editor may take to finish its export. */
  timeoutMs?: number
}

interface DocumentRecord {
  path: string
  name: string
  bytes: Uint8Array
}

interface OutputRecord {
  path: string
  done: Promise<{ ok?: boolean; error?: string; timedOut?: boolean }>
  settle: (report: { ok?: boolean; error?: string; timedOut?: boolean }) => void
}

export class OfficeOrigin {
  #server: Server | null = null
  #baseUrl = ''
  #documents = new Map<string, DocumentRecord>()
  #outputs = new Map<string, OutputRecord>()
  #answers = new Map<string, OfficeAnswer>()
  #scratch: string | null = null

  constructor(private readonly options: OfficeOriginOptions) {}

  /** `http://127.0.0.1:<port>` — the only origin a printed page is allowed to reach. */
  get baseUrl(): string {
    if (!this.#baseUrl) throw new Error('The office origin is not running.')
    return this.#baseUrl
  }

  async start(): Promise<string> {
    if (this.#server) return this.#baseUrl
    this.#scratch = await mkdtemp(join(tmpdir(), 'craft-office-'))
    const server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        respondText(response, 500, error instanceof Error ? error.message : String(error))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The office origin did not bind a port.')
    this.#server = server
    this.#baseUrl = `http://127.0.0.1:${address.port}`
    return this.#baseUrl
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    this.#baseUrl = ''
    this.#documents.clear()
    this.#outputs.clear()
    this.#answers.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.#scratch) await rm(this.#scratch, { recursive: true, force: true }).catch(() => undefined)
    this.#scratch = null
  }

  /** The bytes an export is printing, under a token only that export knows. */
  addDocument(path: string, bytes: Uint8Array): string {
    const token = randomUUID()
    this.#documents.set(token, { path, name: basename(path) || path, bytes })
    return token
  }

  releaseDocument(token: string): void {
    this.#documents.delete(token)
  }

  /**
   * Where a headless export writes, and the signal that it finished.
   *
   * A caller that names its own path (a conversion always does) keeps the file; one that does not
   * gets a scratch path that is removed with the origin.
   */
  addOutput(outPath?: string): { token: string; path: string; done: Promise<{ ok?: boolean; error?: string; timedOut?: boolean }> } {
    const token = randomUUID()
    const path = outPath ?? join(this.#scratch ?? tmpdir(), `${token}.pdf`)
    let settle: OutputRecord['settle'] = () => undefined
    const done = new Promise<{ ok?: boolean; error?: string; timedOut?: boolean }>((resolve) => {
      settle = resolve
    })
    this.#outputs.set(token, { path, done, settle })
    return { token, path, done }
  }

  releaseOutput(token: string): void {
    this.#outputs.delete(token)
  }

  /** The one door an editor's question comes through, per export. */
  setAnswer(token: string, answer: OfficeAnswer): void {
    this.#answers.set(token, answer)
  }

  // ── routing ────────────────────────────────────────────────────────────────────────────────

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.#baseUrl)
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === OFFICE_SHIM_PATH) return this.#serveShim(url, response)
    if (pathname.startsWith(`${FILE_PATH}/`)) return this.#serveFile(pathname.slice(FILE_PATH.length + 1), response)
    if (pathname.startsWith(`${CALL_PATH}/`)) return this.#serveCall(pathname.slice(CALL_PATH.length + 1), request, response)
    if (pathname.startsWith(`${WRITE_PATH}/`)) return this.#serveWrite(pathname.slice(WRITE_PATH.length + 1), request, response)
    if (pathname.startsWith(`${DONE_PATH}/`)) return this.#serveDone(pathname.slice(DONE_PATH.length + 1), request, response)
    return this.#serveEditor(pathname, url, response)
  }

  /** The shim, told which document to open and which token to ask under. */
  #serveShim(url: URL, response: ServerResponse): void {
    const exportToken = url.searchParams.get('export')
    const headlessToken = url.searchParams.get('headless')
    const format = url.searchParams.get('format')
    const file = exportToken ? this.#documents.get(exportToken) : undefined
    const output = headlessToken ? this.#outputs.get(headlessToken) : undefined
    // A top document is its own parent, so every question it has goes over this route. The token
    // is the window's own: it can only be asked about the document it was opened on.
    const callToken = headlessToken && output ? headlessToken : exportToken && file ? exportToken : undefined

    const script = officeShimScript({
      // The token alone: the shim builds `/__craft/office-call/<token>` itself, and a path here
      // would be encoded into the token and 404 every call (measured).
      ...(callToken ? { callToken } : {}),
      ...(file && exportToken
        ? { exportFile: { url: `${FILE_PATH}/${encodeURIComponent(exportToken)}`, path: file.path, name: file.name } }
        : {}),
      ...(output && headlessToken
        ? {
            headless: {
              format: format === 'md' ? 'md' : format === 'pdf' ? 'pdf' : 'html',
              outPath: output.path,
              writeUrl: `${WRITE_PATH}/${encodeURIComponent(headlessToken)}`,
              doneUrl: `${DONE_PATH}/${encodeURIComponent(headlessToken)}`,
            },
          }
        : {}),
    })
    respond(response, 200, 'text/javascript; charset=utf-8', script)
  }

  #serveFile(token: string, response: ServerResponse): void {
    const record = this.#documents.get(token)
    if (!record) return respondText(response, 404, 'No such document.')
    respond(response, 200, 'application/octet-stream', record.bytes)
  }

  async #serveCall(token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const answer = this.#answers.get(token)
    if (!answer) return respondJson(response, 404, { ok: false, error: 'This export is not running.' })
    const body = await readBody(request)
    let parsed: { method?: unknown; args?: unknown }
    try {
      parsed = JSON.parse(body) as { method?: unknown; args?: unknown }
    } catch {
      return respondJson(response, 400, { ok: false, error: 'A host call must be JSON.' })
    }
    const method = typeof parsed.method === 'string' ? parsed.method : ''
    const args = Array.isArray(parsed.args) ? (parsed.args as unknown[]) : []
    try {
      const value = await answer(method, args)
      return respondJson(response, 200, { ok: true, value: encodeBytes(value) })
    } catch (error) {
      return respondJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The bytes a headless export produced (`md`, `html`) — the editor hands them over, not us. */
  async #serveWrite(token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const output = this.#outputs.get(token)
    if (!output) return respondText(response, 404, 'No such export.')
    // The only route where the bytes are the document rather than a message.
    await writeFile(output.path, Buffer.from(await readBody(request), 'utf8'))
    respondJson(response, 200, { ok: true })
  }

  async #serveDone(token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const output = this.#outputs.get(token)
    if (!output) return respondText(response, 404, 'No such export.')
    const body = await readBody(request)
    output.settle(parseReport(body))
    respondJson(response, 200, { ok: true })
  }

  /** The editor itself: `/office/<app>/…`, the same layout the hub serves to the Web UI. */
  async #serveEditor(pathname: string, url: URL, response: ServerResponse): Promise<void> {
    const match = /^\/office\/([^/]+)(\/.*)?$/.exec(pathname)
    if (!match) return respondText(response, 404, 'Not here.')
    const app = match[1] as OfficeApp
    const relative = match[2] ?? '/'
    const appDir = join(this.options.appsDir, app)

    if (relative === '/' || relative === '/index.html') {
      let html: string
      try {
        html = prepareEditorDocument(await readFile(join(appDir, 'index.html'), 'utf8'))
      } catch {
        return respondText(response, 404, `The ${app} editor is not installed in this build.`)
      }
      // One rewrite carries both modes: the document to open, and where the result goes.
      const query = [
        url.searchParams.get('__craftExport') ? `export=${encodeURIComponent(url.searchParams.get('__craftExport')!)}` : '',
        url.searchParams.get('__craftHeadless') && url.searchParams.get('__craftOut')
          ? `headless=${encodeURIComponent(url.searchParams.get('__craftOut')!)}&format=${encodeURIComponent(
              url.searchParams.get('__craftHeadless')!,
            )}`
          : '',
      ]
        .filter(Boolean)
        .join('&')
      const withShim = query ? html.replace(`${OFFICE_SHIM_PATH}"`, `${OFFICE_SHIM_PATH}?${query}"`) : html
      return respond(response, 200, 'text/html; charset=utf-8', withShim, { 'cache-control': 'no-store' })
    }

    const target = resolveServedPath(appDir, relative.replace(/^\//, ''))
    if (!target) return respondText(response, 403, 'Not reachable.')
    let bytes: Buffer
    try {
      bytes = await readFile(target)
    } catch {
      return respondText(response, 404, 'Nothing here.')
    }
    respond(response, 200, contentTypeFor(target), bytes, { 'cache-control': 'public, max-age=300' })
  }

  /** Where a caller should write when it names no path. */
  scratchPath(name: string): string {
    return join(this.#scratch ?? tmpdir(), name)
  }
}

/** JSON has no bytes; the shim knows `{$bytes}` and puts them back (`decodeBytes`). */
function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  return value
}

function parseReport(body: string): { ok?: boolean; error?: string } {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown; error?: unknown }
    return {
      ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {}),
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
    }
  } catch {
    return {}
  }
}

/** A request body as text: every body on this origin is a JSON message, except one write. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function respond(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

function respondText(response: ServerResponse, status: number, message: string): void {
  respond(response, status, 'text/plain; charset=utf-8', message)
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  respond(response, status, 'application/json; charset=utf-8', JSON.stringify(value ?? null), {
    'cache-control': 'no-store',
  })
}
