/**
 * Tests for `drawio_tool`'s command line.
 *
 * The door itself is covered in `tool-commands.test.ts`; what is checked here is the reading of
 * the command — which file is read, which flag decides whether anything is written, how a scale and
 * a format are validated — and the exact wording of what comes back.
 *
 * Nothing here writes a `.drawio` file: writing one is the agent's own `Write`, and these commands
 * only draw a file that already exists.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { executeDrawioToolCommand, getDrawioToolHelp } from '../drawio-commands'
import type { BrowserPaneFns } from '../browser-pane'

let workspace = ''

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'craft-diagram-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** The two methods this door's commands reach, so the rest of the surface is absent. */
function stubFns(
  overrides: Partial<Pick<BrowserPaneFns, 'exportDrawio' | 'listDrawioPages'>> = {},
): BrowserPaneFns {
  return {
    exportDrawio: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/svg+xml',
      extension: '.svg',
      path: null,
    }),
    listDrawioPages: async () => [],
    ...overrides,
  } as unknown as BrowserPaneFns
}

async function run(command: string | string[], fns: BrowserPaneFns) {
  return executeDrawioToolCommand({
    command,
    fns,
    sessionId: 'test-session',
    workspaceRootPath: workspace,
  })
}

/** A document on disk, because every command here reads one. */
function diagram(name = 'flow.drawio'): string {
  const path = join(workspace, name)
  writeFileSync(path, '<mxfile><diagram id="p"/></mxfile>', 'utf-8')
  return path
}

