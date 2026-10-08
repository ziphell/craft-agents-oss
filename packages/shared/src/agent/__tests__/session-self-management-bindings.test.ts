import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import { createClaudeContext } from '../claude-context.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import type {
  SessionToolContext,
  SessionInfo,
  DesignsToolCallbacks,
  DesignToolSummary,
  DesignToolDetails,
} from '@craft-agent/session-tools-core';
import { SESSION_TOOL_REGISTRY } from '@craft-agent/session-tools-core';

// Minimal noop callbacks for createClaudeContext
const noopPlan = () => {};
const noopAuth = () => {};

/** Helper to create a valid SessionInfo fixture */
function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'test-session',
    name: 'Test Session',
    labels: [],
    status: 'active',
    permissionMode: 'execute',
    createdAt: Date.now(),
    isActive: true,
    ...overrides,
  };
}

function createBaseContext(sessionId: string): SessionToolContext {
  return createClaudeContext({
    sessionId,
    workspacePath: '/tmp/test-workspace',
    workspaceId: 'test-ws',
    onPlanSubmitted: noopPlan,
    onAuthRequest: noopAuth,
  });
}

// ============================================================
// Phase 1 — Regression test: Pi path must support session tools
// ============================================================

describe('Pi session self-management regression (#511)', () => {
  const sessionId = 'test-pi-regression-511';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('context WITHOUT bindings has undefined session management properties', () => {
    const ctx = createBaseContext(sessionId);
    // This is the bug: PiAgent creates context without session management
    expect(ctx.setSessionLabels).toBeUndefined();
    expect(ctx.setSessionStatus).toBeUndefined();
    expect(ctx.getSessionInfo).toBeUndefined();
    expect(ctx.listSessions).toBeUndefined();
    expect(ctx.resolveLabels).toBeUndefined();
    expect(ctx.resolveStatus).toBeUndefined();
  });

  it('context WITH bindings resolves callbacks from registry', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Register callbacks in the registry (simulates SessionManager)
    const setLabelsCalled: Array<[string | undefined, string[]]> = [];
    const setStatusCalled: Array<[string | undefined, string]> = [];

    registerSessionScopedToolCallbacks(sessionId, {
      setSessionLabelsFn: (sid, labels) => { setLabelsCalled.push([sid, labels]); },
      setSessionStatusFn: (sid, status) => { setStatusCalled.push([sid, status]); },
      getSessionInfoFn: (sid) => makeSessionInfo({ id: sid ?? sessionId }),
      listSessionsFn: () => ({ total: 1, returned: 1, sessions: [] }),
      resolveLabelsFn: (labels) => ({ resolved: labels, unknown: [], available: labels }),
      resolveStatusFn: (status) => ({ resolved: status, available: ['active', 'done'] }),
    });

    // All 6 properties should now be defined
    expect(ctx.setSessionLabels).toBeDefined();
    expect(ctx.setSessionStatus).toBeDefined();
    expect(ctx.getSessionInfo).toBeDefined();
    expect(ctx.listSessions).toBeDefined();
    expect(ctx.resolveLabels).toBeDefined();
    expect(ctx.resolveStatus).toBeDefined();

    // Verify they actually work
    await ctx.setSessionLabels!(undefined, ['bug', 'urgent']);
    expect(setLabelsCalled).toEqual([[undefined, ['bug', 'urgent']]]);

    await ctx.setSessionStatus!(undefined, 'done');
    expect(setStatusCalled).toEqual([[undefined, 'done']]);

    const info = ctx.getSessionInfo!();
    expect(info).toBeTruthy();
    expect(info!.id).toBe(sessionId);

    const list = ctx.listSessions!();
    expect(list.total).toBe(1);

    const resolved = ctx.resolveLabels!(['bug']);
    expect(resolved.resolved).toEqual(['bug']);

    const statusResolved = ctx.resolveStatus!('active');
    expect(statusResolved.resolved).toBe('active');
  });
});

// ============================================================
// Phase 2 — Binding helper unit tests
// ============================================================

