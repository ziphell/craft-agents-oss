import { describe, expect, it } from 'bun:test';
import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts';

function adapter() {
  const value = new ClaudeEventAdapter({ mapSDKError: async () => { throw new Error('Unexpected SDK error'); } });
  value.startTurn();
  value.setContextUsage({ usedTokens: 419_000, limitTokens: 1_000_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true });
  return value;
}
const boundary = (postTokens?: number) => ({
  type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 419_000, post_tokens: postTokens },
}) as any;
const result = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 0,
  usage: { input_tokens: 419_000, output_tokens: 100 }, total_cost_usd: 0,
} as any;

describe('native compaction occupancy and completion', () => {
  it('publishes post-compaction occupancy and never restores cumulative result usage', async () => {
    const value = adapter();
    value.expectManualCompaction();
    const events = await value.adapt(boundary(12_000));
    expect(events).toEqual([{ type: 'context_usage', contextUsage: { usedTokens: 12_000, limitTokens: 1_000_000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } }]);
    const terminal = await value.adapt(result);
    expect(terminal.map(e => e.type)).toEqual(['info', 'complete']);
    expect(terminal[0]).toMatchObject({ compactionTrigger: 'manual' });
    expect(value.getContextUsage()?.usedTokens).toBe(12_000);
  });

  it('invalidates occupancy without post_tokens, including across a synthetic command result', async () => {
    const value = adapter();
    value.expectManualCompaction();
    const events = await value.adapt(boundary());
    expect(events[0]).toMatchObject({ type: 'context_usage', contextUsage: { usedTokens: null, isStale: true } });
    await value.adapt({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 0, output_tokens: 0 } } } as any);
    await value.adapt(result);
    expect(value.getContextUsage()).toMatchObject({ usedTokens: null, isStale: true });
  });

  it.each(['failed', 'success'])('does not mistake compact_result %s without a boundary for successful compaction', async (status) => {
    const value = adapter();
    value.expectManualCompaction();
    await value.adapt({ type: 'system', subtype: 'status', status: null, compact_result: status } as any);
    const events = await value.adapt(result);
    expect(events.map(e => e.type)).toEqual(['compaction_failed', 'complete']);
    expect(value.getContextUsage()?.usedTokens).toBe(419_000);
  });

  it('does not let an unrelated automatic boundary satisfy an explicitly requested compact', async () => {
    const value = adapter();
    value.expectManualCompaction();
    const events = await value.adapt({ ...boundary(12_000), compact_metadata: { trigger: 'auto', post_tokens: 12_000 } });
    expect(events.find(e => e.type === 'info')).toMatchObject({ compactionTrigger: 'auto' });
    expect((await value.adapt(result)).map(e => e.type)).toEqual(['compaction_failed', 'complete']);
  });

  it('uses only fresh main-thread assistant usage after a compaction', async () => {
    const value = adapter();
    await value.adapt(boundary());
    value.startTurn();
    const message = { type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 3_000 } } } as any;
    await value.adapt({ ...message, parent_tool_use_id: 'subagent' });
    await value.adapt({ ...message, isReplay: true });
    expect(value.getContextUsage()?.usedTokens).toBeNull();
    const events = await value.adapt(message);
    expect(events.find(e => e.type === 'context_usage')).toMatchObject({ contextUsage: { usedTokens: 12_050, isStale: false } });
  });
});
