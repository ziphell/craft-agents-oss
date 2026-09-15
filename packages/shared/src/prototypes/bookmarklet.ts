/**
 * The overlay's preview carrier.
 *
 * A from-scratch prototype hands over a document, so its deliverable *is* a
 * document. An overlay's changes belong to a page we do not own, and nothing we
 * write to `dist/` can be that page — freezing it produces something that runs
 * none of its own JavaScript. What we can hand over is the *changes*, wrapped so
 * that whoever receives them can put them onto the real page themselves.
 *
 * That wrapper is a bookmarklet: a `javascript:` bookmark the recipient drags to
 * their bookmarks bar and clicks while standing on the target page. Nothing to
 * install, nothing to host, works while our app is closed.
 *
 * ## Why the bundle is also offered as a console snippet
 *
 * A bookmarklet is an inline script running in the page's context, so a page
 * that sends `script-src 'self'` — GitHub, Gmail, most banks — refuses to run
 * it, exactly as it would refuse an inline `<script>`. That is a property of the
 * page, not of the bookmarklet, and there is no way around it from a URL. The
 * developer console is not subject to that policy, so the same bundle is also
 * written out as a snippet: same bytes, second way in, no extra build step. The
 * recipient who hits a strict CSP is told why and what to do, instead of
 * watching a bookmark do nothing.
 *
 * ## What this demands of a patch
 *
 * - **Small.** Everything travels inside one URL; the bookmarks bar is not a
 *   filesystem. No minification is needed (and readable patches are a feature —
 *   the recipient can see what will change on their page), but dead or
 *   duplicated patches are now a size problem, not just untidiness.
 * - **Re-runnable.** The bookmark gets clicked more than once, and a single-page
 *   app changes views without a reload (see `apply` below). Setting text or
 *   styles is naturally idempotent; `appendChild` is not.
 * - **Not assuming document-start.** Live replay runs before the app boots; a
 *   bookmarklet runs after. A patch that needs an element must wait for it
 *   rather than assume it is there.
 *
 * @see docs/prototype-workbench-plan.md §17 (overlay 的预览载体)
 */

import { buildPatchInitScript } from './patch-script.ts'
import type { PrototypePatch } from './types.ts'

/** Global the bundle installs, so a second click reuses the first install. */
function previewGlobalName(slug: string): string {
  return `__craft_prototype_${slug.replace(/[^A-Za-z0-9]/g, '_')}__`
}

/**
 * The patches as one runnable script.
 *
 * The patches themselves go through {@link buildPatchInitScript} — the same
 * transform the live injector and the self-contained page use — so the preview
 * cannot behave differently from what the workspace shows. Only the frame around
 * them is new, and it does three things:
 *
 * 1. **Install once.** A second click re-runs the existing install rather than
 *    adding a second set of listeners.
 * 2. **Replay on view changes.** A single-page app swaps views without a reload,
 *    and the page it lands on is a page the patches never saw. Hooking
 *    `pushState` / `replaceState` / `popstate` covers that.
 * 3. **Keep the stylesheet honest.** Re-running a css patch overwrites the
 *    `<style>` element it owns, so css can be replayed freely; js patches have
 *    to be written for it (see the module note).
 */
export function buildPatchBundle(slug: string, patches: PrototypePatch[]): string {
  const global = previewGlobalName(slug)
  return [
    '(() => {',
    `  const GLOBAL = ${JSON.stringify(global)};`,
    '  const apply = () => {',
    ...patches.map((patch) => indent(buildPatchInitScript(patch), 4)),
    '  };',
    '',
    '  const installed = window[GLOBAL];',
    '  if (installed) { installed.apply(); return; }',
    '  window[GLOBAL] = { apply };',
    '  apply();',
    '',
    "  for (const method of ['pushState', 'replaceState']) {",
    '    const original = history[method];',
    '    history[method] = function (...args) {',
    '      const result = original.apply(this, args);',
    '      apply();',
    '      return result;',
    '    };',
    '  }',
    "  window.addEventListener('popstate', apply);",
    '})()',
  ].join('\n')
}

