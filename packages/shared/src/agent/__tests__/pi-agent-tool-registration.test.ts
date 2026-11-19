import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

/**
 * Regression coverage for the lost `mcp__session__*` tool layer.
 *
 * Session tools were registered once at spawn, while source (pool) tools were
 * re-sent every turn. A session built between the two — or while spawn-time
 * registration was still in flight — kept source tools and no session tools for
 * the whole conversation. These tests pin the two host-side invariants:
 *  - one `register_tools` message carries the whole surface, and
 *  - `ensureSubprocess` waits for the whole spawn, not just `ready`.
 */

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

function createAgentWithFakeSubprocess(): { agent: PiAgent; lines: string[] } {
  const agent = new PiAgent(createConfig())
  const lines: string[] = []
  ;(agent as any).subprocess = {
    stdin: {
      writable: true,
      write: (line: string) => {
        lines.push(line)
        return true
      },
      end: () => {},
    },
    kill: () => true,
  }
  return { agent, lines }
}

function sessionDef(name: string) {
  return { name, description: `${name} description`, inputSchema: { type: 'object', properties: {} } }
}

function sentMessages(lines: string[]): any[] {
  return lines.map(line => JSON.parse(line))
}

describe('PiAgent proxy tool registration', () => {
  it('registers session tools and pool tools in one message', () => {
    const { agent, lines } = createAgentWithFakeSubprocess()
    ;(agent as any).config.mcpPool = {
      getProxyToolDefs: () => [sessionDef('mcp__bitwarden__list_items')],
    }

    ;(agent as any).registerProxyToolsWithSubprocess([
      sessionDef('mcp__session__call_llm'),
      sessionDef('mcp__session__submit_plan'),
    ])

    const messages = sentMessages(lines)
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe('register_tools')
    expect(messages[0].tools.map((tool: any) => tool.name)).toEqual([
      'mcp__session__call_llm',
      'mcp__session__submit_plan',
      'mcp__bitwarden__list_items',
    ])

    agent.destroy()
  })

  it('re-sends the session tools with the pool tools on every source update', () => {
    const { agent, lines } = createAgentWithFakeSubprocess()
    ;(agent as any).config.mcpPool = {
      getProxyToolDefs: () => [sessionDef('mcp__bitwarden__list_items')],
    }
    ;(agent as any).subprocessSessionToolDefs = [sessionDef('mcp__session__call_llm')]

    ;(agent as any).registerPoolToolsWithSubprocess()

    const messages = sentMessages(lines)
    expect(messages).toHaveLength(1)
    expect(messages[0].tools.map((tool: any) => tool.name)).toEqual([
      'mcp__session__call_llm',
      'mcp__bitwarden__list_items',
    ])

    agent.destroy()
  })

  it('never sends pool tools alone (no partial surface)', () => {
    const { agent, lines } = createAgentWithFakeSubprocess()
    ;(agent as any).config.mcpPool = {
      getProxyToolDefs: () => [sessionDef('mcp__bitwarden__list_items')],
    }
    ;(agent as any).subprocessSessionToolDefs = null

    ;(agent as any).registerPoolToolsWithSubprocess()

    expect(lines).toHaveLength(0)

    agent.destroy()
  })
})

describe('PiAgent ensureSubprocess waits for the whole spawn', () => {
  it('does not return at `ready` while the spawn is still registering tools', async () => {
    const { agent } = createAgentWithFakeSubprocess()
    // `ready` has already resolved; the spawn mill is still running.
    ;(agent as any).subprocessReady = Promise.resolve()

    let releaseSpawn: () => void = () => {}
    ;(agent as any).spawnInFlight = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })

    let settled = false
    const ensuring = (agent as any).ensureSubprocess().then(() => {
      settled = true
    })

    // Several turns of the event loop: only `ready` is ready.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    releaseSpawn()
    await ensuring
    expect(settled).toBe(true)

    agent.destroy()
  })
})
