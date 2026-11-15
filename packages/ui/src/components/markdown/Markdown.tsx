import * as React from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cn } from '../../lib/utils'
import { CodeBlock, InlineCode } from './CodeBlock'
import { MarkdownImage } from './MarkdownImage'
import { fenceBlockType, fenceDrawing } from './fences'
import { renderFence } from './fence-components'
import { preprocessLinks } from './linkify'
import { resolveMarkdownLinkTarget } from './link-target'
import { resolveDocumentPath } from './document-path'
import remarkCollapsibleSections from './remarkCollapsibleSections'
import remarkCallouts from './remarkCallouts'
import { calloutName } from './callouts'
import { tableCellAlignOf, tableCellAlignStyle } from './extensions/TableAlignment'
import { CollapsibleSection } from './CollapsibleSection'
import { useCollapsibleMarkdown } from './CollapsibleMarkdownContext'
import { wrapWithSafeProxy } from './safe-components'
import { MARKDOWN_MATH_OPTIONS } from './math-options'
import { markdownUrlTransform } from './url-transform'

/**
 * Names of preview-block code-fence types that recursive `Markdown` callers
 * may want to suppress. Used by `MarkdownDocBlock` to prevent
 * `markdown-preview` self-recursion while leaving other preview blocks
 * (mermaid, datatable, …) intact.
 */
export type DisablablePreviewBlock =
  | 'markdown-preview'
  | 'html-preview'
  | 'office-preview'
  | 'pdf-preview'
  | 'image-preview'
  | 'drawio-preview'

/** The names above, as the set the fence dispatch tests. */
const DISABLABLE_PREVIEW_BLOCKS = new Set<DisablablePreviewBlock>([
  'markdown-preview',
  'html-preview',
  'office-preview',
  'pdf-preview',
  'image-preview',
  'drawio-preview',
])

/**
 * Render modes for markdown content — two, and both are implemented:
 *
 * - 'terminal': raw output with minimal formatting, for debug output and logs
 * - 'minimal': clean rendering with syntax highlighting, for chat messages and documents (the default)
 *
 * There used to be a third, `'full'`, declared in this type and never written: it type-checked, and what a caller got
 * for it was whatever fell through the last `return` — a component map with no classes at all. A document opened to be
 * read is `minimal` (its `mode` says so in `MarkdownEditorPane`), and the editing face matches that by hand
 * (`.tiptap-prose` in `tiptap-editor.css`, held to it by `__tests__/tiptap-typography.test.ts`).
 */
export type RenderMode = 'terminal' | 'minimal'

export interface MarkdownProps {
  children: string
  /**
   * Render mode controlling formatting level
   * @default 'minimal'
   */
  mode?: RenderMode
  className?: string
  /**
   * Message ID for memoization (optional)
   * When provided, memoizes parsed blocks to avoid re-parsing during streaming
   */
  id?: string
  /**
   * Callback when a URL is clicked
   */
  onUrlClick?: (url: string) => void
  /**
   * Callback when a file path is clicked
   */
  onFileClick?: (path: string) => void
  /**
   * Enable collapsible headings
   * Requires wrapping in CollapsibleMarkdownProvider
   * @default false
   */
  collapsible?: boolean
  /**
   * Hide expand button on first mermaid block (when message starts with mermaid)
   * Used in chat to avoid overlap with TurnCard's fullscreen button
   * @default true
   */
  hideFirstMermaidExpand?: boolean
  /**
   * The folder the document being rendered lives in, when it is a file on disk.
   *
   * A picture named beside the document (`![](shots/cart.png)`) is resolved against it —
   * see `MarkdownImage`. Omitted for content that is not a file (a message in a
   * conversation), where a relative destination has no folder to be relative to and is
   * left as it was.
   */
  baseDir?: string
  /**
   * Disable specific preview-block handlers for nested rendering.
   *
   * When a preview-block component renders user-supplied markdown through
   * `Markdown` again (e.g. `MarkdownDocBlock`), it can pass the names of the
   * preview-block types it wants to suppress to prevent infinite recursion.
   * Suppressed blocks fall through to the default `CodeBlock` renderer.
   *
   * Default behavior (prop omitted): all preview blocks are registered.
   */
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>
}

/**
 * How each callout type looks — the type's own name, in its own colour.
 *
 * A colour and a word, no icon set: the word is what GitHub and Obsidian both show above the text,
 * and it is what a person recognises. An unknown type keeps its own name in the neutral colour rather
 * than being dropped — a document from another tool still reads as the callout it says it is.
 */
