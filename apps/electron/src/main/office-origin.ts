/**
 * The vendored GenOffice editors, answered by Electron at their own origin.
 *
 * Same arrangement as `drawio-host.ts`, for the same reasons: an editor is a web application
 * (HTML + its assets), so it needs what any served app needs before it will run — a real
 * origin, root-absolute references that resolve, and `localStorage`/`fetch` that work. What
 * it does *not* get is a preload: `shim.ts` stands in for one, injected into the document on
 * the way out, so the bundle runs exactly as published and the host owns every capability it
 * asks for.
 *
 * Three consequences follow from "the app's own bundle", and they are why this is a host of
 * its own:
 *
 * - **One install, many documents.** The directory is a vendored dependency, not a person's
 *   work: nothing here is authored, so there is no write path and no watcher.
 * - **The editor is disposable.** A missing directory is a real answer (the build script has
 *   not run), not a failure to handle — the caller says so instead of showing an empty frame.
 * - **Bytes never come from here.** Documents are handed to the frame over the bridge (see
 *   `shared/office/types.ts`); this origin serves code, and only code.
 *
 * Layout of the vendored directory — one folder per editor, each the `out/renderer` of the
 * matching GenOffice app:
 *
 *   resources/office/docs/{index.html, assets/…}
 *   resources/office/sheets/{…}
 *   resources/office/slides/{…}
 *   resources/office/pdf/{…}
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  contentTypeFor,
  labelFromHost,
  localHostLabel,
  localHostOrigin,
  resolveServedPath,
} from '@craft-agent/shared/local-origin'
import { OFFICE_APPS, OFFICE_SHIM_PATH, type OfficeApp } from '@craft-agent/shared/office/types'
import { officeShimScript } from '@craft-agent/shared/office/shim'
import { prepareEditorDocument } from '@craft-agent/shared/office/document'
import { getBundledAssetsDir } from '@craft-agent/shared/utils/paths'
import { fileResponse, isFile, textResponse } from './local-http'
import { mainLog } from './logger'

/** The directory this run has handed an address out for. Null until `officeOriginUrl` runs. */
let served: { label: string; dir: string } | null = null

/**
 * Documents an export is printing, by one-shot token.
 *
 * Export runs with the editor as the top document, so there is no host page to hand the bytes
 * over — the shim asks this origin instead. A token keeps that door one document wide and shut
 * again as soon as the window closes: nothing here is listed, guessed or reused.
 */
const exportFiles = new Map<string, { bytes: Uint8Array; path: string; name: string }>()

export function registerExportFile(path: string, bytes: Uint8Array): string {
  const token = randomUUID()
  exportFiles.set(token, { bytes, path, name: path.split(/[\\/]/).pop() || path })
  return token
}

export function releaseExportFile(token: string): void {
  exportFiles.delete(token)
}

/**
 * Where an export window's questions go: the same hosts a frame reaches over the frame's channel.
 *
 * Registered per token, so one window can only ask about the document it was opened on, and
 * released when that window closes. A window with no entry answers nothing — which is the honest
 * answer for an address nobody handed out.
 */
type ExportHostAnswer = (method: string, args: unknown[]) => Promise<unknown>
const exportHosts = new Map<string, ExportHostAnswer>()

export function registerExportHost(token: string, answer: ExportHostAnswer): void {
  exportHosts.set(token, answer)
}

export function releaseExportHost(token: string): void {
  exportHosts.delete(token)
}

/**
 * A renderer export in flight: where its bytes go, and the promise that settles when it says so.
 *
 * The docs bundle's own export mode asks the host for a target, hands back the produced file, and
 * then reports that it finished. Without a host page there is nobody to answer those three calls,
 * so they travel as URLs on this origin — one document wide, released when the window closes.
 */
interface HeadlessTarget {
  path: string
  done: (report: unknown) => void
}
const headlessTargets = new Map<string, HeadlessTarget>()

export function registerHeadlessTarget(path: string): { token: string; done: Promise<unknown> } {
  const token = randomUUID()
  let settle: (report: unknown) => void = () => undefined
  const done = new Promise<unknown>((resolve) => {
    settle = resolve
  })
  headlessTargets.set(token, { path, done: settle })
  return { token, done }
}

export function releaseHeadlessTarget(token: string): void {
  headlessTargets.delete(token)
}

/**
 * Hand out an address for an office directory, and answer it from then on.
 *
 * Split from `officeOriginUrl` for the reason the drawio host states: the registration and
 * the serving are the parts with rules in them, and they can be driven from any directory —
 * which is what makes them testable without shipping the editors.
 */
