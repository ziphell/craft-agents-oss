/**
 * Website bridge validation: strict parsing of untrusted iframe messages,
 * URL gating, mutating-invocation classification, and the per-frame
 * rate limiter.
 */

import { describe, test, expect } from 'bun:test'
import {
  WEBSITE_BRIDGE_PROTOCOL,
  WebsiteActionRateLimiter,
  buildWebsiteActionResultMessage,
  buildWebsiteDataMessage,
  buildWebsiteGrantsMessage,
  buildWebsiteInitMessage,
  descriptorEquals,
  grantIdsEqual,
  isMutatingInvocation,
  isSafeExternalUrl,
  parseWebsiteBridgeMessage,
  reconcileGrantSummaries,
  type WebsiteGrantSummary,
} from '../website-bridge'

const validAction = {
  protocol: WEBSITE_BRIDGE_PROTOCOL,
  type: 'action',
  requestId: 'req-1',
  nonce: 'a'.repeat(32),
  grantId: 'grant_1',
  invocation: { kind: 'api', method: 'GET', path: '/gmail/v1/users/me/messages' },
}

describe('parseWebsiteBridgeMessage', () => {
  test('accepts a well-formed api action', () => {
    const msg = parseWebsiteBridgeMessage(validAction)
    expect(msg).toEqual({
      type: 'action',
      requestId: 'req-1',
      nonce: 'a'.repeat(32),
      grantId: 'grant_1',
      invocation: { kind: 'api', method: 'GET', path: '/gmail/v1/users/me/messages' },
    })
  })

  test('accepts a bare script action trigger', () => {
    const msg = parseWebsiteBridgeMessage({
      protocol: WEBSITE_BRIDGE_PROTOCOL,
      type: 'action',
      requestId: 'r',
      nonce: 'n',
      grantId: 'g',
      // A website cannot smuggle script/args here — the parser strips to a bare trigger.
      invocation: { kind: 'script', script: 'websites/evil/pwn.sh', args: ['--sudo'] },
    })
    expect(msg?.type).toBe('action')
    if (msg?.type === 'action') {
      expect(msg.invocation).toEqual({ kind: 'script' })
    }
  })

  test('accepts a well-formed mcp action with args', () => {
    const msg = parseWebsiteBridgeMessage({
      protocol: WEBSITE_BRIDGE_PROTOCOL,
      type: 'action',
      requestId: 'r',
      nonce: 'n',
      grantId: 'g',
      invocation: { kind: 'mcp', toolName: 'list_issues', args: { limit: 5 } },
    })
    expect(msg?.type).toBe('action')
    if (msg?.type === 'action') {
      expect(msg.invocation).toEqual({ kind: 'mcp', toolName: 'list_issues', args: { limit: 5 } })
    }
  })

  test('accepts ready / action-cancel / open-url', () => {
    expect(parseWebsiteBridgeMessage({ protocol: WEBSITE_BRIDGE_PROTOCOL, type: 'ready' })).toEqual({ type: 'ready' })
    expect(
      parseWebsiteBridgeMessage({ protocol: WEBSITE_BRIDGE_PROTOCOL, type: 'action-cancel', requestId: 'r', nonce: 'n' }),
    ).toEqual({ type: 'action-cancel', requestId: 'r', nonce: 'n' })
    expect(
      parseWebsiteBridgeMessage({ protocol: WEBSITE_BRIDGE_PROTOCOL, type: 'open-url', nonce: 'n', url: 'https://example.com' }),
    ).toEqual({ type: 'open-url', nonce: 'n', url: 'https://example.com' })
  })

  test('rejects wrong/missing protocol and unknown types', () => {
    expect(parseWebsiteBridgeMessage(null)).toBeNull()
    expect(parseWebsiteBridgeMessage('hi')).toBeNull()
    expect(parseWebsiteBridgeMessage({ type: 'ready' })).toBeNull()
    expect(parseWebsiteBridgeMessage({ protocol: 'craft-websites/v0', type: 'ready' })).toBeNull()
    expect(parseWebsiteBridgeMessage({ protocol: WEBSITE_BRIDGE_PROTOCOL, type: 'eval' })).toBeNull()
  })

  test('rejects malformed actions', () => {
    expect(parseWebsiteBridgeMessage({ ...validAction, requestId: '' })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...validAction, nonce: 42 })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...validAction, invocation: { kind: 'api', method: 'TRACE', path: '/x' } })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...validAction, invocation: { kind: 'api', method: 'GET', path: '' } })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...validAction, invocation: { kind: 'mcp' } })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...validAction, invocation: { kind: 'api', method: 'GET', path: '/x', params: [] } })).toBeNull()
  })

  test('rejects oversized and cyclic payloads', () => {
    expect(
      parseWebsiteBridgeMessage({
        ...validAction,
        invocation: { kind: 'api', method: 'GET', path: '/x', params: { blob: 'x'.repeat(300 * 1024) } },
      }),
    ).toBeNull()

    const cyclic: Record<string, unknown> = { protocol: WEBSITE_BRIDGE_PROTOCOL, type: 'ready' }
    cyclic.self = cyclic
    expect(parseWebsiteBridgeMessage(cyclic)).toBeNull()
  })

  test('rejects pathologically deep params', () => {
    let deep: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 20; i++) deep = { nested: deep }
    expect(
      parseWebsiteBridgeMessage({
        ...validAction,
        invocation: { kind: 'api', method: 'GET', path: '/x', params: deep },
      }),
    ).toBeNull()
  })
})

