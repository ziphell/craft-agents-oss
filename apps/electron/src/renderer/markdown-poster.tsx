/**
 * A markdown document drawn **by the app's own renderer**, for a poster.
 *
 * This is the whole reason the poster exists here rather than in the main process: the renderer is
 * a React tree, and a second parser in main (which is what used to make the picture) was a second
 * dialect — callouts, mermaid, datatables and real tables simply were not in it. So the poster
 * window loads the renderer with `?mdPoster=1&text=…` and this is what it mounts: the **reading
 * face** of a markdown document (`TiptapMarkdownEditor presentation`), 800 px wide, on white, and
 * nothing else. `markdown_tool shot` takes the same picture at the size the caller asked for.
 *
 * Three decisions, all of them about a picture rather than a page:
 *
 * - **800 px is the card's layout width**, not A4's 794. The card is a 16:9 slot and takes the page
 *   *from its top at card width*, so drawing at the width it is shown at means the layout matches
 *   the card — the capture's own pixel density is what makes it sharp on a high-density screen.
 * - **The blocks that read files are off.** A `drawio-preview` or `html-preview` block asks the
 *   platform for bytes, and this window has no workspace behind it. The pure ones (datatable,
 *   spreadsheet, diff, json, mermaid, latex) stay: they are drawn from the fence alone.
 * - **It says when it is ready** (`data-poster-ready`), and only after the fonts are. A capture
 *   taken before the fonts land is a picture of the fallback face — measured, not guessed.
 */

import * as React from 'react'
import { Markdown, PlatformProvider, preprocessLinks, resolveDocumentPath, TiptapMarkdownEditor } from '@craft-agent/ui'
import type { DisablablePreviewBlock, PlatformActions } from '@craft-agent/ui'

/**
 * The fences a picture **does not draw**, and the rule that picks them.
 *
 * The line is not "does it need the app" — it is *what the block is*:
 *
 * - A fence that holds its own content (`mermaid`, `latex`, `datatable`, `spreadsheet`, `diff`,
 *   `json`) is drawn: the diagram, the table, the numbers **are** what the document says, and
 *   leaving them as code would make the card less like the file, not more.
 * - A fence that **points at something else** (`markdown-preview`, `html-preview`, `pdf-preview`,
 *   `image-preview`) or at another app's surface (`drawio-preview`) is not drawn. It means "open
 *   that over there", so a picture of it would either nest a second editor inside this one or show
 *   a page this document does not contain — and `image-preview` is a path to read, which is a
 *   capability a picture has no business exercising. A **standard** image (`![]()`) is a different
 *   thing and stays: every editor shows one, and `MarkdownImage` reads it through the same door as
 *   the app does.
 *
 * That set is also what an **outside reader** sees — `markdown-preview` and friends are not
 * standard markdown, so anyone opening the file in another editor gets a code block. A poster that
 * drew them would show a document nobody else can open.
 */
const NOT_DRAWN: ReadonlySet<DisablablePreviewBlock> = new Set<DisablablePreviewBlock>([
  'markdown-preview',
  'html-preview',
  'pdf-preview',
  'image-preview',
  'drawio-preview',
])

/** The bridge the preload exposes: a file beside the document, as text or as a data URL. */
interface PosterBridge {
  readText(path: string): Promise<string>
  readDataUrl(path: string): Promise<string>
}

/**
 * The platform a picture gets: read a file **the document names beside it**, and nothing else.
 *
 * The rule is the app's own (`resolveDocumentPath`, the same function `![](logo.png)` goes through):
 * only a **relative** destination is resolved against the document's folder — an absolute path, a
 * `file:` URL or an `https:` one is not "beside the document" and is refused here rather than read.
 * That is stricter than a browser, which would fetch a remote image and with it tell somebody the
 * page was drawn, and it is why a document handed to this window cannot reach a file of its choosing:
 * `../` past the document's workspace is refused on the other side of the bridge as well.
 *
 * Refused reads reject, and the block already knows what to do with that: a `datatable` with a
 * `src` shows its error, a `![]()` shows nothing. Neither invents content.
 */
function posterPlatform(baseDir: string | undefined): PlatformActions {
  const bridge = (globalThis as { craftPoster?: PosterBridge }).craftPoster
  if (!bridge) return {}

  /** The absolute path a destination beside the document names, or a refusal. */
  const beside = (src: string): string => {
    const resolved = resolveDocumentPath(baseDir, src)
    if (!resolved) {
      throw new Error(`a poster only reads a file beside its document: ${src}`)
    }
    return resolved
  }

  return {
    onReadFile: (src: string) => bridge.readText(beside(src)),
    onReadFileDataUrl: (src: string) => bridge.readDataUrl(beside(src)),
  }
}

/** The text a poster is asked for, and the width it is drawn at. */
export function MarkdownPoster({ text, width, base }: { text: string; width: number; base?: string }) {
  const platform = React.useMemo(() => posterPlatform(base), [base])

  React.useEffect(() => {
    // One frame after the fonts are in: a capture taken earlier photographs the fallback face.
    let cancelled = false
    const ready = () => {
      if (cancelled) return
      requestAnimationFrame(() => {
        document.documentElement.dataset.posterReady = '1'
      })
    }
    if (document.fonts?.ready) void document.fonts.ready.then(ready)
    else ready()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      style={{
        width,
        padding: '44px 52px',
        boxSizing: 'border-box',
        background: '#ffffff',
        color: '#26241f',
        overflow: 'hidden',
      }}
    >
      {/* The **reading face** of the document — the same `TiptapMarkdownEditor` a `.md` file is read with
          (`presentation`), not a second renderer: a card that looked different from the document it pictures
          would be a picture of something else. The provider is the poster window's one capability: read the
          file a block names. */}
      <PlatformProvider actions={platform}>
        {/* `baseDir` is what makes `![](logo.png)` resolve against the document's own folder —
            without it the renderer would ask for it relative to its own origin, which is not where
            a document's pictures live. */}
        <TiptapMarkdownEditor
          content={preprocessLinks(text)}
          presentation
          markdownEngine="official"
          baseDir={base}
          readFileDataUrl={platform.onReadFileDataUrl}
          suppressedFenceDrawings={NOT_DRAWN}
          renderLiteralBlock={(literal) => (
            <Markdown baseDir={base} disablePreviewBlocks={NOT_DRAWN}>
              {literal}
            </Markdown>
          )}
        />
      </PlatformProvider>
    </div>
  )
}

/** What `?mdPoster=1` turns the window into: the poster, or a sentence instead of a blank page. */
export function MarkdownPosterRoot({ text, width, base }: { text: string; width: number; base?: string }) {
  if (!text.trim()) {
    return <p style={{ font: '14px system-ui', padding: 24 }}>This document is empty.</p>
  }
  return <MarkdownPoster text={text} width={width} base={base} />
}

/**
 * The document text as a query value, and back.
 *
 * Base64url rather than percent-encoded text: a document is full of characters a URL is entitled to
 * re-encode, and the window is loaded through two different paths (dev server, packaged file) with
 * a query Electron builds. Base64url survives both, and decoding to bytes is what makes a document
 * with an emoji in it arrive as the same document.
 */
export function encodePosterText(source: string): string {
  const bytes = new TextEncoder().encode(source)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodePosterText(value: string): string {
  if (!value) return ''
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder().decode(bytes)
  } catch {
    // A query the window cannot decode is an empty document, not a crash in the renderer.
    return ''
  }
}
