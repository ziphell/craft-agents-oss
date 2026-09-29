/**
 * A tweak, as code a page can run.
 *
 * This is the in-app carrier's payload: one self-contained script that picks, for the
 * document it finds itself in, the tweaks whose `matches` cover the address, inserts each
 * one's CSS — always before the DOM exists, so a page never flashes the state the tweak is
 * there to change — and runs each one's JavaScript at the moment that tweak declares
 * (`./run-at.ts`). The host (`apps/electron/src/main/tweaks-injector.ts`)
 * registers it for **future documents** and does nothing else with it — a document that
 * already exists is never evaluated, so this script meets each document exactly once, as it
 * is being born.
 *
 * ## The match-pattern test exists twice, and a table keeps the two equal
 *
 * `./match.ts` decides, host-side, which tweaks are in play for an address — that is what
 * `hits.json` is attributed from (see below). The page cannot import it: an injected script
 * has to be self-contained. So the grammar is written a second time here, in javascript
 * ({@link buildTweaksMatcherSource}), and `__tests__/inject.test.ts` runs one shared case
 * table through both implementations. Two implementations of one rule is a cost this
 * project names rather than hides — the alternative is a tweak that fires in the app and
 * in an extension built from the same file (or the reverse), which is the one thing the
 * grammar exists to prevent.
 *
 * ## What the page reports back
 *
 * The script records the slugs it applied on `window.__craftTweaks`, and
 * {@link buildTweaksProbeScript} reads that back. It is what lets the host attribute a hit
 * record to "the page this tweak was actually running on" rather than to what the host
 * assumed the page was.
 *
 * ## One pass per document, and no way back
 *
 * A document keeps what it was born with, for its whole life. Switching a tweak off, editing
 * it, deleting it, or routing away from the address it matched are all answered by the **next**
 * document, never by this one — which is why nothing here counts passes or digests: with one
 * pass per document there is nothing to make idempotent, and a tweak's JavaScript cannot run
 * twice on a page.
 *
 * The rule behind that is that a tweak cannot be taken back completely. Its CSS could be
 * (removing the `<style>` returns the page to its own cascade), but its JavaScript cannot:
 * what it did to the document is history nobody here has a record of. Pulling the CSS out from
 * under it would leave the page in a state its author never wrote, and would separate two
 * files that are one tweak. So they stay together, and a **load** is the reset —
 * `tweaks-injector.ts` states the same rule from the host's side.
 *
 * ## Where a hit record does and does not come from
 *
 * The extension carrier (`./extension.ts`) runs in a browser this app is not in, and a
 * content script has no way to reach the host's disk — so `hits.json` only ever knows about
 * the app's own browser window. A reader of that file must not read its absence as "this
 * tweak has never run anywhere".
 */

import type { TweakRunAt } from './run-at.ts'

/** One tweak as the init script needs it: identity, the pages, and the two code files. */
export interface TweaksInitScriptTweak {
  slug: string
  name: string
  /** The tweak's `tweak.css`, or null when there is none. */
  css: string | null
  /** The tweak's `tweak.js`, or null when there is none. */
  js: string | null
  /** When its javascript runs — what it declares with `@run-at`, or the default. */
  runAt: TweakRunAt
  /** Chrome match patterns — the pages this tweak is for. */
  matches: string[]
}

/**
 * The match-pattern test, as javascript — the twin of `match.ts`.
 *
 * Names here mirror the TypeScript ones so the two can be read side by side, and the
 * branches are in the same order, so a change to one can be made to the other by eye.
 * Pure on purpose (no `window`, `document` or `location`): that is what lets the test run
 * it without a page.
 */
