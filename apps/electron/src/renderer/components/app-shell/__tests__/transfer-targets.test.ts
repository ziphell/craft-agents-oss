import { describe, expect, it } from 'bun:test'
import type { Workspace } from '../../../../shared/types'
import { getTransferTargets, hasTransferTargets } from '../transfer-targets'

function ws(id: string): Workspace {
  return { id, name: id } as unknown as Workspace
}

describe('getTransferTargets', () => {
  it('offers every workspace except the active one', () => {
    const all = [ws('workspace-a'), ws('workspace-b'), ws('workspace-c')]

    const targets = getTransferTargets(all, 'workspace-a')

    expect(targets.map(w => w.id)).toEqual(['workspace-b', 'workspace-c'])
  })

  it('offers everything when no active workspace is known', () => {
    const all = [ws('workspace-a'), ws('workspace-b')]

    expect(getTransferTargets(all, null)).toHaveLength(2)
  })
})

describe('hasTransferTargets', () => {
  it('is false with a single (active-only) workspace', () => {
    expect(hasTransferTargets([ws('workspace-a')])).toBe(false)
  })

  it('is true with two workspaces', () => {
    expect(hasTransferTargets([ws('workspace-a'), ws('workspace-b')])).toBe(true)
  })

  it('handles missing workspace lists', () => {
    expect(hasTransferTargets(undefined)).toBe(false)
    expect(hasTransferTargets(null)).toBe(false)
    expect(hasTransferTargets([])).toBe(false)
  })
})
