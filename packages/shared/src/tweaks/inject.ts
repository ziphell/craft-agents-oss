/**
 * A tweak, as code a page can run.
 *
 * This is the in-app carrier's payload: one self-contained script that picks, for the
 * document it finds itself in, the tweaks whose `matches` cover the address, injects each
 * one's CSS and runs each one's JavaScript. The host (`apps/electron/src/main/tweaks-injector.ts`)
 * registers it for future documents and evaluates the *same* source against the document
 * that is already open, which is the same shape prototype replay uses — one code path, so
 * live and reloaded behaviour cannot diverge.
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
 * Running the same content twice against the same address is a **no-op**, per tweak and per
 * file: the host both registers this for future documents and evaluates it against the open
 * one, and without a mark the second pass would run every tweak's JavaScript twice. The
 * address is part of the mark because a single-page app's route change is the one case that
 * *should* run again, and the digest is per file because editing a tweak's CSS must not run
 * its JavaScript a second time on a document that already has it.
 *
 * The same pass is what makes a switch take effect on the page already open: a tweak that is
 * no longer in the set loses its `<style>` immediately (and its run mark, so switching it
 * back on replays it). What the tweak's JavaScript already did to the document is not undone
 * — that is the reload's job, and the module that folds the two carriers together says so.
 *
 * ## Where a hit record does and does not come from
 *
 * The extension carrier (`./extension.ts`) runs in a browser this app is not in, and a
 * content script has no way to reach the host's disk — so `hits.json` only ever knows about
 * the app's own browser window. A reader of that file must not read its absence as "this
 * tweak has never run anywhere".
 */

/** One tweak as the init script needs it: identity, the pages, and the two code files. */
export interface TweaksInitScriptTweak {
  slug: string
  name: string
  /** The tweak's `tweak.css`, or null when there is none. */
  css: string | null
  /** The tweak's `tweak.js`, or null when there is none. */
  js: string | null
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
 * A short, stable digest of a string.
 *
 * The page keeps the digest it last ran against, per tweak and per file, so re-evaluating
 * identical content on the same address does nothing. Only a "have I already done this"
 * mark — not a security boundary.
 */
function contentVersion(entries: unknown): string {
  const json = JSON.stringify(entries)
  let hash = 5381
  for (let index = 0; index < json.length; index += 1) {
    hash = ((hash * 33) ^ json.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/**
 * The whole carrier as one script: for the current document, every tweak that applies.
 *
 * A **statement**, terminated with `;`, like every other init script in this codebase. It is
 * self-contained (the matcher is generated in, not imported) because an injected script has
 * no module system.
 */
export function buildTweaksInitScript(tweaks: TweaksInitScriptTweak[]): string {
  const lines: string[] = [
    '(() => {',
    buildTweaksMatcherSource(),
    '  const HREF = String(location.href);',
    `  const OURS = ${JSON.stringify(tweaks.map((tweak) => tweak.slug))};`,
    '  const RUN = (window.__craftTweaksRun ||= {});',
    // A tweak that is no longer ours — switched off, deleted, or renamed away — loses both
    // its style and the memory of having run. Without forgetting it, switching a tweak off
    // and on again would leave the page without it until the next reload. What its
    // javascript already did to the document is **not** undone: only the tweak knows how to
    // take that back, and a reload is the honest way to get it.
    '  for (const element of document.querySelectorAll("style[data-tweak]")) {',
    '    const slug = element.getAttribute("data-tweak");',
    '    if (!OURS.includes(slug)) element.remove();',
    '  }',
    '  for (const slug of Object.keys(RUN)) { if (!OURS.includes(slug)) delete RUN[slug]; }',
    '  const APPLIED = (window.__craftTweaks = []);',
    '',
    '  const insertStyle = (slug, css) => {',
    // At `document-start` neither `head` nor `documentElement` is guaranteed to exist; the
    // caller retries on `DOMContentLoaded` when this answers false.
    '    const root = document.head || document.documentElement;',
    '    if (!root) return false;',
    '    const selector = \'style[data-tweak="\' + slug + \'"]\';',
    '    let element = document.querySelector(selector);',
    '    if (!element) {',
    '      element = document.createElement("style");',
    '      element.setAttribute("data-tweak", slug);',
    '    }',
    // Replace, never append a second one: a re-run must leave one element, not two.
    '    if (element.parentNode !== root) root.appendChild(element);',
    '    element.textContent = css;',
    '    return true;',
    '  };',
  ]

  // Unrolled per tweak rather than driven by a data array, because a tweak's javascript has
  // to be emitted as *source*: a body kept in a string could only be run through `eval`,
  // which a page's CSP may refuse. Each tweak becomes one `if` over its own patterns.
  for (const tweak of tweaks) {
    const slug = JSON.stringify(tweak.slug)
    const matches = JSON.stringify([...tweak.matches])
    // Per file, not per tweak: editing a tweak's CSS is a reason to restyle the page, and
    // nothing like a reason to run its javascript again on the document it is already on.
    const cssMark = JSON.stringify(`${contentVersion(tweak.css)}|`)
    const jsMark = JSON.stringify(`${contentVersion(tweak.js)}|`)

    lines.push('')
    lines.push(`  // ${tweak.name} (${tweak.slug})`)
    lines.push(`  if (tweakMatchUrl(HREF, ${matches})) {`)
    lines.push(`    const run = (RUN[${slug}] ||= {});`)

    if (typeof tweak.css === 'string') {
      const css = JSON.stringify(tweak.css)
      lines.push(`    const cssMark = ${cssMark} + HREF;`)
      lines.push('    if (run.css !== cssMark) {')
      lines.push('      run.css = cssMark;')
      lines.push(`      if (!insertStyle(${slug}, ${css})) {`)
      lines.push(
        `        document.addEventListener("DOMContentLoaded", () => { insertStyle(${slug}, ${css}); }, { once: true });`,
      )
      lines.push('      }')
      lines.push('    }')
    }

    if (typeof tweak.js === 'string') {
      // Each body in its own IIFE with its own try/catch, so one tweak that throws cannot
      // stop the ones after it. A body ending in a line comment would swallow the closing
      // lines, so every body is on its own lines with the closers after a newline — the same
      // hazard `patch-script.ts` documents. A *parse* error in one body is the honest limit:
      // the script is one source, so it cannot be caught per tweak (running each body
      // through a `Function` constructor would, at the cost of `eval`, which a page's CSP
      // may refuse).
      lines.push(`    const jsMark = ${jsMark} + HREF;`)
      lines.push('    if (run.js !== jsMark) {')
      lines.push('      run.js = jsMark;')
      lines.push('      try {')
      lines.push('        (() => {')
      lines.push(...tweak.js.split('\n').map((line) => `          ${line}`))
      lines.push('        })();')
      lines.push('      } catch (err) {')
      lines.push(`        console.error(${JSON.stringify(`[craft tweak ${tweak.slug}]`)}, err);`)
      lines.push('      }')
      lines.push('    }')
    }

    // Still "applied" whether or not this pass injected it: the probe answers what is on the
    // page, and a tweak this script ran earlier in this document is on the page.
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
