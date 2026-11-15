/**
 * The editor document as a host serves it: **the host's policy, and the shim in front.**
 *
 * Two things happen to the vendored `index.html`, and both are consequences of the file having
 * been written to run from a `genoffice-app://` scheme inside its own app:
 *
 * - **Its `<meta http-equiv="Content-Security-Policy">` is dropped.** A meta policy and a
 *   response header are *both* enforced — the intersection of the two — and the vendored one
 *   allows `connect-src 'self' ws://localhost:* genoffice-docx-media:`, which does not include
 *   `blob:`. The editor fetches its document from a blob URL the shim makes (`shim.ts`), so
 *   keeping that policy blocks the one thing that makes a document open at all. Measured, not
 *   assumed: a blank editor and a CSP refusal in the console. One policy, in one place — the
 *   response header the host writes.
 * - **The shim goes in after `<head>`**, so it runs before the editor's module script (a module
 *   is deferred; a classic script is not). Without it the editor mounts and throws on the first
 *   `window.desktop` it touches.
 *
 * Shared by both hosts because both serve the same bytes: `apps/electron/src/main/office-host.ts`
 * at a `craft-local://` label, `packages/server-core/src/webui/office.ts` at `/office/`.
 */

import { OFFICE_SHIM_PATH } from './types'

const META_POLICY = /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi
const HEAD = /<head[^>]*>/i

/**
 * Chrome this host does not offer.
 *
 * The AI panel is already off at the editor's own switch (`showAiSidebar: false` in the shim's
 * preferences collapses the dock to nothing); what is left is its **door** — the ribbon group
 * with the one-click actions. A group whose items include `.ai-entry` is that group, so the rule
 * below is the narrowest one that removes the door and nothing else.
 *
 * Kept as one stylesheet with one reason, so deleting it is a decision and not an archaeology
 * exercise: a host that later *does* wire an AI backend deletes this and turns the pref back on.
 */
const HOST_CHROME_CSS = `<style id="craft-office-host">
  /* the AI ribbon group: its items carry .ai-entry */
  .ribbon-group:has(.ai-entry) { display: none !important; }
</style>`

export function prepareEditorDocument(html: string, shimPath: string = OFFICE_SHIM_PATH): string {
  const withoutMetaPolicy = html.replace(META_POLICY, '')
  if (withoutMetaPolicy.includes(shimPath)) return withoutMetaPolicy
  const tag = `<script src="${shimPath}"></script>${HOST_CHROME_CSS}`
  return withoutMetaPolicy.replace(HEAD, (head) => head + tag)
}
