import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  parseSpecDocument,
  readSpecDocuments,
} from '..'

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A project with nothing but its folder, ready for files to be written into it. */
function makeProject(slug = 'checkout-flow'): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-project-specs-'))
  const dir = join(workspaceRoot, 'projects', slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeFile(dir: string, name: string, source: string): void {
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, 'utf-8')
}

describe('parseSpecDocument', () => {
  // A spec is a file: its first heading is the title, and the rest of the file is the prose.
  it('takes the first heading as the title and the rest of the document as the body', () => {
    const spec = parseSpecDocument(
      ['# A cart holds its line until stock runs out', '', 'Given a line is in the cart…'].join('\n'),
      'cart-line.spec.md',
    )

    expect(spec.title).toBe('A cart holds its line until stock runs out')
    expect(spec.body).toContain('Given a line is in the cart')
    // The file it is written in travels with it: it is the spec's identity.
    expect(spec.file).toBe('cart-line.spec.md')
  })

  it('takes the first heading at any depth, and leaves later headings in the body', () => {
    const spec = parseSpecDocument(
      ['## A cart holds its line', '', 'The prose.', '', '## A later heading', 'More prose.'].join('\n'),
      'cart-line.spec.md',
    )

    expect(spec.title).toBe('A cart holds its line')
    expect(spec.body).toContain('The prose.')
    // Only the title line is removed; a later heading is ordinary prose.
    expect(spec.body).toContain('## A later heading')
    expect(spec.body).not.toContain('A cart holds its line')
  })

  // No heading at all: the file's own name is the title, and the whole file is prose. The name is
  // the spec's identity, so it is shown as it stands rather than dressed up as a title.
  it('falls back to the file name when the document has no heading', () => {
    const spec = parseSpecDocument('Just prose, no heading.\n', 'cart-total.spec.md')

    expect(spec.title).toBe('cart-total.spec.md')
    expect(spec.body).toBe('Just prose, no heading.')
  })

  // `check:` is not a concept any more: a line that says it is prose in the spec, read like
  // the rest of the body, and nothing parses or reports it.
  it('treats a check: line as ordinary prose', () => {
    const spec = parseSpecDocument(
      ['# A cart holds its line', 'check: endpoint GET /api/cart', '', 'The prose.'].join('\n'),
      'cart-line.spec.md',
    )

    expect(spec.body).toContain('check: endpoint GET /api/cart')
    expect(spec.body).toContain('The prose.')
  })
})

describe('readSpecDocuments', () => {
  // One file is one spec, and the file's path is its identity.
  it('reads one spec per *.spec.md file', () => {
    const dir = makeProject()
    writeFile(dir, 'cart-line.spec.md', '# A cart holds its line\n')
    writeFile(dir, 'checkout.spec.md', '# Checking out takes one step\n')

    expect(readSpecDocuments(dir).specs.map((r) => r.file)).toEqual([
      'cart-line.spec.md',
      'checkout.spec.md',
    ])
  })

  it('reads the suffix without case, and a spec in a subfolder', () => {
    const dir = makeProject()
    writeFile(dir, 'Cart.SPEC.MD', '# A cart holds its line\n')
    writeFile(dir, 'docs/checkout.spec.md', '# Checking out takes one step\n')

    const read = readSpecDocuments(dir)

    expect(read.issues).toEqual([])
    expect(read.specs.map((r) => r.file)).toEqual(['Cart.SPEC.MD', 'docs/checkout.spec.md'])
  })

  // Being markdown is not the test any more: a document that merely *mentions* a spec — a
  // research report carrying a `## R-001` heading — is material, and reads as nothing here.
  it('reads no spec out of a markdown file that is not *.spec.md', () => {
    const dir = makeProject()
    writeFile(dir, 'spec.md', '# Checkout flow\n\nThe index.\n')
    writeFile(dir, 'research/report.md', '## R-001 A cart holds its line\n\nFindings.\n')
    writeFile(dir, 'notes.md', 'Scratch.\n')

    const read = readSpecDocuments(dir)

    expect(read.specs).toEqual([])
    expect(read.issues).toEqual([])
  })

  // The entry's new name is `spec.md`, which does **not** end in `.spec.md`: the suffix, not the
  // word "spec", is what makes a spec, so the index states nothing while the spec beside it
  // does.
  it('reads cart.spec.md as a spec, and the entry spec.md not as one', () => {
    const dir = makeProject()
    writeFile(dir, 'spec.md', '# Checkout flow\n\nThe index.\n')
    writeFile(dir, 'cart.spec.md', '# A cart holds its line\n')

    const read = readSpecDocuments(dir)

    expect(read.specs.map((r) => r.file)).toEqual(['cart.spec.md'])
    expect(read.issues).toEqual([])
  })
})
