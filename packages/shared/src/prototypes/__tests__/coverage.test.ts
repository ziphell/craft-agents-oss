import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildPrototypeStatus,
  exportPrototype,
  extractRequirementIds,
  getPrototypeDirPath,
  getPrototypeDistPath,
  getPrototypePatchesPath,
  getPrototypeResearchPath,
  normalizeRequirementId,
  parsePrototypeFinding,
  parsePrototypePrd,
  readPrototypeFindings,
  writePrototypeConfig,
} from '..'

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A prototype with a page table and a document, ready for markers to be added. */
function makePrototype(slug = 'checkout-flow'): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-coverage-'))
  const dir = getPrototypeDirPath(workspaceRoot, slug)
  mkdirSync(join(dir, 'patches'), { recursive: true })
  writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
  writeFileSync(join(dir, 'cart.html'), '<!doctype html><html><body>cart</body></html>', 'utf-8')
  return slug
}

function writePrd(slug: string, source: string): void {
  writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'prd.md'), source, 'utf-8')
}

function writePatch(slug: string, name: string, source: string): void {
  writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), name), source, 'utf-8')
}

function writeFinding(slug: string, name: string, source: string): void {
  const dir = getPrototypeResearchPath(workspaceRoot, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), source, 'utf-8')
}

describe('requirement ids', () => {
  // Ids are written by hand in three kinds of file, so the spellings have to
  // converge — otherwise a typo reads as "no such requirement" rather than as a
  // typo, and the thread breaks without saying anything.
  it('accepts the spellings a person actually writes', () => {
    expect(normalizeRequirementId('R-1')).toBe('R-001')
    expect(normalizeRequirementId('r-007')).toBe('R-007')
    expect(normalizeRequirementId('R-0042')).toBe('R-042')
    expect(normalizeRequirementId('TBD')).toBeNull()
  })

  it('reads a marker with several ids, and stops inventing them where it cannot', () => {
    const source = [
      '/* A-001-sticky-total.css',
      ' * @requirement R-3 — the total stays visible',
      ' * @requirement R-003, R-4',
      ' * @requirement TBD: ask the user',
      ' */',
    ].join('\n')

    expect(extractRequirementIds(source)).toEqual(['R-003', 'R-004'])
  })
})

describe('parsePrototypePrd', () => {
  it('reads one requirement per heading, with the prose under it', () => {
    const { requirements, issues } = parsePrototypePrd(
      [
        '# Requirements — checkout',
        '',
        '## R-001 A cart holds its line until stock runs out',
        '',
        'Given a line is in the cart…',
        '',
        '## R-002 Checking out takes one step',
        '',
        'No account is required.',
      ].join('\n'),
    )

    expect(issues).toEqual([])
    expect(requirements.map((requirement) => requirement.id)).toEqual(['R-001', 'R-002'])
    expect(requirements[0]?.title).toBe('A cart holds its line until stock runs out')
    expect(requirements[0]?.body).toContain('Given a line is in the cart')
    // The body ends at the next heading: it is what is *under* the requirement.
    expect(requirements[0]?.body).not.toContain('No account is required')
  })

  it('reports a duplicate id rather than letting a reference be ambiguous', () => {
    const { issues } = parsePrototypePrd(['## R-001 One', '## R-1 Two'].join('\n'))
    expect(issues.join('\n')).toContain('two entries share the id R-001')
  })

  it('says so when a PRD has no entries at all', () => {
    const { requirements, issues } = parsePrototypePrd('# Requirements\n\nNothing yet.\n')
    expect(requirements).toEqual([])
    expect(issues.join('\n')).toContain('no "## R-001 <title>" entries')
  })

  // A criterion only a person can judge is a criterion nobody runs, which is why
  // the supported kinds are exactly the mechanical ones — and why an unsupported
  // one has to be reported rather than left looking like a check that passed.
  it('reads acceptance checks, and refuses the kinds it cannot run', () => {
    const { requirements, issues } = parsePrototypePrd(
      [
        '## R-001 A cart holds its line',
        'check: selector [data-cart-total]',
        'check: endpoint GET /api/cart',
        'check: expression alert(1)',
        '',
        'The prose.',
      ].join('\n'),
    )

    expect(requirements[0]?.checks).toEqual([
      { kind: 'selector', target: '[data-cart-total]' },
      { kind: 'endpoint', target: 'GET /api/cart' },
    ])
    expect(issues.join('\n')).toContain('"expression" is not a check this can run')
    // The check lines are not prose: they are instructions, and leaving them in
    // the body would print them twice.
    expect(requirements[0]?.body).toBe('The prose.')
  })
})

