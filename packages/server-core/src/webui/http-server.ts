/**
 * Web UI HTTP handler and standalone server.
 *
 * The core logic lives in `createWebuiHandler()` which returns a web-standard
 * fetch handler `(Request) => Promise<Response>`. This handler can be:
 *
 * 1. **Embedded** — attached to the WsRpcServer's HTTPS server via the
 *    node-adapter so that HTTP and WSS share a single port.
 * 2. **Standalone** — wrapped in `Bun.serve()` via `startWebuiHttpServer()`
 *    for separate-port deployments or development.
 */

import { join, extname } from 'node:path'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import {
  RateLimiter,
  createSessionToken,
  deriveWebuiSessionKey,
  validateSession,
  buildSessionCookie,
  buildLogoutCookie,
} from './auth'
import { createDefaultWebuiRuntime, type WebuiRuntime } from './runtime'
import { DRAWIO_ROUTE_BASE, serveDrawioRoute } from './drawio'
import { findExport } from '../services/export-store'
import { generateCallbackPage } from '@craft-agent/shared/auth'
import type { PlatformServices } from '../runtime/platform'

// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.map': 'application/json',
}

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** `attachment`, with an ASCII fallback plus the real (possibly non-ASCII) name. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Assets the browser fetches without a session cookie. The web app manifest and
 * its icons are requested with `credentials: omit`, so gating them behind the
 * session cookie would 302 the browser to the login page and break PWA
 * installability.
 */
const UNAUTHENTICATED_ASSET_PATHS = new Set([
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
])

function getForwardedValue(req: Request, key: 'proto' | 'host'): string | null {
  const forwarded = req.headers.get('forwarded')
  if (!forwarded) return null

  const match = forwarded.match(new RegExp(`${key}="?([^;,"]+)"?`, 'i'))
  return match?.[1]?.trim() || null
}

function getRequestProto(req: Request): string {
  return req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'proto')
    || new URL(req.url).protocol.replace(/:$/, '')
}

function getRequestHost(req: Request): string | null {
  return req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'host')
    || req.headers.get('host')
}

function formatHostWithPort(host: string, port: number): string {
  try {
    const parsed = new URL(`http://${host}`)
    const hostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname
    return `${hostname}:${port}`
  } catch {
    const withoutPort = host.replace(/:\d+$/, '')
    return `${withoutPort}:${port}`
  }
}

export function shouldUseSecureCookies(req: Request, secureCookies?: boolean): boolean {
  if (secureCookies != null) return secureCookies
  return getRequestProto(req) === 'https'
}

export interface ResolveWebSocketUrlOptions {
  publicWsUrl?: string
  wsProtocol: 'ws' | 'wss'
  wsPort: number
}

/** The hostname a request claims to have arrived at, without its port. */
function requestHostname(req: Request): string | null {
  const host = getRequestHost(req)
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname.toLowerCase() || null
  } catch {
    const withoutPort = host.replace(/:\d+$/, '').toLowerCase()
    return withoutPort || null
  }
}

/**
 * Whether this request came in through the server's external endpoint.
 *
 * The configured external address belongs to the requests that arrive on it — a browser that
 * enters by the tunnel host, or that reaches the hub through a reverse proxy (which is what puts
 * `X-Forwarded-*` on the request). A browser on the LAN calls this hub directly: its host is the
 * LAN address and nothing sits in front of it, so the external address is not its own and must
 * not be handed to it — a tunnel or public host it cannot reach would break a connection that
 * works today.
 */
export function requestUsesExternalAddress(req: Request, publicWsUrl: string): boolean {
  const hostname = requestHostname(req)
  try {
    const publicHostname = new URL(publicWsUrl).hostname.toLowerCase()
    if (hostname && publicHostname && hostname === publicHostname) return true
  } catch {
    // A malformed value (validated at save time) simply never matches here.
  }

  return Boolean(
    req.headers.get('x-forwarded-host')
    || req.headers.get('x-forwarded-proto')
    || req.headers.get('forwarded'),
  )
}

