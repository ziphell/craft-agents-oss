import * as React from 'react'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { normalizeMermaidSource } from './mermaid-source'
import { isMindmapSource } from '@craft-agent/core/mermaid/mindmap'
import { MarkdownMindmapBlock } from './MarkdownMindmapBlock'
import { DiagramBlock } from './DiagramBlock'
import { useTranslation } from 'react-i18next'

// ============================================================================
// MarkdownMermaidBlock — renders mermaid code fences as SVG diagrams.
//
// Uses beautiful-mermaid to parse flowchart text and produce an SVG string.
// Falls back to a plain code block if rendering fails (invalid syntax, etc).
//
// Theming: Colors are passed as CSS variable references (var(--background),
// var(--foreground), etc.) so the SVG inherits from the app's theme system
// via CSS cascade. Theme switches (light/dark, preset changes) apply
// automatically without re-rendering — the browser resolves the variables.
//
// How it is shown — as big as it was drawn, in a box that scrolls, with a
// click opening the full-size window — is `DiagramBlock`, the frame both
// mermaid and mindmap are drawn in.
// ============================================================================

interface MarkdownMermaidBlockProps {
  code: string
  className?: string
  /** Whether to show the inline expand button. Default true.
   *  Set to false when the mermaid block is the first block in a message,
   *  where the TurnCard's own fullscreen button already occupies the same position. */
  showExpandButton?: boolean
  /** Whether the block reads the mouse itself — see `InlineDiagram`. */
  interactive?: boolean
  /** Optional minimum block height to reserve space before responsive sizing settles. */
  minHeight?: number
}

/**
 * The block a `mermaid` fence is drawn with — except when its header says `mindmap`.
 *
 * Mermaid accepts a mindmap under the `mermaid` header, and that is the form people (and agents)
 * write; `beautiful-mermaid` cannot read it, but the app can, so the fence falls through to the
 * mindmap block instead of becoming a code block. The `mindmap` fence is the same drawing under
 * a name of its own — see `fences`.
 */
export function MarkdownMermaidBlock(props: MarkdownMermaidBlockProps) {
  if (isMindmapSource(normalizeMermaidSource(props.code))) {
    return <MarkdownMindmapBlock {...props} />
  }
  return <MermaidDiagramBlock {...props} />
}

function MermaidDiagramBlock({
  code,
  className,
  showExpandButton = true,
  interactive = true,
  minHeight,
}: MarkdownMermaidBlockProps) {
  const { t } = useTranslation()

  // Render synchronously — no flash between CodeBlock and SVG.
  // Colors are CSS variable references so the SVG inherits from the app's theme
  // via CSS cascade. Theme switches apply automatically without re-rendering.
  const svg = React.useMemo(() => {
    try {
      return renderMermaidSVG(normalizeMermaidSource(code), {
        bg: 'var(--background)',
        fg: 'var(--foreground)',
        accent: 'var(--accent)',
        line: 'var(--foreground-30)',
        muted: 'var(--muted-foreground)',
        surface: 'var(--foreground-3)',
        border: 'var(--foreground-20)',
        transparent: true,
        interactive: true,
      })
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
      overlayTitle={t('overlay.mermaidDiagram')}
      activateLabel={t('common.viewFullscreen')}
    />
  )
}
