import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { anyMatchPatternMatches, matchPatternMatches } from '../match'
import {
  buildSelectorMatchScript,
  buildTweaksInitScript,
  buildTweaksMatcherSource,
  buildTweaksProbeScript,
  type TweaksInitScriptTweak,
} from '../inject'
import { createTweak, getTweakCssPath, getTweakHitsPath, loadTweak } from '../storage'
import { readTweakHits, recordTweakHits, tweakTargets, writeTweakHits } from '../targets'
import { toTweakTargets } from '../summary'
import type { TweakTargetHit } from '../types'

// ---------------------------------------------------------------------------
// The generated matcher, run the way a page runs it
// ---------------------------------------------------------------------------

/**
 * The parity table, and the reason it exists.
 *
 * The grammar is implemented twice — `match.ts` host-side, and the generated javascript in
 * `inject.ts` — because an injected script cannot import. What keeps the two equal is this
 * one table run through both. A case added here is a case both must answer the same way.
 */
const PARITY: Array<[pattern: string, url: string, expected: boolean]> = [
  // scheme
  ['https://example.com/', 'https://example.com/', true],
  ['https://example.com/', 'http://example.com/', false],
  ['*://example.com/', 'http://example.com/', true],
  ['*://example.com/', 'https://example.com/', true],
  // `*` is the web's two schemes, not "anything".
  ['*://example.com/', 'file://example.com/', false],
  ['ftp://example.com/', 'ftp://example.com/', false],
  // host
  ['*://*.example.com/', 'https://example.com/', true],
  ['*://*.example.com/', 'https://app.example.com/', true],
  ['*://example.com/', 'https://app.example.com/', false],
  ['*://*.example.com/', 'https://notexample.com/', false],
  ['*://*/', 'https://anything.test/', true],
  // A pattern names a host, never a port, so a port written into one is not a pattern at
  // all — the same answer in both implementations.
  ['http://localhost:5173/*', 'http://localhost:5173/app', false],
  // path anchoring
  ['*://example.com/admin/*', 'https://example.com/admin/users', true],
  ['*://example.com/admin/*', 'https://example.com/admin/', true],
  // The pattern has that slash in it, so the bare prefix is a different page.
  ['*://example.com/admin/*', 'https://example.com/admin', false],
  // The distinction this grammar is for: an admin console must not reach a page that merely
  // starts the same way.
  ['*://example.com/admin/*', 'https://example.com/administrate', false],
  ['*://example.com/', 'https://example.com/other', false],
  ['*://example.com/admin/*', 'https://example.com/admin/a/b/c', true],
  ['*://example.com/', 'https://example.com/?q=1#top', true],
  // what neither can read
  ['not a pattern', 'https://example.com/', false],
  ['example.com/admin', 'https://example.com/admin', false],
  ['https://example.com', 'https://example.com/', false],
  ['*://example.com/a/*/b', 'https://example.com/a/x/b', false],
  ['*://example.com/', 'not a url', false],
]

/** The generated matcher, evaluated the way the page evaluates it. */
function pageMatcher(): (url: string, patterns: string[]) => boolean {
  return new Function(`${buildTweaksMatcherSource()}\nreturn tweakMatchUrl;`)() as (
    url: string,
    patterns: string[],
  ) => boolean
}

describe('the generated match-pattern test', () => {
  it('answers every case in the shared table exactly as the TypeScript matcher does', () => {
    const jsMatchUrl = pageMatcher()

    for (const [pattern, url, expected] of PARITY) {
      // The definition of a match is `match.ts`; this asserts the generated one agrees.
      expect(matchPatternMatches(pattern, url)).toBe(expected)
      expect(jsMatchUrl(url, [pattern])).toBe(expected)
    }
  })

  it('agrees on "any of a tweak’s patterns" too', () => {
    const jsMatchUrl = pageMatcher()
    const patterns = ['*://*.example.com/admin/*', 'https://other.test/report']

    for (const url of [
      'https://app.example.com/admin/users',
      'https://other.test/report',
      'https://other.test/',
      'https://example.com/admin',
    ]) {
      expect(jsMatchUrl(url, patterns)).toBe(anyMatchPatternMatches(patterns, url))
    }
  })
})

// ---------------------------------------------------------------------------
// The init script, run against a document
// ---------------------------------------------------------------------------

/**
 * A document just real enough to run the generated script against.
 *
 * Not a DOM: the point is to run the *generated* code cheaply and honestly rather than to
 * re-describe the browser. It has what the script touches — `head`, the `style[data-tweak]`
 * lookup and its removal, `createElement`, and `DOMContentLoaded` — and nothing else.
 */