describe('parseWebsiteBridgeMessage: grant-request', () => {
  const mcpEntry = {
    key: 'read',
    description: 'Refresh the task list',
    action: { kind: 'mcp', sourceSlug: 'craft-private', toolName: 'craft_read' },
  }
  const apiEntry = {
    key: 'weather',
    action: { kind: 'api', sourceSlug: 'openweather', method: 'GET', pathPattern: '/data/2\\.5/weather.*' },
  }
  const valid = { protocol: WEBSITE_BRIDGE_PROTOCOL, type: 'grant-request', nonce: 'n', requests: [mcpEntry, apiEntry] }

  test('accepts well-formed mcp and api entries', () => {
    expect(parseWebsiteBridgeMessage(valid)).toEqual({
      type: 'grant-request',
      nonce: 'n',
      requests: [
        { key: 'read', description: 'Refresh the task list', action: { kind: 'mcp', sourceSlug: 'craft-private', toolName: 'craft_read' } },
        { key: 'weather', action: { kind: 'api', sourceSlug: 'openweather', method: 'GET', pathPattern: '/data/2\\.5/weather.*' } },
      ],
    })
  })

  test('rejects missing nonce, empty/oversized request lists, duplicate keys', () => {
    expect(parseWebsiteBridgeMessage({ ...valid, nonce: undefined })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...valid, requests: [] })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...valid, requests: 'nope' })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...valid, requests: Array.from({ length: 9 }, (_, i) => ({ ...mcpEntry, key: `k${i}` })) })).toBeNull()
    expect(parseWebsiteBridgeMessage({ ...valid, requests: [mcpEntry, mcpEntry] })).toBeNull()
  })

  test('rejects malformed descriptors', () => {
    const withAction = (action: unknown) => ({ ...valid, requests: [{ key: 'k', action }] })
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'mcp', toolName: 'craft_read' }))).toBeNull() // no sourceSlug
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'mcp', sourceSlug: 's' }))).toBeNull() // no toolName
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'api', sourceSlug: 's', method: 'FETCH', pathPattern: '/x' }))).toBeNull()
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'api', sourceSlug: 's', method: 'GET' }))).toBeNull() // no pathPattern
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'exec', sourceSlug: 's', command: 'rm -rf /' }))).toBeNull()
    expect(parseWebsiteBridgeMessage(withAction(null))).toBeNull()
  })

  test('accepts a well-formed script descriptor', () => {
    const withAction = (action: unknown) => ({ ...valid, requests: [{ key: 'k', action }] })
    const parsed = parseWebsiteBridgeMessage(
      withAction({ kind: 'script', script: 'websites/p/run.sh', runtime: 'bun', args: ['--once'] }),
    )
    expect(parsed).toEqual({
      type: 'grant-request',
      nonce: 'n',
      requests: [{ key: 'k', action: { kind: 'script', script: 'websites/p/run.sh', runtime: 'bun', args: ['--once'] } }],
    })
    // runtime + args are optional
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: 'websites/p/run.ts' }))).not.toBeNull()
  })

  test('rejects unsafe or malformed script descriptors', () => {
    const withAction = (action: unknown) => ({ ...valid, requests: [{ key: 'k', action }] })
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script' }))).toBeNull() // no script path
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: '/etc/passwd' }))).toBeNull() // absolute
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: '../escape.sh' }))).toBeNull() // .. escape
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: 'a/../../b.sh' }))).toBeNull() // .. mid-path
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: 'ok.sh', runtime: 'ruby' }))).toBeNull() // bad runtime
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: 'ok.sh', args: 'nope' }))).toBeNull() // args not array
    expect(parseWebsiteBridgeMessage(withAction({ kind: 'script', script: 'ok.sh', args: [1, 2] }))).toBeNull() // non-string args
    expect(
      parseWebsiteBridgeMessage(withAction({ kind: 'script', script: 'ok.sh', args: Array.from({ length: 33 }, () => 'x') })),
    ).toBeNull() // too many args
  })

  test('rejects oversized descriptions', () => {
    expect(
      parseWebsiteBridgeMessage({ ...valid, requests: [{ ...mcpEntry, description: 'x'.repeat(501) }] }),
    ).toBeNull()
  })
})

