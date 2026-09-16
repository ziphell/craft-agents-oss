/**
 * Which prototype a page is showing — the answer the agent-side browser tools
 * attach to a page, next to its real URL (plan §22).
 *
 * **The page decides first, and that is the whole point.** A window used to be one
 * prototype's, so "which prototype" was answered by *whose window it is* — the
 * conversation's binding. A window holds pages of several prototypes now, so the
 * question belongs to the page: `BrowserTabSummary.prototype` is recorded when the
 * page is created and it is the only answer that survives an overlay loading a
 * third-party address. The conversation's binding is what is left when the page is
 * silent — a page opened with no prototype in mind, being studied as part of one.
 *
 * The **kind** is a fact about a *page*, not about the prototype (plan §19): one
 * flow may mix pages of ours with pages of someone else's site, so it is read off
 * the prototype's own page table. `kind` and `page` are both null when the page is
 * on the prototype's address but on no page the table describes — the generated
 * page index, or a path no page claims.
 *
 * `origin` is the prototype's **own** address (`http://<slug>-<hash>.localhost/`),
 * which differs from the page's URL for an overlay and coincides with it for a page
 * of ours.
 *
 * Kept as a function of its inputs rather than a method on the session, because it
 * is the rule the whole multi-prototype story rests on: a caller that gets it wrong
 * tells an agent to patch one prototype while it is looking at another.
 *
 * @see docs/prototype-workbench-plan.md §22
 */

import type { BrowserTabSummary } from '@craft-agent/shared/protocol'
import type { PrototypeWindowDescriptor } from '@craft-agent/shared/prototypes'
import {
  listPrototypePages,
  matchPrototypePage,
  prototypeOriginUrl,
} from '@craft-agent/shared/prototypes'

export function describePrototypeAtPage(
  /** The page on screen, as the browser side reports it. */
  tab: BrowserTabSummary | undefined,
  /** The conversation's own prototype, for a page that belongs to none. */
  fallbackSlug: string | null | undefined,
  /** The page's real address, for placing a page the table has to be asked about. */
  url: string | null | undefined,
  workspaceRootPath: string,
): PrototypeWindowDescriptor | null {
  const slug = tab?.prototype?.slug ?? fallbackSlug
  if (!slug) return null

  const pages = listPrototypePages(workspaceRootPath, slug)

  // The page name comes from the browser side when it was the one who named the
  // prototype (it asked the page table itself); otherwise the table is asked here,
  // because a page sitting on this prototype's address is worth placing even when
  // nothing declared it.
  const page = tab?.prototype?.slug === slug
    ? tab.prototypePage ?? null
    : matchPrototypePage(pages, url ?? null)

  return {
    slug,
    kind: pages.find((candidate) => candidate.name === page)?.kind ?? null,
    origin: prototypeOriginUrl(workspaceRootPath, slug),
    page,
  }
}
