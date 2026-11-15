/**
 * A cut, as a document — ours, not an editor's.
 *
 * A cut is **time**, not space: the canvas is for arranging things next to each other, a timeline
 * for arranging them one after another. So a cut is a project document (`reels/<slug>.reel`),
 * revisioned like every other document here, and addressable by path — which is how the agent
 * names it (`reels/预告.reel`). The suffix is ours on purpose: a cut is not "a JSON file" to any
 * other app.
 *
 * The shape is deliberately small. A clip is a **source file plus the window of it that is used**
 * (`in`, `duration`) and where that window sits on its track (`start`). Everything else — how a
 * clip is drawn, how a transition is animated — is a property of the renderer, not of the cut, so
 * the file stays diffable and a person can read it.
 *
 * Pure functions only: this module is imported by the renderer, by the agent's tool and by tests,
 * and none of them should be dragging `fs` or a DOM along with them.
 */

import { normalizeOverlay, type EditOverlay, type OverlayFrame } from './overlay.ts'
import { automationGainAt, type DuckingSettings, type VolumePoint } from './ducking.ts'
import { normalizeEffect, type ClipEffect } from './effects.ts'
import { normalizeAudioEffect, type AudioEffect } from './audio-effects.ts'

/** The suffix a cut is stored under — ours, so no other app claims the file. */
export const REEL_EXTENSION = '.reel'

export function isReelPath(path: string): boolean {
  return path.toLowerCase().endsWith(REEL_EXTENSION)
}

/** `reels/预告.reel` → `预告`, for a title or a default export name. */
export function reelNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return isReelPath(base) ? base.slice(0, -REEL_EXTENSION.length) : base
}

export type TrackKind = 'video' | 'audio'

export interface EditClip {
  id: string
  /** Project-relative media path (`assets/a.mp4`). */
  src: string
  /** Seconds into the track where this piece begins. */
  start: number
  /** Seconds into the source where the piece begins. */
  in: number
  /**
   * Seconds this piece occupies on the timeline. Speed keeps the **source window** fixed and
   * rescales this instead: at 2× the same material occupies half as much timeline.
   */
  duration: number
  /** Playback speed: 2 plays twice as fast, 0.5 half. Omitted means 1. */
  speed?: number
  /** How loud this clip's own sound is, 0..1. Omitted means 1. The picture is unaffected. */
  volume?: number
  /** This clip's sound is off; the picture stays. A detached audio clip is what is heard instead. */
  muted?: boolean
  /** Seconds of fade at each end of the clip's sound — OpenReel's `fade: { fadeIn, fadeOut }`. */
  fade?: { fadeIn: number; fadeOut: number }
  /** Volume keyframes inside the clip (OpenReel's `automation.volume`), relative to its start. */
  automation?: VolumePoint[]
  /** The settings a ducking envelope was baked from — MiniMax keeps these on the clip too. */
  ducking?: DuckingSettings
  /** Position / scale / rotation / corner radius of the picture. */
  transform?: ClipTransform
  /** A rectangle of the source's own frame, in fractions of it — the 裁剪 tab. */
  crop?: CropRect
  /** The picture is a held frame: `clipSourceTime` stays at `in` for the clip's whole length. */
  freeze?: true
  /** 0..1; omitted means fully opaque. */
  opacity?: number
  /** Colour grading — the 滤镜 tab. Omitted means the picture is untouched. */
  effect?: ClipEffect
  /** Tone of this clip's own sound — a low-cut, three bands and a compressor. */
  audioEffect?: AudioEffect
  /** The transition that brings this clip in from the clip immediately before it. */
  transition?: ClipTransition
  /**
   * Placement over time: the picture moves between these, instead of sitting at `transform`.
   * When present, they are the whole story — `transform`/`opacity` are ignored (and kept only so
   * turning keyframes off restores the look the clip had).
   */
  keyframes?: TransformKeyframe[]
}

/**
 * One placement at a moment inside the clip.
 *
 * `time` is **clip-local seconds** (from the clip's start), not timeline seconds: moving a clip
 * must not have to rewrite every keyframe in it.
 */
export interface TransformKeyframe {
  time: number
  transform: ClipTransform
  /** 0..1; omitted means fully opaque. */
  opacity?: number
  /** How the **segment arriving at this keyframe** travels. Omitted means `linear`. */
  easing?: KeyframeEasing
}

/**
 * The shape of the segment between two keyframes. `ease-in` starts slow, `ease-out` ends slow,
 * `ease-in-out` does both; all of them are evaluated by one function shared by preview and export.
 */
export type KeyframeEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export const KEYFRAME_EASINGS: Record<KeyframeEasing, { label: string }> = {
  linear: { label: '匀速' },
  'ease-in': { label: '缓入' },
  'ease-out': { label: '缓出' },
  'ease-in-out': { label: '缓入缓出' },
}

const EASING_NAMES = new Set<string>(Object.keys(KEYFRAME_EASINGS))

export const isKeyframeEasing = (value: unknown): value is KeyframeEasing =>
  typeof value === 'string' && EASING_NAMES.has(value)

/** Progress 0..1 bent by the keyframe's easing — one formula for every renderer. */
export function easeKeyframe(easing: KeyframeEasing | undefined, progress: number): number {
  const at = Math.min(1, Math.max(0, progress))
  switch (easing) {
    case 'ease-in':
      return at * at
    case 'ease-out':
      return 1 - (1 - at) * (1 - at)
    case 'ease-in-out':
      return at < 0.5 ? 2 * at * at : 1 - ((-2 * at + 2) ** 2) / 2
    default:
      return at
  }
}

export interface EditTrack {
  id: string
  kind: TrackKind
  clips: EditClip[]
  /** What the timeline calls this lane; omitted means "V1" / "A1" by position. */
  name?: string
  /** The track's own sound is off. The picture on a video track keeps playing. */
  muted?: boolean
  /** While anything is soloed, only soloed tracks are heard. */
  solo?: boolean
  /** The panel will not move, trim or drop onto it. The agent's explicit writes still land. */
  locked?: boolean
  /** A hidden video track keeps its sound but paints nothing. Sound tracks have no picture. */
  hidden?: boolean
}

/** How a picture sits inside the composition — MiniMax's Transform tab. */
export interface ClipTransform {
  /** Offset from the composition centre, as a fraction of its width/height. */
  x: number
  y: number
  /** 1 is the contain fit. */
  scale: number
  /** Degrees, clockwise. */
  rotation: number
  /** Corner radius as a fraction of the smaller drawn side, 0..0.5. */
  radius: number
  /** Mirror the picture left-to-right. Omitted means normal. */
  flipX?: boolean
}

export const NEUTRAL_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 }

/**
 * A rectangle of the source, in fractions of its own frame.
 *
 * Cropping is a window onto the source, not a transform of the composition: the picture is fitted
 * and placed as if the crop were the whole frame, so a 4:3 crop of a 16:9 clip fills a 4:3
 * composition instead of sitting in letterbox bars.
 */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** No crop — the whole source frame. */
export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 }

/** How one clip arrives at the cut with the clip before it — MiniMax's `tr.*`. */
export type TransitionKind =
  | 'crossfade'
  | 'dip-black'
  | 'dip-white'
  | 'wipe-left'
  | 'slide-left'
  | 'zoom'

export const TRANSITIONS: Record<TransitionKind, { label: string }> = {
  crossfade: { label: '交叉淡化' },
  'dip-black': { label: '淡入黑场' },
  'dip-white': { label: '淡入白场' },
  'wipe-left': { label: '擦除' },
  'slide-left': { label: '滑动' },
  zoom: { label: '缩放' },
}

/**
 * Transitions that draw both pictures: the outgoing one underneath, the incoming one on top
 * with its own motion. Everything else passes through a single colour instead.
 */
export const LAYERED_TRANSITIONS: ReadonlySet<TransitionKind> = new Set<TransitionKind>([
  'crossfade',
  'wipe-left',
  'slide-left',
  'zoom',
])

export const isLayeredTransition = (kind: TransitionKind): boolean =>
  LAYERED_TRANSITIONS.has(kind)

/**
 * How the incoming picture arrives, 0..1 — the one formula preview and export share.
 *
 * - `crossfade`: opacity only.
 * - `wipe-left`: revealed from the left edge rightwards.
 * - `slide-left`: pushed in from the right.
 * - `zoom`: shrunk and transparent, settling to full size.
 */
export function arrivalStyle(
  kind: TransitionKind,
  progress: number,
): { opacity: number; scale: number; wipe: number; slide: number } {
  const at = Math.min(1, Math.max(0, progress))
  switch (kind) {
    case 'crossfade':
      return { opacity: at, scale: 1, wipe: 1, slide: 0 }
    case 'wipe-left':
      return { opacity: 1, scale: 1, wipe: at, slide: 0 }
    case 'slide-left':
      return { opacity: 1, scale: 1, wipe: 1, slide: 1 - at }
    case 'zoom':
      return { opacity: at, scale: 0.85 + 0.15 * at, wipe: 1, slide: 0 }
    default:
      return { opacity: 1, scale: 1, wipe: 1, slide: 0 }
  }
}

export interface ClipTransition {
  kind: TransitionKind
  /** Seconds, centred on the cut (half before it, half after). */
  duration: number
}

const TRANSITION_KINDS = new Set<string>(Object.keys(TRANSITIONS))

export interface EditSettings {
  width: number
  height: number
  frameRate: number
}

/** A named point on the timeline — a chapter, a cue for the person, a place to come back to. */
export interface EditMarker {
  id: string
  /** Timeline seconds. */
  time: number
  /** What the point is called; omitted means an unnamed flag. */
  name?: string
}

/** The three shapes a mask can take in this version. */
export type MaskShape = 'rectangle' | 'ellipse' | 'polygon'

/** A polygon vertex, normalized inside the mask's own bounds. */
export interface MaskPoint {
  x: number
  y: number
}

/**
 * One moment of a mask's box, in **clip-local seconds** (from the clip's start, not the timeline).
 * Moving the clip therefore moves its mask animation with it; a split re-anchors the times.
 */
export interface MaskKeyframe {
  time: number
  /** Composition fractions, like the static mask. */
  x: number
  y: number
  width: number
  height: number
  /** 0..1; omitted means 1. */
  opacity?: number
  /** How the segment arriving at this keyframe travels; omitted means linear. */
  easing?: KeyframeEasing
}

/**
 * A shape mask over one clip's painted picture.
 *
 * Coordinates are **fractions of the composition**, not of the clip: the mask stays where it was
 * drawn while the clip moves, scales or is keyframed underneath it. Several masks on one clip are
 * combined in order — a normal mask adds, an inverted one subtracts — which is enough for a
 * spotlight, a circular portrait or a split-screen cut-out.
 */
