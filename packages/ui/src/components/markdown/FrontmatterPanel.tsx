/**
 * The properties a file carries above its body.
 *
 * A `SKILL.md` opens with YAML — a name, a description, a version — and that block is read by tools, not by people
 * reading the document. So it sits in a strip above the text rather than in it: always visible for the files that
 * have one, never in the way of the ones that do not, and never part of the document a save serializes (see
 * `editors/markdown-envelope.ts` for why it cannot be a block).
 *
 * Edits go straight to the file through the same path as typing: the pane rebuilds the envelope from what is typed
 * here and hands the whole file to the writer, which debounces it like any other change.
 */

import * as React from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { buildFrontmatterRaw, frontmatterInner } from '../editors/markdown-envelope'

export interface FrontmatterPanelProps {
  /** The raw block, both fences included; `''` when the file has none (then nothing is drawn). */
  frontmatter: string
  /** The new raw block, or `''` to take it off the file. */
  onChange: (frontmatter: string) => void
  readOnly?: boolean
  className?: string
}

export function FrontmatterPanel({ frontmatter, onChange, readOnly = false, className }: FrontmatterPanelProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(true)
  /**
   * Removal asks first.
   *
   * This used to be one unlabelled `✕` — the same glyph as closing the panel — with the *properties hint* as its
   * tooltip, which says the document editor never touches these. A person tidying the strip deleted the file's YAML
   * with one click, and the write followed a second later (`示例文档.md`, 2026-11-03: body byte-identical, header
   * gone). The glyph said "close"; the action said "delete file metadata". So: an icon that means delete, a tooltip
   * that says what it does, and a second click that confirms it.
   */
  const [confirmingRemove, setConfirmingRemove] = React.useState(false)
  const inner = React.useMemo(() => frontmatterInner(frontmatter), [frontmatter])

  /**
   * What is typed, uncommitted. The YAML is rebuilt into a fenced block only when it is written, so a trailing
   * newline the person is in the middle of typing does not turn into an empty line in the file.
   */
  const [value, setValue] = React.useState(inner)
  const edited = React.useRef(false)
  React.useEffect(() => {
    // Follow the file, unless this is the echo of what is being typed here.
    if (!edited.current) setValue(inner)
  }, [inner])

  if (!frontmatter) return null

  const commit = (next: string) => {
    setValue(next)
    edited.current = true
    onChange(buildFrontmatterRaw(next))
  }

  const lines = inner.split('\n').length

  return (
    <div className={cn('shrink-0 border-b border-border/60 bg-muted/25', className)}>
      <div className="flex items-center gap-1 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          className="flex items-center gap-1 rounded-[5px] px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={t('preview.frontmatterHint')}
        >
          {open ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
          {t('preview.frontmatter')}
          {!open && <span className="normal-case tracking-normal opacity-60">· {lines}</span>}
        </button>
        <div className="flex-1" />
        {!readOnly &&
          (confirmingRemove ? (
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">{t('preview.frontmatterRemoveConfirm')}</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingRemove(false)
                  edited.current = true
                  onChange('')
                }}
                className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {t('common.remove')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingRemove(false)}
                className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:text-destructive focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title={t('preview.frontmatterRemove')}
              aria-label={t('preview.frontmatterRemove')}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
            </button>
          ))}
      </div>
      {open && (
        <textarea
          value={value}
          spellCheck={false}
          readOnly={readOnly}
          onChange={(event) => commit(event.target.value)}
          rows={Math.min(Math.max(lines, 1), 8)}
          className={cn(
            'w-full resize-none bg-transparent px-3 pb-2 font-mono text-[12px] leading-[1.6] text-foreground/85',
            'outline-none placeholder:text-muted-foreground/50',
          )}
          placeholder="name: …"
          aria-label={t('preview.frontmatter')}
        />
      )}
    </div>
  )
}
