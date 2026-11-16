import * as React from 'react'
import { parseMindmapFence } from '@craft-agent/core/mermaid/mindmap'
import { useTranslation } from 'react-i18next'
import { DiagramBlock } from './DiagramBlock'
import { renderMindmapSVG } from './mindmap-svg'

// ============================================================================
// MarkdownMindmapBlock — draws a mermaid mindmap fence as an SVG.
//
// `beautiful-mermaid` has no mindmap pipeline, so this block parses and draws the tree itself
// (see `mindmap-svg`). Everything around the drawing — the expand button, the sizing rules,
// the full-screen window, the fallback to source — is `DiagramBlock`, shared with mermaid.
// Rendering is synchronous so there is no flash, and colours are CSS variable references so
// the theme repaints without re-rendering.
// ============================================================================

interface MarkdownMindmapBlockProps {
  code: string
  className?: string
  /** Whether to show the inline expand button. Default true. */
  showExpandButton?: boolean
  /** Whether the block reads the mouse itself — see `InlineDiagram`. */
  interactive?: boolean
  /** Optional minimum block height to reserve space before responsive sizing settles. */
  minHeight?: number
}

export function MarkdownMindmapBlock({
  code,
  className,
  showExpandButton = true,
  interactive = true,
  minHeight,
}: MarkdownMindmapBlockProps) {
  const { t } = useTranslation()

  // A parse failure, or a map past the drawing limit, falls back to the source.
  const svg = React.useMemo(() => {
    try {
      return renderMindmapSVG(parseMindmapFence(code))
    } catch {
      return null
    }
  }, [code])

  return (
    <DiagramBlock
      svg={svg}
      code={code}
      className={className}
      showExpandButton={showExpandButton}
      interactive={interactive}
      minHeight={minHeight}
      language="mindmap"
      overlayTitle={t('overlay.mindmapDiagram')}
      activateLabel={t('common.viewFullscreen')}
    />
  )
}