export interface EditMask {
  id: string
  /** The clip whose picture is masked. */
  clipId: string
  shape: MaskShape
  /** Bounds in composition fractions, 0..1. */
  x: number
  y: number
  width: number
  height: number
  /** Polygon vertices, normalized inside the bounds. Ignored by rectangle and ellipse. */
  points?: MaskPoint[]
  /** Soft edge, in composition pixels. */
  feather: number
  /** Grow (+) or shrink (-) the shape, in composition pixels. */
  expansion: number
  inverted: boolean
  /** 0..1 alpha multiplier; lower values make the reveal partial. */
  opacity: number
  /**
   * Animated bounds. When present they replace the static box above and are held at the first and
   * last one; `time` is clip-local. Rotoscoping without automatic tracking.
   */
  keyframes?: MaskKeyframe[]
}

export interface EditDocument {
  schemaVersion: 1
  /** Bumped on every write; a writer states the revision it read. */
  revision: number
  name: string
  settings: EditSettings
  tracks: EditTrack[]
  /** Words and picture-in-picture boxes painted above the tracks. */
  overlays: EditOverlay[]
  /** Points on the timeline; they do not render, they are named places to cut or export from. */
  markers?: EditMarker[]
  /** Shape masks, each tied to one clip. They are kept here so a clip can carry several. */
  masks?: EditMask[]
}

export const DEFAULT_SETTINGS: EditSettings = { width: 1920, height: 1080, frameRate: 30 }

/**
 * The composition's own frame rate. It is a grid the exporter walks and FCPXML writes down, so an
 * impossible value is worse than a clamped one: `--fps 100000` would ask a 60-second cut for six
 * million frames. One to 240 covers every editing rate; a typo lands on the nearest end.
 */
export const MIN_FPS = 1
export const MAX_FPS = 240

export function normalizeFrameRate(
  value: unknown,
  fallback: number = DEFAULT_SETTINGS.frameRate,
): number {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return fallback
  return Math.min(MAX_FPS, Math.max(MIN_FPS, fps))
}

/**
 * The revision a write lands on: never behind what is already on disk.
 *
 * Two writers share one document — the panel and the agent. Both compute "one past the base they
 * read", and when they read the same base that is the same number twice: whoever writes second
 * leaves a file whose revision says nothing changed. Taking the higher base makes the number
 * monotonic across writers, which is what a reader's "did it move?" test relies on.
 */
export function nextRevision(base: number, onDisk: number | null): number {
  return Math.max(base, onDisk ?? 0) + 1
}

/**
 * Is a write based on a revision older than the file's?
 *
 * That is the ordinary meaning of stale, and it is refused rather than merged: the writer would
 * otherwise replace somebody else's revision with its own. Undo and redo are the exception the
 * caller decides on — they are a person naming an older document on purpose.
 */
export function isStaleRevision(base: number, onDisk: number | null): boolean {
  return onDisk !== null && onDisk > base
}

/** Nothing can be shorter than this; a zero-length clip has no picture to show. */
export const MIN_CLIP = 0.05

/** Speed is bounded so a typo cannot turn a clip into a single frame or an hour-long crawl. */
export const MIN_SPEED = 0.1
export const MAX_SPEED = 100

export const clipSpeed = (clip: { speed?: number }): number =>
  Math.min(MAX_SPEED, Math.max(MIN_SPEED, clip.speed ?? 1))

/** A clip's timing: the window it uses and how fast it plays. */
export interface ClipTiming {
  in: number
  duration: number
  speed?: number
  /** A held frame: the source time does not advance. */
  freeze?: true
}

/**
 * The source moment shown at a playback offset. One formula for the preview, the exporter and a
 * split, so a speed change can never make them disagree. A freeze clip answers `in` for every
 * offset — that is the whole of what a held frame is.
 */
export function clipSourceTime(clip: ClipTiming, offset: number): number {
  if (clip.freeze) return Math.max(0, clip.in)
  const speed = clipSpeed(clip)
  const span = clip.duration * speed
  const at = Math.min(clip.duration, Math.max(0, offset))
  const source = clip.in + at * speed
  return Math.min(clip.in + span - 1e-3, Math.max(clip.in, source))
}

const id = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const emptyDocument = (name: string, settings: EditSettings = DEFAULT_SETTINGS): EditDocument => ({
  schemaVersion: 1,
  revision: 0,
  name,
  settings,
  tracks: [{ id: 'video-1', kind: 'video', clips: [] }],
  overlays: [],
})

/** The one track things are added to until there is a reason for a second. */
export const primaryTrack = (doc: EditDocument): EditTrack =>
  doc.tracks.find((track) => track.kind === 'video') ?? doc.tracks[0]!

export const clipsOf = (doc: EditDocument): EditClip[] => doc.tracks.flatMap((track) => track.clips)

export const findClip = (doc: EditDocument, clipId: string): EditClip | undefined =>
  clipsOf(doc).find((clip) => clip.id === clipId)

/** Where the last clip on a track ends — the default place to put the next one. */
export const endOf = (track: EditTrack): number =>
  track.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)

export const durationOf = (doc: EditDocument): number =>
  doc.tracks.reduce(
    (longest, track) => Math.max(longest, endOf(track)),
    doc.overlays.reduce((longest, overlay) => Math.max(longest, overlay.start + overlay.duration), 0),
  )

/** One clip under a moment, and how far into it that moment is. */
export interface ClipPlacement {
  track: EditTrack
  clip: EditClip
  /** Seconds into the clip at this moment (`time - clip.start`). */
  offset: number
}

const placementIn = (track: EditTrack, time: number): ClipPlacement | null => {
  let found: ClipPlacement | null = null
  for (const clip of track.clips) {
    if (time >= clip.start && time < clip.start + clip.duration) {
      // Clips on one track should not overlap; if they do, the one that starts later covers the
      // one before it — the same rule the painter's `ownerAt` uses.
      if (!found || clip.start >= found.clip.start) {
        found = { track, clip, offset: time - clip.start }
      }
    }
  }
  return found
}

/** Tracks of one kind, in document order. */
export const tracksOf = (doc: EditDocument, kind: TrackKind): EditTrack[] =>
  doc.tracks.filter((track) => track.kind === kind)

/** Whether one track is heard: not muted, and soloed when anything else is. */
export function trackAudible(doc: EditDocument, track: EditTrack): boolean {
  if (track.muted) return false
  return !doc.tracks.some((candidate) => candidate.solo) || track.solo === true
}

/**
 * The clip that owns the picture at a moment.
 *
 * Video tracks stack in document order — a later track is above an earlier one — so the last
 * track with a clip under the playhead is what the viewer is looking at.
 */
export function videoClipAt(doc: EditDocument, time: number): ClipPlacement | null {
  const tracks = tracksOf(doc, 'video').filter((track) => !track.hidden)
  for (let index = tracks.length - 1; index >= 0; index -= 1) {
    const found = placementIn(tracks[index]!, time)
    if (found) return found
  }
  return null
}

/**
 * Every audible audio-track clip sounding at a moment. They mix; none of them is "the" one.
 * Mute and solo are decisions about sound, so they are honoured here and nowhere else.
 */
export function audioClipsAt(doc: EditDocument, time: number): ClipPlacement[] {
  return tracksOf(doc, 'audio')
    .filter((track) => trackAudible(doc, track))
    .map((track) => placementIn(track, time))
    .filter((found): found is ClipPlacement => !!found)
}

/** The clip under a moment on the primary video track (kept for callers that name no track). */
export const clipAt = (doc: EditDocument, time: number): ClipPlacement | null =>
  videoClipAt(doc, time)

/** One more track of a kind, with an id no other track already uses. */
export const addTrack = (doc: EditDocument, kind: TrackKind): EditDocument => {
  const used = new Set(doc.tracks.map((track) => track.id))
  let index = doc.tracks.filter((track) => track.kind === kind).length + 1
  let id = `${kind}-${index}`
  while (used.has(id)) {
    index += 1
    id = `${kind}-${index}`
  }
  return { ...doc, tracks: [...doc.tracks, { id, kind, clips: [] }] }
}

/**
 * Drop a track and the clips on it. Transitions live on the incoming clip, so nothing outside the
 * track points at it; whether a cut may lose its last video track is the caller's call (the panel
 * and the agent both refuse it), not this function's.
 */
export const removeTrack = (doc: EditDocument, trackId: string): EditDocument =>
  pruneMasks({
    ...doc,
    tracks: doc.tracks.filter((track) => track.id !== trackId),
  })

export const findOverlay = (doc: EditDocument, overlayId: string): EditOverlay | undefined =>
  doc.overlays.find((overlay) => overlay.id === overlayId)

/** The points on the timeline, in time order — an empty list when the file has none. */
export const markersOf = (doc: EditDocument): EditMarker[] => doc.markers ?? []

export const findMarker = (doc: EditDocument, markerId: string): EditMarker | undefined =>
  markersOf(doc).find((marker) => marker.id === markerId)

/** Add a named point. Markers are kept in time order so `state` reads like a chapter list. */
export const addMarker = (
  doc: EditDocument,
  input: { time: number; name?: string },
): EditDocument => {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const marker: EditMarker = {
    id: id('marker'),
    time: Math.max(0, Number.isFinite(input.time) ? input.time : 0),
    ...(name ? { name } : {}),
  }
  return {
    ...doc,
    markers: [...markersOf(doc), marker].sort((left, right) => left.time - right.time),
  }
}

/** Drop a point. Removing the last one clears the field, so the file does not keep an empty list. */
export const removeMarker = (doc: EditDocument, markerId: string): EditDocument => {
  const remaining = markersOf(doc).filter((marker) => marker.id !== markerId)
  const { markers: _markers, ...rest } = doc
  return remaining.length ? { ...rest, markers: remaining } : rest
}

const clampUnit = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0))

/** The pentagon a new polygon mask starts as, in its own normalized bounds. */
export const DEFAULT_MASK_POLYGON: readonly MaskPoint[] = [
  { x: 0.5, y: 0 },
  { x: 1, y: 0.38 },
  { x: 0.82, y: 1 },
  { x: 0.18, y: 1 },
  { x: 0, y: 0.38 },
]

function readMaskPoints(raw: unknown): MaskPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const points: MaskPoint[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const x = Number(value.x)
    const y = Number(value.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    points.push({ x: clampUnit(x), y: clampUnit(y) })
  }
  return points.length >= 3 ? points : undefined
}

