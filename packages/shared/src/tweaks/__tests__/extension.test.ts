import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { buildTweaksExtension, exportTweaksExtension, tweaksExtensionFolderName } from '../extension'
import { createTweak, deleteTweak, getTweakCssPath, getTweakJsPath, loadWorkspaceTweaks } from '../storage'

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
    // Two entries, because `run_at` governs the javascript: the stylesheet keeps the earliest
    // moment so the page never flashes the state the tweak is there to change. The javascript
    // goes in the page's own world, which is where the app puts it.
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['*://*.example.com/admin/*'],
        run_at: 'document_start',
        css: ['tweaks/order-ids.css'],
      },
      {
        matches: ['*://*.example.com/admin/*'],
        run_at: 'document_end',
        world: 'MAIN',
        js: ['tweaks/order-ids.js'],
      },
    ])
  })

  it('delivers the javascript at the moment the tweak declares', () => {
    withTweak('Late', ['*://a.test/*'], { css: '.x{}', js: '/* @run-at document_idle */\nvoid 0' })
    const build = buildTweaksExtension(loadWorkspaceTweaks(root), BUILT_AT)

    const scripts = (manifestOf(build.files) as { content_scripts: Array<Record<string, unknown>> }).content_scripts
    expect(scripts.map((entry) => entry.run_at)).toEqual(['document_start', 'document_idle'])
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

describe('tweaksExtensionFolderName', () => {
  it('names the folder after the tweak, keeping it a name a filesystem accepts', () => {
    expect(tweaksExtensionFolderName('Order ids')).toBe('Order ids')
    expect(tweaksExtensionFolderName('a/b:c*d?')).toBe('a-b-c-d-')
    expect(tweaksExtensionFolderName('   ')).toBe('tweaks')
  })
})

describe('exportTweaksExtension', () => {
  const request = (destParent: string) => ({
    workspaceRootPath: root,
    destParent,
    folderName: 'Order ids',
    builtAt: BUILT_AT,
  })

  it('writes the extension into a folder named after the tweak', () => {
    withTweak('Order ids', ['*://*.example.com/*'], { css: '.row{}' })
    const dest = mkdtempSync(join(tmpdir(), 'craft-tweaks-dest-'))
    try {
      const result = exportTweaksExtension(request(dest))
      if (result.status !== 'exported') throw new Error('expected an export')

      // That folder **is** the extension, named after the tweak — so Load unpacked points
      // straight at it and nobody had to invent a name.
      expect(result.dir).toBe(join(resolve(dest), 'Order ids'))
      expect(result.tweaks).toBe(1)
      expect(existsSync(join(result.dir, 'manifest.json'))).toBe(true)
      expect(readFileSync(join(result.dir, 'tweaks', 'order-ids.css'), 'utf-8')).toBe('.row{}')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('asks before replacing an existing export, then replaces it wholesale', () => {
    const gone = withTweak('Order ids', ['*://*.example.com/*'], { css: '.row{}' })
    const dest = mkdtempSync(join(tmpdir(), 'craft-tweaks-dest-'))
    try {
      exportTweaksExtension(request(dest))

      // The folder is already there: the answer is a question, not a build.
      expect(exportTweaksExtension(request(dest))).toEqual({
        status: 'exists',
        dir: join(resolve(dest), 'Order ids'),
      })

      // Their yes replaces the whole folder, so a deleted tweak's script cannot linger.
      deleteTweak(root, gone)
      withTweak('Kept', ['*://*.example.com/*'], { js: 'void 0' })
      const replaced = exportTweaksExtension({ ...request(dest), overwrite: true })

      expect(replaced.status).toBe('exported')
      expect(existsSync(join(dest, 'Order ids', 'tweaks', 'order-ids.css'))).toBe(false)
      expect(existsSync(join(dest, 'Order ids', 'tweaks', 'kept.js'))).toBe(true)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  it('refuses a folder of that name that is not an export', () => {
    withTweak('Order ids', ['*://*.example.com/*'], { css: '.row{}' })
    const dest = mkdtempSync(join(tmpdir(), 'craft-tweaks-dest-'))
    try {
      const folder = join(dest, 'Order ids')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'notes.txt'), 'hello')

      expect(() => exportTweaksExtension(request(dest))).toThrow(/isn't a tweak export/)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
