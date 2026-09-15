import { describe, expect, it } from 'bun:test'
import { buildOverlayPreviewHtml, buildPatchBundle, toBookmarkletUrl } from '../bookmarklet'
import type { PrototypePatch } from '../types'

const cssPatch: PrototypePatch = {
  file: 'A-001-btn.css',
  kind: 'css',
  lane: 'A',
  order: 1,
  source: '.btn { color: red }',
  key: 'k1',
}

const jsPatch: PrototypePatch = {
  file: 'B-002-badge.js',
  kind: 'js',
  lane: 'B',
  order: 2,
  source: "document.querySelector('.total')?.classList.add('is-big');",
  key: 'k2',
}

const TARGET = 'https://app.example.com/checkout'

/**
 * Run a bundle the way a page would, with just enough environment for it to
 * work: a head to append to, a history to hook, a window to hang the install on.
 */
function runBundle(bundle: string, options: { root?: boolean; installed?: boolean } = {}): {
  events: string[]
  styles: Array<{ id: string; textContent: string }>
  history: Record<string, (...args: unknown[]) => unknown>
} {
  const events: string[] = []
  const styles: Array<{ id: string; textContent: string }> = []
  const hasRoot = options.root !== false
  const head = hasRoot
    ? {
        appendChild: (node: { id: string; textContent: string }) => styles.push(node),
      }
    : null

  const document = {
    head,
    documentElement: hasRoot ? { appendChild: () => undefined } : null,
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: (type: string) => events.push(type),
  }
  const history: Record<string, (...args: unknown[]) => unknown> = {
    pushState: () => undefined,
    replaceState: () => undefined,
  }
  const window: Record<string, unknown> = {
    addEventListener: (type: string) => events.push(`window:${type}`),
  }
  if (options.installed) window.__craft_prototype_checkout_flow__ = { apply: () => events.push('reused') }

  new Function('document', 'history', 'window', 'console', bundle)(
    document,
    history,
    window,
    { error: () => undefined },
  )

  return { events, styles, history }
}

describe('buildPatchBundle', () => {
  it('replays every patch in the order it was given', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch, jsPatch])

    expect(bundle.indexOf('.btn { color: red }')).toBeLessThan(bundle.indexOf('is-big'))
  })

  /**
   * The patches go through the same transform the live injector uses, so the
   * preview cannot behave differently from what the workbench shows. What this
   * asserts is that reuse, not the transform itself (patch-script.test.ts owns it).
   */
  it('reuses the live transform for both kinds', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch, jsPatch])

    // A css patch owns a `<style>` element keyed by its file name.
    expect(bundle).toContain('__craft_patch_A-001-btn_css')
    // A js patch is wrapped so one failure cannot abort the rest of the bundle.
    expect(bundle).toContain('} catch (err) {')
  })

  it('installs once, and re-runs the install on a second click', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch])

    expect(bundle).toContain('__craft_prototype_checkout_flow__')
    expect(bundle).toContain('if (installed) { installed.apply(); return; }')
  })

  /**
   * A single-page app swaps views without a reload, and the view it lands on is a
   * page the patches have never seen. Without these hooks the preview would
   * silently stop at the first route change.
   */
  it('replays on view changes', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch])

    expect(bundle).toContain("['pushState', 'replaceState']")
    expect(bundle).toContain("window.addEventListener('popstate', apply)")
  })

  it('is executable JavaScript, and survives a patch ending in a line comment', () => {
    const bundle = buildPatchBundle('checkout-flow', [{ ...jsPatch, source: '// nothing to do' }])

    expect(() => new Function(bundle)).not.toThrow()
  })

  it('runs against a page-like environment without throwing', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch, jsPatch])
    expect(() => runBundle(bundle)).not.toThrow()
  })

  it('injects the css patch as a stylesheet on the page', () => {
    const { styles } = runBundle(buildPatchBundle('checkout-flow', [cssPatch]))

    expect(styles).toHaveLength(1)
    expect(styles[0]!.id).toBe('__craft_patch_A-001-btn_css')
    expect(styles[0]!.textContent).toBe('.btn { color: red }')
  })

  it('re-runs the existing install on a second click instead of adding a second one', () => {
    const { events, styles } = runBundle(buildPatchBundle('checkout-flow', [cssPatch]), { installed: true })

    expect(events).toContain('reused')
    // Nothing was injected twice: the page already had this prototype installed.
    expect(styles).toHaveLength(0)
  })

  it('is a no-op when the page arrives before its head exists', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch])

    expect(() => runBundle(bundle, { root: false })).not.toThrow()
  })
})