/** Read a mask's animated boxes, clamped into the frame and the clip's own length. */
function readMaskKeyframes(raw: unknown, duration: number): MaskKeyframe[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const byTime = new Map<number, MaskKeyframe>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const time = Number(value.time)
    if (!Number.isFinite(time) || time < 0) continue
    const width = clampUnit(Number(value.width) || 0.5, 0.02, 1)
    const height = clampUnit(Number(value.height) || 0.5, 0.02, 1)
    const x = clampUnit(Number(value.x) || 0, 0, 1 - width)
    const y = clampUnit(Number(value.y) || 0, 0, 1 - height)
    const opacity = Number(value.opacity)
    const at = Math.min(duration, time)
    const keyframe: MaskKeyframe = {
      time: at,
      x,
      y,
      width,
      height,
      ...(Number.isFinite(opacity) ? { opacity: clampUnit(opacity) } : {}),
      ...(isKeyframeEasing(value.easing) ? { easing: value.easing } : {}),
    }
    byTime.set(Number(at.toFixed(6)), keyframe)
  }
  return byTime.size > 0
    ? [...byTime.values()].sort((left, right) => left.time - right.time)
    : undefined
}

/** Read one mask, clamping it into the composition and the shape it claims to be. */
function normalizeMask(
  raw: Record<string, unknown>,
  index: number,
  duration = Number.POSITIVE_INFINITY,
): EditMask | null {
  const clipId = typeof raw.clipId === 'string' ? raw.clipId : ''
  if (!clipId) return null
  const shape: MaskShape =
    raw.shape === 'ellipse' || raw.shape === 'polygon' ? raw.shape : 'rectangle'
  const width = clampUnit(Number(raw.width) || 0.5, 0.02, 1)
  const height = clampUnit(Number(raw.height) || 0.5, 0.02, 1)
  const points = shape === 'polygon' ? (readMaskPoints(raw.points) ?? [...DEFAULT_MASK_POLYGON]) : undefined
  const rawX = Number(raw.x)
  const rawY = Number(raw.y)
  const keyframes = readMaskKeyframes(raw.keyframes, duration)
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `mask-${index + 1}`,
    clipId,
    shape,
    x: clampUnit(Number.isFinite(rawX) ? rawX : (1 - width) / 2, 0, 1 - width),
    y: clampUnit(Number.isFinite(rawY) ? rawY : (1 - height) / 2, 0, 1 - height),
    width,
    height,
    ...(points ? { points } : {}),
    feather: clampUnit(Number(raw.feather) || 0, 0, 200),
    expansion: Math.min(200, Math.max(-200, Number(raw.expansion) || 0)),
    inverted: raw.inverted === true,
    opacity: clampUnit(Number(raw.opacity ?? 1)),
    ...(keyframes ? { keyframes } : {}),
  }
}

/** The masks in this cut, in the order they are combined. */
export const masksOf = (doc: EditDocument): EditMask[] => doc.masks ?? []

/** The masks that belong to one clip. */
export const masksForClip = (doc: EditDocument, clipId: string): EditMask[] =>
  masksOf(doc).filter((mask) => mask.clipId === clipId)

/**
 * The mask's box at a clip-local moment — the same rule as placement keyframes: interpolate
 * between the surrounding two, hold at the ends. Keyframe times are clip-local, so a moved clip
 * carries its mask animation along.
 */
export function maskAt(mask: EditMask, local: number): EditMask {
  const frames = mask.keyframes
  if (!frames || frames.length === 0) return mask
  const { keyframes: _frames, ...rest } = mask
  const at = Math.max(0, local)
  const first = frames[0]!
  const last = frames[frames.length - 1]!
  if (at <= first.time) {
    return {
      ...rest,
      x: first.x,
      y: first.y,
      width: first.width,
      height: first.height,
      opacity: first.opacity ?? 1,
    }
  }
  if (at >= last.time) {
    return {
      ...rest,
      x: last.x,
      y: last.y,
      width: last.width,
      height: last.height,
      opacity: last.opacity ?? 1,
    }
  }
  let before = first
  let after = last
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.time >= at) {
      before = frames[index - 1]!
      after = frames[index]!
      break
    }
  }
  const span = after.time - before.time
  const progress = easeKeyframe(after.easing, span > 0 ? (at - before.time) / span : 0)
  const mix = (from: number, to: number) => from + (to - from) * progress
  return {
    ...rest,
    x: mix(before.x, after.x),
    y: mix(before.y, after.y),
    width: mix(before.width, after.width),
    height: mix(before.height, after.height),
    opacity: mix(before.opacity ?? 1, after.opacity ?? 1),
  }
}

/**
 * Write the mask for a clip — one per clip in this version, so setting it again updates it.
 * A mask needs a clip that exists; a caller that got the id wrong writes nothing.
 */
export const setMask = (
  doc: EditDocument,
  input: { clipId: string } & Partial<Omit<EditMask, 'id' | 'clipId'>>,
): EditDocument => {
  const clip = findClip(doc, input.clipId)
  if (!clip) return doc
  const existing = masksForClip(doc, input.clipId)[0]
  const mask = normalizeMask(
    { ...(existing ?? {}), ...input, id: existing?.id ?? id('mask') } as Record<string, unknown>,
    masksOf(doc).length,
    clip.duration,
  )
  if (!mask) return doc
  return {
    ...doc,
    masks: [...masksOf(doc).filter((item) => item.clipId !== input.clipId), mask],
  }
}

/** Remove a clip's mask; removing the last one clears the field. */
export const clearMask = (doc: EditDocument, clipId: string): EditDocument => {
  const all = masksOf(doc)
  const remaining = all.filter((mask) => mask.clipId !== clipId)
  if (remaining.length === all.length) return doc
  const { masks: _masks, ...rest } = doc
  return remaining.length ? { ...rest, masks: remaining } : rest
}

/** Drop masks whose clip no longer exists. Every removal path ends with this. */
export function pruneMasks(doc: EditDocument): EditDocument {
  const all = masksOf(doc)
  if (all.length === 0) return doc
  const ids = new Set(clipsOf(doc).map((clip) => clip.id))
  const kept = all.filter((mask) => ids.has(mask.clipId))
  if (kept.length === all.length) return doc
  const { masks: _masks, ...rest } = doc
  return kept.length ? { ...rest, masks: kept } : rest
}

/**
 * Move a mask's animation to a new clip-local origin — the same rule slicing uses for placement
 * keyframes: shift by the trimmed head, drop what fell outside, clamp what sits on an edge.
 */
function reanchorMask(mask: EditMask, shift: number, duration: number): EditMask {
  if (!mask.keyframes?.length) return mask
  const keyframes = mask.keyframes
    .map((frame) => ({ ...frame, time: frame.time - shift }))
    .filter((frame) => frame.time >= -1e-9 && frame.time <= duration + 1e-9)
    .map((frame) => ({ ...frame, time: Math.min(duration, Math.max(0, frame.time)) }))
  const { keyframes: _frames, ...rest } = mask
  return keyframes.length ? { ...rest, keyframes } : rest
}

/**
 * A split turns one clip into two ids; the mask belongs to the picture, not the id, so every new
 * piece over the old clip's span gets its own copy. Used by split, cut_at and freeze.
 */
function carrySplitMasks(before: EditDocument, after: EditDocument): EditDocument {
  const known = new Set(clipsOf(before).map((clip) => clip.id))
  const additions: EditMask[] = []
  for (const clip of clipsOf(after)) {
    if (known.has(clip.id)) continue
    const ancestor = clipsOf(before).find(
      (candidate) =>
        masksForClip(before, candidate.id).length > 0 &&
        clip.start >= candidate.start - 1e-6 &&
        clip.start + clip.duration <= candidate.start + candidate.duration + 1e-6,
    )
    if (!ancestor) continue
    for (const mask of masksForClip(before, ancestor.id)) {
      const moved = reanchorMask(mask, clip.start - ancestor.start, clip.duration)
      additions.push({ ...moved, id: id('mask'), clipId: clip.id })
    }
  }
  return additions.length ? { ...after, masks: [...masksOf(after), ...additions] } : after
}

/** Add words or a picture-in-picture box above the tracks. */
export const addOverlay = (
  doc: EditDocument,
  overlay: Omit<EditOverlay, 'id'> & { id?: string },
): EditDocument => ({
  ...doc,
  overlays: [...doc.overlays, { ...overlay, id: overlay.id ?? id('ov') }],
})

export const updateOverlay = (
  doc: EditDocument,
  overlayId: string,
  change: Partial<EditOverlay>,
): EditDocument => ({
  ...doc,
  overlays: doc.overlays.map((overlay) =>
    overlay.id === overlayId ? { ...overlay, ...change, id: overlay.id } : overlay,
  ),
})

export const removeOverlay = (doc: EditDocument, overlayId: string): EditDocument => ({
  ...doc,
  overlays: doc.overlays.filter((overlay) => overlay.id !== overlayId),
})

/** A hand-written fade is usable only when at least one side is positive. */
const readFade = (raw: unknown): { fadeIn: number; fadeOut: number } | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const fadeIn = Math.max(0, Number(value.fadeIn) || 0)
  const fadeOut = Math.max(0, Number(value.fadeOut) || 0)
  return fadeIn > 0 || fadeOut > 0 ? { fadeIn, fadeOut } : undefined
}

/** Volume keyframes, sorted and clamped. Anything unreadable is dropped, not fatal. */
const readAutomation = (raw: unknown): VolumePoint[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const points: VolumePoint[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const time = Number(value.time)
    const gain = Number(value.value)
    if (!Number.isFinite(time) || !Number.isFinite(gain) || time < 0) continue
    points.push({ time, value: Math.min(1, Math.max(0, gain)) })
  }
  points.sort((left, right) => left.time - right.time)
  return points.length > 0 ? points : undefined
}

/** A transform with every field inside its legal range — what a keyframe stores. */
const clampTransform = (raw: unknown): ClipTransform => {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const number = (key: 'x' | 'y' | 'scale' | 'rotation' | 'radius'): number => {
    const parsed = Number(value[key])
    return Number.isFinite(parsed) ? parsed : NEUTRAL_TRANSFORM[key]
  }
  return {
    x: Math.min(1, Math.max(-1, number('x'))),
    y: Math.min(1, Math.max(-1, number('y'))),
    scale: Math.min(4, Math.max(0.05, number('scale'))),
    rotation: Math.min(360, Math.max(-360, number('rotation'))),
    radius: Math.min(0.5, Math.max(0, number('radius'))),
    ...(value.flipX === true ? { flipX: true } : {}),
  }
}