export function buildTweaksMatcherSource(): string {
  return [
    '  const tweakParsePattern = (pattern) => {',
    '    const trimmed = String(pattern).trim();',
    // A pattern is one token: whitespace means this is prose, or two patterns typed on one
    // line — either way it is not a pattern.
    '    if (trimmed === "" || /\\s/.test(trimmed)) return null;',
    '    const match = /^(\\*|https?):\\/\\/(\\*|\\*\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*)(\\/.*)$/.exec(trimmed);',
    '    if (!match) return null;',
    '    const scheme = match[1];',
    '    const host = match[2];',
    '    const path = match[3];',
    '    if (!scheme || !host || path === undefined) return null;',
    // A `*` path is the whole of the path grammar, and only a trailing one runs past it.
    '    const wildcards = path.split("*").length - 1;',
    '    if (wildcards > 1 || (wildcards === 1 && path.slice(-1) !== "*")) return null;',
    '    return {',
    '      scheme: scheme,',
    '      host: host === "*" ? null : host.replace(/^\\*\\./, ""),',
    '      subdomains: host.startsWith("*."),',
    '      path: path,',
    '    };',
    '  };',
    '',
    '  const tweakMatchUrl = (url, patterns) => {',
    '    let target;',
    '    try { target = new URL(url); } catch { return false; }',
    '    for (const pattern of patterns) {',
    '      const parsed = tweakParsePattern(pattern);',
    // A pattern that cannot be read applies to nothing — the same answer a typo should give.
    '      if (!parsed) continue;',
    '      if (parsed.scheme === "*") {',
    '        if (target.protocol !== "http:" && target.protocol !== "https:") continue;',
    '      } else if (target.protocol !== parsed.scheme + ":") continue;',
    '      if (parsed.host !== null && target.hostname !== parsed.host) {',
    // `*.example.com` is that domain and its subdomains — not a suffix to be loose about.
    '        if (!parsed.subdomains || !target.hostname.endsWith("." + parsed.host)) continue;',
    '      }',
    // Chrome's anchoring: the pattern matches the whole path, and only a trailing `*` may
    // run past its end. `/admin/*` therefore covers `/admin/users`, not `/admin`.
    '      if (parsed.path.slice(-1) === "*") {',
    '        if (!target.pathname.startsWith(parsed.path.slice(0, -1))) continue;',
    '      } else if (target.pathname !== parsed.path) continue;',
    '      return true;',
    '    }',
    '    return false;',
    '  };',
  ].join('\n')
}

/**
 * The whole carrier as one script: for the current document, every tweak that applies.
 *
 * A **statement**, terminated with `;`, like every other init script in this codebase. It is
 * self-contained (the matcher is generated in, not imported) because an injected script has
 * no module system.
 *
 * It runs **once per document**, at `document-start`, and never again — so it has no marks, no
 * digests and no second-pass bookkeeping: there is nothing to make idempotent (see the module
 * note).
 */
