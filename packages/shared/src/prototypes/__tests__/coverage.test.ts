import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  extractRequirementIds,
  getPrototypeDirPath,
  getPrototypeResearchPath,
  normalizeRequirementId,
  parsePrototypeFinding,
  parseRequirementDocument,
  readPrototypeFindings,
  readPrototypeRequirements,
  resolveRequirementCoverage,
  type RequirementCoverage,
} from '..'

/** The requirements nothing implements, as `status.unresolved.unmet` derives them. */
function unmet(requirements: RequirementCoverage[]): string[] {
  return requirements
    .filter((requirement) => requirement.files.length === 0)
    .map((requirement) => requirement.id)
}

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A prototype with nothing but its folder, ready for files to be written into it. */
function makePrototype(slug = 'checkout-flow'): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-coverage-'))
  mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
  return slug
}

function writeFile(slug: string, name: string, source: string): void {
  writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), name), source, 'utf-8')
}

function writeFinding(slug: string, name: string, source: string): void {
  const dir = getPrototypeResearchPath(workspaceRoot, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), source, 'utf-8')
}

describe('requirement ids', () => {
  // Ids are written by hand in more than one kind of file, so the spellings have to
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
      '<!-- cart.html',
      '  @requirement R-3 — the total stays visible',
      '  @requirement R-003, R-4',
      '  @requirement TBD: ask the user',
      '-->',
    ].join('\n')

    expect(extractRequirementIds(source)).toEqual(['R-003', 'R-004'])
  })
})

