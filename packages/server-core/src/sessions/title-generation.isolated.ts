import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as backend from '@craft-agent/shared/agent/backend'
import * as config from '@craft-agent/shared/config'
import { SessionManager, createManagedSession, setSessionPlatform } from './SessionManager.ts'

// Run in isolation: setSessionPlatform is process-global and has no reset API.
setSessionPlatform({
  appRootPath: '/tmp/title-test',
  resourcesPath: '/tmp/title-test/resources',
  isPackaged: false,
  appVersion: 'test',
  isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: {
    async getMetadata() { return null },
    async process() { throw new Error('Unexpected image processing in title test') },
  },
})

// No config/credential writes or real subprocesses: exercise the actual manager
// title paths with an in-memory session and a temporary backend stub.
const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function setup() {
  const manager = new SessionManager()
  const managed = createManagedSession({
    id: 'title-test',
    llmConnection: 'chatgpt-plus-test',
    model: 'pi/gpt-5.4',
  }, {
    id: 'ws-test',
    slug: 'ws-test',
    name: 'Test',
    rootPath: '/tmp/title-test',
    createdAt: 0,
  }, { messagesLoaded: true })
  managed.messages = [{
    id: 'user-1', role: 'user', content: 'Fix ChatGPT title regeneration', timestamp: 1,
  }]
  ;(manager as any).sessions.set(managed.id, managed)

  const agent = {
    postInit: mock(async () => undefined),
    regenerateTitle: mock(async () => 'ChatGPT Title Fix'),
    generateTitle: mock(async () => 'ChatGPT Title Fix'),
    destroy: mock(() => {}),
  }
  const createAgent = spyOn(backend, 'createBackendFromConnection').mockReturnValue(agent as unknown as backend.AgentBackend)
  spies.push(createAgent)
  spies.push(spyOn(config, 'getLlmConnection').mockReturnValue({
    slug: 'chatgpt-plus-test',
    name: 'ChatGPT Plus',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'openai-codex',
    defaultModel: 'pi/gpt-5.5',
    models: ['pi/gpt-5.4-mini', 'pi/gpt-5.4', 'pi/gpt-5.5'],
    createdAt: 0,
  }))
  spies.push(spyOn(config, 'resolveTitleLanguageName').mockReturnValue('English'))
  spies.push(spyOn(config, 'getPersistedUiLanguage').mockReturnValue('en'))
  const sendEvent = spyOn(manager as any, 'sendEvent').mockImplementation(() => {})
  spies.push(sendEvent)
  spies.push(spyOn(manager as any, 'persistSession').mockImplementation(() => {}))
  spies.push(spyOn(manager as any, 'flushSession').mockResolvedValue(undefined))
  return { manager, managed, agent, createAgent, sendEvent }
}

describe('temporary title agents', () => {
  it('preserves the cold session model for regenerate-title fallback and cleans up the agent', async () => {
    const { manager, managed, agent, createAgent, sendEvent } = setup()
    await expect(manager.refreshTitle(managed.id)).resolves.toEqual({ success: true, title: 'ChatGPT Title Fix' })
    expect(createAgent.mock.calls[0]![1]).toMatchObject({
      model: 'pi/gpt-5.4', miniModel: 'pi/gpt-5.4-mini', isHeadless: true,
    })
    // Exercise the real factory's model resolver too: the preserved selection
    // must survive resolution, not merely arrive at the factory stub.
    expect(backend.resolveModelForProvider(
      'pi', createAgent.mock.calls[0]![1].model, config.getLlmConnection('chatgpt-plus-test'),
    )).toBe('pi/gpt-5.4')
    expect(agent.regenerateTitle).toHaveBeenCalledWith(['Fix ChatGPT title regeneration'], '', { language: 'English' })
    expect(agent.destroy).toHaveBeenCalledTimes(1)
    expect(managed.name).toBe('ChatGPT Title Fix')
    expect(managed.isAsyncOperationOngoing).toBe(false)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'title_generated', sessionId: managed.id, title: 'ChatGPT Title Fix' }, 'ws-test')
  })

  it('preserves the session model when initial title generation also needs a temporary agent', async () => {
    const { manager, managed, agent, createAgent } = setup()
    await (manager as any).generateTitle(managed, 'Fix ChatGPT title regeneration')
    expect(createAgent.mock.calls[0]![1]).toMatchObject({ model: 'pi/gpt-5.4', miniModel: 'pi/gpt-5.4-mini' })
    expect(agent.generateTitle).toHaveBeenCalledWith('Fix ChatGPT title regeneration', { language: 'English' })
    expect(agent.destroy).toHaveBeenCalledTimes(1)
    expect(managed.name).toBe('ChatGPT Title Fix')
  })
})
