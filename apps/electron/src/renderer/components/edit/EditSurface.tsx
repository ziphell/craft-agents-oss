/**
 * A cut, on screen — our own surface, laid out like the editing台 it is compared with.
 *
 * The composition is the one every timeline editor converges on, and the one MiniMax Design
 * ships (whose clip studio is OpenReel's layout with its own chrome): a top bar that names the
 * document and exports it, a media column with searchable assets, a player over a transport bar,
 * and a timeline whose toolbar sits above a ruler and its tracks.
 *
 * What is ours is everything underneath: the document is `reels/<slug>.reel`
 * (`@craft-agent/shared/reel/document`), the media is the project's own `assets/`, and the agent
 * writes the same file through `reel_tool`. No second app, no project store, no chat.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronDown,
  Clapperboard,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode,
  Film,
  Loader2,
  Lock,
  Maximize2,
  Magnet,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Search,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Unlock,
  Volume2,
  VolumeX,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { toast } from 'sonner'
import { mediaUrl } from '@/lib/media-url'
import {
  addClip,
  addMarker,
  addOverlay,
  addTrack,
  clipSpeed,
  clipVolume,
  clipsOf,
  clearClipDucking,
  clearMask,
  clearTransition,
  closeGap,
  cutAt,
  detachAudio,
  duplicateClip,
  durationOf,
  emptyDocument,
  MAX_SPEED,
  MIN_SPEED,
  moveClip,
  moveTrack,
  NEUTRAL_TRANSFORM,
  normalizeDocument,
  primaryTrack,
  removeClip,
  removeGaps,
  removeMarker,
  removeOverlay,
  removeTrack,
  rippleDelete,
  setClipAudio,
  setClipAudioEffect,
  setClipDucking,
  setClipEffect,
  setClipFade,
  setClipSpeed,
  setClipTransform,
  setTrack,
  setTrackAudio,
  setTransition,
  splitClip,
  tracksOf,
  trackOfClip,
  TRANSITIONS,
  trimClip,
  trimEdges,
  findClip,
  updateOverlay,
  videoClipAt,
  clipVisualAt,
  insertFreezeFrame,
  isStaleRevision,
  markersOf,
  maskAt,
  masksForClip,
  nextRevision,
  quantizeDocument,
  resizeComposition,
  setClipCrop,
  setClipKeyframes,
  setMask,
  sliceDocument,
  KEYFRAME_EASINGS,
  reelNameOf,
  type ClipPlacement,
  type ClipTransform,
  type CropRect,
  type EditClip,
  type EditDocument,
  type EditTrack,
  type KeyframeEasing,
  type MaskKeyframe,
  type MaskShape,
  type TransformKeyframe,
  type TransitionKind,
} from '@craft-agent/shared/reel/document'
import {
  resolveOverlayBox,
  resolveOverlayVolume,
  resolveTextStyle,
  TEXT_ANIMATIONS,
  TEXT_PRESETS,
  type EditOverlay,
  type TextAnimationPreset,
  type TextPreset,
} from '@craft-agent/shared/reel/overlay'
import { cuesFromOverlays, formatSrt, parseSrt } from '@craft-agent/shared/reel/srt'
import { TEXT_TEMPLATES, type TextTemplate } from '@craft-agent/shared/reel/text-templates'
import {
  dedupeSubtitles,
  replaceSubtitleText,
  shiftSubtitles,
  styleSubtitles,
} from '@craft-agent/shared/reel/subtitles'
import { analyzeBeats, clipBeatsOf } from '@craft-agent/shared/reel/beats'
import { toFcpxml } from '@craft-agent/shared/reel/fcpxml'
import { toJianyingDraft } from '@craft-agent/shared/reel/jianying'
import { exportPlanOf } from '@craft-agent/shared/reel/export-job'
import { MasterTimelineClock } from './preview/master-clock'
import { RealtimeAudioGraph } from './preview/audio-graph'
import { PreviewStage } from './preview/stage'
import { resolveAudioEffect, type AudioEffect } from '@craft-agent/shared/reel/audio-effects'
import {
  EFFECT_PRESETS,
  resolveEffect,
  type BlurRegion,
  type ClipEffect,
  type EffectPreset,
  type ResolvedEffect,
} from '@craft-agent/shared/reel/effects'
import {
  DUCKING_PRESETS,
  duckingEnvelope,
  type DuckingPreset,
  type VolumePoint,
} from '@craft-agent/shared/reel/ducking'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error' | 'conflict'
type Tab = 'media' | 'text' | 'graphics' | 'effects' | 'transitions' | 'adjust'

const nameOf = (path: string) => (path.split(/[\\/]/).pop() ?? path)
const cutNameOf = (path: string) => reelNameOf(path)
const absolute = (folder: string, relative: string) =>
  `${folder.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i
const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i
const AUDIO = /\.(mp3|wav|m4a|aac|ogg)$/i
const MEDIA = /\.(mp4|mov|m4v|webm|mkv|png|jpe?g|webp|gif|avif|mp3|wav|m4a|aac|ogg)$/i

/** Output shapes offered in the top bar; the project's short edge is kept. */
const ASPECTS = [
  { id: '16:9', label: '16:9', ratio: 16 / 9, portrait: false },
  { id: '9:16', label: '9:16', ratio: 9 / 16, portrait: true },
  { id: '1:1', label: '1:1', ratio: 1, portrait: false },
  { id: '4:3', label: '4:3', ratio: 4 / 3, portrait: false },
] as const

/** Encoders prefer even dimensions, and it costs nothing to keep them. */
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

function aspectSize(
  entry: (typeof ASPECTS)[number],
  doc: EditDocument,
): { width: number; height: number } {
  // The short edge is the constant: a 1080p landscape cut becomes 1080×1920 vertically and
  // 1080×1080 squarely, rather than growing into a larger render.
  const short = Math.min(doc.settings.width, doc.settings.height)
  if (entry.id === '1:1') return { width: even(short), height: even(short) }
  return entry.portrait
    ? { width: even(short), height: even(short / entry.ratio) }
    : { width: even(short * entry.ratio), height: even(short) }
}

/** The shortcuts the surface answers, in the order the help panel lists them. */
const SHORTCUT_ROWS = [
  ['Space', 'edit.keyPlayPause'],
  ['← / →', 'edit.keyStep'],
  ['↑ / ↓', 'edit.keyJump'],
  ['Home / End', 'edit.keyStartEnd'],
  ['I / O', 'edit.keyRange'],
  ['M / Shift+M', 'edit.keyMarker'],
  ['[ / ]', 'edit.keyEdges'],
  ['S', 'edit.keySplit'],
  ['Q / W', 'edit.keyTrim'],
  ['Delete', 'edit.keyDelete'],
  ['Ctrl/⌘+Z', 'edit.keyUndo'],
  ['Ctrl/⌘+D', 'edit.keyDuplicate'],
  ['Ctrl/⌘+C / X / V', 'edit.keyClipboard'],
  ['Ctrl/⌘+A', 'edit.keySelectAll'],
  ['Ctrl/⌘+S', 'edit.keySave'],
  ['Ctrl/⌘+E', 'edit.keyExport'],
  ['+ / − / Ctrl/⌘+0', 'edit.keyZoom'],
  ['Esc', 'edit.keyDeselect'],
  ['?', 'edit.keyHelp'],
] as const

function probeDuration(url: string, still: boolean): Promise<number> {
  return new Promise((resolve) => {
    if (still) return resolve(5)
    const el = document.createElement(VIDEO.test(url) ? 'video' : 'audio')
    el.preload = 'metadata'
    el.onloadedmetadata = () =>
      resolve(Number.isFinite((el as HTMLMediaElement).duration) ? (el as HTMLMediaElement).duration : 0)
    el.onerror = () => resolve(0)
    el.src = url
  })
}

const timecode = (seconds: number, fps: number) => {
  const total = Math.max(0, seconds)
  const frames = Math.min(fps - 1, Math.floor((total % 1) * fps))
  const whole = Math.floor(total)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

const inputClass =
  'h-6 min-w-0 rounded border border-border/60 bg-transparent px-1 text-[11px] tabular-nums outline-none focus:border-foreground/40'

/** A colour input speaks `#rrggbb`; a translucent CSS colour falls back to the swatch value. */
const hexColor = (value: string | undefined, fallback: string): string =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback

/** A fresh clip id for a paste; the document itself only owns ids it created. */
const newClipId = () =>
  `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** The fields for one overlay. Drafts are local and written on blur, so typing is one undo step. */
function OverlayInspector({
  overlay,
  onChange,
  onRemove,
  onLiveChange,
  onLiveEnd,
}: {
  overlay: EditOverlay
  onChange: (patch: Partial<EditOverlay>) => void
  onRemove: () => void
  /** A slider being dragged: published on every tick, committed once the drag ends. */
  onLiveChange?: (patch: Partial<EditOverlay>) => void
  onLiveEnd?: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = React.useState(overlay.text ?? '')
  const [start, setStart] = React.useState(String(overlay.start))
  const [duration, setDuration] = React.useState(String(overlay.duration))

  React.useEffect(() => {
    setText(overlay.text ?? '')
    setStart(String(overlay.start))
    setDuration(String(overlay.duration))
  }, [overlay.id, overlay.text, overlay.start, overlay.duration])

  const box = resolveOverlayBox(overlay)
  const frame = overlay.frame ?? { width: 6, color: '#ffffff', radius: 0 }
  const style = resolveTextStyle(overlay)
  const silent = resolveOverlayVolume(overlay) === 0
  const live = onLiveChange ?? onChange

  const commitNumber = (key: 'start' | 'duration', raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    if (key === 'start' && value < 0) return
    if (key === 'duration' && value <= 0) return
    onChange({ [key]: value })
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-foreground/[0.02] p-2 text-[11px]">
      {overlay.kind === 'text' ? (
        <>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => onChange({ text })}
            rows={2}
            className="w-full resize-none rounded border border-border/60 bg-transparent px-1.5 py-1 text-[11px] leading-relaxed outline-none focus:border-foreground/40"
            placeholder={t('edit.overlayText')}
          />
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.preset')}</span>
            <select
              value={overlay.preset ?? 'subtitle'}
              onChange={(event) => onChange({ preset: event.target.value as TextPreset })}
              className={inputClass}
            >
              {(Object.keys(TEXT_PRESETS) as TextPreset[]).map((preset) => (
                <option key={preset} value={preset}>
                  {TEXT_PRESETS[preset].label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.animation')}</span>
            <select
              value={overlay.animation?.preset ?? 'none'}
              onChange={(event) => {
                const preset = event.target.value
                onChange({
                  animation:
                    preset === 'none'
                      ? undefined
                      : {
                          ...overlay.animation,
                          preset: preset as TextAnimationPreset,
                        },
                })
              }}
              className={inputClass}
            >
              <option value="none">{t('edit.animationNone')}</option>
              {(Object.keys(TEXT_ANIMATIONS) as TextAnimationPreset[]).map((preset) => (
                <option key={preset} value={preset}>
                  {TEXT_ANIMATIONS[preset].label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.fontSize')}</span>
            <input
              type="number"
              min={8}
              max={400}
              value={style.fontSize}
              onChange={(event) =>
                onChange({ style: { ...overlay.style, fontSize: Number(event.target.value) } })
              }
              className={`${inputClass} w-14`}
            />
            <span className="shrink-0 text-muted-foreground">{t('edit.color')}</span>
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#ffffff'}
              onChange={(event) => onChange({ style: { ...overlay.style, color: event.target.value } })}
              className="h-6 w-8 cursor-pointer rounded border border-border/60 bg-transparent"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.align')}</span>
            {(['left', 'center', 'right'] as const).map((align) => (
              <button
                key={align}
                type="button"
                onClick={() => onChange({ style: { ...overlay.style, align } })}
                className={`h-6 flex-1 rounded border text-[10px] ${
                  style.align === align
                    ? 'border-foreground/60 bg-foreground/[0.08]'
                    : 'border-border/60 hover:bg-foreground/[0.05]'
                }`}
              >
                {t(
                  align === 'left'
                    ? 'edit.alignLeft'
                    : align === 'center'
                      ? 'edit.alignCenter'
                      : 'edit.alignRight',
                )}
              </button>
            ))}
            {([
              ['bold', t('edit.bold'), style.bold === true],
              ['italic', t('edit.italic'), style.italic === true],
            ] as const).map(([key, label, active]) => (
              <button
                key={key}
                type="button"
                onClick={() =>
                  onChange({ style: { ...overlay.style, [key]: active ? undefined : true } })
                }
                className={`h-6 w-7 rounded border text-[10px] ${
                  active
                    ? 'border-foreground/60 bg-foreground/[0.08]'
                    : 'border-border/60 hover:bg-foreground/[0.05]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.stroke')}</span>
            <input
              type="color"
              value={hexColor(style.strokeColor, '#000000')}
              onChange={(event) =>
                onChange({ style: { ...overlay.style, strokeColor: event.target.value } })
              }
              className="h-6 w-8 cursor-pointer rounded border border-border/60 bg-transparent"
            />
            <input
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={style.strokeWidth ?? 0}
              onChange={(event) =>
                onChange({
                  style: {
                    ...overlay.style,
                    strokeWidth: Number(event.target.value) || undefined,
                  },
                })
              }
              className={`${inputClass} w-12`}
              title={t('edit.strokeWidth')}
            />
            <button
              type="button"
              onClick={() =>
                onChange({ style: { ...overlay.style, strokeColor: undefined, strokeWidth: undefined } })
              }
              className="text-[10px] text-muted-foreground hover:underline"
            >
              {t('edit.clear')}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.background')}</span>
            <input
              type="color"
              value={hexColor(style.backgroundColor, '#000000')}
              onChange={(event) =>
                onChange({ style: { ...overlay.style, backgroundColor: event.target.value } })
              }
              className="h-6 w-8 cursor-pointer rounded border border-border/60 bg-transparent"
            />
            <button
              type="button"
              onClick={() => onChange({ style: { ...overlay.style, backgroundColor: undefined } })}
              className="text-[10px] text-muted-foreground hover:underline"
            >
              {t('edit.clear')}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.shadow')}</span>
            <input
              type="color"
              value={hexColor(style.shadowColor, '#000000')}
              onChange={(event) =>
                onChange({ style: { ...overlay.style, shadowColor: event.target.value } })
              }
              className="h-6 w-8 cursor-pointer rounded border border-border/60 bg-transparent"
            />
            <input
              type="number"
              min={0}
              max={40}
              step={1}
              value={style.shadowBlur ?? 0}
              onChange={(event) =>
                onChange({
                  style: { ...overlay.style, shadowBlur: Number(event.target.value) || undefined },
                })
              }
              className={`${inputClass} w-12`}
              title={t('edit.shadowBlur')}
            />
            <button
              type="button"
              onClick={() =>
                onChange({ style: { ...overlay.style, shadowColor: undefined, shadowBlur: undefined } })
              }
              className="text-[10px] text-muted-foreground hover:underline"
            >
              {t('edit.clear')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.lineHeight')}</span>
            <input
              type="number"
              min={0.8}
              max={2}
              step={0.05}
              value={style.lineHeight ?? 1.3}
              onChange={(event) =>
                onChange({ style: { ...overlay.style, lineHeight: Number(event.target.value) } })
              }
              className={`${inputClass} w-12`}
            />
            <span className="shrink-0 text-muted-foreground">{t('edit.opacity')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={overlay.opacity ?? 1}
              onChange={(event) =>
                (onLiveChange ?? onChange)({ opacity: Number(event.target.value) })
              }
              onPointerUp={() => onLiveEnd?.()}
              onKeyUp={() => onLiveEnd?.()}
              className="h-1 min-w-0 flex-1 accent-foreground"
            />
          </div>
        </>
      ) : null}
      {overlay.kind === 'media' ? (
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-muted-foreground">{t('edit.volume')}</span>
          <button
            type="button"
            onClick={() => onChange({ muted: !silent })}
            title={silent ? t('edit.unmute') : t('edit.mute')}
            className="grid h-6 w-6 shrink-0 place-items-center rounded border border-border/60 text-muted-foreground hover:bg-foreground/[0.05]"
          >
            {silent ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((silent ? 0 : overlay.volume ?? 1) * 100)}
            onChange={(event) => live({ volume: Number(event.target.value) / 100, muted: false })}
            onPointerUp={() => onLiveEnd?.()}
            onKeyUp={() => onLiveEnd?.()}
            className="h-1 min-w-0 flex-1 accent-foreground"
          />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-muted-foreground">{t('edit.start')}</span>
        <input
          type="number"
          step="0.1"
          min={0}
          value={start}
          onChange={(event) => setStart(event.target.value)}
          onBlur={() => commitNumber('start', start)}
          className={`${inputClass} w-14`}
        />
        <span className="shrink-0 text-muted-foreground">{t('edit.duration')}</span>
        <input
          type="number"
          step="0.1"
          min={0.1}
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
          onBlur={() => commitNumber('duration', duration)}
          className={`${inputClass} w-14`}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-12 shrink-0 text-muted-foreground">{t('edit.box')}</span>
        {(['x', 'y', 'w', 'h'] as const).map((key) => (
          <input
            key={key}
            type="number"
            step="0.01"
            min={0}
            max={1}
            value={box[key]}
            onChange={(event) => onChange({ box: { ...box, [key]: Number(event.target.value) } })}
            className={`${inputClass} w-12`}
            title={key}
          />
        ))}
      </div>
      {overlay.kind === 'media' ? (
        <div className="space-y-1.5 rounded border border-border/50 p-1.5">
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.frame')}</span>
            <input
              type="number"
              min={0}
              max={40}
              step={0.5}
              value={frame.width}
              onChange={(event) =>
                onChange({ frame: { ...frame, width: Number(event.target.value) } })
              }
              className={`${inputClass} w-14`}
              title={t('edit.frameWidth')}
            />
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(frame.color) ? frame.color : '#ffffff'}
              onChange={(event) => onChange({ frame: { ...frame, color: event.target.value } })}
              className="h-6 w-8 cursor-pointer rounded border border-border/60 bg-transparent"
              title={t('edit.frameColor')}
            />
            <button
              type="button"
              onClick={() => onChange({ frame: undefined })}
              className="ml-auto text-[10px] text-muted-foreground hover:underline"
            >
              {t('edit.frameClear')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-muted-foreground">{t('edit.radius')}</span>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={frame.radius ?? 0}
              onChange={(event) =>
                live({ frame: { ...frame, radius: Number(event.target.value) } })
              }
              onPointerUp={() => onLiveEnd?.()}
              onKeyUp={() => onLiveEnd?.()}
              className="h-1 min-w-0 flex-1 accent-foreground"
              title={t('edit.frameRadius')}
            />
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="text-[11px] text-destructive hover:underline"
      >
        {t('edit.removeOverlay')}
      </button>
    </div>
  )
}

/**
 * One lane of overlays in the timeline — the same objects that paint above the picture.
 *
 * Subtitles and graphics each get a lane: both live in `overlays`, but they occupy the same
 * seconds without covering each other, so one lane would hide one behind the other.
 */
function OverlayLane({
  overlays,
  selected,
  pxPerSecond,
  label,
  onSeek,
  onPick,
  onMove,
  onEnd,
  onMenu,
}: {
  overlays: EditOverlay[]
  selected: string | null
  pxPerSecond: number
  label: string
  onSeek: (event: React.PointerEvent) => void
  onPick: (event: React.PointerEvent, overlay: EditOverlay) => void
  onMove: (event: React.PointerEvent) => void
  onEnd: () => void
  onMenu: (event: React.MouseEvent, overlay: EditOverlay) => void
}) {
  return (
    <div
      className="relative h-12 border-b border-border/40 bg-foreground/[0.04]"
      onPointerDown={onSeek}
      onPointerMove={onMove}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
    >
      {overlays.length === 0 ? (
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[10px] text-muted-foreground/50">
          {label}
        </span>
      ) : null}
      {overlays.map((overlay) => (
        <div
          key={overlay.id}
          data-overlay={overlay.id}
          className={`absolute top-1.5 h-9 cursor-grab overflow-hidden rounded border px-1.5 text-[10px] leading-9 ${
            selected === overlay.id
              ? 'border-foreground/80 bg-foreground/[0.22]'
              : overlay.kind === 'media'
                ? 'border-sky-400/50 bg-sky-400/10 hover:border-sky-400/80'
                : 'border-border/70 bg-foreground/[0.1] hover:border-foreground/40'
          }`}
          style={{
            left: overlay.start * pxPerSecond,
            width: Math.max(overlay.duration * pxPerSecond, 6),
          }}
          onPointerDown={(event) => onPick(event, overlay)}
          onContextMenu={(event) => onMenu(event, overlay)}
          title={overlay.kind === 'media' ? nameOf(overlay.src ?? '') : overlay.text ?? ''}
        >
          <span className="truncate">
            {overlay.kind === 'media' ? nameOf(overlay.src ?? '') : overlay.text || label}
          </span>
        </div>
      ))}
    </div>
  )
}

/** One labelled slider: live while dragging, one undo step when released. */
function ClipSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (value: number) => void
  onCommit: () => void
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="h-1 min-w-0 flex-1 accent-foreground"
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{display}</span>
    </div>
  )
}

