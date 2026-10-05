import { describe, expect, it, mock } from 'bun:test';
import type { AgentEvent } from '@craft-agent/core/types';
import { PendingSteers } from '../backend/claude/pending-steers.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { AbortReason } from '../backend/types.ts';

const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tool', tool_input: {} };
const messages = ['a', 'b', 'c'].map(messageId => ({ message: 'same', messageId }));
function queue() {
  const pending = new PendingSteers();
  pending.begin();
  messages.forEach(m => pending.enqueue(m));
  return pending;
}
function fakeAgent() {
  const agent = Object.create(ClaudeAgent.prototype) as any;
  agent.pendingSteers = new PendingSteers();
  agent.currentQuery = { interrupt: mock(async () => {}) };
  agent.currentQueryAbortController = new AbortController();
  agent.debug = () => {};
  return agent;
}

describe('Claude steering delivery', () => {
  it.each([false, true])('injects all once on allow/modify (modify=%s)', async modify => {
    const pending = queue();
    const hook = pending.wrapHook(async () => ({ continue: true,
      ...(modify ? { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'changed' }, additionalContext: 'prior context' } } : {}),
    }));
    const result = await hook(input, 'tool', {}) as any;
    expect(result.hookSpecificOutput.additionalContext.match(/same/g)).toHaveLength(3);
    expect(result.hookSpecificOutput.additionalContext).toContain('Message 1:');
    expect(result.hookSpecificOutput.additionalContext).toContain('Message 3:');
    if (modify) {
      expect(result.hookSpecificOutput.updatedInput).toEqual({ command: 'changed' });
      expect(result.hookSpecificOutput.additionalContext).toContain('prior context');
    }
    const again = await hook(input, 'tool', {}) as any;
    expect(again.hookSpecificOutput?.additionalContext ?? '').not.toContain('same');
    expect(pending.drain()).toEqual([]);
  });

  it.each(['block', 'source activation', 'permission denied'])('retains FIFO on %s', async reason => {
    const pending = queue();
    await pending.wrapHook(async () => ({ continue: false, decision: 'block', reason }))(input, 'tool', {});
    expect(pending.drain()).toEqual(messages);
  });

  it('retains pending messages when a hook throws or returns an SDK deny', async () => {
    const pending = queue();
    await expect(pending.wrapHook(async () => { throw new Error('hook failed'); })(input, 'tool', {})).rejects.toThrow('hook failed');
    await pending.wrapHook(async () => ({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }))(input, 'tool', {});
    expect(pending.drain()).toEqual(messages);
  });

  it('recovers leftover handoff input before opening an unrelated turn', async () => {
    const pending = queue();
    pending.pause();
    const events: AgentEvent[] = [];
    for await (const event of pending.runTurn((async function* (): AsyncGenerator<AgentEvent> {
      expect(pending.drain()).toEqual([]);
      yield { type: 'complete' };
    })())) events.push(event);
    expect(events).toEqual([...messages.map(m => ({ type: 'steer_undelivered' as const, ...m })), { type: 'complete' }]);
  });

  it('includes arrivals during an approved permission await, and leaves later arrivals for the next hook', async () => {
    const pending = queue();
    const gate = Promise.withResolvers<void>();
    const hook = pending.wrapHook(async () => { await gate.promise; return { continue: true }; });
    const resultPromise = hook(input, 'tool', {});
    pending.enqueue({ message: 'during await', messageId: 'd' });
    gate.resolve();
    const result = await resultPromise as any;
    expect(result.hookSpecificOutput.additionalContext).toContain('during await');
    pending.enqueue({ message: 'later', messageId: 'e' });
    expect(result.hookSpecificOutput.additionalContext).not.toContain('later');
    expect(pending.drain()).toEqual([{ message: 'later', messageId: 'e' }]);
  });

  it.each([AbortReason.AuthRequest, AbortReason.PlanSubmitted, AbortReason.UserStop])('suspends stale hooks and retains accepted IDs on %s', async reason => {
    const agent = fakeAgent();
    agent.pendingSteers.begin();
    for (const message of messages) expect(agent.redirect(message.message, { messageId: message.messageId })).toBe(true);
    const gate = Promise.withResolvers<void>();
    const hook = agent.pendingSteers.wrapHook(async () => { await gate.promise; return { continue: true }; });
    const oldResult = hook(input, 'tool', {});
    if (reason === AbortReason.UserStop) agent.forceAbort(reason);
    else agent.interruptForHandoff(reason);
    expect(agent.takePendingSteers()).toEqual(messages);
    agent.pendingSteers.begin();
    agent.pendingSteers.enqueue({ message: 'new turn', messageId: 'new' });
    gate.resolve();
    expect((await oldResult as any).hookSpecificOutput).toBeUndefined();
    expect(agent.takePendingSteers()).toEqual([{ message: 'new turn', messageId: 'new' }]);
  });

  it('recovers A/B/C before complete via the production Claude chatImpl wrapper', async () => {
    const agent = fakeAgent();
    agent.chatTurn = async function* (): AsyncGenerator<AgentEvent> {
      for (const message of messages) agent.redirect(message.message, { messageId: message.messageId });
      yield { type: 'complete' };
    };
    const consumed: AgentEvent[] = [];
    // Like the host, deliberately stop reading at complete, not iterator end.
    for await (const event of agent.chatImpl('initial')) {
      consumed.push(event);
      if (event.type === 'complete') break;
    }
    expect(consumed).toEqual([...messages.map(m => ({ type: 'steer_undelivered' as const, ...m })), { type: 'complete' }]);
  });

  it('an old handed-off turn cannot drain the new turn when it finally finishes', async () => {
    const pending = new PendingSteers();
    const oldGate = Promise.withResolvers<void>();
    const old = pending.runTurn((async function* (): AsyncGenerator<AgentEvent> { await oldGate.promise; yield { type: 'complete' }; })());
    const oldNext = old.next();
    pending.pause();
    pending.drain();
    const newGate = Promise.withResolvers<void>();
    const current = pending.runTurn((async function* (): AsyncGenerator<AgentEvent> { await newGate.promise; yield { type: 'complete' }; })());
    const currentNext = current.next();
    pending.enqueue({ message: 'new', messageId: 'new' });
    oldGate.resolve();
    expect((await oldNext).value).toEqual({ type: 'complete' });
    newGate.resolve();
    expect((await currentNext).value).toEqual({ type: 'steer_undelivered', message: 'new', messageId: 'new' });
    for await (const _ of current) { /* drain */ }
  });
});
