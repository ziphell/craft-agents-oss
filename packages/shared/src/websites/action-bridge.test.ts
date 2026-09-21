/**
 * Tests for the WebsiteActionBroker — lease/nonce/replay checks, grant
 * validation (digest + expiry + descriptor matching), execution via
 * injected executors, cancellation, and the audit trail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebsiteActionGrant, WebsiteActionRequest, WebsiteConfig, WebsiteRenderLease } from '@craft-agent/core';
import {
  MAX_LIVE_LEASES,
  WEBSITE_ACTION_MAX_IN_FLIGHT_PER_LEASE,
  WEBSITE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE,
  WebsiteActionBroker,
  type WebsiteActionExecutors,
} from './action-bridge.ts';

const DIGEST_V1 = 'a'.repeat(64);
const DIGEST_V2 = 'b'.repeat(64);

describe('websites/action-bridge', () => {
  let tempDir: string;
  let auditPath: string;
  let clock: { now: number };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'website-action-bridge-test-'));
    auditPath = join(tempDir, 'website-actions.jsonl');
    clock = { now: 1_000_000 };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeBroker(executors: WebsiteActionExecutors = {}) {
    return new WebsiteActionBroker({
      executors,
      auditLogPath: auditPath,
      now: () => clock.now,
    });
  }

  function makeGrant(overrides: Partial<WebsiteActionGrant> = {}): WebsiteActionGrant {
    return {
      id: 'grant_test0001',
      action: { kind: 'api', sourceSlug: 'github', method: 'GET', pathPattern: '/repos/.*' },
      contentDigest: DIGEST_V1,
      createdAt: clock.now,
      expiresAt: clock.now + 60_000,
      ...overrides,
    };
  }

  function makeWebsite(overrides: Partial<WebsiteConfig> = {}): WebsiteConfig {
    return {
      schemaVersion: 1,
      id: 'website_test0001',
      slug: 'dash',
      name: 'Dash',
      kind: 'interactive',
      createdAt: 1,
      updatedAt: 1,
      contentDigest: DIGEST_V1,
      grants: [makeGrant()],
      ...overrides,
    };
  }

  function makeRequest(lease: WebsiteRenderLease, overrides: Partial<WebsiteActionRequest> = {}): WebsiteActionRequest {
    return {
      requestId: `req_${Math.random().toString(36).slice(2)}`,
      websiteSlug: 'dash',
      leaseId: lease.leaseId,
      nonce: lease.nonce,
      grantId: 'grant_test0001',
      invocation: { kind: 'api', method: 'GET', path: '/repos/craft/agents' },
      ...overrides,
    };
  }

  async function readAudit(): Promise<Array<Record<string, unknown>>> {
    // Audit writes are fire-and-forget; give the microtask queue a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  describe('happy path', () => {
    it('executes a granted api action through the injected executor', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation, { signal }) => {
          calls.push({ invocation, aborted: signal.aborted });
          return { status: 200, ok: true, body: { repos: 3 } };
        },
      });

      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makeWebsite(), makeRequest(lease));

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ repos: 3 });
      expect(calls).toHaveLength(1);
      expect((calls[0] as { invocation: { sourceSlug: string } }).invocation.sourceSlug).toBe('github');

      const audit = await readAudit();
      const executed = audit.find((e) => e.event === 'website_action_executed');
      expect(executed?.ok).toBe(true);
      expect(executed?.policyDecision).toBe('allow');
      expect((executed?.invocation as { path: string }).path).toBe('/repos/craft/agents');
    });
  });

  describe('api path traversal (grant path canonicalization)', () => {
    it('rejects a `..` path before the match and never runs the executor', async () => {
      const calls: unknown[] = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation); return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      // Grant is GET /repos/.* — this matches the anchored pattern raw, but fetch
      // would normalize it to /admin with the real credential.
      const literal = await broker.executeAction(makeWebsite(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/../../admin' },
      }));
      expect(literal.ok).toBe(false);
      expect(literal.error).toContain('invocation-path-unsafe');

      // Percent-encoded form (%2e%2e) is decoded and caught too.
      const encoded = await broker.executeAction(makeWebsite(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/%2e%2e/admin' },
      }));
      expect(encoded.ok).toBe(false);
      expect(encoded.error).toContain('invocation-path-unsafe');

      expect(calls).toHaveLength(0);
    });

    it('still allows a legitimate nested path under the grant', async () => {
      const calls: Array<{ path: string }> = [];
      const broker = makeBroker({
        executeApi: async (invocation) => { calls.push(invocation as { path: string }); return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const ok = await broker.executeAction(makeWebsite(), makeRequest(lease, {
        invocation: { kind: 'api', method: 'GET', path: '/repos/craft/agents' },
      }));
      expect(ok.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe('/repos/craft/agents');
    });
  });

  describe('lease + replay validation', () => {
    it('rejects unknown leases, wrong nonces, and cross-website leases', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      const noLease = await broker.executeAction(makeWebsite(), makeRequest(lease, { leaseId: 'nope' }));
      expect(noLease.ok).toBe(false);
      expect(noLease.error).toContain('lease-not-found');

      const badNonce = await broker.executeAction(makeWebsite(), makeRequest(lease, { nonce: 'wrong' }));
      expect(badNonce.ok).toBe(false);
      expect(badNonce.error).toContain('nonce-mismatch');

      const otherWebsite = await broker.executeAction(
        makeWebsite({ slug: 'other' }),
        makeRequest(lease, { websiteSlug: 'other' }),
      );
      expect(otherWebsite.ok).toBe(false);
      expect(otherWebsite.error).toContain('lease-website-mismatch');
    });

    it('rejects expired leases', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      clock.now += 13 * 60 * 60 * 1000; // past the 12h default TTL
      const result = await broker.executeAction(makeWebsite(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('lease-expired');
    });

    it('rejects replayed request ids on the same lease', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);

      const first = await broker.executeAction(makeWebsite(), request);
      expect(first.ok).toBe(true);

      const replay = await broker.executeAction(makeWebsite(), request);
      expect(replay.ok).toBe(false);
      expect(replay.error).toContain('replay');
    });

    it('rejects actions after the website content changed under the lease', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      const result = await broker.executeAction(
        makeWebsite({ contentDigest: DIGEST_V2 }),
        makeRequest(lease),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('content-changed');
    });

    it('releasing a lease invalidates it', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      broker.releaseLease(lease.leaseId);

      const result = await broker.executeAction(makeWebsite(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('lease-not-found');
    });
  });

  describe('grant validation', () => {
    async function expectRejection(website: WebsiteConfig, requestPatch: Partial<WebsiteActionRequest>, code: string) {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: website.contentDigest! });
      const result = await broker.executeAction(website, makeRequest(lease, requestPatch));
      expect(result.ok).toBe(false);
      expect(result.error).toContain(code);
    }

    it('rejects unknown grants', async () => {
      await expectRejection(makeWebsite(), { grantId: 'grant_missing' }, 'grant-not-found');
    });

    it('rejects grants bound to older content (stale)', async () => {
      const website = makeWebsite({
        contentDigest: DIGEST_V2,
        grants: [makeGrant()], // grant still bound to v1
      });
      await expectRejection(website, {}, 'grant-stale');
    });

    it('rejects expired grants', async () => {
      const website = makeWebsite({ grants: [makeGrant({ expiresAt: clock.now - 1 })] });
      await expectRejection(website, {}, 'grant-expired');
    });

    it('rejects method and kind mismatches', async () => {
      await expectRejection(
        makeWebsite(),
        { invocation: { kind: 'api', method: 'POST', path: '/repos/x' } },
        'grant-mismatch',
      );
      await expectRejection(
        makeWebsite(),
        { invocation: { kind: 'mcp', toolName: 'create_issue' } },
        'grant-mismatch',
      );
    });

    it('anchors the path pattern (no substring matches)', async () => {
      await expectRejection(
        makeWebsite(),
        { invocation: { kind: 'api', method: 'GET', path: '/evil/prefix/repos/x' } },
        'grant-mismatch',
      );
      // Normalization: leading slash optional in requests
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const ok = await broker.executeAction(
        makeWebsite(),
        makeRequest(lease, { invocation: { kind: 'api', method: 'GET', path: 'repos/x' } }),
      );
      expect(ok.ok).toBe(true);
    });

    it('rejects mcp tool-name mismatches and honors mcp grants', async () => {
      const mcpGrant = makeGrant({
        id: 'grant_mcp00001',
        action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
      });
      const website = makeWebsite({ grants: [mcpGrant] });

      const broker = makeBroker({
        executeMcp: async (invocation) => ({ echoed: invocation.toolName }),
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      const wrongTool = await broker.executeAction(
        website,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'delete_issue' } }),
      );
      expect(wrongTool.ok).toBe(false);
      expect(wrongTool.error).toContain('grant-mismatch');

      const ok = await broker.executeAction(
        website,
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'create_issue', args: { title: 'x' } } }),
      );
      expect(ok.ok).toBe(true);
      expect(ok.body).toEqual({ echoed: 'create_issue' });
    });
  });

  describe('execution edges', () => {
    it('returns a structured error when the executor is not wired', async () => {
      const mcpGrant = makeGrant({
        id: 'grant_mcp00001',
        action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' },
      });
      const broker = makeBroker({}); // no executors
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(
        makeWebsite({ grants: [mcpGrant] }),
        makeRequest(lease, { grantId: 'grant_mcp00001', invocation: { kind: 'mcp', toolName: 'create_issue' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('executor-unavailable');
    });

    it('folds executor throws into failed results', async () => {
      const broker = makeBroker({
        executeApi: async () => {
          throw new Error('connection reset');
        },
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makeWebsite(), makeRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toBe('connection reset');
    });

    it('cancelAction aborts an in-flight request', async () => {
      const broker = makeBroker({
        executeApi: (_invocation, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const request = makeRequest(lease);

      const pending = broker.executeAction(makeWebsite(), request);
      // Give the broker a tick to register the in-flight controller
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(broker.cancelAction(request.requestId)).toBe(true);

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Cancelled');
      expect(broker.cancelAction(request.requestId)).toBe(false);
    });
  });

  describe('script actions', () => {
    const scriptGrant = () =>
      makeGrant({
        id: 'grant_script001',
        action: { kind: 'script', script: 'websites/dash/run.sh', runtime: 'bun', args: ['--once'] },
      });
    const scriptRequest = (lease: WebsiteRenderLease) =>
      makeRequest(lease, { grantId: 'grant_script001', invocation: { kind: 'script' } });

    it('runs the grant-pinned script and returns stdout/stderr/exit on success', async () => {
      const seen: unknown[] = [];
      const broker = makeBroker({
        executeScript: async (invocation) => {
          seen.push(invocation);
          return { exitCode: 0, stdout: 'hello', stderr: '' };
        },
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makeWebsite({ grants: [scriptGrant()] }), scriptRequest(lease));

      expect(result.ok).toBe(true);
      expect(result.body).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' });
      // The executor receives the grant's pinned script/runtime/args, never website input.
      expect(seen[0]).toEqual({ websiteSlug: 'dash', script: 'websites/dash/run.sh', runtime: 'bun', args: ['--once'] });

      const audit = await readAudit();
      const executed = audit.find((e) => e.event === 'website_action_executed');
      expect(executed?.ok).toBe(true);
      expect((executed?.invocation as { kind: string }).kind).toBe('script');
    });

    it('reports ok:false but still surfaces output on a non-zero exit', async () => {
      const broker = makeBroker({
        executeScript: async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }),
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makeWebsite({ grants: [scriptGrant()] }), scriptRequest(lease));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('code 2');
      expect(result.body).toEqual({ exitCode: 2, stdout: '', stderr: 'boom' });
    });

    it('returns executor-unavailable when no script executor is wired', async () => {
      const broker = makeBroker({}); // no executors
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makeWebsite({ grants: [scriptGrant()] }), scriptRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('executor-unavailable');
    });

    it('folds a blocked/throwing executor into a failed result', async () => {
      const broker = makeBroker({
        executeScript: async () => {
          throw new Error('Script path escapes the workspace');
        },
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const result = await broker.executeAction(makeWebsite({ grants: [scriptGrant()] }), scriptRequest(lease));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('escapes the workspace');
    });
  });

  describe('audit trail', () => {
    it('records rejections with codes and redacts sensitive params', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      await broker.executeAction(
        makeWebsite(),
        makeRequest(lease, {
          nonce: 'wrong',
          invocation: { kind: 'api', method: 'GET', path: '/repos/x', params: { apiToken: 'sk-super-secret', website: 2 } },
        }),
      );

      const audit = await readAudit();
      const rejected = audit.find((e) => e.event === 'website_action_rejected');
      expect(rejected?.code).toBe('nonce-mismatch');
      const params = (rejected?.invocation as { params: Record<string, unknown> }).params;
      expect(params.apiToken).toBe('[REDACTED]');
      expect(params.website).toBe(2);
    });
  });

  describe('host-side per-lease rate limiting', () => {
    it('caps in-flight actions per lease, audits the rejection, and frees slots on completion', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const broker = makeBroker({
        executeApi: async () => { await gate; return { status: 200, ok: true, body: null }; },
      });
      const lease = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      const website = makeWebsite();

      // Fill every in-flight slot (calls run to the executor await synchronously).
      const inFlight = Array.from({ length: WEBSITE_ACTION_MAX_IN_FLIGHT_PER_LEASE }, () =>
        broker.executeAction(website, makeRequest(lease)),
      );
      const overflowRequest = makeRequest(lease);
      const overflow = await broker.executeAction(website, overflowRequest);
      expect(overflow.ok).toBe(false);
      expect(overflow.error).toContain('rate-limited');

      // The rejection is part of the audit contract, same as validation rejections.
      const audit = await readAudit();
      const rejected = audit.find(
        (e) => e.event === 'website_action_rejected' && e.requestId === overflowRequest.requestId,
      );
      expect(rejected?.code).toBe('rate-limited');

      release();
      const settled = await Promise.all(inFlight);
      expect(settled.every((r) => r.ok)).toBe(true);

      // Slots freed → the same lease accepts actions again.
      const after = await broker.executeAction(website, makeRequest(lease));
      expect(after.ok).toBe(true);
    });

    it('caps starts per sliding minute, refills after the window, and isolates leases', async () => {
      const broker = makeBroker({
        executeApi: async () => ({ status: 200, ok: true, body: null }),
      });
      // Long-lived grant: the test advances the clock past the default 60s expiry.
      const grant = makeGrant({ expiresAt: clock.now + 3_600_000 });
      const website = makeWebsite({ grants: [grant] });
      const leaseA = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });

      for (let i = 0; i < WEBSITE_ACTION_MAX_STARTS_PER_MINUTE_PER_LEASE; i++) {
        expect((await broker.executeAction(website, makeRequest(leaseA))).ok).toBe(true);
      }
      const throttled = await broker.executeAction(website, makeRequest(leaseA));
      expect(throttled.ok).toBe(false);
      expect(throttled.error).toContain('rate-limited');

      // A different render (lease) has its own budget.
      const leaseB = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      expect((await broker.executeAction(website, makeRequest(leaseB))).ok).toBe(true);

      // The window slides: a minute later the first lease works again.
      clock.now += 61_000;
      expect((await broker.executeAction(website, makeRequest(leaseA))).ok).toBe(true);
    });
  });

  describe('lease store cap', () => {
    it('evicts the oldest lease past MAX_LIVE_LEASES (audited) and keeps new mounts working', async () => {
      const broker = makeBroker({ executeApi: async () => ({ status: 200, ok: true, body: null }) });
      const website = makeWebsite();

      const first = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      for (let i = 1; i < MAX_LIVE_LEASES; i++) {
        clock.now += 1; // strictly increasing issuedAt → deterministic oldest
        broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      }
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);

      clock.now += 1;
      const newest = broker.createLease({ websiteSlug: 'dash', contentDigest: DIGEST_V1 });
      expect(broker.leaseCount).toBe(MAX_LIVE_LEASES);

      // The oldest render lost its lease (a re-mount recovers)…
      const evicted = await broker.executeAction(website, makeRequest(first));
      expect(evicted.ok).toBe(false);
      expect(evicted.error).toContain('lease-not-found');

      // …the newest works, and the eviction is on the audit trail.
      expect((await broker.executeAction(website, makeRequest(newest))).ok).toBe(true);
      const audit = await readAudit();
      const eviction = audit.find((e) => e.event === 'website_lease_evicted');
      expect(eviction?.leaseId).toBe(first.leaseId);
      expect(eviction?.reason).toBe('lease-store-full');
    });
  });
});