/**
 * The socket form of a configured external address.
 *
 * The field takes whichever form the address came in — `https://host` is the same endpoint as
 * `wss://host` — while what a browser is handed has to be a socket URL. Only the scheme changes:
 * a path prefix a proxy forwards is part of the address and is kept.
 */
function toWebSocketUrl(address: string): string {
  return address.replace(/^http/i, 'ws')
}

export function resolveWebSocketUrl(
  req: Request,
  { publicWsUrl, wsProtocol, wsPort }: ResolveWebSocketUrlOptions,
): string {
  // Per request, not globally: the internal address stays the address a LAN browser is given.
  if (publicWsUrl && requestUsesExternalAddress(req, publicWsUrl)) return toWebSocketUrl(publicWsUrl)

  const host = getRequestHost(req)
  if (host) {
    return `${wsProtocol}://${formatHostWithPort(host, wsPort)}`
  }

  return `${wsProtocol}://127.0.0.1:${wsPort}`
}

// ---------------------------------------------------------------------------
// Handler options (shared between embedded and standalone modes)
// ---------------------------------------------------------------------------

/** Dependencies for the /api/oauth/callback HTTP route (server-side OAuth completion). */
export interface OAuthCallbackDeps {
  flowStore: { getByState: (state: string) => any; remove: (state: string) => void }
  credManager: { exchangeAndStore: (...args: any[]) => Promise<any> }
  sessionManager: { completeAuthRequest: (...args: any[]) => Promise<void> }
  pushSourcesChanged: (workspaceId: string) => void
}

export interface WebuiHandlerOptions {
  /**
   * Path to the built web UI `dist/` directory.
   *
   * Optional, and deliberately independent of the handler existing: a hub serves its protocol
   * routes (`/api/*`) whether or not the page bundle was built. Without it the request handler
   * answers those and 404s everything else, with no login redirect to nowhere.
   */
  webuiDir?: string
  /**
   * The vendored drawio directory, when this hub has one.
   *
   * Served at `/drawio/` on the app's own origin: the web UI has no Electron process to hand
   * out a `craft-local://` address, and same-origin is what lets the editor sit behind the
   * session cookie. No directory → the editor is reported as not installed.
   */
  drawioDir?: string
  /**
   * The hub's own token. It logs a browser in directly, and it is the HMAC key the session
   * signing key is derived from (together with `password`) — so changing either credential ends
   * every browser session.
   */
  serverToken: string
  /** Web UI login password (generated when Server Mode first starts). */
  password: string
  /**
   * Accepts a bearer header for endpoints a native client fetches over HTTP (export downloads).
   * The hub passes its token registry here; a browser's cookie never reaches this path.
   */
  authorizeBearer?: (header: string | null) => boolean | Promise<boolean>
  /** Explicit Secure-cookie override. When unset, infer from the request / proxy headers. */
  secureCookies?: boolean
  /**
   * Optional browser-facing WebSocket URL for the server's external address.
   *
   * Applied only to requests that arrive through it (see `requestUsesExternalAddress`); a browser
   * on the network keeps the address it used.
   */
  publicWsUrl?: string
  /** RPC WebSocket protocol used when building a browser-facing fallback URL. */
  wsProtocol: 'ws' | 'wss'
  /** RPC WebSocket port used when building a browser-facing fallback URL. */
  wsPort: number
  /** Health check function (injected from existing server handler). */
  getHealthCheck: () => { status: string }
  /** Logger. */
  logger: PlatformServices['logger']
  /** OAuth callback deps — when provided, enables /api/oauth/callback route. */
  oauthCallbackDeps?: OAuthCallbackDeps
  /**
   * Trusted proxy IPs/CIDRs. When set, proxy headers (x-forwarded-for, x-forwarded-proto)
   * are only trusted from these sources. When empty/unset, proxy headers are ignored
   * and 'direct' is used as the rate-limit key.
   */
  trustedProxies?: string[]
  /**
   * Runtime adapter for asset streaming and password hashing. When omitted it is
   * chosen from the current runtime (Bun or Node) — see `createDefaultWebuiRuntime`.
   */
  runtime?: WebuiRuntime
}

