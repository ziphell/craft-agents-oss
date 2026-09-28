import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  extractLinkTargets,
  getPrototypeDirPath,
  readPrototypeLinks,
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
  it('reads the relative file destinations, once each, with the fragment set aside', () => {
    const source = [
      'The detail is in [the checkout document](docs/checkout.md).',
      'Also [states](docs/checkout.md#states) and [a space](<docs/my file.md>).',
      'A repeat of [checkout](docs/checkout.md) is the same link.',
    ].join('\n')

    expect(extractLinkTargets(source)).toEqual(['docs/checkout.md', 'docs/my file.md'])
  })

  // Everything the browser fetches on its own, an absolute path, a fragment, or a destination that
  // names no file: none of them is "a document in this folder".
  it('leaves everything that is not a file beside the document alone', () => {
    const source = [
      '[a site](https://example.com/x.md)',
      '[an address](mailto:me@example.com)',
      '[absolute](/w/other/x.md)',
      '[windows](C:\\other\\x.md)',
      '[a section](#states)',
      '[no file](docs/checkout)',
      '[a page](docs/page.html#top)',
    ].join('\n')

    expect(extractLinkTargets(source)).toEqual(['docs/page.html'])
  })

  // A document that explains the convention writes a link inside code, and describing a link must
  // not create one.
  it('leaves `[text](dest)` inside code spans and fenced blocks alone', () => {
    const source = [
      'Use `[x](docs/checkout.md)` like that.',
      '',
      '```md',
      'See [x](docs/checkout.md) for the detail.',
      '```',
      '',
      'But [real](docs/real.md) is a link.',
    ].join('\n')

    expect(extractLinkTargets(source)).toEqual(['docs/real.md'])
  })
})

describe('readPrototypeLinks', () => {
  it('resolves from the document’s folder, from the root, and past the document’s own level', () => {
    const slug = makePrototype()
    writeDoc(
      slug,
      'PRD.md',
      'The detail is in [checkout](docs/checkout.md), the states in [states](docs/states.md).\n',
    )
    writeDoc(slug, 'docs/checkout.md', 'Back to [the entry](../PRD.md).\n')
    // A link between two documents in the same subfolder is relative to that folder.
    writeDoc(slug, 'docs/states.md', 'See also [checkout](checkout.md).\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)

    expect(issues).toEqual([])
    expect(
      links.filter((link) => link.from === 'PRD.md').map((link) => `${link.target}→${link.to}`),
    ).toEqual(['docs/checkout.md→docs/checkout.md', 'docs/states.md→docs/states.md'])
    expect(links.find((link) => link.from === 'docs/checkout.md')?.to).toBe('PRD.md')
    expect(links.find((link) => link.from === 'docs/states.md')?.to).toBe('docs/checkout.md')
  })

  it('reports a link that points at nothing, in its own words', () => {
    const slug = makePrototype()
    writeDoc(slug, 'PRD.md', 'The detail is in [nowhere](docs/nowhere.md).\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)

    expect(links).toEqual([{ from: 'PRD.md', target: 'docs/nowhere.md', to: null }])
    expect(issues.join('\n')).toContain('PRD.md links to docs/nowhere.md, which is not in this prototype')
  })

  // The app opens the link; the workbench only reads the ones that point inside the folder, and a
  // link written in a script is not one of them.
  it('reads links out of markdown only', () => {
    const slug = makePrototype()
    writeDoc(slug, 'PRD.md', '# PRD\n')
    writeDoc(slug, 'cart.js', 'const x = "[a](b.md)"\n')

    const { links, issues } = readPrototypeLinks(workspaceRoot, slug)

    expect(links).toEqual([])
    expect(issues).toEqual([])
  })
})
