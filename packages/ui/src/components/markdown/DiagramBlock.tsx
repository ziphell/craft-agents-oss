/**
 * A diagram in a conversation: as big as it was drawn, in a box that scrolls, with a press that
 * stayed put opening the full-size window.
 *
 * Both diagrams go through here — mermaid and mindmap — because the frame around the drawing is
 * the same question whichever renderer produced the markup: the expand button in the corner, the
 * sizing rules in `InlineDiagram`, the overlay, and the source to fall back to when the drawing
 * could not be made. Only the SVG and the window's title differ, and those are the props.
 */

import * as React from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { InlineDiagram, svgSize } from './InlineDiagram'
import { MermaidPreviewOverlay } from '../overlay/MermaidPreviewOverlay'

export interface DiagramBlockProps {
  /** The drawing, or null when it could not be made — the source is shown instead. */
  svg: string | null
  /** The fence body, which the full-screen window offers to copy. */
  code: string
  className?: string
  /** Whether to show the inline expand button. Default true. */
  showExpandButton?: boolean
  /** Whether the block reads the mouse itself — see `InlineDiagram`. */
  interactive?: boolean
  /** Optional minimum block height to reserve space before responsive sizing settles. */
  minHeight?: number
  /** The full-screen window's title. */
  overlayTitle: string
  /** The accessible name for the press that opens the window. */
  activateLabel?: string
}

export function DiagramBlock({
  svg,
  code,
  className,
  showExpandButton = true,
  interactive = true,
  minHeight,
  overlayTitle,
  activateLabel,
}: DiagramBlockProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const size = React.useMemo(() => (svg ? svgSize(svg) : null), [svg])
  const minHeightStyle = minHeight != null ? { minHeight: `${minHeight}px` } : undefined

  // A drawing that could not be made falls back to the source, not to an empty box.
  if (!svg) {
    return <CodeBlock code={code} language="mermaid" mode="full" className={className} />
  }

  return (
    <>
      {/* Wrapper with group class so the expand button shows on hover */}
      <div className={cn('relative group', className)} style={minHeightStyle}>
        {showExpandButton && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              'absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none',
              'opacity-0 group-hover:opacity-100',
              'bg-background shadow-minimal',
              'text-muted-foreground/50 hover:text-foreground',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}

        <InlineDiagram
          svg={svg}
          size={size}
          onActivate={() => setIsFullscreen(true)}
          interactive={interactive}
          minHeight={minHeight}
          activateLabel={activateLabel}
        />
      </div>

      <MermaidPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        svg={svg}
        code={code}
        title={overlayTitle}
      />
    </>
  )
}
