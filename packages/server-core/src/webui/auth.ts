/**
 * Web UI session authentication.
 *
 * Cookie-based JWT session auth for the browser-served web UI.
 * - Login: verify password → issue signed JWT → set HttpOnly cookie
 * - Validation: check cookie on every HTTP request + WebSocket upgrade
 * - Rate limiting: per-IP brute-force protection on /api/auth
 */

import { SignJWT, jwtVerify } from 'jose'
import { createHmac } from 'node:crypto'

// ---------------------------------------------------------------------------
// JWT helpers (via jose library)
// ---------------------------------------------------------------------------

const JWT_EXPIRY_SECONDS = 86_400 // 24 hours

/**
 * The key that signs session cookies: HMAC(server token, "webui-session\0" + Web UI password).
 *
 * Both credentials take part, so changing either one ends every browser session — from a
 * browser's point of view, rotating the token and resetting the password are the same act. The
 * server token is the HMAC key, so a weak password cannot weaken cookie integrity.
 */
export function deriveWebuiSessionKey(serverToken: string, webuiPassword: string): string {
  return createHmac('sha256', serverToken)
    .update(`webui-session\0${webuiPassword}`, 'utf8')
    .digest('hex')
}

export interface JwtPayload {
  sub: string
  iat: number
  exp: number
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ sub: payload.sub } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(key)
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return {
      sub: payload.sub as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
    }
  } catch {
    return null
  }
}

export async function createSessionToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ sub: 'webui', iat: now, exp: now + JWT_EXPIRY_SECONDS }, secret)
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'craft_session'
const SESSION_COOKIE_PATTERN = /^craft_session(_\d+)?$/

/**
 * Cookie 不区分端口：同一域名的多个实例（例如 example.com:9100 与 :9101）
 * 都写 craft_session 时会互相覆盖，表现为登录态被对方清空。
 * 把端口写进 cookie 名，让同一 cookie jar 里的多个实例各用各的。
 */
export function sessionCookieName(hostHeader: string | null): string {
  const port = hostHeader?.match(/:(\d+)$/)?.[1]
  return port ? `${SESSION_COOKIE_NAME}_${port}` : SESSION_COOKIE_NAME
}

export function buildSessionCookie(jwt: string, secure: boolean, name = SESSION_COOKIE_NAME): string {
  const parts = [
    `${name}=${jwt}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${JWT_EXPIRY_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildLogoutCookie(secure = false, name = SESSION_COOKIE_NAME): string {
  const parts = [
    `${name}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** 同时兼容旧的无端口 cookie 名，以及按端口隔离后的名字。 */
function sessionCookieValues(cookieHeader: string | null): string[] {
  if (!cookieHeader) return []
  const values: string[] = []
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (SESSION_COOKIE_PATTERN.test(name)) values.push(rest.join('='))
  }
  return values
}

export function extractSessionCookie(cookieHeader: string | null): string | null {
  return sessionCookieValues(cookieHeader)[0] ?? null
}

// ---------------------------------------------------------------------------
// Rate limiter (per-IP + global, sliding window)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  attempts: number
  windowStart: number
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  /** Global counter — blocks all IPs after too many total failures (defeats IP spoofing). */
  private readonly maxGlobalAttempts: number
  private globalAttempts = 0
  private globalWindowStart = Date.now()

  constructor(maxAttempts = 5, windowMs = 60_000, maxGlobalAttempts = 20) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.maxGlobalAttempts = maxGlobalAttempts
  }

  /** Returns true if the request should be allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now()

    // Reset global window if expired
    if (now - this.globalWindowStart > this.windowMs) {
      this.globalAttempts = 0
      this.globalWindowStart = now
    }

    // Global rate limit — blocks everyone if too many total attempts
    this.globalAttempts++
    if (this.globalAttempts > this.maxGlobalAttempts) return false

    // Per-IP rate limit
    const entry = this.entries.get(ip)

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(ip, { attempts: 1, windowStart: now })
      return true
    }

    entry.attempts++
    if (entry.attempts > this.maxAttempts) return false
    return true
  }

  /** Periodic cleanup of stale entries (call on a timer). */
  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.entries.delete(ip)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session validator (used by both HTTP and WebSocket)
// ---------------------------------------------------------------------------

export async function validateSession(
  cookieHeader: string | null,
  secret: string,
): Promise<JwtPayload | null> {
  // 同一域名可能同时存在多个端口的 cookie；逐个校验，取能通过签名的那一个。
  for (const token of sessionCookieValues(cookieHeader)) {
    if (!token) continue
    const payload = await verifyJwt(token, secret)
    if (payload) return payload
  }
  return null
}