const isNeutralTransform = (transform: ClipTransform): boolean =>
  transform.x === 0 &&
  transform.y === 0 &&
  transform.scale === 1 &&
  transform.rotation === 0 &&
  transform.radius === 0 &&
  transform.flipX !== true

const readTransform = (raw: unknown): ClipTransform | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const transform = clampTransform(raw)
  return isNeutralTransform(transform) ? undefined : transform
}

/** A crop is kept only when it actually cuts something away; the full frame is stored as absent. */
const readCrop = (raw: unknown): CropRect | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const number = (key: keyof CropRect, fallback: number): number => {
    const parsed = Number(value[key])
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const w = Math.min(1, Math.max(0.02, number('w', 1)))
  const h = Math.min(1, Math.max(0.02, number('h', 1)))
  const x = Math.min(1 - w, Math.max(0, number('x', 0)))
  const y = Math.min(1 - h, Math.max(0, number('y', 0)))
  if (x === 0 && y === 0 && w === 1 && h === 1) return undefined
  return { x, y, w, h }
}

/**
 * Placement keyframes: sorted, de-duplicated (last one at a moment wins), and bounded by the clip.
 *
 * A keyframe outside the clip is clamped to its edge rather than dropped — the writer meant "hold
 * this look", and a frame that never plays is worse than one that holds.
 */
const readKeyframes = (raw: unknown, duration: number): TransformKeyframe[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const byTime = new Map<number, TransformKeyframe>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const parsed = Number(value.time)
    if (!Number.isFinite(parsed)) continue
    const time = Math.min(Math.max(0, parsed), Math.max(0, duration))
    byTime.set(time, {
      time,
      transform: clampTransform(value.transform),
      ...(Number.isFinite(Number(value.opacity)) && value.opacity !== undefined
        ? { opacity: Math.min(1, Math.max(0, Number(value.opacity))) }
        : {}),
      ...(isKeyframeEasing(value.easing) && value.easing !== 'linear'
        ? { easing: value.easing }
        : {}),
    })
  }
  const frames = [...byTime.values()].sort((left, right) => left.time - right.time)
  return frames.length ? frames : undefined
}

/** A transition written by hand is kept only when its kind is one we can render. */
const readTransition = (raw: unknown): ClipTransition | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.kind !== 'string' || !TRANSITION_KINDS.has(value.kind)) return undefined
  const duration = Number(value.duration)
  if (!Number.isFinite(duration) || duration <= 0) return undefined
  return {
    kind: value.kind as TransitionKind,
    duration: Math.min(5, Math.max(0.05, duration)),
  }
}

/** Ducking settings as the panel wrote them; a missing trigger track makes them meaningless. */
const readDucking = (raw: unknown): DuckingSettings | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.sourceTrackId !== 'string' || !value.sourceTrackId.trim()) return undefined
  const number = (key: string, fallback: number): number => {
    const parsed = Number(value[key])
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    sourceTrackId: value.sourceTrackId.trim(),
    threshold: Math.min(0, Math.max(-60, number('threshold', -30))),
    reduction: Math.min(1, Math.max(0, number('reduction', 0.6))),
    attack: Math.max(0.01, number('attack', 0.1)),
    release: Math.max(0.01, number('release', 0.3)),
    holdTime: Math.max(0, number('holdTime', 0.2)),
  }
}

/** The document as the editor should hold it, whatever the file on disk actually says. */
export const normalizeDocument = (raw: unknown, fallbackName: string): EditDocument => {
  const base = emptyDocument(fallbackName)
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Record<string, unknown>

  const name = typeof value.name === 'string' && value.name.trim() ? value.name : fallbackName
  const settingsValue = (value.settings ?? {}) as Record<string, unknown>
  const settings: EditSettings = {
    width: Number(settingsValue.width) > 0 ? Number(settingsValue.width) : DEFAULT_SETTINGS.width,
    height: Number(settingsValue.height) > 0 ? Number(settingsValue.height) : DEFAULT_SETTINGS.height,
    frameRate: normalizeFrameRate(settingsValue.frameRate),
  }

  const tracks: EditTrack[] = []
  if (Array.isArray(value.tracks)) {
    for (const [index, candidate] of (value.tracks as Array<Record<string, unknown>>).entries()) {
      const kind: TrackKind = candidate.kind === 'audio' ? 'audio' : 'video'
      const clips = Array.isArray(candidate.clips)
        ? (candidate.clips as Array<Record<string, unknown>>)
            .map((clip) => {
              const duration = Math.max(MIN_CLIP, Number(clip.duration) || 0)
              const keyframes = readKeyframes(clip.keyframes, duration)
              return {
                id: typeof clip.id === 'string' ? clip.id : id('clip'),
                src: typeof clip.src === 'string' ? clip.src : '',
                start: Math.max(0, Number(clip.start) || 0),
                in: Math.max(0, Number(clip.in) || 0),
                duration,
                ...(Number.isFinite(Number(clip.speed)) &&
                Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(clip.speed))) !== 1
                  ? { speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(clip.speed))) }
                  : {}),
                ...(Number.isFinite(Number(clip.volume))
                  ? { volume: Math.min(1, Math.max(0, Number(clip.volume))) }
                  : {}),
                ...(clip.muted === true ? { muted: true } : {}),
                ...(readFade(clip.fade) ? { fade: readFade(clip.fade) } : {}),
                ...(readAutomation(clip.automation) ? { automation: readAutomation(clip.automation) } : {}),
                ...(readDucking(clip.ducking) ? { ducking: readDucking(clip.ducking) } : {}),
                ...(readTransform(clip.transform) ? { transform: readTransform(clip.transform) } : {}),
                ...(readCrop(clip.crop) ? { crop: readCrop(clip.crop) } : {}),
                ...(clip.freeze === true ? { freeze: true as const } : {}),
                ...(Number.isFinite(Number(clip.opacity))
                  ? { opacity: Math.min(1, Math.max(0, Number(clip.opacity))) }
                  : {}),
                ...(normalizeEffect(clip.effect) ? { effect: normalizeEffect(clip.effect) } : {}),
                ...(normalizeAudioEffect(clip.audioEffect)
                  ? { audioEffect: normalizeAudioEffect(clip.audioEffect) }
                  : {}),
                ...(readTransition(clip.transition) ? { transition: readTransition(clip.transition) } : {}),
                ...(keyframes ? { keyframes } : {}),
              }
            })
            .filter((clip) => clip.src)
        : []
      tracks.push({
        id: typeof candidate.id === 'string' ? candidate.id : `${kind}-${index + 1}`,
        kind,
        clips,
        ...(typeof candidate.name === 'string' && candidate.name.trim()
          ? { name: candidate.name.trim() }
          : {}),
        ...(candidate.muted === true ? { muted: true } : {}),
        ...(candidate.solo === true ? { solo: true } : {}),
        ...(candidate.locked === true ? { locked: true } : {}),
        ...(candidate.hidden === true ? { hidden: true } : {}),
      })
    }
  }

  // The first version of this file was `{ name, clips }` — one track, no absolute times. Reading
  // it here means an existing cut keeps working instead of silently opening empty.
  if (tracks.length === 0 && Array.isArray(value.clips)) {
    let at = 0
    const clips = (value.clips as Array<Record<string, unknown>>)
      .map((clip) => {
        const duration = Math.max(MIN_CLIP, Number(clip.duration) || 0)
        const next: EditClip = {
          id: typeof clip.id === 'string' ? clip.id : id('clip'),
          src: typeof clip.src === 'string' ? clip.src : '',
          start: at,
          in: Math.max(0, Number(clip.in) || 0),
          duration,
        }
        at += duration
        return next
      })
      .filter((clip) => clip.src)
    tracks.push({ id: 'video-1', kind: 'video', clips })
  }

  const overlays: EditOverlay[] = Array.isArray(value.overlays)
    ? (value.overlays as unknown[])
        .map((raw, index) => normalizeOverlay(raw, index))
        .filter((overlay): overlay is EditOverlay => !!overlay)
    : []

  const markerIds = new Set<string>()
  const markers: EditMarker[] = Array.isArray(value.markers)
    ? (value.markers as Array<Record<string, unknown>>)
        .map((raw, index) => {
          const time = Number(raw.time)
          if (!Number.isFinite(time) || time < 0) return null
          const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
          let markerId = typeof raw.id === 'string' && raw.id ? raw.id : `marker-${index + 1}`
          while (markerIds.has(markerId)) markerId = `${markerId}-${index + 1}`
          markerIds.add(markerId)
          return { id: markerId, time, ...(name ? { name } : {}) }
        })
        .filter((marker): marker is EditMarker => !!marker)
        .sort((left, right) => left.time - right.time)
    : []

  // A mask without its clip is stale: it would never be drawn, so it is dropped on the way in.
  const clipIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)))
  const clipDurations = new Map(
    tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip.duration] as const)),
  )
  const masks: EditMask[] = Array.isArray(value.masks)
    ? (value.masks as Array<Record<string, unknown>>)
        .map((raw, index) =>
          normalizeMask(
            raw,
            index,
            clipDurations.get(typeof raw.clipId === 'string' ? raw.clipId : '') ?? Number.POSITIVE_INFINITY,
          ),
        )
        .filter((mask): mask is EditMask => !!mask && clipIds.has(mask.clipId))
    : []

  return {
    schemaVersion: 1,
    revision: Math.max(0, Number(value.revision) || 0),
    name,
    settings,
    tracks: tracks.length > 0 ? tracks : base.tracks,
    overlays,
    ...(markers.length ? { markers } : {}),
    ...(masks.length ? { masks } : {}),
  }
}

/** Add a source at the end of the primary track (or at `start`, when the caller knows). */
export const addClip = (
  doc: EditDocument,
  input: {
    src: string
    duration: number
    in?: number
    start?: number
    trackId?: string
    volume?: number
    muted?: boolean
    fadeIn?: number
    fadeOut?: number
  },
): EditDocument => {
  const track = doc.tracks.find((candidate) => candidate.id === (input.trackId ?? primaryTrack(doc).id)) ?? primaryTrack(doc)
  const fadeIn = Math.max(0, input.fadeIn ?? 0)
  const fadeOut = Math.max(0, input.fadeOut ?? 0)
  const clip: EditClip = {
    id: id('clip'),
    src: input.src,
    start: Math.max(0, input.start ?? endOf(track)),
    in: Math.max(0, input.in ?? 0),
    duration: Math.max(MIN_CLIP, input.duration),
    ...(input.volume !== undefined ? { volume: Math.min(1, Math.max(0, input.volume)) } : {}),
    ...(input.muted ? { muted: true } : {}),
    ...(fadeIn > 0 || fadeOut > 0 ? { fade: { fadeIn, fadeOut } } : {}),
  }
  return {
    ...doc,
    tracks: doc.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, clips: [...candidate.clips, clip] } : candidate,
    ),
  }
}

