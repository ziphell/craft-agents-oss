import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TokenUsage } from '@craft-agent/core/types';
import type { CreateSessionOptions } from '@craft-agent/shared/protocol';
import { parseTaskSpec, saveTaskSpec, readRunLog, readNodeOutput, type TaskSpec } from '@craft-agent/shared/tasks';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import { TaskRunner, type ConductorSessionHost } from './TaskRunner';

// Flush pending microtasks so the runner's async dispatch (create → column → send) settles.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function tu(inputTokens: number, outputTokens: number): TokenUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, contextTokens: 0, costUsd: 0 };
}

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw);
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues));
  return r.data;
}

/** Mock host: records calls; the test drives completions via complete(). */
class MockHost implements ConductorSessionHost {
  // A Set, mirroring SessionManager — the Conductor keeps its main subscription AND a one-shot
  // verdict listener attached at the same time while a run is `verifying`.
  private readonly listeners = new Set<(evt: SessionCompletionEvent) => void>();
  readonly created: { id: string; options: CreateSessionOptions }[] = [];
  readonly sent: { sessionId: string; message: string }[] = [];
  readonly statuses: { sessionId: string; status: string }[] = [];
  readonly columns: { sessionId: string; column: string | null }[] = [];
  readonly nodeCounts: { sessionId: string; count: number }[] = [];
  readonly cancelled: string[] = [];
  readonly finalTextById = new Map<string, string>();

  async createSession(_workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }> {
    const id = `sess-${options.name}`;
    this.created.push({ id, options });
    return { id };
  }
  async sendMessage(sessionId: string, message: string): Promise<void> {
    this.sent.push({ sessionId, message });
  }
  async setSessionStatus(sessionId: string, status: string): Promise<void> {
    this.statuses.push({ sessionId, status });
  }
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    this.columns.push({ sessionId, column });
  }
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    this.nodeCounts.push({ sessionId, count })
  }
  /** Gate counts pushed to the orchestrator session (board badge + notification source). */
  readonly awaitingCounts: { sessionId: string; count: number }[] = []
  async setTaskAwaitingApproval(sessionId: string, count: number): Promise<void> {
    this.awaitingCounts.push({ sessionId, count })
  }
  async cancelProcessing(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getSessionFinalText(sessionId: string): string | undefined {
    return this.finalTextById.get(sessionId);
  }
  workingDirById = new Map<string, string>();
  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.workingDirById.get(sessionId);
  }

  // --- test helpers (sessionId is derived from the node title, which defaults to the node id) ---
  sessionIdFor(nodeId: string): string {
    return `sess-${nodeId}`;
  }
  promptFor(nodeId: string): string | undefined {
    return this.sent.find((s) => s.sessionId === this.sessionIdFor(nodeId))?.message;
  }
  dispatchedNames(): string[] {
    return this.created.map((c) => c.options.name!).filter(Boolean);
  }
  complete(nodeId: string, opts: { reason?: SessionCompletionEvent['reason']; finalText?: string; tokenUsage?: TokenUsage } = {}): void {
    this.completeSession(this.sessionIdFor(nodeId), opts);
  }
  /** Fire a completion for an arbitrary session id (e.g. the orchestrator's verification verdict). */
  completeSession(sessionId: string, opts: { reason?: SessionCompletionEvent['reason']; finalText?: string; tokenUsage?: TokenUsage } = {}): void {
    const evt: SessionCompletionEvent = {
      sessionId,
      workspaceId: 'ws',
      reason: opts.reason ?? 'complete',
      finalText: opts.finalText,
      tokenUsage: opts.tokenUsage,
    };
    for (const listener of [...this.listeners]) listener(evt);
  }
}