describe('parseRequirementDocument', () => {
  it('reads one requirement per heading, with the prose under it', () => {
    const { requirements, issues } = parseRequirementDocument(
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
      'PRD.md',
    )

    expect(issues).toEqual([])
    expect(requirements.map((requirement) => requirement.id)).toEqual(['R-001', 'R-002'])
    expect(requirements[0]?.title).toBe('A cart holds its line until stock runs out')
    expect(requirements[0]?.body).toContain('Given a line is in the cart')
    // The carrier document travels with the entry.
    expect(requirements[0]?.file).toBe('PRD.md')
    // The body ends at the next heading: it is what is *under* the requirement.
    expect(requirements[0]?.body).not.toContain('No account is required')
  })

  it('reports a duplicate id rather than letting a reference be ambiguous', () => {
    const { issues } = parseRequirementDocument(['## R-001 One', '## R-1 Two'].join('\n'), 'PRD.md')
    expect(issues.join('\n')).toContain('two entries share the id R-001')
  })

  it('reads no requirements out of a document that states none', () => {
    const { requirements, issues } = parseRequirementDocument('# Requirements\n\nNothing yet.\n', 'PRD.md')
    expect(requirements).toEqual([])
    expect(issues).toEqual([])
  })

  // `check:` is not a concept any more: a line that says it is prose under the requirement, read
  // like the rest of the body, and nothing parses or reports it.
  it('treats a check: line as ordinary prose', () => {
    const { requirements, issues } = parseRequirementDocument(
      [
        '## R-001 A cart holds its line',
        'check: endpoint GET /api/cart',
        '',
        'The prose.',
      ].join('\n'),
      'PRD.md',
    )

    expect(issues).toEqual([])
    expect(requirements[0]?.body).toContain('check: endpoint GET /api/cart')
    expect(requirements[0]?.body).toContain('The prose.')
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
    writeFile(slug, 'PRD.md', '## R-001 A cart holds its line\n')
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
   * nothing implements, and a marker whose reason was never written down.
   */
  it('collects the files and findings behind each requirement', () => {
    const slug = makePrototype()
    writeFile(
      slug,
      'PRD.md',
      ['## R-001 A cart holds its line until stock runs out', '', '## R-002 Checking out takes one step', '', '## R-003 Nobody built this one'].join('\n'),
    )
    // Any file of the folder may say what it serves — a document, a stylesheet, a script.
    writeFile(slug, 'cart.html', '<!doctype html><!-- @requirement R-002 --><html><body>cart</body></html>')
    writeFile(slug, 'notes.md', 'Some notes.\n\n@requirement R-003 and R-009, which the PRD does not define.\n')
    writeFinding(slug, 'F-001-sticky.md', '# F-001 Sticky total\n\nclaim: The total stays on screen.\nrequirements: R-001\n')

    const report = resolveRequirementCoverage(workspaceRoot, slug)
    const byId = new Map(report.requirements.map((requirement) => [requirement.id, requirement]))

    expect(byId.get('R-001')?.files).toEqual([])
    expect(byId.get('R-001')?.findings).toEqual(['F-001'])
    expect(byId.get('R-002')?.files).toEqual(['cart.html'])
    expect(byId.get('R-003')?.files).toEqual(['notes.md'])
    // PRD order, not discovery order: the document's order is part of its argument.
    expect(report.requirements.map((requirement) => requirement.id)).toEqual(['R-001', 'R-002', 'R-003'])

    const issues = report.issues.map((issue) => issue.text).join('\n')
    expect(issues).toContain('R-001 is in PRD.md but no file refers to it')
    // A finding is evidence, not implementation: R-001 has one and is still unmet.
    expect(unmet(report.requirements)).toEqual(['R-001'])
    expect(issues).toContain('notes.md refers to R-009')
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'requirement.unimplemented',
      'requirement.undefined',
    ])
  })

  /**
   * The brief defines requirements; it does not implement them. Counting a marker
   * written in `PRD.md` would make every requirement look built.
   */
  it('does not read the brief as an implementation of what it defines', () => {
    const slug = makePrototype()
    writeFile(slug, 'PRD.md', '## R-001 A cart holds its line\n\n@requirement R-001 — see the section above.\n')

    const report = resolveRequirementCoverage(workspaceRoot, slug)

    expect(report.requirements[0]?.files).toEqual([])
    expect(report.issues.map((issue) => issue.code)).toEqual(['requirement.unimplemented'])
  })

  /**
   * A finding argues for a requirement; it does not implement it. The line that says so
   * (`requirements:`) is not the marker that claims implementation (`@requirement`), so the
   * requirement is still one the gate names.
   */
  it('does not count a finding as an implementation', () => {
    const slug = makePrototype()
    writeFile(slug, 'PRD.md', '## R-001 A cart holds its line\n')
    writeFinding(slug, 'F-001-sticky.md', '# F-001 Sticky\n\nclaim: x\nrequirements: R-001\n')

    const report = resolveRequirementCoverage(workspaceRoot, slug)

    expect(report.requirements[0]?.files).toEqual([])
    // A finding is evidence, not an implementation — so the requirement stays one the gate names.
    expect(report.issues.map((issue) => issue.code)).toEqual(['requirement.unimplemented'])
  })

  it('reads the requirements it was given', () => {
    const slug = makePrototype()
    writeFile(slug, 'PRD.md', '## R-001 x\n\n## R-002 y\n')

    expect(readPrototypeRequirements(workspaceRoot, slug).requirements.map((r) => r.id)).toEqual(['R-001', 'R-002'])
  })

  // The specification is one file or several: a requirement is found wherever an author wrote it —
  // a subfolder included — and the file it was written in travels with it.
  it('reads requirements from every markdown file, wherever the author put them', () => {
    const slug = makePrototype()
    writeFile(slug, 'PRD.md', '## R-001 A cart holds its line\n')
    mkdirSync(join(getPrototypeDirPath(workspaceRoot, slug), 'docs'), { recursive: true })
    writeFile(slug, 'docs/features.md', '## R-002 Checking out takes one step\n')
    writeFile(slug, 'cart.html', '<!doctype html><!-- @requirement R-002 --><html></html>')

    const read = readPrototypeRequirements(workspaceRoot, slug)
    expect(read.issues).toEqual([])
    expect(read.requirements.map((r) => `${r.id}:${r.file}`)).toEqual([
      'R-001:PRD.md',
      'R-002:docs/features.md',
    ])

    const report = resolveRequirementCoverage(workspaceRoot, slug)
    const byId = new Map(report.requirements.map((requirement) => [requirement.id, requirement]))
    expect(byId.get('R-001')?.file).toBe('PRD.md')
    expect(byId.get('R-002')?.file).toBe('docs/features.md')
    expect(byId.get('R-002')?.files).toEqual(['cart.html'])
    // The unimplemented notice names the document the requirement is written in, not a fixed one.
    expect(report.issues.map((issue) => issue.text).join('\n')).toContain(
      'R-001 is in PRD.md but no file refers to it',
    )
  })

  /**
   * The old rule ("the brief defines requirements; it does not implement them") generalizes to any
   * document that defines one — so a `@requirement` line written inside a spec document still does
   * not count as building what it specifies.
   */
  it('treats any document that defines a requirement as specification, not implementation', () => {
    const slug = makePrototype()
    mkdirSync(join(getPrototypeDirPath(workspaceRoot, slug), 'docs'), { recursive: true })
    writeFile(slug, 'docs/features.md', '## R-001 A cart holds its line\n\n@requirement R-001 — see above.\n')

    const report = resolveRequirementCoverage(workspaceRoot, slug)

    expect(report.requirements[0]?.files).toEqual([])
    expect(report.issues.map((issue) => issue.code)).toEqual(['requirement.unimplemented'])
  })

  it('reports one id defined in two documents rather than guessing which a reference meant', () => {
    const slug = makePrototype()
    writeFile(slug, 'PRD.md', '## R-001 A cart holds its line\n')
    mkdirSync(join(getPrototypeDirPath(workspaceRoot, slug), 'docs'), { recursive: true })
    writeFile(slug, 'docs/features.md', '## R-001 A second claim on the same id\n')

    const read = readPrototypeRequirements(workspaceRoot, slug)

    expect(read.requirements.map((r) => r.id)).toEqual(['R-001'])
    expect(read.issues.join('\n')).toContain('R-001 is defined in both PRD.md and docs/features.md')
  })
})
