import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getTweakHitsPath,
  readTweakHits,
  recordTweakHits,
  tweakTargets,
  writeTweakHits,
} from '@craft-agent/shared/tweaks'
import { buildTweaksToolCallbacks } from '../tool-callbacks'

let root = ''
let mutated: string[] = []

function callbacks() {
  return buildTweaksToolCallbacks({
    workspaceRootPath: root,
    onTweaksMutated: (slug) => { mutated.push(slug) },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-tweaks-tool-'))
  mutated = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('create_tweak', () => {
  it('writes the code it was given and answers with the tweak in full', async () => {
    const created = await callbacks().createTweak({
      name: 'Order ids',
      matches: ['*://*.example.com/admin/*'],
      css: '/* @target .row */\n.row { color: red }',
      js: 'void 0',
    })

    expect(created.slug).toBe('order-ids')
    expect(created.hasCode).toBe(true)
    expect(existsSync(created.cssPath)).toBe(true)
    expect(existsSync(created.jsPath)).toBe(true)

    // The `@target` the code declares is what makes it checkable later, so it comes
    // back parsed rather than left for the reader to grep for.
    expect(created.targets).toEqual([{ selector: '.row', file: 'tweak.css', stale: false }])
    expect(created.appliedAt).toBeNull()
    expect(mutated).toEqual(['order-ids'])
  })

  // Naming the pages is not the consent — see the tool's own description.
  it('is off unless it was asked to be on', async () => {
    const paused = await callbacks().createTweak({ name: 'Paused', matches: ['*://a.test/*'] })
    const on = await callbacks().createTweak({ name: 'On', matches: ['*://b.test/*'], enabled: true })

    expect(paused.enabled).toBe(false)
    expect(on.enabled).toBe(true)
  })
})

describe('get_tweak', () => {
  it('answers null for a tweak that is not there', async () => {
    expect(await callbacks().getTweak('nope')).toBeNull()
  })

  /**
   * The whole reason a record is kept: a selector that matched before and did not the
   * last time the tweak ran is a page that moved, not a tweak that never worked.
   */
  it('reports a target that stopped matching as stale', async () => {
    const tweak = await callbacks().createTweak({
      name: 'Order ids',
      matches: ['*://*.example.com/*'],
      css: '/* @target .row */\n/* @target .never */',
    })

    // First run: `.row` matched.
    const declared = tweakTargets({
      css: '/* @target .row */\n/* @target .never */',
      js: null,
    })
    const first = recordTweakHits(null, declared, new Set(['.row']), 'https://app.example.com/admin', 1_000)
    writeTweakHits(getTweakHitsPath(root, tweak.slug), first)

    expect((await callbacks().getTweak(tweak.slug))?.targets).toEqual([
      { selector: '.row', file: 'tweak.css', lastMatchedAt: 1_000, stale: false },
      { selector: '.never', file: 'tweak.css', stale: false },
    ])

    // Second run: nothing matched, and the record was written after the last match.
    const second = recordTweakHits(first, declared, new Set(), 'https://app.example.com/admin', 2_000)
    writeTweakHits(getTweakHitsPath(root, tweak.slug), second)

    const details = (await callbacks().getTweak(tweak.slug))!
    expect(details.appliedAt).toBe(2_000)
    expect(details.targets[0]).toEqual({
      selector: '.row',
      file: 'tweak.css',
      lastMatchedAt: 1_000,
      stale: true,
    })
    // Never matched at all is a different answer from stopped matching.
    expect(details.targets[1]?.stale).toBe(false)

    expect(readTweakHits(getTweakHitsPath(root, tweak.slug))?.updatedAt).toBe(2_000)
  })
})

describe('update_tweak', () => {
  it('changes what an edit may change, and pokes the watcher', async () => {
    const tweak = await callbacks().createTweak({ name: 'Order ids', matches: ['*://a.test/*'] })
    mutated.length = 0

    const updated = await callbacks().updateTweak(tweak.slug, { enabled: true, matches: ['*://b.test/*'] })

    expect(updated.enabled).toBe(true)
    expect(updated.matches).toEqual(['*://b.test/*'])
    expect(mutated).toEqual([tweak.slug])
  })

  it('refuses a slug that does not exist', async () => {
    expect(() => callbacks().updateTweak('nope', { enabled: true })).toThrow(/not found/)
  })
})

describe('delete_tweak', () => {
  it('removes the folder, and refuses a tweak that is not there', async () => {
    const tweak = await callbacks().createTweak({ name: 'Order ids', matches: ['*://a.test/*'] })

    expect(await callbacks().deleteTweak(tweak.slug)).toEqual({ deleted: true })
    expect(callbacks().getTweak(tweak.slug)).toBeNull()
    expect(() => callbacks().deleteTweak(tweak.slug)).toThrow(/not found/)
  })
})