const withClip = (doc: EditDocument, clipId: string, change: (clip: EditClip) => EditClip): EditDocument => ({
  ...doc,
  tracks: doc.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => (clip.id === clipId ? change(clip) : clip)),
  })),
})

export const moveClip = (doc: EditDocument, clipId: string, start: number): EditDocument =>
  withClip(doc, clipId, (clip) => ({ ...clip, start: Math.max(0, start) }))

/** Trim either edge: `in` moves the head, `duration` the tail. */
export const trimClip = (
  doc: EditDocument,
  clipId: string,
  change: { in?: number; duration?: number },
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const nextIn = Math.max(0, change.in ?? clip.in)
    const nextDuration = Math.max(MIN_CLIP, change.duration ?? clip.duration)
    return { ...clip, in: nextIn, duration: nextDuration }
  })

/**
 * Trim from either edge, counted in **timeline** seconds — the shape a person means by "cut two
 * seconds off the front".
 *
 * `head` removes it from the beginning and moves `start` right, so the rest of the piece stays at
 * the same timeline moment; the source window advances by `head × speed` (a held frame keeps its
 * `in`, because the frame is the whole content). `tail` only shortens the piece. The two are
 * clamped together so the result is never shorter than `MIN_CLIP`.
 */
export const trimEdges = (
  doc: EditDocument,
  clipId: string,
  change: { head?: number; tail?: number },
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const room = Math.max(0, clip.duration - MIN_CLIP)
    const head = Math.min(room, Math.max(0, change.head ?? 0))
    const tail = Math.min(room - head, Math.max(0, change.tail ?? 0))
    if (head <= 0 && tail <= 0) return clip
    return {
      ...clip,
      start: clip.start + head,
      in: clip.freeze ? clip.in : clip.in + head * clipSpeed(clip),
      duration: Math.max(MIN_CLIP, clip.duration - head - tail),
    }
  })

export const removeClip = (doc: EditDocument, clipId: string): EditDocument =>
  pruneMasks({
    ...doc,
    tracks: doc.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) })),
  })

/**
 * The part of a cut between two timeline moments, as a document that starts at 0.
 *
 * Exporting a range is a slice, not a second renderer: a clip that crosses `from` advances its
 * source window by the trimmed head (speed included) and keeps the rest of itself; the tail is
 * clipped at `to`. Keyframes and volume points are clip-local, so they move with the material.
 * A transition whose cut is trimmed away is dropped — it would otherwise be re-centred on the new
 * head and fire at a moment that was never a cut.
 */
export function sliceDocument(doc: EditDocument, from: number, to: number): EditDocument {
  const start = Math.max(0, Math.min(from, to))
  const end = Math.max(0, Math.max(from, to))
  const length = end - start
  if (!(length > 0)) {
    return {
      ...doc,
      tracks: doc.tracks.map((track) => ({ ...track, clips: [] })),
      overlays: [],
      ...(doc.markers ? { markers: [] } : {}),
    }
  }

  const maskShifts = new Map<string, { shift: number; duration: number }>()
  const tracks = doc.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      const clipEnd = clip.start + clip.duration
      const overlapStart = Math.max(clip.start, start)
      const overlapEnd = Math.min(clipEnd, end)
      const duration = overlapEnd - overlapStart
      if (duration < MIN_CLIP - 1e-9) return []
      const head = overlapStart - clip.start
      const tail = clipEnd - overlapEnd
      const speed = clipSpeed(clip)
      // A mask's animation is clip-local; a trimmed head moves its origin.
      if (head > 1e-9 || duration < clip.duration - 1e-9) {
        maskShifts.set(clip.id, { shift: head, duration })
      }

      const keyframes = clip.keyframes
        ?.map((keyframe) => ({ ...keyframe, time: keyframe.time - head }))
        .filter((keyframe) => keyframe.time >= -1e-9 && keyframe.time <= duration + 1e-9)
        .map((keyframe) => ({ ...keyframe, time: Math.min(duration, Math.max(0, keyframe.time)) }))
      const automation = clip.automation
        ?.map((point) => ({ ...point, time: point.time - head }))
        .filter((point) => point.time >= -1e-9 && point.time <= duration + 1e-9)
        .map((point) => ({ ...point, time: Math.min(duration, Math.max(0, point.time)) }))
      const fadeIn = Math.max(0, (clip.fade?.fadeIn ?? 0) - head)
      const fadeOut = Math.max(0, (clip.fade?.fadeOut ?? 0) - tail)
      const { keyframes: _keyframes, automation: _automation, transition: _transition, fade: _fade, ...rest } =
        clip

      return [
        {
          ...rest,
          start: overlapStart - start,
          in: clip.freeze ? clip.in : clip.in + head * speed,
          duration,
          ...(keyframes?.length ? { keyframes } : {}),
          ...(automation?.length ? { automation } : {}),
          ...(fadeIn > 0 || fadeOut > 0 ? { fade: { fadeIn, fadeOut } } : {}),
          // A cut is only a cut while the incoming clip's own head is inside the range.
          ...(head <= 1e-9 && clip.transition ? { transition: clip.transition } : {}),
        },
      ]
    }),
  }))

  const overlays = doc.overlays.flatMap((overlay) => {
    const overlayEnd = overlay.start + overlay.duration
    const overlapStart = Math.max(overlay.start, start)
    const overlapEnd = Math.min(overlayEnd, end)
    const duration = overlapEnd - overlapStart
    if (duration < MIN_CLIP - 1e-9) return []
    return [{ ...overlay, start: overlapStart - start, duration }]
  })

  const markers = doc.markers
    ?.filter((marker) => marker.time >= start - 1e-9 && marker.time <= end + 1e-9)
    .map((marker) => ({ ...marker, time: Math.max(0, marker.time - start) }))

  const masks = doc.masks?.map((mask) => {
    const move = maskShifts.get(mask.clipId)
    return move ? reanchorMask(mask, move.shift, move.duration) : mask
  })

  return pruneMasks({
    ...doc,
    tracks,
    overlays,
    ...(markers ? { markers } : {}),
    ...(masks ? { masks } : {}),
  })
}

/** How loud a clip's own sound is. Muted wins over a volume that was set before it. */
export const clipVolume = (clip: EditClip): number =>
  clip.muted ? 0 : Math.min(1, Math.max(0, clip.volume ?? 1))

/**
 * The gain at a moment **inside** the clip: volume, mute, then the fade envelope.
 *
 * This is OpenReel's `fadeValueAtTime`: a linear ramp up over `fadeIn` seconds and down over the
 * last `fadeOut`, whichever is lower. The preview and the exporter both call this, so a fade is
 * heard the same way it is written.
 */
export const clipGainAt = (clip: EditClip, offset: number): number => {
  const base = clipVolume(clip)
  if (base === 0) return 0
  const fadeIn = Math.max(0, clip.fade?.fadeIn ?? 0)
  const fadeOut = Math.max(0, clip.fade?.fadeOut ?? 0)
  const inValue = fadeIn > 0 ? Math.min(1, Math.max(0, offset / fadeIn)) : 1
  const outValue = fadeOut > 0 ? Math.min(1, Math.max(0, (clip.duration - offset) / fadeOut)) : 1
  return base * Math.min(inValue, outValue) * automationGainAt(clip.automation, offset)
}

/**
 * Change playback speed while keeping the **source window**: a clip made twice as fast covers the
 * same material in half the time.
 *
 * The rest of the track follows by default: a packed cut stays packed, so a speed change neither
 * opens a gap nor covers its neighbour. `ripple: false` keeps every other clip where it is, for a
 * caller that is about to arrange them itself.
 */
export const setClipSpeed = (
  doc: EditDocument,
  clipId: string,
  speed: number,
  options: { ripple?: boolean } = {},
): EditDocument => {
  const target = findClip(doc, clipId)
  if (!target) return doc
  const next = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
  const previous = clipSpeed(target)
  if (next === previous) return doc
  const duration = Math.max(MIN_CLIP, (target.duration * previous) / next)
  const shift = duration - target.duration
  const after = target.start + target.duration
  const ripple = options.ripple ?? true
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      const holdsClip = track.clips.some((clip) => clip.id === clipId)
      return {
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id === clipId) {
            const { speed: _previous, ...rest } = clip
            return { ...rest, duration, ...(next !== 1 ? { speed: next } : {}) }
          }
          // Only clips that began at or after this one's old end move, and only on its own
          // track, so gaps further down keep their distance and other lanes stay put.
          if (holdsClip && ripple && shift !== 0 && clip.start >= after) {
            return { ...clip, start: Math.max(0, clip.start + shift) }
          }
          return clip
        }),
      }
    }),
  }
}

/** Change one clip's sound without touching its picture or its window. */
export const setClipAudio = (
  doc: EditDocument,
  clipId: string,
  change: { volume?: number; muted?: boolean },
): EditDocument =>
  withClip(doc, clipId, (clip) => ({
    ...clip,
    ...(change.volume !== undefined ? { volume: Math.min(1, Math.max(0, change.volume)) } : {}),
    ...(change.muted !== undefined ? { muted: change.muted } : {}),
  }))

/** Fade one clip's sound in and/or out, in seconds from each edge. */
export const setClipFade = (
  doc: EditDocument,
  clipId: string,
  fade: { fadeIn?: number; fadeOut?: number },
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const fadeIn = Math.max(0, fade.fadeIn ?? clip.fade?.fadeIn ?? 0)
    const fadeOut = Math.max(0, fade.fadeOut ?? clip.fade?.fadeOut ?? 0)
    const { fade: _previous, ...rest } = clip
    return fadeIn > 0 || fadeOut > 0 ? { ...rest, fade: { fadeIn, fadeOut } } : rest
  })

/** Replace a clip's volume keyframes; an empty list removes them. */
export const setClipAutomation = (
  doc: EditDocument,
  clipId: string,
  points: readonly VolumePoint[] | undefined,
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { automation: _previous, ...rest } = clip
    const next = (points ?? [])
      .map((point) => ({
        time: Math.max(0, point.time),
        value: Math.min(1, Math.max(0, point.value)),
      }))
      .sort((left, right) => left.time - right.time)
    return next.length > 0 ? { ...rest, automation: next } : rest
  })

