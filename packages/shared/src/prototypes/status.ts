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
import { readPrototypeConfig } from './config.ts'
import { notice, type PrototypeNotice } from './notices.ts'
import { buildMockRoutes, composeContract, listContractServices, loadContractService } from './contract.ts'
import { describePrototypePages, findEntryPage, type PrototypePage } from './pages.ts'
import { resolvePrototypeOwnership } from './ownership.ts'
import { resolveRequirementCoverage, type RequirementDispute } from './coverage.ts'
import { listFrameCaptures } from './frames.ts'
import { readAllPrototypeAnchors, resolveAnchorOrphans, SHARED_ANCHOR_SCOPE, type PrototypeAnchor } from './anchors.ts'
import { readPrototypeFindings } from './research.ts'
import { PROTOTYPE_PRD_FILENAME, type PrototypeCheck } from './requirements.ts'
import { readAcceptanceState, summarizeAcceptance, type AcceptanceSummary } from './acceptance.ts'
import type { PrototypeReviewStatus } from './reviews.ts'
import { prototypeOriginUrl } from './url.ts'
import {
  getPrototypeDistPath,
  getPrototypePatchesPath,
  getPrototypeDirPath,
  listPrototypeFiles,
  listPrototypePatchPages,
  patchFingerprint,
  scanPrototypePatches,
  type PrototypeFileEntry,
} from './storage.ts'

