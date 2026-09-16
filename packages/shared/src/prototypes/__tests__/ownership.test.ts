import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  canLaneWrite,
  classifyPrototypePath,
  createPrototype,
  getContractFixturesPath,
  getContractPathsPath,
  getPrototypeConfigPath,
  getPrototypeDistPath,
  getPrototypePagePatchesPath,
  getPrototypePatchesPath,
  getPrototypeDirPath,
  isPrototypeLane,
  listPrototypeStatuses,
  resolvePrototypeOwnership,
  resolvePrototypeEntry,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
  writePrototypePage,
  type PrototypePageEntry,
} from '..'
import { getWorkspacePrototypesPath } from '../../workspaces/storage'

const DOCUMENT = '<!doctype html><html><body><h1>Cart</h1></body></html>'

describe('prototype path ownership', () => {
  it('assigns control-plane paths', () => {
    // Top-level documents and the page table are written by the control plane (the
    // agent, on the human's behalf) and read by the lanes.
    expect(classifyPrototypePath('cart.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('_layout.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('config.json')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('dist/extension/cart.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('services/checkout-api/openapi.yaml')).toEqual({
      owner: { kind: 'control-plane' },
    })
  })

  it('derives patch ownership from the lane in the file name', () => {
    expect(classifyPrototypePath('patches/A-001-btn.css')).toEqual({ owner: { kind: 'lane', lane: 'A' } })
    expect(classifyPrototypePath('patches/b-012-guard.js')).toEqual({ owner: { kind: 'lane', lane: 'B' } })
    // One level deeper is a page's own patch: the lane still owns it, and the
    // directory decides which page it changes (plan §19.4).
    expect(classifyPrototypePath('patches/cart/A-002-total.css')).toEqual({ owner: { kind: 'lane', lane: 'A' } })
  })

  it('flags a patch whose lane prefix is not a declared lane', () => {
    const result = classifyPrototypePath('patches/Y-001-btn.css')
    expect(result).toHaveProperty('violation')
    expect((result as { violation: string }).violation).toContain('unknown lane prefix "Y"')
  })

  /**
   * The consolidated lane is a lane (plan §21.3) — a folded patch is an ordinary
   * patch written by the control plane, so it is classified like one rather than
   * reported as an unknown prefix.
   */
  it('accepts the consolidated lane that a commit writes', () => {
    expect(classifyPrototypePath('patches/Z-001-upper.css')).toEqual({
      owner: { kind: 'lane', lane: 'Z' },
    })
    expect(classifyPrototypePath('patches/cart/Z-002-upper.js')).toEqual({
      owner: { kind: 'lane', lane: 'Z' },
    })
  })

  it('flags a misnamed patch rather than silently ignoring it', () => {
    expect(classifyPrototypePath('patches/notes.txt')).toEqual({
      violation: 'misnamed patch — expected {lane}-{nnn}-{name}.{css|js}, optionally under patches/<page>/',
    })
  })

  it('assigns contract and data paths to lanes B and C', () => {
    expect(classifyPrototypePath('services/api/paths/list-orders.yaml')).toEqual({
      owner: { kind: 'lane', lane: 'B' },
    })
    expect(classifyPrototypePath('services/api/config.json')).toEqual({ owner: { kind: 'lane', lane: 'B' } })
    expect(classifyPrototypePath('services/api/fixtures/list-orders-200.json')).toEqual({
      owner: { kind: 'lane', lane: 'C' },
    })
  })

  it('flags unowned paths', () => {
    expect(classifyPrototypePath('services/api/random.txt')).toEqual({
      violation: 'unowned file inside a service directory',
    })
    expect(classifyPrototypePath('README.md')).toEqual({ violation: 'unowned path' })
  })

  it('knows which lane ids are declared', () => {
    expect(isPrototypeLane('A')).toBe(true)
    expect(isPrototypeLane('D')).toBe(true)
    // Z is the consolidated lane a commit writes into (§21.3), so it is declared
    // like any other — what makes it different is its replay order, not its id.
    expect(isPrototypeLane('Z')).toBe(true)
    expect(isPrototypeLane('Y')).toBe(false)
  })
})

describe('lane write guard', () => {
  it('lets a lane write its own artifacts', () => {
    expect(canLaneWrite('patches/A-001-btn.css', 'A').ok).toBe(true)
    expect(canLaneWrite('patches/cart/A-002-total.css', 'A').ok).toBe(true)
    expect(canLaneWrite('services/api/paths/x.yaml', 'B').ok).toBe(true)
    expect(canLaneWrite('services/api/fixtures/x.json', 'C').ok).toBe(true)
  })

  it('refuses writes to another lane, with the reason', () => {
    const result = canLaneWrite('patches/B-001-btn.css', 'A')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('owned by lane B')
  })

  it('refuses writes to control-plane outputs', () => {
    expect(canLaneWrite('dist/extension/cart.html', 'A').reason).toBe('owned by the control plane')
    expect(canLaneWrite('cart.html', 'A').reason).toBe('owned by the control plane')
    expect(canLaneWrite('config.json', 'A').reason).toBe('owned by the control plane')
    expect(canLaneWrite('services/api/openapi.yaml', 'B').reason).toBe('owned by the control plane')
  })

  it('refuses writes to paths nobody owns', () => {
    expect(canLaneWrite('README.md', 'A').ok).toBe(false)
    expect(canLaneWrite('patches/notes.txt', 'A').ok).toBe(false)
  })
})

describe('resolvePrototypeOwnership', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-ownership-'))
    const prototypeDir = getPrototypeDirPath(workspaceRoot, slug)
    const patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    mkdirSync(patchesDir, { recursive: true })
    mkdirSync(getPrototypePagePatchesPath(workspaceRoot, slug, 'cart'), { recursive: true })
    writeFileSync(join(prototypeDir, 'cart.html'), DOCUMENT, 'utf-8')
    writeFileSync(join(patchesDir, 'A-001-btn.css'), '.btn{}', 'utf-8')
    writeFileSync(join(patchesDir, 'oops.css'), '.x{}', 'utf-8')
    writeFileSync(join(patchesDir, '.DS_Store'), '', 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('walks the prototype, skipping hidden files, and reports violations', () => {
    const report = resolvePrototypeOwnership(workspaceRoot, slug)

    expect(report.inspected).toBe(3)
    expect(report.violations).toEqual([
      { path: 'patches/oops.css', reason: 'misnamed patch — expected {lane}-{nnn}-{name}.{css|js}, optionally under patches/<page>/' },
    ])
    expect(report.entries.some((entry) => entry.path === '.DS_Store')).toBe(false)
  })

  it('reports nothing for a prototype that does not exist', () => {
    expect(resolvePrototypeOwnership(workspaceRoot, 'nope')).toEqual({
      entries: [],
      violations: [],
      inspected: 0,
    })
  })
})

describe('listPrototypeStatuses', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-list-prototypes-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('returns an empty list when nothing has been created yet', () => {
    expect(listPrototypeStatuses(workspaceRoot)).toEqual([])
  })

  it('lists only prototype directories, sorted, skipping hidden entries and loose files', () => {
    const prototypesRoot = getWorkspacePrototypesPath(workspaceRoot)
    mkdirSync(join(prototypesRoot, 'checkout-flow'), { recursive: true })
    mkdirSync(join(prototypesRoot, 'alpha'), { recursive: true })
    mkdirSync(join(prototypesRoot, '.DS_Store-dir'), { recursive: true })
    writeFileSync(join(prototypesRoot, 'notes.md'), 'not a prototype', 'utf-8')

    const slugs = listPrototypeStatuses(workspaceRoot).map((status) => status.slug)

    expect(slugs).toEqual(['alpha', 'checkout-flow'])
  })

  // Patches can legitimately be collected before a page is written, so a prototype
  // with patches and no pages is a state worth reporting rather than hiding.
  it('includes a prototype that has patches but no page, and says it has nothing to open', () => {
    const patchesDir = getPrototypePatchesPath(workspaceRoot, 'draft')
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(patchesDir, 'A-001-btn.css'), '.btn{}', 'utf-8')

    const [status] = listPrototypeStatuses(workspaceRoot)

    expect(status?.slug).toBe('draft')
    expect(status?.pages).toEqual([])
    expect(status?.pageAvailable).toBe(false)
    expect(status?.patches.total).toBe(1)
  })
})

