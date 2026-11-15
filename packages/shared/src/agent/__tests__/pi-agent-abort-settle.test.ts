import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

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

/** An agent with a fake subprocess handle, so the abort handshake can be armed. */
function createAgent(): PiAgent {
  const agent = new PiAgent(createConfig())
  ;(agent as any).subprocess = {
    stdin: { write: () => true, end: () => {} },
    kill: () => true,
  }
  return agent
}

/** Let pending microtasks (and zero-delay timers) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function sendEvent(agent: PiAgent, event: Record<string, unknown>): void {
  ;(agent as any).handleLine(JSON.stringify({ type: 'event', event }))
}

describe('PiAgent abort handshake (send-now after an interrupt)', () => {
  it('drops the aborted run\'s trailing events instead of closing the next turn', () => {
    const agent = createAgent()
    ;(agent as any).armAbortSettle()

    // What the interrupted run still emits a few hundred ms later: the abort
    // error and the agent_end that used to end the freshly replayed turn.
    sendEvent(agent, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'The operation was aborted.' } })
    sendEvent(agent, { type: 'agent_end', messages: [] })

    expect((agent as any).eventQueue.isComplete).toBe(false)

    agent.destroy()
  })

  it('still forwards events from the interrupted run that cannot end the turn', () => {
    const agent = createAgent()
    ;(agent as any).armAbortSettle()

    // A tool that was in flight when the abort landed still reports its result;
    // that is transcript content, not the run's ending, so it must not be eaten.
    sendEvent(agent, { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'Bash', result: 'done', isError: false })

    expect((agent as any).eventQueue.hasPending).toBe(true)
    expect((agent as any).eventQueue.isComplete).toBe(false)

    agent.destroy()
  })

  it('lets events through again once the subprocess reports the abort settled', () => {
    const agent = createAgent()
    ;(agent as any).armAbortSettle()

    ;(agent as any).handleLine(JSON.stringify({ type: 'abort_settled' }))
    expect((agent as any).isAbortSettling).toBe(false)

    sendEvent(agent, { type: 'agent_end', messages: [] })
    expect((agent as any).eventQueue.isComplete).toBe(true)

    agent.destroy()
  })

  it('releases a turn waiting on the handshake only after the settle', async () => {
    const agent = createAgent()
    ;(agent as any).armAbortSettle()

    let released = false
    void (agent as any).awaitAbortSettle().then(() => {
      released = true
    })

    await tick()
    expect(released).toBe(false)

    ;(agent as any).handleLine(JSON.stringify({ type: 'abort_settled' }))
    await tick()
    expect(released).toBe(true)

    agent.destroy()
  })

  it('does not arm a wait when no subprocess could answer it', () => {
    const agent = new PiAgent(createConfig())
    // No subprocess: the next turn must start immediately rather than wait out
    // the handshake timeout.
    ;(agent as any).armAbortSettle()

    expect((agent as any).isAbortSettling).toBe(false)

    agent.destroy()
  })
})
