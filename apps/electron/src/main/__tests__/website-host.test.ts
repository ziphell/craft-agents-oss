import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getWebsitePath } from '@craft-agent/shared/websites'
import { websiteOriginUrl } from '../website-host'
import { registerLocalHostHandler } from '../local-host'
import type { ProtocolHostSession } from '../local-http'

interface Host {
  origin: string
  passedThrough: string[]
  serve: (path: string, init?: RequestInit) => Promise<Response>
  close: () => void
}

/**
 * A website to serve: its own workspace, its own host, and the pass-through
 * recorded in order.
 *
 * The files are written after the fixture exists, because the host reads the disk
 * on every request — the property that lets a site be edited without a restart.
 */
function hostFor(slug: string): Host {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-website-host-'))
  const dir = getWebsitePath(workspaceRoot, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>report</title>')
  writeFileSync(join(dir, 'website.json'), '{"slug":"' + slug + '"}')
  writeFileSync(join(dir, 'site.css'), 'body{}')

  const fake = fakeSession()
  const passedThrough: string[] = []
  registerLocalHostHandler(fake.session, async (request) => {
    passedThrough.push(request.url)
    return new Response('somebody else', { status: 200, headers: { 'x-passthrough': '1' } })
  })
  const handler = fake.handler()

  const origin = websiteOriginUrl(workspaceRoot, slug)
  if (!origin) throw new Error(`the fixture website ${slug} was not registered`)

  return {
    origin,
    passedThrough,
    serve: (path: string, init: RequestInit = {}) => {
      passedThrough.length = 0
      return Promise.resolve(handler(new Request(new URL(path, origin).toString(), init)))
    },
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  }
}

/** Stand in for the app session: it only has to remember the handler. */
function fakeSession(): { session: ProtocolHostSession; handler: () => (request: Request) => Promise<Response> } {
  let registered: ((request: Request) => Promise<Response> | Response) | null = null

  return {
    session: {
      protocol: {
        handle: (_scheme, handler) => {
          registered = handler
        },
      },
    },
    handler: () => async (request: Request) => {
      if (!registered) throw new Error('no handler was registered')
      return registered(request)
    },
  }
}

describe('a website at its own origin', () => {
  it('serves its document at the address root', async () => {
    const host = hostFor('report')
    try {
      const response = await host.serve('/')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('report')
    } finally {
      host.close()
    }
  })

  // The whole point of the origin: a path the site names is a file of the site, so
  // root-absolute references resolve without the document knowing where it is served.
  it('serves a file the site names', async () => {
    const host = hostFor('sheet')
    try {
      const response = await host.serve('/site.css')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/css')
    } finally {
      host.close()
    }
  })

  it('falls back to the document for a history-API route', async () => {
    const host = hostFor('flow')
    try {
      const response = await host.serve('/orders', { headers: { accept: 'text/html' } })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('report')
    } finally {
      host.close()
    }
  })

  it('keeps the app’s own bookkeeping off the site’s origin', async () => {
    const host = hostFor('private')
    try {
      const response = await host.serve('/website.json')

      expect(response.status).toBe(403)
      expect(host.passedThrough).toEqual([])
    } finally {
      host.close()
    }
  })

  it('answers a missing path with a 404, not with the document', async () => {
    const host = hostFor('missing')
    try {
      const response = await host.serve('/api/orders', { headers: { accept: '*/*' } })

      expect(response.status).toBe(404)
    } finally {
      host.close()
    }
  })

  it('404s a path with no site behind it', async () => {
    const host = hostFor('gone')
    try {
      const response = await host.serve('/not-a-file.png')

      expect(response.status).toBe(404)
    } finally {
      host.close()
    }
  })
})

describe('the hosts that are not ours', () => {
  // `*.localhost` is full of real dev servers: a label nobody handed out must reach
  // Chromium untouched, not answer 404.
  it('passes a foreign localhost host through', async () => {
    const host = hostFor('passthrough')
    try {
      const fake = fakeSession()
      const passedThrough: string[] = []
      registerLocalHostHandler(fake.session, async (request) => {
        passedThrough.push(request.url)
        return new Response('somebody else', { status: 200 })
      })
      const response = await fake.handler()(new Request('http://dev-server.localhost:5173/app.js'))

      expect(response.status).toBe(200)
      expect(passedThrough).toEqual(['http://dev-server.localhost:5173/app.js'])
    } finally {
      host.close()
    }
  })
})
