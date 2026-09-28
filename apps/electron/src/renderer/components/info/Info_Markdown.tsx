/**
 * Info_Markdown
 *
 * Markdown content with consistent styling and heading detection.
 * Auto-adjusts top padding based on whether content starts with a heading.
 * Supports optional fullscreen view using the shared DocumentFormattedMarkdownOverlay component.
 */

import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2 } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { DocumentFormattedMarkdownOverlay } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

export interface Info_MarkdownProps {
  /** Markdown content */
  children: string
  /** Optional max height with scroll */
  maxHeight?: number
  /** Markdown rendering mode */
  mode?: 'minimal' | 'full'
  className?: string
  /** Enable fullscreen button (shows Maximize2 icon on hover) */
  fullscreen?: boolean
  /**
   * The folder the document lives in, when the content *is* a file on disk — a picture
   * named beside it is resolved from there (`Markdown`'s `baseDir`). Omitted for content
   * that is not a file, where a relative destination has no folder to be relative to.
   */
  baseDir?: string
  /**
   * A link in the document, handed to the app rather than followed here — a file path opens in
   * whatever shows that kind of file, an address in the browser. Omitted where the content is not
   * something a reader can open (a skill's instructions, say), and then a link is just text.
   */
  onFileClick?: (path: string) => void
  onUrlClick?: (url: string) => void
}

export function Info_Markdown({
  children,
  maxHeight,
  mode = 'minimal',
  className,
  fullscreen = false,
  baseDir,
  onFileClick,
  onUrlClick,
}: Info_MarkdownProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Detect if content starts with H1-H3 heading
  const startsWithHeading = children.trimStart().match(/^#{1,3}\s/)

  return (
    <>
      <div
        className={cn(
          'px-6 pb-3 text-sm',
          maxHeight && 'overflow-y-auto',
          startsWithHeading ? 'pt-0' : 'pt-1',
          // Add relative + group for fullscreen button positioning
          fullscreen && 'relative group',
          className
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* Fullscreen button - visible on hover, positioned top-right */}
        {fullscreen && (
          <button
            onClick={() => setIsFullscreen(true)}
            className={cn(
              'absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10',
              'opacity-0 group-hover:opacity-100',
              'bg-background shadow-minimal',
              'text-muted-foreground/50 hover:text-foreground',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100'
            )}
            title={t("table.viewFullscreen")}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}

        <Markdown
          mode={mode}
          baseDir={baseDir}
          onFileClick={onFileClick}
          onUrlClick={onUrlClick}
        >
          {children}
        </Markdown>
      </div>

      {/* Fullscreen overlay - reuses shared component from packages/ui */}
      {fullscreen && (
        <DocumentFormattedMarkdownOverlay
          content={children}
          baseDir={baseDir}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          onOpenFile={onFileClick}
          onOpenUrl={onUrlClick}
        />
      )}
    </>
  )
}
