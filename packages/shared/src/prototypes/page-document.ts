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
 *
 * The document stays self-contained on purpose — no external stylesheet, font or
 * script — because it is served by the host **and** written verbatim into the
 * package as the extension's options page, where MV3's CSP permits neither a
 * remote resource nor an inline script. So the styling is one inline `<style>`,
 * a system font stack, and a `prefers-color-scheme` variant so the page belongs
 * to the window it was opened from.
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
    const line = [
      `<span class="name">${escapeHtml(page.name)}</span>`,
      `<span class="badge ${page.kind}">${page.kind}</span>`,
      page.entry ? '<span class="badge entry">entry</span>' : '',
    ].filter(Boolean).join('')

    const content = [
      '      <span class="body">',
      `        <span class="line">${line}</span>`,
      `        <code>${escapeHtml(where)}</code>`,
      '      </span>',
    ]
    // A page with nothing to open is text, not a link (see the note above).
    const element = target
      ? [
          `    <a class="page" href="${escapeHtml(target)}">`,
          ...content,
          '      <span class="trail" aria-hidden="true">→</span>',
          '    </a>',
        ]
      : ['    <div class="page missing">', ...content, '    </div>']

    return ['  <li>', ...element, '  </li>'].join('\n')
  })

  const body = pages.length === 0
    ? '  <p class="empty">This prototype has no pages yet. Write one (a top-level ' +
      '<code>&lt;name&gt;.html</code>), or add an overlay page with ' +
      '<code>prototype-pages --add &lt;name&gt;=&lt;url&gt;</code>.</p>'
    : ['  <ol class="pages">', ...rows, '  </ol>'].join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(slug)} — pages</title>
<style>
  :root {
    color-scheme: light dark;
    --canvas: #f6f7f9;
    --wash: rgba(37, 99, 235, 0.07);
    --surface: #ffffff;
    --text: #10131a;
    --text-muted: #626c7a;
    --text-faint: #6b7480;
    --border: #e7e9ee;
    --border-strong: #cfd5de;
    --soft: rgba(17, 24, 39, 0.06);
    --accent: #2563eb;
    --accent-soft: rgba(37, 99, 235, 0.12);
    --entry: #0f7a52;
    --entry-soft: rgba(16, 163, 106, 0.14);
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.05);
    --shadow-hover: 0 8px 20px rgba(16, 24, 40, 0.1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #0d0f13;
      --wash: rgba(96, 165, 250, 0.1);
      --surface: #161a20;
      --text: #eceef2;
      --text-muted: #98a1ad;
      --text-faint: #7d8695;
      --border: #262b33;
      --border-strong: #39414d;
      --soft: rgba(255, 255, 255, 0.08);
      --accent: #7dabff;
      --accent-soft: rgba(125, 171, 255, 0.18);
      --entry: #4bd39c;
      --entry-soft: rgba(75, 211, 156, 0.16);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-hover: 0 8px 20px rgba(0, 0, 0, 0.45);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: clamp(28px, 7vh, 76px) 20px;
    background: radial-gradient(120% 320px at 50% 0%, var(--wash), transparent 70%) var(--canvas);
    color: var(--text);
    font: 15px/1.55 var(--sans);
    -webkit-font-smoothing: antialiased;
  }
  .sheet { max-width: 780px; margin: 0 auto; }
  .head { margin-bottom: 26px; }
  .eyebrow {
    margin: 0 0 8px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-faint);
  }
  h1 { margin: 0 0 6px; font-size: clamp(22px, 3vw, 27px); font-weight: 600; letter-spacing: -0.02em; }
  .sub { margin: 0; color: var(--text-muted); }
  code { font-family: var(--mono); font-size: 12px; }
  /* One row per page; the number is the flow order the list promises. */
  .pages { counter-reset: page; list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .page {
    display: grid; grid-template-columns: 2.5rem minmax(0, 1fr) 1rem;
    align-items: center; gap: 12px;
    padding: 13px 16px;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface); box-shadow: var(--shadow);
    color: inherit; text-decoration: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }
  .page::before {
    counter-increment: page; content: counter(page, decimal-leading-zero);
    color: var(--text-faint); font-family: var(--mono); font-size: 11px;
  }
  .body { display: grid; gap: 3px; min-width: 0; }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .name { font-weight: 600; letter-spacing: -0.01em; }
  .page code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
  .badge {
    padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600;
    background: var(--soft); color: var(--text-muted);
  }
  .badge.overlay { background: var(--accent-soft); color: var(--accent); }
  .badge.entry { background: var(--entry-soft); color: var(--entry); }
  .trail { color: var(--text-faint); transition: color 0.15s ease, transform 0.15s ease; }
  a.page:hover { border-color: var(--border-strong); box-shadow: var(--shadow-hover); transform: translateY(-1px); }
  a.page:hover .trail { color: var(--accent); transform: translateX(2px); }
  a.page:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* A page with nothing to open keeps its place in the flow, and says so. */
  .page.missing { border-style: dashed; background: transparent; box-shadow: none; }
  .page.missing .name { color: var(--text-muted); font-weight: 500; text-decoration: line-through; }
  .empty {
    margin: 0; padding: 18px 20px;
    border: 1px dashed var(--border-strong); border-radius: var(--radius);
    background: var(--surface); color: var(--text-muted);
  }
  /* The chips wrap at a narrow width; keep each half looking like a chip rather
     than one pill sliced in two. */
  .empty code {
    padding: 2px 6px; border-radius: 6px; background: var(--soft); color: var(--text);
    -webkit-box-decoration-break: clone; box-decoration-break: clone;
  }
</style>
</head>
<body>
<main class="sheet">
  <header class="head">
    <p class="eyebrow">Prototype</p>
    <h1>${escapeHtml(slug)}</h1>
    <p class="sub">Pages of this prototype, in flow order.</p>
  </header>
${body}
</main>
</body>
</html>
`
}
