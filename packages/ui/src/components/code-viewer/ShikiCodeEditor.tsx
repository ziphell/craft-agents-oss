/**
 * ShikiCodeEditor - a small source editor: a textarea over highlighted markup.
 *
 * It exists for the case where a file is *edited as its own text* — the markdown document whose
 * source is what gets written back — as against a rich surface that renders while you type. The
 * highlighting is Shiki's, so the source of a document looks like the code blocks inside it.
 *
 * **Colouring is synchronous, and that is the point of everything below.** `codeToHtml` on its own
 * has to be awaited, and an editor that awaits its own colours paints the document twice for every
 * keystroke — plain first, coloured a frame later — which is text that flashes and drops its colours
 * while you type. A highlighter that has already been *made* colours synchronously, so one keystroke
 * is one paint, colours included. The making takes a few hundred milliseconds and happens when the
 * editor appears, before anyone has typed.
 *
 * The theme is the app's, resolved the way `CodeBlock` resolves it: the name the app publishes
 * (`useShikiTheme`) when there is one, and the DOM's `dark` class otherwise. Colours come from the
 * same CSS variables the rest of the app uses, so a dark-only theme is right even in the light mode
 * of the person's OS.
 *
 * Ported from the app's own renderer, where it was written for exactly this and never used.
 */

import * as React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import Editor from 'react-simple-code-editor'
import { createHighlighter } from 'shiki'
import { cn } from '../../lib/utils'
import { useShikiTheme } from '../../context/ShikiThemeContext'

export interface ShikiCodeEditorProps {
  /** The source. */
  value: string
  /** Language for syntax highlighting (default: 'markdown'). */
  language?: string
  /** Called with the whole source on every change. */
  onChange?: (value: string) => void
  /** Whether the source may be changed. */
  readOnly?: boolean
  /** Whether the textarea takes the caret when the editor appears. */
  autoFocus?: boolean
  className?: string
  placeholder?: string
}

// Map aliases to Shiki language names
const LANGUAGE_ALIASES: Record<string, string> = {
  'md': 'markdown',
  'js': 'javascript',
  'ts': 'typescript',
}

/**
 * What this editor may be asked to colour.
 *
 * Loaded eagerly when the highlighter is made, because colouring has to be ready before the first
 * keystroke rather than after it. A language outside this list is drawn as plain text.
 */
const HIGHLIGHT_LANGS = ['markdown', 'javascript', 'typescript', 'text']

/** Whether the DOM is in its dark presentation — the fallback when the app names no theme. */
function domIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

/** A highlighter that has been made, which is what makes colouring synchronous. */
interface ReadyHighlighter {
  /** The theme actually in use: the one asked for, or the fallback it resolved to. */
  theme: string
  html(code: string, lang: string): string
}

const madeHighlighters = new Map<string, Promise<ReadyHighlighter>>()

/**
 * Make (or hand back) a highlighter for a theme.
 *
 * A theme the app names but Shiki does not bundle falls back to the default pair for the mode
 * rather than taking the colours away entirely — measured: colouring with an unloaded theme throws
 * `ShikiError: Theme ... not found`.
 */
function highlighterFor(theme: string): Promise<ReadyHighlighter> {
  const existing = madeHighlighters.get(theme)
  if (existing) return existing

  const make = async (name: string): Promise<ReadyHighlighter> => {
    const highlighter = await createHighlighter({ themes: [name], langs: HIGHLIGHT_LANGS })
    return { theme: name, html: (code, lang) => highlighter.codeToHtml(code, { lang, theme: name }) }
  }

  const promise = make(theme).catch(() => make(domIsDark() ? 'github-dark' : 'github-light'))
  madeHighlighters.set(theme, promise)
  return promise
}

// Simple cache for highlighted code, so an unchanged document is not re-tokenized on every render.
const highlightCache = new Map<string, string>()
const CACHE_MAX_SIZE = 50

function getCacheKey(code: string, lang: string, theme: string): string {
  // Use hash for large content
  if (code.length > 500) {
    const hash = code.length.toString() + code.substring(0, 100) + code.substring(code.length - 100)
    return `${theme}:${lang}:${hash}`
  }
  return `${theme}:${lang}:${code}`
}