export interface PrototypeStatusService {
  slug: string
  fragments: number
  fixtures: number
  endpoints: number
  mockedEndpoints: number
  /**
   * How many mocked routes remember state (a path declaring `x-mock-collection`, plan §5.3).
   *
   * Apart from {@link mockedEndpoints} because it answers a different question: a service with
   * stateful routes is not a set of fixed answers — the screens of the flow depend on each other,
   * and what the last request did is what the next one shows.
   */
  statefulEndpoints: number
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
  /** Arguments against it — filed against it, or against something that serves it. */
  disputes: RequirementDispute[]
  /** The acceptance checks the PRD puts under it (`check:` lines). */
  checks: PrototypeCheck[]
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
   *
   * Notices rather than sentences (`notices.ts`): the panel shows these in the
   * reader's language, the agent prints `text`.
   */
  pageIssues: PrototypeNotice[]
  /**
   * The PRD's requirements, each with the pages, patches and findings that refer
   * to it (plan §20.1). Empty when there is no `PRD.md`, which is the honest
   * state of a prototype whose requirements have not been written down yet.
   */
  requirements: PrototypeStatusRequirement[]
  /**
   * `PRD.md` — the brief, and the one file requirements are read from (plan §20.1). Null when it
   * has not been written down yet, which is the honest state of a prototype just created.
   */
  entryDocument: PrototypeFileEntry | null
  /**
   * Everything else in the prototype's own directory, in **any format** — the folder is the
   * author's and there is no rule about what may sit in it (`listPrototypeFiles`).
   *
   * Paths rather than text: the panel reads what it shows through `file:read`, and a list of
   * status reports is no place to carry every prototype's files.
   */
  files: PrototypeFileEntry[]
  /** Findings under `research/` — what was learned about other products (plan §20.2). */
  findings: PrototypeStatusFinding[]
  /**
   * The argument against the work (`reviews/`, plan §3.7).
   *
   * Read from the files, like every other fact here — and derived *once*: the per-requirement
   * disputes in `requirements[].disputes` and this list are the same `RequirementDispute` objects,
   * so the panel cannot show a requirement as settled while the summary says otherwise.
   */
  reviews: {
    total: number
    byStatus: Record<PrototypeReviewStatus, number>
    /** Every dispute that still stands, in id order. */
    unresolved: RequirementDispute[]
  }
  /**
   * What the last verification answered, or null when the checks have never run here
   * (`acceptance/state.json` — our memory, never part of the deliverable).
   */
  acceptance: AcceptanceSummary | null
  /**
   * What this prototype still owes, in one place, because "is it done?" is one question: a
   * requirement nothing implements, an objection nobody answered, a check the last round failed.
   *
   * The three are deliberately *not* folded into one number — each is a different action — but they
   * share a field because a gate has to see them together (`whyPrototypeIsNotSettled`).
   */
  unresolved: {
    /** Requirement ids nothing implements — the proposal claims what the delivery does not do. */
    unmet: string[]
    /** Disputes that still stand: open, or a record that disagrees with the files. */
    disputes: RequirementDispute[]
    /** Checks the last round answered `fail`, as `kind: target`. */
    redChecks: string[]
  }
  /**
   * {@link whyPrototypeIsNotSettled} of this very report — the gate in its own words, carried as
   * data so the panel can say what stands between the work and its handover.
   *
   * It is computed here rather than by each reader for the reason the gate exists at all: two
   * statements of "is it done?" would drift. The renderer is a reader now, and it cannot call a
   * runtime function from the shared barrel (dev doc §3.6), so the verdict travels with the facts
   * it was reached from. Empty when there is nothing outstanding.
   */
  settleBlockers: PrototypeNotice[]
  /**
   * Everything worth saying about the PRD and the research: an entry that could
   * not be read, a requirement nothing implements, a reference to an id the PRD
   * does not define, a finding with no claim or with evidence that is not on
   * disk. Each is a silent failure otherwise — precisely the kind this report
   * exists to make loud.
   */
  briefIssues: PrototypeNotice[]
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
    byWriter: Record<string, number>
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
      writer: string | null
      page: string | null
      targets: string[]
      /**
       * The patch's content fingerprint. Printed so a dispute can record `on:` without writing a
       * hash by hand (`reviews.ts`), which is what makes a stale argument detectable at all.
       */
      fingerprint: string
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
    issues: PrototypeNotice[]
  }
  services: PrototypeStatusService[]
  /**
   * Entries under `dist/`. Folders are listed with a trailing `/` — the
   * deliverable *is* one (`extension/`), so a listing that only counted files
   * would report an exported prototype as having nothing exported.
   */
  distFiles: string[]
  ownership: { inspected: number; violations: Array<{ path: string; reason: string }> }
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
  const byWriter: Record<string, number> = {}
  for (const patch of patches) {
    // Keyed by the writer id as written in the name (case preserved): the report groups by who
    // wrote what, and an agent-chosen id has no canonical spelling to normalize to.
    const writer = patch.writer ?? '?'
    byWriter[writer] = (byWriter[writer] ?? 0) + 1
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
      statefulEndpoints: mock.routes.filter((route) => route.state !== undefined).length,
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
        notice('page.patchScopeUnmatched', {
          name: patchPage,
          pages: [...pageNames].join(', ') || 'none',
        }),
      )
    }
  }

  const ownership = resolvePrototypeOwnership(workspaceRootPath, slug)

  // The thread from the PRD to what implements it, derived in one place so this
  // report and the delivered dev spec cannot disagree (see `coverage.ts`).
  const coverage = resolveRequirementCoverage(workspaceRootPath, slug)
  // The prototype's own files, and which of them is the brief. No filter of any kind: the folder
  // is the author's, and what sits in it is their business (plan §20.1).
  const { entry: entryDocument, files } = listPrototypeFiles(
    workspaceRootPath,
    slug,
    PROTOTYPE_PRD_FILENAME,
  )
  const findings = readPrototypeFindings(workspaceRootPath, slug)
  const frameCaptures = listFrameCaptures(workspaceRootPath, slug)
  // What the checks answered last time: a fact about a run, so it is read from the record
  // `verify` wrote rather than remembered here.
  const acceptance = summarizeAcceptance(readAcceptanceState(workspaceRootPath, slug))

  // Anchors: what each declared `@target` matched, and which records nothing
  // declares any more. The second is the disk-derivable half of drift — the
  // other half needs a browser (a target that stopped matching the live page) and
  // is reported by an apply.
  const anchorFiles = readAllPrototypeAnchors(workspaceRootPath, slug)
  const anchors = resolveAnchorOrphans(anchorFiles, patches)
  const anchorIssues = anchors.orphaned.map((anchor) => notice('anchor.orphaned', { target: anchor.target }))

  const briefIssues = [...coverage.issues]

  const report: Omit<PrototypeStatus, 'settleBlockers'> = {
    slug,
    dir,
    pages,
    entryPage: entry?.name ?? null,
    pageIssues: issues,
    requirements: coverage.requirements,
    entryDocument,
    files,
    reviews: coverage.reviews,
    acceptance,
    unresolved: {
      unmet: coverage.requirements
        .filter((requirement) => requirement.pages.length === 0 && requirement.patches.length === 0)
        .map((requirement) => requirement.id),
      disputes: coverage.reviews.unresolved,
      redChecks: acceptance?.red ?? [],
    },
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
      byWriter,
      scoped: patches.filter((patch) => patch.page !== null).length,
      files: patches.map((patch) => join(patchesDir, patch.file)),
      entries: patches.map((patch) => ({
        file: patch.file,
        kind: patch.kind,
        writer: patch.writer,
        page: patch.page,
        targets: patch.targets,
        fingerprint: patchFingerprint(patch.source),
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
  }

  // The gate's verdict travels with the facts it was reached from, so every reader — the strict
  // export, the status output, the panel — answers "is it done?" the same way. Computed after the
  // literal because it reads the report it belongs to.
  return { ...report, settleBlockers: whyPrototypeIsNotSettled({ ...report, settleBlockers: [] }) }
}

/**
 * What this prototype still owes — empty when there is nothing outstanding.
 *
 * This is the **gate**, expressed once: `export --strict` refuses on a non-empty list, the
 * status output prints it, and a task graph branches on it. Reason-first, like the write guard and
 * for the same reader — an agent that has to decide whether to keep working, or whether what it has
 * is finished.
 *
 * Three things count, and they are deliberately not summed into one number: a requirement nothing
 * implements, an objection nobody answered, a check that failed. Each is a different action — and
 * each is a {@link PrototypeNotice}, so the panel can name the action in the reader's language while
 * the sentence the agent prints stays the one above.
 *
 * With the one a person meets on the screen that hands the work over: a service that declares a
 * faked response which is not on disk. It is a delivery fact rather than a mechanism detail — the
 * request is simply not faked, so whoever receives this gets a page that reaches for something they
 * do not have (plan §21.5).
 */
export function whyPrototypeIsNotSettled(status: PrototypeStatus): PrototypeNotice[] {
  const reasons: PrototypeNotice[] = []
  const prd = PROTOTYPE_PRD_FILENAME

  for (const id of status.unresolved.unmet) {
    reasons.push(notice('gate.requirementUnmet', { id, prd }))
  }

  for (const dispute of status.unresolved.disputes) {
    const about = dispute.stale && dispute.staleReason ? `${dispute.about} — ${dispute.staleReason}` : dispute.about
    reasons.push(
      notice('gate.disputeStanding', { file: dispute.file, about, status: dispute.status }),
    )
  }

  for (const check of status.unresolved.redChecks) {
    reasons.push(notice('gate.checkFailed', { check }))
  }

  // A PRD that carries checks nobody has ever run is the one state the record cannot show: the
  // file exists, so "no failures" and "never looked" look identical from here.
  const declaresChecks = status.requirements.some((requirement) => requirement.checks.length > 0)
  if (declaresChecks && status.acceptance === null) {
    reasons.push(notice('gate.checksNeverRun', { prd }))
  }

  // A contract that names a `x-mock` fixture which is not there is a hole in what is handed over:
  // the route is skipped, so the request goes to a backend the recipient may not have. One line per
  // service rather than per fixture — the fix is one edit, and the names are in the line.
  for (const service of status.services) {
    if (service.missingFixtures.length === 0) continue
    reasons.push(
      notice('gate.serviceUncovered', {
        service: service.slug,
        fixtures: service.missingFixtures.join(', '),
      }),
    )
  }

  return reasons
}