describe('attachSessionSelfManagementBindings', () => {
  const sessionId = 'test-bindings-unit';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('absent callback → property is undefined for all 6 fields', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // No callbacks registered — all should resolve to undefined
    expect(ctx.setSessionLabels).toBeUndefined();
    expect(ctx.setSessionStatus).toBeUndefined();
    expect(ctx.getSessionInfo).toBeUndefined();
    expect(ctx.listSessions).toBeUndefined();
    expect(ctx.resolveLabels).toBeUndefined();
    expect(ctx.resolveStatus).toBeUndefined();
  });

  it('late merge becomes visible without recreating the context', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Initially no callbacks
    expect(ctx.setSessionLabels).toBeUndefined();

    // Late merge — simulates SessionManager registering after agent start
    registerSessionScopedToolCallbacks(sessionId, {
      setSessionLabelsFn: () => {},
    });

    // Should now be defined without recreating ctx
    expect(ctx.setSessionLabels).toBeDefined();
  });

  it('callback replacement is visible without recreating the context', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    const callsA: string[] = [];
    const callsB: string[] = [];

    // Register callback A
    registerSessionScopedToolCallbacks(sessionId, {
      setSessionStatusFn: (_, status) => { callsA.push(status); },
    });

    ctx.setSessionStatus!(undefined, 'from-A');
    expect(callsA).toEqual(['from-A']);

    // Replace with callback B via merge (full overwrite)
    mergeSessionScopedToolCallbacks(sessionId, {
      setSessionStatusFn: (_, status) => { callsB.push(status); },
    });

    ctx.setSessionStatus!(undefined, 'from-B');
    expect(callsA).toEqual(['from-A']); // A not called again
    expect(callsB).toEqual(['from-B']); // B was called
  });

  it('getSessionInfo defaults to current session ID when called without arg', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    let receivedId: string | undefined;
    registerSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: (sid) => {
        receivedId = sid;
        return makeSessionInfo({ id: sid ?? sessionId });
      },
    });

    // Call without arg — should default to sessionId
    ctx.getSessionInfo!();
    expect(receivedId).toBe(sessionId);

    // Call with explicit arg — should pass through
    ctx.getSessionInfo!('other-session');
    expect(receivedId).toBe('other-session');
  });

  it('setters pass through explicit session IDs unchanged', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    let receivedSid: string | undefined;
    registerSessionScopedToolCallbacks(sessionId, {
      setSessionLabelsFn: (sid) => { receivedSid = sid; },
    });

    await ctx.setSessionLabels!('explicit-session-123', ['test']);
    expect(receivedSid).toBe('explicit-session-123');

    await ctx.setSessionLabels!(undefined, ['test']);
    expect(receivedSid).toBeUndefined();
  });

  it('no identity fallback — resolveLabels returns undefined when no callback', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // No callbacks registered — resolveLabels should be undefined, not an identity function
    expect(ctx.resolveLabels).toBeUndefined();
  });
});

// ============================================================
// Phase 3 — Parity: Claude and Pi paths expose same bindings
// ============================================================

describe('Claude/Pi session self-management parity', () => {
  const sessionId = 'test-parity';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('both paths expose the same 6 bound properties when callbacks are registered', () => {
    const SELF_MGMT_PROPERTIES = [
      'setSessionLabels',
      'setSessionStatus',
      'getSessionInfo',
      'listSessions',
      'resolveLabels',
      'resolveStatus',
    ] as const;

    registerSessionScopedToolCallbacks(sessionId, {
      setSessionLabelsFn: () => {},
      setSessionStatusFn: () => {},
      getSessionInfoFn: () => makeSessionInfo({ id: sessionId }),
      listSessionsFn: () => ({ total: 0, returned: 0, sessions: [] }),
      resolveLabelsFn: (l) => ({ resolved: l, unknown: [], available: l }),
      resolveStatusFn: (s) => ({ resolved: s, available: [] }),
    });

    // Simulate Pi path: createClaudeContext + attachBindings
    const piCtx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(piCtx, sessionId);

    // Simulate Claude path: same thing after refactor
    const claudeCtx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(claudeCtx, sessionId);

    for (const prop of SELF_MGMT_PROPERTIES) {
      expect(piCtx[prop]).toBeDefined();
      expect(claudeCtx[prop]).toBeDefined();
      // Both should be functions
      expect(typeof piCtx[prop]).toBe('function');
      expect(typeof claudeCtx[prop]).toBe('function');
    }
  });

  it('absent callbacks → handlers return exact "not available" error messages', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);
    // No callbacks registered — use the canonical registry to invoke handlers (same as runtime)

    const labelsHandler = SESSION_TOOL_REGISTRY.get('set_session_labels')!.handler!;
    const labelsResult = await labelsHandler(ctx, { labels: ['test'] });
    expect(labelsResult.isError).toBe(true);
    expect(labelsResult.content[0]!.text).toContain('not available in this context');

    const statusHandler = SESSION_TOOL_REGISTRY.get('set_session_status')!.handler!;
    const statusResult = await statusHandler(ctx, { status: 'done' });
    expect(statusResult.isError).toBe(true);
    expect(statusResult.content[0]!.text).toContain('not available in this context');

    const infoHandler = SESSION_TOOL_REGISTRY.get('get_session_info')!.handler!;
    const infoResult = await infoHandler(ctx, {});
    expect(infoResult.isError).toBe(true);
    expect(infoResult.content[0]!.text).toContain('not available in this context');

    const listHandler = SESSION_TOOL_REGISTRY.get('list_sessions')!.handler!;
    const listResult = await listHandler(ctx, {});
    expect(listResult.isError).toBe(true);
    expect(listResult.content[0]!.text).toContain('not available in this context');
  });
});