function makePage(href: string) {
  interface FakeStyle {
    attrs: Record<string, string>
    textContent: string
    parentNode: unknown
    setAttribute(key: string, value: string): void
    getAttribute(key: string): string | null
    remove(): void
  }

  const styles = new Map<string, FakeStyle>()
  const listeners: Array<{ type: string; fn: () => void }> = []
  const errors: unknown[][] = []

  const head = {
    appendChild(child: FakeStyle) {
      child.parentNode = head
      styles.set(child.attrs['data-tweak'] ?? '', child)
    },
  }

  const document = {
    head,
    documentElement: head,
    createElement(): FakeStyle {
      const element: FakeStyle = {
        attrs: {},
        textContent: '',
        parentNode: null,
        setAttribute(key: string, value: string) {
          this.attrs[key] = value
        },
        getAttribute(key: string) {
          return this.attrs[key] ?? null
        },
        // The one element the script removes by itself: a style it no longer owns.
        remove() {
          styles.delete(this.attrs['data-tweak'] ?? '')
          this.parentNode = null
        },
      }
      return element
    },
    querySelector(selector: string) {
      const match = /^style\[data-tweak="(.*)"\]$/.exec(selector)
      return match ? styles.get(match[1] ?? '') ?? null : null
    },
    querySelectorAll(selector: string) {
      return selector === 'style[data-tweak]' ? [...styles.values()] : []
    },
    addEventListener(type: string, fn: () => void) {
      listeners.push({ type, fn })
    },
  }

  const window: Record<string, unknown> = {}
  const console = { error: (...args: unknown[]) => errors.push(args) }
  const location = { href }

  return {
    window,
    document,
    location,
    console,
    styles,
    listeners,
    errors,
    run(script: string) {
      new Function('window', 'document', 'location', 'console', script)(
        window,
        document,
        location,
        console,
      )
    },
  }
}

/** A tweak as the init script takes it, with only the pieces a case cares about. */
function tweak(over: Partial<TweaksInitScriptTweak> & { slug: string; matches: string[] }): TweaksInitScriptTweak {
  return { name: over.slug, css: null, js: null, ...over }
}

