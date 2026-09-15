/**
 * Patch → init-script transform.
 *
 * A patch is replayed through exactly one code path whether it is registered for
 * future documents (`Page.addScriptToEvaluateOnNewDocument`) or applied live to
 * the current one, so live and reloaded behaviour cannot diverge.
 */

import type { PrototypePatch } from './types.ts'

/** DOM id of the `<style>` element a css patch injects, derived from its file name. */
export function buildPatchStyleElementId(patch: PrototypePatch): string {
  return `__craft_patch_${patch.file.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * Turn a patch into a self-contained init script.
 *
 * - **css** creates/updates a `<style>` element. At `document-start` neither
 *   `document.head` nor `document.documentElement` is guaranteed to exist, so it
 *   falls back to retrying on `DOMContentLoaded`.
 * - **js** is wrapped in an IIFE with a `try`/`catch` so one broken patch cannot
 *   abort the rest of the replay.
 */
export function buildPatchInitScript(patch: PrototypePatch): string {
  if (patch.kind === 'css') {
    return [
      '(() => {',
      `  const STYLE_ID = ${JSON.stringify(buildPatchStyleElementId(patch))};`,
      `  const CSS = ${JSON.stringify(patch.source)};`,
      '  const apply = () => {',
      '    const root = document.head || document.documentElement;',
      '    if (!root) return false;',
      "    let el = document.getElementById(STYLE_ID);",
      "    if (!el) { el = document.createElement('style'); el.id = STYLE_ID; root.appendChild(el); }",
      '    el.textContent = CSS;',
      '    return true;',
      '  };',
      "  if (!apply()) document.addEventListener('DOMContentLoaded', apply, { once: true });",
      '})()',
    ].join('\n')
  }

  // The newline before `} catch` matters: a patch ending in a line comment would
  // otherwise swallow the closing brace and produce a syntax error.
  return [
    '(() => {',
    '  try {',
    patch.source,
    '  } catch (err) {',
    `    console.error(${JSON.stringify(`[prototype patch ${patch.file}]`)}, err);`,
    '  }',
    '})()',
  ].join('\n')
}
