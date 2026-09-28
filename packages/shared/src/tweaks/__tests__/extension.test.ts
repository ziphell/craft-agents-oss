import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildTweaksExtension, exportTweaksExtension, TWEAKS_EXTENSION_DIRNAME } from '../extension'
import { createTweak, getTweakCssPath, getTweakJsPath, loadWorkspaceTweaks } from '../storage'

let root = ''

const BUILT_AT = new Date('2026-09-24T10:30:00Z')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-tweaks-ext-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A tweak with code in it, switched on. */
function withTweak(name: string, matches: string[], code: { css?: string; js?: string } = {}): string {
  const tweak = createTweak(root, { name, matches, enabled: true })
  if (code.css !== undefined) writeFileSync(getTweakCssPath(root, tweak.slug), code.css)
  if (code.js !== undefined) writeFileSync(getTweakJsPath(root, tweak.slug), code.js)
  return tweak.slug
}

function manifestOf(files: Array<{ path: string; content: string }>): Record<string, unknown> {
  const manifest = files.find((file) => file.path === 'manifest.json')
  if (!manifest) throw new Error('no manifest')
  return JSON.parse(manifest.content) as Record<string, unknown>
}

describe('buildTweaksExtension', () => {
  it('turns each tweak into a content script over the pages it names', () => {
    withTweak('Order ids', ['*://*.example.com/admin/*'], { css: '.row{}', js: 'void 0' })
    const build = buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)

    const manifest = manifestOf(build.files) as {
      manifest_version: number
      version: string
      content_scripts: Array<Record<string, unknown>>
    }
    expect(manifest.manifest_version).toBe(3)
    // `1.<days>.<minutes>` — monotonic, so a reviewer can tell one build from the next.
    expect(manifest.version).toMatch(/^1\.\d+\.\d+$/)
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['*://*.example.com/admin/*'],
        run_at: 'document_start',
        css: ['tweaks/order-ids.css'],
        js: ['tweaks/order-ids.js'],
      },
    ])
  })

  it('ships the tweak’s own bytes, not a build of them', () => {
    const css = '/* @target .row */\n.row { color: red }'
    withTweak('Order ids', ['*://*.example.com/*'], { css })

    const build = buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)

    expect(build.files.find((file) => file.path === 'tweaks/order-ids.css')?.content).toBe(css)
  })

  it('carries a tweak that has only one of the two files', () => {
    withTweak('Css only', ['*://a.test/*'], { css: '.x{}' })
    const build = buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)

    const scripts = (manifestOf(build.files) as { content_scripts: Array<Record<string, unknown>> }).content_scripts
    expect(scripts[0]).not.toHaveProperty('js')
    expect(scripts[0]).toHaveProperty('css')
  })

  // The switch is a person's, and it means the same thing in both carriers.
  it('leaves out a tweak that is switched off, and says so', () => {
    createTweak(root, { name: 'Paused', matches: ['*://a.test/*'] })
    withTweak('On', ['*://b.test/*'], { css: '.x{}' })

    const build = buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)

    expect(build.included).toEqual(['on'])
    expect(build.skipped).toEqual([{ slug: 'paused', why: 'switched off' }])
    expect((manifestOf(build.files) as { content_scripts: unknown[] }).content_scripts).toHaveLength(1)
  })

  it('leaves out a tweak with nothing to inject, and refuses to build an empty extension', () => {
    expect(withTweak('Empty', ['*://a.test/*'])).toBe('empty')

    // An extension with no content scripts is not a smaller delivery, it is a
    // meaningless one — so this is an error rather than an empty package.
    expect(() => buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)).toThrow(/nothing to build/)
  })

  // The README is the only credential this package has, so it has to name what runs where.
  it('writes a note that says what it changes and how to load it', () => {
    withTweak('Order ids', ['*://*.example.com/admin/*'], { css: '.row{}' })
    const build = buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)
    const readme = build.files.find((file) => file.path === 'README.md')?.content ?? ''

    expect(readme).toContain('Order ids')
    expect(readme).toContain('`*://*.example.com/admin/*`')
    expect(readme).toContain('Load unpacked')
    expect(readme).toContain('chrome://extensions')
  })
})

describe('exportTweaksExtension', () => {
  it('writes the extension into its own folder', () => {
    withTweak('Order ids', ['*://*.example.com/*'], { css: '.row{}' })
    const dest = mkdtempSync(join(tmpdir(), 'craft-tweaks-dest-'))
    try {
      const result = exportTweaksExtension(root, dest, BUILT_AT)

      expect(result.dir).toBe(join(dest, TWEAKS_EXTENSION_DIRNAME))
      expect(result.tweaks).toBe(1)
      expect(existsSync(join(result.dir, 'manifest.json'))).toBe(true)
      expect(readFileSync(join(result.dir, 'tweaks', 'order-ids.css'), 'utf-8')).toBe('.row{}')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('refuses to write over an extension that is already there', () => {
    withTweak('Order ids', ['*://*.example.com/*'], { css: '.row{}' })
    const dest = mkdtempSync(join(tmpdir(), 'craft-tweaks-dest-'))
    try {
      exportTweaksExtension(root, dest, BUILT_AT)

      expect(() => exportTweaksExtension(root, dest, BUILT_AT)).toThrow(/already exists/)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
