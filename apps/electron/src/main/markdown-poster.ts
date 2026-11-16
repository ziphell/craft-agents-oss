/**
 * A `.md` poster: the app's own renderer, in a window nobody sees, at the card's width.
 *
 * This used to be a string builder in main — headings, bullets, quotes, then "everything else is
 * text" — which was a second dialect of markdown and a picture that disagreed with the page it
 * claimed to show (no callouts, no mermaid, no real tables). The renderer that draws a document is
 * the React one, so the picture is taken **there**: this window loads the app's own bundle with
 * `?mdPoster=1`, that bundle mounts one `<Markdown>`, and the screenshot is the poster.
 *
 * The geometry is the card's, not paper's: **800 CSS px** wide and 450 tall, laid out and captured
 * at 1×, so the picture is the card's top 450 px at the display's own density. A document's top
 * 450 px is what a card shows — a page continues below the fold, and that is what the fold is for.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { captureSurface } from './capture-surface'
import { registerPosterRoot } from './poster-bridge'
import { getWorkspaces } from '@craft-agent/shared/config'
import { MARKDOWN_POSTER_WIDTH, markdownPosterQuery } from './creation-poster'

/**
 * The picture, or `null` when the window never drew one.
 */
export async function captureMarkdownPoster(
  source: string,
  size: { width: number; height: number } = { width: MARKDOWN_POSTER_WIDTH, height: 450 },
  /** The document's own path, so a picture may read beside it and nowhere else. */
  documentPath?: string,
): Promise<Buffer | null> {
  const query = markdownPosterQuery(source, size.width, documentPath ? dirname(documentPath) : undefined)
  const devServer = process.env.VITE_DEV_SERVER_URL

  const capture = await captureSurface({
    // A card's shape by default; a caller asking to *look* at the document says how much it wants.
    size,
    /**
     * **Scripting on**, and it is the one place in the poster code that needs saying twice.
     *
     * `captureSurface` defaults to scripting **off**, which is right for a page we only *show* —
     * and it is why the first version of this file photographed a white rectangle: a React
     * component does not mount without its script. What the document itself may execute is a
     * different question, and the answer is still no: the fences that would run a page or read a
     * file are simply not drawn (`NOT_DRAWN` in the renderer).
     */
    javascript: true,
    // The renderer needs no node, but the blocks that name a file need one verb from the app: this
    // is the window that supplies it (see `poster-bridge.ts`).
    preload: join(__dirname, 'poster-preload.cjs'),
    // A picture reads the files its document names — inside that document's workspace, and no
    // further. `poster-bridge.ts` refuses everything else.
    onWindow: (win) => registerPosterRoot(win.webContents.id, rootOf(documentPath)),
    // The same two loads a normal window uses: the dev server, or the packaged file.
    load: devServer
      ? (win) => win.loadURL(`${devServer}?${new URLSearchParams(query).toString()}`)
      : (win) => win.loadFile(join(__dirname, 'renderer/index.html'), { query }),
    prepare: async (surface) => {
      // The page says when its fonts are in (`markdown-poster.tsx`); before that a capture
      // photographs the fallback face. A page that never says so still gets photographed, later.
      await surface
        .run<boolean>(`(async () => {
          const deadline = Date.now() + 8000
          while (Date.now() < deadline) {
            if (document.documentElement.dataset.posterReady === '1') return true
            await new Promise((r) => setTimeout(r, 50))
          }
          return false
        })()`)
        .catch(() => false)
      return null
    },
    settleMs: 150,
    timeoutMs: 20_000,
  })
  return capture?.png ?? null
}

/**
 * The same window, for `markdown_tool shot`: the document at the size the caller asked for.
 *
 * One difference from the poster, and it is the caller's, not the picture's: the picture is written
 * into `outDir` and its path handed back, because a tool answer carries files and the tool layer
 * decides how many of them ride the reply.
 */
export async function writeMarkdownShot(
  path: string,
  outDir: string,
  size: { width: number; height: number },
): Promise<string[]> {
  const source = await readFile(path, 'utf8')
  const png = await captureMarkdownPoster(source, size, path)
  if (!png) return []
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, `${basename(path).replace(/\.[^.]+$/, '')}.png`)
  await writeFile(file, png)
  return [file]
}

/**
 * The root a poster may read from: the workspace holding the document.
 *
 * A markdown file can reference `../assets/logo.png`, so the root is the workspace and not the
 * file's own folder — but it is **that** workspace, not every workspace the person has open. A file
 * outside any configured workspace falls back to its own directory, which is the narrowest answer
 * that still lets a document show a picture beside it.
 */
function rootOf(documentPath: string | undefined): string {
  if (!documentPath) return process.cwd()
  const target = resolve(documentPath)
  try {
    const containing = getWorkspaces()
      .map((workspace) => resolve(workspace.rootPath))
      .filter((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
      // The deepest root wins: a workspace nested inside another belongs to the inner one.
      .sort((a, b) => b.length - a.length)[0]
    if (containing) return containing
  } catch {
    // No config yet (first run): the document's own folder is all a picture may look at.
  }
  return dirname(target)
}