// ---------------------------------------------------------------------------
// Handler factory — the core request handler
// ---------------------------------------------------------------------------

export interface WebuiHandler {
  /** Web-standard fetch handler. */
  fetch: (req: Request) => Promise<Response>
  /** Call on shutdown to release timers. */
  dispose: () => void
  /** Inject OAuth callback deps after bootstrap (lazy wiring). */
  setOAuthCallbackDeps: (deps: OAuthCallbackDeps) => void
}

/**
 * Create a web-standard fetch handler for the WebUI.
 *
 * This handler can be used directly with `Bun.serve({ fetch })`,
 * or adapted for Node's HTTP server via `nodeHttpAdapter()`.
 */
export function createWebuiHandler(options: WebuiHandlerOptions): WebuiHandler {
  const {
    webuiDir,
    drawioDir,
    password,
    serverToken,
    authorizeBearer,
    secureCookies,
    publicWsUrl,
    wsProtocol,
    wsPort,
    getHealthCheck,
    logger,
    trustedProxies,
  } = options

  // One key for every session this handler issues or checks; see `deriveWebuiSessionKey`.
  const sessionKey = deriveWebuiSessionKey(serverToken, password)

  const runtime = options.runtime ?? createDefaultWebuiRuntime()

  // Said once, at startup: without the bundle every `/drawio/` request is a 404 that the
  // app's loading overlay hides, which reads as "the editor is still loading" forever.
  if (drawioDir) {
    logger.info(`[webui] drawio editor: ${drawioDir}`)
  } else {
    logger.warn('[webui] drawio editor not installed (resources/drawio missing)')
  }

  const rateLimiter = new RateLimiter(5, 60_000)
  const cleanupTimer = setInterval(() => rateLimiter.cleanup(), 120_000)

  const trustedProxySet = new Set(trustedProxies ?? [])

  // Hash both accepted passwords at startup (async, but resolves before the first auth attempt).
  const passwordReady = runtime.hashPassword(password)
  const tokenPasswordReady = runtime.hashPassword(serverToken)

  /** Extract client IP — only trusts proxy headers when trustedProxies is configured. */
  function getClientIp(req: Request): string {
    if (trustedProxySet.size > 0) {
      return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('x-real-ip')
        ?? 'direct'
    }
    return 'direct'
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const useSecureCookies = shouldUseSecureCookies(req, secureCookies)

    // ── Health endpoint (no auth) ──
    if (path === '/health') {
      const health = getHealthCheck()
      return Response.json(health, {
        status: health.status === 'ok' ? 200 : 503,
      })
    }

    // ── Login page (no auth) ──
    if (path === '/login' || path === '/login/') {
      if (!webuiDir) return new Response('Web UI is not built', { status: 404 })
      const loginFile = await runtime.openAsset(join(webuiDir, 'login.html'))
      if (loginFile) {
        return new Response(loginFile, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
      return new Response('Login page not found', { status: 404 })
    }

    // ── Static assets that login page + PWA install need (no auth) ──
    if (webuiDir && (path === '/favicon.ico' || UNAUTHENTICATED_ASSET_PATHS.has(path) || path.startsWith('/login-assets/'))) {
      const file = await runtime.openAsset(join(webuiDir, path))
      if (file) {
        return new Response(file, {
          headers: { 'Content-Type': getMimeType(path) },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    // ── Auth endpoint ──
    if (path === '/api/auth' && req.method === 'POST') {
      const passwordHash = await passwordReady
      const tokenHash = await tokenPasswordReady
      const ip = getClientIp(req)

      if (!rateLimiter.check(ip)) {
        logger.warn(`[webui] Rate limited auth attempt from ${ip}`)
        return Response.json(
          { error: 'Too many attempts. Try again later.' },
          { status: 429 },
        )
      }

      let body: { password?: string }
      try {
        body = await req.json() as { password?: string }
      } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
      }

      if (!body.password || typeof body.password !== 'string') {
        return Response.json({ error: 'Password is required' }, { status: 400 })
      }

      // Either credential is a full client of this hub, so either is a valid login.
      const matchesPassword = await runtime.verifyPassword(body.password, passwordHash)
      const matchesToken = matchesPassword
        || await runtime.verifyPassword(body.password, tokenHash)
      if (!matchesToken) {
        logger.warn(`[webui] Failed auth attempt from ${ip}`)
        return Response.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      const jwt = await createSessionToken(sessionKey)
      logger.info(`[webui] Successful auth from ${ip}`)

      return Response.json({ ok: true }, {
        status: 200,
        headers: {
          'Set-Cookie': buildSessionCookie(jwt, useSecureCookies),
        },
      })
    }

    // ── Logout endpoint ──
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return new Response(null, {
        status: 204,
        headers: {
          'Set-Cookie': buildLogoutCookie(useSecureCookies),
        },
      })
    }

    // ── OAuth callback (no cookie auth — state param is CSRF protection) ──
    // Receives redirect from the relay (or directly from OAuth provider for MCP sources).
    // Completes the token exchange server-side and renders a success/error page.
    if (path === '/api/oauth/callback' && req.method === 'GET' && options.oauthCallbackDeps) {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        const flow = state ? options.oauthCallbackDeps.flowStore.getByState(state) : null
        if (flow && state) options.oauthCallbackDeps.flowStore.remove(state)
        const errorMsg = errorDescription || error
        logger.warn(`[webui] OAuth callback error: ${errorMsg}`)
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: errorMsg }), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      if (!code || !state) {
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: 'Missing code or state parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      try {
        const { completeOAuthFlow } = await import('../handlers/rpc/oauth')
        const result = await completeOAuthFlow({
          code,
          state,
          flowStore: options.oauthCallbackDeps.flowStore,
          credManager: options.oauthCallbackDeps.credManager as any,
          sessionManager: options.oauthCallbackDeps.sessionManager,
          pushSourcesChanged: options.oauthCallbackDeps.pushSourcesChanged,
          logger,
          // No clientId/workspaceId — HTTP callback skips ownership checks (state is auth)
        })

        if (result.success) {
          return new Response(generateCallbackPage({ title: 'Authorization Successful', isSuccess: true }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        } else {
          return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: result.error }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Token exchange failed'
        logger.error(`[webui] OAuth callback failed: ${msg}`)
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: msg }), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
    }

    // ── Config endpoint (requires session cookie) ──
    if (path === '/api/config' && req.method === 'GET') {
      const configSession = await validateSession(req.headers.get('cookie'), sessionKey)
      if (!configSession) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return Response.json({
        wsUrl: resolveWebSocketUrl(req, { publicWsUrl, wsProtocol, wsPort }),
      })
    }

    // Workspace IDs for the webui handshake. The first workspace is the default (stable, unlike
    // `activeWorkspaceId` which only tracks the most recently created one); the full list lets a
    // tab validate a workspace it remembered before using it.
    if (path === '/api/config/workspaces' && req.method === 'GET') {
      const configSession = await validateSession(req.headers.get('cookie'), sessionKey)
      if (!configSession) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const { loadStoredConfig } = await import('@craft-agent/shared/config/storage')
      const workspaceIds = (loadStoredConfig()?.workspaces ?? []).map((w) => w.id)
      return Response.json({
        defaultWorkspaceId: workspaceIds[0] ?? null,
        workspaceIds,
      })
    }

    // ── Export downloads ──
    // A file this hub produced for a caller that is not on this machine. The browser brings its
    // session cookie; a native client brings a hub credential as a bearer header. Either way the
    // bytes travel here, not over the RPC socket.
    if (path.startsWith('/api/exports/') && req.method === 'GET') {
      const authorized = !!await validateSession(req.headers.get('cookie'), sessionKey)
        || !!await authorizeBearer?.(req.headers.get('authorization'))
      if (!authorized) return Response.json({ error: 'Unauthorized' }, { status: 401 })

      const file = findExport(decodeURIComponent(path.slice('/api/exports/'.length)))
      if (!file) return new Response('Not Found', { status: 404 })

      return new Response(Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream, {
        headers: {
          'Content-Type': file.mime,
          'Content-Length': String(file.size),
          'Content-Disposition': contentDisposition(file.name),
          'Cache-Control': 'no-store',
        },
      })
    }

    // ── Everything below requires a valid session cookie ──
    const cookieHeader = req.headers.get('cookie')
    const session = await validateSession(cookieHeader, sessionKey)

    if (!session) {
      const accept = req.headers.get('accept') ?? ''
      // Only a hub that actually has a page has somewhere to send the person.
      if (webuiDir && (accept.includes('text/html') || path === '/' || path === '')) {
        // A relative `Location` is valid HTTP, but `Response.redirect()` demands an
        // absolute URL and throws `ERR_INVALID_URL` under Node's undici (Bun is
        // lenient) — so build the redirect response directly.
        return new Response(null, { status: 302, headers: { Location: '/login' } })
      }
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── The bundled drawio editor, on this app's own origin ──
    // After the session check on purpose: the assets are not a secret, but there is no reason
    // for an anonymous visitor to use the hub as a static host either.
    if (path === DRAWIO_ROUTE_BASE || path.startsWith(`${DRAWIO_ROUTE_BASE}/`)) {
      if (!drawioDir) {
        return new Response('The bundled drawio editor is not installed on this hub.', { status: 404 })
      }
      const drawioResponse = await serveDrawioRoute(req, path, { dir: drawioDir, runtime })
      if (drawioResponse) return drawioResponse
    }

    // ── Serve SPA static files ──
    if (webuiDir) {
      if (path !== '/') {
        const file = await runtime.openAsset(join(webuiDir, path))
        if (file) {
          return new Response(file, {
            headers: { 'Content-Type': getMimeType(path) },
          })
        }
      }

      // SPA fallback — serve index.html for all non-file routes
      const indexFile = await runtime.openAsset(join(webuiDir, 'index.html'))
      if (indexFile) {
        return new Response(indexFile, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
    }

    return new Response(webuiDir ? 'Not Found' : 'Web UI is not built', { status: 404 })
  }

  return {
    fetch,
    dispose: () => clearInterval(cleanupTimer),
    setOAuthCallbackDeps: (deps: OAuthCallbackDeps) => {
      options.oauthCallbackDeps = deps
    },
  }
}

// ---------------------------------------------------------------------------
// Standalone server (backwards-compatible, uses Bun.serve)
// ---------------------------------------------------------------------------

export interface WebuiHttpServerOptions extends WebuiHandlerOptions {
  /** Port to bind on. Use 0 for an ephemeral port in tests. */
  port: number
}

export async function startWebuiHttpServer(
  options: WebuiHttpServerOptions,
): Promise<{ port: number, stop: () => void }> {
  const { port, logger, ...handlerOpts } = options
  const handler = createWebuiHandler({ ...handlerOpts, logger })

  const server = Bun.serve({
    port,
    fetch: handler.fetch,
  })

  const boundPort = server.port ?? port
  logger.info(`[webui] Web UI server listening on http://0.0.0.0:${boundPort}`)

  return {
    port: boundPort,
    stop: () => {
      handler.dispose()
      server.stop()
    },
  }
}
