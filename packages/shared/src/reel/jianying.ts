/**
 * A cut as a 剪映 / CapCut draft — the JSON pair the desktop editor opens.
 *
 * The shape here is not invented: it follows the draft schema MiniMax's own clip studio writes
 * (`projectToJianying`), including the fields 剪映 validates and the scaffold files the installer
 * adds around it. Times are microseconds, ids are UUIDs, and media are named by their file name —
 * the installer copies them into the draft's `Resources/` and rewrites the paths to absolute ones,
 * because 剪映 looks for media by absolute path.
 *
 * What travels: the picture and sound tracks, per-clip volume/mute/fade/automation, the picture's
 * transform and opacity, and text overlays (one text track per overlapping group). What does not:
 * transitions, colour grades, audio tone, picture-in-picture and text animations — 剪映 has its own
 * versions of those, and guessing at them would be worse than leaving them behind. The result says
 * so in `warnings`.
 *
 * Pure functions only: the panel builds this, the main process installs it.
 */

import {
  clipSpeed,
  clipVolume,
  durationOf,
  tracksOf,
  trackAudible,
  type EditClip,
  type EditDocument,
  type EditTrack,
} from './document.ts'
import { resolveOverlayBox, resolveTextStyle, type EditOverlay } from './overlay.ts'

export type JianyingFlavor = 'jianying' | 'capcut'

export interface JianyingOptions {
  /** Draft name shown in 剪映; defaults to the cut's name. */
  draftName?: string
  flavor?: JianyingFlavor
  /** `mac` or `windows` in the platform block; defaults to `windows`. */
  os?: 'mac' | 'windows'
  /** Milliseconds since the epoch — pass a fixed value in tests. */
  now?: number
  /** Destination file name for a source; defaults to its basename. */
  nameFor?: (src: string) => string
}

export interface JianyingMediaFile {
  /** Project-relative source (`assets/a.mp4`). */
  src: string
  /** File name inside the draft's `Resources/`; unique across the draft. */
  destName: string
}

export interface JianyingDraft {
  content: Record<string, unknown>
  meta: Record<string, unknown>
  media: JianyingMediaFile[]
  /** Things this draft cannot carry, in the words the person will read. */
  warnings: string[]
}

const MICROS = 1_000_000

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i

/** 剪映 holds a frame with a near-zero rate; the source window scales down to match. */
const FREEZE_SPEED = 0.01

const PLATFORMS: Record<JianyingFlavor, { appId: number; appSource: string; appVersion: string }> = {
  jianying: { appId: 3704, appSource: 'lv', appVersion: '5.0.0' },
  capcut: { appId: 359289, appSource: 'cc', appVersion: '8.5.0' },
}

const NEW_VERSION = '110.0.0'
const DRAFT_VERSION = 360000
const TEXT_RENDER_BASE = 14_000

const micros = (seconds: number) => Math.max(0, Math.round(seconds * MICROS))

const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

const gcd = (left: number, right: number): number =>
  right === 0 ? left : gcd(right, left % right)

/** `1920×1080` → `16:9`; the reduced form is what 剪映 stores in `canvas_config.ratio`. */
export function deriveRatio(width: number, height: number): string {
  const divisor = gcd(Math.round(width), Math.round(height)) || 1
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`
}

/** 剪映's font size unit is roughly a third of a composition pixel in MiniMax's mapping. */
const fontSizeFor = (px: number) => Math.max(0.1, px / 3)

/** `#RRGGBB` as three 0..1 floats, which is what the rich-text runs store. */
function hexToRgbFloat(color: string): [number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim())
  if (!match) return [1, 1, 1]
  return [
    parseInt(match[1]!, 16) / 255,
    parseInt(match[2]!, 16) / 255,
    parseInt(match[3]!, 16) / 255,
  ]
}

