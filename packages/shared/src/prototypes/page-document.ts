/**
 * How a page becomes the document that is served or shipped.
 *
 * Two small assemblies live here, and both are deliberately text-level: the host
 * renders a page per request, export writes the same page into the package, and
 * neither may invent markup the author did not write.
 *
 * - **the page index** — the document `/` answers with when the prototype has no
 *   entry page (plan §19.3), and the same document the extension ships as its
 *   options page. It is the one page a prototype never writes itself, so it is
 *   generated from the page table rather than stored: a stored one would be a
 *   second answer to "what pages are there".
 * - **the shared shell** — an optional `_layout.html` with one slot
 *   ({@link PROTOTYPE_LAYOUT_SLOT}), filled with the page document. Not a
 *   template engine: the authoring surface stays the final artifact (plan §19.2).
 *
 * @see docs/prototype-workbench-plan.md §19.2, §19.3
 */

import { LEGACY_PROTOTYPE_LAYOUT_SLOT, PROTOTYPE_LAYOUT_SLOT } from './types.ts'
import type { PrototypePage } from './pages.ts'

/**
 * The shell every new prototype starts with, written by the control plane at
 * creation (plan §19.2).
 *
 * This is a **sample to copy from**, not machinery: it is an ordinary document
 * that happens to hold the slot, so an author — usually the agent — has one
 * validated shape to follow instead of inventing a page structure per screen. What
 * it demonstrates is what is expensive to discover later: root-absolute asset
 * paths, no external hosts, no build step, the frame written in exactly one place,
 * and `var(--token)` values a page can use directly.
 *
 * It is a shell, not a page: nothing here is listed as a page or rendered on its
 * own, so writing it claims nothing about what the prototype contains — creation
 * still seeds no page, and "no pages yet" stays true until someone writes one.
 */
export function buildLayoutShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prototype</title>
<!--
  The shared shell for this prototype's pages. Every page of ours is rendered into
  the slot near the bottom of <body>, so the frame lives here exactly once: the
  design tokens, the container, the navigation, the footer.

  The tokens are named in two layers, the way design-token sets usually are: a
  scale (--size-4, --gray-8, --radius-3) and a meaning that points at it
  (--gap, --text-muted, --radius). Prefer the meaning; reach for the scale when
  there is no word for what you need. The rules below the scale are a classless
  floor, so plain markup already looks intentional.

  A page is still a complete document of its own — it arrives with its own <head>
  and <body>, and a browser merges the two — which is why a page can use these
  tokens directly (var(--gap), .card, .row) without importing anything.