describe('buildTweaksInitScript', () => {
  it('leaves a tweak whose patterns do not cover the address out entirely', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'other-site', matches: ['*://*.other.test/*'], css: '.a{}', js: 'window.__ran = 1' }),
    ])
    const page = makePage('https://app.example.com/admin')
    page.run(script)

    expect(page.styles.size).toBe(0)
    expect(page.window.__craftTweaks).toEqual([])
    // Its javascript did not run: the filter is the tweak's patterns, not the host's filter.
    expect(page.window.__ran).toBeUndefined()
  })

  it('applies every matching tweak, and reports each one it applied', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'first', matches: ['*://*.example.com/*'], css: '.a{}', js: 'window.__first = true' }),
      tweak({ slug: 'second', matches: ['*://*.example.com/admin/*'], css: '.b{}' }),
    ])
    const page = makePage('https://app.example.com/admin/users')
    page.run(script)

    expect(page.styles.get('first')?.textContent).toBe('.a{}')
    expect(page.styles.get('second')?.textContent).toBe('.b{}')
    expect(page.window.__first).toBe(true)
    expect(page.window.__craftTweaks).toEqual(['first', 'second'])
  })

  it('runs a css-only tweak with no javascript wrapper at all', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'css-only', matches: ['*://example.com/*'], css: '.a{}' }),
    ])

    // One tweak, and it declares no javascript: nothing to catch, so no IIFE is emitted.
    expect(script).not.toContain('catch (err)')
  })

  it('gives each javascript body its own IIFE and try/catch', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'a', matches: ['*://example.com/*'], js: 'window.__a = 1' }),
      tweak({ slug: 'b', matches: ['*://example.com/*'], js: 'window.__b = 1' }),
    ])

    // Defensive wrapping, asserted structurally: a parse error cannot be caught (the script
    // has one document), but a body that throws must not take the next tweak with it.
    expect(script.split('catch (err) {').length - 1).toBe(2)
    expect(script.split('(() => {').length - 1).toBe(3) // the outer script + one per body
  })

  it('keeps a throwing tweak from stopping the one after it', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'broken', matches: ['*://example.com/*'], js: 'throw new Error("boom")' }),
      tweak({ slug: 'fine', matches: ['*://example.com/*'], css: '.fine{}', js: 'window.__fine = true' }),
    ])
    const page = makePage('https://example.com/')
    page.run(script)

    expect(page.errors).toHaveLength(1)
    expect(page.styles.get('fine')?.textContent).toBe('.fine{}')
    expect(page.window.__fine).toBe(true)
    // Both were applied, in order: the failure is the tweak's, not the document's.
    expect(page.window.__craftTweaks).toEqual(['broken', 'fine'])
  })

  it('survives a body that ends in a line comment', () => {
    // A body on one line would otherwise comment out the closers and break the whole script —
    // the hazard `patch-script.ts` documents, which is why every body is emitted on its own lines.
    const script = buildTweaksInitScript([
      tweak({ slug: 'note', matches: ['*://example.com/*'], js: 'window.__noted = 1 // keep going' }),
    ])
    const page = makePage('https://example.com/')
    page.run(script)

    expect(page.window.__noted).toBe(1)
    expect(page.window.__craftTweaks).toEqual(['note'])
  })

  it('replaces its stylesheet instead of adding a second one when it runs again', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'once', matches: ['*://example.com/*'], css: '.v1{}', js: 'window.__runs = (window.__runs || 0) + 1' }),
    ])
    const page = makePage('https://example.com/')
    page.run(script)

    // A different address is a route change: the script replays for it.
    page.location.href = 'https://example.com/next'
    page.run(buildTweaksInitScript([
      tweak({ slug: 'once', matches: ['*://example.com/*'], css: '.v2{}', js: 'window.__runs = (window.__runs || 0) + 1' }),
    ]))

    expect(page.styles.size).toBe(1)
    expect(page.styles.get('once')?.textContent).toBe('.v2{}')
    expect(page.window.__runs).toBe(2)
  })

  it('does nothing the second time it is evaluated against the same address', () => {
    const script = buildTweaksInitScript([
      tweak({ slug: 'same', matches: ['*://example.com/*'], css: '.a{}', js: 'window.__runs = (window.__runs || 0) + 1' }),
    ])
    const page = makePage('https://example.com/')
    // The host registers this for future documents and evaluates it now: the two passes must
    // not run the tweak's javascript twice.
    page.run(script)
    page.run(script)

    expect(page.window.__runs).toBe(1)
  })

  it('does not run a tweak’s javascript again when only its css changed', () => {
    const body = 'window.__runs = (window.__runs || 0) + 1'
    const page = makePage('https://example.com/')
    page.run(buildTweaksInitScript([
      tweak({ slug: 'styled', matches: ['*://example.com/*'], css: '.v1{}', js: body }),
    ]))
    // Editing the css is a reason to restyle the page and no reason at all to re-run code that
    // may have already appended something: the marks are per file, not per tweak.
    page.run(buildTweaksInitScript([
      tweak({ slug: 'styled', matches: ['*://example.com/*'], css: '.v2{}', js: body }),
    ]))

    expect(page.styles.get('styled')?.textContent).toBe('.v2{}')
    expect(page.window.__runs).toBe(1)
  })

  it('takes a switched-off tweak off the page it is already on, and can put it back', () => {
    const over = { slug: 'toggled', matches: ['*://example.com/*'], css: '.on{}', js: 'window.__runs = (window.__runs || 0) + 1' }
    const page = makePage('https://example.com/')
    page.run(buildTweaksInitScript([tweak(over)]))
    expect(page.styles.get('toggled')?.textContent).toBe('.on{}')

    // The switch flipped while the page was open: the host re-evaluates the script, and this
    // time the tweak is not in the set. Its style goes at once.
    page.run(buildTweaksInitScript([]))
    expect(page.styles.size).toBe(0)
    expect(page.window.__craftTweaks).toEqual([])

    // Back on: the mark was forgotten along with the style, so it runs again rather than
    // being suppressed as work already done.
    page.run(buildTweaksInitScript([tweak(over)]))
    expect(page.styles.get('toggled')?.textContent).toBe('.on{}')
    expect(page.window.__runs).toBe(2)
  })

  it('leaves another tweak alone when one is switched off', () => {
    const page = makePage('https://example.com/')
    const kept = tweak({ slug: 'kept', matches: ['*://example.com/*'], css: '.kept{}', js: 'window.__keptRuns = (window.__keptRuns || 0) + 1' })
    page.run(buildTweaksInitScript([
      tweak({ slug: 'dropped', matches: ['*://example.com/*'], css: '.dropped{}' }),
      kept,
    ]))

    page.run(buildTweaksInitScript([kept]))

    expect([...page.styles.keys()]).toEqual(['kept'])
    expect(page.window.__craftTweaks).toEqual(['kept'])
    // Untouched, not replayed: turning a *different* tweak off is no reason to re-run this one.
    expect(page.window.__keptRuns).toBe(1)
  })
})

describe('buildTweaksProbeScript', () => {
  it('reads back the applied slugs, and answers nothing when the page knows nothing', () => {
    const probe = new Function('window', `return ${buildTweaksProbeScript()};`) as (w: unknown) => unknown

    expect(probe({ __craftTweaks: ['a', 'b'] })).toEqual(['a', 'b'])
    // Defensive on purpose: a page that navigated, never ran, or was tampered with.
    expect(probe({})).toEqual([])
    expect(probe({ __craftTweaks: 'nope' })).toEqual([])
    expect(probe({ __craftTweaks: ['a', 1, null, 'b'] })).toEqual(['a', 'b'])
  })
})

