import { describe, it, expect } from 'bun:test'
import type { WebContents } from 'electron'
import { BrowserCDP } from '../browser-cdp'
import type { MockRoute } from '@craft-agent/shared/prototypes'

/**
 * The mock answers requests in the browser's network stack via CDP Fetch
 * interception. These tests drive the `Fetch.requestPaused` event by hand and
 * assert the disposition — including the failure path, where leaving a request
 * paused would freeze the page.
 */
function createFakeDebugger(options?: { failFulfil?: boolean }) {
  const calls: Array<{ method: string; params: any }> = []
  const listeners = new Map<string, Array<(...args: any[]) => void>>()

  const fake = {
    debugger: {
      attach: () => {},
      detach: () => {},
      on: (event: string, callback: (...args: any[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), callback])
      },
      sendCommand: async (method: string, params: any) => {
        calls.push({ method, params })
        if (options?.failFulfil && method === 'Fetch.fulfillRequest') {
          throw new Error('boom')
        }
        return {}
      },
    },
  }

  return {
    webContents: fake as unknown as WebContents,
    calls,
    emitPaused: (requestId: string, url: string, method: string) => {
      for (const callback of listeners.get('message') ?? []) {
        callback({}, 'Fetch.requestPaused', { requestId, request: { url, method } })
      }
    },
  }
}

const ROUTES: MockRoute[] = [{ method: 'GET', path: '/orders', status: 200, body: [{ id: 1 }] }]

/** One macrotask is enough to flush the handler's awaited CDP calls. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('BrowserCDP fetch mock', () => {
  it('enables Fetch interception at the request stage and normalises methods', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    const count = await cdp.setFetchMockRoutes([{ method: 'get', path: '/orders', status: 200, body: null }])

    expect(count).toBe(1)
    expect(cdp.listFetchMockRoutes()[0]?.method).toBe('GET')
    const enable = calls.find((call) => call.method === 'Fetch.enable')
    expect(enable?.params?.patterns).toEqual([{ urlPattern: '*', requestStage: 'Request' }])
    cdp.detach()
  })

  it('fulfils a matching request with the fixture body, status and CORS header', async () => {
    const { webContents, calls, emitPaused } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes([{ method: 'GET', path: '/orders', status: 201, body: [{ id: 1 }] }])
    emitPaused('req-1', 'http://localhost:3000/api/orders?page=1', 'GET')
    await flush()

    const fulfill = calls.find((call) => call.method === 'Fetch.fulfillRequest')
    expect(fulfill?.params?.requestId).toBe('req-1')
    expect(fulfill?.params?.responseCode).toBe(201)
    expect(Buffer.from(fulfill?.params?.body ?? '', 'base64').toString('utf-8')).toBe('[{"id":1}]')
    expect(fulfill?.params?.responseHeaders).toContainEqual({
      name: 'access-control-allow-origin',
      value: '*',
    })
    expect(calls.some((call) => call.method === 'Fetch.continueRequest')).toBe(false)
    cdp.detach()
  })

  it('matches on pathname so a baseUrl prefix and query string still hit the route', async () => {
    const { webContents, calls, emitPaused } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes(ROUTES)
    // Same-origin relative request — the common case for an in-development app.
    emitPaused('req-rel', '/api/v2/orders', 'GET')
    await flush()

    const fulfill = calls.find((call) => call.method === 'Fetch.fulfillRequest')
    expect(fulfill?.params?.requestId).toBe('req-rel')
    cdp.detach()
  })

  it('overlays a real backend: a route intercepts any host with the same path', async () => {
    const { webContents, calls, emitPaused } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes([
      { method: 'GET', path: '/api/orders', status: 200, body: { overridden: true } },
    ])
    // Note the host: a production API, not a mock server.
    emitPaused('req-real', 'https://api.production.example.com/api/orders', 'GET')
    await flush()

    const fulfill = calls.find((call) => call.method === 'Fetch.fulfillRequest')
    expect(fulfill?.params?.requestId).toBe('req-real')
    expect(Buffer.from(fulfill?.params?.body ?? '', 'base64').toString('utf-8')).toBe('{"overridden":true}')
    cdp.detach()
  })

  it('continues requests that do not match, including a different method', async () => {
    const { webContents, calls, emitPaused } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes(ROUTES)
    emitPaused('req-post', 'http://localhost:3000/orders', 'POST')
    emitPaused('req-other', 'http://localhost:3000/invoices', 'GET')
    await flush()

    const continued = calls.filter((call) => call.method === 'Fetch.continueRequest').map((call) => call.params?.requestId)
    expect(continued).toEqual(['req-post', 'req-other'])
    expect(calls.some((call) => call.method === 'Fetch.fulfillRequest')).toBe(false)
    cdp.detach()
  })

  it('releases the request even when fulfilling throws, so the page cannot hang', async () => {
    const { webContents, calls, emitPaused } = createFakeDebugger({ failFulfil: true })
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes(ROUTES)
    emitPaused('req-1', 'http://localhost:3000/orders', 'GET')
    await flush()

    const continued = calls.filter((call) => call.method === 'Fetch.continueRequest')
    expect(continued).toHaveLength(1)
    expect(continued[0]?.params?.requestId).toBe('req-1')
    cdp.detach()
  })

  it('disables interception when the mock is cleared', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes(ROUTES)
    await cdp.clearFetchMock()

    expect(cdp.listFetchMockRoutes()).toEqual([])
    expect(calls.some((call) => call.method === 'Fetch.disable')).toBe(true)
    cdp.detach()
  })

  it('drops the route table on detach, because CDP does too', async () => {
    const { webContents } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.setFetchMockRoutes(ROUTES)
    expect(cdp.listFetchMockRoutes()).toHaveLength(1)

    cdp.detach()
    expect(cdp.listFetchMockRoutes()).toEqual([])
  })
})
