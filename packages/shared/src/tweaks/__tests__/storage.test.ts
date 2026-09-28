import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createTweak,
  deleteTweak,
  getTweakCssPath,
  getTweakHitsPath,
  getTweakJsPath,
  getTweakPath,
  loadTweak,
  loadWorkspaceTweaks,
  readTweakSources,
  tweakExists,
  tweaksForUrl,
  updateTweak,
} from '../storage'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-tweaks-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('createTweak', () => {
  it('makes a folder with a config, and refuses a tweak with no pages', () => {
    const tweak = createTweak(root, { name: 'Admin console: order ids', matches: ['*://*.example.com/admin/*'] })

    expect(tweak.slug).toBe('admin-console-order-ids')
    expect(existsSync(join(getTweakPath(root, tweak.slug), 'tweak.json'))).toBe(true)

    expect(() => createTweak(root, { name: 'Nothing', matches: [] })).toThrow(/at least one match pattern/)
  })

  it('refuses a pattern that could never match', () => {
    expect(() => createTweak(root, { name: 'Typo', matches: ['example.com/admin'] })).toThrow(/match pattern/)
  })

  // Naming the pages is not the same consent as running the code in them.
  it('arrives switched off unless it is asked for', () => {
    const paused = createTweak(root, { name: 'Paused', matches: ['*://*.example.com/*'] })
    const on = createTweak(root, {
      name: 'On',
      matches: ['*://*.example.com/*'],
      enabled: true,
    })

    expect(paused.enabled).toBe(false)
    expect(on.enabled).toBe(true)
  })

  it('gives two tweaks with the same name two folders', () => {
    const first = createTweak(root, { name: 'Same', matches: ['*://a.test/*'] })
    const second = createTweak(root, { name: 'Same', matches: ['*://b.test/*'] })

    expect(first.slug).not.toBe(second.slug)
  })
})

describe('a tweak on disk', () => {
  it('reads its sources, and says which of the two files are there', () => {
    const tweak = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/*'] })
    expect(loadTweak(root, tweak.slug)?.empty).toBe(true)
    expect(loadTweak(root, tweak.slug)?.hasCss).toBe(false)

    writeFileSync(getTweakCssPath(root, tweak.slug), '/* @target .row */')
    const loaded = loadTweak(root, tweak.slug)!

    expect(loaded.empty).toBe(false)
    expect(loaded.hasCss).toBe(true)
    // A path alone does not say whether the file is there — that is why both are reported.
    expect(loaded.hasJs).toBe(false)
    expect(readTweakSources(loaded).css).toContain('@target')
    expect(readTweakSources(loaded).js).toBeNull()
  })

  it('updates the fields an edit may change, and never the slug', () => {
    const tweak = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/*'] })
    const updated = updateTweak(root, tweak.slug, {
      name: 'Order ids (v2)',
      matches: ['*://*.example.com/admin/*'],
      enabled: true,
      description: 'shows the id beside the name',
    })

    expect(updated.slug).toBe(tweak.slug)
    expect(updated.name).toBe('Order ids (v2)')
    expect(updated.enabled).toBe(true)

    const cleared = updateTweak(root, tweak.slug, { description: null })
    expect(cleared.description).toBeUndefined()
  })

  it('refuses an edit that would leave it matching nothing', () => {
    const tweak = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/*'] })

    expect(() => updateTweak(root, tweak.slug, { matches: [] })).toThrow(/at least one match pattern/)
    expect(() => updateTweak(root, tweak.slug, { matches: ['nonsense'] })).toThrow(/match pattern/)
  })

  it('deletes the whole folder', () => {
    const tweak = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/*'] })
    deleteTweak(root, tweak.slug)

    expect(tweakExists(root, tweak.slug)).toBe(false)
    expect(existsSync(getTweakPath(root, tweak.slug))).toBe(false)
  })

  it('lists the workspace’s tweaks by name, ignoring anything that is not one', () => {
    createTweak(root, { name: 'Zebra', matches: ['*://z.test/*'] })
    createTweak(root, { name: 'Apple', matches: ['*://a.test/*'] })
    writeFileSync(join(root, 'tweaks', 'README.md'), 'not a tweak')

    expect(loadWorkspaceTweaks(root).map((tweak) => tweak.config.name)).toEqual(['Apple', 'Zebra'])
  })
})

describe('tweaksForUrl', () => {
  it('answers only with the tweaks that are switched on and match', () => {
    const on = createTweak(root, { name: 'On', matches: ['*://*.example.com/admin/*'], enabled: true })
    createTweak(root, { name: 'Paused', matches: ['*://*.example.com/admin/*'] })

    expect(tweaksForUrl(root, 'https://app.example.com/admin/users').map((tweak) => tweak.config.slug)).toEqual([on.slug])
    expect(tweaksForUrl(root, 'https://app.example.com/other')).toEqual([])
  })

  it('reads the hits record where it lives, next to the tweak', () => {
    const tweak = createTweak(root, { name: 'On', matches: ['*://*.example.com/*'], enabled: true })

    expect(getTweakHitsPath(root, tweak.slug)).toBe(join(getTweakPath(root, tweak.slug), 'hits.json'))
    expect(getTweakJsPath(root, tweak.slug)).toBe(join(getTweakPath(root, tweak.slug), 'tweak.js'))
  })
})