/**
 * The bundle as the `javascript:` URL that goes in a bookmark.
 *
 * Percent-encoded: a bookmark URL has to survive a bookmark manager and an
 * `href` attribute, and a raw `<`, `"` or newline in the code would not. The
 * trailing `void 0` is the standard guard — a `javascript:` URL whose last
 * expression evaluates to a string is rendered as a document *replacing the
 * page*, which is a spectacular way to lose the page you were patching.
 */
export function toBookmarkletUrl(bundle: string): string {
  return `javascript:${encodeURIComponent(`${bundle};void 0`)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Indent every non-empty line, so a nested script stays readable in the bundle. */
function indent(source: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return source
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n')
}

/** Bytes as kb, for the size note the recipient (and the author) can act on. */
function kb(text: string): string {
  return `${(Buffer.byteLength(text, 'utf-8') / 1024).toFixed(1)} KB`
}

/**
 * The HTML file that carries the preview: instructions, the draggable bookmark,
 * the console fallback, and what the patches are.
 *
 * Deliberately self-contained — no fetch, no script tag, no stylesheet, no
 * dependency on the workbench being open — because the whole point is to hand
 * this to someone who does not have the workbench. Being able to *read* the
 * change list here also matters: this file asks a person to run code on a page
 * they trust, and the file itself is the only credential it has.
 */
export function buildOverlayPreviewHtml(
  slug: string,
  targetUrl: string,
  patches: PrototypePatch[],
): string {
  const bundle = buildPatchBundle(slug, patches)
  const bookmarklet = toBookmarkletUrl(bundle)
  const target = escapeHtml(targetUrl)

  const fileList = patches
    .map((patch) => `<li><code>${escapeHtml(patch.file)}</code> — ${patch.kind}, lane ${patch.lane ?? '—'}</li>`)
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Overlay preview — ${escapeHtml(slug)}</title>
<style>
  :root { color-scheme: light dark }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem }
  h1 { font-size: 1.4rem; margin-bottom: .25rem }
  h2 { font-size: 1rem; margin-top: 2rem }
  .target { font-family: ui-monospace, monospace; word-break: break-all; opacity: .8 }
  .bookmark { display: inline-block; padding: .5rem .9rem; border-radius: .4rem; background: #6d5dfc; color: #fff; text-decoration: none; font-weight: 600 }
  ol, ul { padding-left: 1.2rem }
  textarea { width: 100%; height: 9rem; font-family: ui-monospace, monospace; font-size: 12px }
  .meta, .note { opacity: .7; font-size: .85rem }
  code { font-size: .9em }
</style>
</head>
<body>
<h1>Overlay preview — ${escapeHtml(slug)}</h1>
<p class="target">Applies to: ${target}</p>
<p>These patches change a page that belongs to someone else, so they are not a
page of their own: this file applies them to the live page in your own browser.
Nothing is installed and nothing is uploaded.</p>

<h2>See it on the real page</h2>
<ol>
  <li>Show your bookmarks bar — <code>Ctrl/Cmd + Shift + B</code>.</li>
  <li>Drag this onto it: <a class="bookmark" href="${bookmarklet}">Preview ${escapeHtml(slug)}</a></li>
  <li>Open <code>${target}</code> and click the bookmark. Every patch runs on that page.</li>
</ol>
<p class="note">Reloading the page clears the preview — click the bookmark again. Moving
between views inside a single-page app replays it automatically.</p>

<h2>If nothing happens</h2>
<p class="note">Sites that send a <code>Content-Security-Policy</code> forbidding inline
scripts also refuse bookmarklets — the bookmark runs as an inline script in the page,
so the page's policy applies to it. The developer console is not subject to that policy:
open <code>F12</code> on the target page, paste the snippet below, press Enter. It is the
same code the bookmark would have run.</p>
<textarea readonly onclick="this.select()">${escapeHtml(bundle)}</textarea>

<h2>What it changes</h2>
<ul>
${fileList || '<li><em>No patches yet.</em></li>'}
</ul>
<p class="meta">${patches.length} patch${patches.length === 1 ? '' : 'es'} · bundle ${kb(bundle)} · bookmarklet URL ${kb(bookmarklet)}</p>
</body>
</html>
`
}
