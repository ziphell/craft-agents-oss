import * as React from 'react'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { Maximize2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { InlineDiagram, svgSize } from './InlineDiagram'
import { MermaidPreviewOverlay } from '../overlay/MermaidPreviewOverlay'
import { normalizeMermaidSource } from './mermaid-source'
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
// click opening the full-size window — is `InlineDiagram`, which every diagram
// in a conversation goes through, this one and drawio's alike.
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

export function MarkdownMermaidBlock({ code, className, showExpandButton = true, interactive = true, minHeight }: MarkdownMermaidBlockProps) {
  const { t } = useTranslation()
  // Render synchronously — no flash between CodeBlock and SVG.
  // Colors are CSS variable references so the SVG inherits from the app's theme
  // via CSS cascade. Theme switches apply automatically without re-rendering.
  const { svg, error } = React.useMemo(() => {
    try {
      return {
        svg: renderMermaidSVG(normalizeMermaidSource(code), {
          bg: 'var(--background)',
          fg: 'var(--foreground)',
          accent: 'var(--accent)',
          line: 'var(--foreground-30)',
          muted: 'var(--muted-foreground)',
          surface: 'var(--foreground-3)',
          border: 'var(--foreground-20)',
          transparent: true,
          interactive: true,
        }),
        error: null,
      }
    } catch (err) {
      return { svg: null, error: err instanceof Error ? err : new Error(String(err)) }
    }
  }, [code])

  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const size = React.useMemo(() => (svg ? svgSize(svg) : null), [svg])
  const minHeightStyle = minHeight != null ? { minHeight: `${minHeight}px` } : undefined

  // On error, fall back to a plain code block showing the mermaid source
  if (error || !svg) {
    return <CodeBlock code={code} language="mermaid" mode="full" className={className} />
  }

  return (
    <>
      {/* Wrapper with group class so the expand button shows on hover */}
      <div className={cn('relative group', className)} style={minHeightStyle}>
        {/* Expand button — matches code block expand button style (TurnCard pattern).
            Hidden when showExpandButton is false (first block in message, where
            TurnCard's own fullscreen button occupies the same top-right position). */}
        {showExpandButton && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              "absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none",
              "opacity-0 group-hover:opacity-100",
              "bg-background shadow-minimal",
              "text-muted-foreground/50 hover:text-foreground",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
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
          activateLabel="Open Mermaid diagram fullscreen"
        />
      </div>

      {/* Fullscreen overlay with zoom/pan */}
      <MermaidPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        svg={svg}
        code={code}
      />
    </>
  )
}
