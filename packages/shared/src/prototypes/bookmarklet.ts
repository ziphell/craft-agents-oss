/**
 * The third carrier: a bookmarklet, for the machine where an extension cannot be
 * installed.
 *
 * An overlay page is somebody else's live page, so the only way to show changes on
 * it is to run code in it, and there is more than one way to get code into a
 * document. The extension (extension.ts) is the carrier this project chose, and it
 * is the better one — Chrome injects it, so the page's CSP does not apply to it, it
 * applies by itself on every matching document, and it may be any size. A bookmark
 * has none of those properties:
 *
 * | | extension | bookmarklet |
 * |---|---|---|
 * | page CSP | does not apply (the browser injects) | **applies** — a bookmark runs as an inline script, so `script-src 'self'` (GitHub, Gmail, most banks) refuses it and nothing happens |
 * | per document | automatic, survives reloads | **one click each time**, and every page |
 * | size | a file | **a URL budget** |
 *
 * It is here anyway, as a choice, because the machine this is handed to is not
 * always one where a person may load an unpacked extension: a managed browser, a
 * colleague on a locked-down laptop, someone who just wants one look. And the code
 * is the *same code*: {@link buildPatchBundle} and {@link buildMockScript} are what
 * the extension ships, so the two carriers cannot behave differently — only what
 * gets them into the page differs.
 *
 * Which is why the page this module generates is written for the reader, and says
 * all of the above out loud rather than letting them discover it in front of the
 * audience: what refused to run, why the reload needs another click, why the data
 * looks unfaked, and which address each link is for.
 */

import { buildMockScript, buildPatchBundle, patchesForPage } from './extension.ts'
import { noMockProgram, type MockProgram } from './mock-engine.ts'
import type { PrototypePatch } from './types.ts'

/** Where the page lands in `dist/`. */
export const BOOKMARKLET_FILENAME = 'bookmarklet.html'

export interface BookmarkletPage {
  /** The page of the flow this bookmark applies to, as the table knows it. */
  page: string
  /** The address it is meant to be clicked on. */
  url: string
  /** The code the bookmark carries. */
  script: string
  /** `javascript:` + the encoded script — what goes in the `href`. */
  href: string
  /** How long that URL is, in bytes: the one property a bookmark has a budget for. */
  bytes: number
}

/**
 * The code a bookmark carries: the mock layer first, then the page's own changes.
 *
 * The order is not cosmetic — a patch that fetches has to find the mock layer
 * already installed — and it is the same order the extension declares (`document_start`
 * in the page's world, then the bundle at `document_idle`).
 *
 * {@link buildPatchBundle} carries **all** of a page's patches, css included: the
 * extension hands its css to Chrome as a stylesheet, which a bookmark cannot do, so
 * here the css becomes the `<style>` element a replay creates. Same patches, one
 * carrier doing the plumbing the other one gets for free.
 *
 * Null when there is nothing to apply: a bookmark that does nothing is worse than
 * no bookmark, because it looks like it worked.
 */
