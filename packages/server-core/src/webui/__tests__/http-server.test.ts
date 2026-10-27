import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestUsesExternalAddress, resolveWebSocketUrl, startWebuiHttpServer } from '../http-server'
import { deriveWebuiSessionKey, sessionCookieName, buildSessionCookie, createSessionToken, validateSession } from '../auth'
import { storeExport } from '../../services/export-store'

const SECRET = 'test-server-secret'
const PASSWORD = 'test-password'
/** A hub credential, as a native client would present it — not the Web UI's signing key. */
const HUB_TOKEN = 'test-hub-token'
const TEMP_DIRS: string[] = []
const SERVERS: Array<{ stop: () => void }> = []

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-webui-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

/** A stand-in for the vendored bundle: the editor document and one asset. */
function createTestDrawioDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-drawio-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>drawio-editor</body></html>')
  mkdirSync(join(dir, 'js'), { recursive: true })
  writeFileSync(join(dir, 'js', 'viewer-static.min.js'), 'window.GraphViewer = {}')
  return dir
}

async function createServer(overrides?: {
  secureCookies?: boolean
  publicWsUrl?: string
  wsProtocol?: 'ws' | 'wss'
  wsPort?: number
  /** A hub whose page bundle is missing: protocol routes only. */
  withoutWebui?: boolean
  /** A hub carrying the bundled drawio editor. */
  withDrawio?: boolean
}) {
  const server = await startWebuiHttpServer({
    port: 0,
    ...(overrides?.withoutWebui ? {} : { webuiDir: createTestWebuiDir() }),
    ...(overrides?.withDrawio ? { drawioDir: createTestDrawioDir() } : {}),
    serverToken: HUB_TOKEN,
    password: PASSWORD,
    authorizeBearer: (header) => header === `Bearer ${HUB_TOKEN}`,
    secureCookies: overrides?.secureCookies,
    publicWsUrl: overrides?.publicWsUrl,
    wsProtocol: overrides?.wsProtocol ?? 'wss',
    wsPort: overrides?.wsPort ?? 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
  })

  SERVERS.push(server)

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
  }
}