export function registerOfficeOrigin(dir: string): string {
  const label = localHostLabel('office', dir)
  served = { label, dir }
  return localHostOrigin(label)
}

/**
 * The origin the editors are reachable at, or null when they are not installed.
 *
 * Null is a real answer: the bundles are produced by a build script rather than committed
 * (see `scripts/build-office-assets.md`), so a checkout that has never run it has no editors.
 */
export function officeOriginUrl(): string | null {
  const dir = getBundledAssetsDir('office')
  return dir && existsSync(dir) ? registerOfficeOrigin(dir) : null
}

/** The directory a label names, if this run has handed its address out. */
function resolveServedOffice(url: string): string | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  const label = labelFromHost(host)
  return served && label === served.label ? served.dir : null
}

/**
 * The vendored files are the one thing on these origins worth caching.
 *
 * The opposite of workspace content: this is a built release that changes only when the build
 * script re-runs, and without a cache every open re-reads and re-compiles several megabytes of
 * editor script. Ten minutes, not a year, because the label is derived from the *path* and so
 * survives a rebuild — a long cache would pin the previous build for as long as it lasted.
 *
 * The document itself is deliberately not covered: it carries the shim, which is app code.
 */
const BUNDLE_CACHE = 'public, max-age=600'

/**
 * The editor document's policy: its own origin only, and no network beyond it.
 *
 * `connect-src 'self'` is what lets the editor `fetch` the blob URL the shim makes for a
 * document, so it is not decoration; `form-action 'none'` stops a form from leaving.
 *
 * **`frame-ancestors` names the shells that actually embed the editor, and `'self'` is not one of
 * them here.** `'self'` is the document's own origin — the `craft-local://office-…` label — while
 * the page embedding it is the app shell: `file://` in a packaged build and the Vite dev server in
 * development. A clause of `'self'` alone therefore blocks every embed: the frame comes up blank
 * and `did-fail-load` reports -27 `ERR_BLOCKED_BY_RESPONSE` (reproduced: a parent on one origin
 * framing a child whose policy says `frame-ancestors 'self'` logs *"Framing … violates … the
 * request has been blocked"*). The hub's copy of this policy (`packages/server-core/src/webui/
 * office.ts`) can say `'self'` because it serves the shell and the editors from one origin; this
 * host cannot.
 *
 * `file:` is what admits the packaged shell (verified: a `file://` parent framing a child that
 * allows `file:` renders, the same child with `'self'` does not), and the dev server's origin is
 * added only when there is one — a development build must not silently open the editor to a
 * second origin.
 */