/**
 * How each type is painted. The *names* live in `callouts.ts`, because the editing face draws the same label (its
 * callout is a blockquote attribute, so there is no React component to hold a table like this one).
 */
const CALLOUT_STYLES: Record<string, { label: string; box: string }> = {
  note: { label: 'text-accent', box: 'border-accent/60 bg-accent/5' },
  info: { label: 'text-accent', box: 'border-accent/60 bg-accent/5' },
  tip: { label: 'text-[var(--success-text)]', box: 'border-success/60 bg-success/5' },
  success: { label: 'text-[var(--success-text)]', box: 'border-success/60 bg-success/5' },
  important: { label: 'text-[var(--info-text)]', box: 'border-info/60 bg-info/5' },
  question: { label: 'text-[var(--info-text)]', box: 'border-info/60 bg-info/5' },
  example: { label: 'text-[var(--info-text)]', box: 'border-info/60 bg-info/5' },
  warning: { label: 'text-[var(--info-text)]', box: 'border-info/70 bg-info/10' },
  caution: { label: 'text-[var(--destructive-text)]', box: 'border-destructive/60 bg-destructive/5' },
  danger: { label: 'text-[var(--destructive-text)]', box: 'border-destructive/60 bg-destructive/5' },
  failure: { label: 'text-[var(--destructive-text)]', box: 'border-destructive/60 bg-destructive/5' },
  bug: { label: 'text-[var(--destructive-text)]', box: 'border-destructive/60 bg-destructive/5' },
  todo: { label: 'text-muted-foreground', box: 'border-foreground/30 bg-foreground-5' },
  quote: { label: 'text-muted-foreground', box: 'border-foreground/30 bg-foreground-5' },
}

/**
 * The callout a blockquote says it is, if it says anything.
 *
 * Two keys, because the same property has two spellings depending on what ran: `rehype-raw`
 * normalises `data-*` attributes into camel case (`dataCallout`), and a pipeline without it leaves
 * the hyphens alone. Reading both means the callout does not depend on which plugins happen to be
 * in front of it — a lesson paid for by a document that rendered a callout in one place and a plain
 * quote in another.
 */
function calloutType(node: unknown): string | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties
  const callout = properties?.['data-callout'] ?? properties?.['dataCallout']
  return typeof callout === 'string' && callout.length > 0 ? callout : null
}

/**
 * A blockquote that named its type — the same rendering in every mode.
 *
 * The modes differ in how carefully they set prose (a message is `minimal`, a document opened to be
 * read is not), but a callout is a *thing*, not a setting: it gets its colour and its name either
 * way, or a document would mean something different in two places.
 */
function CalloutBlockquote({ type, children }: { type: string; children: React.ReactNode }) {
  const style = CALLOUT_STYLES[type] ?? {
    label: 'text-muted-foreground',
    box: 'border-foreground/30 bg-foreground-5',
  }

  return (
    <blockquote
      data-callout={type}
      className={cn('border-l-4 pl-4 pr-3 py-2 my-3 rounded-r-md not-italic', style.box)}
    >
      <div className={cn('mb-1 text-[11px] font-semibold uppercase tracking-wide', style.label)}>
        {calloutName(type)}
      </div>
      {children}
    </blockquote>
  )
}

/** Context for collapsible sections */
interface CollapsibleContext {
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
}

/**
 * Create custom components based on render mode.
 *
 * @param firstMermaidCodeRef - Ref holding the code of the first mermaid block
 *   when the markdown message starts with a mermaid fence. Used to hide the
 *   inline expand button on that block (TurnCard's own fullscreen button
 *   occupies the same top-right position). A ref is used so the closure can
 *   read the latest value without adding content to the memo deps — that would
 *   cause component re-mounting on every streaming update.
 * @param hideFirstMermaidExpand - Whether to hide the expand button on the first
 *   mermaid block when the message starts with a mermaid fence. Defaults to true.
 * @param baseDir - The folder the document lives in, used to resolve a picture named
 *   beside it. Absent for content that is not a file.
 */
