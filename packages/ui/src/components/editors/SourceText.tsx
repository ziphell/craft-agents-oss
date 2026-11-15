/**
 * A file as text — a `<textarea>` with colour behind it, and nothing else.
 *
 * This is the surface a file is *edited* in when the editor is not a document model: markdown's 源码 face, an
 * `.html` page's markup, and every other text file. It is deliberately not a code editor runtime: no
 * decorations, no widgets, no second copy of the document, no syntax tree anyone has to keep in step with the
 * text. What the textarea holds **is** the file, so nothing can be dropped on the way out — which is the one
 * property that matters for somebody's own file, and the reason CodeMirror was taken back out of this seat.
 *
 * The technique is the old one and it is not ours: `react-simple-code-editor` keeps a transparent textarea over
 * a highlighted `<pre>`, so the caret, the selection and every native editing gesture (undo, IME, drag, spell
 * check) are the browser's own, and the colour is a picture behind them that never has to agree with the text.
 * Shiki paints that picture, from the theme the app is already showing.
 *
 * Colour is the *only* thing the layer adds. Nothing here changes a line's size, hides a character, or draws a
 * block: a source view that styled its content would be a preview wearing a monospace font, and then the two
 * faces would lie about which one you are in.
 */

import * as React from 'react'
import Editor from 'react-simple-code-editor'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { cn } from '../../lib/utils'

export interface SourceTextProps {
  /** The file's text. The surface is controlled: every keystroke comes back through `onChange`. */
  value: string
  /**
   * What to colour it as — a shiki language id (`markdown`, `html`, `typescript`…), or a file name, whose
   * extension is used. Anything shiki does not know is shown as plain text rather than guessed at.
   */
  language?: string
  onChange?: (value: string) => void
  readOnly?: boolean
  className?: string
  placeholder?: string
  /** The caret goes in once, on the mount that opened the document to be typed in. */
  autoFocus?: boolean
  /**
   * The selection, as offsets into the text, on every change of it and `null` when it collapses.
   *
   * A caller that can *hand a selection to someone else* — the conversation, a comment — needs the offsets
   * rather than the words: it is what survives a sentence that occurs twice.
   */
  onSelectionChange?: (selection: { from: number; to: number } | null) => void
}

/** Extensions people write that shiki spells differently. The rest are passed through and checked. */
const LANGUAGE_ALIASES: Record<string, string> = {
  md: 'markdown',
  mdx: 'mdx',
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  obj: 'objc',
  htm: 'html',
  txt: 'text',
}

/** `notes.md` and `markdown` both resolve; anything else is `text`. */
export function resolveLanguage(language: string | undefined): string {
  if (!language) return 'text'
  const named = language.trim().toLowerCase()
  if (named in bundledLanguages) return named
  if (named in LANGUAGE_ALIASES) {
    const alias = LANGUAGE_ALIASES[named]!
    return alias in bundledLanguages ? alias : 'text'
  }
  // A file name: use its extension, once.
  const extension = named.includes('.') ? (named.split('.').pop() ?? '') : ''
  if (!extension) return 'text'
  const alias = LANGUAGE_ALIASES[extension] ?? extension
  return alias in bundledLanguages ? alias : 'text'
}

/**
 * Is the app showing its dark theme right now?
 *
 * Shiki paints in JS and needs a theme name, so this reads the one signal the app already publishes —
 * `color-scheme` on the root, which the stylesheet sets with the tokens — and follows it when the theme is
 * switched. Reading the OS preference instead would be wrong: the app's theme is its own setting.
 */
function useDarkScheme(): boolean {
  const read = (): boolean => {
    if (typeof document === 'undefined') return false
    const root = document.documentElement
    if (root.classList.contains('dark') || root.dataset.theme === 'dark') return true
    return getComputedStyle(root).colorScheme.includes('dark')
  }
  const [dark, setDark] = React.useState(read)
  React.useEffect(() => {
    const update = () => setDark(read())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener?.('change', update)
    }
  }, [])
  return dark
}

/** Highlighted HTML is pure and expensive; the same text on two faces should not be painted twice. */
const highlighted = new Map<string, string>()
const CACHE_MAX = 40