-->
<style>
  :root {
    /* The scale: bare numbers, named the way token sets usually name them. */
    --gray-0: #ffffff; --gray-1: #f6f7f9; --gray-3: #e6e8eb;
    --gray-6: #b6bcc4; --gray-8: #59636e; --gray-10: #1f2328;
    --blue-6: #2563eb; --red-7: #a40e26;
    --size-1: 4px; --size-2: 8px; --size-3: 12px; --size-4: 16px; --size-6: 24px; --size-8: 32px;
    --radius-2: 6px; --radius-3: 10px;
    --font-1: 12px; --font-2: 14px; --font-3: 18px; --font-4: 24px;
    /* The meaning: what a page should mostly use. */
    --canvas: var(--gray-1);
    --surface: var(--gray-0);
    --text: var(--gray-10);
    --text-muted: var(--gray-8);
    --border: var(--gray-3);
    --accent: var(--blue-6);
    --danger: var(--red-7);
    --radius: var(--radius-3);
    --gap: var(--size-4);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--text);
    font: var(--font-2)/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  /* The classless floor: write markup first, style only what is specific to the screen. */
  h1 { font-size: var(--font-4); margin: 0 0 var(--gap); }
  h2 { font-size: var(--font-3); margin: 0 0 var(--size-3); }
  h3 { font-size: var(--font-2); margin: 0 0 var(--size-2); }
  p { margin: 0 0 var(--size-3); }
  a { color: var(--accent); }
  button {
    font: inherit; cursor: pointer;
    padding: var(--size-2) var(--size-3);
    border: 1px solid var(--border); border-radius: var(--radius-2);
    background: var(--surface); color: var(--text);
  }
  button:hover { border-color: var(--gray-6); }
  input, select, textarea {
    font: inherit; color: var(--text); background: var(--surface);
    padding: var(--size-2); border: 1px solid var(--border); border-radius: var(--radius-2);
  }
  label { display: block; margin-bottom: var(--size-1); font-size: var(--font-1); color: var(--text-muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: var(--size-2); text-align: left; border-bottom: 1px solid var(--border); }
  code { padding: 1px var(--size-1); border-radius: var(--radius-2); background: var(--gray-1); font-size: var(--font-1); }
  /* A few layout pieces every screen needs, so none of them reinvents them. */
  .app { max-width: 960px; margin: 0 auto; padding: var(--gap); }
  .app > header { display: flex; align-items: center; gap: var(--gap); margin-bottom: var(--gap); }
  .app > header nav { display: flex; gap: var(--size-3); }
  .app > header a { color: var(--text-muted); text-decoration: none; }
  .app > header a[aria-current="page"] { color: var(--text); font-weight: 600; }
  .card { padding: var(--gap); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .stack { display: grid; gap: var(--gap); }
  .row { display: flex; align-items: center; gap: var(--size-3); }
  .row + .row { margin-top: var(--size-2); }
  .muted { color: var(--text-muted); }
</style>
</head>
<body>
<div class="app">
  <header>
    <!--
      Navigation: with more than one page, add one anchor per page here — relative
      links, so they also work inside the delivered extension — and mark the page you
      are on with aria-current="page". (No sample paths in this comment on purpose:
      export checks that every reference in a document exists in the package, and a
      comment is not an exception.)
    -->
    <nav></nav>
  </header>
${PROTOTYPE_LAYOUT_SLOT}
</div>
</body>
</html>
`
}

/**
 * Put a page document into a shared shell, if there is one.
 *
 * The slot is replaced once — the first occurrence — because a shell has exactly
 * one place for the page, and replacing every occurrence would silently duplicate
 * a document that happens to appear twice. A shell with no slot is used as it
 * stands: it is then the whole document, which is a legitimate frame.
 *
 * A page document is complete (`<!doctype html>…`) and so is the shell, so the
 * result nests one inside the other; a browser drops the redundant inner
 * `html`/`head`/`body` tags and keeps the content, and the page's own styles and
 * scripts still apply. Merging the two heads would be a real templating engine,
 * and that is the thing this design keeps out (plan §19.2 未做).
 */
export function applyPrototypeLayout(document: string, layout: string | null): string {
  if (!layout) return document
  const slot = findLayoutSlot(layout)
  if (!slot) return layout
  return layout.slice(0, slot.index) + document + layout.slice(slot.index + slot.length)
}

/**
 * Where the shell's slot is — in the standard spelling, or in the one it used to
 * have (see {@link LEGACY_PROTOTYPE_LAYOUT_SLOT}).
 */
function findLayoutSlot(layout: string): { index: number; length: number } | null {
  for (const slot of [PROTOTYPE_LAYOUT_SLOT, LEGACY_PROTOTYPE_LAYOUT_SLOT]) {
    const index = layout.indexOf(slot)
    if (index !== -1) return { index, length: slot.length }
  }
  return null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The generated page index: what this prototype is made of, and how to open each
 * page.
 *
 * **Default, not fallback.** No page of a flow is naturally the first one, so `/`
 * shows this list until someone marks a page as the entry (plan §19.3); it stays
 * reachable at `/_index` afterwards, because configuring an entry should change
 * what `/` opens, never take the list away.
 *
 * A page whose document is gone is listed as text rather than a link: the report
 * says the same thing (`pageIssues`), and a dead link would hide it.
 */
export function buildPrototypeIndexDocument(input: {
  slug: string
  pages: PrototypePage[]
  /** Where a page's link points — the host addresses its own tree, the package names a file in it. */
  href: (page: PrototypePage) => string | null
}): string {
  const { slug, pages, href } = input

  const rows = pages.map((page) => {
    const target = href(page)
    const where = page.url ?? page.file ?? '—'
    const label = target
      ? `<a href="${escapeHtml(target)}">${escapeHtml(page.name)}</a>`
      : `<span class="missing">${escapeHtml(page.name)}</span>`
    return [
      '    <li>',
      `      <span class="kind ${page.kind}">${page.kind}</span>`,
      `      ${label}`,
      page.entry ? '      <span class="entry">entry</span>' : '',
      `      <code>${escapeHtml(where)}</code>`,
      '    </li>',
    ].filter(Boolean).join('\n')
  })

  const body = pages.length === 0
    ? '  <p class="empty">This prototype has no pages yet. Write one (a top-level ' +
      '<code>&lt;name&gt;.html</code>), or add an overlay page with ' +
      '<code>prototype-pages --add &lt;name&gt;=&lt;url&gt;</code>.</p>'
    : ['  <ul>', ...rows, '  </ul>'].join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(slug)} — pages</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; color: #1f2328; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p.sub { color: #59636e; margin: 0 0 16px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: baseline; gap: 8px; padding: 6px 0; border-bottom: 1px solid #e6e8eb; }
  code { color: #59636e; font-size: 12px; }
  .kind { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #eef1f4; }
  .kind.overlay { background: #e7f0ff; }
  .entry { font-size: 11px; color: #0a7a3d; }
  .missing { text-decoration: line-through; color: #a40e26; }
  .empty { color: #59636e; }
</style>
</head>
<body>
<h1>${escapeHtml(slug)}</h1>
<p class="sub">Pages of this prototype, in flow order.</p>
${body}
</body>
</html>
`
}