function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function createComponents(
  mode: RenderMode,
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void,
  collapsibleContext?: CollapsibleContext | null,
  firstMermaidCodeRef?: React.RefObject<string | null>,
  hideFirstMermaidExpand: boolean = true,
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>,
  baseDir?: string,
): Partial<Components> {
  const isPreviewEnabled = (name: DisablablePreviewBlock) => !disablePreviewBlocks?.has(name)
  let blockIndex = 0
  const wrapBlock = (
    blockType: string,
    content: string,
    child: React.ReactNode,
    nodePosition?: { start?: { line?: number }; end?: { line?: number } },
  ) => {
    blockIndex += 1
    const startLine = nodePosition?.start?.line
    const endLine = nodePosition?.end?.line
    const path = startLine && endLine
      ? `line:${startLine}-${endLine}`
      : `idx:${blockIndex}`
    const blockId = `blk-${stableHash(`${blockType}|${path}|${content.slice(0, 240)}`)}`

    return (
      <div
        data-ca-block-type={blockType}
        data-ca-block-path={path}
        data-ca-block-id={blockId}
      >
        {child}
      </div>
    )
  }

  /**
   * The block a fence draws, or null when it is a code block.
   *
   * The one place the renderer decides "is this fence somebody else's block, and may it be drawn".
   * Which fence draws what, and how each is called, is `fences` and `fence-components` — so both
   * render modes and the editor's in-place blocks answer the same question the same way, and a
   * fence added to the table is drawn here without another `if`.
   */
  const fenceBlock = (lang: string | undefined, code: string) => {
    const drawing = fenceDrawing(lang ?? '')
    if (!drawing) return null

    // A document may name another document, and drawing that one inside this one has no floor:
    // the fence falls through to a code block instead.
    if (DISABLABLE_PREVIEW_BLOCKS.has(drawing as DisablablePreviewBlock) && !isPreviewEnabled(drawing as DisablablePreviewBlock)) {
      return null
    }

    // Mermaid hides its own expand button when it is the first content of a message — the turn's
    // fullscreen button occupies the same top-right spot. Detection uses firstMermaidCodeRef
    // (content match) rather than AST line positions, which are unreliable after `preprocessLinks`.
    const isFirstMermaidBlock =
      drawing === 'mermaid' &&
      hideFirstMermaidExpand &&
      firstMermaidCodeRef?.current != null &&
      code === firstMermaidCodeRef.current

    const node = renderFence(drawing, code, 'my-2', {
      onUrlClick,
      onFileClick,
      showExpandButton: !isFirstMermaidBlock,
    })

    return node ? { drawing, node } : null
  }

  const baseComponents: Partial<Components> = {
    // Section wrapper for collapsible headings
    div: ({ node, children, ...props }) => {
      const sectionId = (props as Record<string, unknown>)['data-section-id'] as string | undefined
      const headingLevel = (props as Record<string, unknown>)['data-heading-level'] as number | undefined

      // If this is a collapsible section div and we have context
      if (sectionId && headingLevel && collapsibleContext) {
        return (
          <CollapsibleSection
            sectionId={sectionId}
            headingLevel={headingLevel}
            isCollapsed={collapsibleContext.collapsedSections.has(sectionId)}
            onToggle={collapsibleContext.toggleSection}
          >
            {children}
          </CollapsibleSection>
        )
      }

      // Regular div
      return <div {...props}>{children}</div>
    },
    // Links: Make clickable with callbacks.
    //
    // We sanitize the DOM `href` separately from the click-dispatch target:
    // - `safeHref` is what React puts on the `<a>` element. We pass `href`
    //   through `defaultUrlTransform`; any dangerous scheme
    //   (javascript:/data:/vbscript:/file:) is stripped to empty, in which case
    //   we omit the attribute entirely. That blocks middle-click and
    //   cmd-click escape routes (Electron's `setWindowOpenHandler` /
    //   `will-navigate` would otherwise bypass our React `onClick` and call
    //   `shell.openExternal` directly).
    // - The click handler still receives the ORIGINAL `href` and routes it
    //   through `resolveMarkdownLinkTarget` so file URLs land in `onFileClick`
    //   and blocked URLs surface a meaningful error via `onUrlClick` →
    //   `classifyExternalUrl`.
    a: ({ href, children }) => {
      const trimmedHref = href?.trim() ?? ''
      const sanitized = trimmedHref ? defaultUrlTransform(trimmedHref) : ''
      const safeHref = sanitized ? sanitized : undefined

      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault()

        // Some AI outputs include raw HTML anchors with empty href but path text content.
        // Fallback to the anchor text when href is missing/empty.
        const fallbackText = React.Children.toArray(children)
          .map((child) => (typeof child === 'string' ? child : ''))
          .join('')
          .trim()

        const target = trimmedHref || fallbackText
        if (!target) return

        const resolvedTarget = resolveMarkdownLinkTarget(target)
        if (resolvedTarget.kind === 'file' && onFileClick) {
          // A file named beside the document is relative to *that* document, not to the app — the
          // rule a picture already follows (`document-path.ts`). An absolute path or a `file:` URL
          // comes back null and is opened exactly as written.
          onFileClick(resolveDocumentPath(baseDir, resolvedTarget.path) ?? resolvedTarget.path)
        } else if (resolvedTarget.kind === 'url' && onUrlClick) {
          onUrlClick(resolvedTarget.url)
        }
      }

      return (
        <a
          href={safeHref}
          onClick={handleClick}
          className="text-accent hover:underline cursor-pointer"
        >
          {children}
        </a>
      )
    },
    // Pictures: a destination that names a file beside the document is read and shown
    // (`MarkdownImage`); everything else is the plain `<img>` it always was.
    img: (props) => <MarkdownImage baseDir={baseDir} {...props} />,
  }

  // Terminal mode: minimal formatting
  if (mode === 'terminal') {
    return {
      ...baseComponents,
      // No special code handling - just monospace
      code: ({ children }) => (
        <code className="font-mono">{children}</code>
      ),
      pre: ({ children }) => (
        <pre className="font-mono whitespace-pre-wrap my-2">{children}</pre>
      ),
      // Minimal paragraph spacing
      p: ({ children }) => <p className="my-1">{children}</p>,
      // Simple lists
      ul: ({ children }) => <ul className="list-disc list-inside my-1">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal list-inside my-1">{children}</ol>,
      li: ({ children }) => <li className="my-0.5">{children}</li>,
      // Plain tables
      table: ({ children }) => (
        <table className="my-2 font-mono text-sm">{children}</table>
      ),
      th: ({ children }) => <th className="text-left pr-4">{children}</th>,
      td: ({ children }) => <td className="pr-4">{children}</td>,
    }
  }

  // The reading style — what a conversation and an open document are both drawn with.
  return {
      ...baseComponents,
      // Inline code
      code: ({ className, children, ...props }) => {
        const match = /language-([\w-]+)/.exec(className || '')
        const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

        // Block code
        if (match || isBlock) {
          const code = String(children).replace(/\n$/, '')
          const fence = fenceBlock(match?.[1], code)
          if (fence) {
            return wrapBlock(fenceBlockType(fence.drawing), code, fence.node, props.node?.position)
          }
          return wrapBlock('code', code, <CodeBlock code={code} language={match?.[1]} mode="full" className="my-2" />, props.node?.position)
        }

        // Inline code
        return <InlineCode>{children}</InlineCode>
      },
      pre: ({ children }) => <>{children}</>,
      // Comfortable paragraph spacing
      p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
      // Styled lists - ul uses tighter spacing, ol uses standard for number alignment
      ul: ({ children, className }) => (
        <ul
          className={cn(
            'my-2 space-y-1 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
            className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
          )}
        >
          {children}
        </ul>
      ),
      ol: ({ children, className }) => (
        <ol className={cn('my-2 space-y-1 pl-6 list-decimal', className)}>{children}</ol>
      ),
      li: ({ children, className }) => (
        <li className={cn(className?.includes('task-list-item') && 'list-none')}>{children}</li>
      ),
      input: ({ type, checked }) => {
        if (type === 'checkbox') {
          return (
            <input
              type="checkbox"
              checked={checked}
              readOnly
              className="mr-2 rounded border-muted-foreground align-middle"
            />
          )
        }
        return <input type={type} />
      },
      // Clean tables
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table className="min-w-full text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="border-b">{children}</thead>,
      // `align` comes from GFM's delimiter row (`|:--|:-:|--:|`) and reaches these components as a property of the
      // hast element. It used to be dropped here, so a table showed its alignment in the file and nowhere on screen.
      th: ({ children, node }) => (
        <th style={tableCellAlignStyle(tableCellAlignOf(node))} className="text-left py-2 px-3 font-semibold text-muted-foreground">
          {children}
        </th>
      ),
      td: ({ children, node }) => (
        <td style={tableCellAlignStyle(tableCellAlignOf(node))} className="py-2 px-3 border-b border-border/50">
          {children}
        </td>
      ),
      // Headings - H1/H2 same size, differentiated by weight
      h1: ({ children }) => <h1 className="font-sans text-[16px] font-bold mt-5 mb-3">{children}</h1>,
      h2: ({ children }) => <h2 className="font-sans text-[16px] font-semibold mt-4 mb-3">{children}</h2>,
      h3: ({ children }) => <h3 className="font-sans text-[15px] font-semibold mt-4 mb-2">{children}</h3>,
      // Blockquotes
      blockquote: ({ children, node }) => {
        const callout = calloutType(node)
        if (callout) return <CalloutBlockquote type={callout}>{children}</CalloutBlockquote>
        return (
          <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
            {children}
          </blockquote>
        )
      },
      // Horizontal rules
      hr: () => <hr className="my-4 border-border" />,
      // Strong/emphasis
      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
    }
}

