import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  extractLinkTargets,
  readSpecLinks,
} from '..'

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A project folder, ready for documents to be written into it. */
function makeProject(slug = 'checkout-flow'): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-project-links-'))
  const dir = join(workspaceRoot, 'projects', slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeDoc(dir: string, name: string, source: string): void {
  const path = join(dir, name)
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

  // A picture is a destination too, but it is not a document pointing at another one.
  it('does not read a picture as a link', () => {
    expect(extractLinkTargets('![a link in prose](images/links.drawio.svg)')).toEqual([])
    expect(extractLinkTargets('![diagram](images/a.svg) and [doc](docs/b.md)')).toEqual(['docs/b.md'])
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

describe('readSpecLinks', () => {
  it('resolves from the document’s folder, from the root, and past the document’s own level', () => {
    const dir = makeProject()
    writeDoc(
      dir,
      'spec.md',
      'The detail is in [checkout](docs/checkout.md), the states in [states](docs/states.md).\n',
    )
    writeDoc(dir, 'docs/checkout.md', 'Back to [the entry](../spec.md).\n')
    // A link between two documents in the same subfolder is relative to that folder.
    writeDoc(dir, 'docs/states.md', 'See also [checkout](checkout.md).\n')

    const { links } = readSpecLinks(dir)

    expect(
      links.filter((link) => link.from === 'spec.md').map((link) => `${link.target}→${link.to}`),
    ).toEqual(['docs/checkout.md→docs/checkout.md', 'docs/states.md→docs/states.md'])
    expect(links.find((link) => link.from === 'docs/checkout.md')?.to).toBe('spec.md')
    expect(links.find((link) => link.from === 'docs/states.md')?.to).toBe('docs/checkout.md')
  })

  it('keeps a link that points at nothing, as a target that resolves to nothing', () => {
    const dir = makeProject()
    writeDoc(dir, 'spec.md', 'The detail is in [nowhere](docs/nowhere.md).\n')

    const { links } = readSpecLinks(dir)

    // It stays in the list as `to: null` rather than being dropped — what a broken link *means* is
    // the report's sentence (`gate.linkBroken`), so this reader does not say it a second time.
    expect(links).toEqual([{ from: 'spec.md', target: 'docs/nowhere.md', to: null }])
  })

  it('follows a link out of the folder, to a document another project holds', () => {
    const dir = makeProject()
    writeDoc(dir, 'spec.md', 'Shared with [the other project](../../projects/cart/cart.spec.md).\n')
    // A real file one level above the projects root: another project's spec.
    writeDoc(join(workspaceRoot, 'projects', 'cart'), 'cart.spec.md', '# Cart total\n')

    const { links } = readSpecLinks(dir)

    // The path the author wrote is the path. Dropping the leading `..` used to rewrite it into
    // `projects/cart/cart.spec.md` — a name *inside* this folder — and report a working link as
    // broken.
    expect(links).toEqual([
      {
        from: 'spec.md',
        target: '../../projects/cart/cart.spec.md',
        to: '../../projects/cart/cart.spec.md',
      },
    ])
  })

  it('still reports a link that leaves the folder and arrives nowhere', () => {
    const dir = makeProject()
    writeDoc(dir, 'spec.md', 'Shared with [a project that is gone](../../projects/gone/x.spec.md).\n')

    const { links } = readSpecLinks(dir)

    expect(links).toEqual([
      { from: 'spec.md', target: '../../projects/gone/x.spec.md', to: null },
    ])
  })

  // The app opens the link; the workbench only reads the ones written in this folder's markdown,
  // and a link written in a script is not one of them.
  it('reads links out of markdown only', () => {
    const dir = makeProject()
    writeDoc(dir, 'spec.md', '# Spec\n')
    writeDoc(dir, 'cart.js', 'const x = "[a](b.md)"\n')

    const { links } = readSpecLinks(dir)

    expect(links).toEqual([])
  })
})
