/**
 * Patch → init-script transform, and the state each patch reports about itself.
 *
 * A patch is replayed through exactly one code path whether it is registered for
 * future documents (`Page.addScriptToEvaluateOnNewDocument`) or applied live to
 * the current one, so live and reloaded behaviour cannot diverge.
 *
 * The second job of this module is the answer to a question the replay alone
 * cannot give: **did the patch do anything?** A stylesheet whose selector matches
 * nothing is indistinguishable from one that matched and changed nothing, which
 * is the silent failure the workbench spends the most effort avoiding. So every
 * patch writes what happened to itself into one object on the page
 * (`PATCH_STATE_KEY`), and the apply reads it back:
 *
 * - a css patch reports how many elements its declared `@target` matched
 *   (`null` when it declares none — "not checkable" is not "matched nothing");
 * - a js patch reports whether it threw, which is otherwise only visible in a
 *   console nobody has open.
 *
 * The state is written by the same transform that applies the patch, so a hosted
 * page (whose css is inlined as text with no script of its own) gets a small
 * recorder instead — see `buildPatchMatchRecorderScript`.
 */

import type { PrototypePatch } from './types.ts'

/** DOM id of the `<style>` element a css patch injects, derived from its file name. */
export function buildPatchStyleElementId(patch: PrototypePatch): string {
  return `__craft_patch_${patch.file.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** Where every patch writes what it observed about itself. */
export const PATCH_STATE_KEY = '__craft_patch_state__'

/**
 * The one bit of generated code that touches the state object.
 *
 * Interpolated into every patch script rather than imported by it, because the
 * injected script has to be self-contained: `merge` never overwrites a field it
 * was not given, so a css patch's match count and a js patch's error cannot
 * clobber each other in a document that carries both.
 */
const STATE_HELPER = `
  const record = (patch) => {
    const state = (window.${PATCH_STATE_KEY} = window.${PATCH_STATE_KEY} || {});
    state[FILE] = Object.assign({}, state[FILE], patch);
  };
`

/**
 * Turn a patch into a self-contained init script.
 *
 * - **css** creates/updates a `<style>` element. At `document-start` neither
 *   `document.head` nor `document.documentElement` is guaranteed to exist, so it
 *   falls back to retrying on `DOMContentLoaded`.
 * - **js** is wrapped in an IIFE with a `try`/`catch` so one broken patch cannot
 *   abort the rest of the replay.
 *
 * The result is a **statement, terminated with `;`** — not an expression. It gets
 * concatenated: two patches end up as consecutive lines inside one `<script>`
 * (the self-contained page) or one bundle (the overlay preview). Without the
 * terminator, `…})()\n(() => {…})()` parses as a *call chain* on the first
 * patch's result, and since that result is undefined the whole block throws
 * before the second patch ever runs — a failure that only appears once there are
 * two js patches, which is why the terminator is here rather than at each call
 * site.
 */
export function buildPatchInitScript(patch: PrototypePatch): string {
  const file = JSON.stringify(patch.file)

  if (patch.kind === 'css') {
    return [
      '(() => {',
      `  const FILE = ${file};`,
      `  const TARGETS = ${JSON.stringify(patch.targets)};`,
      STATE_HELPER,
      `  const STYLE_ID = ${JSON.stringify(buildPatchStyleElementId(patch))};`,
      `  const CSS = ${JSON.stringify(patch.source)};`,
      '  const measure = () => {',
      '    const matches = {};',
      '    for (const target of TARGETS) {',
      // An invalid selector is reported as unmeasurable rather than as zero
      // matches: "could not check" and "checked, found nothing" are different
      // facts, and only the second one is evidence the page moved.
      '      try { matches[target] = document.querySelectorAll(target).length; }',
      '      catch { matches[target] = null; }',
      '    }',
      '    record({ matches, error: null });',
      '  };',
      '  const apply = () => {',
      '    const root = document.head || document.documentElement;',
      '    if (!root) return false;',
      "    let el = document.getElementById(STYLE_ID);",
      "    if (!el) { el = document.createElement('style'); el.id = STYLE_ID; root.appendChild(el); }",
      '    el.textContent = CSS;',
      '    return true;',
      '  };',
      "  if (!apply()) document.addEventListener('DOMContentLoaded', apply, { once: true });",
      '  measure();',
      // The first measurement can happen before the elements exist, so a second
      // pass once the document is there — the number that gets compared later is
      // the one taken against the finished page.
      "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', measure, { once: true });",
      '})();',
    ].join('\n')
  }

  // The newline before `} catch` matters: a patch ending in a line comment would
  // otherwise swallow the closing brace and produce a syntax error.
  return [
    '(() => {',
    `  const FILE = ${file};`,
    STATE_HELPER,
    '  try {',
    patch.source,
    '    record({ error: null });',
    '  } catch (err) {',
    `    console.error(${JSON.stringify(`[prototype patch ${patch.file}]`)}, err);`,
    "    record({ error: (err && err.message) ? String(err.message) : String(err) });",
    '  }',
    '})();',
  ].join('\n')
}

/**
 * An expression that reads back what every replayed patch observed about itself.
 *
 * Deliberately tolerant: no state object (a page where nothing ran yet), a state
 * that is not an object, or an entry that is not one all mean "nothing is known"
 * — which is the safe answer, because the alternative is reporting a match count
 * nobody measured.
 */
export function buildPatchStateProbeScript(): string {
  return [
    '(() => {',
    `  const state = window.${PATCH_STATE_KEY};`,
    '  if (!state || typeof state !== "object") return {};',
    '  const out = {};',
    '  for (const key of Object.keys(state)) {',
    '    const entry = state[key];',
    '    if (!entry || typeof entry !== "object") continue;',
    '    const matches = {};',
    '    const measured = (entry.matches && typeof entry.matches === "object") ? entry.matches : {};',
    '    for (const target of Object.keys(measured)) {',
    '      matches[target] = typeof measured[target] === "number" ? measured[target] : null;',
    '    }',
    '    out[key] = {',
    '      matches,',
    '      error: typeof entry.error === "string" ? entry.error : null,',
    '    };',
    '  }',
    '  return out;',
    '})()',
  ].join('\n')
}

/**
 * The recorder for css patches that were inlined as **text**.
 *
 * A page of ours carries its css inside one `<style>` block, which has no script
 * to report anything — and that is the page where a match count is most useful,
 * because a selector written against a live page is being checked against our own
 * document. So the host appends this one script instead of a per-patch script:
 * it counts each declared target once the document is there.
 *
 * Returns null when there is nothing to measure, so a call site can leave the
 * document untouched rather than adding a script that does nothing.
 */
export function buildPatchMatchRecorderScript(patches: PrototypePatch[]): string | null {
  const targets: Record<string, string[]> = {}
  for (const patch of patches) {
    if (patch.kind === 'css' && patch.targets.length > 0) targets[patch.file] = patch.targets
  }
  if (Object.keys(targets).length === 0) return null

  return [
    '<script>',
    '(() => {',
    `  const TARGETS_BY_FILE = ${JSON.stringify(targets)};`,
    `  const state = () => (window.${PATCH_STATE_KEY} = window.${PATCH_STATE_KEY} || {});`,
    '  const recordFor = (file, patch) => { state()[file] = Object.assign({}, state()[file], patch); };',
    '  const run = () => {',
    '    for (const file of Object.keys(TARGETS_BY_FILE)) {',
    '      const matches = {};',
    '      for (const target of TARGETS_BY_FILE[file]) {',
    '        try { matches[target] = document.querySelectorAll(target).length; }',
    '        catch { matches[target] = null; }',
    '      }',
    '      recordFor(file, { matches, error: null });',
    '    }',
    '  };',
    "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });",
    '  else run();',
    '})();',
    '</script>',
  ].join('\n')
}