describe('drawio_tool command line', () => {
  it('answers --help with the commands and their flags', async () => {
    const help = getDrawioToolHelp()
    expect(help).toContain('drawio_tool command help')
    expect(help).toContain('export <diagram-file> --to <path>')
    expect(help).toContain('render <diagram-file>')
    // And it says where a `.drawio` file comes from, since no command writes one.
    expect(help).toContain('Write')

    expect((await run('--help', stubFns())).output).toBe(help)
  })

  // `pages` exists because a page is addressed by the name the document gives it, and nobody can
  // guess that name: reading the file's XML is the only other way to find it, which is not something
  // to ask of a caller that just wants to draw one page.
  it('lists the pages of a file, and how a command draws one of them', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      listDrawioPages: async (args) => {
        seen.push(args)
        return [
          { id: 'p1', name: 'Checkout', compressed: false },
          { id: 'p2', name: 'v2 split payment', compressed: true },
          { id: 'p3', name: '', compressed: false },
        ]
      },
    })

    const result = await run(['pages', 'flows/../flow.drawio'], fns)

    expect(seen[0]!.path).toBe(resolve(workspace, 'flow.drawio'))
    expect(result.output).toContain('has 3 pages')
    // The one a command draws with no `--page` is marked, and the names are the point of the listing.
    expect(result.output).toContain('* Checkout')
    expect(result.output).toContain('v2 split payment')
    // A page the document never named is listed as such, and said to be unaddressable.
    expect(result.output).toContain('(no name)')
    expect(result.output).toContain('cannot be asked for by name')
    // A compressed page is marked where it is listed, and the way out is named once.
    expect(result.output).toContain('v2 split payment (compressed)')
    expect(result.output).toContain('1 of its 3 pages is compressed')
    expect(result.output).toContain('--format drawio')
  })

  it('says there is nothing to choose when a file has one page', async () => {
    diagram()

    const result = await run('pages flow.drawio', stubFns({
      listDrawioPages: async () => [{ id: 'p1', name: 'Checkout', compressed: false }],
    }))

    expect(result.output).toContain('one page')
    expect(result.output).toContain('"Checkout"')
    expect(result.output).toContain('nothing to choose')
    // Nothing to say about compression when there is none: the sentence would be noise.
    expect(result.output).not.toContain('compressed')
  })

  it('says when every page is compressed, and how a file is written out plain', async () => {
    diagram()

    const result = await run('pages flow.drawio', stubFns({
      listDrawioPages: async () => [{ id: 'p1', name: 'Checkout', compressed: true }],
    }))

    expect(result.output).toContain('Every page is compressed')
    expect(result.output).toContain('--format drawio')
  })

  // A file that is not an `<mxfile>` of pages — an exported `.svg`, say — has no pages to name, and
  // saying which of the two it is beats leaving a caller to guess why the list is empty.
  it('says so when the file is not a drawio document', async () => {
    diagram()

    const result = await run('pages flow.drawio', stubFns({ listDrawioPages: async () => [] }))

    expect(result.output).toContain('No pages in flow.drawio')
    expect(result.output).toContain('not a drawio document')
  })

  it('takes a diagram file and nothing else, and says which diagram when none is named', async () => {
    diagram()

    await expect(run('pages flow.drawio --page Checkout', stubFns()))
      .rejects.toThrow('pages takes a diagram file and nothing else')
    await expect(run('pages', stubFns())).rejects.toThrow('Which diagram?')
  })

  it('refuses an empty command', async () => {
    await expect(run('   ', stubFns())).rejects.toThrow('Missing command')
  })

  it('names the doors a command it does not own belongs to', async () => {
    const message = await run('screenshot', stubFns()).catch((error) => (error as Error).message)

    expect(message).toContain('Unknown drawio_tool command "screenshot"')
    expect(message).toContain("browser_tool's")
    expect(message).toContain("video_tool's")
  })

  // There is no `convert`: a `.drawio` file is written by the agent with `Write`, and this tool's
  // job is drawing one. A command that no longer exists has to say so rather than do nothing.
  it('has no convert — writing the file is the agent’s own Write', async () => {
    const message = await run('convert flow.drawio --out other.drawio', stubFns())
      .catch((error) => (error as Error).message)

    expect(message).toContain('Unknown drawio_tool command "convert"')
  })

  it('refuses an export with nowhere to go — that is what render is for', async () => {
    const message = await run('export flow.drawio', stubFns()).catch((error) => (error as Error).message)

    expect(message).toContain('--to is required')
    expect(message).toContain('"render"')
  })

  it('refuses a format the engine does not draw', async () => {
    await expect(run('export flow.drawio --to flow.pdf --format pdf', stubFns()))
      .rejects.toThrow('--format takes one of svg, png, html, drawio')

    // And drawio's own names for two of them are not this command line's words: they were, and a
    // caller that still says them is asking for something that no longer exists.
    await expect(run('export flow.drawio --to flow.svg --format xmlsvg', stubFns()))
      .rejects.toThrow('not "xmlsvg"')
  })

  // `drawio` is the document rather than a drawing: the same road out, and the one format whose file
  // *is* the thing — so the reply does not warn that nothing in it points back at the document.
  it('writes the document out plain with --format drawio', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return {
          bytes: new Uint8Array([60, 109, 120]),
          mimeType: 'application/xml',
          extension: '.drawio',
          path: args.out ?? null,
        }
      },
    })

    const result = await run('export flow.drawio --to out/plain.drawio --format drawio', fns)

    // The engine is asked for `xml`: drawio's own name for "the document". The command line's word
    // for it is `drawio`, because that is what the caller gets.
    expect(seen[0]).toMatchObject({ format: 'xml' })
    expect(seen[0]!.out).toBe(resolve(workspace, 'out', 'plain.drawio'))
    expect(result.output).toContain('drawio, 3 bytes')
    expect(result.output).not.toContain('Nothing in the file points back')

    // A plain `svg` is a rendering, though: the file holds the picture and nothing that points back at
    // what it came from, and the reply says so rather than leaving someone to find out.
    const drawn = await run('export flow.drawio --to out/plain.svg', fns)
    expect(drawn.output).toContain('Nothing in the file points back')
  })

  // An SVG with the document inside it is asked for as an *attachment to svg* rather than as a format
  // of its own: there is one picture format here, and this is what makes it handable-on.
  it('puts the document inside an SVG when asked for --editable', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return {
          bytes: new Uint8Array([1, 2]),
          mimeType: 'image/svg+xml',
          extension: '.svg',
          path: args.out ?? null,
        }
      },
    })

    const result = await run('export flow.drawio --to out/editable.svg --editable', fns)

    expect(seen[0]).toMatchObject({ format: 'xmlsvg' })
    // Enough of the document travels with it that the reply must not claim otherwise.
    expect(result.output).not.toContain('Nothing in the file points back')
    expect(result.output).toContain('svg (editable)')
  })

  // Refused rather than ignored: a caller that asks for an editable PNG believes it is handing over a
  // file that carries the document, and a file that does not is the wrong deliverable — the same
  // failure, by the same reasoning, as drawing a page nobody asked for.
  it('refuses --editable on anything but svg', async () => {
    await expect(run('export flow.drawio --to out/flow.png --format png --editable', stubFns()))
      .rejects.toThrow('--editable is for svg: a png has no document to carry')

    await expect(run('export flow.drawio --to out/plain.drawio --format drawio --editable', stubFns()))
      .rejects.toThrow('drawio *is* the document')
  })

  // `--theme` is what the drawing is *made for* — one axis, honoured two ways: an SVG states it in
  // the file, a PNG is drawn by it. Unsaid it is `auto`, and what the file is has to travel with the
  // answer, because a file that follows the reader and one that is pinned are different files.
  it('passes --theme through for svg, and says which of the two the file is', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return {
          bytes: new Uint8Array([1]),
          mimeType: 'image/svg+xml',
          extension: '.svg',
          path: args.out ?? null,
        }
      },
    })

    const pinned = await run('export flow.drawio --to out/flow.svg --theme light', fns)
    expect(seen[0]).toMatchObject({ format: 'svg', theme: 'light' })
    expect(pinned.output).toContain('svg (fixed light)')

    // Unsaid, it is `auto` — and the reply must not say a file is pinned when it is not.
    const following = await run('export flow.drawio --to out/flow.svg', fns)
    expect(seen[1]).toMatchObject({ format: 'svg', theme: 'auto' })
    expect(following.output).not.toContain('fixed')

    // The one file that carries its document takes it too: the two are separate facts, and both
    // travel in the answer.
    const editable = await run('export flow.drawio --to out/editable.svg --editable --theme dark', fns)
    expect(seen[2]).toMatchObject({ format: 'xmlsvg', theme: 'dark' })
    expect(editable.output).toContain('svg (editable, fixed dark)')
  })

  // A render is a PNG, and a PNG is a drawing `--theme` is honoured for — the other half of the same
  // axis: there is no file to state a scheme in, so the picture is simply drawn that way.
  it('draws a render for the theme it was given', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return { bytes: new Uint8Array([137, 80]), mimeType: 'image/png', extension: '.png', path: null }
      },
    })

    const dark = await run('render flow.drawio --theme dark', fns)
    expect(seen[0]).toMatchObject({ format: 'png', theme: 'dark' })
    // Nothing in the sentence claims a scheme: a PNG carries none, and the picture is right there.
    expect(dark.output).not.toContain('fixed')

    await run('render flow.drawio', fns)
    expect(seen[1]).toMatchObject({ format: 'png', theme: 'auto' })
  })

  // Refused rather than ignored where the export cannot honour it, like `--editable` where it means
  // nothing: a caller who believes their page states a scheme is a caller about to be surprised.
  it('refuses --theme for the formats that state none, and a theme it does not have', async () => {
    await expect(run('export flow.drawio --to out/flow.html --format html --theme dark', stubFns()))
      .rejects.toThrow('--theme is for svg and png')

    await expect(run('export flow.drawio --to out/plain.drawio --format drawio --theme dark', stubFns()))
      .rejects.toThrow('--theme is for svg and png')

    await expect(run('export flow.drawio --to out/flow.svg --theme sepia', stubFns()))
      .rejects.toThrow('--theme takes one of auto, light, dark')
  })

  // A path that names no suffix gets the format's, which for a diagram matters more than for a
  // picture: the app opens one by its `.drawio` name and by nothing else.
  it('completes a --to path that names no suffix', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return {
          bytes: new Uint8Array([1]),
          mimeType: 'application/xml',
          extension: '.drawio',
          path: args.out ?? null,
        }
      },
    })

    await run('export flow.drawio --to out/plain --format drawio', fns)
    expect(seen[0]!.out).toBe(resolve(workspace, 'out', 'plain.drawio'))

    // A suffix of its own is left alone — what the caller named is theirs.
    await run('export flow.drawio --to out/v1.2 --format svg', fns)
    expect(seen[1]!.out).toBe(resolve(workspace, 'out', 'v1.2'))

    await run('export flow.drawio --to out/picture --format png', fns)
    expect(seen[2]!.out).toBe(resolve(workspace, 'out', 'picture.png'))
  })

  it('exports svg by default, reading the document at the path it was given', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return {
          bytes: new Uint8Array([1]),
          mimeType: 'image/svg+xml',
          extension: '.svg',
          path: resolve(args.out ?? ''),
        }
      },
    })

    await run('export flows/../flow.drawio --to out/flow.svg', fns)

    expect(seen[0]).toMatchObject({ format: 'svg', theme: 'auto' })
    expect(seen[0]!.path).toBe(resolve(workspace, 'flow.drawio'))
    expect(seen[0]!.out).toBe(resolve(workspace, 'out', 'flow.svg'))
    expect(seen[0]!.scale).toBeUndefined()
  })

  it('passes --format, --scale and --theme through, and names the file it wrote', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return { bytes: new Uint8Array([1, 2]), mimeType: 'image/png', extension: '.png', path: args.out ?? null }
      },
    })

    const result = await run('export flow.drawio --to out/flow.png --format png --scale 2 --theme dark', fns)

    expect(seen[0]).toMatchObject({ format: 'png', scale: 2, theme: 'dark' })
    expect(result.output).toContain('png, 2 bytes')
  })

  it('refuses a --scale with no number', async () => {
    diagram()
    await expect(run('export flow.drawio --to out/flow.svg --scale', stubFns()))
      .rejects.toThrow('--scale needs a value')
  })

  // A page travels as the name the document gives it — spaces and all, which is why the command line
  // honours quotes. Which page that is, the file answers; the command only carries the word.
  it('passes --page through as the name it was given', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return { bytes: new Uint8Array([1]), mimeType: 'image/svg+xml', extension: '.svg', path: args.out ?? null }
      },
    })

    const result = await run('export flow.drawio --to out/v2.svg --page "v2 split payment"', fns)

    expect(seen[0]!.page).toBe('v2 split payment')
    // And it comes back named, so a caller can see the page it asked for is the page drawn.
    expect(result.output).toContain('page "v2 split payment"')

    // The array form takes the same name with no quoting to get right.
    await run(['export', 'flow.drawio', '--to', 'out/v2.svg', '--page', 'v2 split payment'], fns)
    expect(seen[1]!.page).toBe('v2 split payment')
  })

  it('asks for no page when none is named — the first page is the document’s own answer', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return { bytes: new Uint8Array([137, 80]), mimeType: 'image/png', extension: '.png', path: null }
      },
    })

    const result = await run('render flow.drawio', fns)

    expect('page' in seen[0]!).toBe(false)
    expect(result.output).not.toContain('page "')
  })

  it('refuses a --page with no name', async () => {
    diagram()
    await expect(run('export flow.drawio --to out/flow.svg --page', stubFns()))
      .rejects.toThrow('--page needs a value')
  })

  it('renders a picture into the reply and writes nothing', async () => {
    diagram()

    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns({
      exportDrawio: async (args) => {
        seen.push(args)
        return { bytes: new Uint8Array([137, 80]), mimeType: 'image/png', extension: '.png', path: null }
      },
    })

    const result = await run('render flow.drawio', fns)

    // A rendering is a picture in the reply: no destination, and no file to name.
    expect(seen[0]).toMatchObject({ format: 'png' })
    expect(seen[0]!.out).toBeUndefined()
    expect(result.image).toMatchObject({ mimeType: 'image/png', sizeBytes: 2 })
    expect(result.output).toContain('nothing was written')
  })

  it('refuses a render with no diagram named', async () => {
    await expect(run('render', stubFns())).rejects.toThrow('Which diagram?')
  })
})
