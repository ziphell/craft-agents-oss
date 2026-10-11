/**
 * LarkAdapter tests — focused on pure / unit-testable surface.
 *
 * The full adapter relies on Lark's WSClient (long-polling socket) and a
 * concrete `Client` instance, neither of which can be exercised in a unit
 * test without integration infrastructure. These tests cover the credential
 * parser and confirm the adapter's static contract (capabilities, platform).
 *
 * End-to-end behaviour (event dispatch, send/edit roundtrips) is verified
 * via manual smoke against a real Lark Custom App.
 */
import { describe, expect, it } from 'bun:test'
import { parseLarkCredentials, LarkAdapter } from '../adapters/lark/index'

describe('parseLarkCredentials', () => {
  it('parses a valid JSON-encoded credential blob', () => {
    const creds = parseLarkCredentials(
      JSON.stringify({ appId: 'cli_abc', appSecret: 'secret', domain: 'lark' }),
    )
    expect(creds.appId).toBe('cli_abc')
    expect(creds.appSecret).toBe('secret')
    expect(creds.domain).toBe('lark')
  })

  it('accepts feishu domain', () => {
    const creds = parseLarkCredentials(
      JSON.stringify({ appId: 'cli_abc', appSecret: 'x', domain: 'feishu' }),
    )
    expect(creds.domain).toBe('feishu')
  })

  it('throws on missing token', () => {
    expect(() => parseLarkCredentials(undefined)).toThrow(/missing/i)
    expect(() => parseLarkCredentials('')).toThrow(/missing/i)
  })

  it('throws on non-JSON input', () => {
    expect(() => parseLarkCredentials('not-json')).toThrow(/JSON/i)
  })

  it('throws on missing appId or appSecret', () => {
    expect(() =>
      parseLarkCredentials(JSON.stringify({ appSecret: 'x', domain: 'lark' })),
    ).toThrow(/appId/i)
    expect(() =>
      parseLarkCredentials(JSON.stringify({ appId: 'cli_x', domain: 'lark' })),
    ).toThrow(/appSecret/i)
  })

  it('throws on invalid domain', () => {
    expect(() =>
      parseLarkCredentials(JSON.stringify({ appId: 'cli_x', appSecret: 'x', domain: 'larksuite' })),
    ).toThrow(/domain/i)
  })
})

describe('LarkAdapter — static contract', () => {
  it('declares platform = "lark"', () => {
    const adapter = new LarkAdapter()
    expect(adapter.platform).toBe('lark')
  })

  it('reports Phase 2 capabilities (edits, buttons, lark-post)', () => {
    const adapter = new LarkAdapter()
    expect(adapter.capabilities.messageEditing).toBe(true)
    expect(adapter.capabilities.inlineButtons).toBe(true)
    expect(adapter.capabilities.markdown).toBe('lark-post')
    expect(adapter.capabilities.maxButtons).toBe(10)
    expect(adapter.capabilities.webhookSupport).toBe(false)
  })

  it('starts disconnected before initialize', () => {
    const adapter = new LarkAdapter()
    expect(adapter.isConnected()).toBe(false)
  })
})

describe('LarkAdapter — business errors & resource downloads', () => {
  function wire(client: unknown) {
    const adapter = new LarkAdapter()
    const logs: Array<{ level: string; meta: Record<string, unknown> | undefined }> = []
    const log = {
      info: (_m: string, meta?: Record<string, unknown>) => logs.push({ level: 'info', meta }),
      warn: (_m: string, meta?: Record<string, unknown>) => logs.push({ level: 'warn', meta }),
      error: (_m: string, meta?: Record<string, unknown>) => logs.push({ level: 'error', meta }),
      child: () => log,
    }
    ;(adapter as unknown as { client: unknown }).client = client
    ;(adapter as unknown as { log: unknown }).log = log
    const hasEvent = (ev: string) => logs.some((l) => l.meta?.event === ev)
    return { adapter, logs, hasEvent }
  }

  it('throws and logs lark_send_failed when create resolves a business error code', async () => {
    const { adapter, hasEvent } = wire({
      im: { message: { create: async () => ({ code: 230020, msg: 'rate limited' }) } },
    })
    await expect(adapter.sendText('chat-1', 'hi')).rejects.toThrow(/230020/)
    expect(hasEvent('lark_send_failed')).toBe(true)
  })

  it('logs lark_send_ok and returns the message id on a successful send', async () => {
    const { adapter, hasEvent } = wire({
      im: {
        message: {
          create: async () => ({ code: 0, msg: 'success', data: { message_id: 'om_1' } }),
        },
      },
    })
    const sent = await adapter.sendText('chat-1', 'hi')
    expect(sent.messageId).toBe('om_1')
    expect(hasEvent('lark_send_ok')).toBe(true)
  })

  it('throws and logs lark_edit_failed when update resolves a business error code', async () => {
    const { adapter, hasEvent } = wire({
      im: { message: { update: async () => ({ code: 99992361, msg: 'edit expired' }) } },
    })
    await expect(adapter.editMessage('chat-1', 'om_1', 'new text')).rejects.toThrow(/99992361/)
    expect(hasEvent('lark_edit_failed')).toBe(true)
  })

  it('downloads resources via im.messageResource.get (not im.message.resource)', async () => {
    let calledWith: unknown
    const { adapter } = wire({
      im: {
        messageResource: {
          get: async (args: unknown) => {
            calledWith = args
            return { writeFile: async () => {} }
          },
        },
      },
    })
    const path = await (
      adapter as unknown as {
        downloadResource: (a: {
          messageId: string
          fileKey: string
          filename: string
          isImage: boolean
        }) => Promise<string | null>
      }
    ).downloadResource({ messageId: 'om_1', fileKey: 'fk', filename: 'x.png', isImage: true })

    expect(path).toBeTruthy()
    expect(calledWith).toMatchObject({
      path: { message_id: 'om_1', file_key: 'fk' },
      params: { type: 'image' },
    })
  })
})