const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' } as const

/**
 * Paint `code`, and answer with the markup **inside** shiki's `<pre><code>` — the editor supplies its own
 * element, so shiki's wrapper (and its background) would be a second box on top of the textarea's.
 */
async function paint(code: string, language: string, theme: string): Promise<string> {
  if (!code) return ''
  const key = `${theme}:${language}:${code.length}:${code}`
  const cached = highlighted.get(key)
  if (cached !== undefined) return cached
  try {
    const html = await codeToHtml(code, {
      lang: (language in bundledLanguages ? language : 'text') as BundledLanguage,
      theme,
    })
    const inner = html.match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/)
    const content = inner ? inner[1]! : escapeHtml(code)
    if (highlighted.size >= CACHE_MAX) {
      const oldest = highlighted.keys().next().value
      if (oldest !== undefined) highlighted.delete(oldest)
    }
    highlighted.set(key, content)
    return content
  } catch (error) {
    console.warn('[SourceText] highlighting failed, showing plain text:', error)
    return escapeHtml(code)
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function SourceText({
  value,
  language,
  onChange,
  readOnly = false,
  className,
  placeholder,
  autoFocus = false,
  onSelectionChange,
}: SourceTextProps) {
  const dark = useDarkScheme()
  const theme = dark ? SHIKI_THEMES.dark : SHIKI_THEMES.light
  const lang = resolveLanguage(language)

  /** What the layer currently shows. Until the first paint lands the editor shows the plain text. */
  const [painted, setPainted] = React.useState(() => highlighted.get(`${theme}:${lang}:${value.length}:${value}`) ?? '')

  React.useEffect(() => {
    let cancelled = false
    void paint(value, lang, theme).then((html) => {
      if (!cancelled) setPainted(html)
    })
    return () => {
      cancelled = true
    }
  }, [value, lang, theme])

  /**
   * `react-simple-code-editor` highlights synchronously, so it is handed the last paint it can have and the
   * new one arrives a tick later through `painted`. Typing is never blocked on a highlighter.
   */
  const highlight = React.useCallback((code: string): string => {
    const cached = highlighted.get(`${theme}:${lang}:${code.length}:${code}`)
    if (cached !== undefined) return cached
    void paint(code, lang, theme).then((html) => setPainted((current) => (html === current ? current : html)))
    return painted || escapeHtml(code)
  }, [lang, theme, painted])

  /** The element `react-simple-code-editor` renders; it exposes no ref of its own, so the textarea is
   *  found through the box it is in. */
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const areaOf = React.useCallback((): HTMLTextAreaElement | null => boxRef.current?.querySelector('textarea') ?? null, [])

  React.useEffect(() => {
    if (!onSelectionChange) return
    const textarea = areaOf()
    if (!textarea) return
    const report = () => {
      const { selectionStart, selectionEnd } = textarea
      onSelectionChange(selectionStart === selectionEnd ? null : { from: selectionStart, to: selectionEnd })
    }
    const events = ['select', 'keyup', 'mouseup', 'focus', 'blur'] as const
    for (const event of events) textarea.addEventListener(event, report)
    return () => {
      for (const event of events) textarea.removeEventListener(event, report)
    }
  }, [onSelectionChange, areaOf])

  React.useEffect(() => {
    if (autoFocus && !readOnly) areaOf()?.focus()
  }, [autoFocus, readOnly, areaOf])

  return (
    <div ref={boxRef} className={cn('h-full w-full overflow-auto', className)}>
      <Editor
        value={value}
        onValueChange={(next) => onChange?.(next)}
        highlight={highlight}
        disabled={readOnly}
        padding={0}
        placeholder={placeholder}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          lineHeight: 1.6,
          minHeight: '100%',
          backgroundColor: 'transparent',
          color: 'var(--foreground)',
        }}
        className="min-h-full"
        textareaClassName={cn('focus:outline-none', readOnly && 'cursor-default')}
      />
      <style>{`
        .npm__react-simple-code-editor__textarea::placeholder { color: var(--muted-foreground); }
        .npm__react-simple-code-editor__textarea { caret-color: var(--foreground); }
      `}</style>
    </div>
  )
}