describe('findings', () => {
  it('reads the labelled lines, and keeps the prose that follows', () => {
    const finding = parsePrototypeFinding(
      [
        '# F-001 The total stays pinned while the list scrolls',
        '',
        'claim: The cart keeps the total on screen at all times.',
        'source: https://shop.example.com/cart',
        'captured: 2026-09-15',
        'evidence: shots/cart-top.png, shots/cart-scrolled.png',
        'requirements: R-1, R-002',
        '',
        'The pinned bar is `position: sticky` on the summary row.',
      ].join('\n'),
      'research/F-001-sticky-total.md',
    )

    expect(finding?.id).toBe('F-001')
    expect(finding?.claim).toBe('The cart keeps the total on screen at all times.')
    expect(finding?.source).toBe('https://shop.example.com/cart')
    expect(finding?.evidence).toEqual(['shots/cart-top.png', 'shots/cart-scrolled.png'])
    expect(finding?.requirements).toEqual(['R-001', 'R-002'])
    expect(finding?.body).toContain('position: sticky')
  })

  it('ignores a plain note — research/ is allowed to hold one', () => {
    expect(parsePrototypeFinding('# Ideas\n\nMaybe look at the toast pattern.\n', 'research/notes.md')).toBeNull()
  })

  // A finding argues from something checkable. Both failures below make it
  // unfalsifiable, which is worse than not recording it at all.
  it('reports a finding with no claim, and evidence that is not on disk', () => {
    const slug = makePrototype()
    writeFinding(slug, 'F-001-sticky.md', '# F-001 Sticky total\n\nsource: https://shop.example.com/cart\n')
    writeFinding(
      slug,
      'F-002-invented.md',
      '# F-002 Something\n\nclaim: It animates.\nevidence: shots/never-taken.png\n',
    )

    const { findings, issues } = readPrototypeFindings(workspaceRoot, slug)

    expect(findings.map((finding) => finding.id)).toEqual(['F-001', 'F-002'])
    expect(issues.join('\n')).toContain('F-001-sticky.md: no "claim:" line')
    expect(issues.join('\n')).toContain('shots/never-taken.png')
  })
})

describe('the thread from a requirement to what implements it', () => {
  /**
   * The two answers nobody can get by reading files one at a time: a requirement
   * nothing implements, and a change whose reason was never written down.
   */
  it('collects the pages, patches and findings behind each requirement', () => {
    const slug = makePrototype()
    writePrd(
      slug,
      [
        '## R-001 A cart holds its line until stock runs out',
        '',
        '## R-002 Checking out takes one step',
        '',
        '## R-003 Nobody built this one',
      ].join('\n'),
    )
    writePatch(slug, 'A-001-sticky.css', '/* @requirement R-001 */\n.total { position: sticky }')
    writePatch(slug, 'A-002-unknown.css', '/* @requirement R-009 */\n.btn { color: red }')
    writePatch(slug, 'B-001-note.css', '.muted { color: gray }')
    writeFinding(
      slug,
      'F-001-sticky.md',
      '# F-001 Sticky total\n\nclaim: The total stays on screen.\nrequirements: R-001\n',
    )

    const status = buildPrototypeStatus(workspaceRoot, slug)
    const cartDocument = join(getPrototypeDirPath(workspaceRoot, slug), 'cart.html')
    writeFileSync(cartDocument, '<!doctype html><!-- @requirement R-002 --><html><body>cart</body></html>', 'utf-8')

    const repaired = buildPrototypeStatus(workspaceRoot, slug)
    const first = repaired.requirements.find((requirement) => requirement.id === 'R-001')
    const second = repaired.requirements.find((requirement) => requirement.id === 'R-002')

    expect(first?.patches).toEqual(['patches/A-001-sticky.css'])
    expect(first?.findings).toEqual(['F-001'])
    expect(second?.pages).toEqual(['cart'])
    // PRD order, not discovery order: the document's order is part of its argument.
    expect(repaired.requirements.map((requirement) => requirement.id)).toEqual(['R-001', 'R-002', 'R-003'])

    expect(repaired.briefIssues.join('\n')).toContain('R-003 is in prd.md but no page or patch refers to it')
    expect(repaired.briefIssues.join('\n')).toContain('patches/A-002-unknown.css refers to R-009')
    // The requirement has a patch before the page marker is added — the first
    // report is what a prototype looks like while it is being built.
    expect(status.briefIssues.join('\n')).not.toContain('R-001 is in prd.md')
  })

  it('ships the thread inside the dev spec, and keeps research out of the package', () => {
    const slug = makePrototype()
    writePrd(slug, '## R-001 A cart holds its line\n')
    writePatch(slug, 'A-001-sticky.css', '/* @requirement R-001 */\n.total { position: sticky }')
    writeFinding(slug, 'F-001-sticky.md', '# F-001 Sticky total\n\nclaim: It stays on screen.\nrequirements: R-001\n')

    const result = exportPrototype(workspaceRoot, slug)
    const spec = readFileSync(join(getPrototypeDistPath(workspaceRoot, slug), 'dev-spec.md'), 'utf-8')

    expect(spec).toContain('## Requirements')
    expect(spec).toContain('| 1 | `R-001` | A cart holds its line | `patches/A-001-sticky.css`, `F-001 (finding)` |')

    // The reader gets the requirements, not the author's notes (plan §20.2).
    expect(existsSync(join(result.extensionDir, 'research'))).toBe(false)
  })
})
