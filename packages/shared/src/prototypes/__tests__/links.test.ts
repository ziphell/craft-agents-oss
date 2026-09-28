import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  extractLinkTargets,
  getPrototypeDirPath,
  readPrototypeLinks,
  rewriteWikiLinks,
} from '..'

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A prototype folder, ready for documents to be written into it. */
function makePrototype(slug = 'checkout-flow'): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-links-'))
  mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
  return slug
}

function writeDoc(slug: string, name: string, source: string): void {
  const path = join(getPrototypeDirPath(workspaceRoot, slug), name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, 'utf-8')
}

describe('extractLinkTargets', () => {
  it('reads a target once, with the label and the anchor stripped', () => {
    const source = [
      'The detail is in [[docs/checkout.md]].',
      'Also [[checkout|the checkout document]] and [[docs/checkout.md#states]].',
      'A repeat of [[docs/checkout.md]] is the same link.',
    ].join('\n')

    expect(extractLinkTargets(source)).toEqual(['docs/checkout.md', 'checkout'])
  })

  // The guide that explains this convention writes `[[…]]` inside code, and describing a link must
  // not create one.
  it('leaves `[[…]]` inside code spans and fenced blocks alone', () => {
    const source = [
      'Use `[[docs/checkout.md]]` like that.',
      '',
      '```md',
      'See [[docs/checkout.md]] for the detail.',
      '```',
      '',
      'But [[docs/real.md]] is a link.',
    ].join('\n')

    expect(extractLinkTargets(source)).toEqual(['docs/real.md'])
  })
})

describe('rewriteWikiLinks', () => {
  it('turns a resolved link into an ordinary markdown link, keeping the author’s label', () => {
    const source = 'See [[docs/checkout.md]] and [[checkout|the flow]].'
    const out = rewriteWikiLinks(source, (target) =>
      target === 'docs/checkout.md' ? '/w/p/docs/checkout.md' : '/w/p/docs/checkout.md',
    )

    expect(out).toBe(
      'See [docs/checkout.md](</w/p/docs/checkout.md>) and [the flow](</w/p/docs/checkout.md>).',
    )
  })

  // A broken link is reported where it is reported; drawing it as one that looks live, pointing
  // somewhere invented, would be worse than leaving it plainly unresolved.
  it('leaves a link that resolves to nothing exactly as written', () => {
    const out = rewriteWikiLinks('See [[gone]].', () => null)
    expect(out).toBe('See [[gone]].')
  })

  it('does not rewrite inside code', () => {
    const out = rewriteWikiLinks('`[[a]]` and [[a]]', () => '/x/a.md')
    expect(out).toBe('`[[a]]` and [a](</x/a.md>)')
  })
})

describe('readPrototypeLinks', () => {
  it('resolves a path from the document, from the root, and a bare name across the folder', () => {
    const slug = makePrototype()
    writeDoc(slug, 'PRD.md', [
      'The detail is in [[docs/checkout.md]].',
      'The state list is in [[docs/states]].',
      'And the glossary is [[glossary]].',
    ].join('\n'))
    writeDoc(slug, 'docs/checkout.md', '# Checkout\n\nBack to [[../PRD.md]].\n')
    writeDoc(slug, 'docs/states.md', '# States\n')
    writeDoc(slug, 'glossary.md', '# Glossary\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)
    const byTarget = new Map(links.map((link) => [link.target, link.to]))

    expect(issues).toEqual([])
    expect(byTarget.get('docs/checkout.md')).toBe('docs/checkout.md')
    expect(byTarget.get('docs/states')).toBe('docs/states.md')
    expect(byTarget.get('glossary')).toBe('glossary.md')
    // A document in a subfolder points back up past its own level.
    expect(links.find((link) => link.from === 'docs/checkout.md')?.to).toBe('PRD.md')
  })

  it('reports a link that points at nothing, in its own words', () => {
    const slug = makePrototype()
    writeDoc(slug, 'PRD.md', 'The detail is in [[docs/nowhere.md]].\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)

    expect(links).toEqual([{ from: 'PRD.md', target: 'docs/nowhere.md', to: null }])
    expect(issues.join('\n')).toContain('PRD.md links to docs/nowhere.md, which is not in this prototype')
  })

  // Two files with one name is a question, not something to guess at. (Neither sits at the root: a
  // name that a path resolves never reaches the name match at all.)
  it('reports a bare name that matches more than one document', () => {
    const slug = makePrototype()
    writeDoc(slug, 'PRD.md', 'See [[checkout]].\n')
    writeDoc(slug, 'docs/checkout.md', '# One\n')
    writeDoc(slug, 'notes/checkout.md', '# Two\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)

    expect(links[0]?.to).toBeNull()
    expect(issues.join('\n')).toContain('matches more than one file (docs/checkout.md, notes/checkout.md)')
  })

  // `[[…]]` in a script is an array literal, and a file that only happens to contain brackets is not
  // a document pointing anywhere.
  it('reads links out of markdown only', () => {
    const slug = makePrototype()
    writeDoc(slug, 'PRD.md', '# PRD\n')
    writeDoc(slug, 'cart.js', 'const rows = [[1, 2], [3, 4]]\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)

    expect(links).toEqual([])
    expect(issues).toEqual([])
  })
})
