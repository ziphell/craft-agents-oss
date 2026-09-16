/**
 * Prototype status — the control-plane view of a prototype.
 *
 * Composes the derived facts (pages, patches, services, contract, exports) with
 * the ownership check into one report, so the state of a prototype can be
 * inspected without opening the filesystem by hand.
 *
 * All facts are recomputed from disk; nothing here is cached or persisted.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import { projectExists } from '../projects/storage.ts'
import { readPrototypeConfig } from './config.ts'
import { buildMockRoutes, composeContract, listContractServices, loadContractService } from './contract.ts'
import { describePrototypePages, findEntryPage, type PrototypePage } from './pages.ts'
import { PROTOTYPE_LANES, resolvePrototypeOwnership } from './ownership.ts'
import { resolveRequirementCoverage } from './coverage.ts'
import { listFrameCaptures } from './frames.ts'
import { readAllPrototypeAnchors, resolveAnchorOrphans, SHARED_ANCHOR_SCOPE, type PrototypeAnchor } from './anchors.ts'
import { readPrototypeFindings } from './research.ts'
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

/**
 * One requirement, and what implements it.
 *
 * The three lists are the whole value. A requirement whose lists are all empty is
 * the finding this report exists to produce: the delivery claims something that
 * nothing in it does (plan §20.1).
 */
export interface PrototypeStatusRequirement {
  id: string
  title: string
  /** Pages whose document declares it (`<!-- @requirement R-001 -->`). */
  pages: string[]
  /** Patch files that declare it, as `patches/…` paths. */
  patches: string[]
  /** Findings in `research/` that argue for it. */
  findings: string[]
}

/** A finding from `research/` — what was learned, and about whose product (plan §20.2). */
export interface PrototypeStatusFinding {
  id: string
  /** Null when the file has no `claim:` line — reported in `briefIssues`. */
  claim: string | null
  /** The address it was observed at. */
  source: string | null
  /** Requirement ids it argues for. */
  requirements: string[]
  /** Path relative to the prototype directory, e.g. `research/F-001-sticky.md`. */
  file: string
}

/** A frame capture session, as the panel lists it (plan §20.3). */
export interface PrototypeStatusFrameCapture {
  /** Directory name under `research/frames/`, e.g. `20260915-183012`. */
  session: string
  /** Path relative to the prototype directory. */
  file: string
  startedAt: string
  frames: number
  /** True when the capture hit its ceiling — a sample rather than the session. */
  truncated: boolean
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
   * The workspace project this prototype was made for, or null (plan §15.1).
   *
   * An edge, not a nesting: nothing of the prototype lives in the project. The
   * status carries it so the panel can show which project a prototype belongs to,
   * and so a dangling edge — a project since deleted — can be reported.
   */
  projectSlug: string | null
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
   * The PRD's requirements, each with the pages, patches and findings that refer
   * to it (plan §20.1). Empty when there is no `prd.md`, which is the honest
   * state of a prototype whose requirements have not been written down yet.
   */
  requirements: PrototypeStatusRequirement[]
  /** Findings under `research/` — what was learned about other products (plan §20.2). */
  findings: PrototypeStatusFinding[]
  /**
   * Everything worth saying about the PRD and the research: an entry that could
   * not be read, a requirement nothing implements, a reference to an id the PRD
   * does not define, a finding with no claim or with evidence that is not on
   * disk. Each is a silent failure otherwise — precisely the kind this report
   * exists to make loud.
   */
  briefIssues: string[]
  /**
   * Frame captures of the browser window, newest first (plan §20.3).
   *
   * Read from the files rather than remembered: the index beside the images is
   * the record, so this listing and what a finding can cite are one thing.
   */
  frameCaptures: PrototypeStatusFrameCapture[]
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
    /**
     * The same patches with what their headers declare — the page they belong to
     * and the selectors they are aimed at (`@target`).
     *
     * Listed here rather than left in the files because a reader who wants to
     * know *what a change is aimed at* should not have to open every patch, and
     * because `targets` being empty is a fact worth seeing: nothing can check
     * what that patch matched (plan §21.1).
     */
    entries: Array<{
      /** Path relative to `patches/`, e.g. `cart/A-001-btn.css`. */
      file: string
      kind: string
      lane: string | null
      page: string | null
      targets: string[]
    }>
  }
  /**
   * The anchor records (`anchors/`): what each declared `@target` matched, and
   * when (plan §21.2).
   *
   * Read from the files rather than remembered, like every other derived fact
   * here — the record beside the patches *is* the evidence, so what this lists
   * and what a drift check compares against are one thing.
   */
  anchors: {
    files: Array<{
      /** `shared` for `patches/*`, otherwise the page name. */
      scope: string
      page: string | null
      url: string | null
      updatedAt: string
      anchors: PrototypeAnchor[]
    }>
    /**
     * Anchors nothing declares any more — a patch edited or deleted, with its
     * record left behind. Named rather than dropped: a record that outlives its
     * patch is how a stale selector keeps looking checked.
     */
    issues: string[]
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

  // The thread from the PRD to what implements it, derived in one place so this
  // report and the delivered dev spec cannot disagree (see `coverage.ts`).
  const coverage = resolveRequirementCoverage(workspaceRootPath, slug)
  const findings = readPrototypeFindings(workspaceRootPath, slug)
  const frameCaptures = listFrameCaptures(workspaceRootPath, slug)

  // Anchors: what each declared `@target` matched, and which records nothing
  // declares any more. The second is the disk-derivable half of drift — the
  // other half needs a browser (a target that stopped matching the live page) and
  // is reported by an apply.
  const anchorFiles = readAllPrototypeAnchors(workspaceRootPath, slug)
  const anchors = resolveAnchorOrphans(anchorFiles, patches)
  const anchorIssues = anchors.orphaned.map(
    (anchor) =>
      `anchors/${anchor.target} was recorded but no patch declares it any more — the patch was edited or ` +
      `removed, and the record outlived it.`,
  )

  const briefIssues = [...coverage.issues]
  // An edge naming a project that is gone: nothing else in the workspace would
  // notice, and the panel would go on showing the name as if it still resolved.
  if (config.projectSlug && !projectExists(workspaceRootPath, config.projectSlug)) {
    briefIssues.push(
      `This prototype belongs to project "${config.projectSlug}", which no longer exists.`,
    )
  }

  return {
    slug,
    dir,
    references: config.references ?? [],
    projectSlug: config.projectSlug ?? null,
    pages,
    entryPage: entry?.name ?? null,
    pageIssues: issues,
    requirements: coverage.requirements,
    findings: findings.findings.map((finding) => ({
      id: finding.id,
      claim: finding.claim,
      source: finding.source,
      requirements: finding.requirements,
      file: finding.file,
    })),
    briefIssues,
    frameCaptures,
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
      entries: patches.map((patch) => ({
        file: patch.file,
        kind: patch.kind,
        lane: patch.lane,
        page: patch.page,
        targets: patch.targets,
      })),
    },
    anchors: {
      files: anchorFiles.map((file) => ({
        scope: file.page ?? SHARED_ANCHOR_SCOPE,
        page: file.page,
        url: file.url,
        updatedAt: file.updatedAt,
        anchors: file.anchors,
      })),
      issues: anchorIssues,
    },
    services,
    distFiles: listFileNames(getPrototypeDistPath(workspaceRootPath, slug)),
    ownership: { inspected: ownership.inspected, violations: ownership.violations },
    lanes: { ...PROTOTYPE_LANES },
  }
}
