import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  canLaneWrite,
  classifyPrototypePath,
  getContractFixturesPath,
  getContractPathsPath,
  getPrototypeDistPath,
  getPrototypePatchesPath,
  getPrototypeDirPath,
  isPrototypeLane,
  listPrototypeStatuses,
  resolvePrototypeOwnership,
  resolvePrototypeEntry,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
} from '..'
import { getWorkspacePrototypesPath } from '../../workspaces/storage'

describe('prototype path ownership', () => {
  it('assigns control-plane paths', () => {
    expect(classifyPrototypePath('base.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('dist/prototype.html')).toEqual({ owner: { kind: 'control-plane' } })
    expect(classifyPrototypePath('services/checkout-api/openapi.yaml')).toEqual({
      owner: { kind: 'control-plane' },
    })
  })

  it('derives patch ownership from the lane in the file name', () => {
    expect(classifyPrototypePath('patches/A-001-btn.css')).toEqual({ owner: { kind: 'lane', lane: 'A' } })
    expect(classifyPrototypePath('patches/b-012-guard.js')).toEqual({ owner: { kind: 'lane', lane: 'B' } })
  })

  it('flags a patch whose lane prefix is not a declared lane', () => {
    const result = classifyPrototypePath('patches/Z-001-btn.css')
    expect(result).toHaveProperty('violation')
    expect((result as { violation: string }).violation).toContain('unknown lane prefix "Z"')
  })

  it('flags a misnamed patch rather than silently ignoring it', () => {
    expect(classifyPrototypePath('patches/notes.txt')).toEqual({
      violation: 'misnamed patch — expected {lane}-{nnn}-{name}.{css|js}',
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
    expect(isPrototypeLane('Z')).toBe(false)
  })
})

describe('lane write guard', () => {
  it('lets a lane write its own artifacts', () => {
    expect(canLaneWrite('patches/A-001-btn.css', 'A').ok).toBe(true)
    expect(canLaneWrite('services/api/paths/x.yaml', 'B').ok).toBe(true)
    expect(canLaneWrite('services/api/fixtures/x.json', 'C').ok).toBe(true)
  })

  it('refuses writes to another lane, with the reason', () => {
    const result = canLaneWrite('patches/B-001-btn.css', 'A')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('owned by lane B')
  })

  it('refuses writes to control-plane outputs', () => {
    expect(canLaneWrite('dist/prototype.html', 'A').reason).toBe('owned by the control plane')
    expect(canLaneWrite('base.html', 'A').reason).toBe('owned by the control plane')
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
    writeFileSync(join(prototypeDir, 'base.html'), '<html></html>', 'utf-8')
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
      { path: 'patches/oops.css', reason: 'misnamed patch — expected {lane}-{nnn}-{name}.{css|js}' },
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

  it('includes a prototype that has patches but no base.html, and says so', () => {
    const patchesDir = getPrototypePatchesPath(workspaceRoot, 'draft')
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(patchesDir, 'A-001-btn.css'), '.btn{}', 'utf-8')

    const [status] = listPrototypeStatuses(workspaceRoot)

    expect(status?.slug).toBe('draft')
    expect(status?.baseHtmlPresent).toBe(false)
    expect(status?.patches.total).toBe(1)
  })
})

describe('buildPrototypeStatus', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-status-'))
    const prototypeDir = getPrototypeDirPath(workspaceRoot, slug)
    const patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(prototypeDir, 'base.html'), '<html></html>', 'utf-8')
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
    writeFileSync(join(getPrototypeDistPath(workspaceRoot, slug), 'prototype.html'), '<html></html>', 'utf-8')
  })

  afterEach(() => {
    // The resolver is process-global; one of the tests below installs it.
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('summarises patches by lane, service coverage, exports and violations', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.slug).toBe(slug)
    expect(status.baseHtmlPresent).toBe(true)
    expect(status.baseHtmlPath).toBe(join(getPrototypeDirPath(workspaceRoot, slug), 'base.html'))
    // Only the well-named patch counts; the misnamed one surfaces as a violation.
    expect(status.patches.total).toBe(1)
    expect(status.patches.byLane).toEqual({ A: 1 })
    // The file list is the replayable set, so the panel can never open a file
    // that the injector would ignore.
    expect(status.patches.files).toEqual([join(getPrototypePatchesPath(workspaceRoot, slug), 'A-001-btn.css')])

    expect(status.services).toHaveLength(1)
    expect(status.services[0]?.slug).toBe('checkout-api')
    expect(status.services[0]?.endpoints).toBe(2)
    expect(status.services[0]?.mockedEndpoints).toBe(1)
    expect(status.services[0]?.fixtures).toBe(1)

    expect(status.distFiles).toEqual(['prototype.html'])
    expect(status.ownership.violations).toHaveLength(1)
    expect(status.lanes.A).toContain('UI')
  })

  it('reports an empty prototype without throwing', () => {
    const status = buildPrototypeStatus(workspaceRoot, 'does-not-exist')

    expect(status.baseHtmlPresent).toBe(false)
    expect(status.baseHtmlPath).toBeNull()
    expect(status.patches.total).toBe(0)
    expect(status.patches.files).toEqual([])
    expect(status.services).toEqual([])
    expect(status.distFiles).toEqual([])
    expect(status.ownership.violations).toEqual([])
  })

  /**
   * `pageAvailable` is what lets the UI offer Open only when it can work, and it
   * is *not* `baseHtmlPresent`: the two kinds get their page from different places.
   * An overlay opens the live address it was made against and needs no file at
   * all — which is the whole reason a captured copy of that page was dropped;
   * a from-scratch prototype opens the host's rendering of its own document.
   */
  it('counts an overlay with a target page as openable, without any file', () => {
    const slug = 'overlay-no-file'
    mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
    writePrototypeConfig(workspaceRoot, slug, { kind: 'overlay', targetUrl: 'https://app.example.com/checkout' })

    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.pageAvailable).toBe(true)
    expect(status.baseHtmlPresent).toBe(false)

    // An overlay with nothing to point at has nothing to open — and that is a
    // state worth naming, since the address cannot be guessed.
    writePrototypeConfig(workspaceRoot, slug, { kind: 'overlay' })
    expect(buildPrototypeStatus(workspaceRoot, slug).pageAvailable).toBe(false)
  })

  /**
   * `pageAvailable` and `resolvePrototypeEntry` state one rule in two places: what
   * the UI offers to open has to be exactly what the open path can produce. This
   * walks every combination so they cannot drift apart silently.
   */
  it('agrees with resolvePrototypeEntry about what can be opened', () => {
    setPrototypeBaseUrlResolver(() => 'http://case-abc123ab.localhost:41234')

    const cases = [
      { kind: 'overlay' as const, targetUrl: 'https://app.example.com/checkout', base: false },
      { kind: 'overlay' as const, targetUrl: 'https://app.example.com/checkout', base: true },
      { kind: 'overlay' as const, targetUrl: undefined, base: true },
      { kind: 'overlay' as const, targetUrl: undefined, base: false },
      { kind: 'scratch' as const, targetUrl: undefined, base: true },
      { kind: 'scratch' as const, targetUrl: undefined, base: false },
    ]

    for (const scenario of cases) {
      const slug = `${scenario.kind}-${scenario.targetUrl ? 'url' : 'nourl'}-${scenario.base ? 'base' : 'nobase'}`
      mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
      writePrototypeConfig(workspaceRoot, slug, { kind: scenario.kind, targetUrl: scenario.targetUrl })
      if (scenario.base) {
        writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'base.html'), '<!doctype html><html></html>', 'utf-8')
      }

      let openable = true
      try {
        resolvePrototypeEntry(workspaceRoot, slug)
      } catch {
        openable = false
      }

      expect(`${slug}: ${buildPrototypeStatus(workspaceRoot, slug).pageAvailable}`).toBe(`${slug}: ${openable}`)
    }
  })
})