export function ShikiCodeEditor({
  value,
  language = 'markdown',
  onChange,
  readOnly = false,
  autoFocus = false,
  className,
  placeholder,
}: ShikiCodeEditorProps) {
  /** The app's name for the theme, or null to read the one the DOM is in. */
  const shikiTheme = useShikiTheme()
  const theme = shikiTheme ?? (domIsDark() ? 'github-dark' : 'github-light')

  const boxRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState<ReadyHighlighter | null>(null)

  const resolvedLang = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase()

  // Made as soon as the editor appears rather than on the first keystroke, so the wait is over
  // before there is any text to colour.
  useEffect(() => {
    let cancelled = false
    void highlighterFor(theme).then((highlighter) => {
      if (!cancelled) setReady(highlighter)
    })
    return () => {
      cancelled = true
    }
  }, [theme])

  /**
   * The markup for `code`, or null while the highlighter is still being made.
   *
   * Synchronous, and the answer itself is cached: the editor calls this during render (that is the
   * library's shape), so it does the tokenizing for a piece of text exactly once.
   */
  const highlight = useCallback(
    (code: string): string | null => {
      if (!code) return ''
      if (!ready) return null

      const lang = HIGHLIGHT_LANGS.includes(resolvedLang) ? resolvedLang : 'text'
      const cacheKey = getCacheKey(code, lang, ready.theme)
      const cached = highlightCache.get(cacheKey)
      if (cached !== undefined) return cached

      try {
        // Shiki returns <pre class="…" style="…"><code>…</code></pre>; what the editor wants is the
        // inside of that, because it draws the markup under a transparent textarea.
        const inner = ready.html(code, lang).match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/)?.[1]
        const content = inner ?? code

        if (highlightCache.size >= CACHE_MAX_SIZE) {
          const firstKey = highlightCache.keys().next().value
          if (typeof firstKey === 'string') highlightCache.delete(firstKey)
        }
        highlightCache.set(cacheKey, content)

        return content
      } catch (error) {
        console.warn(`Shiki highlighting failed:`, error)
        return code
      }
    },
    [ready, resolvedLang],
  )

  /**
   * What the highlighted layer draws.
   *
   * Before the highlighter exists — the first moment after the editor appears — this is the text
   * itself, unstyled: the characters under the caret are always the characters that were typed, and
   * a frame without colour at startup is not a frame with the wrong text in it.
   */
  const syncHighlight = useCallback((code: string): string => highlight(code) ?? code, [highlight])

  /** The caret, for a document that was opened to be typed in — once, and only into a writable one. */
  useEffect(() => {
    if (!autoFocus || readOnly) return
    boxRef.current?.querySelector('textarea')?.focus()
  }, [autoFocus, readOnly])

  const handleValueChange = useCallback((newValue: string) => {
    if (!readOnly && onChange) {
      onChange(newValue)
    }
  }, [readOnly, onChange])

  return (
    /* The surface: the file as text, on the app's background, with the corner the page and diagram
       editors' boxes have (`rounded-[12px]`).
       **It takes the room its parent gives it, and the parent has to give it a size** — `flex-1
       min-h-0` inside a flex column, which is what `MarkdownEditorPane` hands it: a box positioned
       absolutely, so its height is the pane's *used* height rather than a percentage of a parent
       whose own height is a minimum (`h-full`, which is what this once was, resolves to `auto`
       there — measured, as is the flexed variant: a 3000px source gave a 3000px editor and a
       scrolling window). `overflow-auto` is then what scrolls the source inside it, and what clips
       it to the rounded corner. */
    <div
      ref={boxRef}
      className={cn('flex-1 min-h-0 w-full overflow-auto rounded-[12px] bg-background', className)}
    >
      <Editor
        value={value}
        onValueChange={handleValueChange}
        highlight={syncHighlight}
        disabled={readOnly}
        padding={24}
        placeholder={placeholder}
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 14,
          lineHeight: 1.6,
          minHeight: '100%',
          color: 'var(--foreground)',
        }}
        textareaClassName={cn('focus:outline-none', readOnly && 'cursor-default')}
        className="min-h-full"
      />
      <style>{`
        .npm__react-simple-code-editor__textarea::placeholder {
          color: var(--muted-foreground);
        }
      `}</style>
    </div>
  )
}