export function buildBookmarkletScript(input: {
  slug: string
  page: string
  patches: PrototypePatch[]
  mocks?: MockProgram
}): string | null {
  const carries = patchesForPage(input.patches, input.page)
  const mocks = input.mocks ?? noMockProgram()
  if (carries.length === 0 && mocks.routes.length === 0) return null

  return [
    mocks.routes.length > 0 ? buildMockScript(mocks) : '',
    carries.length > 0 ? buildPatchBundle(input.slug, carries) : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** A `javascript:` URL for a script — every byte encoded, so nothing can end the attribute. */
function bookmarkletHref(script: string): string {
  return `javascript:${encodeURIComponent(script)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The delivered page: one draggable link per live page, the same code for the
 * console, and the costs of this carrier in the reader's words.
 *
 * **One link per page, not one for the flow.** A content script is scoped by
 * Chrome to an address; a bookmark is not — it applies to whatever page it is
 * clicked on — so scoping it would mean carrying every page's patches and choosing
 * between them at click time, which fails into the one shape this project keeps
 * refusing: a click that silently applies the wrong screen's changes. Naming the
 * link after its page, with the address printed beside it, makes the scoping the
 * reader's decision, and visible.
 *
 * The script is printed as well as linked, because a long `javascript:` URL is the
 * thing browsers refuse first (and the console is not subject to the page's CSP,
 * which is the other way a bookmark fails).
 *
 * @param pages the prototype's live pages, in flow order — the ones an extension
 *   would inject into.
 */
export function buildBookmarkletDocument(input: {
  slug: string
  pages: Array<{ page: string; url: string }>
  patches: PrototypePatch[]
  mocks?: MockProgram
  builtAt: Date
}): { html: string; pages: BookmarkletPage[] } {
  const mocks = input.mocks ?? noMockProgram()
  const bookmarks: BookmarkletPage[] = []

  for (const target of input.pages) {
    const script = buildBookmarkletScript({
      slug: input.slug,
      page: target.page,
      patches: input.patches,
      mocks,
    })
    if (!script) continue
    const href = bookmarkletHref(script)
    bookmarks.push({ page: target.page, url: target.url, script, href, bytes: Buffer.byteLength(href, 'utf-8') })
  }

  const sections = bookmarks.map((bookmark) => [
    `  <h2>${escapeHtml(bookmark.page)}</h2>`,
    `  <p class="sub">Click this one on <code>${escapeHtml(bookmark.url)}</code> · ${kilobytes(bookmark.bytes)}</p>`,
    '  <p>',
    `    <a class="bookmarklet" href="${bookmark.href}">Apply ${escapeHtml(bookmark.page)}</a>`,
    '    <span class="muted">← drag this to the bookmarks bar</span>',
    '  </p>',
    '  <details>',
    '    <summary>If the link will not stick, or the page refuses it: paste this into the console instead</summary>',
    `    <pre>${escapeHtml(bookmark.script)}</pre>`,
    '  </details>',
  ].join('\n')).join('\n')

  const empty = bookmarks.length === 0
    ? '  <p>No live page of this prototype has anything to apply yet, so there is no bookmark to drag.</p>\n'
    : `${sections}\n`

  return {
    pages: bookmarks,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.slug)} — bookmarklets</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 820px; color: #1f2328; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 4px; }
  p.sub { color: #59636e; margin: 0 0 8px; }
  code { color: #59636e; font-size: 12px; }
  .muted { color: #59636e; font-size: 12px; }
  a.bookmarklet {
    display: inline-block; padding: 6px 12px; border-radius: 6px;
    border: 1px solid #b6bcc4; background: #fff; color: #1f2328;
    font-weight: 600; text-decoration: none;
  }
  details { margin: 8px 0 0; }
  summary { cursor: pointer; color: #59636e; font-size: 12px; }
  pre { overflow: auto; max-height: 240px; padding: 8px; background: #f6f7f9; border: 1px solid #e6e8eb; font-size: 12px; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
</style>
</head>
<body>
<h1>${escapeHtml(input.slug)} — bookmarklets</h1>
<p class="sub">The changes the extension applies, as bookmarks — for a browser where an extension cannot be
loaded. Built ${escapeHtml(input.builtAt.toISOString())}.</p>

<h2>How</h2>
<ol>
  <li>Show the bookmarks bar (<code>Ctrl/Cmd+Shift+B</code>).</li>
  <li>Drag the link for the page you are about to look at onto it. One link per page, because a bookmark is
      not scoped to an address the way a content script is: it applies to whatever page you click it on, so
      the link you pick is the screen you get.</li>
  <li>Open that page of the real product and click the bookmark. Reload, and click it again.</li>
</ol>
${empty}
<h2>What this carrier cannot do</h2>
<ul>
  <li><strong>The page's own policy can refuse it.</strong> A bookmark runs as an inline script in the page,
      so a site sending <code>script-src 'self'</code> refuses it and nothing happens at all — the console
      snippet under each link is the way round that, and it is the same code.</li>
  <li><strong>Once per document.</strong> Every reload, and every page of the flow, needs another click. That
      is what the extension removes, and the only reason to prefer loading it where you can.</li>
  <li><strong>The mock layer installs when you click.</strong> Requests the page made before that are not
      faked — reload first if the data looks like the real backend's.</li>
  <li><strong>It is a snapshot.</strong> Re-export and drag the links again to pick up a change.</li>
</ul>
</body>
</html>
`,
  }
}
