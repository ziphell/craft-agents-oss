import { describe, expect, it } from 'bun:test'
import { releaseBrowserOnForcedStop } from '@craft-agent/server-core/domain'

describe('releaseBrowserOnForcedStop', () => {
  it('clears visuals and lets the lease go', async () => {
    const calls: string[] = []

    const browserPaneManager = {
      clearVisualsForSession: async (sessionId: string) => {
        calls.push(`clear:${sessionId}`)
      },
      unbindAllForSession: (sessionId: string) => {
        calls.push(`unbind:${sessionId}`)
      },
    }

    await releaseBrowserOnForcedStop(browserPaneManager, 'session-1')

    expect(calls).toEqual(['clear:session-1', 'unbind:session-1'])
  })

  it('is a safe no-op when browser manager is missing', async () => {
    await expect(releaseBrowserOnForcedStop(null, 'session-2')).resolves.toBeUndefined()
    await expect(releaseBrowserOnForcedStop(undefined, 'session-3')).resolves.toBeUndefined()
  })
})
