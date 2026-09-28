/**
 * Websites, answered by Electron at their own origin.
 *
 * A website is a **directory** (`websites/<slug>/`) served at
 * `http://<label>.localhost/` — the same mechanism a prototype's pages use
 * (`local-origin.ts` in the shared package), and for the same reason: its documents
 * need a real origin before they can load their own files by root-absolute path,
 * keep state in `localStorage`, or `fetch` anything at all.
 *
 * What this module owns is the **registry**: which websites have been handed an
 * address in this run. Handing one out is also the security boundary — the host
 * never walks the filesystem looking for things to serve, so an address exists for
 * the websites the app has actually shown, and for nothing else. `*.localhost` is
 * full of real dev servers, which is why an unregistered label goes straight back
 * to Chromium (`serveWebsiteRequest` returns null and the caller passes it on).
 *
 * The routing itself is `@craft-agent/shared/websites/host.ts` (which file a path
 * names, and which names the host keeps for itself); what is left here is IO.
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { contentTypeFor, labelFromHost, localHostLabel, localHostOrigin } from '@craft-agent/shared/local-origin'
import { getWebsitePath } from '@craft-agent/shared/websites'
import { resolveWebsiteRequest, type ServedWebsite } from '@craft-agent/shared/websites/host'
import { fileResponse, isFile, textResponse } from './local-http'
import { mainLog } from './logger'

/** label → website. Populated only by {@link websiteOriginUrl}. */
const served = new Map<string, ServedWebsite>()

/**
 * The origin a website is reachable at, registering it so that origin answers.
 *
 * Null when the website has no directory (deleted while a window kept its link), so
 * a stale link degrades to "no address" instead of an address that 404s.
 *
 * Registration is per run, like a prototype's: the label is stable across restarts,
 * but a page opened from a previous run is only reachable once this run has handed
 * its address out again.
 */
export function websiteOriginUrl(workspaceRootPath: string, slug: string): string | null {
  const dir = resolve(getWebsitePath(workspaceRootPath, slug))
  if (!existsSync(dir)) return null

  const label = localHostLabel(slug, dir)
  served.set(label, { workspaceRootPath, slug, dir })
  return localHostOrigin(label)
}

/** The website a label names, if this run has handed its address out. */
export function resolveServedWebsite(url: string): ServedWebsite | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  const label = labelFromHost(host)
  return label ? served.get(label) ?? null : null
}

/**
 * Answer a request for a website, or null when the host is not one of ours.
 *
 * Null is the common case and the caller's answer to it is the pass-through: a
 * request for a host we never handed out an address for is not ours to answer,
 * however much it looks like one of ours.
 */
export async function serveWebsiteRequest(request: Request): Promise<Response | null> {
  const website = resolveServedWebsite(request.url)
  if (!website) return null

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, '', { allow: 'GET, HEAD' })
    }

    const requested = new URL(request.url).pathname.replace(/^\/+/, '')
    const resolution = resolveWebsiteRequest(
      website,
      requested,
      request.headers.get('accept') ?? undefined,
    )

    if (resolution.kind === 'refused') return textResponse(403, resolution.reason)
    if (resolution.kind === 'missing') return textResponse(404, resolution.reason)
    if (!(await isFile(resolution.path))) {
      return textResponse(404, `Nothing of this website is at /${requested}.`)
    }

    return fileResponse(request, {
      body: await readFile(resolution.path),
      contentType: contentTypeFor(resolution.path),
    })
  } catch (error) {
    // Never hand someone else's page a network error because *we* failed: this
    // branch is only reachable for a host that is ours.
    mainLog.warn(`[website-host] failed to serve ${request.url}: ${String(error)}`)
    return textResponse(500, 'The website could not be served. See the app logs.')
  }
}