describe('buildPrototypeStatus', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-status-'))
    createPrototype(workspaceRoot, { name: slug })
    const patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    writePrototypePage(workspaceRoot, slug, 'base', DOCUMENT)
    writeFileSync(join(patchesDir, 'A-001-btn.css'), '.btn{}', 'utf-8')
    writeFileSync(join(patchesDir, 'oops.css'), '.x{}', 'utf-8')

    const pathsDir = getContractPathsPath(workspaceRoot, slug, 'checkout-api')
    mkdirSync(pathsDir, { recursive: true })
    writeFileSync(
      join(pathsDir, 'list-orders.yaml'),
      "/orders:\n  get:\n    x-mock:\n      fixture: list-orders-200\n    responses:\n      '200':\n        description: OK\n/health:\n  get:\n    responses:\n      '200':\n        description: OK\n",
      'utf-8',
    )

    const fixturesDir = getContractFixturesPath(workspaceRoot, slug, 'checkout-api')
    mkdirSync(fixturesDir, { recursive: true })
    writeFileSync(join(fixturesDir, 'list-orders-200.json'), '[]', 'utf-8')

    mkdirSync(getPrototypeDistPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeDistPath(workspaceRoot, slug), 'dev-spec.md'), 'spec', 'utf-8')
  })

  afterEach(() => {
    // The resolver is process-global; one of the tests below installs it.
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('summarises the pages, the patches by lane, service coverage, exports and violations', () => {
    // A page of ours is rendered by the host, so "is there something to open"
    // depends on one being there — which it always is where the panel runs.
    setPrototypeBaseUrlResolver((_workspaceRootPath, prototypeSlug) => `http://${prototypeSlug}-hash.localhost`)
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.slug).toBe(slug)

    // The filesystem says what exists: base.html is a page with nothing declared.
    expect(status.pages.map((page) => `${page.name}:${page.kind}`)).toEqual(['base:scratch'])
    // No row carries the entry flag, so the address root shows the page index.
    expect(status.entryPage).toBeNull()
    expect(status.pageAvailable).toBe(true)
    expect(status.pageIssues).toEqual([])

    // Only the well-named patch counts; the misnamed one surfaces as a violation.
    expect(status.patches.total).toBe(1)
    expect(status.patches.byLane).toEqual({ A: 1 })
    // Nothing sits under `patches/<page>/`, so no patch is page-scoped.
    expect(status.patches.scoped).toBe(0)
    // The file list is the replayable set, so the panel can never open a file
    // that the injector would ignore.
    expect(status.patches.files).toEqual([join(getPrototypePatchesPath(workspaceRoot, slug), 'A-001-btn.css')])

    expect(status.services).toHaveLength(1)
    expect(status.services[0]?.slug).toBe('checkout-api')
    expect(status.services[0]?.endpoints).toBe(2)
    expect(status.services[0]?.mockedEndpoints).toBe(1)
    expect(status.services[0]?.fixtures).toBe(1)

    expect(status.distFiles).toEqual(['dev-spec.md'])
    expect(status.ownership.violations).toHaveLength(1)
    expect(status.lanes.A).toContain('UI')
  })

  it('reports an empty prototype without throwing', () => {
    const status = buildPrototypeStatus(workspaceRoot, 'does-not-exist')

    expect(status.pages).toEqual([])
    expect(status.entryPage).toBeNull()
    expect(status.pageAvailable).toBe(false)
    expect(status.pageIssues).toEqual([])
    expect(status.patches.total).toBe(0)
    expect(status.patches.files).toEqual([])
    expect(status.services).toEqual([])
    expect(status.distFiles).toEqual([])
    expect(status.ownership.violations).toEqual([])
  })

  /**
   * `pageAvailable` is what lets the UI offer Open only when it can work, and it
   * is not "a document exists": a page of ours opens the document, while a live
   * page opens the address it records and needs no file at all.
   */
  it('counts a live page as openable, without any document', () => {
    const slug = 'overlay-no-file'
    createPrototype(workspaceRoot, { name: slug })
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true }],
    })

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.pageAvailable).toBe(true)
    expect(status.entryPage).toBe('pay')
    expect(status.pages.map((page) => page.file)).toEqual([null])

    // A row with no address is not a page — and that is a state worth naming,
    // since the address cannot be guessed.
    writeFileSync(
      getPrototypeConfigPath(workspaceRoot, slug),
      JSON.stringify({ pages: [{ name: 'pay', kind: 'overlay' }] }),
      'utf-8',
    )

    const empty = buildPrototypeStatus(workspaceRoot, slug)
    expect(empty.pages).toEqual([])
    expect(empty.pageAvailable).toBe(false)
    expect(empty.pageIssues.join('\n')).toContain('an overlay page needs a url')
  })

  /**
   * The patch directories are the page scopes (plan §19.4), so a directory that
   * matches no page is a change nothing will ever replay — the most expensive kind
   * of silent failure this model has.
   */
  it('counts the page-scoped patches, and names a patch directory that matches no page', () => {
    const slug = 'scoped'
    createPrototype(workspaceRoot, { name: slug })
    writePrototypePage(workspaceRoot, slug, 'cart', DOCUMENT)
    mkdirSync(getPrototypePagePatchesPath(workspaceRoot, slug, 'cart'), { recursive: true })
    mkdirSync(getPrototypePagePatchesPath(workspaceRoot, slug, 'nope'), { recursive: true })

    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), 'A-001-shared.css'), '.shared{}', 'utf-8')
    writeFileSync(join(getPrototypePagePatchesPath(workspaceRoot, slug, 'cart'), 'B-001-cart.css'), '.cart{}', 'utf-8')
    writeFileSync(join(getPrototypePagePatchesPath(workspaceRoot, slug, 'nope'), 'C-001-x.css'), '.x{}', 'utf-8')

    const status = buildPrototypeStatus(workspaceRoot, slug)
    const issues = status.pageIssues.join('\n')

    expect(status.patches.total).toBe(3)
    expect(status.patches.scoped).toBe(2)
    expect(issues).toContain('patches/nope/ belongs to no page of this prototype')
    expect(issues).not.toContain('patches/cart/')
  })

  /**
   * `pageAvailable` and `resolvePrototypeEntry` state one rule in two places: what
   * the UI offers to open has to be exactly what the open path can produce. This
   * walks every combination so they cannot drift apart silently.
   */
  it('agrees with resolvePrototypeEntry about what can be opened', () => {
    setPrototypeBaseUrlResolver(() => 'http://case-abc123ab.localhost:41234')

    const cases: Array<{ label: string; pages: PrototypePageEntry[]; documents: string[] }> = [
      {
        label: 'live-entry',
        pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true }],
        documents: [],
      },
      { label: 'live-entry-with-no-address', pages: [{ name: 'pay', kind: 'overlay' }], documents: [] },
      { label: 'our-entry', pages: [{ name: 'cart', kind: 'scratch', entry: true }], documents: ['cart'] },
      { label: 'our-entry-with-no-document', pages: [{ name: 'cart', kind: 'scratch', entry: true }], documents: [] },
      { label: 'no-entry-with-a-page', pages: [], documents: ['cart'] },
      { label: 'no-entry-and-no-pages', pages: [], documents: [] },
      {
        label: 'live-page-beside-our-entry',
        pages: [
          { name: 'cart', kind: 'scratch', entry: true },
          { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
        ],
        documents: ['cart'],
      },
    ]

    for (const scenario of cases) {
      createPrototype(workspaceRoot, { name: scenario.label })
      for (const page of scenario.documents) {
        writePrototypePage(workspaceRoot, scenario.label, page, DOCUMENT)
      }
      writePrototypeConfig(workspaceRoot, scenario.label, { pages: scenario.pages })

      let openable = true
      try {
        resolvePrototypeEntry(workspaceRoot, scenario.label)
      } catch {
        openable = false
      }

      expect(`${scenario.label}: ${buildPrototypeStatus(workspaceRoot, scenario.label).pageAvailable}`)
        .toBe(`${scenario.label}: ${openable}`)
    }
  })
})