describe('descriptorEquals', () => {
  test('matches on all fields per kind, never across kinds', () => {
    const mcp = { kind: 'mcp' as const, sourceSlug: 's', toolName: 't' }
    expect(descriptorEquals(mcp, { ...mcp })).toBe(true)
    expect(descriptorEquals(mcp, { ...mcp, toolName: 'other' })).toBe(false)
    expect(descriptorEquals(mcp, { ...mcp, sourceSlug: 'other' })).toBe(false)
    const api = { kind: 'api' as const, sourceSlug: 's', method: 'GET' as const, pathPattern: '/x' }
    expect(descriptorEquals(api, { ...api })).toBe(true)
    expect(descriptorEquals(api, { ...api, method: 'POST' })).toBe(false)
    expect(descriptorEquals(api, { ...api, pathPattern: '/y' })).toBe(false)
    expect(descriptorEquals(mcp, api)).toBe(false)
  })

  test('script matches on path, runtime (bun default), and ordered args', () => {
    const script = { kind: 'script' as const, script: 'websites/p/run.sh', runtime: 'bun' as const, args: ['a', 'b'] }
    expect(descriptorEquals(script, { ...script })).toBe(true)
    // omitted runtime defaults to bun
    expect(descriptorEquals({ kind: 'script', script: 'websites/p/run.sh', args: ['a', 'b'] }, script)).toBe(true)
    expect(descriptorEquals(script, { ...script, script: 'websites/p/other.sh' })).toBe(false)
    expect(descriptorEquals(script, { ...script, runtime: 'node' })).toBe(false)
    expect(descriptorEquals(script, { ...script, args: ['b', 'a'] })).toBe(false)
    expect(descriptorEquals(script, { ...script, args: ['a'] })).toBe(false)
  })
})