describe('toBookmarkletUrl', () => {
  const bundle = buildPatchBundle('checkout-flow', [cssPatch])

  it('is a javascript: URL a bookmarks bar can hold', () => {
    const url = toBookmarkletUrl(bundle)

    expect(url.startsWith('javascript:')).toBe(true)
    // Percent-encoded: a raw quote, newline or `<` in the code would break the
    // bookmark (and the `href` it is dragged from) rather than run.
    expect(url).not.toContain('"')
    expect(url).not.toContain('\n')
    expect(url).not.toContain('<')
  })

  it('carries the bundle verbatim once decoded', () => {
    const url = toBookmarkletUrl(bundle)
    const decoded = decodeURIComponent(url.slice('javascript:'.length))

    expect(decoded).toContain(bundle)
  })

  /**
   * A `javascript:` URL whose last expression evaluates to a string is rendered
   * as a document, replacing the page being patched. `void 0` is what prevents
   * that, so it is not decoration.
   */
  it('ends with the guard that stops it from navigating away', () => {
    const decoded = decodeURIComponent(toBookmarkletUrl(bundle).slice('javascript:'.length))

    expect(decoded.trimEnd().endsWith(';void 0')).toBe(true)
  })
})

describe('buildOverlayPreviewHtml', () => {
  const patches = [cssPatch, jsPatch]
  const html = buildOverlayPreviewHtml('checkout-flow', TARGET, patches)

  it('names the page the changes belong to', () => {
    expect(html).toContain(`Applies to: ${TARGET}`)
    expect(html).toContain(`<code>${TARGET}</code>`)
  })

  it('carries a draggable bookmark, not a script tag', () => {
    expect(html).toContain(`href="${toBookmarkletUrl(buildPatchBundle('checkout-flow', patches))}"`)
    // Self-contained: no remote script, no remote stylesheet, no fetch — the file
    // has to work for someone who does not have the workbench at all.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<link')
  })

  /**
   * A page that forbids inline scripts also refuses the bookmarklet, so the same
   * bundle has to be reachable a second way. Without this the recipient sees a
   * bookmark do nothing and concludes the preview is broken.
   */
  it('offers the same bundle as a console snippet for CSP-strict pages', () => {
    expect(html).toContain('Content-Security-Policy')

    // The snippet is the same code, not a paraphrase of it — the fallback is only
    // worth having if it does exactly what the bookmark would have done.
    const inTextarea = html.slice(html.indexOf('<textarea'), html.indexOf('</textarea>'))
    const snippet = inTextarea
      .slice(inTextarea.indexOf('>') + 1)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')

    expect(snippet).toBe(buildPatchBundle('checkout-flow', patches))
  })

  it('lists what will be changed, so the recipient can read before running it', () => {
    expect(html).toContain('<code>A-001-btn.css</code> — css, lane A')
    expect(html).toContain('<code>B-002-badge.js</code> — js, lane B')
  })

  it('escapes anything a patch file name could smuggle into the page', () => {
    const hostile = { ...cssPatch, file: '<img src=x onerror=alert(1)>.css' }
    const rendered = buildOverlayPreviewHtml('checkout-flow', TARGET, [hostile])

    expect(rendered).not.toContain('<img src=x')
    expect(rendered).toContain('&lt;img src=x')
  })
})
