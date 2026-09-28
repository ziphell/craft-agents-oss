/**
 * MarkdownImage - the `<img>` a document's pictures are drawn with.
 *
 * A plain `<img>` for everything a browser fetches on its own. For a destination that names
 * a file beside the document, the file is read through the platform and shown as a data URL
 * — the document's folder is what makes that possible (`image-path.ts`).
 *
 * The picture is only ever an `<img>`, and that is the point: an SVG shown this way is drawn
 * in the browser's static image mode, so nothing inside it runs and nothing inside it is
 * fetched. Inlining the same markup into the DOM would be a different question, and one this
 * component does not ask.
 */

import * as React from 'react'
import { usePlatform } from '../../context/PlatformContext'
import { resolveDocumentImagePath } from './image-path'

export interface MarkdownImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** The folder the document lives in; a relative `src` is read from there. */
  baseDir?: string
  /** react-markdown's own node, dropped here rather than spread onto the element. */
  node?: unknown
}

export function MarkdownImage({ src, alt, baseDir, node, ...props }: MarkdownImageProps) {
  const { onReadFileDataUrl } = usePlatform()
  const localPath = resolveDocumentImagePath(baseDir, src)
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!localPath || !onReadFileDataUrl) return
    let cancelled = false
    setDataUrl(null)
    onReadFileDataUrl(localPath)
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch(() => {
        // The host refused the read, or there is no such file. There is then no picture to
        // show, and the read is the thing that said so — this is a document's picture, not a
        // report about one.
      })
    return () => {
      cancelled = true
    }
  }, [localPath, onReadFileDataUrl])

  // A relative destination is never handed to the browser: it would be requested from the
  // renderer's origin, which is not where the document is. Until the file has been read there
  // is nothing to put in `src`.
  return <img {...props} src={localPath ? dataUrl ?? undefined : src} alt={alt} />
}
