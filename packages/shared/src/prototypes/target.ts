/**
 * An overlay page's address, after the page was added.
 *
 * A page's kind is fixed when it is added (plan §13.2), and every rule that
 * follows from it is fixed with it. The *address* is not one of those rules — it
 * is a fact about the world, and the same page exists in several of them: a local
 * dev server, staging, production. The same patches are meant to be looked at in
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
 * reserved for the one case that is a lie rather than a risk — a scratch page,
 * whose document is our own file and for which a stored URL means nothing
 * (plan §13.4).
 */

import { existsSync } from 'fs'
import { readPrototypeConfig, writePrototypeConfig, type PrototypeConfig } from './config.ts'
import { listPrototypePages, type PrototypePage } from './pages.ts'
import { getPrototypeDirPath } from './storage.ts'

/**
 * The address, or a refusal that says what to fix.
 *
 * One function for every entry point (adding an overlay page, pointing one
 * somewhere else), so the rule "an overlay's address has to be one a browser can
 * actually open" cannot be stricter in one place than another. A scheme-less
 * value is the common typo, and without this it would be recorded happily and fail
 * much later, as a navigation error with nothing pointing back at the config.
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

/** Which overlay page a bare "point it somewhere else" means: the entry if it is one, otherwise the first. */
export function pickOverlayPage(pages: PrototypePage[], wanted?: string): PrototypePage {
  if (wanted) {
    const page = pages.find((candidate) => candidate.name === wanted)
    if (!page) {
      const names = pages.map((candidate) => candidate.name).join(', ') || 'none'
      throw new Error(`This prototype has no page "${wanted}". Pages: ${names}`)
    }
    return page
  }

  const entry = pages.find((page) => page.entry && page.kind === 'overlay')
  return entry ?? pages.find((page) => page.kind === 'overlay') ?? pages[0]!
}

/**
 * Point one overlay page at a different address.
 *
 * Only the page's own rules are enforced (it has to be an overlay, the address has
 * to be openable, and no other page may already claim it); whether the patches
 * still fit the new page is the caller's risk to take, and taking it is the point
 * (see the module note).
 *
 * @throws when the prototype does not exist, when there is no overlay page to
 *   point (nothing for an address to mean), or when the value is not openable.
 */
export function setPrototypePageUrl(
  workspaceRootPath: string,
  slug: string,
  url: string,
  page?: string,
): PrototypeConfig {
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
    throw new Error(`Prototype "${slug}" does not exist. See "list" for what exists.`)
  }

  const pages = listPrototypePages(workspaceRootPath, slug)
  if (pages.length === 0) {
    throw new Error(
      `Prototype "${slug}" has no pages, so there is no overlay page to point anywhere. ` +
        `Add one with "pages --add <name>=<url>" first.`,
    )
  }

  const target = pickOverlayPage(pages, page)
  if (target.kind !== 'overlay') {
    throw new Error(
      `Page "${target.name}" of prototype "${slug}" is a scratch page: it is our own ${target.file ?? 'document'}, ` +
        `so there is no external page for an address to mean. Add an overlay page instead ` +
        `("pages --add <name>=<url>").`,
    )
  }

  const next = requireTargetUrl(url)
  const claimed = pages.find((candidate) => candidate.name !== target.name && candidate.url === next)
  if (claimed) {
    throw new Error(`Prototype "${slug}" already has page "${claimed.name}" at "${next}".`)
  }

  const config = readPrototypeConfig(workspaceRootPath, slug)
  const rows = (config.pages ?? []).map((row) =>
    row.name === target.name ? { ...row, kind: 'overlay' as const, url: next } : row,
  )
  writePrototypeConfig(workspaceRootPath, slug, { ...config, pages: rows })

  return readPrototypeConfig(workspaceRootPath, slug)
}
