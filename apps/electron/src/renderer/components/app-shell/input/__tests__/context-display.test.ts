import { describe, expect, it } from 'bun:test'
import { getContextDisplay, shouldShowCompactBadge } from '../context-display'

describe('truthful context occupancy', () => {
  it('uses the resolved compaction window and does not cap over-limit usage at 99%', () => {
    expect(getContextDisplay({ inputTokens: 900000, contextUsage: {
      usedTokens: 419000, limitTokens: 200000, limitKind: 'compaction', isEstimate: false, isStale: false, canCompact: true,
    } }, 1000000)).toMatchObject({ usedTokens: 419000, limitTokens: 200000, limitKind: 'compaction', percent: 210, canCompact: true, showWarning: true })
  })
  it('never restores legacy pre-compaction counts when a snapshot is unknown/stale', () => {
    expect(getContextDisplay({ inputTokens: 419000, contextUsage: {
      usedTokens: null, limitKind: 'context', isEstimate: true, isStale: true, canCompact: true,
    } }, 1000000)).toMatchObject({ usedTokens: null, limitTokens: null, percent: null, isStale: true, showWarning: false })
  })
  it('treats legacy counts as estimates against model capacity, never invented policy/capability', () => {
    expect(getContextDisplay({ inputTokens: 180000 }, 200000)).toMatchObject({ percent: 90, limitKind: 'context', isEstimate: true, canCompact: false })
  })
  it('shows fresh zero and supports a real post-compaction drop', () => {
    expect(getContextDisplay({ contextUsage: { usedTokens: 0, limitTokens: 200000, limitKind: 'context', isEstimate: false, isStale: false, canCompact: false } })).toMatchObject({ visible: true, usedTokens: 0, percent: 0 })
    expect(getContextDisplay({ contextUsage: { usedTokens: 12000, limitTokens: 200000, limitKind: 'compaction', isEstimate: true, isStale: false, canCompact: true } })).toMatchObject({ percent: 6, showWarning: false })
  })
  it('measures occupancy against the compaction window, not a share of the raw window', () => {
    // Real config: contextWindow 1,000,000 with reserveTokens 16,384, so the SDK
    // compacts above 983,616. A legacy per-turn count must not drive the number:
    // a 0.775-of-raw-window heuristic would read 99% at ~767k, ~216k early.
    const snapshot = { usedTokens: 963_943, limitTokens: 983_616, limitKind: 'compaction' as const, isEstimate: true, isStale: false, canCompact: true }
    expect(getContextDisplay({ inputTokens: 500_000, contextUsage: snapshot })).toMatchObject({
      usedTokens: 963_943, limitTokens: 983_616, percent: 98, showWarning: true,
    })
  })
  it('shows the compact badge near the compaction window only, and never without compaction', () => {
    const nearFull = { usedTokens: 963_943, limitTokens: 983_616, limitKind: 'compaction' as const, isEstimate: true, isStale: false, canCompact: true }
    const halfFull = { ...nearFull, usedTokens: 500_000 }
    expect(shouldShowCompactBadge(getContextDisplay({ contextUsage: nearFull }))).toBe(true)
    expect(shouldShowCompactBadge(getContextDisplay({ contextUsage: halfFull }))).toBe(false)
    // A raw near-full window with no compaction to offer must stay quiet.
    expect(shouldShowCompactBadge(getContextDisplay({ inputTokens: 900_000 }, 1_000_000))).toBe(false)
  })
  it('does not invent a limit for snapshots or show a stale count as a live warning', () => {
    expect(getContextDisplay({ contextUsage: { usedTokens: 419000, limitKind: 'compaction', isEstimate: false, isStale: true, canCompact: false } }, 200000)).toMatchObject({ limitTokens: null, percent: null, showWarning: false })
    expect(getContextDisplay(undefined, 200000).visible).toBe(false)
  })
})
