/**
 * A picture's local actions: read its words, or write a changed copy.
 *
 * Both are the same two things everywhere the library shows a picture — the grid's detail column
 * and the card's own toolbar — so they are one component, sized to its host. Nothing here talks to
 * a model: OCR is the bundled engine, and an edit is the browser's own canvas arithmetic
 * (`lib/image-edit`). Each result becomes a new asset; the picture being read is never written over.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Loader2,
  RotateCcw,
  RotateCw,
  ScanText,
  Scaling,
  SlidersHorizontal,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CROP_RATIOS, type ImageEditSpec } from '@/lib/image-edit'
import { cn } from '@/lib/utils'

export interface ImageToolsProps {
  /** This picture is having its words read right now. */
  reading: boolean
  /** This picture is being edited right now. */
  editing: boolean
  /** Another picture (or a recording) is being worked on; every door is closed. */
  disabled: boolean
  /** The card's toolbar is shorter than the detail column's. */
  compact?: boolean
  onOcr: () => void
  onEdit: (spec: ImageEditSpec) => void
}

export function ImageTools({
  reading,
  editing,
  disabled,
  compact = false,
  onOcr,
  onEdit,
}: ImageToolsProps) {
  const { t } = useTranslation()
  const buttonClass = cn(
    'inline-flex items-center gap-1 rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
    compact ? 'h-6 px-1.5 text-[10px]' : 'h-7 px-2 text-[11px]',
  )

  const item = (label: string, icon: React.ReactNode, spec: ImageEditSpec) => (
    <DropdownMenuItem key={label} className="gap-2 text-xs" onSelect={() => onEdit(spec)}>
      {icon}
      {label}
    </DropdownMenuItem>
  )

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={t('library.readText')}
        onClick={onOcr}
        className={buttonClass}
      >
        {reading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ScanText className="h-3.5 w-3.5" />
        )}
        {reading ? t('library.readingText') : t('library.readText')}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={disabled} title={t('library.editImage')} className={buttonClass}>
            {editing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SlidersHorizontal className="h-3.5 w-3.5" />
            )}
            {t('library.editImage')}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {item(
            t('library.rotateLeft'),
            <RotateCcw className="h-3.5 w-3.5" />,
            { op: 'rotate', params: { angle: 270 } },
          )}
          {item(
            t('library.rotateRight'),
            <RotateCw className="h-3.5 w-3.5" />,
            { op: 'rotate', params: { angle: 90 } },
          )}
          {item(
            t('library.flipHorizontal'),
            <FlipHorizontal2 className="h-3.5 w-3.5" />,
            { op: 'flip', params: { axis: 'horizontal' } },
          )}
          {item(
            t('library.flipVertical'),
            <FlipVertical2 className="h-3.5 w-3.5" />,
            { op: 'flip', params: { axis: 'vertical' } },
          )}
          <DropdownMenuSeparator />
          {CROP_RATIOS.map((ratio) =>
            item(
              `${t('library.crop')} ${ratio.label}`,
              <Crop className="h-3.5 w-3.5" />,
              { op: 'crop', params: { ratio: ratio.value } },
            ),
          )}
          <DropdownMenuSeparator />
          {[0.5, 1.5, 2].map((scale) =>
            item(
              `${t('library.resize')} ${Math.round(scale * 100)}%`,
              <Scaling className="h-3.5 w-3.5" />,
              { op: 'resize', params: { scale } },
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