/**
 * Store the settings ducking was baked from together with the keyframes they produced. One write,
 * so the document never says "ducked" without saying how.
 */
export const setClipDucking = (
  doc: EditDocument,
  clipId: string,
  settings: DuckingSettings,
  points: readonly VolumePoint[],
): EditDocument =>
  withClip(doc, clipId, (clip) => ({
    ...clip,
    ducking: settings,
    ...(points.length > 0
      ? {
          automation: points
            .map((point) => ({
              time: Math.max(0, point.time),
              value: Math.min(1, Math.max(0, point.value)),
            }))
            .sort((left, right) => left.time - right.time),
        }
      : {}),
  }))

/** Remove ducking and the keyframes it baked — MiniMax's "clear" does the same. */
export const clearClipDucking = (doc: EditDocument, clipId: string): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { ducking: _ducking, automation: _automation, ...rest } = clip
    return rest
  })

/** Change the picture's placement; going back to neutral removes the transform entirely. */
export const setClipTransform = (
  doc: EditDocument,
  clipId: string,
  change: Partial<ClipTransform> & { opacity?: number },
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { transform: _previous, opacity: _opacity, ...rest } = clip
    const merged = { ...NEUTRAL_TRANSFORM, ...clip.transform, ...change }
    const transform: ClipTransform = {
      x: Math.min(1, Math.max(-1, merged.x)),
      y: Math.min(1, Math.max(-1, merged.y)),
      scale: Math.min(4, Math.max(0.05, merged.scale)),
      rotation: Math.min(360, Math.max(-360, merged.rotation)),
      radius: Math.min(0.5, Math.max(0, merged.radius)),
      ...(merged.flipX === true ? { flipX: true } : {}),
    }
    const neutral =
      transform.x === 0 &&
      transform.y === 0 &&
      transform.scale === 1 &&
      transform.rotation === 0 &&
      transform.radius === 0 &&
      transform.flipX !== true
    const opacity =
      change.opacity === undefined ? clip.opacity : Math.min(1, Math.max(0, change.opacity))
    return {
      ...rest,
      ...(neutral ? {} : { transform }),
      ...(opacity !== undefined && opacity < 1 ? { opacity } : {}),
    }
  })

/**
 * The placement a clip shows at a clip-local moment — the one formula preview and export share.
 *
 * With no keyframes it is the clip's own `transform`/`opacity`. With them, the moment is
 * interpolated linearly between the two keyframes that surround it, and held at the first or last
 * one outside their span.
 */
export function clipVisualAt(
  clip: {
    duration: number
    transform?: ClipTransform
    opacity?: number
    keyframes?: TransformKeyframe[]
  },
  local: number,
): { transform: ClipTransform; opacity?: number } {
  const frames = clip.keyframes
  if (!frames || frames.length === 0) {
    return {
      transform: clip.transform ?? NEUTRAL_TRANSFORM,
      ...(clip.opacity !== undefined ? { opacity: clip.opacity } : {}),
    }
  }

  const at = Math.min(Math.max(0, local), Math.max(0, clip.duration))
  const first = frames[0]!
  const last = frames[frames.length - 1]!
  if (at <= first.time) {
    return { transform: first.transform, ...(first.opacity !== undefined ? { opacity: first.opacity } : {}) }
  }
  if (at >= last.time) {
    return { transform: last.transform, ...(last.opacity !== undefined ? { opacity: last.opacity } : {}) }
  }

  let before = first
  let after = last
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.time >= at) {
      before = frames[index - 1]!
      after = frames[index]!
      break
    }
  }
  const span = after.time - before.time
  const progress = easeKeyframe(after.easing, span > 0 ? (at - before.time) / span : 0)
  const mix = (from: number, to: number) => from + (to - from) * progress

  const transform: ClipTransform = {
    x: mix(before.transform.x, after.transform.x),
    y: mix(before.transform.y, after.transform.y),
    scale: mix(before.transform.scale, after.transform.scale),
    rotation: mix(before.transform.rotation, after.transform.rotation),
    radius: mix(before.transform.radius, after.transform.radius),
    // A mirror has no in-between: it switches halfway through the segment.
    ...((progress < 0.5 ? before.transform.flipX : after.transform.flipX) === true
      ? { flipX: true }
      : {}),
  }
  const opacity =
    before.opacity === undefined && after.opacity === undefined
      ? undefined
      : mix(before.opacity ?? 1, after.opacity ?? 1)
  return { transform, ...(opacity !== undefined ? { opacity } : {}) }
}

/**
 * Replace a clip's placement keyframes. `null` (or an empty list) turns them off, and the clip
 * falls back to its static `transform`/`opacity` — which this deliberately leaves untouched, so
 * turning keyframes off restores the look the clip had before them.
 */
export const setClipKeyframes = (
  doc: EditDocument,
  clipId: string,
  keyframes: TransformKeyframe[] | null,
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { keyframes: _previous, ...rest } = clip
    const frames = readKeyframes(keyframes, clip.duration)
    return frames ? { ...rest, keyframes: frames } : rest
  })

/**
 * Change a clip's crop window. Values merge into what is already there; `null` restores the whole
 * source frame, and a rectangle that covers everything is stored as no crop at all.
 */
export const setClipCrop = (
  doc: EditDocument,
  clipId: string,
  change: Partial<CropRect> | null,
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { crop: _previous, ...rest } = clip
    const next = readCrop(change === null ? null : { ...(clip.crop ?? FULL_FRAME), ...change })
    return next ? { ...rest, crop: next } : rest
  })

/**
 * Give a media overlay a frame, or take it away (`null`). Text overlays keep their look in `style`
 * and ignore this.
 */
export const setOverlayFrame = (
  doc: EditDocument,
  overlayId: string,
  frame: OverlayFrame | null,
): EditDocument => ({
  ...doc,
  overlays: doc.overlays.map((overlay) => {
    if (overlay.id !== overlayId) return overlay
    const { frame: _previous, ...rest } = overlay
    if (overlay.kind !== 'media' || !frame || frame.width <= 0) return rest
    return { ...rest, frame }
  }),
})

/**
 * Replace a clip's colour grade. `null` clears it; a preset on its own means "the preset's own
 * numbers", and explicit values pin the look regardless of what the preset says.
 */
export const setClipEffect = (
  doc: EditDocument,
  clipId: string,
  effect: ClipEffect | null,
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { effect: _previous, ...rest } = clip
    const next = normalizeEffect(effect)
    return next ? { ...rest, effect: next } : rest
  })

/**
 * Change the tone of a clip's own sound. Values merge into what is already there; neutral values
 * are dropped, and `null` clears the whole tone.
 */
export const setClipAudioEffect = (
  doc: EditDocument,
  clipId: string,
  change: Partial<AudioEffect> | null,
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { audioEffect: _previous, ...rest } = clip
    if (!change) return rest
    const next = normalizeAudioEffect({ ...clip.audioEffect, ...change })
    return next ? { ...rest, audioEffect: next } : rest
  })

/** Put a copy of a clip right after it, on the same track. */
export const duplicateClip = (doc: EditDocument, clipId: string): EditDocument => {
  const track = trackOfClip(doc, clipId)
  const clip = track?.clips.find((candidate) => candidate.id === clipId)
  if (!track || !clip) return doc
  const copy: EditClip = { ...clip, id: id('clip'), start: clip.start + clip.duration }
  const copiedMasks = masksForClip(doc, clipId).map((mask) => ({
    ...mask,
    id: id('mask'),
    clipId: copy.id,
  }))
  return {
    ...doc,
    tracks: doc.tracks.map((candidate) =>
      candidate.id === track.id ? { ...candidate, clips: [...candidate.clips, copy] } : candidate,
    ),
    ...(copiedMasks.length ? { masks: [...masksOf(doc), ...copiedMasks] } : {}),
  }
}

/** Delete a clip and pull the rest of its track left by its duration. */
export const rippleDelete = (doc: EditDocument, clipId: string): EditDocument => {
  const track = trackOfClip(doc, clipId)
  const clip = track?.clips.find((candidate) => candidate.id === clipId)
  if (!track || !clip) return doc
  const end = clip.start + clip.duration
  return pruneMasks({
    ...doc,
    tracks: doc.tracks.map((candidate) =>
      candidate.id === track.id
        ? {
            ...candidate,
            clips: candidate.clips
              .filter((item) => item.id !== clipId)
              .map((item) =>
                item.start >= end - 1e-6
                  ? { ...item, start: Math.max(0, item.start - clip.duration) }
                  : item,
              ),
          }
        : candidate,
    ),
  })
}

/** Move a clip left until it touches the clip before it. */
export const closeGap = (doc: EditDocument, clipId: string): EditDocument => {
  const track = trackOfClip(doc, clipId)
  const clip = track?.clips.find((candidate) => candidate.id === clipId)
  if (!track || !clip) return doc
  const previousEnd = track.clips
    .filter((item) => item.id !== clipId && item.start + item.duration <= clip.start + 1e-6)
    .reduce((end, item) => Math.max(end, item.start + item.duration), 0)
  return previousEnd >= clip.start ? doc : moveClip(doc, clipId, previousEnd)
}

/** Pack one track (or every track) against zero, removing every gap. */
export const removeGaps = (doc: EditDocument, trackId?: string): EditDocument => ({
  ...doc,
  tracks: doc.tracks.map((track) => {
    if (trackId && track.id !== trackId) return track
    let at = 0
    const clips = [...track.clips]
      .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
      .map((clip) => {
        const placed = { ...clip, start: at }
        at += clip.duration
        return placed
      })
    return { ...track, clips }
  }),
})

/** Set (or clear, with `null`) the transition that brings a clip in from the one before it. */
export const setTransition = (
  doc: EditDocument,
  clipId: string,
  transition: { kind: TransitionKind; duration: number } | null,
): EditDocument =>
  withClip(doc, clipId, (clip) => {
    const { transition: _previous, ...rest } = clip
    if (!transition || !TRANSITION_KINDS.has(transition.kind)) return rest
    return {
      ...rest,
      transition: {
        kind: transition.kind,
        duration: Math.min(5, Math.max(0.05, transition.duration)),
      },
    }
  })

export const clearTransition = (doc: EditDocument, clipId: string): EditDocument =>
  setTransition(doc, clipId, null)

export interface TransitionFrame {
  kind: TransitionKind
  /** 0..1 across the window; 0.5 is the cut itself. */
  progress: number
  /** The outgoing picture. Past its window it holds its last frame. */
  from: { clip: EditClip; offset: number }
  /** The incoming picture. Before its window it holds its first frame. */
  to: { clip: EditClip; offset: number }
}

