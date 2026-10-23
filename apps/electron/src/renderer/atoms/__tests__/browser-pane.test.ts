import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { BrowserInstanceInfo } from '../../../shared/types'
import {
  browserInstancesAtom,
  filterInstancesForWorkspace,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '../browser-pane'

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

describe('browser pane atoms', () => {
  it('does not resurrect removed instance from stale update event', () => {
    const store = createStore()

    store.set(updateBrowserInstanceAtom, makeInstance('browser-1'))
    expect(store.get(browserInstancesAtom).map((i) => i.id)).toEqual(['browser-1'])

    store.set(removeBrowserInstanceAtom, 'browser-1')
    expect(store.get(browserInstancesAtom)).toHaveLength(0)

    // Simulate late out-of-order state event arriving after removal
    store.set(updateBrowserInstanceAtom, makeInstance('browser-1'))

    expect(store.get(browserInstancesAtom)).toHaveLength(0)
  })

  it('authoritative list refresh can restore an instance after prior remove', () => {
    const store = createStore()

    store.set(removeBrowserInstanceAtom, 'browser-2')
    expect(store.get(browserInstancesAtom)).toHaveLength(0)

    // Simulate full list() reconciliation from main process
    store.set(setBrowserInstancesAtom, [makeInstance('browser-2')])

    expect(store.get(browserInstancesAtom).map((i) => i.id)).toEqual(['browser-2'])
  })

  describe('filterInstancesForWorkspace', () => {
    it('returns only the active workspace + unbound entries', () => {
      const all = [
        makeInstance('ws-a-bound', { workspaceId: 'ws-a' }),
        makeInstance('ws-b-bound', { workspaceId: 'ws-b' }),
        makeInstance('unbound', { workspaceId: null }),
      ]

      const visibleInWsA = filterInstancesForWorkspace(all, 'ws-a')
      expect(visibleInWsA.map((i) => i.id).sort()).toEqual(['unbound', 'ws-a-bound'])

      const visibleInWsB = filterInstancesForWorkspace(all, 'ws-b')
      expect(visibleInWsB.map((i) => i.id).sort()).toEqual(['unbound', 'ws-b-bound'])
    })

    it('returns everything when the workspace is null (safe default)', () => {
      const all = [
        makeInstance('ws-a-bound', { workspaceId: 'ws-a' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      expect(filterInstancesForWorkspace(all, null).map((i) => i.id).sort()).toEqual([
        'unbound',
        'ws-a-bound',
      ])
    })

    it('treats undefined workspaceId on an instance as unbound (old-server compat)', () => {
      // Simulate an older main process that doesn't emit workspaceId yet.
      const legacyInstance: BrowserInstanceInfo = makeInstance('legacy')
      delete legacyInstance.workspaceId

      expect(filterInstancesForWorkspace([legacyInstance], 'ws-a').map((i) => i.id)).toEqual([
        'legacy',
      ])
    })

    it('keeps two servers that both call their workspace ws-1 apart', () => {
      const all = [
        makeInstance('hub-a', { workspaceId: 'hub:conn-a:ws-1' }),
        makeInstance('hub-b', { workspaceId: 'hub:conn-b:ws-1' }),
      ]

      // Each remote window sees its own server's window, and only that one.
      expect(filterInstancesForWorkspace(all, 'ws-1', 'conn-a').map((i) => i.id)).toEqual(['hub-a'])
      expect(filterInstancesForWorkspace(all, 'ws-1', 'conn-b').map((i) => i.id)).toEqual(['hub-b'])
      // A local window with a same-named workspace sees neither hub's windows.
      expect(filterInstancesForWorkspace(all, 'ws-1', null)).toEqual([])
    })
  })
})
