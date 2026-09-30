/**
 * ArtifactThumbnail — the small drawn preview beside an artifact's row.
 *
 * The host draws a `.drawio` with the app's own bundled engine, in a hidden window, which
 * is seconds of work — so a row must not ask until somebody can see it (`useInView`), and
 * the atom's `mtimeMs` is the cache key: the row re-asks exactly when the file it names
 * has changed, not on every render.
 *
 * Nothing here decides anything. No picture — still loading, absent, or failed — leaves the
 * icon this list used before the preview existed, so a row never looks broken over one.
 */

import * as React from 'react'
import { Workflow } from 'lucide-react'
import { useInView } from '@/hooks/useInView'

export interface ArtifactThumbnailProps {
  /** The workspace the artifact lives in — the host resolves the file from it. */
  workspaceId: string
  /** Workspace-relative path, POSIX separators. */
  relativePath: string
  /** The list's own mtime for this file; a change re-asks the host for a fresh drawing. */
  mtimeMs: number
}

export function ArtifactThumbnail({ workspaceId, relativePath, mtimeMs }: ArtifactThumbnailProps) {
  // Latches on first sight: a preview, once drawn, is kept as the row scrolls away.
  const [ref, inView] = useInView<HTMLDivElement>()
  const [svg, setSvg] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!inView) return
    let cancelled = false
    window.electronAPI
      .getArtifactThumbnail(workspaceId, relativePath)
      .then((result) => {
        if (!cancelled) setSvg(result?.svg ?? null)
      })
      .catch((err) => {
        console.error('[ArtifactThumbnail] Failed to load thumbnail:', err)
        if (!cancelled) setSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [inView, workspaceId, relativePath, mtimeMs])

  return (
    <div
      ref={ref}
      className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[6px] border border-border/50 bg-foreground/3"
      data-artifact-thumbnail={svg ? 'ready' : 'none'}
    >
      {svg ? (
        // The mark-up is handed to an <img> rather than mounted inline: an SVG in an image
        // is its own document, so no rule of this app's stylesheet — or script — reaches it.
        <img
          src={svgDataUrl(svg)}
          alt=""
          draggable={false}
          className="h-full w-full object-contain"
        />
      ) : (
        <Workflow className="h-3.5 w-3.5 text-foreground/60" />
      )}
    </div>
  )
}

/** The engine's SVG as a URL an `<img>` will take. Encoded whole, as the document is mark-up. */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