/** The rich-text document 剪映 paints for a text segment. */
function textContent(text: string, color: string, size: number): string {
  return JSON.stringify({
    text,
    styles: [
      {
        fill: {
          alpha: 1,
          content: { render_type: 'solid', solid: { color: hexToRgbFloat(color) } },
        },
        font: { id: '', path: '' },
        range: [0, text.length],
        size,
      },
    ],
  })
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path

/** File names inside one draft must be unique; `a.mp4` and `a.mp4` from two folders collide. */
function uniqueName(src: string, used: Set<string>, nameFor?: (src: string) => string): string {
  const original = nameFor?.(src) ?? nameOf(src)
  if (!used.has(original)) {
    used.add(original)
    return original
  }
  const dot = original.lastIndexOf('.')
  const stem = dot > 0 ? original.slice(0, dot) : original
  const ext = dot > 0 ? original.slice(dot) : ''
  let index = 2
  while (used.has(`${stem}_${index}${ext}`)) index += 1
  const name = `${stem}_${index}${ext}`
  used.add(name)
  return name
}

/** 剪映's primary storyline cannot start with a gap, so a track like that is never chosen first. */
const isSafeMainTrack = (track: EditTrack): boolean => {
  const clips = [...track.clips].sort((left, right) => left.start - right.start)
  if (clips.length === 0 || clips[0]!.start > 0.001) return false
  let end = 0
  for (const clip of clips) {
    if (clip.start - end > 0.001) return false
    end = Math.max(end, clip.start + clip.duration)
  }
  return true
}

interface SegmentContext {
  doc: EditDocument
  materials: {
    videos: Record<string, unknown>[]
    audios: Record<string, unknown>[]
    speeds: Record<string, unknown>[]
    soundChannelMappings: Record<string, unknown>[]
    canvases: Record<string, unknown>[]
    audioFades: Record<string, unknown>[]
    texts: Record<string, unknown>[]
  }
  videoId: Map<string, string>
  audioId: Map<string, string>
  media: JianyingMediaFile[]
  mediaNames: Map<string, string>
  width: number
  height: number
  nowSeconds: number
}

function videoMaterial(context: SegmentContext, clip: EditClip): string {
  const known = context.videoId.get(clip.src)
  if (known) return known
  const id = uuid()
  context.videoId.set(clip.src, id)
  const destName = context.mediaNames.get(clip.src)
  const image = IMAGE.test(clip.src)
  context.materials.videos.push({
    id,
    type: 'video',
    path: destName,
    material_name: destName,
    duration: micros(clip.in + clip.duration * clipSpeed(clip)),
    width: context.width,
    height: context.height,
    create_time: context.nowSeconds,
    crop: {
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1,
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
    },
    crop_ratio: 'free',
    crop_scale: 1,
    category_name: 'local',
    category_id: '',
    check_flag: 63487,
    extra_type_option: 0,
    formula_id: '',
    gameplay: null,
    has_audio: !image,
    has_sound_separated: false,
    hdr_type: 0,
    intensifies_audio_path: '',
    intensifies_path: '',
    is_ai_generate_content: false,
    is_copyright: false,
    is_text_edit_overdub: false,
    is_unified_beauty_mode: false,
    local_id: '',
    local_material_id: '',
    material_id: '',
    matting: {
      flag: 0,
      has_use_quick_brush: false,
      has_use_quick_eraser: false,
      interactiveTime: [],
      path: '',
      strokes: [],
    },
    media_path: '',
    object_locked: null,
    origin_material_id: '',
    picture_from: 'none',
    picture_set_category_id: '',
    picture_set_category_name: '',
    request_id: '',
    reverse_intensifies_path: '',
    reverse_path: '',
    smart_motion: null,
    source: 0,
    source_platform: 0,
    stable: { matrix_path: '', stable_level: 0, time_range: { duration: 0, start: 0 } },
    team_id: '',
    video_algorithm: {
      algorithms: [],
      complement_frame_config: null,
      deflicker: null,
      gameplay_configs: [],
      motion_blur_config: null,
      mouth_shape_driver: null,
      noise_reduction: null,
      path: '',
      quality_enhance: null,
      time_range: null,
    },
  })
  return id
}

function audioMaterial(context: SegmentContext, clip: EditClip): string {
  const known = context.audioId.get(clip.src)
  if (known) return known
  const id = uuid()
  context.audioId.set(clip.src, id)
  const destName = context.mediaNames.get(clip.src)
  context.materials.audios.push({
    id,
    type: 'extract_music',
    path: destName,
    name: destName,
    duration: micros(clip.in + clip.duration * clipSpeed(clip)),
    category_id: 'local',
    category_name: 'local',
    check_flag: 1,
    id_internal: '',
    is_ai_clone_tone: false,
    is_text_edit_overdub: false,
    is_ugc: false,
    local_material_id: '',
    music_id: '',
    query: '',
    request_id: '',
    resource_id: '',
    search_id: '',
    source_from: '',
    source_platform: 0,
    team_id: '',
    text_id: '',
    tone_category_id: '',
    tone_category_name: '',
    tone_effect_id: '',
    tone_effect_name: '',
    tone_platform: '',
    tone_second_category_id: '',
    tone_second_category_name: '',
    tone_speaker: '',
    tone_type: '',
    wave_points: [],
  })
  return id
}

/** Volume keyframes in 剪映's shape: offsets inside the segment, `KFTypeVolume`. */
function volumeKeyframes(clip: EditClip): Record<string, unknown>[] {
  if (!clip.automation?.length) return []
  return [
    {
      id: uuid(),
      keyframe_list: [...clip.automation]
        .filter((point) => point.time >= 0 && point.time <= clip.duration)
        .sort((left, right) => left.time - right.time)
        .map((point) => ({
          id: uuid(),
          time_offset: micros(point.time),
          values: [point.value],
          curveType: 'Line',
          graphID: '',
          left_control: { x: 0, y: 0 },
          right_control: { x: 0, y: 0 },
        })),
      material_id: '',
      property_type: 'KFTypeVolume',
    },
  ]
}

function segmentFor(
  context: SegmentContext,
  clip: EditClip,
  track: EditTrack,
  renderIndex: number,
  isVideo: boolean,
): Record<string, unknown> {
  const materialId = isVideo ? videoMaterial(context, clip) : audioMaterial(context, clip)
  // A held frame is a near-zero speed over a sliver of source; 剪映's own 定格 works the same way.
  // `source_timerange` stays proportional to the target (`source = target × speed`), which is the
  // invariant the draft format relies on.
  const speed = clip.freeze === true ? FREEZE_SPEED : clipSpeed(clip)
  const speedId = uuid()
  context.materials.speeds.push({ id: speedId, type: 'speed', mode: 0, speed, curve_speed: null })
  const channelId = uuid()
  context.materials.soundChannelMappings.push({
    id: channelId,
    audio_channel_mapping: 0,
    is_config_open: false,
    type: 'none',
  })
  const extra: string[] = [speedId, channelId]

  if (isVideo) {
    const canvasId = uuid()
    context.materials.canvases.push({
      id: canvasId,
      type: 'canvas_color',
      album_image: '',
      blur: 0,
      color: '',
      image: '',
      image_id: '',
      image_name: '',
      source_platform: 0,
      team_id: '',
    })
    extra.push(canvasId)
  }

  const fadeIn = Math.max(0, clip.fade?.fadeIn ?? 0)
  const fadeOut = Math.max(0, clip.fade?.fadeOut ?? 0)
  if (fadeIn > 0 || fadeOut > 0) {
    const fadeId = uuid()
    context.materials.audioFades.push({
      id: fadeId,
      type: 'audio_fade',
      fade_in_duration: micros(fadeIn),
      fade_out_duration: micros(fadeOut),
      fade_type: 0,
    })
    extra.push(fadeId)
  }

  const transform = clip.transform
  const audible = trackAudible(context.doc, track) && !clip.muted
  const volume = audible ? clipVolume(clip) : 0
  const keyframes = volumeKeyframes(clip).map((keyframe) => ({ ...keyframe, material_id: materialId }))

  return {
    id: uuid(),
    material_id: materialId,
    source_timerange: { start: micros(clip.in), duration: micros(clip.duration * speed) },
    target_timerange: { start: micros(clip.start), duration: micros(clip.duration) },
    extra_material_refs: extra,
    speed,
    volume,
    visible: !track.hidden,
    clip: {
      alpha: Math.min(1, Math.max(0, clip.opacity ?? 1)),
      flip: { horizontal: false, vertical: false },
      // 剪映 stores rotation in radians; the document keeps degrees.
      rotation: ((transform?.rotation ?? 0) * Math.PI) / 180,
      scale: { x: transform?.scale ?? 1, y: transform?.scale ?? 1 },
      // The document's x/y are fractions of the composition; 剪映 wants -1..1 of a half-frame.
      transform: { x: (transform?.x ?? 0) * 2, y: -(transform?.y ?? 0) * 2 },
    },
    common_keyframes: keyframes,
    render_index: renderIndex,
    track_attribute: 0,
    track_render_index: 0,
    uniform_scale: { on: true, value: 1 },
    enable_adjust: true,
    enable_lut: true,
    enable_color_wheels: true,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_smart_color_adjust: false,
    enable_video_mask: true,
    is_placeholder: false,
    is_tone_modify: false,
    last_nonzero_volume: clipVolume(clip),
    reverse: false,
    template_id: '',
    template_scene: 'default',
    intensifies_audio: false,
    lyric_keyframes: null,
    keyframe_refs: [],
    group_id: '',
    hdr_settings: null,
    cartoon: false,
  }
}

/** The text material 剪映 paints, filled from our overlay's preset and style. */
function textMaterial(overlay: EditOverlay, position: { x: number; y: number }, width: number) {
  const style = resolveTextStyle(overlay)
  const size = fontSizeFor(style.fontSize)
  const alignment = style.align === 'left' ? 0 : style.align === 'right' ? 2 : 1
  const alpha = Math.min(1, Math.max(0, overlay.opacity ?? 1))
  return {
    id: uuid(),
    type: 'text',
    content: textContent(overlay.text ?? '', style.color, size),
    font_name: style.fontFamily ?? '',
    font_size: size,
    font_path: '',
    text_color: style.color,
    border_color: style.strokeColor ?? '#000000',
    border_width: Math.min(0.2, (style.strokeWidth ?? 0) / 30),
    has_shadow: !!(style.shadowColor && (style.shadowBlur ?? 0) > 0),
    shadow_color: style.shadowColor ?? '#000000',
    shadow_distance: 0,
    shadow_alpha: 0.8,
    shadow_angle: -45,
    shadow_smoothing: style.shadowBlur ?? 0,
    bold_width: style.bold ? 0.08 : 0,
    italic_degree: style.italic ? 15 : 0,
    underline: false,
    underline_offset: 0.22,
    underline_width: 0.05,
    alignment,
    line_feed: 1,
    line_max_width: Math.min(1, Math.max(0.1, width)),
    letter_spacing: 0,
    line_spacing: Math.max(0, (style.lineHeight ?? 1.3) - 1),
    background_color: style.backgroundColor ?? '',
    background_alpha: 1,
    background_height: 0.14,
    background_horizontal_offset: 0,
    background_round_radius: 0,
    background_style: style.backgroundColor ? 1 : 0,
    background_vertical_offset: 0,
    background_width: 0.14,
    check_flag: 7,
    combo_info: { text_templates: [] },
    force_apply_line_max_width: false,
    global_alpha: alpha,
    group_id: '',
    is_rich_text: false,
    ktv_color: '',
    layer_weight: 1,
    recognize_task_id: '',
    recognize_type: 0,
    relevance_segment: [],
    shape_clip_x: false,
    shape_clip_y: false,
    style_name: '',
    sub_type: 0,
    subtitle_keywords: null,
    subtitle_template_original_fontsize: 0,
    text_alpha: alpha,
    text_curve: null,
    text_preset_resource_id: '',
    text_size: size,
    text_to_audio_ids: [],
    tts_auto_update: false,
    typesetting: 0,
    underline_color: style.color,
    use_effect_default_color: true,
    words: { end_time: [], start_time: [], text: [] },
    position,
  }
}

/** Greedy lanes: a text that starts after a lane's last end joins that lane. */
function textLanes(overlays: EditOverlay[]): EditOverlay[][] {
  const lanes: EditOverlay[][] = []
  for (const overlay of [...overlays].sort((left, right) => left.start - right.start)) {
    const lane = lanes.find((candidate) => {
      const last = candidate[candidate.length - 1]!
      return overlay.start >= last.start + last.duration - 1e-6
    })
    if (lane) lane.push(overlay)
    else lanes.push([overlay])
  }
  return lanes
}

/**
 * Build the draft. Media are referenced by file name; the installer copies them and rewrites the
 * paths, because 剪映 resolves media absolutely.
 */
export function toJianyingDraft(doc: EditDocument, options: JianyingOptions = {}): JianyingDraft {
  const flavor = options.flavor ?? 'jianying'
  const now = options.now ?? Date.now()
  const nowSeconds = Math.floor(now / 1000)
  const nowMicros = now * 1000
  const { width, height } = doc.settings
  const warnings: string[] = []

  const materials = {
    videos: [] as Record<string, unknown>[],
    audios: [] as Record<string, unknown>[],
    speeds: [] as Record<string, unknown>[],
    soundChannelMappings: [] as Record<string, unknown>[],
    canvases: [] as Record<string, unknown>[],
    audioFades: [] as Record<string, unknown>[],
    texts: [] as Record<string, unknown>[],
  }

  const usedNames = new Set<string>()
  const mediaNames = new Map<string, string>()
  const media: JianyingMediaFile[] = []
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (mediaNames.has(clip.src)) continue
      const destName = uniqueName(clip.src, usedNames, options.nameFor)
      mediaNames.set(clip.src, destName)
      media.push({ src: clip.src, destName })
    }
  }

  const context: SegmentContext = {
    doc,
    materials,
    videoId: new Map(),
    audioId: new Map(),
    media,
    mediaNames,
    width,
    height,
    nowSeconds,
  }

  // ── Picture and sound tracks ─────────────────────────────────────────────────────────────────
  const videoTracks = [...tracksOf(doc, 'video')].reverse()
  if (videoTracks.length > 0) {
    const safeIndex = videoTracks.findIndex(isSafeMainTrack)
    if (safeIndex > 0) {
      const [main] = videoTracks.splice(safeIndex, 1)
      videoTracks.unshift(main!)
    } else if (safeIndex < 0) {
      warnings.push('剪映主轨不支持起始空隙，最下方轨道的片段位置可能被剪映自动前移')
    }
  }

  const tracks: Record<string, unknown>[] = []
  let videoRender = 0
  let audioRender = 0
  for (const track of [...videoTracks, ...tracksOf(doc, 'audio')]) {
    if (track.clips.length === 0) continue
    const isVideo = track.kind === 'video'
    const renderIndex = isVideo ? videoRender : audioRender
    if (isVideo) videoRender += 1
    else audioRender += 1
    const segments = [...track.clips]
      .sort((left, right) => left.start - right.start)
      .map((clip) => segmentFor(context, clip, track, renderIndex, isVideo))
    tracks.push({
      id: uuid(),
      type: isVideo ? 'video' : 'audio',
      attribute: 0,
      flag: 0,
      segments,
    })
  }

  // ── Text overlays, one track per overlapping group ──────────────────────────────────────────
  const texts = doc.overlays.filter(
    (overlay) => overlay.kind === 'text' && (overlay.text ?? '').trim() && overlay.duration > 0,
  )
  let textRender = TEXT_RENDER_BASE
  for (const lane of textLanes(texts)) {
    const segments: Record<string, unknown>[] = []
    for (const overlay of lane) {
      const box = resolveOverlayBox(overlay)
      const position = {
        x: (box.x + box.w / 2) * 2 - 1,
        y: 1 - (box.y + box.h / 2) * 2,
      }
      const material = textMaterial(
        { ...overlay, box },
        position,
        Math.min(1, Math.max(0.1, box.w)),
      )
      const { position: _position, ...materialFields } = material
      materials.texts.push(materialFields)
      segments.push({
        id: uuid(),
        material_id: material.id,
        source_timerange: { start: 0, duration: micros(overlay.duration) },
        target_timerange: { start: micros(overlay.start), duration: micros(overlay.duration) },
        extra_material_refs: [],
        speed: 1,
        volume: 1,
        visible: true,
        clip: {
          alpha: material.global_alpha,
          flip: { horizontal: false, vertical: false },
          rotation: 0,
          scale: { x: 1, y: 1 },
          transform: position,
        },
        common_keyframes: [],
        render_index: textRender,
        track_attribute: 0,
        track_render_index: 0,
        uniform_scale: { on: true, value: 1 },
        enable_adjust: false,
        enable_lut: false,
        enable_color_wheels: false,
        enable_color_curves: false,
        enable_color_match_adjust: false,
        enable_smart_color_adjust: false,
        enable_video_mask: false,
        is_placeholder: false,
        is_tone_modify: false,
        last_nonzero_volume: 1,
        reverse: false,
        template_id: '',
        template_scene: 'default',
        intensifies_audio: false,
        lyric_keyframes: null,
        keyframe_refs: [],
        group_id: '',
        hdr_settings: null,
        cartoon: false,
      })
      textRender += 1
    }
    tracks.push({
      id: uuid(),
      type: 'text',
      attribute: 0,
      flag: 0,
      segments,
    })
  }

  // ── What this draft cannot carry, said plainly ──────────────────────────────────────────────
  if (doc.overlays.some((overlay) => overlay.kind === 'media')) {
    warnings.push('画中画素材未随草稿导出，需要时请在剪映中重新添加')
  }
  if (doc.overlays.some((overlay) => overlay.animation)) {
    warnings.push('文字动画未随草稿导出，可在剪映中重新选择')
  }
  if (doc.tracks.some((track) => track.clips.some((clip) => clip.transition))) {
    warnings.push('转场未随草稿导出，剪映有自己的转场库')
  }
  if (doc.tracks.some((track) => track.clips.some((clip) => clip.effect || clip.audioEffect))) {
    warnings.push('调色与音色未随草稿导出，剪映使用自己的滤镜与音频面板')
  }

  const platform = PLATFORMS[flavor]
  const draftId = uuid()
  const durationMicros = micros(durationOf(doc))
  const platformBlock = {
    app_id: platform.appId,
    app_source: platform.appSource,
    app_version: platform.appVersion,
    device_id: '',
    hard_disk_id: '',
    mac_address: '',
    os: options.os ?? 'windows',
    os_version: '',
  }

  const content: Record<string, unknown> = {
    canvas_config: { width, height, ratio: deriveRatio(width, height) },
    color_space: 0,
    config: { adjust_max_index: 1, attachment_info: null, combination_max_index: 1 },
    cover: null,
    create_time: nowSeconds,
    duration: durationMicros,
    extra_info: null,
    fps: Math.max(1, Math.round(doc.settings.frameRate)),
    free_render_index_mode_on: false,
    group_container: null,
    id: draftId,
    keyframe_graph_list: [],
    keyframes: {
      adjusts: [],
      audios: [],
      effects: [],
      filters: [],
      handwrites: [],
      stickers: [],
      texts: [],
      videos: [],
    },
    last_modified_platform: platformBlock,
    materials: {
      adjusts: [],
      ai_translates: [],
      audio_balances: [],
      audio_effects: [],
      audio_fades: materials.audioFades,
      audio_track_indexes: [],
      audios: materials.audios,
      beats: [],
      canvases: materials.canvases,
      chromas: [],
      color_curves: [],
      common_mask: [],
      digital_humans: [],
      drafts: [],
      effects: [],
      filters: [],
      flowers: [],
      green_screens: [],
      handwrites: [],
      hsl: [],
      images: [],
      log_color_wheels: [],
      loudnesses: [],
      manual_deformations: [],
      masks: [],
      material_animations: [],
      material_colors: [],
      multi_language_refs: [],
      placeholders: [],
      plugin_effects: [],
      primary_color_wheels: [],
      realtime_denoises: [],
      shapes: [],
      smart_crops: [],
      smart_relights: [],
      sound_channel_mappings: materials.soundChannelMappings,
      speeds: materials.speeds,
      stickers: [],
      tail_leaders: [],
      text_templates: [],
      texts: materials.texts,
      time_marks: [],
      transitions: [],
      video_effects: [],
      video_trackings: [],
      videos: materials.videos,
      vocal_beautifys: [],
      vocal_separations: [],
    },
    mutable_config: null,
    name: '',
    new_version: NEW_VERSION,
    platform: platformBlock,
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks,
    update_time: nowSeconds,
    version: DRAFT_VERSION,
  }

  const usedMaterials = [...media].map((file) => ({
    create_time: nowSeconds,
    duration: micros(0),
    extra_info: file.destName,
    file_Path: file.destName,
    id: context.videoId.get(file.src) ?? context.audioId.get(file.src) ?? uuid(),
    import_time: nowSeconds,
    import_time_ms: nowMicros,
    item_source: 1,
    md5: '',
    metetype: VIDEO.test(file.src) || IMAGE.test(file.src) ? 'video' : 'audio',
    roughcut_time_range: { duration: -1, start: -1 },
    sub_time_range: { duration: -1, start: -1 },
    type: 0,
  }))
  // The material's own length is more useful to 剪映 than zero; fill it from the material table.
  for (const entry of usedMaterials) {
    const material = [...materials.videos, ...materials.audios].find(
      (candidate) => candidate.id === entry.id,
    )
    if (material) entry.duration = Number(material.duration ?? 0)
  }

  const meta: Record<string, unknown> = {
    cloud_package_completed_time: '',
    draft_cloud_capcut_purchase_info: '',
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: 'draft_cover.jpg',
    draft_deeplink_url: '',
    draft_enterprise_info: {
      draft_enterprise_extra: '',
      draft_enterprise_id: '',
      draft_enterprise_name: '',
      enterprise_material: [],
    },
    draft_fold_path: '',
    draft_id: draftId,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: 'false',
    draft_is_invisible: false,
    draft_materials: [{ type: 0, value: usedMaterials }],
    draft_materials_copied_info: [],
    draft_name: (options.draftName ?? doc.name).trim() || doc.name,
    draft_new_version: NEW_VERSION,
    draft_removable_storage_device: '',
    draft_root_path: '',
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_modified: 0,
    tm_draft_create: nowMicros,
    tm_draft_modified: nowMicros,
    tm_draft_removed: 0,
    tm_duration: durationMicros,
  }

  return { content, meta, media, warnings }
}