// ============================================================
// Phase 4 — Designs: the six design tools are advertised to every session,
// so the grouped callbacks behind them must be bound like every other
// session-scoped group. Regression: they were wired in SessionManager and left
// out of this helper, so all six answered
// "Designs tools are not available in this context."
// ============================================================

describe('designs tools binding', () => {
  const sessionId = 'test-designs-binding';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  const SUMMARY: DesignToolSummary = {
    slug: 'build-health',
    kind: 'prototype',
    name: 'Build Health',
    createdAt: 1,
    updatedAt: 2,
    hasContent: true,
    shared: false,
    folderPath: '/ws/designs/build-health',
  };

  const DETAILS: DesignToolDetails = {
    ...SUMMARY,
    id: 'design_1a2b3c4d',
    contentDigest: 'abc',
    contentLength: 128,
    contentPath: '/ws/designs/build-health/index.html',
    data: null,
    grants: [],
  };

  function designsCallbacks(): DesignsToolCallbacks {
    return {
      listDesigns: () => [SUMMARY],
      getDesign: (slug) => (slug === SUMMARY.slug ? DETAILS : null),
      createDesign: async () => DETAILS,
      updateDesign: async () => DETAILS,
      writeDesignData: async (slug) => ({
        slug,
        kvCount: 1,
        seriesCount: 0,
        generatedAt: 3,
        snapshotPath: `/ws/designs/${slug}/data/snapshot.json`,
        durationMs: 1,
      }),
      deleteDesign: async () => ({ deleted: true, publicCopyMayRemain: false }),
    };
  }

  it('every design tool reaches its registry callbacks, with no tool left unbound', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Without callbacks the degrade path still stands (unchanged behaviour).
    expect(ctx.designs).toBeUndefined();

    const designs = designsCallbacks();
    registerSessionScopedToolCallbacks(sessionId, { designs });

    // Resolved fresh from the registry, not captured at attach time.
    expect(ctx.designs).toBe(designs);

    const invocations: Array<[string, Record<string, unknown>]> = [
      ['list_designs', {}],
      ['get_design', { slug: SUMMARY.slug }],
      ['create_design', { name: 'Build Health' }],
      ['update_design', { slug: SUMMARY.slug, name: 'Renamed' }],
      ['write_design_data', { slug: SUMMARY.slug, set: { total: 1 } }],
      ['delete_design', { slug: SUMMARY.slug }],
    ];

    for (const [name, args] of invocations) {
      const handler = SESSION_TOOL_REGISTRY.get(name)!.handler!;
      const result = await handler(ctx, args);
      expect(`${name}: ${result.content[0]!.text}`).not.toContain('not available in this context');
      expect(result.isError).toBe(false);
    }
  });

  it('reports \"not available\" for a design tool when no callbacks are registered', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    const handler = SESSION_TOOL_REGISTRY.get('list_designs')!.handler!;
    const result = await handler(ctx, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not available in this context');
  });
});