/**
 * Markdown - Customizable markdown renderer with multiple render modes
 *
 * Features:
 * - Three render modes: terminal, minimal, full
 * - Syntax highlighting via Shiki
 * - GFM support (tables, task lists, strikethrough)
 * - Clickable links and file paths
 * - Memoization for streaming performance
 */
export function Markdown({
  children,
  mode = 'minimal',
  className,
  id,
  onUrlClick,
  onFileClick,
  collapsible = false,
  hideFirstMermaidExpand = true,
  baseDir,
  disablePreviewBlocks,
}: MarkdownProps) {
  // Get collapsible context if enabled
  const collapsibleContext = useCollapsibleMarkdown()

  // Extract the first mermaid code block's content when the message starts
  // with a mermaid fence. Stored in a ref so createComponents can read it
  // without adding `children` to the memo deps (which would remount all
  // components on every streaming update, breaking internal state).
  const firstMermaidCodeRef = React.useRef<string | null>(null)
  const trimmed = children.trimStart()
  if (trimmed.startsWith('```mermaid')) {
    const m = trimmed.match(/^```mermaid\n([\s\S]*?)```/)
    firstMermaidCodeRef.current = m?.[1] ? m[1].replace(/\n$/, '') : null
  } else {
    firstMermaidCodeRef.current = null
  }

  const components = React.useMemo(
    () => wrapWithSafeProxy(createComponents(mode, onUrlClick, onFileClick, collapsible ? collapsibleContext : null, firstMermaidCodeRef, hideFirstMermaidExpand, disablePreviewBlocks, baseDir)),
    [mode, onUrlClick, onFileClick, collapsible, collapsibleContext, hideFirstMermaidExpand, disablePreviewBlocks, baseDir]
  )

  // Preprocess to convert raw URLs and file paths to markdown links
  const processedContent = React.useMemo(
    () => preprocessLinks(children),
    [children]
  )

  // Conditionally include the collapsible sections plugin.
  // IMPORTANT: Disable single-dollar inline math so currency like $2M–$4M
  // stays plain text. Math should use $$...$$ delimiters.
  const remarkPlugins = React.useMemo(
    () => {
      const mathPlugin: [typeof remarkMath, typeof MARKDOWN_MATH_OPTIONS] = [
        remarkMath,
        MARKDOWN_MATH_OPTIONS
      ]
      return collapsible
        ? [remarkGfm, mathPlugin, remarkCallouts, remarkCollapsibleSections]
        : [remarkGfm, mathPlugin, remarkCallouts]
    },
    [collapsible]
  )

  return (
    <div className={cn('markdown-content', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex, rehypeRaw]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
}

/**
 * MemoizedMarkdown - Optimized for streaming scenarios
 *
 * Splits content into blocks and memoizes each block separately,
 * so only new/changed blocks re-render during streaming.
 */
export const MemoizedMarkdown = React.memo(
  Markdown,
  (prevProps, nextProps) => {
    // If id is provided, use it for memoization
    if (prevProps.id && nextProps.id) {
      return (
        prevProps.id === nextProps.id &&
        prevProps.children === nextProps.children &&
        prevProps.mode === nextProps.mode &&
        prevProps.baseDir === nextProps.baseDir &&
        prevProps.disablePreviewBlocks === nextProps.disablePreviewBlocks
      )
    }
    // Otherwise compare content and mode
    return (
      prevProps.children === nextProps.children &&
      prevProps.mode === nextProps.mode &&
      prevProps.baseDir === nextProps.baseDir &&
      prevProps.disablePreviewBlocks === nextProps.disablePreviewBlocks
    )
  }
)
MemoizedMarkdown.displayName = 'MemoizedMarkdown'

// Re-export for convenience
export { CodeBlock, InlineCode } from './CodeBlock'
export { CollapsibleMarkdownProvider } from './CollapsibleMarkdownContext'
