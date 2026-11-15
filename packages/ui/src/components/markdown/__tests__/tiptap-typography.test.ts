import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The editing face's typography, held to the reading face's values.
 *
 * A `.md` file has two faces and one look, and the look used to be written twice: `Markdown`'s `minimal` components in
 * Tailwind classes, and `tiptap-editor.css` in plain CSS. They drifted exactly the way two copies do — every heading
 * was 4px larger in the editor, and every table gained a box around each cell, so switching faces made the document
 * jump.
 *
 * These are the values that were reconciled (`Markdown.tsx`, `mode === 'minimal'`). Nothing here can tell whether the
 * *reading* face changed; what it can do is refuse a change to the editing face that walks away from the other one
 * without anybody deciding to.
 */

const css = readFileSync(join(import.meta.dir, '..', 'tiptap-editor.css'), 'utf8')

function escape(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function declarationsAt(index: number): string {
  const open = css.indexOf('{', index)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

/**
 * The declarations of the rule whose selector is exactly this one.
 *
 * A selector that is the *second* entry of a list (`th, td { … }`) does not count: the check is that what comes before
 * it is the end of another rule or of a comment, not a comma.
 */
function rule(selector: string): string {
  const pattern = new RegExp(`${escape(selector)}\\s*\\{`, 'g')
  for (let found = pattern.exec(css); found; found = pattern.exec(css)) {
    const before = css.slice(0, found.index).trimEnd()
    if (before === '' || before.endsWith('}') || before.endsWith('*/')) return declarationsAt(found.index)
  }
  throw new Error(`no rule for ${selector}`)
}

/** The declarations of the rule whose selector *list* starts with this one (`th, td { … }`). */
function ruleStarting(selector: string): string {
  const found = new RegExp(`${escape(selector)}\\s*,`).exec(css)
  if (!found) throw new Error(`no rule list for ${selector}`)
  return declarationsAt(found.index)
}

function declaration(selector: string, property: string): string | null {
  const found = new RegExp(`(?:^|[;{])\\s*${property}\\s*:\\s*([^;]+)`, 'm').exec(rule(selector))
  return found?.[1]?.trim() ?? null
}

const P = '.tiptap-editor .tiptap-prose'

describe('headings are the reading face’s headings', () => {
  // `h1` and `h2` are both 16px and differ by weight; `h3` is 15px. They were 20/18/16px here.
  it('sets h1 at 16px, bold', () => {
    expect(declaration(`${P} h1`, 'font-size')).toBe('1rem')
    expect(declaration(`${P} h1`, 'font-weight')).toBe('700')
  })

  it('sets h2 at 16px, semibold', () => {
    expect(declaration(`${P} h2`, 'font-size')).toBe('1rem')
    expect(declaration(`${P} h2`, 'font-weight')).toBe('600')
  })

  it('sets h3 at 15px', () => {
    expect(declaration(`${P} h3`, 'font-size')).toBe('0.9375rem')
  })

  it('sets strong at 600 — `font-semibold` is what the renderer asks for', () => {
    expect(declaration(`${P} strong`, 'font-weight')).toBe('600')
  })
})

describe('tables are ruled, not boxed', () => {
  it('is 14px, the renderer’s `text-sm`', () => {
    expect(declaration(`${P} table`, 'font-size')).toBe('0.875rem')
  })

  it('pads cells the way the renderer does', () => {
    const cells = ruleStarting(`${P} th`)
    expect(/padding\s*:\s*0\.5rem 0\.75rem/.test(cells)).toBe(true)
  })

  it('rules the header and the rows, and never draws a grid', () => {
    expect(declaration(`${P} th`, 'border-bottom')).toBe('1px solid var(--border)')
    expect(declaration(`${P} td`, 'border-bottom')).toContain('color-mix(in oklch, var(--border) 50%, transparent)')
    // The regression this exists for: `border: 1px solid …` on the shared `th, td` rule boxed every cell.
    expect(ruleStarting(`${P} th`)).not.toMatch(/border\s*:\s*1px/)
  })
})

describe('quotes and lists keep the reader’s spacing', () => {
  it('mutes a plain quote’s text', () => {
    expect(declaration(`${P} blockquote`, 'color')).toBe('var(--muted-foreground)')
  })

  it('gives list items the renderer’s `space-y-1`', () => {
    expect(declaration(`${P} li + li`, 'margin-top')).toBe('0.25rem')
  })
})

describe('a callout is drawn from its attributes', () => {
  it('names itself from `data-callout-label`, which the node writes', () => {
    const declarations = rule(`${P} blockquote[data-callout]::before`)
    expect(declarations).toContain('content: attr(data-callout-label)')
  })

  it('has a plain default, so an unknown type is still a callout', () => {
    expect(rule(`${P} blockquote[data-callout]`)).toContain('color-mix(in oklch, var(--foreground) 30%, transparent)')
  })
})

describe('selection looks like a selection', () => {
  it('paints a band and knocks the text out, instead of tinting it', () => {
    // Outside `ProseMirror-hideselection`, the one state that must paint nothing.
    const selection = rule(`${P}:not(.ProseMirror-hideselection) ::selection`)
    expect(selection).toContain('background: var(--tiptap-selection)')
    expect(selection).toContain('color: var(--tiptap-selection-text)')
  })

  it('paints nothing while a drag has the selection hidden', () => {
    // A band over everything the pointer crossed is a smear, and the blue band is strong enough to show it.
    // `prosemirror-view` ships this rule; its stylesheet is not loaded here, and our blue rule would outrank it.
    expect(ruleStarting(`${P}.ProseMirror-hideselection ::selection`)).toContain('background: transparent')
    expect(rule(`${P}.ProseMirror-hideselection`)).toContain('caret-color: transparent')
  })

  it('defines that band as a light/dark pair, so both themes get one', () => {
    // `light-dark()` resolves against the `color-scheme` the app sets on `:root`
    // (`packages/ui/src/styles/index.css`), which is why one variable is enough for both.
    const tokens = rule('.tiptap-editor')
    expect(tokens).toContain('--tiptap-selection: light-dark(')
    expect(tokens).toContain('--tiptap-selection-text: #fff')
  })
})

describe('a code block is part of the page, not a screenshot of a theme', () => {
  it('keeps the editor’s own surface instead of shiki’s inline background', () => {
    // The highlighter writes `background-color:#fff` as an inline style on the block; only `!important` beats that.
    const block = rule(`${P} pre.shiki`)
    expect(block).toContain('background-color: transparent !important')
  })

  it('uses the dark theme’s token colours when the app is dark', () => {
    // `--shiki-dark` sits beside every token colour and nothing consumed it, so a dark-mode document drew the light
    // theme's colours on our dark surface.
    const dark = ruleStarting('.dark ' + P + ' pre.shiki')
    expect(dark).toContain('color: var(--shiki-dark, inherit) !important')
  })

  it('leaves a token with no surface of its own', () => {
    // `--shiki-dark-bg` is set on the block, so a `<span>` that reads it paints the theme's background **behind each
    // token** and leaves the gaps between them the page's colour: a code block came out as a row of individually lit
    // chips, which reads as "every line is selected" (measured: a token's computed `background-color` was
    // `rgb(36, 41, 46)` in the dark theme, 2026-11-03). The surface is the block's, below; a token carries its colour.
    const token = rule('.dark .tiptap-editor .shiki span')
    expect(token).toContain('background-color: transparent !important')
    expect(token).not.toContain('var(--shiki-dark-bg)')
  })
})
