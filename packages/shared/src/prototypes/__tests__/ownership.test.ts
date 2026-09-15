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
  getPrototypeProjectPath,
  isPrototypeLane,
  listPrototypeStatuses,
  resolvePrototypeOwnership,
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
    const projectDir = getPrototypeProjectPath(workspaceRoot, slug)
    const patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(projectDir, 'base.html'), '<html></html>', 'utf-8')
    writeFileSync(join(patchesDir, 'A-001-btn.css'), '.btn{}', 'utf-8')
    writeFileSync(join(patchesDir, 'oops.css'), '.x{}', 'utf-8')
    writeFileSync(join(patchesDir, '.DS_Store'), '', 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('walks the project, skipping hidden files, and reports violations', () => {
    const report = resolvePrototypeOwnership(workspaceRoot, slug)

    expect(report.inspected).toBe(3)
    expect(report.violations).toEqual([
      { path: 'patches/oops.css', reason: 'misnamed patch — expected {lane}-{nnn}-{name}.{css|js}' },
    ])
    expect(report.entries.some((entry) => entry.path === '.DS_Store')).toBe(false)
  })

  it('reports nothing for a project that does not exist', () => {
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

  it('includes a project that has patches but no base.html, and says so', () => {
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
    const projectDir = getPrototypeProjectPath(workspaceRoot, slug)
    const patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(projectDir, 'base.html'), '<html></html>', 'utf-8')
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
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('summarises patches by lane, service coverage, exports and violations', () => {
    const status = buildPrototypeStatus(workspaceRoot, slug)

    expect(status.slug).toBe(slug)
    expect(status.baseHtmlPresent).toBe(true)
    expect(status.baseHtmlPath).toBe(join(getPrototypeProjectPath(workspaceRoot, slug), 'base.html'))
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

  it('reports an empty project without throwing', () => {
    const status = buildPrototypeStatus(workspaceRoot, 'does-not-exist')

    expect(status.baseHtmlPresent).toBe(false)
    expect(status.baseHtmlPath).toBeNull()
    expect(status.patches.total).toBe(0)
    expect(status.patches.files).toEqual([])
    expect(status.services).toEqual([])
    expect(status.distFiles).toEqual([])
    expect(status.ownership.violations).toEqual([])
  })
})
