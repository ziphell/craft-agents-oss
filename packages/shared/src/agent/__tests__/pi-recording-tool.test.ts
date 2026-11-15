/**
 * `recording_tool` on the **pi** backend.
 *
 * The pane tools take a path of their own through the Pi adapter: it reads the pane functions out
 * of the session-scoped callback registry and calls the command table itself. This pins that path
 * for the local decoder — `probe` and `frames` need the browser's `sampleVideo`, nothing else.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts'

const SESSION_ID = 'session-recording-tool'

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

describe('recording_tool on the pi backend', () => {
  it('probes a recording through the registered pane functions', async () => {
    const seen: Array<Record<string, unknown>> = []
    mergeSessionScopedToolCallbacks(SESSION_ID, {
      browserPaneFns: {
        sampleVideo: async (args: any) => {
          seen.push(args)
          return {
            durationMs: 4000,
            viewport: { width: 1280, height: 720 },
            truncated: false,
            frames: [],
          }
        },
      } as any,
    })

    const agent = new PiAgent(createConfig())
    const result = await (agent as any).executeSessionTool('recording_tool', {
      command: ['probe', 'demo.webm'],
    })

    expect(result.isError).toBe(false)
    expect(seen[0]).toMatchObject({ probeOnly: true })
    expect(result.content).toContain('4s')
    expect(result.content).toContain('1280x720')
  })

  it('refuses by name when the host has neither a pane nor a decoder', async () => {
    mergeSessionScopedToolCallbacks(SESSION_ID, {})

    const agent = new PiAgent(createConfig())
    const result = await (agent as any).executeSessionTool('recording_tool', {
      command: ['frames', 'demo.webm'],
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('needs a decoder')
  })

  const withFrame = () => {
    mergeSessionScopedToolCallbacks(SESSION_ID, {
      browserPaneFns: {
        sampleVideo: async () => ({
          durationMs: 4000,
          truncated: false,
          frames: [{ offsetMs: 0, bytes: new Uint8Array([1, 2]), path: '/tmp/records/frame-0001.jpg' }],
        }),
      } as any,
    })
  }

  // A picture the main model cannot see is a capability boundary: the path is the hand-off, and
  // `call_llm` is the door that reads it. No vision configured means nobody here can read it.
  it('routes a frame through call_llm when the main model cannot see', async () => {
    withFrame()

    const agent = new PiAgent({ ...createConfig(), mainModelSeesImages: false, imageModel: 'vision-9' })
    const result = await (agent as any).executeSessionTool('recording_tool', {
      command: ['frames', 'demo.webm'],
    })

    expect(result.content).toContain('cannot see images')
    expect(result.content).toContain('call_llm')
    expect(result.content).toContain('vision-9')
  })

  it('says the picture is only for the person when nothing can see images', async () => {
    withFrame()

    const agent = new PiAgent({ ...createConfig(), mainModelSeesImages: false })
    const result = await (agent as any).executeSessionTool('recording_tool', {
      command: ['frames', 'demo.webm'],
    })

    expect(result.content).toContain('cannot see images')
    expect(result.content).toContain('no vision model is configured')
  })

  it('does not teach a detour to a model that can see', async () => {
    withFrame()

    const agent = new PiAgent({ ...createConfig(), mainModelSeesImages: true, imageModel: 'vision-9' })
    const result = await (agent as any).executeSessionTool('recording_tool', {
      command: ['frames', 'demo.webm'],
    })

    expect(result.content).toContain('image-preview')
    expect(result.content).not.toContain('cannot see images')
  })
})
