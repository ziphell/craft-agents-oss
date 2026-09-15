/**
 * An overlay's target page, after creation.
 *
 * The kind is fixed at creation (plan §13.2), and every rule that follows from
 * it is fixed with it. The *address* is not one of those rules — it is a fact
 * about the world, and the same page exists in several of them: a local dev
 * server, staging, production. The same patches are meant to be looked at in
 * each, so an immutable address turns "look at this on staging" into "create a
 * second prototype and copy everything into it".
 *
 * ## What changing it does not do
 *
 * Two things can go stale the moment the address moves, and **neither raises an
 * error** — which is exactly why they are worth saying out loud when the change
 * is made:
 *
 * - **Windows already showing the old page.** Injection is per document
 *   (`Page.addScriptToEvaluateOnNewDocument`, see patch-script.ts), so a window
 *   that is open on the old address keeps it until it navigates again.
 * - **The selectors.** They were written against the DOM that was there. Another
 *   environment may be a different build, and even the same environment changes
 *   under a deploy; a patch that matches nothing looks exactly like a patch that
 *   did nothing.
 *
 * Neither is a reason to refuse the change: both of those go stale on their own
 * when a site changes without the address moving at all. The refusal here is
 * reserved for the one case that is a lie rather than a risk — a from-scratch
 * prototype, whose page is its own `base.html` and which has no external page for
 * a URL to mean (plan §13.4).
 */

import { existsSync } from 'fs'
import { readPrototypeConfig, writePrototypeConfig, type PrototypeConfig } from './config.ts'
import { getPrototypeDirPath } from './storage.ts'

/**
 * The address, or a refusal that says what to fix.
 *
 * One function for both entry points (creation and later change), so the rule
 * "an overlay's address has to be one a browser can actually open" cannot be
 * stricter in one place than the other. A scheme-less value is the common typo,
 * and without this it would be recorded happily and fail much later, as a
 * navigation error with nothing pointing back at the config.
 */
export function requireTargetUrl(value: string): string {
  const url = value.trim()
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error(
      `"${value}" is not an address a browser can open. Include the scheme, e.g. https://app.example.com/checkout`,
    )
  }
  return url
}

/**
 * Point an overlay at a different page.
 *
 * Only the overlay kind and its own rules are enforced; whether the patches still
 * fit the new page is the caller's risk to take, and taking it is the point (see
 * the module note).
 *
 * @throws when the prototype does not exist, when it is a from-scratch prototype
 *   (nothing for an address to mean), or when the value is not openable.
 */
export function setPrototypeTargetUrl(
  workspaceRootPath: string,
  slug: string,
  targetUrl: string,
): PrototypeConfig {
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
    throw new Error(`Prototype "${slug}" does not exist. See "prototype-list" for what exists.`)
  }

  const config = readPrototypeConfig(workspaceRootPath, slug)
  if (config.kind !== 'overlay') {
    throw new Error(
      `Prototype "${slug}" is a from-scratch prototype: its page is its own base.html, so there is no target ` +
        `page to set. Storing an address here would be a claim nothing honours.`,
    )
  }

  writePrototypeConfig(workspaceRootPath, slug, { ...config, targetUrl: requireTargetUrl(targetUrl) })

  return readPrototypeConfig(workspaceRootPath, slug)
}