describe('buildSelectorMatchScript', () => {
  it('answers per selector, and distinguishes "not there" from "could not check"', () => {
    const page = {
      document: {
        querySelector: (selector: string) => {
          if (selector === '.bad[') throw new Error('invalid selector')
          return selector === '.present' ? {} : null
        },
      },
    }
    const read = new Function('document', `return ${buildSelectorMatchScript(['.present', '.absent', '.bad['])};`) as (
      d: unknown,
    ) => Record<string, unknown>

    expect(read(page.document)).toEqual({ '.present': true, '.absent': false, '.bad[': null })
  })
})

// ---------------------------------------------------------------------------
// Hits recording — the same read/merge/write the injector does
// ---------------------------------------------------------------------------

describe('tweak hits recording', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'craft-tweaks-hit-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** One apply, as the injector performs it: read what is there, merge, write it back. */
  function apply(slug: string, targets: TweakTargetHit[], matched: string[], url: string, now: number): void {
    const path = getTweakHitsPath(root, slug)
    const existing = readTweakHits(path)
    writeTweakHits(path, recordTweakHits(existing, targets, new Set(matched), url, now))
  }

  /** The selectors a tweak's own files declare, read off disk. */
  function targetsOf(slug: string): TweakTargetHit[] {
    const loaded = loadTweak(root, slug)
    if (!loaded) throw new Error(`no tweak ${slug}`)
    return tweakTargets({
      css: loaded.hasCss ? readFileSync(loaded.cssPath, 'utf-8') : null,
      js: loaded.hasJs ? readFileSync(loaded.jsPath, 'utf-8') : null,
    })
  }

  it('leaves a never-matched target with no time at all', () => {
    const created = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/admin/*'], enabled: true })
    writeFileSync(getTweakCssPath(root, created.slug), '/* @target .present */\n/* @target .absent */\n.present{}')

    const targets = targetsOf(created.slug)
    apply(created.slug, targets, ['.present'], 'https://app.example.com/admin', 1_700_000_000_000)

    const hits = readTweakHits(getTweakHitsPath(root, created.slug))
    const recorded = new Map((hits?.targets ?? []).map((hit) => [hit.selector, hit]))
    expect(recorded.get('.present')?.lastMatchedAt).toBe(1_700_000_000_000)
    // "Never matched" is the absence of a time — a different fact from "stopped matching".
    expect(recorded.get('.absent')?.lastMatchedAt).toBeUndefined()
  })

  it('marks a target stale when a later apply no longer sees it', () => {
    const created = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/admin/*'], enabled: true })
    writeFileSync(getTweakCssPath(root, created.slug), '/* @target .row */\n.row{}')
    const targets = targetsOf(created.slug)

    apply(created.slug, targets, ['.row'], 'https://app.example.com/admin', 1_700_000_000_000)
    apply(created.slug, targets, [], 'https://app.example.com/admin', 1_700_000_001_000)

    const loaded = loadTweak(root, created.slug)
    if (!loaded) throw new Error('no tweak')
    const info = toTweakTargets(loaded, readTweakHits(getTweakHitsPath(root, created.slug)))
    expect(info[0]?.stale).toBe(true)
    // The time it did match is kept, which is what makes the staleness visible.
    expect(info[0]?.lastMatchedAt).toBe(1_700_000_000_000)
  })

  it('merges into the record that is already there instead of replacing it', () => {
    const created = createTweak(root, { name: 'Order ids', matches: ['*://*.example.com/admin/*'], enabled: true })
    writeFileSync(
      getTweakCssPath(root, created.slug),
      '/* @target .row */\n/* @target .total */\n.row{}',
    )
    const targets = targetsOf(created.slug)

    apply(created.slug, targets, ['.row'], 'https://app.example.com/admin', 1_700_000_000_000)
    // A second apply that sees only the other selector: the first one's time must survive.
    apply(created.slug, targets, ['.total'], 'https://app.example.com/admin', 1_700_000_001_000)

    const hits = readTweakHits(getTweakHitsPath(root, created.slug))
    const recorded = new Map((hits?.targets ?? []).map((hit) => [hit.selector, hit]))
    expect(recorded.get('.row')?.lastMatchedAt).toBe(1_700_000_000_000)
    expect(recorded.get('.total')?.lastMatchedAt).toBe(1_700_000_001_000)
    expect(hits?.updatedAt).toBe(1_700_000_001_000)
  })
})
