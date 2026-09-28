import { describe, it, expect } from 'bun:test'
import type { WebContents } from 'electron'
import { BrowserCDP } from '../browser-cdp'

/**
 * `addInitScript` is the mechanism behind "reload keeps my changes", so its
 * registration bookkeeping (replace semantics, detach invalidation) needs to be
 * pinned down — CDP silently drops these registrations when the session detaches.
 * The Page domain has to be on as well: without it the registration is answered
 * and then never run in a new document, which is the same silent nothing.
 */
function createFakeDebugger() {
  const calls: Array<{ method: string; params: any }> = []
  const detachListeners: Array<() => void> = []
  let nextIdentifier = 0

  const fake = {
    debugger: {
      attach: () => {},
      detach: () => {},
      on: (event: string, listener: () => void) => {
        if (event === 'detach') detachListeners.push(listener)
      },
      sendCommand: async (method: string, params: any) => {
        calls.push({ method, params })
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          nextIdentifier += 1
          return { identifier: `script-${nextIdentifier}` }
        }
        return {}
      },
    },
  }

  return {
    webContents: fake as unknown as WebContents,
    calls,
    /** The session ending without us asking — the page's renderer dying. */
    endSessionFromOutside: () => detachListeners.forEach((listener) => listener()),
  }
}

describe('BrowserCDP persistent injection', () => {
  it('registers an init script and exposes its key', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    const identifier = await cdp.addInitScript('tweak:all', 'window.__a = 1')

    expect(identifier).toBe('script-1')
    expect(cdp.listInitScriptKeys()).toEqual(['tweak:all'])
    const registration = calls.find((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
    expect(registration?.params?.source).toBe('window.__a = 1')
    cdp.detach()
  })

  it('replacing a key removes the previous registration first', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.addInitScript('key-a', 'first')
    await cdp.addInitScript('key-a', 'second')

    // The domain enable is pinned by its own test; this one is about the order of
    // the registrations themselves.
    const methods = calls.map((call) => call.method).filter((method) => method !== 'Page.enable')
    expect(methods).toEqual([
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.removeScriptToEvaluateOnNewDocument',
      'Page.addScriptToEvaluateOnNewDocument',
    ])
    expect(cdp.listInitScriptKeys()).toEqual(['key-a'])
    cdp.detach()
  })

  it('removes a registered key and forgets it', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.addInitScript('key-a', 'a')
    await cdp.addInitScript('key-b', 'b')
    await cdp.removeInitScript('key-a')

    expect(cdp.listInitScriptKeys()).toEqual(['key-b'])
    expect(calls.some((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(true)
    cdp.detach()
  })

  it('is a no-op when removing an unknown key', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.removeInitScript('never-registered')

    expect(calls.some((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(false)
    cdp.detach()
  })

  it('drops its bookkeeping on detach, because CDP does too', async () => {
    const { webContents } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.addInitScript('key-a', 'a')
    expect(cdp.listInitScriptKeys()).toEqual(['key-a'])

    cdp.detach()
    expect(cdp.listInitScriptKeys()).toEqual([])
  })

  it('turns the Page domain on before the first registration, and only once', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.addInitScript('key-a', 'a')
    await cdp.addInitScript('key-b', 'b')

    expect(calls.map((call) => call.method)).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.addScriptToEvaluateOnNewDocument',
    ])
    cdp.detach()
  })

  it('turns the Page domain on again after a detach, which forgets it too', async () => {
    const { webContents, calls } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.addInitScript('key-a', 'a')
    cdp.detach()
    await cdp.addInitScript('key-a', 'a')

    expect(calls.filter((call) => call.method === 'Page.enable')).toHaveLength(2)
    cdp.detach()
  })

  it('forgets them when the session ends from outside, not only when we end it', async () => {
    // A session can end without `detach()` being called — the page's renderer dying is the
    // one that happens. (Opening DevTools is not: measured on Electron 39, both sessions
    // stand side by side — `spike/anti-bot-fingerprint.ts` round 5.) Whoever ended it, the
    // registrations went with it, and a reader still listing them is how an injection stops
    // applying without anything saying so.
    const { webContents, calls, endSessionFromOutside } = createFakeDebugger()
    const cdp = new BrowserCDP(webContents)

    await cdp.addInitScript('key-a', 'a')
    expect(cdp.listInitScriptKeys()).toEqual(['key-a'])

    endSessionFromOutside()

    expect(cdp.listInitScriptKeys()).toEqual([])
    // And the domain is turned on again for what comes next: without that the script
    // re-registered here is accepted and then never run in any document.
    await cdp.addInitScript('key-b', 'b')
    expect(calls.filter((call) => call.method === 'Page.enable')).toHaveLength(2)
    cdp.detach()
  })
})