describe('TaskRunner (Conductor)', () => {
  let root: string;
  let host: MockHost;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
    host = new MockHost();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner() {
    return new TaskRunner({ host, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z' });
  }

  it('runs a dependency chain, feeding each output into the next', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'demo',
        title: 'Demo',
        goal: 'audit then design then implement',
        nodes: [
          { id: 'audit', prompt: 'Audit the code' },
          { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
          { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('demo', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.dispatchedNames()).toEqual(['audit']);
    expect(host.promptFor('audit')).toBe('Audit the code');

    host.complete('audit', { finalText: 'AUDIT', tokenUsage: tu(10, 5) });
    await tick();
    expect(host.dispatchedNames()).toEqual(['audit', 'design']);
    expect(host.promptFor('design')).toBe('Design using AUDIT');

    host.complete('design', { finalText: 'DESIGN', tokenUsage: tu(20, 10) });
    await tick();
    expect(host.promptFor('impl')).toBe('Implement DESIGN');

    host.complete('impl', { finalText: 'IMPL', tokenUsage: tu(5, 5) });
    await tick();

    // All nodes done → the run is verifying (not yet terminal) until the orchestrator returns a verdict.
    expect(runner.getRunState('demo', 'r1')!.status).toBe('verifying');
    expect(host.sent.some((s) => s.sessionId === 'orch' && s.message.includes('finished running'))).toBe(true);

    host.completeSession('orch', { finalText: 'Looks correct.\nVERDICT: PASS' });
    await tick();

    const snap = runner.getRunState('demo', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.every((n) => n.state === 'done')).toBe(true);
    expect(snap.tokensUsed).toBe(55);

    // Run-log + node output persisted.
    const log = readRunLog(root, 'demo', 'r1');
    expect(log[0]).toMatchObject({ kind: 'run-started' });
    expect(log.some((e) => e.kind === 'run-completed')).toBe(true);
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'AUDIT' });
  });

  it('passes llmConnection (node value, else the task default) to createSession', async () => {
    // Regression: pi/* models complete instantly with empty output unless the child session is
    // created with the connection slug that serves the model.
    saveTaskSpec(
      root,
      specOf({
        id: 'conn',
        title: 'Conn',
        goal: 'g',
        defaults: { llmConnection: 'default-conn' },
        nodes: [
          { id: 'a', prompt: 'a', model: 'pi/gpt-5.5', llmConnection: 'pi-conn' },
          { id: 'b', prompt: 'b', model: 'claude-opus-4-8' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('conn', { runId: 'r1' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    const optsB = host.created.find((c) => c.options.name === 'b')?.options
    expect(optsA?.llmConnection).toBe('pi-conn')
    expect(optsB?.llmConnection).toBe('default-conn')
  })

  it('resolves permissionMode: node override → task default → child (never the workspace default)', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'perm',
        title: 'Perm',
        goal: 'g',
        defaults: { permissionMode: 'ask' },
        nodes: [
          { id: 'a', prompt: 'a', permissionMode: 'safe' }, // node override wins
          { id: 'b', prompt: 'b' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('perm', { runId: 'r1' })
    await tick()

    expect(host.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('safe')
    expect(host.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('ask')
  })

  it('defaults an omitted permission mode to allow-all (unattended-safe), not undefined/ask', async () => {
    // A hand-authored spec that sets no permission mode must NOT fall through to the workspace default
    // (which could be `ask` → the unattended child would hang). The runner supplies an explicit default.
    saveTaskSpec(
      root,
      specOf({ id: 'perm2', title: 'Perm2', goal: 'g', nodes: [{ id: 'c', prompt: 'c' }] }),
    )
    const runner = makeRunner()
    runner.run('perm2', { runId: 'r1' })
    await tick()

    expect(host.created.find((c) => c.options.name === 'c')?.options.permissionMode).toBe('allow-all')
  })

  it('stamps task/run/node linkage on each dispatched child session', async () => {
    // The manual subtask composer skips Conductor-owned children by checking taskRunId.
    saveTaskSpec(
      root,
      specOf({ id: 'link', title: 'Link', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }),
    )
    const runner = makeRunner()
    runner.run('link', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    expect(optsA?.taskSlug).toBe('link')
    expect(optsA?.taskRunId).toBe('r1')
    expect(optsA?.taskNodeId).toBe('a')
  })

  /**
   * The one hop of §3.6 that had no test: a node's `writes:` becomes the child session's
   * `taskWrites`, which is where the write guard and `<prototype_context writer>` read it from. A
   * node that declares nothing stamps nothing — "absent means the single-writer default" is a
   * decision `resolvePrototypeWriter` makes, not one to write `main` in here.
   */
  it("stamps the node's writer identity on its child, and leaves it off when the node declares none", async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'lanes',
        title: 'Lanes',
        goal: 'g',
        nodes: [
          { id: 'ui', prompt: 'ui', writes: 'checkout-ui' },
          { id: 'notes', prompt: 'notes' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('lanes', { runId: 'r1' });
    await tick();

    const optionsFor = (node: string) => host.created.find((c) => c.options.taskNodeId === node)?.options;

    expect(optionsFor('ui')?.taskWrites).toBe('checkout-ui');
    expect(optionsFor('notes')?.taskWrites).toBeUndefined();
  });

  /**
   * What §6.4 was waiting for, at the runner's level: two lanes in flight at the same time, each
   * writing as its own identity. The files are protected by the pair — a distinct prefix per lane
   * (refused at validation when they collide) and the write guard refusing a name that claims
   * another's — so the runner's job is to get one stamp per node right, and to let both go.
   */
  it('keeps two writer lanes in flight at once, each stamped with its own identity', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'parallel',
        title: 'Parallel',
        goal: 'g',
        nodes: [
          { id: 'ui', prompt: 'ui', writes: 'checkout-ui' },
          { id: 'api', prompt: 'api', writes: 'checkout-api' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('parallel', { runId: 'r1' });
    await tick();

    // Both dispatched before either finished: that is the concurrency, not a queue.
    expect(host.dispatchedNames().sort()).toEqual(['api', 'ui']);

    const writers = host.created
      .map((c) => ({ node: c.options.taskNodeId, writes: c.options.taskWrites }))
      .sort((a, b) => String(a.node).localeCompare(String(b.node)));
    expect(writers).toEqual([
      { node: 'api', writes: 'checkout-api' },
      { node: 'ui', writes: 'checkout-ui' },
    ]);

    // Two children, so no lane's guard can be reading the other's identity.
    expect(new Set(host.created.map((c) => c.id)).size).toBe(2);

    // …and the run settles only when both are done, like any fan-out.
    host.complete('ui', { finalText: 'A' });
    await tick();
    expect(runner.getRunState('parallel', 'r1')!.status).toBe('running');

    host.complete('api', { finalText: 'B' });
    await tick();
    expect(runner.getRunState('parallel', 'r1')!.status).toBe('completed');
  });

  it('creates a child session per node (createSession announces each to the renderer by default)', async () => {
    // Renderer visibility depends on createSession emitting session_created; the runner's job is
    // simply to create one session per node (the host's createSession owns the announcement).
    saveTaskSpec(
      root,
      specOf({ id: 'announce', title: 'Announce', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }] }),
    )
    const runner = makeRunner()
    runner.run('announce', { runId: 'r1' })
    await tick()

    expect(host.created.map((c) => c.id)).toEqual([host.sessionIdFor('a'), host.sessionIdFor('b')])
  })

  it("children inherit the orchestrator's working directory (falling back to spec.cwd)", async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'cwd', title: 'Cwd', goal: 'g', cwd: '/spec/dir', nodes: [{ id: 'a', prompt: 'a' }] }),
    )
    host.workingDirById.set('orch', '/parent/dir')
    const runner = makeRunner()
    runner.run('cwd', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()
    // Orchestrator cwd wins over the spec default.
    expect(host.created.find((c) => c.options.name === 'a')?.options.workingDirectory).toBe('/parent/dir')

    // With no orchestrator cwd, the spec's declared cwd is used.
    host.created.length = 0
    host.workingDirById.clear()
    const runner2 = makeRunner()
    runner2.run('cwd', { runId: 'r2', orchestratorSessionId: 'orch' })
    await tick()
    expect(host.created.find((c) => c.options.name === 'a')?.options.workingDirectory).toBe('/spec/dir')
  })

  it('moves the orchestrator tile to in-progress on start and done on completion', async () => {
    saveTaskSpec(root, specOf({ id: 'col', title: 'Col', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }))
    const runner = makeRunner()
    runner.run('col', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false })
    await tick()
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'in-progress' })

    host.complete('a', { finalText: 'A' })
    await tick()
    expect(host.columns).toContainEqual({ sessionId: 'orch', column: 'done' })
  })

  it('runs a fan-out and joins at the synthesizer', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'fan',
        title: 'Fan',
        goal: 'g',
        nodes: [
          { id: 'design', prompt: 'design' },
          { id: 'impl-a', depends_on: ['design'], prompt: 'A: ${nodes.design.output}' },
          { id: 'impl-b', depends_on: ['design'], prompt: 'B: ${nodes.design.output}' },
          { id: 'review', depends_on: ['impl-a', 'impl-b'], prompt: 'review ${nodes.impl-a.output} ${nodes.impl-b.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('fan', { runId: 'r1' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['design']);

    host.complete('design', { finalText: 'D' });
    await tick();
    // Both siblings dispatch in parallel; review waits for the barrier.
    expect(host.dispatchedNames().sort()).toEqual(['design', 'impl-a', 'impl-b']);
    expect(host.promptFor('review')).toBeUndefined();

    host.complete('impl-a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('review')).toBeUndefined(); // still waiting on impl-b

    host.complete('impl-b', { finalText: 'B' });
    await tick();
    expect(host.promptFor('review')).toBe('review A B');

    host.complete('review', { finalText: 'R' });
    await tick();
    expect(runner.getRunState('fan', 'r1')!.status).toBe('completed');
  });

  it('marks a node failed, leaves dependents pending, and settles the run as failed', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'fail',
        title: 'F',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('fail', { runId: 'r1' });
    await tick();

    host.complete('a', { reason: 'error' });
    await tick();

    const snap = runner.getRunState('fail', 'r1')!;
    expect(snap.status).toBe('failed');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
    expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('pending');
    expect(host.promptFor('b')).toBeUndefined();
    expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);

    const log = readRunLog(root, 'fail', 'r1');
    expect(log.some((e) => e.kind === 'node-finished' && (e as { state?: string }).state === 'failed')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('honors max_parallel', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'par',
        title: 'P',
        goal: 'g',
        max_parallel: 1,
        nodes: [
          { id: 'x', prompt: 'x' },
          { id: 'y', prompt: 'y' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('par', { runId: 'r1' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['x']); // only one slot

    host.complete('x', { finalText: 'X' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['x', 'y']);

    host.complete('y', { finalText: 'Y' });
    await tick();
    expect(runner.getRunState('par', 'r1')!.status).toBe('completed');
  });

  it('pauses scheduling and resumes', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'pz',
        title: 'Pz',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('pz', { runId: 'r1' });
    await tick();

    runner.pause('pz', 'r1');
    host.complete('a', { finalText: 'A' });
    await tick();
    expect(host.promptFor('b')).toBeUndefined(); // paused → no scheduling
    expect(runner.getRunState('pz', 'r1')!.status).toBe('paused');

    runner.resume('pz', 'r1');
    await tick();
    expect(host.promptFor('b')).toBe('b A');

    host.complete('b', { finalText: 'B' });
    await tick();
    expect(runner.getRunState('pz', 'r1')!.status).toBe('completed');
  });

  it('stops a run and cancels in-flight children', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'st',
        title: 'St',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('st', { runId: 'r1' });
    await tick();

    await runner.stop('st', 'r1');
    const snap = runner.getRunState('st', 'r1')!;
    expect(snap.status).toBe('stopped');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('cancelled');
    expect(host.cancelled).toContain('sess-a');
  });

  it('resumes a run from the persisted run-log after a restart, reusing finished node outputs', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'res',
        title: 'Res',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
        ],
      }),
    );
    // First runner: complete 'a' (output persisted), leave 'b' pending, then "crash" (drop the runner).
    const r1 = makeRunner();
    r1.run('res', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    r1.pause('res', 'r1'); // so completing 'a' does not dispatch 'b'
    host.complete('a', { finalText: 'A', tokenUsage: tu(3, 4) });
    await tick();
    expect(readNodeOutput(root, 'res', 'r1', 'a')).toEqual({ text: 'A' });

    // Simulate an app restart: a brand-new runner + host with empty in-memory state.
    const host2 = new MockHost();
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z' });
    r2.resume('res', 'r1'); // not in memory → rehydrate from the run-log
    await tick();

    // 'a' is reused from disk (NOT re-spawned); only 'b' dispatches, seeded with a's recovered output.
    expect(host2.dispatchedNames()).toEqual(['b']);
    expect(host2.promptFor('b')).toBe('b A');
    // The orchestrator linkage is recovered from the run-log.
    expect(host2.created.find((c) => c.options.name === 'b')?.options.parentSessionId).toBe('orch');

    host2.complete('b', { finalText: 'B' });
    await tick();
    // Resumed run re-verifies (orchestrator recovered from the run-log) before going terminal.
    expect(r2.getRunState('res', 'r1')!.status).toBe('verifying');
    host2.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(r2.getRunState('res', 'r1')!.status).toBe('completed');
  });

  it('retries a failed node up to retry.limit, then fails', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rt', title: 'Rt', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 1 } }] }),
    );
    const runner = makeRunner();
    runner.run('rt', { runId: 'r1' });
    await tick();

    // First failure → within budget → re-dispatched (still running, attempt 2).
    host.complete('a', { reason: 'error' });
    await tick();
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(2);
    let snap = runner.getRunState('rt', 'r1')!;
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);

    // Second failure → budget exhausted → failed.
    host.complete('a', { reason: 'error' });
    await tick();
    snap = runner.getRunState('rt', 'r1')!;
    expect(snap.status).toBe('failed');
    expect(snap.nodes[0]!.state).toBe('failed');
    expect(readRunLog(root, 'rt', 'r1').some((e) => e.kind === 'node-retry')).toBe(true);
  });

  it('does not retry when retry.limit is 0', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rt0', title: 'Rt0', goal: 'g', nodes: [{ id: 'a', prompt: 'a', retry: { limit: 0 } }] }),
    );
    const runner = makeRunner();
    runner.run('rt0', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner.getRunState('rt0', 'r1')!.status).toBe('failed');
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
  });

  it('feeds the prior failure into the retried prompt and can then succeed', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rtok', title: 'RtOk', goal: 'g', nodes: [{ id: 'a', prompt: 'do a', retry: { limit: 2 } }] }),
    );
    const runner = makeRunner();
    runner.run('rtok', { runId: 'r1' });
    await tick();

    host.complete('a', { reason: 'timeout' });
    await tick();
    const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
    expect(retryPrompt).toContain('Previous attempt failed: timeout');
    expect(retryPrompt).toContain('do a');

    host.complete('a', { finalText: 'OK' });
    await tick();
    expect(runner.getRunState('rtok', 'r1')!.status).toBe('completed');
  });

  it('does not retry on error when retry.when targets a different failure class', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'rtw', title: 'RtW', goal: 'g', nodes: [{ id: 'a', prompt: 'a', retry: { limit: 3, when: 'empty' } }] }),
    );
    const runner = makeRunner();
    runner.run('rtw', { runId: 'r1' });
    await tick();
    host.complete('a', { reason: 'error' });
    await tick();
    expect(runner.getRunState('rtw', 'r1')!.status).toBe('failed');
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
  });

  it('completes without verifying when there is no orchestrator', async () => {
    saveTaskSpec(root, specOf({ id: 'nov', title: 'NoV', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('nov', { runId: 'r1' }); // no orchestratorSessionId → nothing to verify against
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('nov', 'r1')!.status).toBe('completed');
    expect(readRunLog(root, 'nov', 'r1').some((e) => e.kind === 'run-verifying')).toBe(false);
  });

  it('gates the run on the orchestrator verdict and includes acceptance_criteria in the prompt', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'vp', title: 'Vp', goal: 'g', acceptance_criteria: 'must be perfect', nodes: [{ id: 'a', prompt: 'do a' }] }),
    );
    const runner = makeRunner();
    runner.run('vp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('verifying');
    const vmsg = host.sent.find((s) => s.sessionId === 'orch')!.message;
    expect(vmsg).toContain('must be perfect');
    expect(vmsg).toContain('VERDICT: PASS');

    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('vp', 'r1')!.status).toBe('completed');
  });

  it('re-runs the terminal node once on a FAIL verdict, then completes on PASS', async () => {
    saveTaskSpec(root, specOf({ id: 'vf', title: 'Vf', goal: 'g', nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vf', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'first' });
    await tick();

    host.completeSession('orch', { finalText: 'Not good enough.\nVERDICT: FAIL — missing X' });
    await tick();
    const snap = runner.getRunState('vf', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes[0]!.state).toBe('running');
    expect(snap.nodes[0]!.attempt).toBe(2);
    const retryPrompt = host.sent.filter((s) => s.sessionId === 'sess-a')[1]!.message;
    expect(retryPrompt).toContain('rejected on verification: missing X');

    host.complete('a', { finalText: 'second' });
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('verifying');
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('vf', 'r1')!.status).toBe('completed');
  });

  it('fails the run when FAIL verdicts exhaust the repair budget (max_iterations)', async () => {
    // max_iterations: 1 → one repair allowed; the second FAIL breaches the iteration budget.
    saveTaskSpec(root, specOf({ id: 'vff', title: 'Vff', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'do a' }] }));
    const runner = makeRunner();
    runner.run('vff', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nope' });
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('running'); // first repair in flight

    host.complete('a', { finalText: 'y' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — still nope' });
    await tick();
    expect(runner.getRunState('vff', 'r1')!.status).toBe('failed');
    const log = readRunLog(root, 'vff', 'r1');
    expect(log.filter((e) => e.kind === 'verdict').length).toBe(2);
    expect(log.some((e) => e.kind === 'budget-breach' && (e as { metric?: string }).metric === 'iterations')).toBe(true);
    expect(log.some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('re-asks on an unparsable verdict and fails only after the re-ask budget is exhausted', async () => {
    saveTaskSpec(root, specOf({ id: 'unp', title: 'Unp', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unp', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    // First malformed reply → re-asked, run stays verifying (not terminal).
    host.completeSession('orch', { finalText: 'I think it is fine but forgot the verdict line.' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');
    expect(host.sent.filter((s) => s.sessionId === 'orch' && s.message.includes('did not include a parseable verdict')).length).toBe(1);

    // Second malformed reply → re-asked again (MAX_UNPARSED_REASKS = 2).
    host.completeSession('orch', { finalText: 'still no verdict line, sorry' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('verifying');

    // Third malformed reply → budget exhausted → failed.
    host.completeSession('orch', { finalText: 'nope, no verdict again' });
    await tick();
    expect(runner.getRunState('unp', 'r1')!.status).toBe('failed');
    expect(readRunLog(root, 'unp', 'r1').filter((e) => e.kind === 'verdict' && (e as { result?: string }).result === 'unparsed').length).toBe(3);
  });

  it('scopes a repair to the named nodes and their transitive dependents', async () => {
    // Chain a → b → c. A FAIL naming only `b` must re-run b AND c (downstream), but leave a done.
    saveTaskSpec(
      root,
      specOf({
        id: 'scope',
        title: 'Scope',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b ${nodes.a.output}' },
          { id: 'c', depends_on: ['b'], prompt: 'c ${nodes.b.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('scope', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'A' });
    await tick();
    host.complete('b', { finalText: 'B' });
    await tick();
    host.complete('c', { finalText: 'C' });
    await tick();
    expect(runner.getRunState('scope', 'r1')!.status).toBe('verifying');

    host.completeSession('orch', { finalText: 'VERDICT: FAIL — nodes=b — b is wrong' });
    await tick();
    const snap = runner.getRunState('scope', 'r1')!;
    expect(snap.status).toBe('running');
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('done'); // upstream untouched
    expect(snap.nodes.find((n) => n.id === 'b')!.state).toBe('running'); // re-dispatched
    expect(snap.nodes.find((n) => n.id === 'c')!.state).toBe('pending'); // waits on b
    // a ran once; b re-dispatched (2); c not yet re-dispatched.
    expect(host.created.filter((c) => c.options.name === 'a')).toHaveLength(1);
    expect(host.created.filter((c) => c.options.name === 'b')).toHaveLength(2);
    expect(host.created.filter((c) => c.options.name === 'c')).toHaveLength(1);
  });

  it('an unparsed re-ask does not consume the repair budget', async () => {
    // max_iterations: 1. An intervening unparsed verdict must not eat the single repair allowance.
    saveTaskSpec(root, specOf({ id: 'unb', title: 'Unb', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('unb', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();

    host.completeSession('orch', { finalText: 'no verdict here' }); // unparsed → re-ask
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('verifying');

    host.completeSession('orch', { finalText: 'VERDICT: FAIL — fix it' }); // first real FAIL → repair still allowed
    await tick();
    expect(runner.getRunState('unb', 'r1')!.status).toBe('running');
  });

  it('does not hang in verifying when the verification send rejects', async () => {
    saveTaskSpec(root, specOf({ id: 'snd', title: 'Snd', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('snd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    // Make the orchestrator verification send reject (the verdict can never arrive).
    const origSend = host.sendMessage.bind(host);
    host.sendMessage = async (sessionId: string, message: string) => {
      if (sessionId === 'orch') throw new Error('send boom');
      return origSend(sessionId, message);
    };
    host.complete('a', { finalText: 'x' });
    await tick();
    await tick();
    expect(runner.getRunState('snd', 'r1')!.status).toBe('failed');
  });

  it('ignores a verdict that arrives after the run was stopped', async () => {
    saveTaskSpec(root, specOf({ id: 'late', title: 'Late', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('late', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('verifying');

    await runner.stop('late', 'r1');
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');

    // A late verdict for the (now stopped) run must not flip it back to completed/failed.
    host.completeSession('orch', { finalText: 'VERDICT: PASS' });
    await tick();
    expect(runner.getRunState('late', 'r1')!.status).toBe('stopped');
  });

  it('reconstructs the repair counter from the run-log on a cross-restart resume', async () => {
    // max_iterations: 1. Consume the single repair, then "restart": the resumed run must remember
    // repairsUsed=1 (from the persisted FAIL verdict) so the next FAIL fails immediately.
    saveTaskSpec(root, specOf({ id: 'hyd', title: 'Hyd', goal: 'g', max_iterations: 1, nodes: [{ id: 'a', prompt: 'a' }] }));
    const r1 = makeRunner();
    r1.run('hyd', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();
    host.complete('a', { finalText: 'x' });
    await tick();
    host.completeSession('orch', { finalText: 'VERDICT: FAIL — redo' }); // consumes the one repair
    await tick();
    expect(r1.getRunState('hyd', 'r1')!.status).toBe('running');

    // Restart: fresh host + runner with empty in-memory state, resume from the run-log.
    const host2 = new MockHost();
    const r2 = new TaskRunner({ host: host2, workspaceId: 'ws', workspaceRoot: root, now: () => '2026-06-07T00:00:00.000Z' });
    r2.resume('hyd', 'r1');
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('verifying');

    // A single FAIL now exhausts the (carried-over) budget immediately.
    host2.completeSession('orch', { finalText: 'VERDICT: FAIL — still bad' });
    await tick();
    expect(r2.getRunState('hyd', 'r1')!.status).toBe('failed');
  });

  it('fails a node that completes with no text despite declaring outputs (instead of marking it done)', async () => {
    // Bug 2: a clean turn-completion is not proof of success. A node that declared `outputs` but
    // produced empty final text delivered nothing — it must fail (→ needs-review), not silently pass.
    saveTaskSpec(
      root,
      specOf({
        id: 'empty',
        title: 'Empty',
        goal: 'g',
        nodes: [{ id: 'a', prompt: 'a', outputs: [{ name: 'result' }] }],
      }),
    );
    const runner = makeRunner();
    runner.run('empty', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: '   ' }); // whitespace-only → counts as empty
    await tick();

    const snap = runner.getRunState('empty', 'r1')!;
    expect(snap.nodes.find((n) => n.id === 'a')!.state).toBe('failed');
    expect(snap.status).toBe('failed');
    expect(host.statuses.some((s) => s.sessionId === 'sess-a' && s.status === 'needs-review')).toBe(true);
  });

  it('still marks a node done on empty text when it declares no outputs (lenient default)', async () => {
    // The empty-output guard must only bite nodes that declared outputs; output-less nodes keep the
    // lenient "completed = done" behavior.
    saveTaskSpec(root, specOf({ id: 'lenient', title: 'Lenient', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('lenient', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: '' });
    await tick();

    expect(runner.getRunState('lenient', 'r1')!.nodes.find((n) => n.id === 'a')!.state).toBe('done');
  });

  it('feeds a declared structured field into the dependent node, not the whole prose', async () => {
    // Structured outputs (the producer side of `${nodes.<id>.output.<field>}`): a node that
    // declares `outputs` is told the block shape, and what it hands back is filed as params.
    saveTaskSpec(
      root,
      specOf({
        id: 'gate',
        title: 'Gate',
        goal: 'review then act',
        nodes: [
          {
            id: 'review',
            prompt: 'Review the draft',
            outputs: [{ name: 'verdict', type: 'string', enum: ['approved', 'rejected'] }],
          },
          { id: 'act', depends_on: ['review'], prompt: 'Verdict was ${nodes.review.output.verdict}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('gate', { runId: 'r1' });
    await tick();

    expect(host.promptFor('review')).toContain('```params');
    expect(host.promptFor('review')).toContain('one of: approved, rejected');

    host.complete('review', { finalText: 'The draft is sound.\n\n```params\n{"verdict": "approved"}\n```' });
    await tick();

    expect(host.promptFor('act')).toBe('Verdict was approved');
    expect(readNodeOutput(root, 'gate', 'r1', 'review')).toEqual({
      text: 'The draft is sound.',
      params: { verdict: 'approved' },
    });
  });

  it('fails a node whose declared field is missing instead of passing an unresolved token downstream', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'gate-fail',
        title: 'Gate fail',
        goal: 'g',
        nodes: [
          { id: 'review', prompt: 'Review', outputs: [{ name: 'verdict' }] },
          { id: 'act', depends_on: ['review'], prompt: 'Verdict was ${nodes.review.output.verdict}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('gate-fail', { runId: 'r1' });
    await tick();

    host.complete('review', { finalText: 'I forgot the block.' });
    await tick();

    expect(runner.getRunState('gate-fail', 'r1')!.nodes.find((n) => n.id === 'review')!.state).toBe('failed');
    expect(host.statuses.some((s) => s.sessionId === 'sess-review' && s.status === 'needs-review')).toBe(true);
    expect(host.promptFor('act')).toBeUndefined();
  });

  it('runs only the branch a `when` selects, and skips the other side', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'branch',
        title: 'Branch',
        goal: 'review then act on the verdict',
        nodes: [
          { id: 'review', prompt: 'Review it', outputs: [{ name: 'verdict', enum: ['approved', 'rejected'] }] },
          { id: 'finalize', prompt: 'Publish', when: "review.verdict === 'approved'" },
          { id: 'notify', prompt: 'Tell the requester', when: "review.verdict === 'rejected'" },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('branch', { runId: 'r1' });
    await tick();

    // Nothing downstream of the verdict is dispatched before it exists.
    expect(host.dispatchedNames()).toEqual(['review']);

    host.complete('review', { finalText: 'Looks wrong.\n\n```params\n{"verdict": "rejected"}\n```' });
    await tick();

    expect(host.dispatchedNames()).toEqual(['review', 'notify']);
    expect(host.promptFor('finalize')).toBeUndefined();

    host.complete('notify', { finalText: 'Sent.' });
    await tick();

    const snap = runner.getRunState('branch', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.find((n) => n.id === 'finalize')!.state).toBe('skipped');
    expect(snap.nodes.find((n) => n.id === 'notify')!.state).toBe('done');
    const skipped = readRunLog(root, 'branch', 'r1').find(
      (e) => e.kind === 'node-finished' && e.nodeId === 'finalize',
    );
    expect(skipped).toMatchObject({ state: 'skipped' });
    expect((skipped as { reason?: string }).reason).toContain('when:');
  });

  it('skips a node whose dependency was skipped (and still finishes the run)', async () => {
    // Without propagation the dependent stays `pending` forever — the run would hang instead of
    // settling, since a skipped node never reports `done`.
    saveTaskSpec(
      root,
      specOf({
        id: 'cascade',
        title: 'Cascade',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a', outputs: [{ name: 'verdict' }] },
          { id: 'gate', prompt: 'b', when: "a.verdict === 'never'" },
          { id: 'after', prompt: 'c', depends_on: ['gate'] },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('cascade', { runId: 'r1' });
    await tick();

    host.complete('a', { finalText: 'Fine.\n\n```params\n{"verdict": "approved"}\n```' });
    await tick();

    const snap = runner.getRunState('cascade', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.find((n) => n.id === 'gate')!.state).toBe('skipped');
    expect(snap.nodes.find((n) => n.id === 'after')!.state).toBe('skipped');
    expect(host.dispatchedNames()).toEqual(['a']);
  });

  it('matches retry.when against the failure class (invalid vs the default error)', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'retry-class',
        title: 'Retry class',
        goal: 'g',
        nodes: [
          {
            id: 'report',
            prompt: 'Report',
            outputs: [{ name: 'score' }],
            retry: { limit: 1, when: 'invalid' },
          },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('retry-class', { runId: 'r1' });
    await tick();

    // First attempt: no block → `invalid` → the policy asked for exactly this, so it re-dispatches.
    host.complete('report', { finalText: 'I forgot the block.' });
    await tick();
    expect(host.dispatchedNames()).toEqual(['report', 'report']);
    expect(runner.getRunState('retry-class', 'r1')!.nodes[0]!.state).toBe('running');
    const retried = host.sent.filter((s) => s.sessionId === host.sessionIdFor('report')).at(-1)!.message;
    expect(retried).toContain('Previous attempt failed');

    host.complete('report', { finalText: 'Done.\n\n```params\n{"score": 1}\n```' });
    await tick();
    expect(runner.getRunState('retry-class', 'r1')!.status).toBe('completed');
  });

  it('parks at an approval gate and takes the branch the person chooses', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'gate-run',
        title: 'Gate run',
        goal: 'draft, sign off, then either ship or rework',
        nodes: [
          { id: 'draft', prompt: 'Draft it' },
          {
            id: 'signoff',
            kind: 'approval',
            depends_on: ['draft'],
            prompt: 'Ship the draft?',
            // Declared like any other field the graph reads — the runtime is what fills it in.
            outputs: [{ name: 'verdict' }],
          },
          { id: 'ship', prompt: 'Ship it', when: "signoff.verdict === 'approved'" },
          { id: 'rework', prompt: 'Rework it', when: "signoff.verdict === 'rejected'" },
        ],
      }),
    );
    const runner = makeRunner();
    // verifyOnComplete off: this test is about the gate, not the terminal verdict handshake.
    runner.run('gate-run', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false });
    await tick();

    host.complete('draft', { finalText: 'DRAFT' });
    await tick();

    // The gate is not a session: nothing is dispatched for it, and the run waits rather than
    // finishing (an unanswered gate is neither success nor failure).
    expect(host.dispatchedNames()).toEqual(['draft']);
    expect(runner.getRunState('gate-run', 'r1')!.status).toBe('running');
    expect(runner.getRunState('gate-run', 'r1')!.nodes.find((n) => n.id === 'signoff')!.state).toBe(
      'awaiting-approval',
    );
    expect(readRunLog(root, 'gate-run', 'r1').some((e) => e.kind === 'node-awaiting-approval')).toBe(true);
    // The board tiles + the notification read this off the orchestrator session.
    expect(host.awaitingCounts).toContainEqual({ sessionId: 'orch', count: 1 });

    runner.resolveApproval('gate-run', 'r1', 'signoff', false);
    await tick();

    // The decision is the node's output, so it survives a restart and shows up in Results.
    expect(readNodeOutput(root, 'gate-run', 'r1', 'signoff')).toEqual({
      text: 'Rejected',
      params: { verdict: 'rejected' },
    });
    expect(host.dispatchedNames()).toEqual(['draft', 'rework']);
    expect(runner.getRunState('gate-run', 'r1')!.nodes.find((n) => n.id === 'ship')!.state).toBe('skipped');
    // Nothing is waiting any more: the badge has to drop with the decision, not later.
    expect(host.awaitingCounts.at(-1)).toEqual({ sessionId: 'orch', count: 0 });

    host.complete('rework', { finalText: 'REWORKED' });
    await tick();
    const snap = runner.getRunState('gate-run', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.find((n) => n.id === 'signoff')!.state).toBe('done');
  });

  it('stops a parked gate with the run, and refuses to answer it afterwards', async () => {
    // A gate at the head of the graph parks immediately — nothing to wait for but a person.
    saveTaskSpec(
      root,
      specOf({
        id: 'stopped-gate',
        title: 'Stopped gate',
        goal: 'g',
        nodes: [{ id: 'signoff', kind: 'approval', prompt: 'Ship it?' }],
      }),
    );
    const runner = makeRunner();
    runner.run('stopped-gate', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false });
    await tick();
    expect(runner.getRunState('stopped-gate', 'r1')!.nodes[0]!.state).toBe('awaiting-approval');
    expect(host.awaitingCounts).toContainEqual({ sessionId: 'orch', count: 1 });

    await runner.stop('stopped-gate', 'r1');

    // Stopping cancels the gate rather than leaving it parked: nobody can answer a run that is
    // over, and the tile must stop saying "needs you". Then answering it is refused.
    expect(runner.getRunState('stopped-gate', 'r1')!.nodes[0]!.state).toBe('cancelled');
    expect(host.awaitingCounts.at(-1)).toEqual({ sessionId: 'orch', count: 0 });
    expect(() => runner.resolveApproval('stopped-gate', 'r1', 'signoff', true)).toThrow(/not waiting for approval/);
  });

  it('refuses to answer a node that is not waiting for approval', async () => {
    saveTaskSpec(root, specOf({ id: 'no-gate', title: 'No gate', goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }));
    const runner = makeRunner();
    runner.run('no-gate', { runId: 'r1' });
    await tick();
    host.complete('a', { finalText: 'done' });
    await tick();

    expect(() => runner.resolveApproval('no-gate', 'r1', 'a', true)).toThrow(/not waiting for approval/);
    expect(() => runner.resolveApproval('no-gate', 'r1', 'ghost', true)).toThrow(/not part of this run/);
  });

  it('publishes the total node count to the orchestrator at run start (stable board denominator)', async () => {
    // Bug 3: the board derives subtask progress from lazily-spawned child sessions, so without an
    // up-front total the denominator grows (0/1 → 1/2 …). The runner publishes spec.nodes.length once.
    saveTaskSpec(
      root,
      specOf({
        id: 'count',
        title: 'Count',
        goal: 'g',
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', depends_on: ['a'], prompt: 'b' },
          { id: 'c', depends_on: ['b'], prompt: 'c' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('count', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.nodeCounts).toContainEqual({ sessionId: 'orch', count: 3 });
  });
});
