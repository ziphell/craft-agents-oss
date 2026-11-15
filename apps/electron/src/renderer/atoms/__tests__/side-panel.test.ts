import { describe, expect, it } from 'bun:test'
import { normalizeSidePanelState, PROJECT_DETAIL_PATH } from '../side-panel'

describe('the side panel’s saved tabs', () => {
  it('drops a legacy cut tab, which would otherwise fall through to the JSON viewer', () => {
    const state = normalizeSidePanelState({
      paths: [PROJECT_DETAIL_PATH, '/p/reels/预告.edit.json', '/p/reels/预告.reel'],
      active: '/p/reels/预告.reel',
    })

    expect(state.paths).toEqual([PROJECT_DETAIL_PATH, '/p/reels/预告.reel'])
    expect(state.active).toBe('/p/reels/预告.reel')
  })

  it('keeps a .reel cut and an ordinary json file', () => {
    const state = normalizeSidePanelState({
      paths: [PROJECT_DETAIL_PATH, '/p/reels/预告.reel', '/p/assets/.index.json'],
      active: '/p/assets/.index.json',
    })

    expect(state.paths).toEqual([
      PROJECT_DETAIL_PATH,
      '/p/reels/预告.reel',
      '/p/assets/.index.json',
    ])
  })

  it('falls back to the project tab when the tab that was in front is gone', () => {
    const state = normalizeSidePanelState({
      paths: [PROJECT_DETAIL_PATH, '/p/reels/预告.edit.json'],
      active: '/p/reels/预告.edit.json',
    })

    expect(state).toEqual({ paths: [PROJECT_DETAIL_PATH], active: PROJECT_DETAIL_PATH })
  })
})