/** Clamp a window offset: outside the clip we show a held frame, never a hole. */
const heldOffset = (clip: EditClip, offset: number): number =>
  Math.min(Math.max(0, offset), Math.max(0, clip.duration - 1e-3))

/**
 * The transition covering a moment on the topmost video track, if any.
 *
 * A transition belongs to the **incoming** clip (`to.transition`) and is centred on the cut:
 * half of its duration comes from each side. Clips usually have no handle material outside their
 * own window, so that side holds its edge frame — continuous, and the same in preview and export.
 */
export function transitionAt(doc: EditDocument, time: number): TransitionFrame | null {
  const tracks = tracksOf(doc, 'video').filter((track) => !track.hidden)
  for (let index = tracks.length - 1; index >= 0; index -= 1) {
    const track = tracks[index]!
    const clips = [...track.clips].sort((left, right) => left.start - right.start)
    const current = clips.find((clip) => time >= clip.start && time < clip.start + clip.duration)
    if (!current) continue

    const next = clips.find(
      (clip) => Math.abs(clip.start - (current.start + current.duration)) < 1e-6,
    )
    const previous = clips.find(
      (clip) => Math.abs(clip.start + clip.duration - current.start) < 1e-6,
    )

    // Before the cut: the incoming clip's first frame fades over the outgoing picture.
    if (next?.transition) {
      const half = next.transition.duration / 2
      const cut = current.start + current.duration
      if (time >= cut - half) {
        return {
          kind: next.transition.kind,
          progress: Math.min(1, Math.max(0, (time - (cut - half)) / next.transition.duration)),
          from: { clip: current, offset: heldOffset(current, time - current.start) },
          to: { clip: next, offset: heldOffset(next, time - next.start) },
        }
      }
    }

    // After the cut: the outgoing clip's last frame is still under the incoming picture.
    if (current.transition && previous) {
      const half = current.transition.duration / 2
      if (time < current.start + half) {
        return {
          kind: current.transition.kind,
          progress: Math.min(
            1,
            Math.max(0, (time - (current.start - half)) / current.transition.duration),
          ),
          from: { clip: previous, offset: heldOffset(previous, time - previous.start) },
          to: { clip: current, offset: heldOffset(current, time - current.start) },
        }
      }
    }

    return null
  }
  return null
}

/** Mute or solo one track. Both are decisions about sound; the picture is untouched. */
export const setTrackAudio = (
  doc: EditDocument,
  trackId: string,
  change: { muted?: boolean; solo?: boolean },
): EditDocument => ({
  ...doc,
  tracks: doc.tracks.map((track) =>
    track.id === trackId
      ? {
          ...track,
          ...(change.muted !== undefined ? { muted: change.muted } : {}),
          ...(change.solo !== undefined ? { solo: change.solo } : {}),
        }
      : track,
  ),
})

/** The track a clip is on, by clip id. */
export const trackOfClip = (doc: EditDocument, clipId: string): EditTrack | undefined =>
  doc.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))

/**
 * Rename, lock, hide or silence one track. A blank name clears the label back to "V1" / "A1";
 * `false` clears a flag rather than leaving it in the file.
 */
export const setTrack = (
  doc: EditDocument,
  trackId: string,
  change: {
    name?: string | null
    locked?: boolean
    hidden?: boolean
    muted?: boolean
    solo?: boolean
  },
): EditDocument => ({
  ...doc,
  tracks: doc.tracks.map((track) => {
    if (track.id !== trackId) return track
    const next: EditTrack = { ...track }
    if (change.name !== undefined) {
      const name = typeof change.name === 'string' ? change.name.trim() : ''
      if (name) next.name = name
      else delete next.name
    }
    for (const key of ['locked', 'hidden', 'muted', 'solo'] as const) {
      const value = change[key]
      if (value === undefined) continue
      if (value) next[key] = true
      else delete next[key]
    }
    return next
  }),
})

/**
 * Move one track within the stack. Video tracks paint in document order, so raising a video
 * track puts its picture above the others; the index is clamped to the stack.
 */
export const moveTrack = (doc: EditDocument, trackId: string, toIndex: number): EditDocument => {
  const from = doc.tracks.findIndex((track) => track.id === trackId)
  if (from < 0) return doc
  const tracks = [...doc.tracks]
  const [track] = tracks.splice(from, 1)
  const to = Math.min(tracks.length, Math.max(0, Math.round(toIndex)))
  tracks.splice(to, 0, track!)
  return { ...doc, tracks }
}

/**
 * Take a video clip's sound off the picture and put it on an audio track as its own clip.
 *
 * This is the "detach audio" every timeline editor has: the picture stays where it is, a second
 * clip appears on the first sound track carrying the same source window, and the picture's own
 * sound is muted so the same audio is not heard twice. Trimming or moving the detached clip then
 * changes only the sound, which is the point.
 */
export const detachAudio = (doc: EditDocument, clipId: string): EditDocument => {
  const track = trackOfClip(doc, clipId)
  const clip = track?.clips.find((candidate) => candidate.id === clipId)
  // Only a picture clip has sound that can leave it; an audio clip is already the sound.
  if (!track || !clip || track.kind === 'audio') return doc

  const withSoundTrack = tracksOf(doc, 'audio').length > 0 ? doc : addTrack(doc, 'audio')
  const soundTrack = tracksOf(withSoundTrack, 'audio')[0]!
  // Detaching twice would double the sound, not separate it.
  const alreadyDetached = withSoundTrack.tracks.some(
    (candidate) =>
      candidate.kind === 'audio' &&
      candidate.clips.some(
        (item) =>
          item.src === clip.src &&
          item.start === clip.start &&
          item.in === clip.in &&
          item.duration === clip.duration,
      ),
  )
  if (alreadyDetached) return doc
  const detached: EditClip = {
    id: id('clip'),
    src: clip.src,
    start: clip.start,
    in: clip.in,
    duration: clip.duration,
    ...(clip.volume !== undefined ? { volume: clip.volume } : {}),
    ...(clip.fade ? { fade: { ...clip.fade } } : {}),
    ...(clip.automation ? { automation: clip.automation.map((point) => ({ ...point })) } : {}),
    ...(clip.ducking ? { ducking: { ...clip.ducking } } : {}),
  }
  const moved: EditDocument = {
    ...withSoundTrack,
    tracks: withSoundTrack.tracks.map((candidate) =>
      candidate.id === soundTrack.id
        ? { ...candidate, clips: [...candidate.clips, detached] }
        : candidate,
    ),
  }
  return setClipAudio(moved, clipId, { muted: true })
}

/**
 * The two pieces of one clip cut at an absolute moment, or null when the moment is not inside it.
 *
 * A split changes the count of pieces, never their content: volume, mute, transform, opacity and
 * a baked duck carry into both halves. Fades stay on the edges they belong to — a cut must not
 * invent a dip in the middle of a shot. Automation is split at the cut, with a keyframe written on
 * each side so the gain is continuous. The incoming transition stays with the head; the tail joins
 * a piece of the same shot, which is not a cut between two pictures.
 */
const splitAt = (clip: EditClip, at: number): [EditClip, EditClip] | null => {
  const offset = at - clip.start
  if (offset <= MIN_CLIP || offset >= clip.duration - MIN_CLIP) return null

  const speed = clipSpeed(clip)
  const fadeIn = Math.min(clip.fade?.fadeIn ?? 0, offset)
  const fadeOut = Math.min(clip.fade?.fadeOut ?? 0, clip.duration - offset)
  const { automation, fade: _fade, transition, keyframes: _keyframes, ...rest } = clip
  const boundary = automation?.length ? automationGainAt(automation, offset) : 0
  const headPoints = automation?.filter((point) => point.time < offset - 1e-6) ?? []
  const tailPoints = (automation ?? [])
    .filter((point) => point.time > offset + 1e-6)
    .map((point) => ({ ...point, time: point.time - offset }))

  // Placement keyframes are clip-local, so a cut has to re-anchor them: each half ends/starts at
  // the look the split moment had, or the picture jumps at the join.
  const boundaryVisual = clip.keyframes?.length ? clipVisualAt(clip, offset) : null
  const boundaryFrame =
    boundaryVisual === null
      ? null
      : {
          transform: boundaryVisual.transform,
          ...(boundaryVisual.opacity !== undefined ? { opacity: boundaryVisual.opacity } : {}),
        }
  const headFrames = boundaryFrame
    ? [
        ...(clip.keyframes ?? []).filter((frame) => frame.time < offset - 1e-6),
        { time: offset, ...boundaryFrame },
      ]
    : undefined
  const tailFrames = boundaryFrame
    ? [
        { time: 0, ...boundaryFrame },
        ...(clip.keyframes ?? [])
          .filter((frame) => frame.time > offset + 1e-6)
          .map((frame) => ({ ...frame, time: frame.time - offset })),
      ]
    : undefined

  const head: EditClip = {
    ...rest,
    duration: offset,
    ...(fadeIn > 0 ? { fade: { fadeIn, fadeOut: 0 } } : {}),
    ...(headPoints.length > 0 || tailPoints.length > 0
      ? { automation: [...headPoints, { time: offset, value: boundary }] }
      : {}),
    ...(transition ? { transition } : {}),
    ...(headFrames ? { keyframes: headFrames } : {}),
  }
  const tail: EditClip = {
    ...rest,
    id: id('clip'),
    start: at,
    // A split lands on one source frame; the tail starts where the head stopped. A freeze clip has
    // nowhere to advance to, so both halves hold the same frame.
    in: clip.freeze ? clip.in : clip.in + offset * speed,
    duration: clip.duration - offset,
    ...(fadeOut > 0 ? { fade: { fadeIn: 0, fadeOut } } : {}),
    ...(headPoints.length > 0 || tailPoints.length > 0
      ? { automation: [{ time: 0, value: boundary }, ...tailPoints] }
      : {}),
    ...(tailFrames ? { keyframes: tailFrames } : {}),
  }
  return [head, tail]
}

/**
 * Cut one clip in two at an absolute moment. The tail keeps the same source window, shifted by
 * however much of it the head consumed — a split changes the count of pieces, never their content.
 */
export const splitClip = (doc: EditDocument, clipId: string, at: number): EditDocument => {
  let cut = false
  const tracks = doc.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      if (clip.id !== clipId) return [clip]
      const pieces = splitAt(clip, at)
      if (!pieces) return [clip]
      cut = true
      return pieces
    }),
  }))
  return cut ? carrySplitMasks(doc, { ...doc, tracks }) : doc
}

