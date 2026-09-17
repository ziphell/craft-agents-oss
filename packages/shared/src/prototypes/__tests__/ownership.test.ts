import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  canWriterWrite,
  classifyPrototypePath,
  createPrototype,
  getContractFixturesPath,
  getContractPathsPath,
  getPrototypeAnchorsPath,
  getPrototypeConfigPath,
  getPrototypeDistPath,
  getPrototypePagePatchesPath,
  getPrototypePatchesPath,
  getPrototypeDirPath,
  getPrototypeResearchPath,
  isValidWriterId,
  listPrototypeStatuses,
  resolvePrototypeArtifactPath,
  resolvePrototypeOwnership,
  resolvePrototypeEntry,
  setPrototypeBaseUrlResolver,
  whyWriterMayNotWrite,
  writePrototypeConfig,
  writePrototypePage,
  type PrototypePageEntry,
} from '..'
import { getWorkspacePrototypesPath } from '../../workspaces/storage'

const DOCUMENT = '<!doctype html><html><body><h1>Cart</h1></body></html>'

describe('prototype path ownership', () => {
  it('assigns control-plane paths', () => {
    // Top-level documents and the page table are written by the control plane (the
    // agent, on the human's behalf) and read by the writers.
    expect(classifyPrototypePath('cart.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('_layout.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('config.json')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('dist/extension/cart.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('services/checkout-api/openapi.yaml')).toEqual({
      owner: { kind: 'control-plane' },
    })
  })

  it('derives patch ownership from the writer id in the file name', () => {
    expect(classifyPrototypePath('patches/A-001-btn.css')).toEqual({ owner: { kind: 'writer', writer: 'A' } })
    // A writer id is whatever the graph declares, so it may be a multi-hyphen slug: the name
    // splits at the first `-<digits>-`, which is what makes that parse unambiguous.
    expect(classifyPrototypePath('patches/research-competitors-001-report.css')).toEqual({
      owner: { kind: 'writer', writer: 'research-competitors' },
    })
    // One level deeper is a page's own patch: the writer still owns it, and the
    // directory decides which page it changes (plan §19.4).
    expect(classifyPrototypePath('patches/cart/A-002-total.css')).toEqual({
      owner: { kind: 'writer', writer: 'A' },
    })
  })

  it('flags a patch whose name does not parse', () => {
    expect(classifyPrototypePath('patches/notes.txt')).toEqual({
      violation:
        'misnamed patch — expected {writer}-{nnn}-{name}.{css|js}, optionally under patches/<page>/',
    })
    // The name splits at the *first* `-<digits>-`, so a prefix that looks like a number belongs
    // to the shortest writer. That is why such an id is refused up front (`isValidWriterId`)
    // rather than left to disagree with the very files it would write.
    expect(classifyPrototypePath('patches/ui-2-001-btn.css')).toEqual({
      owner: { kind: 'writer', writer: 'ui' },
    })
  })

  /**
   * The consolidated writer is reserved (plan §21.3, §3.4) — a folded patch is an ordinary
   * patch written by the control plane, so it is classified like one; what makes it special is
   * that it must replay last, and that no agent writer may claim the prefix.
   */
  it('accepts the consolidated writer that a commit writes', () => {
    expect(classifyPrototypePath('patches/Z-001-upper.css')).toEqual({
      owner: { kind: 'writer', writer: 'Z' },
    })
    expect(classifyPrototypePath('patches/cart/Z-002-upper.js')).toEqual({
      owner: { kind: 'writer', writer: 'Z' },
    })
  })

  it('assigns contract and data paths to the writers their path rules declare', () => {
    expect(classifyPrototypePath('services/api/paths/list-orders.yaml')).toEqual({
      owner: { kind: 'writer', writer: 'contract' },
    })
    expect(classifyPrototypePath('services/api/config.json')).toEqual({
      owner: { kind: 'writer', writer: 'contract' },
    })
    expect(classifyPrototypePath('services/api/fixtures/list-orders-200.json')).toEqual({
      owner: { kind: 'writer', writer: 'data' },
    })
  })

  it('flags unowned paths', () => {
    expect(classifyPrototypePath('services/api/random.txt')).toEqual({
      violation: 'unowned file inside a service directory',
    })
    expect(classifyPrototypePath('README.md')).toEqual({ violation: 'unowned path' })
  })

  /**
   * The workbench's own evidence and input files. They are not "unowned" — a prototype that has a
   * PRD or findings used to report violations for them, which made the one report that says what is
   * wrong with a prototype say something untrue about every prototype that had been worked on.
   */
  it('assigns the input and evidence files the agent writes', () => {
    expect(classifyPrototypePath('prd.md')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('assets/pages/cart.js')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('assets/app.css')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('research/competitors.md')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('research/frames/session-1/001.jpg')).toEqual({
      owner: { kind: 'control-plane' },
    })
    expect(classifyPrototypePath('research/videos/demo.mp4')).toEqual({ owner: { kind: 'control-plane' } })
  })

  /**
   * `anchors/` is the one direction the agent may not write: a record of a match is only worth
   * something if the tool that made the match wrote it (§3.5).
   */
  it('assigns the anchor records to the tool that makes them', () => {
    expect(classifyPrototypePath('anchors/cart.json')).toEqual({
      owner: { kind: 'tooling', by: 'prototype-apply' },
    })
  })

  it('accepts writer ids that a name can carry, and no others', () => {
    expect(isValidWriterId('main')).toBe(true)
    expect(isValidWriterId('checkout-ui')).toBe(true)
    expect(isValidWriterId('A')).toBe(true)
    // `-<digits>-` inside the id would make `{writer}-{nnn}-{name}` ambiguous; the rest of the
    // failures are the slug grammar.
    expect(isValidWriterId('ui-2')).toBe(false)
    expect(isValidWriterId('-leading')).toBe(false)
    expect(isValidWriterId('has space')).toBe(false)
    expect(isValidWriterId('')).toBe(false)
  })
})

describe('writer write guard', () => {
  it('lets a writer write its own artifacts', () => {
    expect(canWriterWrite('patches/A-001-btn.css', 'A').ok).toBe(true)
    expect(canWriterWrite('patches/cart/checkout-ui-002-total.css', 'checkout-ui').ok).toBe(true)
    // The on-disk spelling is the author's; the comparison is case-insensitive.
    expect(canWriterWrite('patches/A-001-btn.css', 'a').ok).toBe(true)
    expect(canWriterWrite('services/api/paths/x.yaml', 'contract').ok).toBe(true)
    expect(canWriterWrite('services/api/fixtures/x.json', 'data').ok).toBe(true)
  })

  it('refuses writes to another writer, with the reason', () => {
    const result = canWriterWrite('patches/B-001-btn.css', 'A')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('owned by writer "B", and this session writes as "A"')
  })

  it('refuses the reserved consolidated prefix, even for a writer named Z', () => {
    const result = canWriterWrite('patches/Z-001-upper.css', 'Z')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('reserved for prototype-commit')
  })

  it('refuses writes to control-plane outputs', () => {
    expect(canWriterWrite('dist/extension/cart.html', 'main').reason).toBe('owned by the control plane')
    expect(canWriterWrite('cart.html', 'main').reason).toBe('owned by the control plane')
    expect(canWriterWrite('config.json', 'main').reason).toBe('owned by the control plane')
    expect(canWriterWrite('services/api/openapi.yaml', 'contract').reason).toBe('owned by the control plane')
  })

  it('refuses writes to paths nobody owns', () => {
    expect(canWriterWrite('README.md', 'main').ok).toBe(false)
    expect(canWriterWrite('patches/notes.txt', 'main').ok).toBe(false)
  })

  it('refuses to let a writer author a record a tool made', () => {
    expect(canWriterWrite('anchors/cart.json', 'main').reason).toBe(
      'written by prototype-apply, from what actually happened',
    )
  })
})

/**
 * The enforced rule is narrower than the primitive: the control plane *is* the agent, so its
 * files are the session's own work, while another writer's artifact and an artifact no rule owns
 * are both refusals the agent can act on (plan §3.6).
 */
describe('whyWriterMayNotWrite', () => {
  it('says nothing when the write is the session’s own', () => {
    expect(whyWriterMayNotWrite('patches/main-001-btn.css', 'main')).toBeNull()
    expect(whyWriterMayNotWrite('services/api/paths/x.yaml', 'contract')).toBeNull()
  })

  it('lets the session write the control plane’s own files', () => {
    expect(whyWriterMayNotWrite('cart.html', 'main')).toBeNull()
    expect(whyWriterMayNotWrite('config.json', 'main')).toBeNull()
    expect(whyWriterMayNotWrite('dist/dev-spec.md', 'main')).toBeNull()
    // The input and the evidence the agent authors are its own work too — only the *record* a tool
    // made is off limits.
    expect(whyWriterMayNotWrite('prd.md', 'main')).toBeNull()
    expect(whyWriterMayNotWrite('research/competitors.md', 'main')).toBeNull()
    expect(whyWriterMayNotWrite('assets/pages/cart.js', 'main')).toBeNull()
  })

  it('refuses a hand-written record, and says what to re-run instead', () => {
    const why = whyWriterMayNotWrite('anchors/cart.json', 'main')

    expect(why).toContain('written by prototype-apply, from what actually happened')
    expect(why).toContain('re-run prototype-apply')
  })

  it('refuses another writer’s artifact, naming whose it is and what to write instead', () => {
    const why = whyWriterMayNotWrite('patches/B-001-btn.css', 'A')

    expect(why).toContain('Writing patches/B-001-btn.css as "A" is refused')
    expect(why).toContain('owned by writer "B", and this session writes as "A"')
    expect(why).toContain('`A-<nnn>-<name>.{css,js}`')
  })

  it('refuses an artifact no rule owns, since nothing would ever replay it', () => {
    const why = whyWriterMayNotWrite('patches/notes.txt', 'main')

    expect(why).toContain('Writing patches/notes.txt as "main" is refused')
    expect(why).toContain('misnamed patch')
    expect(why).toContain('`main-<nnn>-<name>.{css,js}`')
  })
})

describe('resolvePrototypeArtifactPath', () => {
  const root = join('/workspace', 'prototypes')

  it('names the prototype and the path inside it', () => {
    expect(resolvePrototypeArtifactPath(root, join(root, 'checkout-flow', 'patches', 'A-001-btn.css'))).toEqual({
      slug: 'checkout-flow',
      relativePath: 'patches/A-001-btn.css',
    })
  })

  it('has no opinion about paths outside a prototype', () => {
    expect(resolvePrototypeArtifactPath(root, join('/workspace', 'src', 'index.ts'))).toBeNull()
    // A sibling directory whose name merely starts the same way is not the prototypes root.
    expect(resolvePrototypeArtifactPath(root, join('/workspace', 'prototypes-archive', 'x', 'y.css'))).toBeNull()
    // The root itself, and a loose file in it, are not inside any prototype.
    expect(resolvePrototypeArtifactPath(root, root)).toBeNull()
    expect(resolvePrototypeArtifactPath(root, join(root, 'notes.md'))).toBeNull()
  })

  it('resolves away a climb out of the prototype rather than trusting the path', () => {
    expect(resolvePrototypeArtifactPath(root, join(root, 'checkout-flow', '..', '..', 'secrets.md'))).toBeNull()
    expect(resolvePrototypeArtifactPath(root, join(root, 'checkout-flow', '..', 'rival', 'config.json'))).toEqual({
      slug: 'rival',
      relativePath: 'config.json',
    })
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
      {
        path: 'patches/oops.css',
        reason: 'misnamed patch — expected {writer}-{nnn}-{name}.{css|js}, optionally under patches/<page>/',
      },
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

  /**
   * The report is only worth reading if a prototype that is *fine* comes back clean. A prototype
   * that has been worked on has a PRD, findings with their frames, its own page assets and anchor
   * records — every one of those used to be listed as a violation, which is a report saying the
   * wrong thing about the normal case.
   */
  it('finds nothing wrong with a prototype that has been worked on', () => {
    const dir = getPrototypeDirPath(workspaceRoot, slug)
    writeFileSync(join(dir, 'prd.md'), '## R-001 A cart holds its line\n', 'utf-8')
    mkdirSync(getPrototypeResearchPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeResearchPath(workspaceRoot, slug), 'competitors.md'), '# F-001 x\n', 'utf-8')
    mkdirSync(join(dir, 'assets', 'pages'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'pages', 'cart.js'), 'export const x = 1\n', 'utf-8')
    mkdirSync(getPrototypeAnchorsPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeAnchorsPath(workspaceRoot, slug), 'cart.json'), '{}\n', 'utf-8')

    const report = resolvePrototypeOwnership(workspaceRoot, slug)

    // Everything but the misnamed patch it was set up with.
    expect(report.violations.map((violation) => violation.path)).toEqual(['patches/oops.css'])
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

  it('summarises the pages, the patches by writer, service coverage, exports and violations', () => {
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
    expect(status.patches.byWriter).toEqual({ A: 1 })
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