function editorCsp(): string {
  const devServer = process.env.VITE_DEV_SERVER_URL
  let devOrigin: string | null = null
  if (devServer) {
    try {
      devOrigin = new URL(devServer).origin
    } catch {
      devOrigin = null
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    `frame-ancestors 'self' file:${devOrigin ? ` ${devOrigin}` : ''}`,
    "form-action 'none'",
    "base-uri 'self'",
  ].join('; ')
}

/** `<label>/<app>` → the app, when the app is one this host serves. */
function appFromPath(rest: string): { app: OfficeApp; tail: string } | null {
  const match = /^\/([a-z]+)(\/.*)?$/.exec(rest)
  if (!match) return null
  const app = match[1] as OfficeApp
  if (!OFFICE_APPS.includes(app)) return null
  return { app, tail: match[2] ?? '/' }
}

/** Where a printing window's bytes are answered from (see `registerExportFile`). */
export const OFFICE_ROUTE_FILE_PATH = '/__craft/office-file'

/**
 * Where an export window's host calls arrive.
 *
 * A POST, so it sits above the GET/HEAD guard like the headless export's own two routes. The body
 * is `{ method, args }` and the answer is `{ ok, value }` or `{ ok: false, error }`; bytes travel
 * as `{ $bytes: base64 }` because JSON has no other way to carry them.
 */
export const OFFICE_ROUTE_CALL_PATH = '/__craft/office-call'

/** Where a headless export writes its bytes, and where it reports that it finished. */
export const OFFICE_ROUTE_WRITE_PATH = '/__craft/office-write'
export const OFFICE_ROUTE_DONE_PATH = '/__craft/office-done'

/**
 * Answer a request for the office origin, or null when the label is not ours.
 *
 * Null is the answer for a label this run never handed out — an address nobody served.
 */
export async function serveOfficeRequest(request: Request): Promise<Response | null> {
  const dir = resolveServedOffice(request.url)
  if (!dir) return null

  try {
    const { pathname } = new URL(request.url)

    // An export window asking what a frame would have asked its host page.
    if (pathname.startsWith(`${OFFICE_ROUTE_CALL_PATH}/`) && request.method === 'POST') {
      const token = decodeURIComponent(pathname.slice(OFFICE_ROUTE_CALL_PATH.length + 1))
      const answer = exportHosts.get(token)
      if (!answer) return textResponse(404, 'No export is in progress here.')
      let body: { method?: unknown; args?: unknown }
      try {
        body = (await request.json()) as { method?: unknown; args?: unknown }
      } catch {
        return textResponse(400, 'The call was not JSON.')
      }
      const method = typeof body.method === 'string' ? body.method : ''
      if (!method) return textResponse(400, 'A method is required.')
      const args = Array.isArray(body.args) ? body.args : []
      try {
        const value = await answer(method, args)
        return jsonResponse({ ok: true, value: toJsonValue(value) })
      } catch (error) {
        return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // A headless export's own two calls: the produced bytes, and "I am done". They are POSTs, so
    // they sit above the GET/HEAD guard below.
    if (pathname.startsWith(`${OFFICE_ROUTE_WRITE_PATH}/`) && request.method === 'POST') {
      const token = decodeURIComponent(pathname.slice(OFFICE_ROUTE_WRITE_PATH.length + 1))
      const target = headlessTargets.get(token)
      if (!target) return textResponse(404, 'No such export is in flight.')
      await writeFile(target.path, await request.text(), 'utf8')
      return new Response('ok', { headers: { 'content-type': 'text/plain' } })
    }
    if (pathname.startsWith(`${OFFICE_ROUTE_DONE_PATH}/`) && request.method === 'POST') {
      const token = decodeURIComponent(pathname.slice(OFFICE_ROUTE_DONE_PATH.length + 1))
      const target = headlessTargets.get(token)
      if (!target) return textResponse(404, 'No such export is in flight.')
      const body = await request.text()
      target.done(body ? JSON.parse(body) : {})
      return new Response('ok', { headers: { 'content-type': 'text/plain' } })
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, '', { allow: 'GET, HEAD' })
    }

    // Our own script, synthesized rather than read: it is app code, and the directory it sits
    // beside is a disposable build. `?export=` switches it to export mode, where the document is
    // named here instead of arriving from a host page.
    if (pathname === OFFICE_SHIM_PATH) {
      const shimUrl = new URL(request.url)
      const exportToken = shimUrl.searchParams.get('export')
      const readOnly = shimUrl.searchParams.get('readonly') === '1'
      // Headless export: the shim is told what to produce and where to hand it back.
      const headlessToken = shimUrl.searchParams.get('headless')
      const headlessFormat = shimUrl.searchParams.get('format')
      const headlessTarget = headlessToken ? headlessTargets.get(headlessToken) : undefined
      const file = exportToken ? exportFiles.get(exportToken) : undefined
      // Both no-host windows answer their editor's questions here (see `OFFICE_ROUTE_CALL_PATH`):
      // the token is the window's own, so it can only be asked about its own document.
      const callToken =
        headlessToken && headlessTarget
          ? headlessToken
          : exportToken && file
            ? exportToken
            : undefined
      /**
       * What the shim is told: the document, the job, or both.
       *
       * Both is the ordinary case for an export (`__craftExport` + `__craftHeadless`): the editor
       * has to **open** the file and then know where its PDF goes. Answering only the job left the
       * editor on a blank page, waiting fifteen seconds for a document nobody had named.
       */
      const source = officeShimScript({
        callToken,
        ...(file && exportToken
          ? {
              exportFile: {
                url: `${OFFICE_ROUTE_FILE_PATH}/${encodeURIComponent(exportToken)}`,
                path: file.path,
                name: file.name,
              },
            }
          : {}),
        ...(headlessTarget && headlessToken
          ? {
              headless: {
                format: headlessFormat === 'md' || headlessFormat === 'pdf' ? headlessFormat : 'html',
                outPath: headlessTarget.path,
                writeUrl: `${OFFICE_ROUTE_WRITE_PATH}/${encodeURIComponent(headlessToken)}`,
                doneUrl: `${OFFICE_ROUTE_DONE_PATH}/${encodeURIComponent(headlessToken)}`,
              },
            }
          : {}),
        ...(readOnly ? { readOnly } : {}),
      })
      return new Response(request.method === 'HEAD' ? null : source, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      })
    }

    // The bytes an export is printing. Answered only for a live token.
    if (pathname.startsWith(`${OFFICE_ROUTE_FILE_PATH}/`)) {
      const token = decodeURIComponent(pathname.slice(OFFICE_ROUTE_FILE_PATH.length + 1))
      const file = exportFiles.get(token)
      if (!file) return textResponse(404, 'No such export is in progress.')
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(file.bytes), {
        headers: {
          'content-type': contentTypeFor(file.name),
          'content-length': String(file.bytes.byteLength),
          'cache-control': 'no-store',
        },
      })
    }

    if (pathname === '/' || pathname === '') {
      return textResponse(404, `The office editors are served under ${OFFICE_APPS.map((app) => `/${app}/`).join(' ')}.`)
    }

    // `/docs` (no slash) would resolve the editor's relative assets against the origin root,
    // so send the one address that has a base.
    const bare = /^\/([a-z]+)$/.exec(pathname)
    if (bare && OFFICE_APPS.includes(bare[1] as OfficeApp)) {
      return new Response(null, { status: 302, headers: { location: `${pathname}/` } })
    }

    const resolved = appFromPath(pathname)
    if (!resolved) {
      // One line per refused path, because "the editor will not load" is otherwise a silent
      // failure: without it nothing in the log says whether a frame was ever asked for.
      mainLog.warn(`[office] ${decodeURIComponent(pathname)} is not an office app path`)
      return textResponse(404, `Nothing of the office editors is reachable at ${pathname}.`)
    }

    const { app, tail } = resolved
    const appDir = join(dir, app)
    const relative = tail.replace(/^\/+/, '')

    if (!relative) {
      const indexPath = join(appDir, 'index.html')
      if (!(await isFile(indexPath))) {
        return textResponse(404, `The ${app} editor is not installed in this build.`)
      }
      // Export mode names its document in the shim's own address, because there is no host page
      // to answer `consumePendingOpenDocx`. The window is opened with `?__craftExport=<token>`.
      const exportToken = new URL(request.url).searchParams.get('__craftExport')
      // A read-only preview asks for the shim without write access; the document itself is
      // served exactly the same way, because what a person sees must be the real document.
      const wantsReadOnly = new URL(request.url).searchParams.get('__craftReadOnly') === '1'
      // A headless export carries its own two parameters: the token it writes through, and the
      // format the editor should produce.
      const headless = new URL(request.url).searchParams.get('__craftHeadless')
      const headlessId = new URL(request.url).searchParams.get('__craftOut')
      const shimQuery = [
        exportToken ? `export=${encodeURIComponent(exportToken)}` : '',
        wantsReadOnly ? 'readonly=1' : '',
        headless && headlessId ? `headless=${encodeURIComponent(headlessId)}&format=${encodeURIComponent(headless)}` : '',
      ]
        .filter(Boolean)
        .join('&')
      // The document itself is asked for once per frame, so this is the one line that answers
      // "did the editor ever load?" — the rest of what a frame fetches is its bundle.
      mainLog.info(
        `[office] ${app} editor served${shimQuery ? ` (${shimQuery})` : ''}`,
      )
      const html = prepareEditorDocument(await readFile(indexPath, 'utf8'))
      // One rewrite covers both modes: export names its document, read-only drops write access,
      // and a document opened plainly gets neither.
      const withShimQuery = shimQuery
        ? html.replace(`${OFFICE_SHIM_PATH}"`, `${OFFICE_SHIM_PATH}?${shimQuery}"`)
        : html
      return new Response(request.method === 'HEAD' ? null : withShimQuery, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': editorCsp(),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      })
    }

    const target = resolveServedPath(appDir, relative)
    if (!target) return textResponse(403, `Nothing of ${app} is reachable at ${pathname}.`)
    if (!(await isFile(target))) return textResponse(404, `Nothing of ${app} is at ${pathname}.`)

    return fileResponse(request, {
      body: await readFile(target),
      contentType: contentTypeFor(target),
      headers: { 'cache-control': BUNDLE_CACHE },
    })
  } catch (error) {
    return textResponse(500, `The office host failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** An answer to a host call, over the same origin the editor is served from. */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * A document's bytes cannot ride in JSON.
 *
 * The one field the shim knows: `{ $bytes: base64 }`, decoded on the other side by `decodeBytes`.
 * Written here rather than left to `JSON.stringify`, which would turn a `Uint8Array` into an
 * object keyed by index — the shape that reads as "present" and is useless.
 */
function toJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (value instanceof ArrayBuffer) return { $bytes: Buffer.from(new Uint8Array(value)).toString('base64') }
  return value
}