describe('isSafeExternalUrl', () => {
  test('allows only http(s)', () => {
    expect(isSafeExternalUrl('https://example.com/a?b=c')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('craftagents://action/new-chat')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})

describe('isMutatingInvocation', () => {
  test('api GET is the only activation-exempt invocation', () => {
    expect(isMutatingInvocation({ kind: 'api', method: 'POST', path: '/x' })).toBe(true)
    expect(isMutatingInvocation({ kind: 'api', method: 'DELETE', path: '/x' })).toBe(true)
    expect(isMutatingInvocation({ kind: 'api', method: 'GET', path: '/x' })).toBe(false)
  })

  test('mcp always mutates (opaque tools — no method to infer read vs write)', () => {
    // A granted MCP tool may write ("create issue"); without user activation a
    // website could fire it from setInterval or on load. Never exempt it.
    expect(isMutatingInvocation({ kind: 'mcp', toolName: 't' })).toBe(true)
    expect(isMutatingInvocation({ kind: 'mcp', toolName: 'list_issues' })).toBe(true)
  })

  test('script always mutates (host command execution needs a fresh gesture)', () => {
    expect(isMutatingInvocation({ kind: 'script' })).toBe(true)
  })
})

describe('outgoing message builders', () => {
  test('stamp the protocol and wrap payloads', () => {
    const snapshot = { version: 1 as const, generatedAt: 1, kv: {}, series: {} }
    expect(buildWebsiteInitMessage({ slug: 's', kind: 'live' }, 'nonce', snapshot)).toEqual({
      protocol: WEBSITE_BRIDGE_PROTOCOL,
      type: 'init',
      payload: { website: { slug: 's', kind: 'live' }, nonce: 'nonce', snapshot, grants: [] },
    })
    expect(buildWebsiteDataMessage(null)).toEqual({
      protocol: WEBSITE_BRIDGE_PROTOCOL,
      type: 'data',
      payload: { snapshot: null },
    })
    const result = { requestId: 'r', ok: true, durationMs: 5 }
    expect(buildWebsiteActionResultMessage(result)).toEqual({
      protocol: WEBSITE_BRIDGE_PROTOCOL,
      type: 'action-result',
      payload: { result },
    })
  })

  test('init and grants messages carry grant summaries', () => {
    const grants = [
      { id: 'grant_1', action: { kind: 'mcp' as const, sourceSlug: 's', toolName: 't' }, expiresAt: 99 },
    ]
    const init = buildWebsiteInitMessage({ slug: 's', kind: 'live' }, 'n', null, grants)
    expect((init.payload as { grants: unknown }).grants).toEqual(grants)
    expect(buildWebsiteGrantsMessage(grants)).toEqual({
      protocol: WEBSITE_BRIDGE_PROTOCOL,
      type: 'grants',
      payload: { grants },
    })
  })
})

describe('WebsiteActionRateLimiter', () => {
  test('caps concurrent requests', () => {
    const limiter = new WebsiteActionRateLimiter(2, 1, 100)
    expect(limiter.canStart(0, false)).toBeNull()
    limiter.start('a', 0, false)
    limiter.start('b', 0, false)
    expect(limiter.canStart(0, false)).toBe('in-flight-limit')
    limiter.finish('a')
    expect(limiter.canStart(0, false)).toBeNull()
  })

  test('caps mutating requests to one in flight', () => {
    const limiter = new WebsiteActionRateLimiter(5, 1, 100)
    limiter.start('m1', 0, true)
    expect(limiter.canStart(0, true)).toBe('in-flight-limit')
    expect(limiter.canStart(0, false)).toBeNull()
    limiter.finish('m1')
    expect(limiter.canStart(0, true)).toBeNull()
  })

  test('enforces a sliding one-minute window', () => {
    const limiter = new WebsiteActionRateLimiter(100, 100, 3)
    for (let i = 0; i < 3; i++) {
      expect(limiter.canStart(i, false)).toBeNull()
      limiter.start(`r${i}`, i, false)
      limiter.finish(`r${i}`)
    }
    expect(limiter.canStart(10, false)).toBe('rate-limit')
    // Window slides: the earliest start falls out after 60s
    expect(limiter.canStart(60_001, false)).toBeNull()
  })

  test('exposes in-flight ids for unmount cancellation', () => {
    const limiter = new WebsiteActionRateLimiter()
    limiter.start('a', 0, false)
    limiter.start('b', 0, true)
    expect(limiter.inFlightIds.sort()).toEqual(['a', 'b'])
  })
})

describe('reconcileGrantSummaries', () => {
  const summary = (id: string): WebsiteGrantSummary => ({
    id,
    action: { kind: 'mcp', sourceSlug: 'slack', toolName: `tool_${id}` },
    expiresAt: 9999,
  })

  test('config additions appear, revocations disappear', () => {
    const current = [summary('g1'), summary('g2')]
    // g2 revoked, g3 issued elsewhere
    const next = reconcileGrantSummaries(current, [summary('g1'), summary('g3')], new Set())
    expect(next.map(g => g.id).sort()).toEqual(['g1', 'g3'])
  })

  test('an in-render approval survives until the config confirms it', () => {
    const issued = new Set(['g2'])
    const current = [summary('g1'), summary('g2')]

    // Watcher lag: config doesn't know g2 yet — keep it.
    const lagged = reconcileGrantSummaries(current, [summary('g1')], issued)
    expect(lagged.map(g => g.id).sort()).toEqual(['g1', 'g2'])
    expect(issued.has('g2')).toBe(true)

    // Config catches up: g2 confirmed, local tracking released.
    const confirmed = reconcileGrantSummaries(lagged, [summary('g1'), summary('g2')], issued)
    expect(confirmed.map(g => g.id).sort()).toEqual(['g1', 'g2'])
    expect(issued.has('g2')).toBe(false)

    // A later revoke of g2 now propagates like any other removal.
    const revoked = reconcileGrantSummaries(confirmed, [summary('g1')], issued)
    expect(revoked.map(g => g.id)).toEqual(['g1'])
  })

  test('grantIdsEqual is order-insensitive set equality', () => {
    expect(grantIdsEqual([summary('a'), summary('b')], [summary('b'), summary('a')])).toBe(true)
    expect(grantIdsEqual([summary('a')], [summary('a'), summary('b')])).toBe(false)
    expect(grantIdsEqual([summary('a')], [summary('b')])).toBe(false)
    expect(grantIdsEqual([], [])).toBe(true)
  })
})