/**
 * Cut every clip that spans one of these moments — one grid for the whole cut, so a beat lands on
 * the picture and the sound together. Moments on a clip's own edges are already cuts, and moments
 * within `MIN_CLIP` of an edge are ignored because a sliver has no picture to show.
 */
export const cutAt = (doc: EditDocument, times: readonly number[]): EditDocument => {
  const grid = [...new Set(times.filter((time) => Number.isFinite(time) && time >= 0))].sort(
    (left, right) => left - right,
  )
  if (grid.length === 0) return doc
  const tracks = doc.tracks.map((track) => {
    let clips = track.clips
    for (const time of grid) {
      clips = clips.flatMap((clip) => splitAt(clip, time) ?? [clip])
    }
    return { ...track, clips }
  })
  return carrySplitMasks(doc, { ...doc, tracks })
}

/**
 * Hold the frame under `at` for `duration` seconds.
 *
 * The clip is split at that moment and a freeze clip is inserted between the halves; everything
 * after it moves right by the hold, so no neighbour is overwritten. The held picture keeps the
 * look the clip had at that moment (placement, grade, crop) and is silenced — a held frame with a
 * running soundtrack is a different edit, made by adding audio.
 *
 * `ripple` decides how wide "everything after it" is. The default, `all`, shifts the other tracks
 * and overlays too, because a hold inserts time into the cut rather than into one lane — captions
 * and detached sound stay beside the picture they belong to. `track` moves only the frozen lane.
 *
 * Answers `null` when there is nothing to hold: no such clip, or the moment sits on or outside one
 * of its edges.
 */
export function insertFreezeFrame(
  doc: EditDocument,
  clipId: string,
  at: number,
  duration: number,
  options: { ripple?: 'track' | 'all' } = {},
): EditDocument | null {
  const hold = Math.max(MIN_CLIP, duration)
  const rippleAll = (options.ripple ?? 'all') === 'all'
  let inserted = false
  let holderTrackId: string | null = null
  const created: Array<{ id: string; shift: number; duration: number }> = []

  const shifted = doc.tracks.map((track) => {
    const clip = track.clips.find((item) => item.id === clipId)
    if (!clip) return track
    const pieces = splitAt(clip, at)
    if (!pieces) return track
    inserted = true
    holderTrackId = track.id

    const offset = at - clip.start
    const [head, tail] = pieces
    const look = clipVisualAt(clip, offset)
    const freeze: EditClip = {
      id: id('clip'),
      src: clip.src,
      start: at,
      in: clipSourceTime(clip, offset),
      duration: hold,
      freeze: true,
      muted: true,
      ...(isNeutralTransform(look.transform) ? {} : { transform: look.transform }),
      ...(look.opacity !== undefined ? { opacity: look.opacity } : {}),
      ...(clip.crop ? { crop: clip.crop } : {}),
      ...(clip.effect ? { effect: clip.effect } : {}),
      ...(clip.audioEffect ? { audioEffect: clip.audioEffect } : {}),
    }
    const shiftedTail = { ...tail, start: tail.start + hold }
    created.push(
      { id: freeze.id, shift: offset, duration: hold },
      { id: shiftedTail.id, shift: offset, duration: tail.duration },
    )

    const clips: EditClip[] = []
    for (const item of track.clips) {
      if (item.id === clip.id) {
        clips.push(head, freeze, shiftedTail)
        continue
      }
      clips.push(item.start >= at ? { ...item, start: item.start + hold } : item)
    }
    return { ...track, clips }
  })

  if (!inserted) return null

  // Other lanes and overlays move only with `all`; the frozen lane has already shifted.
  const tracks = rippleAll
    ? shifted.map((track) =>
        track.id === holderTrackId
          ? track
          : {
              ...track,
              clips: track.clips.map((clip) =>
                clip.start >= at ? { ...clip, start: clip.start + hold } : clip,
              ),
            },
      )
    : shifted
  const overlays = rippleAll
    ? doc.overlays.map((overlay) =>
        overlay.start >= at ? { ...overlay, start: overlay.start + hold } : overlay,
      )
    : doc.overlays
  // The hold and the tail are the same picture under the same mask; each new id gets its copy,
  // with the animation moved to that piece's own origin.
  const copiedMasks = created.flatMap((piece) =>
    masksForClip(doc, clipId).map((mask) => ({
      ...reanchorMask(mask, piece.shift, piece.duration),
      id: id('mask'),
      clipId: piece.id,
    })),
  )
  return {
    ...doc,
    tracks,
    overlays,
    ...(copiedMasks.length ? { masks: [...masksOf(doc), ...copiedMasks] } : {}),
  }
}

export const renameDocument = (doc: EditDocument, name: string): EditDocument => ({ ...doc, name })

export const setSettings = (doc: EditDocument, change: Partial<EditSettings>): EditDocument => ({
  ...doc,
  settings: {
    width: Math.max(1, Math.round(change.width ?? doc.settings.width)),
    height: Math.max(1, Math.round(change.height ?? doc.settings.height)),
    frameRate: normalizeFrameRate(change.frameRate ?? doc.settings.frameRate),
  },
})

/**
 * The nearest frame boundary at `fps`.
 *
 * Every visible moment belongs to a frame. A cut, a cue or a keyframe written between two frames
 * is ambiguous — preview and encoder may land on either side of it — so edits are snapped to the
 * project's frame grid at write time.
 */
export function snapToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) return seconds
  // The epsilon keeps a value that is mathematically on a half-frame boundary from falling to the
  // lower frame because of float error (7.5 × 30 can arrive as 7.499999999).
  return Math.round(seconds * fps + 1e-9) / fps
}

/**
 * Put every time in the document on the frame grid.
 *
 * This is what "frame accurate" means in practice: clip edges, cue windows, keyframes, volume
 * points and transitions are all snapped; a duration never becomes zero frames. Values are already
 * snapped after one pass, so running it again is a no-op.
 */
export function quantizeDocument(doc: EditDocument): EditDocument {
  const fps = Math.max(1, doc.settings.frameRate)
  const frame = 1 / fps
  const snap = (value: number) => snapToFrame(value, fps)
  const snapDuration = (value: number) => Math.max(frame, snap(value))

  const tracks = doc.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      let keyframes: TransformKeyframe[] | undefined
      if (clip.keyframes?.length) {
        // Snapping two nearby points can put them on the same frame; the later one wins, which is
        // the same rule `readKeyframes` uses.
        const byTime = new Map<number, TransformKeyframe>()
        for (const keyframe of clip.keyframes) {
          const time = snap(keyframe.time)
          byTime.set(Number(time.toFixed(6)), { ...keyframe, time })
        }
        keyframes = [...byTime.values()].sort((left, right) => left.time - right.time)
      }
      const automation = clip.automation?.map((point) => ({ ...point, time: snap(point.time) }))
      return {
        ...clip,
        start: Math.max(0, snap(clip.start)),
        // `in` is a moment in another file's timebase; the project grid says nothing about it.
        duration: snapDuration(clip.duration),
        ...(keyframes ? { keyframes } : {}),
        ...(automation ? { automation } : {}),
        ...(clip.transition
          ? { transition: { ...clip.transition, duration: snapDuration(clip.transition.duration) } }
          : {}),
      }
    }),
  }))

  const overlays = doc.overlays.map((overlay) => ({
    ...overlay,
    start: Math.max(0, snap(overlay.start)),
    duration: snapDuration(overlay.duration),
  }))

  // A marker is a point the caller names; it lands on the same grid as every other timeline time.
  const markers = doc.markers?.map((marker) => ({ ...marker, time: Math.max(0, snap(marker.time)) }))

  // A mask's keyframes are clip-local, but they too are moments the picture changes on.
  const masks = doc.masks?.map((mask) => {
    if (!mask.keyframes?.length) return mask
    const byTime = new Map<number, MaskKeyframe>()
    for (const keyframe of mask.keyframes) {
      const time = Math.max(0, snap(keyframe.time))
      byTime.set(Number(time.toFixed(6)), { ...keyframe, time })
    }
    return { ...mask, keyframes: [...byTime.values()].sort((left, right) => left.time - right.time) }
  })

  return {
    ...doc,
    tracks,
    overlays,
    ...(markers ? { markers } : {}),
    ...(masks ? { masks } : {}),
  }
}

/**
 * Change the composition's size and keep the picture's proportions readable.
 *
 * Positions and boxes are normalized and need no work; everything measured in **composition
 * pixels** — text sizes, stroke widths, shadow blur, a picture-in-picture frame, a clip's blur —
 * scales by the height ratio, so a 16:9 cut moved to 9:16 keeps the same share of the frame.
 * `rescale: false` resizes the canvas alone, for a caller that restyles by hand.
 */
export function resizeComposition(
  doc: EditDocument,
  change: Partial<EditSettings>,
  options: { rescale?: boolean } = {},
): EditDocument {
  const next = setSettings(doc, change)
  if (options.rescale === false) return next
  const ratio = doc.settings.height > 0 ? next.settings.height / doc.settings.height : 1
  if (Math.abs(ratio - 1) < 1e-6) return next
  const scaled = (value: number, min: number, max = Number.POSITIVE_INFINITY): number =>
    Math.min(max, Math.max(min, Math.round(value * ratio * 10) / 10))

  const overlays = next.overlays.map((overlay) => {
    const style = overlay.style
    const nextStyle = style
      ? {
          ...style,
          ...(style.fontSize !== undefined ? { fontSize: scaled(style.fontSize, 1) } : {}),
          ...(style.strokeWidth !== undefined ? { strokeWidth: scaled(style.strokeWidth, 0) } : {}),
          ...(style.shadowBlur !== undefined ? { shadowBlur: scaled(style.shadowBlur, 0) } : {}),
        }
      : undefined
    return {
      ...overlay,
      ...(nextStyle ? { style: nextStyle } : {}),
      ...(overlay.frame
        ? { frame: { ...overlay.frame, width: scaled(overlay.frame.width, 0.5, 40) } }
        : {}),
    }
  })

  const tracks = next.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) =>
      clip.effect?.blur !== undefined
        ? { ...clip, effect: { ...clip.effect, blur: scaled(clip.effect.blur, 0, 20) } }
        : clip,
    ),
  }))

  // Mask geometry is fractional and needs no work, but feather and expansion are pixels.
  const masks = next.masks?.map((mask) => ({
    ...mask,
    feather: scaled(mask.feather, 0, 200),
    expansion: scaled(mask.expansion, -200, 200),
  }))

  return { ...next, overlays, tracks, ...(masks ? { masks } : {}) }
}
