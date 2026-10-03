/**
 * `video_tool understand` on the **pi** backend.
 *
 * The pane tools take a path of their own through the Pi adapter: it reads the pane functions out
 * of the session-scoped callback registry and calls the command table itself. The LLM callback
 * `understand` needs sits in that *same* registry entry, so the path has to hand it on too. When
 * it did not, `understand` answered "No model is configured for this conversation" on pi while
 * working on the Claude side — which reads like "this model has no vision" and is not that.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts'
import type { LLMQueryRequest } from '../llm-tool.ts'

const SESSION_ID = 'session-understand'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/craft-agent-test' } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

afterEach(() => {
  unregisterSessionScopedToolCallbacks(SESSION_ID)
})

describe('video_tool understand on the pi backend', () => {
  it('asks the registered model, and hands it every frame with its moment', async () => {
    const asked: LLMQueryRequest[] = []
    mergeSessionScopedToolCallbacks(SESSION_ID, {
      // What the desktop app supplies: the pane half…
      browserPaneFns: {
        sampleVideo: async () => ({
          durationMs: 4000,
          truncated: false,
          frames: [
            { offsetMs: 0, bytes: new Uint8Array([1, 2, 3]), path: null },
            { offsetMs: 1000, bytes: new Uint8Array([4, 5, 6]), path: null },
          ],
        }),
      } as any,
      // …and the model half, which is the one this test is about.
      queryFn: async (request) => {
        asked.push(request)
        return { text: 'a page with a moving dot' }
      },
    })

    const agent = new PiAgent(createConfig())
    const result = await (agent as any).executeSessionTool('video_tool', {
      command: ['understand', 'demo.webm', '--prompt', 'what happened?'],
    })

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.images?.map((image) => image.timestampMs)).toEqual([0, 1000])
    expect(result.content).toContain('a page with a moving dot')
  })

  it('still samples frames when no model is configured, and says why', async () => {
    mergeSessionScopedToolCallbacks(SESSION_ID, {
      browserPaneFns: {
        sampleVideo: async () => ({ durationMs: 1000, truncated: false, frames: [] }),
      } as any,
    })

    const agent = new PiAgent(createConfig())
    const result = await (agent as any).executeSessionTool('video_tool', {
      command: ['understand', 'demo.webm', '--prompt', 'what happened?'],
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No model is configured for this conversation')
  })
})