export function buildTweaksInitScript(tweaks: TweaksInitScriptTweak[]): string {
  const lines: string[] = [
    '(() => {',
    buildTweaksMatcherSource(),
    '  const HREF = String(location.href);',
    '  const APPLIED = (window.__craftTweaks = []);',
    '',
    '  const insertStyle = (slug, css) => {',
    // At `document-start` neither `head` nor `documentElement` is guaranteed to exist; the
    // caller retries on `DOMContentLoaded` when this answers false.
    '    const root = document.head || document.documentElement;',
    '    if (!root) return false;',
    '    const element = document.createElement("style");',
    '    element.setAttribute("data-tweak", slug);',
    '    root.appendChild(element);',
    '    element.textContent = css;',
    '    return true;',
    '  };',
    '',
    // The browser's own three moments (`content_scripts.run_at`), because the extension
    // carrier is a content script and the two have to deliver a tweak the same way.
    '  const whenReady = (at, run) => {',
    '    if (at === "document_start") { run(); return; }',
    '    const isReady = () => at === "document_end" ? document.readyState !== "loading" : document.readyState === "complete";',
    '    if (isReady()) { run(); return; }',
    // `load` is fired at the window, not at the document, so listening on `document` would
    // never fire for `document_idle`.
    '    if (at === "document_end") document.addEventListener("DOMContentLoaded", run, { once: true });',
    '    else window.addEventListener("load", run, { once: true });',
    '  };',
  ]

  // Unrolled per tweak rather than driven by a data array, because a tweak's javascript has
  // to be emitted as *source*: a body kept in a string could only be run through `eval`,
  // which a page's CSP may refuse. Each tweak becomes one `if` over its own patterns.
  for (const tweak of tweaks) {
    const slug = JSON.stringify(tweak.slug)
    const matches = JSON.stringify([...tweak.matches])

    lines.push('')
    lines.push(`  // ${tweak.name} (${tweak.slug})`)
    lines.push(`  if (tweakMatchUrl(HREF, ${matches})) {`)

    if (typeof tweak.css === 'string') {
      const css = JSON.stringify(tweak.css)
      lines.push(`    if (!insertStyle(${slug}, ${css})) {`)
      lines.push(
        `      document.addEventListener("DOMContentLoaded", () => { insertStyle(${slug}, ${css}); }, { once: true });`,
      )
      lines.push('    }')
    }

    if (typeof tweak.js === 'string') {
      const runAt = JSON.stringify(tweak.runAt)
      // The body runs at the moment the tweak declares, in its own IIFE with its own
      // try/catch, so one tweak that throws cannot stop the ones after it — and so a body that
      // throws *when it is deferred* is still contained. A body ending in a line comment would
      // swallow the closing lines, so every body is on its own lines with the closers after a
      // newline — the same hazard `patch-script.ts` documents. A *parse* error in one body is
      // the honest limit: the script is one source, so it cannot be caught per tweak (running
      // each body through a `Function` constructor would, at the cost of `eval`, which a
      // page's CSP may refuse).
      lines.push(`    whenReady(${runAt}, () => {`)
      lines.push('      try {')
      lines.push('        (() => {')
      lines.push(...tweak.js.split('\n').map((line) => `          ${line}`))
      lines.push('        })();')
      lines.push('      } catch (err) {')
      lines.push(`        console.error(${JSON.stringify(`[craft tweak ${tweak.slug}]`)}, err);`)
      lines.push('      }')
      lines.push('    });')
    }

    // What the page reports back: the tweaks this document was given (see the module note).
    lines.push(`    APPLIED.push(${slug});`)
    lines.push('  }')
  }

  lines.push('})();')

  return lines.join('\n')
}

/**
 * An expression that reads back which tweaks this document applied.
 *
 * Deliberately tolerant: no list at all (a page where nothing ran), a value that is not a
 * list, or entries that are not strings all mean "nothing is known" — the safe answer,
 * because the alternative is attributing a hit to a tweak that never ran.
 */
export function buildTweaksProbeScript(): string {
  return [
    '(() => {',
    '  try {',
    '    const applied = window.__craftTweaks;',
    '    if (!Array.isArray(applied)) return [];',
    '    return applied.filter((slug) => typeof slug === "string");',
    '  } catch { return []; }',
    '})()',
  ].join('\n')
}

/**
 * An expression that answers, per declared `@target`, whether the page has it.
 *
 * `true`/`false` is what `document.querySelector` said; `null` is "could not check" (a
 * selector the page rejects), which must not be read as "matched nothing" — the second is
 * evidence the page moved, the first is the absence of any. Returns `{}` for no selectors,
 * so a caller can skip the round-trip.
 */
export function buildSelectorMatchScript(selectors: string[]): string {
  return [
    '(() => {',
    `  const selectors = ${JSON.stringify(selectors)};`,
    '  const out = {};',
    '  for (const selector of selectors) {',
    '    try { out[selector] = document.querySelector(selector) !== null; }',
    '    catch { out[selector] = null; }',
    '  }',
    '  return out;',
    '})()',
  ].join('\n')
}