/** The grading sliders, in the order the panel shows them. */
const EFFECT_SLIDERS: Array<{
  key: keyof ResolvedEffect
  label: string
  min: number
  max: number
  step: number
  display: (value: number) => string
}> = [
  {
    key: 'brightness',
    label: 'edit.effectBrightness',
    min: 0,
    max: 2,
    step: 0.01,
    display: (value) => `${Math.round(value * 100)}%`,
  },
  {
    key: 'contrast',
    label: 'edit.effectContrast',
    min: 0,
    max: 2,
    step: 0.01,
    display: (value) => `${Math.round(value * 100)}%`,
  },
  {
    key: 'saturation',
    label: 'edit.effectSaturation',
    min: 0,
    max: 2,
    step: 0.01,
    display: (value) => `${Math.round(value * 100)}%`,
  },
  {
    key: 'hue',
    label: 'edit.effectHue',
    min: -180,
    max: 180,
    step: 1,
    display: (value) => `${Math.round(value)}°`,
  },
  {
    key: 'blur',
    label: 'edit.effectBlur',
    min: 0,
    max: 20,
    step: 0.5,
    display: (value) => `${value.toFixed(1)}px`,
  },
]

/** The transition tab: pick a kind and duration for the cut before the selected clip. */
function TransitionPanel({
  clip,
  previous,
  onApply,
  onClear,
}: {
  clip: EditClip
  previous: EditClip | null
  onApply: (kind: TransitionKind, duration: number) => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  const [kind, setKind] = React.useState<TransitionKind>(clip.transition?.kind ?? 'crossfade')
  const [duration, setDuration] = React.useState(clip.transition?.duration ?? 0.6)

  if (!previous) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
        {t('edit.transitionNeedsNeighbour')}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-2 text-[11px]">
      <div className="truncate text-muted-foreground" title={`${previous.src} → ${clip.src}`}>
        {nameOf(previous.src)} → {nameOf(clip.src)}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(TRANSITIONS) as TransitionKind[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            className={`h-7 rounded-md border px-2 ${
              kind === id
                ? 'border-foreground/60 bg-foreground/[0.08]'
                : 'border-border/60 hover:bg-foreground/[0.05]'
            }`}
          >
            {TRANSITIONS[id].label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-muted-foreground">{t('edit.duration')}</span>
        <input
          type="range"
          min={0.2}
          max={2}
          step={0.1}
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          className="h-1 min-w-0 flex-1 accent-foreground"
        />
        <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
          {duration.toFixed(1)}s
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onApply(kind, duration)}
          className="h-7 rounded-md border border-border/60 px-2 hover:bg-foreground/[0.05]"
        >
          {clip.transition ? t('edit.replaceTransition') : t('edit.applyTransition')}
        </button>
        {clip.transition ? (
          <button
            type="button"
            onClick={onClear}
            className="h-7 rounded-md border border-border/60 px-2 hover:bg-foreground/[0.05]"
          >
            {t('edit.removeTransition')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'media', label: '媒体', icon: <Film className="h-4 w-4" /> },
  { id: 'text', label: '文字', icon: <Type className="h-4 w-4" /> },
  { id: 'graphics', label: '图形', icon: <Sparkles className="h-4 w-4" /> },
  { id: 'effects', label: '效果', icon: <Wand2 className="h-4 w-4" /> },
  { id: 'transitions', label: '转场', icon: <SlidersHorizontal className="h-4 w-4" /> },
  { id: 'adjust', label: '调整', icon: <SlidersHorizontal className="h-4 w-4" /> },
]

export function EditSurface({
  workspaceId,
  projectSlug,
  projectFolder,
  path,
  active = true,
}: {
  workspaceId: string
  /** The project whose cuts and assets this surface edits. */
  projectSlug: string
  /** The project folder a cut's `src` paths are relative to. */
  projectFolder: string
  path: string
  /** False while another tab is in front: the surface is still mounted, but not the one typing. */
  active?: boolean
}) {
  const { t } = useTranslation()
  const [doc, setDoc] = React.useState<EditDocument | null>(null)
  const [selected, setSelected] = React.useState<string | null>(null)
  /** The clips in the selection. `selected` is the primary one the inspector edits. */
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  /** Companions of the dragged clip, snapshotted at press so a group moves by one delta. */
  const dragCompanions = React.useRef<Array<{ id: string; start: number }>>([])

  const selectClips = React.useCallback((ids: string[]) => {
    const unique = Array.from(new Set(ids))
    setSelectedIds(unique)
    setSelected(unique.length > 0 ? unique[unique.length - 1]! : null)
  }, [])

  const clearClipSelection = React.useCallback(() => {
    setSelectedIds([])
    setSelected(null)
  }, [])
  /** The overlay whose inspector is open. Overlays and clips are separate selections. */
  const [selectedOverlay, setSelectedOverlay] = React.useState<string | null>(null)
  const [pipSource, setPipSource] = React.useState('')
  /** Ducking: which preset to bake, and which track's speech triggers it. */
  const [duckingPreset, setDuckingPreset] = React.useState<DuckingPreset>('moderate')
  const [duckingSource, setDuckingSource] = React.useState('')
  const [duckingBusy, setDuckingBusy] = React.useState(false)
  /** True while a clip's sound is being analysed for a beat grid. */
  const [beatBusy, setBeatBusy] = React.useState(false)
  /** Export range: in/out points in timeline seconds; null means unbounded on that side. */
  const [inPoint, setInPoint] = React.useState<number | null>(null)
  const [outPoint, setOutPoint] = React.useState<number | null>(null)
  const [save, setSave] = React.useState<SaveState>('loading')
  const [playhead, setPlayheadState] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)
  const [pxPerSecond, setPxPerSecond] = React.useState(64)
  const [external, setExternal] = React.useState<number | null>(null)
  const [tab, setTab] = React.useState<Tab>('media')
  const [query, setQuery] = React.useState('')
  const [assets, setAssets] = React.useState<string[]>([])
  const [snap, setSnap] = React.useState(true)
  /** How long a freeze frame holds, in seconds. */
  const [freezeSeconds, setFreezeSeconds] = React.useState('2')
  const [past, setPast] = React.useState<EditDocument[]>([])
  const [future, setFuture] = React.useState<EditDocument[]>([])
  /** Clips copied with Cmd/Ctrl+C, with the lane they came from. */
  const clipboard = React.useRef<Array<{ clip: EditClip; trackId: string }>>([])
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  /** 0..1 while the hidden window is encoding; null when idle. */
  const [exportProgress, setExportProgress] = React.useState<number | null>(null)
  /** The track whose name is being edited in the timeline header, and the draft it holds. */
  const [renamingTrack, setRenamingTrack] = React.useState<string | null>(null)
  const [trackNameDraft, setTrackNameDraft] = React.useState('')

  // A range belongs to one cut: opening another one starts with no range.
  React.useEffect(() => {
    setInPoint(null)
    setOutPoint(null)
  }, [path])

  /**
   * The preview's clock is the audio context's own time (OpenReel's `MasterTimelineClock`), not a
   * RAF sum: picture frames and scheduled sound read the same number, so they cannot drift. The
   * `playhead` state below is only the rendered projection of it.
   */
  const clock = React.useMemo(() => new MasterTimelineClock(), [])
  /**
   * The sound is the audio graph's, not a media element's: the same decoded buffers, the same
   * scheduling against the clock, the same tone chain the exporter builds.
   */
  const audio = React.useMemo(() => new RealtimeAudioGraph(clock), [clock])
  const playheadRef = React.useRef(0)
  playheadRef.current = playhead
  const seekPlayhead = React.useCallback(
    (value: number | ((previous: number) => number)) => {
      const next =
        typeof value === 'function'
          ? (value as (previous: number) => number)(playheadRef.current)
          : value
      playheadRef.current = next
      clock.seek(next)
      audio.seek(next)
      setPlayheadState(next)
    },
    [clock, audio],
  )

  /** The time axis: every scrub is measured against this element, so ticks and pointer agree. */
  const rulerRef = React.useRef<HTMLDivElement>(null)
  /** The timeline's scroller: wheel zoom, horizontal wheel, and playback follow all use it. */
  const timelineScrollRef = React.useRef<HTMLDivElement>(null)
  /** The surface itself. Keyboard shortcuts are bound here, not to `window` — a hidden or
      unfocused editor must never answer for the app. */
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  /** True while a scrub owns the pointer, so the timeline shows a grabbing hand. */
  const [scrubbing, setScrubbing] = React.useState(false)

  /**
   * Zoom around a screen point, keeping the time under it where it is. The reference timeline does
   * the same on Ctrl/Cmd+wheel; anchoring at the pointer is what makes zoom feel like a lens rather
   * than a jump to the start.
   */
  const zoomTo = React.useCallback(
    (next: number, anchorClientX?: number) => {
      const clamped = Math.round(Math.min(240, Math.max(16, next)))
      if (clamped === pxPerSecond) return
      const scroller = timelineScrollRef.current
      const ruler = rulerRef.current
      if (!scroller || !ruler || anchorClientX === undefined) {
        setPxPerSecond(clamped)
        return
      }
      const timeAtCursor = Math.max(0, (anchorClientX - ruler.getBoundingClientRect().left) / pxPerSecond)
      setPxPerSecond(clamped)
      requestAnimationFrame(() => {
        const moved = rulerRef.current
        const box = timelineScrollRef.current
        if (!moved || !box) return
        const drift = moved.getBoundingClientRect().left + timeAtCursor * clamped - anchorClientX
        box.scrollLeft = Math.max(0, box.scrollLeft + drift)
      })
    },
    [pxPerSecond],
  )

  React.useEffect(() => {
    const scroller = timelineScrollRef.current
    if (!scroller) return
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        zoomTo(pxPerSecond * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX)
        return
      }
      // Shift turns a vertical wheel into the horizontal scroll every editor uses for a timeline.
      if (event.shiftKey && event.deltaY !== 0) {
        event.preventDefault()
        scroller.scrollLeft += event.deltaY
      }
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [pxPerSecond, zoomTo])

  /**
   * Keep the playhead visible while playing: when it crosses the right margin, page the view so it
   * lands back near the left with the upcoming timeline as lookahead. Same rule as the reference.
   */
  React.useEffect(() => {
    if (!playing) return
    const scroller = timelineScrollRef.current
    const ruler = rulerRef.current
    if (!scroller || !ruler) return
    const box = scroller.getBoundingClientRect()
    const head = ruler.getBoundingClientRect().left + playhead * pxPerSecond
    // The track-header column is sticky, so the usable view starts after it.
    const left = box.left + 104
    const margin = Math.min(220, Math.max(60, (box.right - left) * 0.12))
    if (head > box.right - margin || head < left) {
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft + head - (left + margin))
    }
  }, [playing, playhead, pxPerSecond])

  /**
   * Start scrubbing on pointer down and keep following the pointer until release.
   *
   * The press itself is the gesture: `absolute` seeks to where the axis was pressed (ruler), while
   * `relative` keeps the offset the grab started with (the playhead), so grabbing the head never
   * jumps it. Pointer capture is what makes "press, then keep dragging" one gesture instead of a
   * click that has to be followed by a second press.
   */
  const beginScrub = React.useCallback(
    (event: React.PointerEvent<HTMLElement>, mode: 'absolute' | 'relative') => {
      if (event.button !== 0) return
      const ruler = rulerRef.current
      if (!ruler) return
      event.preventDefault()
      event.stopPropagation()
      setPlaying(false)
      const element = event.currentTarget
      const rect = ruler.getBoundingClientRect()
      const startX = event.clientX
      const startTime = playheadRef.current
      const timeAt = (clientX: number) =>
        mode === 'relative'
          ? startTime + (clientX - startX) / pxPerSecond
          : (clientX - rect.left) / pxPerSecond
      // Edges the scrub may catch on. A slow drag snaps within 8px; a fast drag passes through,
      // so crossing a busy timeline never feels sticky.
      const edges = snap
        ? [
            0,
            ...clipsOf(docRef.current ?? emptyDocument('x')).flatMap((clip) => [
              clip.start,
              clip.start + clip.duration,
            ]),
            ...(docRef.current?.overlays ?? []).flatMap((overlay) => [
              overlay.start,
              overlay.start + overlay.duration,
            ]),
          ]
        : []
      let lastX = event.clientX
      const settle = (clientX: number) => {
        let time = Math.max(0, timeAt(clientX))
        const moved = Math.abs(clientX - lastX)
        lastX = clientX
        if (edges.length > 0 && moved <= 3) {
          const threshold = 8 / pxPerSecond
          let caught: number | null = null
          for (const edge of edges) {
            if (Math.abs(time - edge) > threshold) continue
            if (caught === null || Math.abs(time - edge) < Math.abs(time - caught)) caught = edge
          }
          if (caught !== null) time = Math.max(0, caught)
        }
        seekPlayhead(time)
      }
      element.setPointerCapture(event.pointerId)
      setScrubbing(true)
      // The press lands exactly where the axis was pressed; snapping starts with the drag.
      if (mode === 'absolute') seekPlayhead(Math.max(0, timeAt(event.clientX)))
      const move = (next: PointerEvent) => settle(next.clientX)
      const end = () => {
        element.removeEventListener('pointermove', move)
        element.removeEventListener('pointerup', end)
        element.removeEventListener('pointercancel', end)
        setScrubbing(false)
      }
      element.addEventListener('pointermove', move)
      element.addEventListener('pointerup', end)
      element.addEventListener('pointercancel', end)
    },
    [pxPerSecond, seekPlayhead, snap],
  )

  const fileInput = React.useRef<HTMLInputElement>(null)
  /** The hidden picker behind "import SRT". */
  const srtInput = React.useRef<HTMLInputElement>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const docRef = React.useRef<EditDocument | null>(null)
  const lastWrite = React.useRef(0)
  const pending = React.useRef<EditDocument | null>(null)
  const gestureStart = React.useRef<EditDocument | null>(null)
  docRef.current = doc

  /**
   * Take a revision written outside this panel as **one undo step**.
   *
   * drawio and the office editor get this by routing an agent's edit into the live document; here
   * the file is already written, so adopting is the whole of it — push what the panel held onto
   * the undo stack, replace it, and leave the file alone (the writer already bumped the revision).
   *
   * It is not done while a debounced write is owed or a gesture is in flight: adopting then would
   * drop the person's own edit, so the banner stays and they decide.
   */
  const adoptExternal = React.useCallback(
    (parsed: unknown) => {
      const current = docRef.current
      if (current) setPast((stack) => [...stack.slice(-49), current])
      setFuture([])
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      pending.current = null
      gestureStart.current = null
      setExternal(null)
      setDoc(normalizeDocument(parsed, cutNameOf(path)))
      setSave('idle')
    },
    [path],
  )

  // ── Read, and keep reading: the agent writes the same file ───────────────────────────────
  React.useEffect(() => {
    let live = true
    const load = async (first: boolean) => {
      try {
        const text = await window.electronAPI.readFile(path)
        if (!live) return
        const parsed = JSON.parse(text) as { revision?: number }
        const revision = Number(parsed.revision) || 0
        const current = docRef.current
        if (!first && current) {
          if (revision <= current.revision || revision <= lastWrite.current) return
          // Somebody wrote a newer revision. Take it as an undo step unless this panel owes a
          // write or is holding a gesture — then say so instead of clobbering their edit.
          if (pending.current || gestureStart.current) {
            setExternal(revision)
            return
          }
          adoptExternal(parsed)
          return
        }
        setDoc(normalizeDocument(parsed, cutNameOf(path)))
        setSave('idle')
      } catch {
        if (!live) return
        setDoc((current) => current ?? emptyDocument(cutNameOf(path)))
        setSave('idle')
      }
    }
    void load(true)
    const poll = setInterval(() => void load(false), 1500)
    return () => {
      live = false
      clearInterval(poll)
    }
  }, [adoptExternal, path])

  React.useEffect(() => {
    setDoc(null)
    clearClipSelection()
    setSelectedOverlay(null)
    seekPlayhead(0)
    setPlaying(false)
    setExternal(null)
  }, [clearClipSelection, path])

  const write = React.useCallback(
    async (next: EditDocument, allowStale = false) => {
      // Another writer may have moved the file since this panel read it — the agent applies batches
      // to the same document. Writing anyway would replace their revision with ours, silently and
      // at the same number. So the revision on disk is checked first: a gesture made against a
      // stale base is refused, and the polling loop adopts the newer document as one undo step —
      // the person's edit is not lost, it is one Ctrl+Z away. Undo and redo pass `allowStale`: they
      // are the person saying "this older document is what I want", so they do write.
      let diskRevision: number | null = null
      try {
        const text = await window.electronAPI.readFile(path)
        diskRevision = Number((JSON.parse(text) as { revision?: number }).revision) || 0
      } catch {
        // No file yet, or unreadable: the write below is what creates it.
        diskRevision = null
      }
      if (!allowStale && isStaleRevision(next.revision, diskRevision)) {
        pending.current = null
        gestureStart.current = null
        setExternal(diskRevision!)
        setSave('conflict')
        return
      }

      // Whenever the file moved on, the next revision must be past it: two writers both landing on
      // R+1 would make a later reader believe nothing changed.
      const bumped = { ...next, revision: nextRevision(next.revision, diskRevision) }
      lastWrite.current = bumped.revision
      pending.current = null
      setDoc(bumped)
      setSave('saving')
      void window.electronAPI
        .writeFile(path, JSON.stringify(bumped, null, 2))
        .then(() => setSave('saved'))
        .catch(() => setSave('error'))
    },
    [path],
  )

  /** One gesture, one undo step and one file write. */
  const commit = React.useCallback(
    (next: EditDocument, options: { undoable?: boolean; allowStale?: boolean } = {}) => {
      const before = gestureStart.current ?? docRef.current
      // Every gesture lands on the frame grid, so preview, snapshot and export agree on the cut.
      const snapped = quantizeDocument(next)
      if (options.undoable !== false && before) {
        setPast((stack) => [...stack.slice(-49), before])
        setFuture([])
      }
      gestureStart.current = null
      setDoc(snapped)
      pending.current = snapped
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void write(snapped, options.allowStale === true), 500)
    },
    [write],
  )

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      const held = pending.current
      if (held) void write(held)
    },
    [write],
  )

  const undo = React.useCallback(() => {
    setPast((stack) => {
      if (stack.length === 0) return stack
      const previous = stack[stack.length - 1]!
      setFuture((forward) => [docRef.current ?? previous, ...forward].slice(0, 50))
      // Undo is explicit: it may deliberately land on top of a revision somebody else wrote.
      commit(previous, { undoable: false, allowStale: true })
      return stack.slice(0, -1)
    })
  }, [commit])

  const redo = React.useCallback(() => {
    setFuture((stack) => {
      if (stack.length === 0) return stack
      const next = stack[0]!
      setPast((back) => [...back, docRef.current ?? next].slice(-50))
      commit(next, { undoable: false, allowStale: true })
      return stack.slice(1)
    })
  }, [commit])

  // ── Media ────────────────────────────────────────────────────────────────────────────────
  /**
   * A filmstrip per source file: eight frames sampled across it, drawn once into a tiny canvas
   * and cached. Seeking a real `<video>` is what a filmstrip costs — a data URL could not do it
   * (no ranges), which is why the media is served as a URL instead.
   */
  const strips = React.useRef(new Map<string, string[]>())
  const [, bumpStrips] = React.useReducer((value: number) => value + 1, 0)

  const filmstrip = React.useCallback(
    (src: string): string[] => {
      const known = strips.current.get(src)
      if (known) return known
      strips.current.set(src, [])
      void (async () => {
        const url = mediaUrl(absolute(projectFolder, src))
        const video = document.createElement('video')
        video.src = url
        video.muted = true
        video.preload = 'auto'
        const meta = new Promise<void>((resolve) => {
          video.onloadedmetadata = () => resolve()
          video.onerror = () => resolve()
        })
        await meta
        const duration = Number.isFinite(video.duration) ? video.duration : 0
        if (!duration) return
        const canvas = document.createElement('canvas')
        canvas.width = 96
        canvas.height = 54
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const shots: string[] = []
        const frames = 8
        for (let index = 0; index < frames; index += 1) {
          video.currentTime = (duration * (index + 0.5)) / frames
          await new Promise<void>((resolve) => {
            video.onseeked = () => resolve()
            setTimeout(resolve, 400)
          })
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            shots.push(canvas.toDataURL('image/jpeg', 0.55))
          } catch {
            break
          }
        }
        strips.current.set(src, shots)
        bumpStrips()
      })()
      return []
    },
    [projectFolder],
  )

  /**
   * Peaks and RMS per source: one decode, 100 buckets a second, and every clip on the track draws
   * its own window of them. Peaks paint the waveform; RMS is what the beat analysis reads — an
   * average level is steadier than a single sample when an attack is only a few milliseconds long.
   */
  const peaks = React.useRef(
    new Map<string, { values: Float32Array; rms: Float32Array; duration: number; bucketSeconds: number }>(),
  )
  const peakLoads = React.useRef(
    new Map<
      string,
      Promise<{ values: Float32Array; rms: Float32Array; duration: number; bucketSeconds: number } | null>
    >(),
  )
  const [, bumpPeaks] = React.useReducer((value: number) => value + 1, 0)

  /**
   * Decode a source once and sample it into 100 buckets a second (capped so a long file stays a
   * small answer). The waveform, the ducking analysis and beat detection all come through here.
   */
  const loadPeaks = React.useCallback(
    (
      src: string,
    ): Promise<{
      values: Float32Array
      rms: Float32Array
      duration: number
      bucketSeconds: number
    } | null> => {
      const known = peakLoads.current.get(src)
      if (known) return known
      const loading = (async () => {
        try {
          const response = await fetch(mediaUrl(absolute(projectFolder, src)))
          const buffer = await response.arrayBuffer()
          const context = new AudioContext()
          const audio = await context.decodeAudioData(buffer.slice(0))
          await context.close()
          const channel = audio.getChannelData(0)
          // 10 ms buckets: fine enough to place an onset, and capped so a ten-minute track does
          // not turn into millions of samples in memory.
          const buckets = Math.min(30_000, Math.max(160, Math.round(audio.duration * 100)))
          const bucketSeconds = audio.duration / buckets
          const step = Math.max(1, Math.floor(channel.length / buckets))
          const values = new Float32Array(buckets)
          const rms = new Float32Array(buckets)
          for (let bucket = 0; bucket < buckets; bucket += 1) {
            let peak = 0
            let sum = 0
            let counted = 0
            const start = bucket * step
            const stop = Math.min(start + step, channel.length)
            for (let index = start; index < stop; index += 1) {
              const sample = channel[index] ?? 0
              const magnitude = Math.abs(sample)
              if (magnitude > peak) peak = magnitude
              sum += sample * sample
              counted += 1
            }
            values[bucket] = peak
            rms[bucket] = Math.sqrt(sum / Math.max(1, counted))
          }
          const result = { values, rms, duration: audio.duration, bucketSeconds }
          peaks.current.set(src, result)
          bumpPeaks()
          return result
        } catch {
          // A file with no audio track (or a codec the decoder will not take) simply has no
          // waveform; ducking analysis of it says the same.
          return null
        }
      })()
      peakLoads.current.set(src, loading)
      return loading
    },
    [projectFolder],
  )

  const peaksFor = React.useCallback(
    (
      src: string,
    ): { values: Float32Array; rms: Float32Array; duration: number; bucketSeconds: number } | null => {
      const known = peaks.current.get(src)
      if (known) return known.values.length > 0 ? known : null
      void loadPeaks(src)
      return null
    },
    [loadPeaks],
  )

  /** The part of the peaks a clip uses, as an SVG path across a 0–100 box. */
  const wavePath = React.useCallback(
    (src: string, clipIn: number, clipDuration: number): string | null => {
      const strip = peaksFor(src)
      if (!strip || strip.duration <= 0) return null
      const from = Math.floor((clipIn / strip.duration) * strip.values.length)
      const to = Math.ceil(((clipIn + clipDuration) / strip.duration) * strip.values.length)
      const count = Math.max(2, Math.min(240, to - from))
      const points: string[] = []
      for (let index = 0; index < count; index += 1) {
        const at = from + Math.round(((to - from) * index) / Math.max(1, count - 1))
        const value = strip.values[Math.min(strip.values.length - 1, Math.max(0, at))] ?? 0
        const x = (index / Math.max(1, count - 1)) * 100
        const height = Math.min(48, value * 96)
        points.push(`M ${x.toFixed(2)} ${(50 - height).toFixed(2)} V ${(50 + height).toFixed(2)}`)
      }
      return points.join(' ')
    },
    [peaksFor],
  )

  /** `assets/x.mp4` → a URL the player can seek in (see `lib/media-url`). */
  const urlOf = React.useCallback(
    (src: string) => (src ? mediaUrl(absolute(projectFolder, src)) : null),
    [projectFolder],
  )

  /**
   * How long each source file itself is, so a right-edge trim cannot reach past the material.
   * Probed once per source; an unknown length simply does not clamp, rather than blocking the
   * gesture while a header loads.
   */
  const sourceLengths = React.useRef(new Map<string, number>())
  const lengthAsked = React.useRef(new Set<string>())
  const ensureSourceLength = React.useCallback(
    (src: string) => {
      if (!src || IMAGE.test(src) || sourceLengths.current.has(src) || lengthAsked.current.has(src)) {
        return
      }
      const url = urlOf(src)
      if (!url) return
      lengthAsked.current.add(src)
      void probeDuration(url, false).then((seconds) => {
        if (seconds > 0) sourceLengths.current.set(src, seconds)
        else lengthAsked.current.delete(src)
      })
    },
    [urlOf],
  )

  const refreshAssets = React.useCallback(async () => {
    try {
      const tree = (await window.electronAPI.getProjectFiles(workspaceId, projectSlug)) as Array<{
        path: string
        children?: unknown
      }>
      const leaves: string[] = []
      const walk = (entries: Array<{ path: string; children?: unknown }>) => {
        for (const entry of entries) {
          const children = Array.isArray(entry.children)
            ? (entry.children as Array<{ path: string; children?: unknown }>)
            : []
          if (children.length) walk(children)
          else leaves.push(entry.path)
        }
      }
      walk(tree)
      // The tree names files absolutely; a cut stores root-relative paths (`assets/a.mp4`).
      const folder = projectFolder.replace(/[\\/]+$/, '').replace(/\\/g, '/')
      const relative = leaves
        .map((leaf) => leaf.replace(/\\/g, '/'))
        .map((leaf) => (leaf.startsWith(`${folder}/`) ? leaf.slice(folder.length + 1) : leaf))
      setAssets(relative.filter((candidate) => candidate.startsWith('assets/') && MEDIA.test(candidate)))
    } catch {
      setAssets([])
    }
  }, [projectFolder, projectSlug, workspaceId])

  React.useEffect(() => {
    void refreshAssets()
  }, [refreshAssets])

  const insert = React.useCallback(
    async (sources: string[]) => {
      let next = docRef.current ?? emptyDocument(cutNameOf(path))
      for (const src of sources) {
        const duration = (await probeDuration(absolute(projectFolder, src), IMAGE.test(src))) || 5
        // A recording belongs on a sound track, not on the picture track: one clip under the
        // playhead is the viewer's picture, and sound is allowed to mix.
        if (AUDIO.test(src) && tracksOf(next, 'audio').length === 0) next = addTrack(next, 'audio')
        const trackId = AUDIO.test(src)
          ? tracksOf(next, 'audio')[0]?.id
          : primaryTrack(next).id
        next = addClip(next, { src, duration, ...(trackId ? { trackId } : {}) })
      }
      commit(next)
    },
    [commit, path, projectFolder],
  )

  const upload = React.useCallback(
    async (files: File[]) => {
      const added: string[] = []
      for (const file of files) {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
          reader.onerror = () => reject(new Error(t('canvas.readFailed')))
          reader.readAsDataURL(file)
        })
        const asset = await window.electronAPI.uploadProjectAsset(workspaceId, projectSlug, {
          filename: file.name,
          base64,
        })
        added.push(`assets/${asset.filename}`)
      }
      await refreshAssets()
      await insert(added)
    },
    [insert, projectSlug, refreshAssets, t, workspaceId],
  )

  // ── Playback ─────────────────────────────────────────────────────────────────────────────
  const total = doc ? durationOf(doc) : 0
  /** What the viewer is looking at: the topmost picture clip under the playhead. */
  const current: ClipPlacement | null = doc ? videoClipAt(doc, playhead) : null
  const fps = doc?.settings.frameRate ?? 30

  // The clock is the only time source: its subscription projects the moment into state, and the
  // end of the cut stops playback from the clock itself.
  React.useEffect(
    () =>
      clock.subscribe((time, running) => {
        playheadRef.current = time
        setPlayheadState(time)
        if (!running) setPlaying(false)
      }),
    [clock],
  )

  React.useEffect(() => {
    if (doc) clock.setLimit(durationOf(doc))
  }, [clock, doc])

  // The document is what the audio graph plays: decode what it names, update gains and tone, and
  // queue anything that starts inside the look-ahead window.
  React.useEffect(() => {
    if (doc) audio.apply(doc, urlOf)
  }, [audio, doc, urlOf])

  React.useEffect(() => {
    if (playing) {
      void clock
        .play()
        .then(() => clock.playing && audio.play())
        .catch(() => setPlaying(false))
    } else {
      audio.pause()
      clock.pause()
    }
  }, [audio, clock, playing])

  React.useEffect(() => () => audio.dispose(), [audio])

  const addTextOverlay = React.useCallback(
    (preset: TextPreset) => {
      const current = docRef.current
      if (!current) return
      const overlayId = `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
      commit(
        addOverlay(current, {
          id: overlayId,
          kind: 'text',
          text: preset === 'subtitle' ? '字幕' : preset === 'title' ? '标题' : '花字',
          start: playhead,
          duration: 2.5,
          preset,
          z: 10,
        }),
      )
      setSelectedOverlay(overlayId)
      setTab('text')
    },
    [commit, playhead],
  )

  const addPipOverlay = React.useCallback(
    (src: string) => {
      const current = docRef.current
      if (!current || !src) return
      const overlayId = `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
      commit(
        addOverlay(current, {
          id: overlayId,
          kind: 'media',
          src,
          start: playhead,
          duration: 5,
          in: 0,
          box: { x: 0.68, y: 0.06, w: 0.28, h: 0.28 },
          z: 10,
        }),
      )
      setSelectedOverlay(overlayId)
      setTab('graphics')
    },
    [commit, playhead],
  )

  /** A catalog template — the same overlay the agent writes with `add_overlay.template`. */
  const addTemplateOverlay = React.useCallback(
    (template: TextTemplate) => {
      const current = docRef.current
      if (!current) return
      const overlayId = `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
      commit(
        addOverlay(current, {
          id: overlayId,
          kind: 'text',
          text: template.sample,
          start: playhead,
          duration: 2.5,
          preset: template.preset,
          style: template.style,
          box: template.box,
          ...(template.animation ? { animation: template.animation } : {}),
          z: 10,
        }),
      )
      setSelectedOverlay(overlayId)
      setTab('text')
    },
    [commit, playhead],
  )

  // ── Subtitle batches ────────────────────────────────────────────────────────────────────
  const [shiftSeconds, setShiftSeconds] = React.useState('0.2')
  const [findText, setFindText] = React.useState('')
  const [replaceValue, setReplaceValue] = React.useState('')

  const shiftAllSubtitles = () => {
    const current = docRef.current
    const by = Number(shiftSeconds)
    if (!current || !Number.isFinite(by) || by === 0) return
    commit(shiftSubtitles(current, by))
  }

  const replaceAllSubtitles = () => {
    const current = docRef.current
    if (!current || !findText) return
    commit(replaceSubtitleText(current, findText, replaceValue))
  }

  const dedupeAllSubtitles = () => {
    const current = docRef.current
    if (current) commit(dedupeSubtitles(current))
  }

  /** Copy the selected text's look — but not its words or timing — onto every subtitle. */
  const styleAllSubtitles = () => {
    const current = docRef.current
    if (!current) return
    const source = current.overlays.find((overlay) => overlay.id === selectedOverlay)
    if (!source?.style) return
    commit(styleSubtitles(current, source.style))
  }

  /** Default the PiP picker to the first picture or clip the project has. */
  React.useEffect(() => {
    if (pipSource && assets.includes(pipSource)) return
    setPipSource(assets.find((src) => VIDEO.test(src) || IMAGE.test(src)) ?? '')
  }, [assets, pipSource])

  /**
   * A transcript from speech recognition, on the subtitle track: one overlay per cue, one undo
   * step, and the same objects the agent writes with `add_subtitles`.
   */
  const importSrt = React.useCallback(
    async (file: File) => {
      const cues = parseSrt(await file.text())
      if (cues.length === 0) {
        toast.error(t('edit.srtEmpty'))
        return
      }
      let current = docRef.current
      if (!current) return
      for (const cue of cues) {
        current = addOverlay(current, {
          kind: 'text',
          preset: 'subtitle',
          text: cue.text,
          start: cue.start,
          duration: Math.max(0.05, cue.end - cue.start),
          z: 10,
        })
      }
      commit(current)
      toast.success(t('edit.srtImported', { count: cues.length }))
    },
    [commit, t],
  )

  /** The cut's subtitles as SRT — the same cues `reel_tool subtitles` prints. */
  const exportSubtitles = React.useCallback(async () => {
    const current = docRef.current
    if (!current) return
    const cues = cuesFromOverlays(current.overlays)
    if (cues.length === 0) {
      toast.error(t('edit.srtEmpty'))
      return
    }
    const answer = await window.electronAPI.saveFileDialog({
      title: t('edit.exportSubtitles'),
      defaultPath: absolute(projectFolder, `${current.name}.srt`),
      filters: [{ name: 'SubRip', extensions: ['srt'] }],
    })
    if (answer.canceled || !answer.filePath) return
    try {
      // SRT is the one subtitle envelope this app writes; every player and translator takes it.
      await window.electronAPI.writeFile(answer.filePath, formatSrt(cues))
      toast.success(t('edit.srtExported'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [projectFolder, t])

  /**
   * The cut as FCPXML — the same timeline another editor can open. Each source is named by its
   * absolute path because the file will be read outside this project.
   */
  const exportFcpxml = React.useCallback(async () => {
    const current = docRef.current
    if (!current) return
    if (clipsOf(current).length === 0) {
      toast.error(t('edit.projectEmpty'))
      return
    }
    const answer = await window.electronAPI.saveFileDialog({
      title: t('edit.exportProject'),
      defaultPath: absolute(projectFolder, `${current.name}.fcpxml`),
      filters: [{ name: 'FCPXML', extensions: ['fcpxml'] }],
    })
    if (answer.canceled || !answer.filePath) return
    try {
      await window.electronAPI.writeFile(
        answer.filePath,
        toFcpxml(current, { fileFor: (src) => absolute(projectFolder, src) }),
      )
      toast.success(t('edit.projectExported'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [projectFolder, t])

  /**
   * A 剪映 draft, installed into the editor's own draft folder. The JSON is built here (this is
   * where the document lives); the main process copies the media and registers the draft.
   */
  const exportJianying = React.useCallback(async () => {
    const current = docRef.current
    if (!current) return
    if (clipsOf(current).length === 0) {
      toast.error(t('edit.projectEmpty'))
      return
    }
    const api = window.electronAPI as unknown as {
      editJianying?: (request: {
        draftName: string
        flavor: 'jianying' | 'capcut'
        content: Record<string, unknown>
        meta: Record<string, unknown>
        media: Array<{ srcPath: string; destName: string }>
      }) => Promise<{ ok: boolean; path?: string; message?: string }>
    }
    if (!api.editJianying) {
      toast.error(t('edit.jianyingUnavailable'))
      return
    }
    const draft = toJianyingDraft(current, { draftName: current.name, flavor: 'jianying' })
    const result = await api.editJianying({
      draftName: current.name,
      flavor: 'jianying',
      content: draft.content,
      meta: draft.meta,
      media: draft.media.map((file) => ({
        srcPath: absolute(projectFolder, file.src),
        destName: file.destName,
      })),
    })
    if (!result.ok) {
      toast.error(result.message ?? t('edit.jianyingFailed'))
      return
    }
    toast.success(t('edit.jianyingDone'))
    if (draft.warnings.length > 0) toast.message(draft.warnings.join('；'))
  }, [projectFolder, t])

  // ── Timeline gestures ────────────────────────────────────────────────────────────────────
  const [drag, setDrag] = React.useState<{
    id: string
    mode: 'move' | 'left' | 'right'
    x: number
    /** The scroller's position at press, so auto-scroll is part of the drag distance. */
    scrollLeft: number
    origin: EditClip
  } | null>(null)
  /** The live pointer x while dragging; the edge auto-scroll loop reads it. */
  const pointerX = React.useRef(0)
  const applyDragAtRef = React.useRef<(clientX: number) => void>(() => {})
  /** Where the drag was caught by an edge (seconds), for the guide line. */
  const [snapGuide, setSnapGuide] = React.useState<number | null>(null)
  /** Where a media item dragged from the column would land. */
  const [dropAt, setDropAt] = React.useState<number | null>(null)

  const beginDrag = (event: React.PointerEvent, clip: EditClip, mode: 'move' | 'left' | 'right') => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    setPlaying(false)
    setSelectedOverlay(null)
    // Trimming is where a source can be asked for more than it holds; start reading its length
    // now, so the first clamp is already informed.
    ensureSourceLength(clip.src)
    // Shift/Ctrl/Cmd adds to the selection; pressing one of several selected clips keeps the set
    // so the whole group moves together, which is how the reference editor behaves.
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const already = selectedIds.includes(clip.id)
    const ids = additive
      ? Array.from(new Set([...selectedIds, clip.id]))
      : already && selectedIds.length > 1
        ? selectedIds
        : [clip.id]
    selectClips(ids)
    const current = docRef.current
    dragCompanions.current =
      mode === 'move' && ids.length > 1 && current
        ? ids
            .filter((id) => id !== clip.id)
            .map((id) => ({
              id,
              start: clipsOf(current).find((candidate) => candidate.id === id)?.start ?? 0,
            }))
        : []
    gestureStart.current = docRef.current
    pointerX.current = event.clientX
    setDrag({
      id: clip.id,
      mode,
      x: event.clientX,
      scrollLeft: timelineScrollRef.current?.scrollLeft ?? 0,
      origin: { ...clip },
    })
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  /**
   * What a dragged edge is allowed to catch on: the start of the cut, the playhead, and the edges
   * of the other clips. 10 screen pixels, not seconds — how close a snap feels is a property of
   * the pointer, not of the timeline's zoom.
   */
  const snapTargets = React.useCallback(
    (ignoreId: string): number[] => {
      const current = docRef.current
      if (!current) return []
      const edges = [0, playhead]
      for (const clip of clipsOf(current)) {
        if (clip.id === ignoreId) continue
        edges.push(clip.start, clip.start + clip.duration)
      }
      return edges
    },
    [playhead],
  )

  const applyDragAt = (clientX: number) => {
    if (!drag || !doc) return
    // A drag that scrolled the timeline moved the content under the pointer, so that distance
    // counts as movement even when the pointer itself stayed still.
    const scrolled = (timelineScrollRef.current?.scrollLeft ?? 0) - drag.scrollLeft
    const seconds = (clientX - drag.x + scrolled) / pxPerSecond
    const threshold = 10 / pxPerSecond
    const targets = snap ? snapTargets(drag.id) : []
    const catchAt = (value: number): number | null => {
      let best: number | null = null
      for (const target of targets) {
        if (Math.abs(value - target) > threshold) continue
        if (best === null || Math.abs(value - target) < Math.abs(value - best)) best = target
      }
      return best
    }

    let next = doc
    let guide: number | null = null

    if (drag.mode === 'move') {
      let start = Math.max(0, drag.origin.start + seconds)
      // Either edge of the clip may catch; whichever is closer wins.
      const head = catchAt(start)
      const tail = catchAt(start + drag.origin.duration)
      if (head !== null && (tail === null || Math.abs(head - start) <= Math.abs(tail - (start + drag.origin.duration)))) {
        start = head
        guide = head
      } else if (tail !== null) {
        start = tail - drag.origin.duration
        guide = tail
      }
      next = moveClip(doc, drag.id, start)
      const delta = start - drag.origin.start
      if (delta !== 0) {
        for (const companion of dragCompanions.current) {
          next = moveClip(next, companion.id, Math.max(0, companion.start + delta))
        }
      }
    }

    if (drag.mode === 'left') {
      const speed = clipSpeed(drag.origin)
      // A left trim can only reach the source's own first frame: `in` covers `in / speed` timeline
      // seconds. A held frame has no such limit — the one frame is the whole content — so it can
      // grow either way.
      const floor = drag.origin.freeze
        ? -(drag.origin.duration - 0.05)
        : -(drag.origin.in / speed)
      const shift = Math.max(floor, Math.min(seconds, drag.origin.duration - 0.05))
      let start = Math.max(0, drag.origin.start + shift)
      const caught = catchAt(start)
      if (caught !== null) {
        start = caught
        guide = caught
      }
      const delta = start - drag.origin.start
      next = trimClip(doc, drag.id, {
        // Timeline seconds become source seconds at the clip's rate — a 2x piece walks two source
        // seconds for every second of head removed.
        in: drag.origin.freeze ? drag.origin.in : Math.max(0, drag.origin.in + delta * speed),
        duration: Math.max(0.05, drag.origin.duration - delta),
      })
      next = moveClip(next, drag.id, start)
    }

    if (drag.mode === 'right') {
      const speed = clipSpeed(drag.origin)
      // A held frame has no source to run out of; a real clip stops at its own last sample.
      const material = drag.origin.freeze ? undefined : sourceLengths.current.get(drag.origin.src)
      const maxEnd =
        material === undefined
          ? Number.POSITIVE_INFINITY
          : drag.origin.start + Math.max(0.05, (material - drag.origin.in) / speed - 1e-6)
      let end = Math.min(drag.origin.start + drag.origin.duration + seconds, maxEnd)
      const caught = catchAt(end)
      if (caught !== null && caught <= maxEnd) {
        end = caught
        guide = caught
      }
      end = Math.min(end, maxEnd)
      next = trimClip(doc, drag.id, { duration: Math.max(0.05, end - drag.origin.start) })
    }

    setSnapGuide(guide)
    setDoc(next)
  }

  const onDrag = (event: React.PointerEvent) => {
    pointerX.current = event.clientX
    applyDragAt(event.clientX)
  }

  // Holding a dragged clip near either edge pages the timeline, so a long cut can be crossed in
  // one gesture. The speed ramps with depth into the 48px zone, like the reference's auto-scroll.
  React.useEffect(() => {
    if (!drag) return
    let raf = 0
    const tick = () => {
      const scroller = timelineScrollRef.current
      if (scroller) {
        const rect = scroller.getBoundingClientRect()
        const left = rect.left + 104
        const x = pointerX.current
        let delta = 0
        if (x < left + 48) delta = -Math.min(18, 2 + (left + 48 - x) / 4)
        else if (x > rect.right - 48) delta = Math.min(18, 2 + (x - rect.right + 48) / 4)
        if (delta !== 0) {
          const before = scroller.scrollLeft
          scroller.scrollLeft = Math.max(0, before + delta)
          if (scroller.scrollLeft !== before) applyDragAtRef.current(pointerX.current)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [drag])

  React.useEffect(() => {
    applyDragAtRef.current = applyDragAt
  })

  /**
   * Finish a gesture: a press that never moved anything is a selection, not an edit, so it must
   * not spend an undo step or a write. A real change is committed with the document the gesture
   * started from as its undo state.
   */
  const commitGesture = React.useCallback(
    (next: EditDocument | null) => {
      const before = gestureStart.current
      if (!next) {
        gestureStart.current = null
        return
      }
      if (!before || JSON.stringify(next) === JSON.stringify(before)) {
        gestureStart.current = null
        return
      }
      commit(next)
    },
    [commit],
  )

  const endDrag = () => {
    if (!drag) return
    dragCompanions.current = []
    setDrag(null)
    setSnapGuide(null)
    commitGesture(docRef.current)
  }

  // ── Overlay track gestures ───────────────────────────────────────────────────────────────
  /** A subtitle block dragged along its lane: the window moves, the words stay. */
  const [overlayDrag, setOverlayDrag] = React.useState<{
    id: string
    x: number
    start: number
  } | null>(null)

  const beginOverlayDrag = (event: React.PointerEvent, overlay: EditOverlay) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    gestureStart.current = docRef.current
    setSelectedOverlay(overlay.id)
    clearClipSelection()
    setPlaying(false)
    setTab(overlay.kind === 'media' ? 'graphics' : 'text')
    setOverlayDrag({ id: overlay.id, x: event.clientX, start: overlay.start })
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onOverlayDrag = (event: React.PointerEvent) => {
    if (!overlayDrag) return
    const current = docRef.current
    if (!current) return
    let start = Math.max(0, overlayDrag.start + (event.clientX - overlayDrag.x) / pxPerSecond)
    if (snap) {
      const threshold = 10 / pxPerSecond
      const targets = [
        0,
        playhead,
        ...clipsOf(current).flatMap((clip) => [clip.start, clip.start + clip.duration]),
        ...current.overlays
          .filter((overlay) => overlay.id !== overlayDrag.id)
          .flatMap((overlay) => [overlay.start, overlay.start + overlay.duration]),
      ]
      let caught: number | null = null
      for (const target of targets) {
        if (Math.abs(start - target) > threshold) continue
        if (caught === null || Math.abs(start - target) < Math.abs(start - caught)) caught = target
      }
      if (caught !== null) start = caught
      setSnapGuide(caught)
    }
    setDoc(updateOverlay(current, overlayDrag.id, { start }))
  }

  const endOverlayDrag = () => {
    if (!overlayDrag) return
    setOverlayDrag(null)
    setSnapGuide(null)
    commitGesture(docRef.current)
  }

  /** Clicking an empty part of an overlay lane moves the playhead there. */
  const seekOverlayLane = (event: React.PointerEvent) => {
    if (event.target !== event.currentTarget) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setPlaying(false)
    seekPlayhead(Math.max(0, (event.clientX - rect.left) / pxPerSecond))
    setSelectedOverlay(null)
    clearClipSelection()
  }

  /**
   * Marquee selection: press an empty part of the timeline and drag a box. A press that never
   * moves is the ordinary seek; a real box selects every clip it touches (Shift/Ctrl/Cmd adds).
   * Like the reference, the box is measured in the timeline's own coordinates, so scrolling or
   * zoom does not move the selection out from under the pointer.
   */
  const [marquee, setMarquee] = React.useState<{
    startX: number
    startY: number
    currentX: number
    currentY: number
    additive: boolean
  } | null>(null)
  const marqueeRef = React.useRef<typeof marquee>(null)
  /** The clip menu: right-clicking a clip offers the edits the toolbar already has. */
  const [clipMenu, setClipMenu] = React.useState<{ id: string; x: number; y: number } | null>(null)
  /** The overlay menu: the same idea for subtitles and graphics. */
  const [overlayMenu, setOverlayMenu] = React.useState<{ id: string; x: number; y: number } | null>(null)

  const openClipMenu = (event: React.MouseEvent, clip: EditClip) => {
    event.preventDefault()
    event.stopPropagation()
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    selectClips(additive ? [...selectedIds, clip.id] : [clip.id])
    setSelectedOverlay(null)
    setOverlayMenu(null)
    setClipMenu({
      id: clip.id,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 210),
    })
  }

  const openOverlayMenu = (event: React.MouseEvent, overlay: EditOverlay) => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedOverlay(overlay.id)
    clearClipSelection()
    setClipMenu(null)
    setTab(overlay.kind === 'media' ? 'graphics' : 'text')
    setOverlayMenu({
      id: overlay.id,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 120),
    })
  }

  const beginMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-clip],[data-overlay],[data-playhead],[data-timeline-ruler]')) return
    const element = event.currentTarget
    const box = element.getBoundingClientRect()
    const next = {
      startX: event.clientX - box.left,
      startY: event.clientY - box.top,
      currentX: event.clientX - box.left,
      currentY: event.clientY - box.top,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
    }
    marqueeRef.current = next
    setMarquee(next)
    element.setPointerCapture(event.pointerId)
    const move = (pointer: PointerEvent) => {
      const current = marqueeRef.current
      if (!current) return
      const updated = {
        ...current,
        currentX: pointer.clientX - box.left,
        currentY: pointer.clientY - box.top,
      }
      marqueeRef.current = updated
      setMarquee(updated)
    }
    const end = (pointer: PointerEvent | null) => {
      const current = marqueeRef.current
      marqueeRef.current = null
      setMarquee(null)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', cancel)
      if (!current || !pointer) return
      const dragged =
        Math.abs(current.currentX - current.startX) > 3 || Math.abs(current.currentY - current.startY) > 3
      if (!dragged) return
      const left = Math.min(current.startX, current.currentX)
      const right = Math.max(current.startX, current.currentX)
      const top = Math.min(current.startY, current.currentY)
      const bottom = Math.max(current.startY, current.currentY)
      const boxNow = element.getBoundingClientRect()
      const hitsIn = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector))
          .filter((node) => {
            const rect = node.getBoundingClientRect()
            const local = {
              left: rect.left - boxNow.left,
              right: rect.right - boxNow.left,
              top: rect.top - boxNow.top,
              bottom: rect.bottom - boxNow.top,
            }
            return local.left < right && local.right > left && local.top < bottom && local.bottom > top
          })
      const clipHits = hitsIn('[data-clip]')
        .map((node) => node.dataset.clip)
        .filter((id): id is string => !!id)
      const overlayHits = hitsIn('[data-overlay]')
        .map((node) => node.dataset.overlay)
        .filter((id): id is string => !!id)
      selectClips(current.additive ? [...selectedIds, ...clipHits] : clipHits)
      if (overlayHits.length > 0) setSelectedOverlay(overlayHits[overlayHits.length - 1]!)
      else if (!current.additive) setSelectedOverlay(null)
    }
    const up = (pointer: PointerEvent) => end(pointer)
    const cancel = () => end(null)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', cancel)
  }

  const split = React.useCallback(() => {
    const doc = docRef.current
    if (!doc) return
    const ids = selectedIds.length > 0 ? selectedIds : current?.clip.id ? [current.clip.id] : []
    if (ids.length === 0) return
    let next = doc
    for (const id of ids) next = splitClip(next, id, playhead)
    if (next !== doc) commit(next)
  }, [commit, current?.clip.id, playhead, selectedIds])

  const removeSelected = React.useCallback(() => {
    const current = docRef.current
    const ids = selectedIds.length > 0 ? selectedIds : selected ? [selected] : []
    if (!current || ids.length === 0) return
    let next = current
    for (const id of ids) next = removeClip(next, id)
    commit(next)
    clearClipSelection()
  }, [clearClipSelection, commit, selected, selectedIds])

  const saveNow = React.useCallback(() => {
    const current = docRef.current
    if (!current) return
    if (timer.current) clearTimeout(timer.current)
    void write(current)
  }, [write])

  const copySelection = React.useCallback(
    (mode: 'copy' | 'cut') => {
      const current = docRef.current
      const ids = selectedIds.length > 0 ? selectedIds : selected ? [selected] : []
      if (!current || ids.length === 0) return
      const picked: Array<{ clip: EditClip; trackId: string }> = []
      for (const track of current.tracks) {
        for (const clip of track.clips) {
          if (ids.includes(clip.id)) picked.push({ clip, trackId: track.id })
        }
      }
      if (picked.length === 0) return
      clipboard.current = picked.map((item) => ({
        clip: { ...item.clip },
        trackId: item.trackId,
      }))
      if (mode !== 'cut') return
      let next = current
      for (const item of picked) next = removeClip(next, item.clip.id)
      commit(next)
      clearClipSelection()
    },
    [clearClipSelection, commit, selected, selectedIds],
  )

  const pasteClipboard = React.useCallback(() => {
    const current = docRef.current
    if (!current || clipboard.current.length === 0) return
    const anchor = Math.min(...clipboard.current.map((item) => item.clip.start))
    const created: string[] = []
    let next = current
    for (const item of clipboard.current) {
      const track =
        next.tracks.find((candidate) => candidate.id === item.trackId) ??
        next.tracks.find((candidate) => candidate.kind === 'video') ??
        next.tracks[0]
      if (!track) return
      const pasted: EditClip = {
        ...item.clip,
        id: newClipId(),
        start: Math.max(0, playhead + item.clip.start - anchor),
      }
      created.push(pasted.id)
      next = {
        ...next,
        tracks: next.tracks.map((candidate) =>
          candidate.id === track.id
            ? { ...candidate, clips: [...candidate.clips, pasted] }
            : candidate,
        ),
      }
    }
    commit(next)
    selectClips(created)
  }, [commit, playhead, selectClips])

  const trimToPlayhead = React.useCallback(
    (edge: 'head' | 'tail') => {
      const current = docRef.current
      const ids = selectedIds.length > 0 ? selectedIds : selected ? [selected] : []
      if (!current || ids.length === 0) return
      let next = current
      let changed = false
      for (const id of ids) {
        const clip = findClip(next, id)
        if (!clip) continue
        const end = clip.start + clip.duration
        if (playhead <= clip.start + 0.001 || playhead >= end - 0.001) continue
        next = trimEdges(
          next,
          id,
          edge === 'head' ? { head: playhead - clip.start } : { tail: end - playhead },
        )
        changed = true
      }
      if (changed) commit(next)
    },
    [commit, playhead, selected, selectedIds],
  )

  const selectAllClips = React.useCallback(() => {
    const current = docRef.current
    if (!current) return
    selectClips(clipsOf(current).map((clip) => clip.id))
    setSelectedOverlay(null)
  }, [selectClips])

  const fitTimeline = React.useCallback(() => {
    const current = docRef.current
    const total = current ? durationOf(current) : 0
    const width = surfaceRef.current?.clientWidth ?? 0
    if (!current || total <= 0 || width < 80) return
    // `zoomTo` clamps to the slider's range; the visible width is the timeline minus headers.
    zoomTo((width - 140) / total)
  }, [zoomTo])

  /** `runExport` is declared below, so the key handler reaches it through a ref. */
  const runExportRef = React.useRef<((audioOnly: boolean) => void) | null>(null)

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A cut stays mounted behind another tab (its undo history is worth more than a remount),
      // so a hidden surface must not answer for the window — not Space, not S, not Ctrl+Z.
      if (!active) return
      const target = event.target instanceof Element ? (event.target as HTMLElement) : null
      // A key belongs to whoever has focus. `tagName` is not enough on its own: the assistant's
      // composer is a contentEditable div (RichTextInput), not a textarea, so Space there is a
      // Space and not the play button — and `s` is a letter, not a split.
      const ownsKeys = !!target && (
        target.isContentEditable
        || /INPUT|TEXTAREA|SELECT/.test(target.tagName)
        || !!target.closest('button,[role="button"],a')
      )
      if (ownsKeys) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (clipMenu || overlayMenu) {
          setClipMenu(null)
          setOverlayMenu(null)
          return
        }
        if (shortcutsOpen) {
          setShortcutsOpen(false)
          return
        }
        if (selectedOverlay) {
          setSelectedOverlay(null)
          return
        }
        clearClipSelection()
        return
      }
      const mod = event.metaKey || event.ctrlKey
      // Chords first: a document command must never be mistaken for a tool letter.
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveNow()
        return
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        runExportRef.current?.(false)
        return
      }
      if (mod && event.key === '0') {
        event.preventDefault()
        fitTimeline()
        return
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAllClips()
        return
      }
      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        copySelection('copy')
        return
      }
      if (mod && event.key.toLowerCase() === 'x') {
        event.preventDefault()
        copySelection('cut')
        return
      }
      if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        pasteClipboard()
        return
      }
      if (!mod && event.key === '?') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (!mod && event.key.toLowerCase() === 't') {
        event.preventDefault()
        addTextOverlay('title')
        return
      }
      if (!mod && (event.key.toLowerCase() === 'q' || event.key.toLowerCase() === 'w')) {
        event.preventDefault()
        trimToPlayhead(event.key.toLowerCase() === 'q' ? 'head' : 'tail')
        return
      }
      // In / out points bound the export. Shift clears the side, and setting one past the other
      // drops the conflicting bound so the range is always valid.
      if (!mod && (event.key.toLowerCase() === 'i' || event.key.toLowerCase() === 'o')) {
        event.preventDefault()
        setPlaying(false)
        const at = Math.max(0, playheadRef.current)
        if (event.key.toLowerCase() === 'i') {
          if (event.shiftKey) {
            setInPoint(null)
            return
          }
          setInPoint(at)
          setOutPoint((current) => (current !== null && current <= at ? null : current))
        } else {
          if (event.shiftKey) {
            setOutPoint(null)
            return
          }
          setOutPoint(at)
          setInPoint((current) => (current !== null && current >= at ? null : current))
        }
        return
      }
      // M drops a named point at the playhead; Shift+M removes the nearest one.
      if (!mod && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        const current = docRef.current
        if (!current) return
        const at = playheadRef.current
        if (event.shiftKey) {
          let nearest: { id: string; distance: number } | null = null
          for (const marker of markersOf(current)) {
            const distance = Math.abs(marker.time - at)
            if (distance <= 0.15 && (!nearest || distance < nearest.distance)) {
              nearest = { id: marker.id, distance }
            }
          }
          if (nearest) commit(removeMarker(current, nearest.id))
          return
        }
        commit(addMarker(current, { time: at }))
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        setPlaying((value) => !value)
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        setPlaying(false)
        const frames = event.shiftKey ? fps : 1
        const step = ((event.key === 'ArrowRight' ? 1 : -1) * frames) / fps
        seekPlayhead((previous) => Math.max(0, Math.min(durationOf(docRef.current ?? emptyDocument('x')), previous + step)))
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        setPlaying(false)
        const step = event.key === 'ArrowUp' ? -5 : 5
        seekPlayhead((previous) =>
          Math.max(0, Math.min(durationOf(docRef.current ?? emptyDocument('x')), previous + step)),
        )
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        setPlaying(false)
        seekPlayhead(event.key === 'Home' ? 0 : durationOf(docRef.current ?? emptyDocument('x')))
        return
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        setPlaying(false)
        const edges = clipsOf(docRef.current ?? emptyDocument('x'))
          .flatMap((clip) => [clip.start, clip.start + clip.duration])
          .sort((a, b) => a - b)
        const at = playheadRef.current
        const target =
          event.key === '['
            ? [...edges].reverse().find((edge) => edge < at - 1e-3)
            : edges.find((edge) => edge > at + 1e-3)
        if (target !== undefined) seekPlayhead(target)
        return
      }
      if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
        event.preventDefault()
        const inwards = event.key === '+' || event.key === '='
        zoomTo(pxPerSecond * (inwards ? 1.25 : 0.8))
        return
      }
      if (event.key.toLowerCase() === 'n' && !mod) {
        event.preventDefault()
        setSnap((value) => !value)
        return
      }
      if (event.key.toLowerCase() === 's' && !mod) {
        event.preventDefault()
        split()
        return
      }
      if (mod && event.key.toLowerCase() === 'd' && selectedIds.length > 0) {
        event.preventDefault()
        const current = docRef.current
        if (!current) return
        let next = current
        const created: string[] = []
        for (const id of selectedIds) {
          const before = new Set(clipsOf(next).map((clip) => clip.id))
          next = duplicateClip(next, id)
          for (const clip of clipsOf(next)) {
            if (!before.has(clip.id)) created.push(clip.id)
          }
        }
        commit(next)
        selectClips(created)
        return
      }
      if (event.key === 'Delete' && event.shiftKey && (selectedIds.length > 0 || selected)) {
        event.preventDefault()
        const current = docRef.current
        if (!current) return
        const ids = selectedIds.length > 0 ? selectedIds : [selected!]
        let next = current
        for (const id of ids) next = rippleDelete(next, id)
        commit(next)
        clearClipSelection()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOverlay) {
        event.preventDefault()
        const current = docRef.current
        if (current) commit(removeOverlay(current, selectedOverlay))
        setSelectedOverlay(null)
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedIds.length > 0 || selected)) {
        event.preventDefault()
        removeSelected()
        return
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      }
    }
    const surface = surfaceRef.current
    if (!surface) return
    surface.addEventListener('keydown', onKey)
    return () => surface.removeEventListener('keydown', onKey)
  }, [active, addTextOverlay, clearClipSelection, clipMenu, commit, copySelection, fitTimeline, fps, overlayMenu, pasteClipboard, pxPerSecond, redo, removeSelected, selectAllClips, selectClips, selected, selectedIds, selectedOverlay, shortcutsOpen, split, saveNow, trimToPlayhead, undo, zoomTo])

  /**
   * The surface owns the keys, so it takes focus when this tab becomes active. Nothing is bound on
   * `window`: a key is answered only while focus is inside this editor, and controls keep theirs.
   */
  React.useEffect(() => {
    if (!active) return
    const surface = surfaceRef.current
    if (!surface) return
    const focused = document.activeElement
    if (focused && surface.contains(focused)) return
    surface.focus({ preventScroll: true })
  }, [active, path])

  /**
   * Keyboard shortcuts belong to this surface, so a press on a non-interactive part of it moves
   * focus into it. Controls keep their own focus (an input or a button is not hijacked).
   */
  const focusSurface = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('input,textarea,select,button,[contenteditable="true"],[role="button"],[role="slider"]')) {
      return
    }
    surfaceRef.current?.focus({ preventScroll: true })
  }
  const runExport = React.useCallback(async (audioOnly: boolean, container: 'mp4' | 'webm' | 'mp3' = 'mp4') => {
    const doc = docRef.current
    if (!doc || (clipsOf(doc).length === 0 && doc.overlays.length === 0)) return
    // In/out points export a slice of the cut, with the same renderer: clips crossing the head
    // advance their source window and everything is placed from 0.
    const hasRange = inPoint !== null || outPoint !== null
    const rangeStart = Math.max(0, inPoint ?? 0)
    const rangeEnd = Math.min(outPoint ?? durationOf(doc), durationOf(doc))
    if (hasRange && rangeEnd <= rangeStart) {
      toast.error(t('edit.rangeInvalid'))
      return
    }
    const exported = hasRange ? sliceDocument(doc, rangeStart, rangeEnd) : doc
    if (clipsOf(exported).length === 0 && exported.overlays.length === 0) {
      toast.error(t('edit.rangeEmpty'))
      return
    }
    const api = window.electronAPI as unknown as {
      editExport?: (request: {
        clips: Array<{
          path: string
          in: number
          duration: number
          start: number
          kind: 'video' | 'image' | 'audio'
          track: number
          volume?: number
          muted?: boolean
          fadeIn?: number
          fadeOut?: number
          automation?: VolumePoint[]
          transform?: ClipTransform
          opacity?: number
          /** Colour grading; the renderer applies it as the same CSS filter string. */
          effect?: ClipEffect
          /** Tone of the clip's own sound; the renderer builds the same EQ chain. */
          audioEffect?: AudioEffect
          speed?: number
          transition?: { kind: TransitionKind; duration: number }
          /** A hidden video track keeps its sound; the render draws no picture for it. */
          hidden?: boolean
        }>
        overlays: EditOverlay[]
        width: number
        height: number
        fps: number
        outPath: string
        container?: 'mp4' | 'webm' | 'mp3'
        audioOnly?: boolean
      }) => Promise<{ ok: boolean; message?: string }>
      onEditExportProgress?: (callback: (ratio: number) => void) => () => void
    }
    if (!api.editExport) {
      toast.error(t('edit.exportUnavailable'))
      return
    }
    // Every track goes into the render: the picture track supplies frames, the sound tracks (and
    // the audio inside video clips) are mixed. `start` is kept, so a gap stays a gap.
    // The flattening is shared with the agent's `export`, so both doors render the same film.
    const plan = exportPlanOf(exported, (src) => absolute(projectFolder, src))
    const off = api.onEditExportProgress?.((ratio) => setExportProgress(ratio))
    setExportProgress(0)
    try {
      const result = await api.editExport({
        ...plan,
        // The render lands beside the cuts it was made from, in the project's `reels/exports/`:
        // it belongs to that project's editing work, not to the generation history or the library.
        outPath: `${projectFolder.replace(/[\\/]+$/, '')}/reels/exports/${doc.name}-${Date.now().toString(36)}.${
          container === 'mp3' ? 'mp3' : audioOnly ? 'm4a' : container
        }`,
        container,
        audioOnly,
      })
      if (result.ok) toast.success(audioOnly ? t('edit.audioExported') : t('edit.exported'))
      else toast.error(result.message ?? t('edit.exportFailed'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      off?.()
      setExportProgress(null)
    }
  }, [projectFolder, t, inPoint, outPoint])

  // The key handler is declared above this callback, so it reaches the exporter through a ref.
  runExportRef.current = runExport

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  const tracks: EditTrack[] = doc.tracks
  const markers = markersOf(doc)
  // The same split SRT uses: a subtitle is words that belong to the dialogue, everything else
  // (title, 花字, picture-in-picture) is a graphic.
  const isSubtitle = (overlay: EditOverlay) =>
    overlay.kind === 'text' && (!overlay.preset || overlay.preset === 'subtitle')
  const subtitleOverlays = doc.overlays.filter(isSubtitle)
  const graphicOverlays = doc.overlays.filter((overlay) => !isSubtitle(overlay))
  const textOverlays = doc.overlays.filter((overlay) => overlay.kind === 'text')
  const mediaOverlays = doc.overlays.filter((overlay) => overlay.kind === 'media')
  const textSelected =
    doc.overlays.find((overlay) => overlay.id === selectedOverlay && overlay.kind === 'text') ?? null
  const mediaSelected =
    doc.overlays.find((overlay) => overlay.id === selectedOverlay && overlay.kind === 'media') ?? null
  const shown = assets.filter((src) => !query || src.toLowerCase().includes(query.toLowerCase()))
  const ratio = doc.settings.width / doc.settings.height
  const aspectId =
    ASPECTS.find((entry) => Math.abs(ratio - entry.ratio) < 0.01)?.id ?? 'custom'

  /** Switch the output shape; typography scales with the height so the look keeps its share. */
  const changeAspect = (id: string) => {
    const current = docRef.current
    const entry = ASPECTS.find((item) => item.id === id)
    if (!current || !entry) return
    commit(resizeComposition(current, aspectSize(entry, current)))
  }

  /** The clip whose sound is controllable: the selection, or the picture under the playhead. */
  const audioClipId = selected ?? current?.clip.id ?? null
  const audioClip = audioClipId ? clipsOf(doc).find((clip) => clip.id === audioClipId) ?? null : null
  const selectedMask = audioClip ? masksForClip(doc, audioClip.id)[0] : undefined
  /** The box as it looks at the playhead — what the sliders edit when the mask is animated. */
  const maskLocal = audioClip
    ? Math.min(audioClip.duration, Math.max(0, playhead - audioClip.start))
    : 0
  const selectedMaskAt = selectedMask ? maskAt(selectedMask, maskLocal) : undefined
  const audioOnSoundTrack = audioClip ? trackOfClip(doc, audioClip.id)?.kind === 'audio' : false
  const audioLevel = audioClip ? clipVolume(audioClip) : 0

  /** A track can trigger a duck only if it is not the one being ducked and it has sound. */
  const ownTrackId = audioClip ? trackOfClip(doc, audioClip.id)?.id : undefined
  const duckingCandidates = doc.tracks.filter(
    (track) => track.id !== ownTrackId && track.clips.length > 0,
  )
  const duckingSourceId = duckingCandidates.some((track) => track.id === duckingSource)
    ? duckingSource
    : duckingCandidates[0]?.id ?? ''

  /** A transition needs the clip immediately before the selected one on the same track. */
  const selectedTrack = audioClip ? trackOfClip(doc, audioClip.id) : undefined
  const previousClip =
    audioClip && selectedTrack
      ? [...selectedTrack.clips]
          .filter(
            (clip) =>
              clip.id !== audioClip.id &&
              Math.abs(clip.start + clip.duration - audioClip.start) < 1e-6,
          )
          .sort((left, right) => left.start - right.start)[0] ?? null
      : null

  /**
   * The trigger track's level across the ducked clip's own window, 50 ticks a second — the same
   * analysis MiniMax does before it writes keyframes.
   */
  const buildDuckingPeaks = async (
    currentDoc: EditDocument,
    target: EditClip,
    sourceTrackId: string,
  ): Promise<Float32Array | null> => {
    const track = currentDoc.tracks.find((candidate) => candidate.id === sourceTrackId)
    if (!track) return null
    const bucketsPerSecond = 50
    const count = Math.max(1, Math.ceil(target.duration * bucketsPerSecond))
    const values = new Float32Array(count)
    let heard = false
    for (const clip of track.clips) {
      const overlapStart = Math.max(clip.start, target.start)
      const overlapEnd = Math.min(clip.start + clip.duration, target.start + target.duration)
      if (overlapEnd <= overlapStart) continue
      const strip = await loadPeaks(clip.src)
      if (!strip || strip.duration <= 0) continue
      heard = true
      const gain = clipVolume(clip)
      for (let index = 0; index < count; index += 1) {
        const time = target.start + index / bucketsPerSecond
        if (time < overlapStart || time >= overlapEnd) continue
        const at = clip.in + (time - clip.start)
        const bucket = Math.min(
          strip.values.length - 1,
          Math.max(0, Math.floor((at / strip.duration) * strip.values.length)),
        )
        const level = (strip.values[bucket] ?? 0) * gain
        if (level > values[index]!) values[index] = level
      }
    }
    return heard ? values : null
  }

  /** Bake the envelope onto the selected clip. The keyframes are what the preview and export use. */
  const applyDucking = async () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip || !duckingSourceId) return
    setDuckingBusy(true)
    try {
      const peaks = await buildDuckingPeaks(currentDoc, audioClip, duckingSourceId)
      if (!peaks) {
        toast.error(t('edit.duckingNoAudio'))
        return
      }
      const amounts = DUCKING_PRESETS[duckingPreset].settings
      const points = duckingEnvelope({
        peaks,
        bucketSeconds: 1 / 50,
        duration: audioClip.duration,
        settings: amounts,
      })
      if (points.length === 0) {
        toast.error(t('edit.duckingNoSpeech'))
        return
      }
      const latest = docRef.current ?? currentDoc
      commit(
        setClipDucking(latest, audioClip.id, { sourceTrackId: duckingSourceId, ...amounts }, points),
      )
      toast.success(t('edit.duckingApplied'))
    } finally {
      setDuckingBusy(false)
    }
  }

  const clearDucking = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(clearClipDucking(currentDoc, audioClip.id))
  }

  /**
   * Cut on the beat: analyse the selected clip's own sound, then cut every track at those
   * moments. Tempo is estimated on the whole source and the grid is moved into this clip's
   * window, so a music bed under the picture drives the cuts — the same rule `reel_tool beats`
   * runs, and the same grid the agent's `auto_edit` arranges on. A source with no steady pulse
   * falls back to its onsets rather than refusing to cut.
   */
  const cutOnBeats = async () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    setBeatBusy(true)
    try {
      // Let the busy state paint: the threshold pass is a few hundred milliseconds on a long
      // track and runs on this thread.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const strip = await loadPeaks(audioClip.src)
      if (!strip || strip.duration <= 0) {
        toast.error(t('edit.beatsNoAudio'))
        return
      }
      const mapped = clipBeatsOf(
        audioClip,
        analyzeBeats(strip.rms, { bucketSeconds: strip.bucketSeconds }),
      )
      const times = mapped.beats.length ? mapped.beats.map((beat) => beat.time) : mapped.onsets
      if (times.length === 0) {
        toast.error(t('edit.beatsNone'))
        return
      }
      commit(cutAt(docRef.current ?? currentDoc, times))
      toast.success(t('edit.beatsDone', { count: times.length }))
    } finally {
      setBeatBusy(false)
    }
  }

  // ── Transform and clip operations (the "adjust" tab) ────────────────────────────────────────
  /** Where the playhead sits inside the selected clip, in clip-local seconds. */
  const clipLocal = audioClip
    ? Math.min(audioClip.duration, Math.max(0, playhead - audioClip.start))
    : 0
  const editVisual = audioClip
    ? clipVisualAt(audioClip, clipLocal)
    : { transform: NEUTRAL_TRANSFORM, opacity: 1 }
  const editTransform = editVisual.transform
  const editOpacity = editVisual.opacity ?? 1
  const clipKeyframes = audioClip?.keyframes ?? []

  /**
   * Write one value into the keyframe at the playhead — creating it when that moment has none.
   * Move the playhead, drag a slider, and the clip remembers what it looked like there.
   */
  const upsertKeyframe = (
    clip: EditClip,
    local: number,
    patch: Partial<ClipTransform> & { opacity?: number },
  ): TransformKeyframe[] => {
    const frames = (clip.keyframes ?? []).slice()
    const at = Math.round(local * 1000) / 1000
    const current = clipVisualAt(clip, at)
    const { opacity, ...transformPatch } = patch
    const nextFrame: TransformKeyframe = {
      time: at,
      transform: { ...current.transform, ...transformPatch },
      ...(opacity !== undefined
        ? { opacity: Math.min(1, Math.max(0, opacity)) }
        : current.opacity !== undefined
          ? { opacity: current.opacity }
          : {}),
    }
    const index = frames.findIndex((frame) => Math.abs(frame.time - at) <= 0.02)
    if (index >= 0) frames[index] = nextFrame
    else frames.push(nextFrame)
    return frames.sort((left, right) => left.time - right.time)
  }

  const updateClipVisual = (patch: Partial<ClipTransform> & { opacity?: number }) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (!gestureStart.current) gestureStart.current = currentDoc
    if (audioClip.keyframes?.length) {
      setDoc(setClipKeyframes(currentDoc, audioClip.id, upsertKeyframe(audioClip, clipLocal, patch)))
      return
    }
    setDoc(setClipTransform(currentDoc, audioClip.id, patch))
  }

  const commitClipVisual = () => {
    const currentDoc = docRef.current
    if (currentDoc) commit(currentDoc)
  }

  /** Sliders repaint while dragging; the commit (one undo step) is `commitClipVisual`. */
  const updateCrop = (patch: Partial<CropRect>) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (!gestureStart.current) gestureStart.current = currentDoc
    setDoc(setClipCrop(currentDoc, audioClip.id, patch))
  }

  const toggleCrop = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(
      setClipCrop(
        currentDoc,
        audioClip.id,
        audioClip.crop ? null : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      ),
    )
  }

  /** A mask is one per clip: adding it again from the panel switches its shape in place. */
  const addMask = (shape: MaskShape) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(setMask(currentDoc, { clipId: audioClip.id, shape }))
  }

  /** Sliders repaint while dragging; `commitMask` is the one undo step. */
  const updateMask = (patch: {
    x?: number
    y?: number
    width?: number
    height?: number
    feather?: number
    expansion?: number
    opacity?: number
    inverted?: boolean
  }) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (!gestureStart.current) gestureStart.current = currentDoc
    const mask = masksForClip(currentDoc, audioClip.id)[0]
    const animated = (mask?.keyframes?.length ?? 0) > 0
    const boxKeys = ['x', 'y', 'width', 'height', 'opacity'] as const
    // Once a mask is animated, moving its box writes a keyframe at the playhead instead of
    // rewriting the whole clip's shape. Feather and expansion stay properties of the mask.
    if (mask && animated && boxKeys.some((key) => patch[key] !== undefined)) {
      const at = Math.min(audioClip.duration, Math.max(0, playheadRef.current - audioClip.start))
      const box = maskAt(mask, at)
      const existing = mask.keyframes!.find((frame) => Math.abs(frame.time - at) < 1e-4)
      const frame: MaskKeyframe = {
        time: at,
        x: patch.x ?? box.x,
        y: patch.y ?? box.y,
        width: patch.width ?? box.width,
        height: patch.height ?? box.height,
        opacity: patch.opacity ?? box.opacity,
        ...(existing?.easing ? { easing: existing.easing } : {}),
      }
      const keyframes = [
        ...mask.keyframes!.filter((item) => Math.abs(item.time - at) >= 1e-4),
        frame,
      ].sort((left, right) => left.time - right.time)
      const { x: _x, y: _y, width: _width, height: _height, opacity: _opacity, ...rest } = patch
      setDoc(setMask(currentDoc, { clipId: audioClip.id, ...rest, keyframes }))
      return
    }
    setDoc(setMask(currentDoc, { clipId: audioClip.id, ...patch }))
  }

  /** Pin the box where it is at the playhead; the next move elsewhere adds the second point. */
  const recordMaskKeyframe = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const mask = masksForClip(currentDoc, audioClip.id)[0]
    if (!mask) return
    const at = Math.min(audioClip.duration, Math.max(0, playheadRef.current - audioClip.start))
    const box = maskAt(mask, at)
    const existing = mask.keyframes?.find((frame) => Math.abs(frame.time - at) < 1e-4)
    const keyframes: MaskKeyframe[] = [
      ...(mask.keyframes ?? []).filter((frame) => Math.abs(frame.time - at) >= 1e-4),
      {
        time: at,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        opacity: box.opacity,
        ...(existing?.easing ? { easing: existing.easing } : {}),
      },
    ].sort((left, right) => left.time - right.time)
    commit(setMask(currentDoc, { clipId: audioClip.id, keyframes }))
  }

  /** Drop the animation and hold the box the playhead currently shows. */
  const clearMaskAnimation = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const mask = masksForClip(currentDoc, audioClip.id)[0]
    if (!mask?.keyframes?.length) return
    const at = Math.min(audioClip.duration, Math.max(0, playheadRef.current - audioClip.start))
    const box = maskAt(mask, at)
    commit(
      setMask(currentDoc, {
        clipId: audioClip.id,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        opacity: box.opacity,
        keyframes: [],
      }),
    )
  }

  const commitMask = () => {
    const currentDoc = docRef.current
    if (currentDoc) commit(currentDoc)
  }

  const removeMask = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(clearMask(currentDoc, audioClip.id))
  }

  /** Hold the frame under the playhead: split the clip and insert a silent still between the halves. */
  const insertFreezeAtPlayhead = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const seconds = Number(freezeSeconds)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      toast.error(t('edit.freezeInvalid'))
      return
    }
    const held = insertFreezeFrame(currentDoc, audioClip.id, playhead, seconds)
    if (!held) {
      toast.error(t('edit.freezeOutside'))
      return
    }
    commit(held)
  }

  const toggleKeyframes = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (audioClip.keyframes?.length) {
      commit(setClipKeyframes(currentDoc, audioClip.id, null))
      return
    }
    const visual = clipVisualAt(audioClip, clipLocal)
    commit(
      setClipKeyframes(currentDoc, audioClip.id, [
        {
          time: clipLocal,
          transform: visual.transform,
          ...(visual.opacity !== undefined ? { opacity: visual.opacity } : {}),
        },
      ]),
    )
  }

  const removeKeyframeAt = (time: number) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const rest = (audioClip.keyframes ?? []).filter((frame) => Math.abs(frame.time - time) > 1e-6)
    commit(setClipKeyframes(currentDoc, audioClip.id, rest.length ? rest : null))
  }

  /**
   * The keyframe the playhead's segment arrives at: easing belongs to that frame, so editing it
   * here changes the curve the user is currently looking at, not an arbitrary one.
   */
  const easingFrame =
    (audioClip?.keyframes ?? []).find((frame) => frame.time >= clipLocal - 1e-6) ??
    audioClip?.keyframes?.[audioClip.keyframes.length - 1]

  const changeEasing = (easing: KeyframeEasing) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip?.keyframes?.length || !easingFrame) return
    commit(
      setClipKeyframes(
        currentDoc,
        audioClip.id,
        audioClip.keyframes.map((frame) =>
          Math.abs(frame.time - easingFrame.time) > 1e-6 ? frame : { ...frame, easing },
        ),
      ),
    )
  }

  const resetTransform = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const cleared = setClipKeyframes(currentDoc, audioClip.id, null)
    commit(setClipTransform(cleared, audioClip.id, { ...NEUTRAL_TRANSFORM, opacity: 1 }))
  }

  // ── Speed (the top of the "adjust" tab) ─────────────────────────────────────────────────────
  const changeSpeed = (speed: number) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip || !Number.isFinite(speed)) return
    commit(setClipSpeed(currentDoc, audioClip.id, speed))
  }

  // ── Colour grading (the "effects" tab) ──────────────────────────────────────────────────────
  const effectValues = resolveEffect(audioClip?.effect)
  const effectRegions = audioClip?.effect?.regions ?? []

  /** A preset replaces the grade; "orignal" clears it. Regional blur is a separate edit and stays. */
  const applyEffectPreset = (preset: EffectPreset) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const regions = audioClip.effect?.regions
    const next: ClipEffect | null =
      preset === 'none'
        ? regions?.length
          ? { regions }
          : null
        : { preset, ...(regions?.length ? { regions } : {}) }
    commit(setClipEffect(currentDoc, audioClip.id, next))
  }

  /** Dragging a slider pins every number, so the look stops following the preset. */
  const updateEffect = (key: keyof ResolvedEffect, value: number) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (!gestureStart.current) gestureStart.current = currentDoc
    setDoc(
      setClipEffect(currentDoc, audioClip.id, {
        ...effectValues,
        [key]: value,
        ...(audioClip.effect?.preset ? { preset: audioClip.effect.preset } : {}),
        ...(effectRegions.length ? { regions: effectRegions } : {}),
      }),
    )
  }

  /** Replace the region list; the grade is left as it is. */
  const writeRegions = (regions: BlurRegion[]) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (!gestureStart.current) gestureStart.current = currentDoc
    const effect: ClipEffect = { ...(audioClip.effect ?? {}) }
    if (regions.length > 0) effect.regions = regions
    else delete effect.regions
    setDoc(setClipEffect(currentDoc, audioClip.id, Object.keys(effect).length > 0 ? effect : null))
  }

  const commitRegions = () => {
    const currentDoc = docRef.current
    if (currentDoc) commit(currentDoc)
  }

  const addRegion = () => {
    writeRegions([
      ...effectRegions,
      { x: 0.68, y: 0.04, w: 0.28, h: 0.12, mode: 'blur', strength: 18 },
    ])
    commitRegions()
  }

  const updateRegion = (index: number, patch: Partial<BlurRegion>) => {
    writeRegions(effectRegions.map((region, position) => (position === index ? { ...region, ...patch } : region)))
  }

  const removeRegion = (index: number) => {
    writeRegions(effectRegions.filter((_, position) => position !== index))
    commitRegions()
  }

  // ── Tone of the clip's own sound (the lower half of the same tab) ────────────────────────────
  const audioEffectValues = resolveAudioEffect(audioClip?.audioEffect)

  /** Sliders publish live and commit once on release, like grading. */
  const updateAudioEffect = (change: Partial<AudioEffect>) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    if (!gestureStart.current) gestureStart.current = currentDoc
    setDoc(setClipAudioEffect(currentDoc, audioClip.id, change))
  }

  const commitAudioEffect = (change: Partial<AudioEffect>) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(setClipAudioEffect(currentDoc, audioClip.id, change))
  }

  const duplicateSelectedClip = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(duplicateClip(currentDoc, audioClip.id))
  }

  const rippleDeleteSelectedClip = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(rippleDelete(currentDoc, audioClip.id))
    clearClipSelection()
  }

  const closeSelectedGap = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(closeGap(currentDoc, audioClip.id))
  }

  const removeAllGaps = () => {
    const currentDoc = docRef.current
    if (!currentDoc) return
    commit(removeGaps(currentDoc))
  }

  const applyTransition = (kind: TransitionKind, duration: number) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(setTransition(currentDoc, audioClip.id, { kind, duration }))
  }

  const removeTransition = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(clearTransition(currentDoc, audioClip.id))
  }

  const changeAudio = (change: { volume?: number; muted?: boolean }, undoable = true) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    commit(setClipAudio(currentDoc, audioClip.id, change), { undoable })
  }

  const toggleMute = () => {
    if (!audioClip) return
    changeAudio({ muted: !audioClip.muted })
  }

  /** "Separate the sound": the picture stays, a new audio clip carries what was inside it. */
  const detachSelectedAudio = () => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const next = detachAudio(currentDoc, audioClip.id)
    if (next === currentDoc) {
      toast.error(t('edit.audioAlreadySeparated'))
      return
    }
    commit(next)
    toast.success(t('edit.audioDetached'))
  }

  /** Dragging the level is a request to hear it, so a muted clip turns its sound back on. */
  const setAudioLevel = (percent: number) => {
    if (!audioClip) return
    if (!gestureStart.current) gestureStart.current = docRef.current
    const currentDoc = docRef.current
    if (!currentDoc) return
    setDoc(
      setClipAudio(currentDoc, audioClip.id, {
        volume: Math.min(1, Math.max(0, percent / 100)),
        ...(audioClip.muted ? { muted: false } : {}),
      }),
    )
  }

  /** Fade in/out, in seconds from each edge — the same envelope the exporter schedules. */
  const setFade = (key: 'fadeIn' | 'fadeOut', raw: string) => {
    const currentDoc = docRef.current
    if (!currentDoc || !audioClip) return
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return
    commit(setClipFade(currentDoc, audioClip.id, key === 'fadeIn' ? { fadeIn: value } : { fadeOut: value }))
  }

  /** Mute/solo belong to the track, so one click silences a whole lane. */
  const toggleTrackAudio = (trackId: string, key: 'muted' | 'solo') => {
    const currentDoc = docRef.current
    const track = currentDoc?.tracks.find((candidate) => candidate.id === trackId)
    if (!currentDoc || !track) return
    commit(
      setTrackAudio(currentDoc, trackId, key === 'muted' ? { muted: !track.muted } : { solo: !track.solo }),
    )
  }

  /** Lock, hide and rename are track properties — the document remembers them, not the panel. */
  const toggleTrackFlag = (trackId: string, key: 'locked' | 'hidden') => {
    const currentDoc = docRef.current
    const track = currentDoc?.tracks.find((candidate) => candidate.id === trackId)
    if (!currentDoc || !track) return
    commit(setTrack(currentDoc, trackId, { [key]: !track[key] }))
  }

  const moveTrackTo = (trackId: string, toIndex: number) => {
    const currentDoc = docRef.current
    if (!currentDoc) return
    commit(moveTrack(currentDoc, trackId, toIndex))
  }

  /** A track can go, with its clips. The last video track stays so the cut keeps a picture. */
  const deleteTrack = (trackId: string) => {
    const currentDoc = docRef.current
    const track = currentDoc?.tracks.find((candidate) => candidate.id === trackId)
    if (!currentDoc || !track) return
    if (track.kind === 'video' && tracksOf(currentDoc, 'video').length === 1) {
      toast.error(t('edit.lastVideoTrack'))
      return
    }
    clearClipSelection()
    commit(removeTrack(currentDoc, trackId))
  }

  const commitTrackName = (trackId: string, name: string) => {
    const currentDoc = docRef.current
    setRenamingTrack(null)
    if (!currentDoc) return
    commit(setTrack(currentDoc, trackId, { name }))
  }

  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      onPointerDownCapture={focusSurface}
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground outline-none"
    >
      {shortcutsOpen ? (
        <div
          className="absolute inset-0 z-50 grid place-items-center bg-background/70 p-6"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-border bg-background p-4 shadow-strong"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium">{t('edit.shortcuts')}</span>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                className="h-6 w-6 rounded text-muted-foreground hover:bg-foreground/[0.06]"
              >
                ×
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
              {SHORTCUT_ROWS.map(([keys, labelKey]) => (
                <React.Fragment key={keys}>
                  <dt className="text-right font-mono text-muted-foreground">{keys}</dt>
                  <dd>{t(labelKey)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
      {/* Top bar: what this is, and the one thing to do with it. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Film className="h-4 w-4 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium">{doc.name}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{timecode(total, fps)}</span>
        <span className="text-[11px] text-muted-foreground/70">
          {save === 'saving'
            ? t('canvas.saving')
            : save === 'error'
              ? t('canvas.saveFailed')
              : save === 'conflict'
                ? t('edit.conflict')
                : ''}
        </span>
        {exportProgress !== null ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {t('edit.exporting')}
            <span className="h-1 w-16 overflow-hidden rounded bg-foreground/15">
              <span
                className="block h-full bg-foreground/70 transition-[width]"
                style={{ width: `${Math.round(exportProgress * 100)}%` }}
              />
            </span>
          </span>
        ) : null}
        {inPoint !== null || outPoint !== null ? (
          <button
            type="button"
            onClick={() => {
              setInPoint(null)
              setOutPoint(null)
            }}
            title={t('edit.clearRange')}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-amber-400/60 bg-amber-400/10 px-1.5 text-[10px] tabular-nums text-amber-600 hover:bg-amber-400/20"
          >
            {`${(inPoint ?? 0).toFixed(2)}–${(outPoint ?? total).toFixed(2)}s`}
            <span className="text-[12px] leading-none">×</span>
          </button>
        ) : null}
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          {t('edit.aspect')}
          <select
            value={aspectId}
            onChange={(event) => changeAspect(event.target.value)}
            className="h-7 rounded-md border border-border/60 bg-transparent px-1 text-[11px] tabular-nums outline-none"
            title={`${doc.settings.width}×${doc.settings.height}`}
          >
            {ASPECTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            {aspectId === 'custom' ? (
              <option value="custom">{`${doc.settings.width}×${doc.settings.height}`}</option>
            ) : null}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          title={t('edit.shortcuts')}
          className="h-7 w-7 shrink-0 rounded-md border border-border/60 text-[11px] text-muted-foreground hover:bg-foreground/[0.05]"
        >
          ?
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded-md bg-foreground px-3 text-[12px] font-medium text-background hover:bg-foreground/90 disabled:opacity-40"
              disabled={
                (clipsOf(doc).length === 0 && doc.overlays.length === 0) || exportProgress !== null
              }
            >
              <Download className="h-3.5 w-3.5" />
              {t('edit.export')}
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem
              disabled={clipsOf(doc).length === 0 && doc.overlays.length === 0}
              onSelect={() => void runExport(false)}
            >
              <Download className="h-4 w-4" />
              {t('edit.export')}
              <DropdownMenuShortcut>MP4</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={clipsOf(doc).length === 0 && doc.overlays.length === 0}
              onSelect={() => void runExport(true)}
            >
              <Music2 className="h-4 w-4" />
              {t('edit.exportAudio')}
              <DropdownMenuShortcut>M4A</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={clipsOf(doc).length === 0 && doc.overlays.length === 0}
              onSelect={() => void runExport(true, 'mp3')}
            >
              <AudioLines className="h-4 w-4" />
              {t('edit.exportMp3')}
              <DropdownMenuShortcut>MP3</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="items-start"
              disabled={clipsOf(doc).length === 0}
              onSelect={() => void exportJianying()}
            >
              <Clapperboard className="mt-0.5 h-4 w-4" />
              <div className="flex min-w-0 flex-col">
                <span>{t('edit.jianying')}</span>
                <span className="whitespace-normal text-[11px] leading-snug text-muted-foreground">
                  {t('edit.jianyingHint')}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="items-start"
              disabled={clipsOf(doc).length === 0}
              onSelect={() => void exportFcpxml()}
            >
              <FileCode className="mt-0.5 h-4 w-4" />
              <div className="flex min-w-0 flex-col">
                <span>{t('edit.exportProject')}</span>
                <span className="whitespace-normal text-[11px] leading-snug text-muted-foreground">
                  {t('edit.exportProjectHint')}
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {external !== null ? (
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-foreground/[0.04] px-3 text-[11px] hover:bg-foreground/[0.07]"
          onClick={() => {
            void window.electronAPI
              .readFile(path)
              .then((text) => adoptExternal(JSON.parse(text)))
              .catch(() => undefined)
          }}
        >
          {t('edit.changedOutside')}
        </button>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Media column: the project's own assets, searchable, one click to place. */}
        <div className="flex w-[232px] shrink-0 flex-col border-r border-border/60">
          <div className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border/60 px-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={`flex h-12 w-full flex-col items-center justify-center gap-1 rounded-md text-[10px] ${
                  tab === entry.id
                    ? 'bg-foreground/[0.08] text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/[0.04]'
                }`}
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </div>

          {tab === 'media' ? (
            <>
              <div className="flex shrink-0 items-center gap-1.5 px-2 py-2">
                <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground">
                  <Search className="h-3 w-3 shrink-0" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('edit.searchMedia')}
                    className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
                  />
                </div>
                <button
                  type="button"
                  className="grid h-7 w-7 place-items-center rounded-md border border-border/60 text-muted-foreground hover:bg-foreground/[0.05]"
                  onClick={() => fileInput.current?.click()}
                  title={t('edit.addClip')}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* The selected clip's own sound. A video carries it inside the file; separating it
                  moves it to an audio track so picture and sound can be trimmed apart. */}
              {audioClip && !IMAGE.test(audioClip.src) ? (
                <div className="shrink-0 space-y-1.5 border-b border-border/60 px-2 pb-2 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate" title={audioClip.src}>
                      {nameOf(audioClip.src)}
                    </span>
                    {audioOnSoundTrack ? (
                      <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[9px] text-muted-foreground">
                        {t('edit.audioClip')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={detachSelectedAudio}
                        title={t('edit.detachAudio')}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded border border-border/60 text-muted-foreground hover:bg-foreground/[0.05]"
                      >
                        <AudioLines className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={toggleMute}
                      title={audioClip.muted ? t('edit.unmute') : t('edit.mute')}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded border border-border/60 text-muted-foreground hover:bg-foreground/[0.05]"
                    >
                      {audioClip.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(audioLevel * 100)}
                      onChange={(event) => setAudioLevel(Number(event.target.value))}
                      onPointerUp={() => {
                        const currentDoc = docRef.current
                        if (currentDoc) commit(currentDoc)
                      }}
                      onKeyUp={() => {
                        const currentDoc = docRef.current
                        if (currentDoc) commit(currentDoc)
                      }}
                      title={t('edit.volume')}
                      className="h-1 min-w-0 flex-1 accent-foreground"
                    />
                    <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                      {Math.round(audioLevel * 100)}%
                    </span>
                  </div>
                  {/* Fades are seconds from each edge; the preview and the export share the ramp. */}
                  <div className="flex items-center gap-1.5">
                    <span className="w-12 shrink-0 text-muted-foreground">{t('edit.fade')}</span>
                    <input
                      key={`fade-in-${audioClip.id}-${audioClip.fade?.fadeIn ?? 0}`}
                      type="number"
                      min={0}
                      step={0.1}
                      defaultValue={audioClip.fade?.fadeIn ?? 0}
                      onBlur={(event) => setFade('fadeIn', event.target.value)}
                      title={t('edit.fadeIn')}
                      className={`${inputClass} w-12`}
                    />
                    <span className="shrink-0 text-muted-foreground">/</span>
                    <input
                      key={`fade-out-${audioClip.id}-${audioClip.fade?.fadeOut ?? 0}`}
                      type="number"
                      min={0}
                      step={0.1}
                      defaultValue={audioClip.fade?.fadeOut ?? 0}
                      onBlur={(event) => setFade('fadeOut', event.target.value)}
                      title={t('edit.fadeOut')}
                      className={`${inputClass} w-12`}
                    />
                    <span className="shrink-0 text-[9px] text-muted-foreground">s</span>
                  </div>
                  {/* Ducking: analyse the chosen track, bake the result as keyframes. */}
                  {duckingCandidates.length > 0 ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        <span className="w-12 shrink-0 text-muted-foreground">{t('edit.ducking')}</span>
                        <select
                          value={duckingSourceId}
                          onChange={(event) => setDuckingSource(event.target.value)}
                          className={`${inputClass} flex-1`}
                          title={t('edit.duckingSource')}
                        >
                          {duckingCandidates.map((track) => (
                            <option key={track.id} value={track.id}>
                              {track.id}
                            </option>
                          ))}
                        </select>
                        <select
                          value={duckingPreset}
                          onChange={(event) => setDuckingPreset(event.target.value as DuckingPreset)}
                          className={`${inputClass} shrink-0`}
                        >
                          {(Object.keys(DUCKING_PRESETS) as DuckingPreset[]).map((id) => (
                            <option key={id} value={id}>
                              {DUCKING_PRESETS[id].label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5 pl-12">
                        <button
                          type="button"
                          disabled={duckingBusy || !duckingSourceId}
                          onClick={() => void applyDucking()}
                          className="flex h-6 items-center gap-1 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05] disabled:opacity-40"
                        >
                          {duckingBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          {audioClip.ducking ? t('edit.duckingRedo') : t('edit.duckingApply')}
                        </button>
                        {audioClip.ducking ? (
                          <button
                            type="button"
                            onClick={clearDucking}
                            className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                          >
                            {t('edit.duckingClear')}
                          </button>
                        ) : null}
                        {audioClip.automation?.length ? (
                          <span className="text-[9px] tabular-nums text-muted-foreground">
                            {audioClip.automation.length} pts
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                  {/* Beat cutting: the selected clip's sound sets the grid for every track. */}
                  <div className="flex items-center gap-1.5">
                    <span className="w-12 shrink-0 text-muted-foreground">{t('edit.beats')}</span>
                    <button
                      type="button"
                      disabled={beatBusy}
                      onClick={() => void cutOnBeats()}
                      className="flex h-6 items-center gap-1 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05] disabled:opacity-40"
                      title={t('edit.beatsHint')}
                    >
                      {beatBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {t('edit.beatsApply')}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
                {shown.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
                    <div className="grid h-12 w-12 place-items-center rounded-lg border border-border/60 text-muted-foreground">
                      <Film className="h-5 w-5" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-[12px]">{t('edit.noMedia')}</div>
                      <div className="text-[10px] leading-relaxed text-muted-foreground">{t('edit.dropHint')}</div>
                    </div>
                    <button
                      type="button"
                      className="h-7 rounded-md border border-border/60 px-3 text-[11px] hover:bg-foreground/[0.05]"
                      onClick={() => fileInput.current?.click()}
                    >
                      {t('edit.importMedia')}
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {shown.map((src) => {
                      const preview = IMAGE.test(src) ? urlOf(src) : null
                      return (
                        <button
                          key={src}
                          type="button"
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData('text/craft-media', src)
                            event.dataTransfer.effectAllowed = 'copy'
                          }}
                          className="group relative aspect-video cursor-grab overflow-hidden rounded-md border border-border/60 bg-foreground/[0.04] hover:border-foreground/50 active:cursor-grabbing"
                          onClick={() => void insert([src])}
                          title={src}
                        >
                          {preview ? (
                            <img src={preview} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="grid h-full w-full place-items-center text-muted-foreground">
                              {AUDIO.test(src) ? <Music2 className="h-4 w-4" /> : <Film className="h-4 w-4" />}
                            </span>
                          )}
                          <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-left text-[9px] text-white">
                            {nameOf(src)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          ) : tab === 'text' ? (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2">
                {(
                  [
                    ['subtitle', t('edit.subtitle')],
                    ['neon', t('edit.flowerText')],
                    ['title', t('edit.titleText')],
                  ] as Array<[TextPreset, string]>
                ).map(([preset, label]) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => addTextOverlay(preset)}
                    className="h-7 rounded-md border border-border/60 px-2 text-[11px] hover:bg-foreground/[0.05]"
                  >
                    + {label}
                  </button>
                ))}
                <span className="mx-0.5 h-4 w-px bg-border" />
                <button
                  type="button"
                  onClick={() => srtInput.current?.click()}
                  className="h-7 rounded-md border border-border/60 px-2 text-[11px] hover:bg-foreground/[0.05]"
                >
                  {t('edit.importSrt')}
                </button>
                <button
                  type="button"
                  onClick={() => void exportSubtitles()}
                  className="h-7 rounded-md border border-border/60 px-2 text-[11px] hover:bg-foreground/[0.05]"
                >
                  {t('edit.exportSubtitles')}
                </button>
              </div>
              {/* 花字 gallery: the same catalog the agent names in `add_overlay.template`, drawn
                  from the same fields the canvas paints, so a thumbnail cannot drift. */}
              <div className="flex shrink-0 gap-1 overflow-x-auto px-2 pb-1">
                {TEXT_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    title={`${template.label} · ${template.style.fontSize ?? 48}px`}
                    onClick={() => addTemplateOverlay(template)}
                    className="relative h-12 w-20 shrink-0 overflow-hidden rounded border border-border/60 bg-black/60 hover:border-foreground/50"
                  >
                    <span
                      className="absolute inset-0 grid place-items-center whitespace-pre-wrap px-1 text-center leading-tight"
                      style={{
                        color: template.style.color ?? '#ffffff',
                        fontSize: 10,
                        fontWeight: template.style.bold ? 700 : 400,
                        fontStyle: template.style.italic ? 'italic' : 'normal',
                        WebkitTextStroke: template.style.strokeColor
                          ? `0.3px ${template.style.strokeColor}`
                          : undefined,
                        textShadow: template.style.shadowColor
                          ? `0 0 4px ${template.style.shadowColor}`
                          : undefined,
                        background: template.style.backgroundColor,
                      }}
                    >
                      {template.label}
                    </span>
                  </button>
                ))}
              </div>
              {/* Subtitle batches: shift, find/replace, dedupe and one style for every line. */}
              <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1 text-[10px]">
                <input
                  value={shiftSeconds}
                  onChange={(event) => setShiftSeconds(event.target.value)}
                  className={`${inputClass} w-12`}
                  title={t('edit.subtitleShift')}
                />
                <button
                  type="button"
                  onClick={shiftAllSubtitles}
                  className="h-6 rounded border border-border/60 px-1.5 hover:bg-foreground/[0.05]"
                >
                  {t('edit.subtitleShiftApply')}
                </button>
                <input
                  value={findText}
                  onChange={(event) => setFindText(event.target.value)}
                  placeholder={t('edit.subtitleFind')}
                  className={`${inputClass} w-16`}
                />
                <input
                  value={replaceValue}
                  onChange={(event) => setReplaceValue(event.target.value)}
                  placeholder={t('edit.subtitleReplace')}
                  className={`${inputClass} w-16`}
                />
                <button
                  type="button"
                  onClick={replaceAllSubtitles}
                  className="h-6 rounded border border-border/60 px-1.5 hover:bg-foreground/[0.05]"
                >
                  {t('edit.subtitleReplaceApply')}
                </button>
                <button
                  type="button"
                  onClick={dedupeAllSubtitles}
                  className="h-6 rounded border border-border/60 px-1.5 hover:bg-foreground/[0.05]"
                >
                  {t('edit.subtitleDedupe')}
                </button>
                <button
                  type="button"
                  onClick={styleAllSubtitles}
                  className="h-6 rounded border border-border/60 px-1.5 hover:bg-foreground/[0.05]"
                >
                  {t('edit.subtitleStyleAll')}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
                {textOverlays.length === 0 ? (
                  <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                    {t('edit.noOverlays')}
                  </div>
                ) : (
                  textOverlays.map((overlay) => (
                    <div
                      key={overlay.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedOverlay(overlay.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') setSelectedOverlay(overlay.id)
                      }}
                      className={`mt-1 cursor-pointer rounded-md border px-2 py-1.5 text-[11px] ${
                        selectedOverlay === overlay.id
                          ? 'border-foreground/40 bg-foreground/[0.08]'
                          : 'border-border/60 hover:bg-foreground/[0.04]'
                      }`}
                    >
                      <div className="truncate">{overlay.text || t('edit.overlayText')}</div>
                      <div className="text-[9px] tabular-nums text-muted-foreground">
                        {overlay.start.toFixed(2)}s · {overlay.duration.toFixed(2)}s
                        {overlay.preset ? ` · ${TEXT_PRESETS[overlay.preset].label}` : ''}
                      </div>
                    </div>
                  ))
                )}
                {textSelected ? (
                  <OverlayInspector
                    overlay={textSelected}
                    onChange={(patch) => {
                      const current = docRef.current
                      if (current) commit(updateOverlay(current, textSelected.id, patch))
                    }}
                    onRemove={() => {
                      const current = docRef.current
                      if (current) commit(removeOverlay(current, textSelected.id))
                      setSelectedOverlay(null)
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : tab === 'graphics' ? (
            <>
              <div className="flex shrink-0 items-center gap-1 px-2 py-2">
                <select
                  value={pipSource}
                  onChange={(event) => setPipSource(event.target.value)}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-transparent px-1 text-[11px] outline-none"
                >
                  {assets
                    .filter((src) => VIDEO.test(src) || IMAGE.test(src))
                    .map((src) => (
                      <option key={src} value={src}>
                        {nameOf(src)}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  disabled={!pipSource}
                  onClick={() => addPipOverlay(pipSource)}
                  className="h-7 shrink-0 rounded-md border border-border/60 px-2 text-[11px] hover:bg-foreground/[0.05] disabled:opacity-40"
                >
                  + {t('edit.pip')}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
                {mediaOverlays.length === 0 ? (
                  <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                    {t('edit.noPip')}
                  </div>
                ) : (
                  mediaOverlays.map((overlay) => (
                    <div
                      key={overlay.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedOverlay(overlay.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') setSelectedOverlay(overlay.id)
                      }}
                      className={`mt-1 cursor-pointer rounded-md border px-2 py-1.5 text-[11px] ${
                        selectedOverlay === overlay.id
                          ? 'border-foreground/40 bg-foreground/[0.08]'
                          : 'border-border/60 hover:bg-foreground/[0.04]'
                      }`}
                    >
                      <div className="truncate">{nameOf(overlay.src ?? '')}</div>
                      <div className="text-[9px] tabular-nums text-muted-foreground">
                        {overlay.start.toFixed(2)}s · {overlay.duration.toFixed(2)}s
                      </div>
                    </div>
                  ))
                )}
                {mediaSelected ? (
                  <OverlayInspector
                    overlay={mediaSelected}
                    onChange={(patch) => {
                      const current = docRef.current
                      if (current) commit(updateOverlay(current, mediaSelected.id, patch))
                    }}
                    onLiveChange={(patch) => {
                      const current = docRef.current
                      if (!current) return
                      if (!gestureStart.current) gestureStart.current = current
                      setDoc(updateOverlay(current, mediaSelected.id, patch))
                    }}
                    onLiveEnd={() => {
                      const current = docRef.current
                      if (current) commit(current)
                    }}
                    onRemove={() => {
                      const current = docRef.current
                      if (current) commit(removeOverlay(current, mediaSelected.id))
                      setSelectedOverlay(null)
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : tab === 'transitions' ? (
            audioClip ? (
              <TransitionPanel
                key={audioClip.id}
                clip={audioClip}
                previous={previousClip}
                onApply={applyTransition}
                onClear={removeTransition}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                {t('edit.selectClip')}
              </div>
            )
          ) : tab === 'adjust' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {audioClip ? (
                <>
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2 py-2 text-[11px]">
                    <span className="min-w-0 truncate" title={audioClip.src}>
                      {nameOf(audioClip.src)}
                    </span>
                    <button
                      type="button"
                      onClick={resetTransform}
                      className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-foreground/[0.05]"
                    >
                      {t('edit.resetTransform')}
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
                    <ClipSlider
                      label={t('edit.positionX')}
                      value={editTransform.x}
                      min={-1}
                      max={1}
                      step={0.01}
                      display={`${Math.round(editTransform.x * 100)}%`}
                      onChange={(value) => updateClipVisual({ x: value })}
                      onCommit={commitClipVisual}
                    />
                    <ClipSlider
                      label={t('edit.positionY')}
                      value={editTransform.y}
                      min={-1}
                      max={1}
                      step={0.01}
                      display={`${Math.round(editTransform.y * 100)}%`}
                      onChange={(value) => updateClipVisual({ y: value })}
                      onCommit={commitClipVisual}
                    />
                    <ClipSlider
                      label={t('edit.scale')}
                      value={editTransform.scale}
                      min={0.05}
                      max={4}
                      step={0.01}
                      display={`${Math.round(editTransform.scale * 100)}%`}
                      onChange={(value) => updateClipVisual({ scale: value })}
                      onCommit={commitClipVisual}
                    />
                    <ClipSlider
                      label={t('edit.rotation')}
                      value={editTransform.rotation}
                      min={-180}
                      max={180}
                      step={1}
                      display={`${Math.round(editTransform.rotation)}°`}
                      onChange={(value) => updateClipVisual({ rotation: value })}
                      onCommit={commitClipVisual}
                    />
                    <ClipSlider
                      label={t('edit.radius')}
                      value={editTransform.radius}
                      min={0}
                      max={0.5}
                      step={0.01}
                      display={`${Math.round(editTransform.radius * 100)}%`}
                      onChange={(value) => updateClipVisual({ radius: value })}
                      onCommit={commitClipVisual}
                    />
                    <ClipSlider
                      label={t('edit.opacity')}
                      value={editOpacity}
                      min={0}
                      max={1}
                      step={0.01}
                      display={`${Math.round(editOpacity * 100)}%`}
                      onChange={(value) => updateClipVisual({ opacity: value })}
                      onCommit={commitClipVisual}
                    />
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-muted-foreground">{t('edit.flipX')}</span>
                      <button
                        type="button"
                        onClick={() => updateClipVisual({ flipX: editTransform.flipX !== true })}
                        className={`h-6 rounded border px-2 text-[10px] ${
                          editTransform.flipX
                            ? 'border-foreground/60 bg-foreground/[0.08]'
                            : 'border-border/60 hover:bg-foreground/[0.05]'
                        }`}
                      >
                        {t('edit.flipX')}
                      </button>
                    </div>
                    {/* Cropping is a window onto the source: the picture is fitted as if the crop
                        were the frame, so a 4:3 window of a 16:9 clip fills a 4:3 composition. */}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-muted-foreground">{t('edit.crop')}</span>
                      <button
                        type="button"
                        onClick={toggleCrop}
                        className={`h-6 rounded border px-2 text-[10px] ${
                          audioClip.crop
                            ? 'border-foreground/60 bg-foreground/[0.08]'
                            : 'border-border/60 hover:bg-foreground/[0.05]'
                        }`}
                      >
                        {audioClip.crop ? t('edit.cropClear') : t('edit.cropEnable')}
                      </button>
                    </div>
                    {audioClip.crop ? (
                      <>
                        <ClipSlider
                          label={t('edit.cropX')}
                          value={audioClip.crop.x}
                          min={0}
                          max={0.9}
                          step={0.01}
                          display={`${Math.round(audioClip.crop.x * 100)}%`}
                          onChange={(value) => updateCrop({ x: value })}
                          onCommit={commitClipVisual}
                        />
                        <ClipSlider
                          label={t('edit.cropY')}
                          value={audioClip.crop.y}
                          min={0}
                          max={0.9}
                          step={0.01}
                          display={`${Math.round(audioClip.crop.y * 100)}%`}
                          onChange={(value) => updateCrop({ y: value })}
                          onCommit={commitClipVisual}
                        />
                        <ClipSlider
                          label={t('edit.cropWidth')}
                          value={audioClip.crop.w}
                          min={0.1}
                          max={1}
                          step={0.01}
                          display={`${Math.round(audioClip.crop.w * 100)}%`}
                          onChange={(value) => updateCrop({ w: value })}
                          onCommit={commitClipVisual}
                        />
                        <ClipSlider
                          label={t('edit.cropHeight')}
                          value={audioClip.crop.h}
                          min={0.1}
                          max={1}
                          step={0.01}
                          display={`${Math.round(audioClip.crop.h * 100)}%`}
                          onChange={(value) => updateCrop({ h: value })}
                          onCommit={commitClipVisual}
                        />
                      </>
                    ) : null}
                    {/* A shape mask over the picture: coordinates are fractions of the frame, so it
                        stays put while the clip moves underneath it. Feather and expansion are in
                        composition pixels; the preview and the export paint the same mask. */}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-muted-foreground">{t('edit.mask')}</span>
                      <button
                        type="button"
                        onClick={() => (selectedMask ? removeMask() : addMask('rectangle'))}
                        className={`h-6 rounded border px-2 text-[10px] ${
                          selectedMask
                            ? 'border-foreground/60 bg-foreground/[0.08]'
                            : 'border-border/60 hover:bg-foreground/[0.05]'
                        }`}
                      >
                        {selectedMask ? t('edit.maskClear') : t('edit.maskAdd')}
                      </button>
                    </div>
                    {audioClip && selectedMask && selectedMaskAt ? (
                      <>
                        <div className="flex flex-wrap items-center gap-1">
                          {(
                            [
                              ['rectangle', 'edit.maskRectangle'],
                              ['ellipse', 'edit.maskEllipse'],
                              ['polygon', 'edit.maskPolygon'],
                            ] as const
                          ).map(([shape, label]) => (
                            <button
                              key={shape}
                              type="button"
                              onClick={() => addMask(shape)}
                              className={`h-6 rounded border px-2 text-[10px] ${
                                selectedMask.shape === shape
                                  ? 'border-foreground/60 bg-foreground/[0.08]'
                                  : 'border-border/60 hover:bg-foreground/[0.05]'
                              }`}
                            >
                              {t(label)}
                            </button>
                          ))}
                          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={selectedMask.inverted}
                              onChange={() => commit(setMask(docRef.current ?? doc, {
                                clipId: audioClip.id,
                                inverted: !selectedMask.inverted,
                              }))}
                              className="h-3 w-3 accent-foreground"
                            />
                            {t('edit.maskInvert')}
                          </label>
                        </div>
                        {/* A tracked box is a mask with two or more keyframes: pin the box here,
                            move the playhead, drag again. Times are clip-local. */}
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={recordMaskKeyframe}
                            className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                          >
                            {t('edit.maskAddKeyframe')}
                          </button>
                          {selectedMask.keyframes?.length ? (
                            <>
                              <button
                                type="button"
                                onClick={clearMaskAnimation}
                                className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                              >
                                {t('edit.maskClearAnimation')}
                              </button>
                              <span className="text-[10px] tabular-nums text-muted-foreground">
                                {t('edit.maskKeyframeCount', {
                                  count: selectedMask.keyframes.length,
                                })}
                              </span>
                            </>
                          ) : null}
                        </div>
                        <ClipSlider
                          label={t('edit.maskX')}
                          value={selectedMaskAt.x}
                          min={0}
                          max={Math.max(0, 1 - selectedMaskAt.width)}
                          step={0.01}
                          display={`${Math.round(selectedMaskAt.x * 100)}%`}
                          onChange={(value) => updateMask({ x: value })}
                          onCommit={commitMask}
                        />
                        <ClipSlider
                          label={t('edit.maskY')}
                          value={selectedMaskAt.y}
                          min={0}
                          max={Math.max(0, 1 - selectedMaskAt.height)}
                          step={0.01}
                          display={`${Math.round(selectedMaskAt.y * 100)}%`}
                          onChange={(value) => updateMask({ y: value })}
                          onCommit={commitMask}
                        />
                        <ClipSlider
                          label={t('edit.maskWidth')}
                          value={selectedMaskAt.width}
                          min={0.05}
                          max={1 - selectedMaskAt.x}
                          step={0.01}
                          display={`${Math.round(selectedMaskAt.width * 100)}%`}
                          onChange={(value) => updateMask({ width: value })}
                          onCommit={commitMask}
                        />
                        <ClipSlider
                          label={t('edit.maskHeight')}
                          value={selectedMaskAt.height}
                          min={0.05}
                          max={1 - selectedMaskAt.y}
                          step={0.01}
                          display={`${Math.round(selectedMaskAt.height * 100)}%`}
                          onChange={(value) => updateMask({ height: value })}
                          onCommit={commitMask}
                        />
                        <ClipSlider
                          label={t('edit.maskFeather')}
                          value={selectedMaskAt.feather}
                          min={0}
                          max={80}
                          step={1}
                          display={`${Math.round(selectedMaskAt.feather)}px`}
                          onChange={(value) => updateMask({ feather: value })}
                          onCommit={commitMask}
                        />
                        <ClipSlider
                          label={t('edit.maskExpansion')}
                          value={selectedMaskAt.expansion}
                          min={-80}
                          max={80}
                          step={1}
                          display={`${Math.round(selectedMaskAt.expansion)}px`}
                          onChange={(value) => updateMask({ expansion: value })}
                          onCommit={commitMask}
                        />
                        <ClipSlider
                          label={t('edit.maskOpacity')}
                          value={selectedMaskAt.opacity}
                          min={0}
                          max={1}
                          step={0.01}
                          display={`${Math.round(selectedMaskAt.opacity * 100)}%`}
                          onChange={(value) => updateMask({ opacity: value })}
                          onCommit={commitMask}
                        />
                      </>
                    ) : null}
                    {/* A held frame: the picture stops for a few seconds, the timeline grows by
                        that much, and the still is silent. */}
                    <div className="flex items-center gap-1.5 pt-1">
                      <span className="w-16 shrink-0 text-muted-foreground">
                        {t('edit.freezeFrame')}
                      </span>
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={freezeSeconds}
                        onChange={(event) => setFreezeSeconds(event.target.value)}
                        className={`${inputClass} w-14`}
                      />
                      <span className="shrink-0 text-[9px] text-muted-foreground">s</span>
                      <button
                        type="button"
                        onClick={insertFreezeAtPlayhead}
                        className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        {t('edit.freezeInsert')}
                      </button>
                    </div>
                    {/* Placement over time. Off, the sliders above are the clip's one look; on,
                        each slider writes a keyframe at the playhead. */}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-muted-foreground">{t('edit.keyframes')}</span>
                      <button
                        type="button"
                        onClick={toggleKeyframes}
                        className={`h-6 rounded border px-2 text-[10px] ${
                          clipKeyframes.length
                            ? 'border-foreground/60 bg-foreground/[0.08]'
                            : 'border-border/60 hover:bg-foreground/[0.05]'
                        }`}
                      >
                        {clipKeyframes.length ? t('edit.keyframesOff') : t('edit.keyframesOn')}
                      </button>
                    </div>
                    {clipKeyframes.length ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {clipKeyframes.map((frame) => (
                          <span
                            key={frame.time}
                            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${
                              Math.abs(frame.time - clipLocal) <= 0.02
                                ? 'border-foreground/60 bg-foreground/[0.08]'
                                : 'border-border/60'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => seekPlayhead(audioClip.start + frame.time)}
                              className="tabular-nums"
                            >
                              {frame.time.toFixed(2)}s
                            </button>
                            <button
                              type="button"
                              onClick={() => removeKeyframeAt(frame.time)}
                              title={t('edit.keyframeRemove')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {clipKeyframes.length ? (
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="w-16 shrink-0 text-muted-foreground">
                          {t('edit.keyframeEasing')}
                        </span>
                        <select
                          value={easingFrame?.easing ?? 'linear'}
                          onChange={(event) => changeEasing(event.target.value as KeyframeEasing)}
                          className={inputClass}
                        >
                          {(Object.keys(KEYFRAME_EASINGS) as KeyframeEasing[]).map((easing) => (
                            <option key={easing} value={easing}>
                              {KEYFRAME_EASINGS[easing].label}
                            </option>
                          ))}
                        </select>
                        <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">
                          {t('edit.keyframeEasingHint')}
                        </span>
                      </div>
                    ) : null}
                    <p className="text-[9px] leading-snug text-muted-foreground">
                      {t('edit.keyframesHint')}
                    </p>
                    {/* Speed changes the picture and its own sound together; stills and held
                        frames have no rate, so the row is only there for time-based media. */}
                    {!IMAGE.test(audioClip.src) && !audioClip.freeze ? (
                      <div className="flex items-center gap-1.5 pt-1 text-[11px]">
                        <span className="w-16 shrink-0 text-muted-foreground">{t('edit.speed')}</span>
                        {[0.5, 1, 1.5, 2, 4].map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => changeSpeed(rate)}
                            className={`h-6 rounded border px-1.5 text-[10px] tabular-nums ${
                              Math.abs(clipSpeed(audioClip) - rate) < 1e-6
                                ? 'border-foreground/60 bg-foreground/[0.08]'
                                : 'border-border/60 hover:bg-foreground/[0.05]'
                            }`}
                          >
                            {rate}x
                          </button>
                        ))}
                        <input
                          key={`speed-${audioClip.id}-${audioClip.speed ?? 1}`}
                          type="number"
                          min={MIN_SPEED}
                          max={MAX_SPEED}
                          step={0.1}
                          defaultValue={clipSpeed(audioClip)}
                          onBlur={(event) => changeSpeed(Number(event.target.value))}
                          className={`${inputClass} w-14`}
                        />
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <button
                        type="button"
                        onClick={duplicateSelectedClip}
                        className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        {t('edit.duplicateClip')}
                      </button>
                      <button
                        type="button"
                        onClick={rippleDeleteSelectedClip}
                        className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        {t('edit.rippleDelete')}
                      </button>
                      <button
                        type="button"
                        onClick={closeSelectedGap}
                        className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        {t('edit.closeGap')}
                      </button>
                      <button
                        type="button"
                        onClick={removeAllGaps}
                        className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        {t('edit.removeGaps')}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                  {t('edit.selectClip')}
                </div>
              )}
            </div>
          ) : tab === 'effects' ? (
            audioClip ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-2 text-[11px]">
                <div className="truncate text-muted-foreground" title={audioClip.src}>
                  {nameOf(audioClip.src)}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {(Object.keys(EFFECT_PRESETS) as EffectPreset[]).map((preset) => {
                    const active = (audioClip.effect?.preset ?? 'none') === preset
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => applyEffectPreset(preset)}
                        className={`h-7 rounded-md border px-2 ${
                          active
                            ? 'border-foreground/60 bg-foreground/[0.08]'
                            : 'border-border/60 hover:bg-foreground/[0.05]'
                        }`}
                      >
                        {EFFECT_PRESETS[preset].label}
                      </button>
                    )
                  })}
                </div>
                {EFFECT_SLIDERS.map((slider) => (
                  <ClipSlider
                    key={slider.key}
                    label={t(slider.label)}
                    value={effectValues[slider.key]}
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    display={slider.display(effectValues[slider.key])}
                    onChange={(value) => updateEffect(slider.key, value)}
                    onCommit={commitClipVisual}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => applyEffectPreset('none')}
                  className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                >
                  {t('edit.effectReset')}
                </button>

                {/* Regional blur/mosaic: hide a watermark or logo without touching the grade. */}
                <div className="h-px bg-border/60" />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('edit.regionBlur')}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={addRegion}
                      className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                    >
                      {t('edit.regionAdd')}
                    </button>
                    {effectRegions.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          writeRegions([])
                          commitRegions()
                        }}
                        className="h-6 rounded border border-border/60 px-2 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        {t('edit.regionClear')}
                      </button>
                    ) : null}
                  </div>
                </div>
                {effectRegions.map((region, index) => (
                  <div
                    key={index}
                    className="space-y-1 rounded border border-border/60 bg-foreground/[0.02] p-1.5"
                  >
                    <div className="flex items-center gap-1">
                      <select
                        value={region.mode}
                        onChange={(event) => {
                          updateRegion(index, { mode: event.target.value as BlurRegion['mode'] })
                          commitRegions()
                        }}
                        className={inputClass}
                      >
                        <option value="blur">{t('edit.regionBlurMode')}</option>
                        <option value="mosaic">{t('edit.regionMosaicMode')}</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeRegion(index)}
                        className="ml-auto h-6 rounded border border-border/60 px-1.5 text-[10px] hover:bg-foreground/[0.05]"
                      >
                        ×
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      {(
                        [
                          ['x', 'edit.regionX'],
                          ['y', 'edit.regionY'],
                          ['w', 'edit.regionW'],
                          ['h', 'edit.regionH'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="flex flex-col gap-0.5 text-[9px] text-muted-foreground">
                          <span>{t(label)}</span>
                          <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.01}
                            value={Number(region[key].toFixed(2))}
                            onChange={(event) => updateRegion(index, { [key]: Number(event.target.value) })}
                            onBlur={commitRegions}
                            className={inputClass}
                          />
                        </label>
                      ))}
                    </div>
                    <ClipSlider
                      label={t('edit.regionStrength')}
                      value={region.strength}
                      min={1}
                      max={60}
                      step={1}
                      display={`${Math.round(region.strength)}px`}
                      onChange={(value) => updateRegion(index, { strength: value })}
                      onCommit={commitRegions}
                    />
                  </div>
                ))}

                {/* The same tab carries the clip's own sound: a low-cut, three bands, and a
                    compressor. Preview and export build the same WebAudio chain. */}
                <div className="h-px bg-border/60" />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('edit.audioTone')}</span>
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={audioEffectValues.compress}
                      onChange={() => commitAudioEffect({ compress: !audioEffectValues.compress })}
                      className="h-3 w-3 accent-foreground"
                    />
                    {t('edit.compress')}
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={audioEffectValues.normalize}
                      onChange={() => commitAudioEffect({ normalize: !audioEffectValues.normalize })}
                      className="h-3 w-3 accent-foreground"
                    />
                    {t('edit.normalize')}
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={audioEffectValues.denoise}
                      onChange={() => commitAudioEffect({ denoise: !audioEffectValues.denoise })}
                      className="h-3 w-3 accent-foreground"
                    />
                    {t('edit.denoise')}
                  </label>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-16 shrink-0 text-muted-foreground">{t('edit.highpass')}</span>
                  <select
                    value={audioEffectValues.highpass}
                    onChange={(event) => commitAudioEffect({ highpass: Number(event.target.value) })}
                    className={inputClass}
                  >
                    <option value={0}>{t('edit.off')}</option>
                    <option value={80}>80 Hz</option>
                    <option value={120}>120 Hz</option>
                    <option value={200}>200 Hz</option>
                  </select>
                </div>
                {(
                  [
                    ['bass', 'edit.bass'],
                    ['mid', 'edit.mid'],
                    ['treble', 'edit.treble'],
                  ] as const
                ).map(([key, label]) => (
                  <ClipSlider
                    key={key}
                    label={t(label)}
                    value={audioEffectValues[key]}
                    min={-12}
                    max={12}
                    step={0.5}
                    display={`${audioEffectValues[key] > 0 ? '+' : ''}${audioEffectValues[key].toFixed(1)}dB`}
                    onChange={(value) => updateAudioEffect({ [key]: value })}
                    onCommit={commitClipVisual}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                {t('edit.selectClip')}
              </div>
            )
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t('edit.comingSoon')}
            </div>
          )}
        </div>

        {/* Player over its transport bar. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3 text-[11px] text-muted-foreground">
            {t('edit.player')}
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/50 p-3">
            {/* The player is a letterbox: the frame's own shape is decided by the canvas's
                intrinsic size (the composition's), not by the panel's, so a 9:16 cut in a wide
                player is pillarboxed instead of stretched. */}
            <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-sm bg-black">
              {/* One canvas paints the whole composition — picture, transition, words, boxes — with
                  the same painter the exported file uses. Sound is the audio graph's. */}
              <PreviewStage
                doc={doc}
                time={playhead}
                playing={playing}
                urlOf={urlOf}
                selectedOverlay={selectedOverlay}
                onSelectOverlay={setSelectedOverlay}
                onOverlayBox={(id, box) => {
                  const current = docRef.current
                  if (!current) return
                  if (!gestureStart.current) gestureStart.current = current
                  setDoc(updateOverlay(current, id, { box }))
                }}
                onOverlayBoxEnd={() => commitGesture(docRef.current)}
              />
              {total === 0 ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
                  {t('edit.importToStart')}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border/60 px-3">
            <span className="text-[11px] tabular-nums text-foreground/80">{timecode(playhead, fps)}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">/ {timecode(total, fps)}</span>
            <div className="mx-auto flex items-center gap-1">
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded hover:bg-foreground/[0.06]"
                onClick={() => seekPlayhead(0)}
                title={t('edit.toStart')}
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="grid h-8 w-9 place-items-center rounded bg-foreground text-background hover:bg-foreground/90"
                onClick={() => setPlaying((value) => !value)}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
              </button>
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded hover:bg-foreground/[0.06]"
                onClick={() => seekPlayhead(total)}
                title={t('edit.toEnd')}
              >
                <SkipForward className="h-4 w-4" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
              <Volume2 className="h-3.5 w-3.5" />
              <button type="button" className="grid h-7 w-7 place-items-center rounded hover:bg-foreground/[0.06]" title={t('edit.fullscreen')}>
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Timeline: toolbar, ruler, track. */}
      <div className="flex h-[42px] shrink-0 items-center gap-3 border-t border-border/60 bg-foreground/[0.02] px-3">
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
          disabled={past.length === 0}
          onClick={undo}
          title={t('edit.undo')}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
          disabled={future.length === 0}
          onClick={redo}
          title={t('edit.redo')}
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <span className="h-4 w-px bg-border" />
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06]"
          onClick={() => fileInput.current?.click()}
          title={t('edit.addClip')}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06]"
          onClick={() => commit(addTrack(docRef.current ?? doc, 'video'))}
          title={t('edit.addVideoTrack')}
        >
          <Film className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06]"
          onClick={() => commit(addTrack(docRef.current ?? doc, 'audio'))}
          title={t('edit.addAudioTrack')}
        >
          <Music2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
          disabled={!selected && !current}
          onClick={split}
          title={t('edit.split')}
        >
          <Scissors className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
          disabled={!selected}
          onClick={removeSelected}
          title={t('edit.removeClip')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
          disabled={!audioClip || audioOnSoundTrack || IMAGE.test(audioClip.src)}
          onClick={detachSelectedAudio}
          title={t('edit.detachAudio')}
        >
          <AudioLines className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-30"
          disabled={!audioClip || IMAGE.test(audioClip.src)}
          onClick={toggleMute}
          title={audioClip?.muted ? t('edit.unmute') : t('edit.mute')}
        >
          {audioClip?.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <span className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => setSnap((value) => !value)}
          className={`grid h-8 w-8 place-items-center rounded ${snap ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06]'}`}
          title={t('edit.snap')}
        >
          <Magnet className="h-4 w-4" />
        </button>

        <div className="ml-auto flex items-center gap-2 text-muted-foreground">
          <ZoomOut className="h-3.5 w-3.5" />
          <input
            type="range"
            min={16}
            max={240}
            step={4}
            value={pxPerSecond}
            onChange={(event) => setPxPerSecond(Number(event.target.value))}
            className="h-1 w-28 accent-foreground"
          />
          <ZoomIn className="h-3.5 w-3.5" />
        </div>
      </div>

      {/* The timeline has a height of its own rather than sharing the leftovers: in a short
          panel the player would otherwise take everything and the track would collapse to a
          line — which reads as "there is no timeline". */}
      <div className="relative flex min-h-[188px] shrink-0 flex-col overflow-hidden" style={{ height: '42%' }}>
        <div ref={timelineScrollRef} className="flex min-h-0 flex-1 overflow-auto">
          {/* Track headers: the rows below line up one-for-one with these. Sticky so scrolling the
              timeline right keeps the labels visible instead of sliding them off the surface. */}
          <div className="sticky left-0 z-30 w-[104px] shrink-0 border-r border-border/60 bg-background">
            <div className="h-6 border-b border-border/60" />
            {/* The overlay tracks: what is painted above the picture. */}
            <div
              className="flex h-12 items-center gap-1.5 border-b border-border/40 px-2 text-[10px] text-muted-foreground"
              title={t('edit.subtitleTrack')}
            >
              <Type className="h-3 w-3" />S
            </div>
            <div
              className="flex h-12 items-center gap-1.5 border-b border-border/40 px-2 text-[10px] text-muted-foreground"
              title={t('edit.overlayTrack')}
            >
              <Sparkles className="h-3 w-3" />O
            </div>
            {tracks.map((track) => {
              const index =
                tracks.filter((candidate) => candidate.kind === track.kind).indexOf(track) + 1
              const globalIndex = tracks.indexOf(track)
              const label = track.name ?? `${track.kind === 'audio' ? 'A' : 'V'}${index}`
              return (
                <div
                  key={track.id}
                  className={`flex h-20 flex-col justify-center gap-1 border-b border-border/40 px-2 text-[10px] ${
                    track.hidden ? 'text-muted-foreground/50' : 'text-muted-foreground'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    {track.kind === 'audio' ? <Music2 className="h-3 w-3 shrink-0" /> : <Film className="h-3 w-3 shrink-0" />}
                    {renamingTrack === track.id ? (
                      <input
                        autoFocus
                        value={trackNameDraft}
                        onChange={(event) => setTrackNameDraft(event.target.value)}
                        onBlur={() => commitTrackName(track.id, trackNameDraft)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            commitTrackName(track.id, trackNameDraft)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            setRenamingTrack(null)
                          }
                        }}
                        className="h-4 w-full min-w-0 rounded border border-border/60 bg-transparent px-0.5 text-[10px] text-foreground outline-none focus:border-foreground/40"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => clearClipSelection()}
                        onDoubleClick={() => {
                          setRenamingTrack(track.id)
                          setTrackNameDraft(track.name ?? '')
                        }}
                        title={t('edit.renameTrack')}
                        className="min-w-0 flex-1 truncate text-left hover:text-foreground"
                      >
                        {label}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={globalIndex === 0}
                      onClick={() => moveTrackTo(track.id, globalIndex - 1)}
                      title={t('edit.moveTrack')}
                      className="grid h-4 w-3.5 shrink-0 place-items-center rounded hover:bg-foreground/[0.08] disabled:opacity-25"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={globalIndex === tracks.length - 1}
                      onClick={() => moveTrackTo(track.id, globalIndex + 1)}
                      title={t('edit.moveTrack')}
                      className="grid h-4 w-3.5 shrink-0 place-items-center rounded hover:bg-foreground/[0.08] disabled:opacity-25"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={track.kind === 'video' && tracksOf(doc, 'video').length === 1}
                      onClick={() => deleteTrack(track.id)}
                      title={
                        track.kind === 'video' && tracksOf(doc, 'video').length === 1
                          ? t('edit.lastVideoTrack')
                          : t('edit.deleteTrack')
                      }
                      className="grid h-4 w-3.5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-red-500/15 hover:text-red-500 disabled:opacity-25"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                  {/* Mute and solo are about sound; the picture on a video track keeps playing.
                      Lock protects the lane from the panel's pointer edits; hide drops its picture. */}
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => toggleTrackAudio(track.id, 'muted')}
                      title={t('edit.muteTrack')}
                      className={`h-4 w-4 rounded text-[8px] leading-4 ${
                        track.muted ? 'bg-foreground text-background' : 'hover:bg-foreground/[0.08]'
                      }`}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleTrackAudio(track.id, 'solo')}
                      title={t('edit.soloTrack')}
                      className={`h-4 w-4 rounded text-[8px] leading-4 ${
                        track.solo ? 'bg-amber-400 text-black' : 'hover:bg-foreground/[0.08]'
                      }`}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleTrackFlag(track.id, 'locked')}
                      title={track.locked ? t('edit.unlockTrack') : t('edit.lockTrack')}
                      className={`grid h-4 w-4 place-items-center rounded ${
                        track.locked ? 'bg-foreground text-background' : 'hover:bg-foreground/[0.08]'
                      }`}
                    >
                      {track.locked ? <Lock className="h-2.5 w-2.5" /> : <Unlock className="h-2.5 w-2.5" />}
                    </button>
                    {track.kind === 'video' ? (
                      <button
                        type="button"
                        onClick={() => toggleTrackFlag(track.id, 'hidden')}
                        title={track.hidden ? t('edit.showTrack') : t('edit.hideTrack')}
                        className="grid h-4 w-4 place-items-center rounded hover:bg-foreground/[0.08]"
                      >
                        {track.hidden ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>

          <div
            className={`relative min-w-0 flex-1 pl-1.5 ${scrubbing ? 'cursor-grabbing' : ''}`}
            style={{ minWidth: Math.max(total * pxPerSecond, 320) }}
            onPointerDown={beginMarquee}
          >
            {/* Ruler: a label every five seconds, a tick every second. */}
            <div
              ref={rulerRef}
              className="relative h-6 cursor-grab border-b border-border/60 text-[9px] tabular-nums text-muted-foreground/70 active:cursor-grabbing"
              onPointerDown={(event) => beginScrub(event, 'absolute')}
            >
              {/* In/out range: the part `runExport` renders when it is set. */}
              {inPoint !== null || outPoint !== null ? (
                <div
                  className="pointer-events-none absolute inset-y-0 bg-amber-400/20"
                  style={{
                    left: (inPoint ?? 0) * pxPerSecond,
                    width: Math.max(0, ((outPoint ?? total) - (inPoint ?? 0)) * pxPerSecond),
                  }}
                />
              ) : null}
              {/* Markers: diamonds on the ruler, click to jump to one. */}
              {markers.map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    setPlaying(false)
                    seekPlayhead(marker.time)
                  }}
                  title={marker.name ?? t('edit.marker')}
                  className="absolute top-0.5 z-20 -translate-x-1/2 text-amber-500 hover:text-amber-400"
                  style={{ left: marker.time * pxPerSecond }}
                >
                  <span className="block h-2 w-2 rotate-45 bg-current" />
                </button>
              ))}
              {Array.from({ length: Math.ceil(total) + 1 }).map((_, second) => (
                <span
                  key={second}
                  className={`absolute bottom-0 ${second % 5 === 0 ? 'h-2.5 border-l border-border' : 'h-1.5 border-l border-border/40'}`}
                  style={{ left: second * pxPerSecond }}
                >
                  {second % 5 === 0 ? (
                    <span className="absolute bottom-2.5 left-1">
                      {`${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}`}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>

            {/* The overlay tracks, above the picture tracks exactly as they paint. Blocks are
                dragged in time here; the inspector edits what they say and how they look. */}
            <OverlayLane
              overlays={subtitleOverlays}
              selected={selectedOverlay}
              pxPerSecond={pxPerSecond}
              label={t('edit.subtitleTrack')}
              onSeek={seekOverlayLane}
              onPick={beginOverlayDrag}
              onMove={onOverlayDrag}
              onEnd={endOverlayDrag}
              onMenu={openOverlayMenu}
            />
            <OverlayLane
              overlays={graphicOverlays}
              selected={selectedOverlay}
              pxPerSecond={pxPerSecond}
              label={t('edit.overlayTrack')}
              onSeek={seekOverlayLane}
              onPick={beginOverlayDrag}
              onMove={onOverlayDrag}
              onEnd={endOverlayDrag}
              onMenu={openOverlayMenu}
            />

            {/* One row per track; a drop lands on the row it was aimed at. */}
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`relative h-20 border-b border-border/40 bg-foreground/[0.02] ${
                  track.locked ? 'bg-foreground/[0.05]' : ''
                } ${track.hidden ? 'opacity-55' : ''}`}
                onDragOver={(event) => {
                  if (track.locked || !event.dataTransfer.types.includes('text/craft-media')) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                  const raw = Math.max(0, (event.clientX - rect.left) / pxPerSecond)
                  const threshold = 10 / pxPerSecond
                  const targets = [
                    0,
                    playhead,
                    ...clipsOf(docRef.current ?? doc).flatMap((clip) => [clip.start, clip.start + clip.duration]),
                  ]
                  let at = raw
                  let guide: number | null = null
                  for (const target of targets) {
                    if (Math.abs(raw - target) <= threshold) {
                      at = target
                      guide = target
                      break
                    }
                  }
                  setSnapGuide(guide)
                  setDropAt(at)
                }}
                onDragLeave={() => {
                  setSnapGuide(null)
                  setDropAt(null)
                }}
                onDrop={(event) => {
                  if (track.locked) return
                  const src = event.dataTransfer.getData('text/craft-media')
                  const at = dropAt
                  setSnapGuide(null)
                  setDropAt(null)
                  if (!src) return
                  event.preventDefault()
                  void (async () => {
                    const duration = (await probeDuration(absolute(projectFolder, src), IMAGE.test(src))) || 5
                    let current = docRef.current
                    if (!current) return
                    // A drop routes by what the file is, not only by the row it landed on:
                    // sound goes to a sound track (created if this is the first one), and a
                    // picture never lands on a sound track.
                    const audio = AUDIO.test(src)
                    let trackId = track.id
                    if (audio && track.kind !== 'audio') {
                      if (tracksOf(current, 'audio').length === 0) current = addTrack(current, 'audio')
                      trackId = tracksOf(current, 'audio')[0]!.id
                    } else if (!audio && track.kind !== 'video') {
                      trackId = primaryTrack(current).id
                    }
                    commit(addClip(current, { src, duration, start: at ?? undefined, trackId }))
                  })()
                }}
                onPointerDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                  setPlaying(false)
                  seekPlayhead(Math.max(0, (event.clientX - rect.left) / pxPerSecond))
                  clearClipSelection()
                }}
                onPointerMove={onDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {track.clips.map((clip) => {
                  const active = selectedIds.includes(clip.id)
                  const preview = IMAGE.test(clip.src) ? urlOf(clip.src) : null
                  const strip = preview ? [] : filmstrip(clip.src)
                  return (
                    <div
                      key={clip.id}
                      data-clip={clip.id}
                      className={`absolute top-1 h-[72px] overflow-hidden rounded border ${
                        active
                          ? 'border-foreground/80 bg-foreground/[0.18]'
                          : 'border-border/70 bg-foreground/[0.08] hover:border-foreground/40'
                      }`}
                      style={{ left: clip.start * pxPerSecond, width: Math.max(clip.duration * pxPerSecond, 4) }}
                      onPointerDown={(event) => {
                        if (track.locked) {
                          event.stopPropagation()
                          const additive = event.shiftKey || event.metaKey || event.ctrlKey
                          selectClips(additive ? [...selectedIds, clip.id] : [clip.id])
                          return
                        }
                        beginDrag(event, clip, 'move')
                      }}
                      onContextMenu={(event) => openClipMenu(event, clip)}
                    >
                      {(() => {
                        const wave = wavePath(clip.src, clip.in, clip.duration)
                        return wave ? (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            className="absolute inset-x-0 bottom-0 h-[26px] w-full text-foreground/75"
                          >
                            <path
                              d={wave}
                              stroke="currentColor"
                              strokeWidth="1.4"
                              fill="none"
                              vectorEffect="non-scaling-stroke"
                            />
                          </svg>
                        ) : null
                      })()}
                      {preview ? (
                        <img src={preview} alt="" className="absolute inset-0 h-full w-full object-cover opacity-45" />
                      ) : strip.length > 0 ? (
                        <div className="absolute inset-0 flex opacity-45">
                          {strip.map((shot, index) => (
                            <img key={index} src={shot} alt="" className="h-full min-w-0 flex-1 object-cover" />
                          ))}
                        </div>
                      ) : null}
                      <div className="relative px-1.5 pt-1 text-[10px] text-foreground/90">
                        <span className="block truncate">{nameOf(clip.src)}</span>
                        <span className="block text-[9px] tabular-nums text-muted-foreground">
                          {clip.duration.toFixed(2)}s · in {clip.in.toFixed(2)}s
                        </span>
                      </div>
                      {clipSpeed(clip) !== 1 ? (
                        <span className="absolute right-1.5 top-1 rounded bg-foreground/85 px-1 text-[9px] font-medium tabular-nums text-background">
                          {clipSpeed(clip)}x
                        </span>
                      ) : null}
                      {/* Every placement keyframe, at its own moment in the clip; clicking one
                          moves the playhead there, and the title names its easing. */}
                      {clip.keyframes?.map((frame) => (
                        <span
                          key={`kf-${frame.time}`}
                          title={`${frame.time.toFixed(2)}s · ${KEYFRAME_EASINGS[frame.easing ?? 'linear'].label}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation()
                            seekPlayhead(clip.start + frame.time)
                          }}
                          className="absolute bottom-1 h-2 w-2 -translate-x-1/2 rotate-45 border border-foreground/80 bg-background"
                          style={{ left: frame.time * pxPerSecond }}
                        />
                      ))}
                      {track.locked ? null : (
                        <>
                          <span
                            className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-foreground/25 hover:bg-foreground/60"
                            onPointerDown={(event) => beginDrag(event, clip, 'left')}
                          />
                          <span
                            className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-foreground/25 hover:bg-foreground/60"
                            onPointerDown={(event) => beginDrag(event, clip, 'right')}
                          />
                        </>
                      )}
                    </div>
                  )
                })}
                {track.clips.length === 0 ? (
                  <div className="grid h-full place-items-center text-[11px] text-muted-foreground">{t('edit.empty')}</div>
                ) : null}
              </div>
            ))}

            {dropAt !== null ? (
              <div
                className="pointer-events-none absolute bottom-0 top-6 w-0.5 rounded bg-foreground/80"
                style={{ left: `calc(0.375rem + ${dropAt * pxPerSecond}px)` }}
              />
            ) : null}

            {marquee &&
            (Math.abs(marquee.currentX - marquee.startX) > 3 ||
              Math.abs(marquee.currentY - marquee.startY) > 3) ? (
              <div
                className="pointer-events-none absolute z-10 border border-foreground/60 bg-foreground/10"
                style={{
                  left: Math.min(marquee.startX, marquee.currentX),
                  top: Math.min(marquee.startY, marquee.currentY),
                  width: Math.abs(marquee.currentX - marquee.startX),
                  height: Math.abs(marquee.currentY - marquee.startY),
                }}
              />
            ) : null}

            {/* The edge a drag caught on, so a snap is something you can see. */}
            {snapGuide !== null ? (
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-amber-400/80"
                style={{ left: `calc(0.375rem + ${snapGuide * pxPerSecond}px)` }}
              />
            ) : null}

            {/* Playhead: a line the height of the timeline, a head you can grab, and it can be
                dragged. At 0 it sits on the track's left edge, so the head is drawn half outside
                and the scroller shows the half that is left — a playhead that is invisible at the
                start of the cut is a playhead nobody can find. */}
            <div
              className="group pointer-events-none absolute bottom-0 top-0 z-20 -translate-x-1/2"
              style={{ left: `calc(0.375rem + ${playhead * pxPerSecond}px)` }}
            >
              {/* The whole line is the grab surface, not just the 10px head: pressing it anywhere
                  starts a scrub, so moving the playhead never needs a second press. */}
              <div
                className="pointer-events-auto absolute bottom-0 left-0 top-0 w-2 -translate-x-1/2 cursor-grab active:cursor-grabbing"
                onPointerDown={(event) => beginScrub(event, 'relative')}
              />
              <div className="pointer-events-none absolute bottom-0 top-2.5 w-[2px] -translate-x-1/2 bg-foreground" />
              <div
                role="slider"
                aria-label={t('edit.playhead')}
                aria-valuemin={0}
                aria-valuemax={Math.round(total * 100) / 100}
                aria-valuenow={Math.round(playhead * 100) / 100}
                tabIndex={0}
                className="pointer-events-auto absolute left-0 top-0 h-3.5 w-2.5 -translate-x-1/2 cursor-grab rounded-b-sm rounded-t-[2px] bg-foreground ring-1 ring-background/60 hover:brightness-110 active:cursor-grabbing"
                onPointerDown={(event) => beginScrub(event, 'relative')}
              />
            </div>
          </div>
        </div>
      </div>

      <input
        ref={srtInput}
        type="file"
        accept=".srt,text/plain"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importSrt(file)
        }}
      />

      <input
        ref={fileInput}
        type="file"
        accept="video/*,image/*,audio/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void upload(files)
        }}
      />

      {clipMenu
        ? (() => {
            const target = clipsOf(docRef.current ?? emptyDocument('x')).find(
              (clip) => clip.id === clipMenu.id,
            )
            if (!target) return null
            const inside =
              playhead > target.start + 0.001 && playhead < target.start + target.duration - 0.001
            const close = () => setClipMenu(null)
            const edit = (change: (current: EditDocument, id: string) => EditDocument) => {
              const current = docRef.current
              if (!current) return
              const next = change(current, target.id)
              if (next !== current) commit(next)
              close()
            }
            const isVideo = !IMAGE.test(target.src) && !AUDIO.test(target.src)
            return (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onPointerDown={close}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    close()
                  }}
                />
                <div
                  role="menu"
                  className="popover-styled fixed z-50 min-w-[176px] p-1 text-[12px]"
                  style={{ left: clipMenu.x, top: clipMenu.y }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!inside}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-foreground/5 disabled:opacity-40"
                    onClick={() => edit((current, id) => splitClip(current, id, playhead))}
                  >
                    <Scissors className="h-3.5 w-3.5" />
                    {t('edit.split')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-foreground/5"
                    onClick={() => edit((current, id) => duplicateClip(current, id))}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('edit.duplicateClip')}
                  </button>
                  {isVideo ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-foreground/5"
                      onClick={() => edit((current, id) => detachAudio(current, id))}
                    >
                      <AudioLines className="h-3.5 w-3.5" />
                      {t('edit.detachAudio')}
                    </button>
                  ) : null}
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-foreground/5"
                    onClick={() => {
                      edit((current, id) => rippleDelete(current, id))
                      clearClipSelection()
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('edit.rippleDelete')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      edit((current, id) => removeClip(current, id))
                      clearClipSelection()
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('edit.removeClip')}
                  </button>
                </div>
              </>
            )
          })()
        : null}

      {overlayMenu
        ? (() => {
            const current = docRef.current
            const target = current?.overlays.find((overlay) => overlay.id === overlayMenu.id)
            if (!current || !target) return null
            const close = () => setOverlayMenu(null)
            return (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onPointerDown={close}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    close()
                  }}
                />
                <div
                  role="menu"
                  className="popover-styled fixed z-50 min-w-[176px] p-1 text-[12px]"
                  style={{ left: overlayMenu.x, top: overlayMenu.y }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-foreground/5"
                    onClick={() => {
                      const before = new Set(current.overlays.map((overlay) => overlay.id))
                      const { id: _id, ...rest } = target
                      const next = addOverlay(current, { ...rest, start: target.start + 0.25 })
                      commit(next)
                      const added = next.overlays.find((overlay) => !before.has(overlay.id))
                      if (added) setSelectedOverlay(added.id)
                      close()
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('edit.duplicateClip')}
                  </button>
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      commit(removeOverlay(current, target.id))
                      setSelectedOverlay(null)
                      close()
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('edit.removeOverlay')}
                  </button>
                </div>
              </>
            )
          })()
        : null}

    </div>
  )
}
