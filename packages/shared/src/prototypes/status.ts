/**
 * Prototype status — the control-plane view of a prototype.
 *
 * Composes the derived facts (pages, patches, services, contract, exports) with
 * the ownership check into one report, so the state of a prototype can be
 * inspected without opening the filesystem by hand.
 *
 * All facts are recomputed from disk; nothing here is cached or persisted.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import { readPrototypeConfig } from './config.ts'
import { buildMockRoutes, composeContract, listContractServices, loadContractService } from './contract.ts'
import { describePrototypePages, findEntryPage, type PrototypePage } from './pages.ts'
import { PROTOTYPE_LANES, resolvePrototypeOwnership } from './ownership.ts'
import { prototypeOriginUrl } from './url.ts'
import {
  getPrototypeDistPath,
  getPrototypePatchesPath,
  getPrototypeDirPath,
  listPrototypePatchPages,
  scanPrototypePatches,
} from './storage.ts'

export interface PrototypeStatusService {
  slug: string
  fragments: number
  fixtures: number
  endpoints: number
  mockedEndpoints: number
  /** `x-mock` fixtures referenced by the contract but not present on disk. */
  missingFixtures: string[]
}

export interface PrototypeStatus {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /**
   * Slugs of prototypes this one is studied from (plan §14). Raw slugs rather
   * than resolved values: callers that need more join against their own status
   * list, and the one caller that needs a page (the prompt) resolves it from that
   * reference's own table.
   */
  references: string[]
  /**
   * The pages of this prototype, in flow order (plan §19): declared rows first,
   * then the documents nobody declared, by name.
   */
  pages: PrototypePage[]
  /**
   * The page the address root opens, or null when it shows the **generated page
   * index** — the default, because no page of a flow is naturally the first one
   * (plan §19.3).
   */
  entryPage: string | null
  /**
   * Everything worth saying out loud about the table: rows that could not be read
   * (`config.ts`), a declared page whose document is gone, and a
   * `patches/<name>/` directory that matches no page. All three are silent
   * failures otherwise — a screen that is not there, or a patch nothing replays.
   */
  pageIssues: string[]
  /**
   * Whether there is something to open — the same condition
   * `resolvePrototypeEntry` enforces, so the panel cannot offer a button that
   * fails: there has to be a page, and an address to show it on (a live page's own
   * address, or the host that renders ours). Two statements of one rule can drift,
   * so a test walks every combination of entry/page/host.
   */
  pageAvailable: boolean
  patches: {
    total: number
    byLane: Record<string, number>
    /** How many patches are page-scoped (`patches/<page>/…`) rather than shared. */
    scoped: number
    /**
     * Absolute paths of every patch that will actually be replayed, in replay
     * order. Files whose names do not match the convention are absent — the
     * same set the injector uses, so the panel cannot list something that is
     * silently ignored.
     */
    files: string[]
  }
  services: PrototypeStatusService[]
  /**
   * Entries under `dist/`. Folders are listed with a trailing `/` — the
   * deliverable *is* one (`extension/`), so a listing that only counted files
   * would report an exported prototype as having nothing exported.
   */
  distFiles: string[]
  ownership: { inspected: number; violations: Array<{ path: string; reason: string }> }
  /** Lane id → description, so callers can render names without a second import. */
  lanes: Record<string, string>
}

function listFileNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.isFile() ? entry.name : null))
      .filter((name): name is string => name !== null)
      .sort()
  } catch {
    return []
  }
}

/**
 * List every prototype in a workspace, each with its full status.
 *
 * A directory under `prototypes/` counts as a prototype even without pages —
 * patches can legitimately be collected before a page is written, and the status
 * reports `pageAvailable: false` so the caller can say so.
 */
export function listPrototypeStatuses(workspaceRootPath: string): PrototypeStatus[] {
  let entries
  try {
    entries = readdirSync(getWorkspacePrototypesPath(workspaceRootPath), { withFileTypes: true })
  } catch {
    // The prototypes folder is created lazily, so a missing one means "none yet".
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((slug) => buildPrototypeStatus(workspaceRootPath, slug))
}

/** Build the full status report for a prototype. */
export function buildPrototypeStatus(workspaceRootPath: string, slug: string): PrototypeStatus {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)

  const patches = scanPrototypePatches(workspaceRootPath, slug)
  const patchesDir = getPrototypePatchesPath(workspaceRootPath, slug)
  const byLane: Record<string, number> = {}
  for (const patch of patches) {
    const lane = patch.lane?.toUpperCase() ?? '?'
    byLane[lane] = (byLane[lane] ?? 0) + 1
  }

  const services: PrototypeStatusService[] = listContractServices(workspaceRootPath, slug).map((serviceSlug) => {
    const service = loadContractService(workspaceRootPath, slug, serviceSlug)
    const composed = composeContract(service)
    const mock = buildMockRoutes(service)
    return {
      slug: serviceSlug,
      fragments: service.fragments.length,
      fixtures: Object.keys(service.fixtures).length,
      endpoints: composed.endpoints.length,
      mockedEndpoints: mock.routes.length,
      missingFixtures: mock.missingFixtures,
    }
  })

  const config = readPrototypeConfig(workspaceRootPath, slug)
  const { pages, issues } = describePrototypePages(workspaceRootPath, slug)
  const entry = findEntryPage(pages)
  const origin = prototypeOriginUrl(workspaceRootPath, slug)

  // A patch directory that matches no page is a change nothing will ever replay:
  // the directory *is* the ownership rule (plan §19.4), so a name that is not a
  // page is a typo rather than an empty scope.
  const pageNames = new Set(pages.map((page) => page.name))
  for (const patchPage of listPrototypePatchPages(workspaceRootPath, slug)) {
    if (!pageNames.has(patchPage)) {
      issues.push(
        `patches/${patchPage}/ belongs to no page of this prototype, so nothing there is replayed. ` +
          `Pages: ${[...pageNames].join(', ') || 'none'}`,
      )
    }
  }

  const ownership = resolvePrototypeOwnership(workspaceRootPath, slug)

  return {
    slug,
    dir,
    references: config.references ?? [],
    pages,
    entryPage: entry?.name ?? null,
    pageIssues: issues,
    // Opening needs a page and an address. An overlay page's address is its own —
    // it is a real site — while a document of ours and the generated page index are
    // rendered by the host, so with no host there is nothing to open; a document
    // that is gone is not a page either. The same condition
    // `resolvePrototypeEntry` enforces, combination by combination (a test walks
    // them).
    pageAvailable:
      pages.length > 0 &&
      (entry?.kind === 'overlay' ? entry.url !== null : origin !== null && (!entry || entry.file !== null)),
    patches: {
      total: patches.length,
      byLane,
      scoped: patches.filter((patch) => patch.page !== null).length,
      files: patches.map((patch) => join(patchesDir, patch.file)),
    },
    services,
    distFiles: listFileNames(getPrototypeDistPath(workspaceRootPath, slug)),
    ownership: { inspected: ownership.inspected, violations: ownership.violations },
    lanes: { ...PROTOTYPE_LANES },
  }
}