async function login(baseUrl: string): Promise<string> {
  const authRes = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(authRes.status).toBe(200)
  return extractSessionCookie(authRes)
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  while (SERVERS.length > 0) {
    SERVERS.pop()?.stop()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('session cookies across ports', () => {
  it('scopes the cookie name by port so two instances on one host do not overwrite each other', () => {
    expect(sessionCookieName('example.com:9100')).toBe('craft_session_9100')
    expect(sessionCookieName('example.com:9101')).toBe('craft_session_9101')
    expect(sessionCookieName('example.com')).toBe('craft_session')
    expect(sessionCookieName(null)).toBe('craft_session')
    expect(buildSessionCookie('jwt', false, 'craft_session_9100')).toContain('craft_session_9100=jwt')
  })

  it('accepts whichever port-scoped cookie verifies with this instance key', async () => {
    const tokenA = await createSessionToken('secret-a')
    const tokenB = await createSessionToken('secret-b')
    const both = `craft_session_9100=${tokenB}; craft_session_9101=${tokenA}`

    expect(await validateSession(both, 'secret-a')).not.toBeNull()
    expect(await validateSession(both, 'secret-b')).not.toBeNull()
    expect(await validateSession(`craft_session_9100=${tokenA}`, 'secret-b')).toBeNull()
  })
})

describe('startWebuiHttpServer', () => {
  it('allows plain-http login even when the RPC transport is wss', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(authRes.status).toBe(200)
    const setCookie = authRes.headers.get('set-cookie')
    expect(setCookie).toMatch(/craft_session(_\d+)?=/)
    expect(setCookie).not.toContain('Secure')

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
  })

  it('serves a produced export to a cookie or a bearer-carrying client', async () => {
    const { baseUrl } = await createServer()

    const dir = mkdtempSync(join(tmpdir(), 'craft-export-test-'))
    TEMP_DIRS.push(dir)
    const file = join(dir, 'deck.pdf')
    writeFileSync(file, 'pdf-bytes')
    const { id } = storeExport({ path: file, name: 'deck.pdf', mime: 'application/pdf' })

    const viaBearer = await fetch(`${baseUrl}/api/exports/${id}`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
    })
    expect(viaBearer.status).toBe(200)
    expect(viaBearer.headers.get('content-type')).toBe('application/pdf')
    expect(viaBearer.headers.get('content-disposition')).toContain('attachment')
    expect(await viaBearer.text()).toBe('pdf-bytes')

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    const viaCookie = await fetch(`${baseUrl}/api/exports/${id}`, {
      headers: { cookie: extractSessionCookie(authRes) },
    })
    expect(viaCookie.status).toBe(200)

    // No credential, a wrong one, the signing key, and an unknown id are four different answers.
    expect((await fetch(`${baseUrl}/api/exports/${id}`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/exports/${id}`, {
      headers: { Authorization: 'Bearer wrong' },
    })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/exports/${id}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/exports/unknown`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
    })).status).toBe(404)
  })

  it('serves protocol routes without a page bundle', async () => {
    const { baseUrl } = await createServer({ withoutWebui: true })

    const dir = mkdtempSync(join(tmpdir(), 'craft-export-test-'))
    TEMP_DIRS.push(dir)
    const file = join(dir, 'deck.pdf')
    writeFileSync(file, 'pdf-bytes')
    const { id } = storeExport({ path: file, name: 'deck.pdf', mime: 'application/pdf' })

    const download = await fetch(`${baseUrl}/api/exports/${id}`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
    })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('pdf-bytes')

    // No page bundle: there is nowhere to redirect a person, so the root answers 401 instead of
    // bouncing to a login page that does not exist.
    expect((await fetch(`${baseUrl}/`)).status).toBe(401)

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    const root = await fetch(`${baseUrl}/`, {
      headers: { cookie: extractSessionCookie(authRes) },
    })
    expect(root.status).toBe(404)
    expect(await root.text()).toBe('Web UI is not built')
  })

  it('rejects invalid credentials', async () => {
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('accepts the hub token at the login page', async () => {
    // The token already drives this hub from a desktop client, so it may as well work in the
    // browser login form — same privilege, one less thing to look up.
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: HUB_TOKEN }),
    })

    expect(res.status).toBe(200)
    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: { cookie: extractSessionCookie(res) },
    })
    expect(configRes.status).toBe(200)
  })

  it('honors an explicit secure-cookie override', async () => {
    const { baseUrl } = await createServer({ secureCookies: true, wsProtocol: 'ws', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('infers secure cookies from proxy https headers when no override is set', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('derives a browser-facing websocket URL from forwarded public host headers', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'craft.example.com:3100',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'craft.example.com:3100',
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://craft.example.com:9100',
    })
  })

  it('gives the external address to a request that arrives through it', async () => {
    const { baseUrl } = await createServer({
      publicWsUrl: 'wss://craft.example.com/ws',
      wsProtocol: 'wss',
      wsPort: 9100,
    })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
        'X-Forwarded-Host': 'craft.example.com',
        'X-Forwarded-Proto': 'https',
      },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://craft.example.com/ws',
    })
  })

  it('keeps a request on the network on its own address when an external address is set', async () => {
    const { baseUrl } = await createServer({
      publicWsUrl: 'wss://craft.example.com/ws',
      wsProtocol: 'wss',
      wsPort: 9100,
    })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    // A browser on the LAN calls this hub directly: no proxy in front, its host is the address it
    // will use. The external address is not its own, so it is not handed to it.
    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: { cookie: extractSessionCookie(authRes) },
    })

    expect(configRes.status).toBe(200)
    expect(await configRes.json()).toEqual({
      wsUrl: 'wss://127.0.0.1:9100',
    })
  })

  it('serves the bundled drawio editor at /drawio/ behind the session', async () => {
    const { baseUrl } = await createServer({ withDrawio: true })

    // No cookie: the editor is part of the app, not a public static host.
    expect((await fetch(`${baseUrl}/drawio/__craft/viewer.html`)).status).toBe(401)

    const cookie = await login(baseUrl)
    const headers = { cookie }

    const editor = await fetch(`${baseUrl}/drawio/`, { headers })
    expect(editor.status).toBe(200)
    expect(await editor.text()).toContain('drawio-editor')
    expect(editor.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")

    const shell = await fetch(`${baseUrl}/drawio/__craft/viewer.html`, { headers })
    expect(shell.status).toBe(200)
    const html = await shell.text()
    expect(html).toContain('<base href="/drawio/">')
    expect(html).toContain('/drawio/__craft/viewer.js')
    expect(html).toContain('/drawio/js/viewer-static.min.js')

    const bridge = await fetch(`${baseUrl}/drawio/__craft/viewer.js`, { headers })
    expect(await bridge.text()).toContain("window.STENCIL_PATH = '/drawio/stencils'")

    const asset = await fetch(`${baseUrl}/drawio/js/viewer-static.min.js`, { headers })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
  })

  it('redirects unauthenticated HTML requests to /login', async () => {
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/`, {
      redirect: 'manual',
      headers: { Accept: 'text/html' },
    })

    expect(res.status).toBe(302)
    // Relative Location — a bare `Response.redirect('/login')` throws under Node's
    // undici, so the handler must build the response itself.
    expect(res.headers.get('location')).toBe('/login')
  })
})

describe('Web UI session signing key', () => {
  it('depends on both the hub token and the Web UI password', () => {
    const base = deriveWebuiSessionKey('token-a', 'password-a')

    expect(deriveWebuiSessionKey('token-a', 'password-a')).toBe(base)
    // Either credential changing ends the sessions the old key signed.
    expect(deriveWebuiSessionKey('token-b', 'password-a')).not.toBe(base)
    expect(deriveWebuiSessionKey('token-a', 'password-b')).not.toBe(base)
  })
})

describe('which requests get the external address', () => {
  const PUBLIC = 'wss://craft.example.com/ws'

  const request = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { headers })

  it('applies to a request whose host is the external one', () => {
    expect(requestUsesExternalAddress(request('http://127.0.0.1:9100/api/config', {
      host: 'craft.example.com',
    }), PUBLIC)).toBe(true)
  })

  it('applies to a request a proxy forwarded here, whatever its host', () => {
    expect(requestUsesExternalAddress(request('http://127.0.0.1:9100/api/config', {
      host: '127.0.0.1:9100',
      'x-forwarded-host': 'craft.example.com',
    }), PUBLIC)).toBe(true)
  })

  it('does not apply to a machine on the network calling the hub directly', () => {
    expect(requestUsesExternalAddress(request('http://192.168.1.5:9100/api/config', {
      host: '192.168.1.5:9100',
    }), PUBLIC)).toBe(false)
  })

  it('resolves the LAN address for that machine, not the external one', () => {
    expect(resolveWebSocketUrl(request('http://192.168.1.5:9100/api/config', {
      host: '192.168.1.5:9100',
    }), { publicWsUrl: PUBLIC, wsProtocol: 'ws', wsPort: 9100 })).toBe('ws://192.168.1.5:9100')
  })

  it('takes an https address and hands out its socket form', () => {
    const proxied = request('http://127.0.0.1:9100/api/config', {
      'x-forwarded-host': 'agents.example.com',
      'x-forwarded-proto': 'https',
    })

    expect(requestUsesExternalAddress(proxied, 'https://agents.example.com/craft')).toBe(true)
    expect(resolveWebSocketUrl(proxied, {
      publicWsUrl: 'https://agents.example.com/craft',
      wsProtocol: 'ws',
      wsPort: 9100,
    })).toBe('wss://agents.example.com/craft')
  })

  it('resolves the internal address when no external address is configured', () => {
    expect(resolveWebSocketUrl(request('http://192.168.1.5:9100/api/config', {
      host: '192.168.1.5:9100',
      'x-forwarded-host': 'craft.example.com',
    }), { wsProtocol: 'ws', wsPort: 9100 })).toBe('ws://craft.example.com:9100')
  })
})
