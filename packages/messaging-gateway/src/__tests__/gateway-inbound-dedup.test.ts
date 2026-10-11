/**
 * MessagingGateway — inbound message dedup.
 *
 * Chat platforms redeliver a message whose delivery wasn't acked in time
 * (Lark ~19s) or retry on transport hiccups. Without dedup the same sentence
 * runs through the session twice (issue F3). The gateway drops repeats by
 * `messageId` before any command/routing work.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { MessagingGateway } from '../gateway'
import type { IncomingMessage, PlatformAdapter } from '../types'

let storageDir: string

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'gateway-dedup-'))
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

function makeAdapter() {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  const adapter = {
    platform: 'lark' as const,
    capabilities: {
      messageEditing: true,
      inlineButtons: true,
      maxButtons: 10,
      maxMessageLength: 30000,
      markdown: 'lark-post' as const,
      webhookSupport: false,
    },
    initialize: async () => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage(h: (msg: IncomingMessage) => Promise<void>) {
      messageHandler = h
    },
    onButtonPress: () => {},
    sendText: async () => ({ platform: 'lark' as const, channelId: '', messageId: '0' }),
    editMessage: async () => {},
    sendButtons: async () => ({ platform: 'lark' as const, channelId: '', messageId: '0' }),
    sendTyping: async () => {},
    sendFile: async () => ({ platform: 'lark' as const, channelId: '', messageId: '0' }),
  } as unknown as PlatformAdapter
  return { adapter, fire: (m: IncomingMessage) => messageHandler!(m) }
}

function baseMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'lark',
    channelId: 'chat-1',
    messageId: 'om_1',
    senderId: 'user-1',
    text: 'hello',
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  }
}

async function makeGateway() {
  const sessionManager = {
    sendMessage: mock(async () => {}),
    getSession: async () => null,
  } as unknown as ISessionManager
  const gateway = new MessagingGateway({
    sessionManager,
    workspaceId: 'ws-test',
    storageDir,
  })
  const { adapter, fire } = makeAdapter()
  gateway.registerAdapter(adapter)
  await gateway.start()
  gateway.getBindingStore().bind('ws-test', 'sess-A', 'lark', 'chat-1')
  return { gateway, sessionManager, fire }
}

describe('MessagingGateway — inbound dedup', () => {
  it('drops a redelivered message with the same id (no double routing)', async () => {
    const { sessionManager, fire } = await makeGateway()
    const msg = baseMsg()

    await fire(msg)
    await fire({ ...msg }) // platform redelivery — identical messageId

    expect((sessionManager.sendMessage as ReturnType<typeof mock>).mock.calls.length).toBe(1)
  })

  it('routes distinct message ids independently', async () => {
    const { sessionManager, fire } = await makeGateway()

    await fire(baseMsg({ messageId: 'om_1', text: 'first' }))
    await fire(baseMsg({ messageId: 'om_2', text: 'second' }))

    expect((sessionManager.sendMessage as ReturnType<typeof mock>).mock.calls.length).toBe(2)
  })
})
