/**
 * Prototype status — the control-plane view of a prototype.
 *
 * Composes the derived facts (patches, services, contract, exports) with the
 * ownership check into one report, so the state of a prototype can be inspected
 * without opening the filesystem by hand.
 *
 * All facts are recomputed from disk; nothing here is cached or persisted.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import { readPrototypeConfig, type PrototypeKind } from './config.ts'
import { buildMockRoutes, composeContract, listContractServices, loadContractService } from './contract.ts'
import { PROTOTYPE_LANES, resolvePrototypeOwnership } from './ownership.ts'
import { getPrototypeDistPath, getPrototypePatchesPath, getPrototypeDirPath, scanPrototypePatches } from './storage.ts'

const BASE_FILENAME = 'base.html'

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
  /** Which kind of prototype this is (fixed at creation). */
  kind: PrototypeKind
  /** `overlay` only: the page this prototype injects into. */
  targetUrl?: string
  /**
   * Slugs of prototypes this one is studied from (plan §14). Raw slugs rather
   * than resolved values: callers that need more join against their own status
   * list, and the one caller that needs `kind`/`targetUrl` (the prompt) resolves
   * it from that reference's own config.
   */
  references: string[]
  /**
   * Whether a `base.html` exists on disk. It is the page for a from-scratch
   * prototype, and by design absent for an overlay, whose page is a live
   * address. For "is there something to open", use {@link pageAvailable}.
   */
  baseHtmlPresent: boolean
  /**
   * Whether there is a page to open — the same condition `resolvePrototypeEntry`
   * enforces, and deliberately not just `baseHtmlPresent`.
   *
   * The two kinds get their page from different places, so "is there something to
   * open" is not one question: an overlay's page is the live address it was
   * created against (it needs no file at all), while a from-scratch prototype's
   * page is its own `base.html` rendered by the host. Two statements of one rule
   * can drift, so a test asserts this agrees with `resolvePrototypeEntry` for
   * every combination.
   */
  pageAvailable: boolean
  /** Absolute path to `base.html`, or null when the prototype has none. */
  baseHtmlPath: string | null
  patches: {
    total: number
    byLane: Record<string, number>
    /**
     * Absolute paths of every patch that will actually be replayed, in replay
     * order. Files whose names do not match the convention are absent — the
     * same set the injector uses, so the panel cannot list something that is
     * silently ignored.
     */
    files: string[]
  }
  services: PrototypeStatusService[]
  /** File names under `dist/`. */
  distFiles: string[]
  ownership: { inspected: number; violations: Array<{ path: string; reason: string }> }
  /** Lane id → description, so callers can render names without a second import. */
  lanes: Record<string, string>
}

function listFileNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * List every prototype in a workspace, each with its full status.
 *
 * A directory under `prototypes/` counts as a prototype even without `base.html` — patches
 * can legitimately be collected before the base page is written, and the status
 * reports `baseHtmlPresent: false` so the caller can say so.
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

  const ownership = resolvePrototypeOwnership(workspaceRootPath, slug)
  const baseHtmlPath = join(dir, BASE_FILENAME)
  const config = readPrototypeConfig(workspaceRootPath, slug)

  return {
    slug,
    dir,
    kind: config.kind,
    ...(config.targetUrl ? { targetUrl: config.targetUrl } : {}),
    references: config.references ?? [],
    baseHtmlPresent: existsSync(baseHtmlPath),
    pageAvailable: config.kind === 'overlay' ? Boolean(config.targetUrl) : existsSync(baseHtmlPath),
    baseHtmlPath: existsSync(baseHtmlPath) ? baseHtmlPath : null,
    patches: {
      total: patches.length,
      byLane,
      files: patches.map((patch) => join(patchesDir, patch.file)),
    },
    services,
    distFiles: listFileNames(getPrototypeDistPath(workspaceRootPath, slug)),
    ownership: { inspected: ownership.inspected, violations: ownership.violations },
    lanes: { ...PROTOTYPE_LANES },
  }
}
