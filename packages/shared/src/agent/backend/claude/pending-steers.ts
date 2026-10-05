import type { SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { SdkAutomationCallback } from '../../../automations/types.ts';
import type { AgentEvent } from '@craft-agent/core/types';
import type { PendingSteer } from '../types.ts';

/** Turn-scoped FIFO. Only an emitting hook may consume accepted messages. */
export class PendingSteers {
  private pending: PendingSteer[] = [];
  private generation = 0;
  private active = false;
  private turn = 0;

  begin(): number {
    this.active = true;
    ++this.generation;
    return ++this.turn;
  }

  pause(): void {
    this.active = false;
    ++this.generation; // Invalidate hooks suspended in permission/source awaits.
  }

  enqueue(message: PendingSteer): boolean {
    if (!this.active) return false;
    this.pending.push(message);
    return true;
  }

  drain(): PendingSteer[] {
    return this.pending.splice(0);
  }

  wrapHook(hook: SdkAutomationCallback): SdkAutomationCallback {
    return async (...args) => {
      const generation = this.generation;
      const result = await hook(...args);
      if (!this.active || generation !== this.generation || args[0].hook_event_name !== 'PreToolUse'
        || ('async' in result && result.async)) return result;
      const output = result as SyncHookJSONOutput;
      if (output.continue === false || output.decision === 'block'
        || (output.hookSpecificOutput?.hookEventName === 'PreToolUse'
          && output.hookSpecificOutput.permissionDecision === 'deny')) return result;

      // No await after draining: arrivals during the hook await join this batch;
      // arrivals after return belong to a later tool boundary.
      const batch = this.drain();
      if (!batch.length) return result;
      const existing = output.hookSpecificOutput?.hookEventName === 'PreToolUse'
        ? output.hookSpecificOutput : undefined;
      return {
        ...output,
        continue: result.continue,
        hookSpecificOutput: {
          ...existing,
          hookEventName: 'PreToolUse' as const,
          additionalContext: [existing?.additionalContext,
            'The user sent the following messages while you were working. Address them in order:',
            ...batch.map((steer, index) => `Message ${index + 1}:\n${steer.message}`),
          ].filter(Boolean).join('\n\n'),
        },
      };
    };
  }

  /** Consumers may return at complete; recover BEFORE publishing that event. */
  async *runTurn(events: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    // A handoff may outlive its consumer. Never inject leftover accepted input
    // into an unrelated turn; transfer it through the recovery contract first.
    this.pause();
    for (const steer of this.drain()) yield { type: 'steer_undelivered', ...steer };
    const turn = this.begin();
    let complete: Extract<AgentEvent, { type: 'complete' }> | undefined;
    try {
      for await (const event of events) {
        if (event.type === 'complete') complete = event;
        else yield event;
      }
    } finally {
      if (turn === this.turn) {
        this.pause();
        for (const steer of this.drain()) yield { type: 'steer_undelivered', ...steer };
      }
    }
    if (complete) yield complete;
  }
}
