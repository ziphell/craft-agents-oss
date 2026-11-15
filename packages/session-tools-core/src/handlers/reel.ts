/**
 * `reel_tool` — the agent's hands on a project's cuts.
 *
 * **Named `reel`, not `edit`.** "edit" already means "change a file" in this tool surface, and an
 * agent that confuses the two will rewrite a document when it meant to trim a clip. A cut is a
 * reel: `reels/<slug>.reel`, one of the project's own documents.
 *
 * The document is ours (`@craft-agent/shared/reel/document`), and the panel showing a cut reads
 * that same file — so a batch written here appears in the timeline without a bridge, a message
 * protocol or an embedded editor. The file is the contract; the panel notices a new revision and
 * takes it as **one undo step**, so the person's Ctrl+Z covers the agent's batch the way it covers
 * their own gesture. (A panel that still owes a write of its own asks before reloading instead.)
 *
 * Every write states the revision it read. A write against a stale one is refused rather than
 * merged: two writers guessing at each other's intent is how an edit is lost quietly.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import {
  isInside,
  resolveContentRoots,
  resolveFilePath,
} from '@craft-agent/shared/agent/content-paths'
import {
  addClip,
  addMarker,
  addOverlay,
  addTrack,
  clearClipDucking,
  clearMask,
  clearTransition,
  clipSourceTime,
  clipSpeed,
  clipsOf,
  closeGap,
  cutAt,
  DEFAULT_SETTINGS,
  detachAudio,
  duplicateClip,
  durationOf,
  emptyDocument,
  findClip,
  findOverlay,
  insertFreezeFrame,
  isKeyframeEasing,
  markersOf,
  masksOf,
  MIN_CLIP,
  moveClip,
  moveTrack,
  normalizeDocument,
  normalizeFrameRate,
  NEUTRAL_TRANSFORM,
  removeClip,
  removeGaps,
  removeMarker,
  removeOverlay,
  removeTrack,
  renameDocument,
  quantizeDocument,
  resizeComposition,
  rippleDelete,
  REEL_EXTENSION,
  isReelPath,
  reelNameOf,
  setClipAudio,
  setClipAudioEffect,
  setClipAutomation,
  setClipEffect,
  setClipFade,
  setClipCrop,
  setClipKeyframes,
  setClipSpeed,
  setClipTransform,
  setMask,
  setTrack,
  setTrackAudio,
  setTransition,
  sliceDocument,
  splitClip,
  trimClip,
  trimEdges,
  trackOfClip,
  TRANSITIONS,
  updateOverlay,
  setOverlayFrame,
  type ClipTransform,
  type CropRect,
  type EditDocument,
  type EditSettings,
  type MaskKeyframe,
  type MaskShape,
  type TransformKeyframe,
  type TransitionKind,
} from '@craft-agent/shared/reel/document'
import {
  normalizeOverlay,
  isTextPreset,
  resolveOverlayVolume,
  TEXT_PRESETS,
  type TextPreset,
  type TextStyle,
} from '@craft-agent/shared/reel/overlay'
import {
  EFFECT_PRESETS,
  type ClipEffect,
  type EffectPreset,
} from '@craft-agent/shared/reel/effects'
import type { AudioEffect } from '@craft-agent/shared/reel/audio-effects'
import {
  cuesFromOverlays,
  formatSrt,
  normalizeCues,
  overlaysFromCues,
  parseSrt,
  type SubtitleCue,
} from '@craft-agent/shared/reel/srt'
import { toFcpxml } from '@craft-agent/shared/reel/fcpxml'
import { TEXT_TEMPLATE_IDS, textTemplateOf } from '@craft-agent/shared/reel/text-templates'
import {
  clearSubtitles,
  dedupeSubtitles,
  replaceSubtitleText,
  shiftSubtitles,
  styleSubtitles,
  subtitleOverlaysOf,
} from '@craft-agent/shared/reel/subtitles'
import { reelSnapshot } from '@craft-agent/shared/reel/snapshot'
import { reelExportHost, type ExportContainer, type ReelExportJob } from '@craft-agent/shared/reel/export-host'
import { reelProbe } from '@craft-agent/shared/reel/probe'
import { reelAudio } from '@craft-agent/shared/reel/audio'
import {
  analyzeBeats,
  clipBeatsOf,
  cutPointsFromBeats,
  type BeatAnalysis,
  type BeatPoint,
} from '@craft-agent/shared/reel/beats'
import { arrangeOnCutPoints, type ArrangeSource } from '@craft-agent/shared/reel/arrange'
import type { SessionToolContext } from '../context.ts'
import type { ToolResult } from '../types.ts'

export interface ReelToolArgs {
  command: string | string[]
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })
const fail = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

/** A still picture, as opposed to a clip with frames — the same test the renderer uses. */
const STILL = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/i

/** A container's stated length can sit a few frames short of its last sample. */
const SOURCE_SLACK = 0.05

/**
 * The short reference: what a batch needs to get right, and where to look things up.
 *
 * Kept small on purpose — a long help is a help nobody reads, and an agent that guesses at op
 * shapes from a wall of text is worse off than one that knows `help all` exists. The full reference
 * (`HELP_DETAIL`) is one flag away.
 */
const HELP = [
  "reel_tool — this conversation's cuts: reels/<slug>.reel, the same file the panel edits.",
  '',
  'Read',
  '  list                                  cuts here (name, revision, duration)',
  '  state [--file <path>] [--json]        settings, duration, tracks, clips; --json is exact',
  '  probe --src <path>                    duration, size, frame rate, frame count, sound',
  '  beats --src <path> [--clip <id>] [--json]',
  '                                        tempo, beat grid and downbeats; --clip maps them',
  '                                        onto the timeline (speed included)',
  '  snapshot [--at <s>] [--clip <id> --edge first|last] [--out <path>]',
  '                                        one frame as JPEG, drawn by the export compositor',
  '',
  'Write',
  '  create [--name <name>] [--width W --height H --fps N]',
  '                                        a new cut at reels/<name>.reel',
  '  apply --ops <json|@file> [--expected-revision N] [--label "…"]',
  '                                        1–50 ops, applied whole or not at all',
  '',
  'Output',
  '  export [--out <path>] [--container mp4|webm|mp3] [--audio-only] [--from <s> --to <s>]',
  '                                        start a render (returns at once); a range exports',
  '                                        only that slice and starts the file at 0',
  '  export --status [<id>] / export --cancel <id>',
  '  subtitles [--out <path>]              SRT',
  '  fcpxml [--out <path>]                 FCPXML 1.9 for FCP / Resolve / Premiere',
  '',
  'Time',
  '  Times are seconds (float), never frames. A batch snaps timeline values — clip start,',
  '  duration, cue and keyframe times, transition length — to the nearest frame of',
  '  settings.frameRate (0.25s at 30fps becomes 0.2667s). A source `in` is not snapped: it',
  '  addresses another file’s timebase. `state --json` has the exact numbers; `state` rounds and',
  '  prints frame numbers (f5).',
  '',
  'apply ops, by area (`help all` lists every shape and field)',
  '  timeline    add_track, add_clip, move_clip, trim_clip, split_clip, cut_at, remove_clip,',
  '              duplicate_clip, ripple_delete, close_gap, remove_gaps, set_speed, freeze_frame,',
  '              auto_edit',
  '  picture     set_transform, set_keyframes, clear_keyframes, set_crop, set_effect,',
  '              set_overlay_frame, set_mask, clear_mask',
  '  sound       set_audio, detach_audio, set_fade, set_track_audio, set_automation,',
  '              clear_ducking, set_audio_effect',
  '  text        add_overlay, add_subtitles, update_overlay, remove_overlay, clear_subtitles,',
  '              shift_subtitles, replace_subtitle_text, dedupe_subtitles, style_subtitles',
  '  tracks      set_track, move_track, add_track, remove_track',
  '  document    rename, set_settings, add_marker, remove_marker',
  '  transition  set_transition, clear_transition',
  '',
  'Transitions',
  '  crossfade, dip-black, dip-white, wipe-left, slide-left, zoom. A transition belongs to the',
  '  incoming clip and needs a clip on the same track ending where it starts. Its length is',
  '  clamped to the shorter of the two clips, and the reply says so when that happens.',
  '',
  '卡点 (cut on the music)',
  '  `beats --src assets/music.mp3 --clip <id> --json` reads the sound: BPM, a beat grid with',
  '  strength, and downbeats every four beats. Then `auto_edit` fills a video track from those',
  '  times — sources taken in turn, cut points closer than minClipDuration dropped, gaps past',
  '  maxClipDuration capped. Without `--clip` the times are source seconds, not timeline seconds.',
  '',
  'Mask',
  '  `set_mask` puts one shape mask on a clip: rectangle, ellipse or polygon, with bounds in',
  '  composition fractions, feather and expansion in pixels, and inverted/opacity. Coordinates are',
  '  fractions of the frame, so the mask stays put while the clip moves underneath it. `clear_mask`',
  '  removes it; `state` lists the mask and its clip.',
  '  `keyframes` animate the box: [{ time, x, y, width, height, opacity?, easing? }] with times',
  '  clip-local, so the animation travels with the clip. A tracked face is this with two or three',
  '  boxes; `[]` removes the animation and keeps the static mask.',
  '',
  'Regional blur',
  '  `set_effect` also takes `regions`: [{ x, y, w, h, mode: blur|mosaic, strength }] in frame',
  '  fractions, to hide a watermark or logo. `clearRegions: true` drops them and keeps the grade.',
  '  `set_transform { flipX: true }` mirrors a clip horizontally.',
  '',
  'Notes',
  '  Cuts live in a project: a conversation not bound to one cannot create or read them.',
  '  With more than one cut in the conversation, name the one you mean with `--file`.',
  '  `add_clip` may omit duration — the host probes the file and the window runs from `in` to',
  '  the end. A batch is one edit: an open panel takes the new revision as one undo step.',
  '  Markers are named points (`add_marker`, `remove_marker`); `state` lists their ids.',
  '  `help all` prints the full reference.',
].join('\n')

const HELP_DETAIL = [
  "reel_tool — this conversation's cuts, as files the person and the agent both edit.",
  '',
  "  list                                  the conversation's cuts (name, revision, duration)",
  '  create [--name <name>] [--file <path>] [--width W --height H --fps N]',
  '                                        a new cut; defaults to reels/<name>.reel',
  '  state [--file <path>] [--json]        the cut: settings, duration, tracks and clips',
  '  probe --src <path>                    a source’s duration, size, frame rate and frame count',
  '  snapshot [--file <path>] [--at <seconds>] [--clip <id> [--edge first|last]]',
  '           [--out <path>] [--max-edge <px>]',
  '                                        one frame as a JPEG, drawn by the same compositor the',
  '                                        preview and the export use',
  '  export [--file <path>] [--out <path>] [--container mp4|webm|mp3] [--audio-only]',
  '                                        render the whole cut in the background (this returns',
  '                                        at once; nothing waits for the encode)',
  '  export --status [<id>]                how a render is doing; no id lists this conversation’s',
  '                                        exports',
  '  export --cancel <id>                  stop a render; the partial file is removed',
  '  subtitles [--file <path>] [--out <path>]',
  '                                        the cut’s subtitles as SRT (stdout, or written to --out)',
  '  fcpxml [--file <path>] [--out <path>]',
  '                                        the cut as FCPXML for FCP / Resolve / Premiere',
  '  apply [--file <path>] --ops <json|@file> [--expected-revision N] [--label "…"]',
  '                                        one batch, applied whole or not at all',
  '',
  'A cut lives at <project>/reels/<slug>.reel: { schemaVersion, revision, name, settings, tracks, overlays }.',
  'Cuts belong to a project; this conversation must be bound to one. Replies print the absolute path.',
  'A clip is { id, src, start, in, duration } — src is root-relative (`assets/a.mp4`), `start` is',
  'where it sits on its track, `in`/`duration` are the window of the source it uses. Times are',
  'seconds (float), never frames: a batch snaps timeline values — clip start, duration, cue and',
  'keyframe times — to the nearest frame of settings.frameRate (0.25s at 30fps lands on 0.2667s),',
  'while a source `in` is left as written because it addresses another file’s timebase. `state --json`',
  'carries the exact numbers; the text view rounds to two decimals.',
  '`add_clip` may omit `duration`: the host reads it from the container and the window runs from',
  '`in` to the end of the file, so a batch of sources is one probe rather than one guess per clip.',
  '',
  '`snapshot` is how you see your own work: it draws the frame at `--at` seconds with the same',
  'compositor the panel and the export use, writes it as a JPEG (default `reels/frames/`) and',
  'answers the path — read that file to look at it. It reflects what is on disk, so write, then look.',
  '`--clip <id> --edge first|last` looks at that clip’s boundary frame directly (the last is sampled',
  'just inside its end) and the reply names the source second that was drawn. The picture is the',
  'composite at that moment, so an upper track or overlay is part of what you see.',
  '',
  '`probe --src <path>` reads a source’s container: duration, pixel size, frame rate, frame count,',
  'codec and whether it has sound. The reply also shows how a source frame converts to seconds,',
  'which is what to use for `in` (a cut’s timeline is snapped to the project frame rate; the source',
  'window is not). `add_clip` uses the same probe silently when a batch leaves out `duration`.',
  '',
  '`export` renders the whole cut — picture, sound and overlays — to `reels/exports/` (or `--out`).',
  'It answers as soon as the encode starts: ask `export --status <id>` for the result, and the',
  'conversation is woken when the file lands. Same encode as the panel’s Export button, so check',
  'what you are about to deliver with `snapshot` first. `--container mp3` is sound only;',
  '`--audio-only` writes `.m4a` from an MP4. With `--from` / `--to` it exports only that slice:',
  'clips crossing the head move their source window, overlays are clipped, markers are dropped,',
  'and the file starts at 0 — a range is a slice of the cut, not a second timeline.',
  '',
  'Markers are named points on the timeline and do not render: `add_marker` ({ time, name? }) and',
  '`remove_marker` ({ markerId }), with the ids listed by `state`. They are the chapter list a',
  'person sees and the handles a range export uses.',
  '',
  'Overlays are the track above the picture — subtitles, styled text and picture-in-picture — and',
  'they are the same objects the panel edits. Subtitles usually arrive from speech recognition as',
  'SRT; `add_subtitles` turns cues into one overlay per line.',
  'A batch can tidy the transcript without touching titles or 花字: `shift_subtitles` moves every',
  'subtitle by `by` seconds, `replace_subtitle_text` rewords them, `dedupe_subtitles` drops the',
  'shorter copy of a repeated line, and `style_subtitles` merges one style into all of them. Each',
  'accepts optional `from` / `to` timeline seconds to limit the window. Re-transcribing is',
  '`clear_subtitles` (same range) followed by `add_subtitles`, so the old lines do not stack.',
  'A text overlay can arrive and leave — `animation: { preset, inDuration?, outDuration? }` with',
  'fade / slide-left / slide-right / slide-up / slide-down / scale / typewriter — and `state` prints',
  'the preset it carries. Preview and export evaluate the same formula.',
  'A text overlay may also name a 花字 template instead of hand-writing a style: `add_overlay` with',
  '"template": "<id>" (neon, impact, badge, lower-third, quote, bar, stamp, glow). The catalog is',
  'shared with the panel gallery, so both produce the same overlay; stated fields win.',
  '',
  'Every clip carries its own sound: `volume` (0..1) and `muted` apply to that clip alone. A video',
  'clip can hand its sound to an audio clip with `detach_audio`; the picture is then muted so the',
  'same sound is not heard twice. `fade` ({ fadeIn, fadeOut } in seconds) ramps a clip in and out.',
  'Mute and solo belong to a track (`set_track_audio`) and affect sound only — the picture keeps',
  'playing. A picture-in-picture overlay is silent unless it sets "muted": false.',
  '',
  'Volume keyframes (`automation`) are how ducking is stored: the panel analyses a trigger track and',
  'bakes the envelope onto the ducked clip, and `set_automation` writes the same points by hand.',
  '`state` shows the keyframe count and whether a duck was baked.',
  '',
  'The picture has its own placement — `transform` (x/y as fractions of the composition, scale,',
  'rotation in degrees, corner radius 0..0.5) and `opacity` — and the usual clip housekeeping:',
  'duplicate_clip, ripple_delete (removes it and pulls the track left), close_gap, remove_gaps.',
  '',
  '`trim_clip` with `head` / `tail` (timeline seconds) is “cut two seconds off the front/back”:',
  'head moves the clip’s start right and advances the source window by head × speed (the rest of',
  'the piece keeps its timeline moment), tail only shortens it. The `in` / `duration` form writes',
  'the window directly — source seconds and timeline seconds — and is for slip edits. Neither form',
  'ripples; call remove_gaps if a hole should close. A window may not run past the source itself:',
  'the reply says how long the file is when the host can read it.',
  '',
  '`set_keyframes` makes that placement move: each entry is a moment in **clip-local seconds**',
  '(from the clip’s start, not the timeline) plus the transform and opacity it should have there.',
  'The segment arriving at a keyframe can carry `easing`: linear, ease-in, ease-out or',
  'ease-in-out. The picture is mixed by that easing and held at the first and last keyframe, so a',
  'clip with keyframes ignores the static `transform`/`opacity` until `clear_keyframes` turns them',
  'off again. At most 50 per clip.',
  '',
  '`set_crop` is a window onto the source, in fractions of its own frame (x/y/w/h, 0..1): the',
  'picture is fitted as if the crop were the whole frame. `set_overlay_frame` draws a border around',
  'a picture-in-picture — width in composition pixels — and mats the box black behind the picture.',
  '',
  '`freeze_frame` holds the frame at `at` (timeline seconds) for `duration`: the clip is split and',
  'a still clip is inserted between the halves, everything after it moves right, and the held',
  'picture keeps the look it had. The ripple covers the whole cut by default, so captions and',
  'detached sound follow the picture; pass "ripple": "track" to move only the frozen lane. It is',
  'silent — add audio if the hold should be heard.',
  '',
  '`effect` is colour grading: brightness / contrast / saturation 0..2 (1 is neutral), hue in',
  'degrees -180..180, blur in composition pixels 0..20, plus a named preset (cinema, warm, cool,',
  'vivid, mono, fade). Preview and export apply the same filter string, so a graded frame matches.',
  '`set_effect` with `clear: true` removes the grade.',
  '',
  '`audioEffect` is the tone of the clip\'s own sound: `highpass` in Hz (0 off), `bass` / `mid` /',
  '`treble` in dB -12..12, and `compress` for a gentle compressor. Two mastering switches sit beside',
  'them: `normalize` brings the clip to a common RMS (about -18 dBFS), and `denoise` gates steady',
  'hiss between sentences — a downward expander, not spectral repair. Both are measured from the',
  'source and applied as gain curves, so the preview and the exported file match.',
  '`set_audio_effect` merges; `clear: true` removes the tone.',
  '',
  '`speed` (0.1..100) retimes a clip: the source window it uses stays the same and its timeline',
  'length scales with the rate (2x halves it, 0.5x doubles it), and its own sound runs at the same',
  'rate (varispeed, pitch follows). The rest of the track ripples with it, so a packed cut stays',
  'packed; pass "ripple": false to rescale the clip alone and arrange the neighbours yourself.',
  'Only moving material has a rate — a still or a held frame is resized with trim_clip instead.',
  '`set_speed` writes it.',
  '',
  'Tracks carry a name, and three flags beyond sound: `locked` refuses clip edits (the panel too),',
  '`hidden` drops a video track\'s picture while its sound keeps playing, and `move_track` reorders',
  'the stack — for video, a higher position paints above the ones below it. `remove_track` drops a',
  'track with its clips; the only video track is kept so the cut still has a picture.',
  '',
  '`set_settings` changes the composition: width and height are the output frame. Text sizes,',
  'stroke widths, shadow blur, picture-in-picture frame widths and clip blur scale with the height',
  'ratio, so a 16:9 cut moved to 9:16 keeps the same share of the frame; boxes and positions are',
  'normalized and need no work. Pass "rescale": false to resize the canvas alone.',
  '',
  '`cut_at` cuts every track at the moments you give it (a beat grid, a shot list) in one pass;',
  'split_clip does one clip at one moment. A split keeps volume, mute, transform and a baked duck,',
  'keeps fades on the edges they belong to, and leaves the incoming transition on the head.',
  '',
  '`fcpxml` writes the cut as FCPXML 1.9 — the base video track becomes the spine (gaps keep the',
  'holes), upper video tracks and sound tracks become connected clips on their own lanes. Speed',
  'changes travel as `timeMap`s, and a held frame is a constant one; transitions, overlays, grades',
  'and gains stay behind in the .reel.',
  '',
  '卡点: `beats --src assets/music.mp3 --clip <id> --json` decodes the sound (a hidden window has the',
  'decoder) and answers tempo, a beat grid with strength, downbeats every fourth beat, and the raw',
  'onsets. With `--clip` the grid is timeline seconds, mapped through the clip window and its speed;',
  'without it they are source seconds. `auto_edit` then fills a video track from that grid: one',
  'clip per accepted cut point, sources taken in turn, points closer than minClipDuration dropped,',
  'gaps past maxClipDuration capped, and each clip placed at its own beat (a capped gap leaves a',
  'short hole — `remove_gaps` closes it). `mode` is beats / downbeats / segments, and `beatsPerCut`',
  'spaces segments. The op takes the beat data, so a batch never decodes twice.',
  '',
  'A transition belongs to the incoming clip (`transition: { kind, duration }`) and needs a clip',
  'starting exactly where it does. It is centred on the cut: crossfade blends the two pictures,',
  'wipe-left reveals it from the left, slide-left pushes it in from the right, zoom settles it from',
  '85% while fading, and dip-black / dip-white pass through that colour. The side outside its own',
  'window holds its edge frame, so the picture never jumps.',
  '',
  '`set_mask` masks a clip\'s picture with a rectangle, ellipse or polygon. Bounds are fractions of',
  'the **composition**, so the mask does not travel with the clip\'s transform or keyframes;',
  '`feather` softens the edge (px), `expansion` grows or shrinks it (px), `inverted` keeps the',
  'outside, and `opacity` makes the reveal partial. A polygon\'s `points` are 0..1 inside its own',
  'bounds. One mask per clip in this version — setting it again replaces it; `clear_mask` removes it.',
  'Add `keyframes: [{ time, x, y, width, height, opacity?, easing? }]` to animate the box — a face',
  'track, a growing spotlight, a reveal that follows a pan. Times are clip-local and interpolation',
  'holds at both ends; `easing` is the segment arriving at that keyframe. `keyframes: []` clears the',
  'animation and keeps the last static box.',
  '',
  '`set_effect` carries regional blur too: `regions: [{ x, y, w, h, mode: "blur"|"mosaic", strength }]`',
  'in composition fractions — a watermark, a logo, a face. The region is sampled from the clip after',
  'its grade and before its mask; `strength` is the blur radius or the mosaic cell size in pixels.',
  '`clearRegions: true` removes them and leaves the grade alone. `set_transform` takes',
  '`flipX: true` to mirror the picture horizontally (a keyframed flip switches halfway through).',
  '',
  'Operations (a batch of 1–50):',
  '  { "op": "add_track",   "kind": "video" | "audio" }',
  '  { "op": "add_clip",    "src": "assets/a.mp4", "duration": 4.2, "in": 0, "start": 0, "trackId": "video-1", "volume": 0.8 }',
  '  { "op": "move_clip",   "id": "clip-1", "start": 4.5 }',
  '  { "op": "trim_clip",   "id": "clip-1", "head": 1.2, "tail": 0.8 }',
  '  { "op": "trim_clip",   "id": "clip-1", "in": 2.0, "duration": 3.5 }',
  '  { "op": "split_clip",  "id": "clip-1", "at": 6.0 }',
  '  { "op": "cut_at",      "times": [2.5, 5, 7.5] }',
  '  { "op": "auto_edit",   "trackId": "video-1", "mode": "beats", "sources": ["assets/a.mp4", "assets/b.mp4"],',
  '      "beats": [{ "time": 0.5, "strength": 1 }, { "time": 1, "strength": 1 }], "downbeats": [0.5],',
  '      "minClipDuration": 0.3, "maxClipDuration": 10, "beatsPerCut": 4, "inPoint": "walk" }',
  '  { "op": "auto_edit",   "trackId": "video-1", "mode": "downbeats", "sources": [{ "src": "assets/a.mp4", "duration": 8 }],',
  '      "downbeats": [0, 2, 4, 6] }',
  '  { "op": "remove_clip", "id": "clip-1" }',
  '  { "op": "add_overlay", "overlay": { "kind": "text", "text": "你好", "start": 0, "duration": 2, "preset": "subtitle" } }',
  '  { "op": "add_overlay", "overlay": { "template": "impact", "text": "第 1 集", "start": 0, "duration": 3 } }',
  '  { "op": "add_overlay", "overlay": { "kind": "media", "src": "assets/face.mp4", "start": 1, "duration": 4, "box": { "x": 0.7, "y": 0.06, "w": 0.26, "h": 0.26 } } }',
  '  { "op": "add_subtitles", "path": "assets/voice.srt" }',
  '  { "op": "add_subtitles", "srt": "1\\n00:00:01,000 --> 00:00:03,000\\n你好\\n" }',
  '  { "op": "add_subtitles", "cues": [{ "start": 1, "end": 3, "text": "你好" }], "style": { "fontSize": 54 } }',
  '  { "op": "shift_subtitles", "by": 0.4 }',
  '  { "op": "clear_subtitles" }',
  '  { "op": "clear_subtitles", "from": 10, "to": 20 }',
  '  { "op": "replace_subtitle_text", "find": "AI", "replace": "人工智能", "wholeWords": true }',
  '  { "op": "dedupe_subtitles", "window": 0.05 }',
  '  { "op": "style_subtitles", "style": { "fontSize": 52, "backgroundColor": "rgba(0,0,0,0.6)" } }',
  '  { "op": "update_overlay", "id": "ov-1", "change": { "text": "改一句", "start": 1 } }',
  '  { "op": "remove_overlay", "id": "ov-1" }',
  '  { "op": "set_audio",   "id": "clip-1", "volume": 0.6, "muted": false }',
  '  { "op": "detach_audio", "id": "clip-1" }',
  '  { "op": "set_fade",    "id": "clip-1", "fadeIn": 0.5, "fadeOut": 0.8 }',
  '  { "op": "set_track_audio", "trackId": "audio-1", "muted": false, "solo": true }',
  '  { "op": "set_track",   "trackId": "video-1", "name": "主画面", "locked": false, "hidden": false }',
  '  { "op": "move_track",  "trackId": "video-2", "index": 0 }',
  '  { "op": "remove_track", "trackId": "video-2" }',
  '  { "op": "set_automation", "id": "clip-1", "points": [{ "time": 0, "value": 1 }, { "time": 4.2, "value": 0.35 }] }',
  '  { "op": "clear_ducking", "id": "clip-1" }',
  '  { "op": "set_transform", "id": "clip-1", "scale": 1.1, "x": 0.05, "opacity": 0.9 }',
  '  { "op": "set_keyframes", "id": "clip-1", "keyframes": [',
  '      { "time": 0, "transform": { "scale": 1 }, "opacity": 1 },',
  '      { "time": 4, "transform": { "scale": 1.3, "x": 0.2 }, "opacity": 0.6, "easing": "ease-in-out" } ] }',
  '  { "op": "clear_keyframes", "id": "clip-1" }',
  '  { "op": "set_crop",  "id": "clip-1", "x": 0.1, "y": 0, "w": 0.8, "h": 1 }',
  '  { "op": "set_crop",  "id": "clip-1", "clear": true }',
  '  { "op": "set_mask",  "id": "clip-1", "shape": "ellipse", "x": 0.3, "y": 0.2, "width": 0.4, "height": 0.6, "feather": 24 }',
  '  { "op": "set_mask",  "id": "clip-1", "shape": "polygon", "points": [{ "x": 0.5, "y": 0 }, { "x": 1, "y": 1 }, { "x": 0, "y": 1 }], "inverted": true }',
  '  { "op": "set_mask",  "id": "clip-1", "shape": "ellipse", "keyframes": [',
  '      { "time": 0, "x": 0.3, "y": 0.2, "width": 0.3, "height": 0.35 },',
  '      { "time": 2, "x": 0.45, "y": 0.3, "width": 0.3, "height": 0.35, "easing": "ease-in-out" } ] }',
  '  { "op": "clear_mask", "id": "clip-1" }',
  '  { "op": "set_overlay_frame", "id": "ov-1", "width": 6, "color": "#ffffff", "radius": 0.08 }',
  '  { "op": "set_overlay_frame", "id": "ov-1", "clear": true }',
  '  { "op": "freeze_frame", "id": "clip-1", "at": 2, "duration": 3 }',
  '  { "op": "set_effect",  "id": "clip-1", "preset": "cinema", "brightness": 1.05 }',
  '  { "op": "set_effect",  "id": "clip-1", "regions": [{ "x": 0.68, "y": 0.04, "w": 0.28, "h": 0.1, "mode": "blur", "strength": 18 }] }',
  '  { "op": "set_effect",  "id": "clip-1", "clearRegions": true }',
  '  { "op": "set_transform", "id": "clip-1", "flipX": true }',
  '  { "op": "set_speed",   "id": "clip-1", "speed": 2 }',
  '  { "op": "set_effect",  "id": "clip-1", "clear": true }',
  '  { "op": "set_audio_effect", "id": "clip-1", "highpass": 120, "bass": 2, "compress": true }',
  '  { "op": "set_audio_effect", "id": "clip-1", "normalize": true, "denoise": true }',
  '  { "op": "set_audio_effect", "id": "clip-1", "clear": true }',
  '  { "op": "duplicate_clip", "id": "clip-1" }',
  '  { "op": "ripple_delete", "id": "clip-1" }',
  '  { "op": "close_gap", "id": "clip-1" }',
  '  { "op": "remove_gaps", "trackId": "video-1" }',
  '  { "op": "set_transition", "id": "clip-2", "kind": "crossfade", "duration": 0.6 }',
  '  { "op": "clear_transition", "id": "clip-2" }',
  '  { "op": "rename",      "name": "预告片" }',
  '  { "op": "add_marker",  "time": 12.5, "name": "第二章" }',
  '  { "op": "remove_marker", "markerId": "marker-1" }',
  '  { "op": "set_settings", "width": 1080, "height": 1920, "frameRate": 30 }',
  '',
  'A batch is one edit: it applies whole or not at all. A panel showing this cut takes the new',
  'revision as one undo step; one that still owes a write of its own asks before reloading.',
].join('\n')

/**
 * Every verb this tool answers. Checked before a cut is resolved, so a typo is named rather than
 * read as a cut handle (and a conversation with no cuts still gets a useful answer).
 */
const VERBS = new Set([
  'list',
  'create',
  'state',
  'probe',
  'beats',
  'snapshot',
  'export',
  'subtitles',
  'fcpxml',
  'apply',
])

function tokenize(command: string | string[]): string[] {
  if (Array.isArray(command)) return command
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) ?? []
}

function parse(tokens: string[]): { verb: string; flags: Map<string, string> } {
  const [verb = 'help', ...rest] = tokens
  const flags = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token?.startsWith('--')) continue
    const value = rest[index + 1]
    // A flag with no value is still a flag: `--json` is the whole statement, and dropping it here
    // would make the caller's choice disappear without a word.
    if (value === undefined || value.startsWith('--')) {
      flags.set(token.slice(2), '')
      continue
    }
    flags.set(token.slice(2), value)
    index += 1
  }
  return { verb: verb.toLowerCase(), flags }
}

const reelsDir = (projectDir: string) => join(projectDir, 'reels')

function cutsOf(projectDir: string): string[] {
  const dir = reelsDir(projectDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => isReelPath(name))
    .map((name) => join(dir, name))
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path
const cutNameOf = (path: string) => reelNameOf(path)

/** A name a file can carry on every platform; a cut is addressed by its path. */
const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'cut'

/** One export job, in the words the agent will repeat to the person. */
function describeExport(job: ReelExportJob): string {
  const elapsed = ((job.completedAt ?? Date.now()) - job.startedAt) / 1000
  const what = job.audioOnly ? `sound only, ${job.container === 'mp3' ? 'mp3' : 'm4a'}` : job.container
  if (job.status === 'running') {
    const percent = job.progress !== undefined ? `${Math.round(job.progress * 100)}%, ` : ''
    return `${job.id}: still rendering (${percent}${elapsed.toFixed(0)}s) → ${job.outPath} (${what})`
  }
  if (job.status === 'failed') {
    return `${job.id}: failed — ${job.message ?? 'no reason given'} (the cut itself is untouched)`
  }
  if (job.status === 'cancelled') {
    return `${job.id}: cancelled — no file was kept (the cut itself is untouched)`
  }
  const timeline = job.duration ? `, ${job.duration.toFixed(1)}s of timeline` : ''
  return `${job.id}: completed in ${elapsed.toFixed(1)}s → ${job.outPath} (${what}${timeline})`
}


function readCut(path: string): EditDocument {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return normalizeDocument(parsed, cutNameOf(path))
}

function summarize(path: string, doc: EditDocument): string {
  const fps = doc.settings.frameRate
  const lines = [
    `${nameOf(path)} — ${doc.name} (rev ${doc.revision})`,
    `${doc.settings.width}×${doc.settings.height} @ ${doc.settings.frameRate}fps · ${durationOf(doc).toFixed(2)}s (${Math.round(durationOf(doc) * doc.settings.frameRate)}f) · ${clipsOf(doc).length} clip(s)`,
  ]
  for (const track of doc.tracks) {
    const flags = `${track.name ? ` · ${track.name}` : ''}${track.muted ? ' · muted' : ''}${track.solo ? ' · solo' : ''}${track.locked ? ' · locked' : ''}${track.hidden ? ' · hidden' : ''}`
    lines.push(`  ${track.id} (${track.kind})${flags}`)
    for (const clip of track.clips) {
      const audio = clip.muted
        ? ' · muted'
        : clip.volume !== undefined
          ? ` · vol ${Math.round(clip.volume * 100)}%`
          : ''
      const fade = clip.fade
        ? ` · fade ${clip.fade.fadeIn.toFixed(2)}/${clip.fade.fadeOut.toFixed(2)}s`
        : ''
      const automation = clip.automation?.length ? ` · ${clip.automation.length} keyframes` : ''
      const ducking = clip.ducking ? ' · duck' : ''
      const placement = clip.keyframes?.length
        ? ` · ${clip.keyframes.length} placement keyframes (${clip.keyframes
            .slice(0, 8)
            .map((keyframe) => `f${Math.round(keyframe.time * fps)}`)
            .join(',')}${clip.keyframes.length > 8 ? ',…' : ''})`
        : clip.transform || clip.opacity !== undefined
          ? ' · transform'
          : ''
      const crop = clip.crop ? ' · crop' : ''
      const freeze = clip.freeze ? ' · freeze' : ''
      const grade = clip.effect
        ? ` · effect${clip.effect.regions?.length ? ` +${clip.effect.regions.length} region(s)` : ''}`
        : ''
      const tone = clip.audioEffect
        ? ` · tone${clip.audioEffect.normalize ? ' +norm' : ''}${clip.audioEffect.denoise ? ' +denoise' : ''}`
        : ''
      const rate = clipSpeed(clip) !== 1 ? ` · ${clipSpeed(clip)}x` : ''
      const transition = clip.transition
        ? ` · transition ${Math.round(clip.transition.duration * fps)}f`
        : ''
      lines.push(
        `    ${clip.id}  ${clip.src}  start ${clip.start.toFixed(2)}s (f${Math.round(clip.start * fps)}) · in ${clip.in.toFixed(2)}s · ${clip.duration.toFixed(2)}s (${Math.round(clip.duration * fps)}f)${audio}${fade}${automation}${ducking}${placement}${crop}${freeze}${grade}${tone}${rate}${transition}`,
      )
    }
  }
  if (clipsOf(doc).length === 0) lines.push('  (empty — add media in the panel, or with add_clip)')
  for (const overlay of doc.overlays) {
    const label = overlay.kind === 'media' ? overlay.src : JSON.stringify(overlay.text ?? '')
    const level = resolveOverlayVolume(overlay)
    const audio = overlay.kind === 'media' ? (level > 0 ? ` · vol ${Math.round(level * 100)}%` : ' · silent') : ''
    const animation = overlay.animation ? ` · ${overlay.animation.preset}` : ''
    const frame = overlay.frame ? ` · frame ${overlay.frame.width}px` : ''
    lines.push(
      `  ${overlay.id} (${overlay.kind}${overlay.preset ? `/${overlay.preset}` : ''})  start ${overlay.start.toFixed(2)}s (f${Math.round(overlay.start * fps)}) · ${overlay.duration.toFixed(2)}s (${Math.round(overlay.duration * fps)}f)${audio}${animation}${frame}  ${label}`,
    )
  }
  for (const marker of markersOf(doc)) {
    lines.push(
      `  ${marker.id} (marker)  ${marker.time.toFixed(2)}s (f${Math.round(marker.time * fps)})${marker.name ? `  ${marker.name}` : ''}`,
    )
  }
  for (const mask of masksOf(doc)) {
    const animated = mask.keyframes?.length
      ? ` · ${mask.keyframes.length} keyframes (f${Math.round(mask.keyframes[0]!.time * fps)}–f${Math.round(mask.keyframes[mask.keyframes.length - 1]!.time * fps)})`
      : ''
    lines.push(
      `  ${mask.id} (mask/${mask.shape})  clip ${mask.clipId} · x ${mask.x.toFixed(2)} y ${mask.y.toFixed(2)} w ${mask.width.toFixed(2)} h ${mask.height.toFixed(2)} · feather ${mask.feather}px · expand ${mask.expansion}px${mask.inverted ? ' · inverted' : ''}${mask.opacity < 1 ? ` · opacity ${Math.round(mask.opacity * 100)}%` : ''}${animated}`,
    )
  }
  return lines.join('\n')
}

/**
 * One overlay, cleaned up and given an id nothing else in this cut uses. Shared by
 * `add_overlay` and `add_subtitles`, so a cue and a hand-made box take the same path in.
 */
function appendOverlay(doc: EditDocument, raw: unknown): EditDocument {
  const normalized = normalizeOverlay(raw, doc.overlays.length)
  if (!normalized) throw new Error('an overlay needs text (text) or src (media)')
  const used = new Set(doc.overlays.map((overlay) => overlay.id))
  let overlayId = normalized.id
  let suffix = 2
  while (used.has(overlayId)) {
    overlayId = `ov-${doc.overlays.length + suffix}`
    suffix += 1
  }
  return addOverlay(doc, { ...normalized, id: overlayId })
}

/** The optional `from` / `to` window a subtitle batch may carry. */
function subtitleRange(op: Record<string, unknown>): { from?: number; to?: number } {
  const read = (key: 'from' | 'to'): number | undefined => {
    if (op[key] === undefined) return undefined
    const value = Number(op[key])
    if (!Number.isFinite(value) || value < 0) throw new Error(`subtitle range ${key} must be >= 0`)
    return value
  }
  const from = read('from')
  const to = read('to')
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
}

export async function handleReelTool(ctx: SessionToolContext, args: ReelToolArgs): Promise<ToolResult> {
  const tokens = tokenize(args.command ?? [])
  const { verb, flags } = parse(tokens)
  if (verb === 'help' || verb === '--help' || verb === '-h') {
    const topic = tokens[1]?.toLowerCase()
    return text(topic === 'all' || topic === 'full' || topic === '--all' ? HELP_DETAIL : HELP)
  }
  if (!VERBS.has(verb)) {
    return text(`Unknown command "${verb}" — try ${[...VERBS].join(', ')}.\n\n${HELP}`)
  }

  // A cut is a project document. A conversation outside a project has no place to put one — the
  // project's `reels/` folder is the one home, so creating one before the conversation is bound to
  // a project is refused rather than written somewhere that has no assets beside it.
  const info = ctx.getSessionInfo?.()
  const resolvedRoots = resolveContentRoots({
    sessionId: ctx.sessionId,
    workspaceRootPath: ctx.workspacePath,
    sessionDir: ctx.sessionPath,
    projectId: info?.projectId,
    workingDirectory: ctx.workingDirectory,
  })
  if (!resolvedRoots.ok) return fail(resolvedRoots.error)
  const roots = resolvedRoots.roots
  if (!roots.projectDir) {
    return fail('剪辑需要一个项目：这个会话还没有绑定项目。先在项目里开始一个会话，再创建剪辑。')
  }
  const projectDir = roots.projectDir
  const cuts = cutsOf(projectDir)

  if (verb === 'create') {
    const requested = (flags.get('name') ?? '').trim()
    const namedFile = flags.get('file')
    let path: string
    if (namedFile) {
      const resolved = resolveFilePath(namedFile, roots)
      if (!resolved.ok) return fail(resolved.error)
      if (!isInside(projectDir, resolved.path)) {
        return fail(`剪辑要放在项目文件夹里：${resolved.path} 不在 ${projectDir} 内。`)
      }
      path = resolved.path
    } else {
      path = join(reelsDir(projectDir), `${safeName(requested || `剪辑 ${cuts.length + 1}`)}${REEL_EXTENSION}`)
    }
    if (existsSync(path)) {
      return fail(`${path} already exists. Open it with state, or pick another name.`)
    }
    const name = requested || cutNameOf(path)
    const settings: EditSettings = { ...DEFAULT_SETTINGS }
    for (const key of ['width', 'height', 'frameRate'] as const) {
      const raw = key === 'frameRate' ? flags.get('fps') : flags.get(key)
      if (raw === undefined) continue
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) return fail(`${key} must be a positive number.`)
      settings[key] = key === 'frameRate' ? normalizeFrameRate(value) : value
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(emptyDocument(name, settings), null, 2)}\n`)
    } catch (error) {
      return fail(`Could not create ${path}: ${(error as Error).message}`)
    }
    return text(
      `Created ${path} — ${settings.width}×${settings.height} @ ${settings.frameRate}fps, revision 0.\n` +
        `Add clips with apply --file ${path} --ops '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'.`,
    )
  }

  if (verb === 'list') {
    if (!cuts.length) {
      return text('This conversation has no cuts yet. Create one with `create --name 预告`, or from the side panel.')
    }
    return text(
      cuts
        .map((path) => {
          try {
            const doc = readCut(path)
            return `${cutNameOf(path)}\t rev ${doc.revision}\t ${durationOf(doc).toFixed(1)}s\t ${clipsOf(doc).length} clip(s)`
          } catch {
            return `${cutNameOf(path)}\t unreadable`
          }
        })
        .join('\n'),
    )
  }

  // A source's own shape — duration, size, rate, frame count. `add_clip` reads the duration from
  // here when a batch omits it; asking directly is how an agent plans frame-accurate cuts.
  if (verb === 'probe') {
    const src = (flags.get('src') ?? '').trim()
    if (!src) return fail('probe needs --src <path> (project-relative, e.g. assets/a.mp4).')
    const resolved = resolveFilePath(src, roots)
    if (!resolved.ok) return fail(resolved.error)
    if (STILL.test(resolved.path)) {
      return text(`${resolved.path} — still image (no source duration; the clip's length is the one you place).`)
    }
    const probe = reelProbe()
    if (!probe) {
      return fail('这个宿主没有素材探测器：读取容器信息要由桌面端完成，这里只有文件。')
    }
    const [info] = await probe([resolved.path], { stats: true })
    if (!info) return fail(`No information for ${src}.`)
    if (info.message) return fail(info.message)
    if (info.duration === null) {
      return fail(`${resolved.path}: the container does not state a duration.`)
    }
    const shape = [
      info.width && info.height ? `${info.width}×${info.height}` : null,
      info.fps ? `${info.fps.toFixed(3)}fps` : null,
      info.frameCount ? `${info.frameCount} frames` : null,
      info.codec ?? null,
      info.hasAudio === undefined ? null : info.hasAudio ? 'audio' : 'no audio',
    ].filter((part): part is string => !!part)
    // The conversion is stated with the source's own rate: a cut is written in project seconds,
    // but `in` addresses this file, so frame N lives at N / sourceFps.
    const conversion = info.fps
      ? (() => {
          const span = info.frameCount ?? Math.max(1, Math.round(info.duration * info.fps!))
          const frame = Math.max(0, Math.min(span - 1, Math.round(span / 2)))
          return `Source frames → seconds: frame ${frame} = ${frame} / ${info.fps!.toFixed(3)} = ${(frame / info.fps!).toFixed(3)}s (frame N is at N / ${info.fps!.toFixed(3)}s).`
        })()
      : null
    return text(
      `${resolved.path} — ${info.duration.toFixed(3)}s${shape.length ? ` · ${shape.join(' · ')}` : ''}${conversion ? `\n${conversion}` : ''}`,
    )
  }

  // The pulse of a source: tempo, a beat grid and downbeats. With `--clip` the grid is moved onto
  // the timeline, which is the form `auto_edit` consumes. The host decodes; `beats.ts` decides.
  if (verb === 'beats') {
    const src = (flags.get('src') ?? '').trim()
    if (!src) return fail('beats needs --src <path> (project-relative, e.g. assets/music.mp3).')
    const resolvedSource = resolveFilePath(src, roots)
    if (!resolvedSource.ok) return fail(resolvedSource.error)
    if (STILL.test(resolvedSource.path)) {
      return fail(`${resolvedSource.path} is a still image — it has no sound to analyse.`)
    }
    const reader = reelAudio()
    if (!reader) {
      return fail('这个宿主没有音频解码器：卡点分析要由桌面端窗口完成，这里只有文件。')
    }
    const bucket = Number(flags.get('bucket') ?? 0.01)
    const decoded = await reader(resolvedSource.path, {
      bucketSeconds: Number.isFinite(bucket) && bucket > 0 ? bucket : 0.01,
    })
    if (!decoded.ok) return fail(decoded.message)

    const readNumber = (flag: string, fallback: number): number => {
      const value = Number(flags.get(flag) ?? fallback)
      return Number.isFinite(value) ? value : fallback
    }
    let analysis: BeatAnalysis = analyzeBeats(decoded.levels.rms, {
      bucketSeconds: decoded.levels.bucketSeconds,
      sensitivity: readNumber('sensitivity', 0.5),
      minBpm: readNumber('min-bpm', 60),
      maxBpm: readNumber('max-bpm', 200),
    })

    // `--clip` maps source seconds onto the timeline, speed included — that is what a cut needs.
    const clipId = (flags.get('clip') ?? '').trim()
    let clipName = ''
    if (clipId) {
      const wanted = flags.get('file') ?? (cuts.length === 1 ? cuts[0]! : null)
      if (!wanted) {
        return fail('beats --clip needs a cut: this conversation has more than one, so name one with --file.')
      }
      const resolvedCut = resolveFilePath(wanted, roots)
      if (!resolvedCut.ok) return fail(resolvedCut.error)
      let clipDoc: EditDocument
      try {
        clipDoc = readCut(resolvedCut.path)
      } catch (error) {
        return fail(`Could not read ${resolvedCut.path}: ${(error as Error).message}`)
      }
      const clip = findClip(clipDoc, clipId)
      if (!clip) return fail(`no clip ${clipId} in ${reelNameOf(resolvedCut.path)}`)
      analysis = clipBeatsOf(clip, analysis)
      clipName = clipId
    }

    const timebase = clipName ? 'timeline' : 'source'
    if (flags.has('json')) {
      return text(
        JSON.stringify(
          {
            source: resolvedSource.path,
            ...(clipName ? { clip: clipName } : {}),
            timebase,
            duration: analysis.duration,
            bpm: analysis.bpm,
            confidence: analysis.confidence,
            beats: analysis.beats,
            downbeats: analysis.downbeats,
            onsets: analysis.onsets,
          },
          null,
          2,
        ),
      )
    }

    const times = (values: number[]): string =>
      values.length ? values.map((value) => value.toFixed(3)).join(' ') : '—'
    const interval = analysis.bpm > 0 ? 60 / analysis.bpm : 0
    const pulse = analysis.bpm
      ? `${analysis.bpm} BPM (confidence ${(analysis.confidence * 100).toFixed(0)}%, ${interval.toFixed(3)}s apart)`
      : 'no steady pulse found — onsets only'
    return text(
      `${resolvedSource.path}${clipName ? ` · clip ${clipName}` : ''} — ${analysis.duration.toFixed(2)}s · ${pulse}\n` +
        `beats ${analysis.beats.length} · downbeats ${analysis.downbeats.length} · onsets ${analysis.onsets.length}\n` +
        `beats (${timebase} s): ${times(analysis.beats.map((beat) => beat.time))}\n` +
        `downbeats (${timebase} s): ${times(analysis.downbeats)}\n` +
        (clipName
          ? 'Times are timeline seconds — pass them to auto_edit (or cut_at).'
          : 'Times are source seconds — add --clip <id> to map them onto the timeline.'),
    )
  }

  // `export --status` answers about jobs, not about one cut: a render may have been started before
  // the folder changed, and asking "is it done?" must not require naming the cut again.
  if (verb === 'export' && flags.has('status')) {
    const host = reelExportHost()
    if (!host) {
      return fail('这个宿主没有渲染器：导出要由桌面端窗口来编码，这里只有文件。')
    }
    const wanted = (flags.get('status') ?? '').trim()
    if (wanted) {
      const job = host.status(wanted)
      // A job id is quotable, not public: another conversation's export is not this one's business.
      if (!job || job.sessionId !== ctx.sessionId) {
        return fail(
          `No export "${wanted}" here — it may have been pruned, or the app restarted. The file, if it was written, is still on disk.`,
        )
      }
      return text(describeExport(job))
    }
    const jobs = host.list(ctx.sessionId)
    if (jobs.length === 0) return text('This conversation has not started an export yet.')
    return text(jobs.map(describeExport).join('\n'))
  }

  // `export --cancel` stops a running encode. Scoped like `--status`: another conversation's job
  // is not this one's to stop.
  if (verb === 'export' && flags.has('cancel')) {
    const host = reelExportHost()
    if (!host) {
      return fail('这个宿主没有渲染器：导出要由桌面端窗口来编码，这里只有文件。')
    }
    const wanted = (flags.get('cancel') ?? '').trim()
    if (!wanted) return fail('--cancel needs a job id (`export --status` lists them).')
    const job = host.status(wanted)
    if (!job || job.sessionId !== ctx.sessionId) {
      return fail(`No export "${wanted}" in this conversation.`)
    }
    if (job.status !== 'running') {
      return fail(`${wanted} is already ${job.status} — there is nothing to cancel.`)
    }
    if (!host.cancel(wanted)) {
      return fail(`Could not stop ${wanted}; it may have just finished. Ask \`export --status ${wanted}\`.`)
    }
    return text(`Cancelling ${wanted}. Its partial file is removed; the cut itself is untouched.`)
  }

  // Which cut: `--file` (a handle or an absolute path), or the only one there is.
  let path: string | null = null
  const named = flags.get('file')
  if (named) {
    const resolved = resolveFilePath(named, roots)
    if (!resolved.ok) return fail(resolved.error)
    path = resolved.path
  } else if (cuts.length === 1) {
    path = cuts[0]!
  } else if (cuts.length === 0) {
    return fail('This conversation has no cuts yet. Create one with `create --name 预告`.')
  } else {
    return fail(
      `This conversation has ${cuts.length} cuts — name one with --file:\n${cuts
        .map((cut) => `  ${cut}`)
        .join('\n')}`,
    )
  }

  if (!existsSync(path)) return fail(`No cut at ${path}.`)
  let doc: EditDocument
  try {
    doc = readCut(path)
  } catch (error) {
    return fail(`Could not read ${path}: ${(error as Error).message}`)
  }

  if (verb === 'state') {
    if (flags.has('json')) return text(JSON.stringify(doc, null, 2))
    return text(summarize(path, doc))
  }

  // One frame, drawn by the same compositor the preview and the export use — so what the agent
  // looks at is what the panel shows at that moment, not an approximation of it.
  if (verb === 'snapshot') {
    const render = reelSnapshot()
    if (!render) {
      return fail('这个宿主没有画面渲染器：快照要由桌面端窗口或渲染宿主来画，这里只有文件。')
    }
    if (clipsOf(doc).length === 0 && doc.overlays.length === 0) {
      return fail('This cut is empty — add a clip before asking to look at a frame.')
    }
    const clipFlag = (flags.get('clip') ?? '').trim()
    const edgeChoice = (flags.get('edge') ?? '').trim()
    if (edgeChoice && !clipFlag) return fail('--edge needs --clip <id>.')
    if (edgeChoice && edgeChoice !== 'first' && edgeChoice !== 'last') {
      return fail('--edge must be first or last.')
    }
    if (clipFlag && flags.has('at')) return fail('Use --at (timeline seconds) or --clip, not both.')
    const target = clipFlag ? findClip(doc, clipFlag) : null
    if (clipFlag && !target) return fail(`No clip ${clipFlag} in this cut.`)
    const edge = target ? (edgeChoice === 'last' ? 'last' : 'first') : null
    // A clip's last frame is the one covering its final instant, so sample just inside the piece:
    // the composition only owns a moment while `time < start + duration`.
    const at = target
      ? edge === 'last'
        ? Math.max(target.start, target.start + target.duration - 1e-3)
        : target.start
      : flags.has('at')
        ? Number(flags.get('at'))
        : 0
    if (!Number.isFinite(at) || at < 0) {
      return fail('--at must be a non-negative number of seconds.')
    }
    // A moment past the end draws black, which reads as "my edit is broken" rather than "you asked
    // for a time the cut does not have". Say which is which.
    const total = durationOf(doc)
    if (total > 0 && at >= total) {
      return fail(`This cut is ${total.toFixed(2)}s long — ${at}s is past its end.`)
    }
    const edgeFlag = flags.get('max-edge')
    const maxEdge = edgeFlag === undefined ? undefined : Number(edgeFlag)
    if (maxEdge !== undefined && (!Number.isFinite(maxEdge) || maxEdge <= 0)) {
      return fail('--max-edge must be a positive number of pixels.')
    }

    const namedOut = (flags.get('out') ?? '').trim()
    let outPath: string
    if (namedOut) {
      const resolved = resolveFilePath(namedOut, roots)
      if (!resolved.ok) return fail(resolved.error)
      outPath = resolved.path
    } else {
      outPath = join(
        reelsDir(projectDir),
        'frames',
        target
          ? `${safeName(doc.name)}-${target.id}-${edge}.jpg`
          : `${safeName(doc.name)}-${at.toFixed(3)}.jpg`,
      )
    }

    const result = await render({
      document: doc,
      at,
      outPath,
      ...(maxEdge === undefined ? {} : { maxEdge }),
      // A project-relative source becomes the file the host's decoder opens.
      pathOf: (src) => {
        const resolved = resolveFilePath(src, roots)
        return resolved.ok ? resolved.path : resolve(projectDir, src)
      },
    })
    if (!result.ok) return fail(result.message ?? 'Could not draw that frame.')
    const gaps = result.warnings?.length
      ? `\nNote — the picture is missing these sources: ${result.warnings.join(' | ')}`
      : ''
    // The source moment is what makes an edge frame checkable: two files can look alike, but this
    // number says which instant of the material was actually drawn.
    const origin = target
      ? ` (${target.id} ${edge} frame, source ${clipSourceTime(target, Math.max(0, at - target.start)).toFixed(3)}s)`
      : ''
    return text(
      `Frame at ${at.toFixed(3)}s${origin} → ${result.path} (${result.width}×${result.height}). Read the file to look at it.${gaps}`,
    )
  }

  // The finished film, as a job. Rendering takes minutes, so nothing here waits: `export` starts
  // it, `export --status` answers, and the host wakes the conversation when the file lands.
  if (verb === 'export') {
    const host = reelExportHost()
    if (!host) {
      return fail('这个宿主没有渲染器：导出要由桌面端窗口来编码，这里只有文件。')
    }

    if (clipsOf(doc).length === 0 && doc.overlays.length === 0) {
      return fail('This cut is empty — add a clip before exporting.')
    }

    // A range export is the same renderer over a slice of the cut: clips that cross the head move
    // their source window, and everything is placed from 0. The file therefore starts at `--from`.
    const total = durationOf(doc)
    const fromFlag = flags.get('from')
    const toFlag = flags.get('to')
    let exportDoc = doc
    let range: { from: number; to: number } | null = null
    if (fromFlag !== undefined || toFlag !== undefined) {
      const from = fromFlag === undefined ? 0 : Number(fromFlag)
      const to = toFlag === undefined ? total : Number(toFlag)
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
        return fail('An export range needs 0 <= --from < --to (seconds).')
      }
      if (from >= total) {
        return fail(`--from ${from}s is past the end of this cut (${total.toFixed(2)}s).`)
      }
      const clippedTo = Math.min(to, total)
      exportDoc = sliceDocument(doc, from, clippedTo)
      if (clipsOf(exportDoc).length === 0 && exportDoc.overlays.length === 0) {
        return fail(`That range (${from}s–${clippedTo.toFixed(2)}s) covers no clips or overlays.`)
      }
      range = { from, to: clippedTo }
    }

    const namedOut = (flags.get('out') ?? '').trim()
    const namedExtension = namedOut ? extname(namedOut).toLowerCase() : ''
    const containerFlag = (flags.get('container') ?? '').trim().toLowerCase()
    let container: ExportContainer
    if (containerFlag) {
      if (containerFlag !== 'mp4' && containerFlag !== 'webm' && containerFlag !== 'mp3') {
        return fail('--container must be mp4, webm or mp3.')
      }
      container = containerFlag
    } else {
      // The name decides when no container is stated, so `--out draft.webm` needs no second flag.
      container = namedExtension === '.webm' ? 'webm' : namedExtension === '.mp3' ? 'mp3' : 'mp4'
    }
    // MP3 carries no picture, so it implies the sound-only render; so does naming the file `.m4a`.
    const audioOnly =
      flags.has('audio-only') || namedExtension === '.m4a' || container === 'mp3'
    // A sound-only render is MP4's `.m4a` unless MP3 was asked for. A WebM container has no such
    // name, and writing one into a `.m4a` would be a file whose name lies about its bytes.
    if (audioOnly && container === 'webm') container = 'mp4'
    const extension = container === 'mp3' ? 'mp3' : audioOnly ? 'm4a' : container

    let outPath: string
    if (namedOut) {
      const resolved = resolveFilePath(namedOut, roots)
      if (!resolved.ok) return fail(resolved.error)
      outPath = resolved.path
    } else {
      outPath = join(
        reelsDir(projectDir),
        'exports',
        `${safeName(doc.name)}-${Date.now().toString(36)}.${extension}`,
      )
    }

    const job = host.start({
      sessionId: ctx.sessionId,
      document: exportDoc,
      name: doc.name,
      outPath,
      container,
      ...(audioOnly ? { audioOnly: true } : {}),
      pathOf: (src) => {
        const resolved = resolveFilePath(src, roots)
        return resolved.ok ? resolved.path : resolve(projectDir, src)
      },
      // Read the getter when the job settles, not now: the callbacks registry is live.
      onFinished: (finished) => {
        const notify = ctx.notifyBackgroundResult
        if (!notify) return
        notify(
          finished.status === 'completed'
            ? [
                `[clip-export-completed] The cut you exported ("${finished.name}") has finished rendering.`,
                `File: ${finished.outPath} (${finished.duration?.toFixed(1) ?? '?'}s of timeline, ${finished.container}).`,
                'Tell the user the film is ready and where it is. Do not call export again.',
              ].join('\n')
            : finished.status === 'cancelled'
              ? `[clip-export-cancelled] The export of "${finished.name}" was stopped, and no file was kept. Tell the user briefly.`
              : [
                  `[clip-export-failed] The export of "${finished.name}" did not finish: ${finished.message ?? 'no reason given'}.`,
                  'Tell the user briefly; the cut itself is untouched.',
                ].join('\n'),
        )
      },
    })

    const what = audioOnly
      ? `sound only, ${container === 'mp3' ? 'mp3' : 'm4a'}`
      : `${doc.settings.width}×${doc.settings.height}, ${container}`
    const span = range ? `, ${range.from.toFixed(2)}s–${range.to.toFixed(2)}s` : ''
    return text(
      `Rendering started: ${job.id} → ${job.outPath} (${what}${span}). It runs in the background — do not ` +
        `wait. Ask \`export --status ${job.id}\` for the result; the conversation is also woken when it lands.`,
    )
  }

  // Subtitles out: the same overlays the panel shows, as SRT another tool can take.
  if (verb === 'subtitles') {
    const cues = cuesFromOverlays(doc.overlays)
    if (cues.length === 0) {
      return text(
        'This cut has no subtitle overlays yet. Add them with add_subtitles (srt, path or cues), or import an .srt in the panel.',
      )
    }
    const requested = (flags.get('format') ?? '').trim().toLowerCase()
    if (requested && requested !== 'srt') {
      return fail('Subtitles are written as SRT; WebVTT is not produced. Drop --format, or pass srt.')
    }
    const out = (flags.get('out') ?? '').trim()
    if (out.toLowerCase().endsWith('.vtt')) {
      return fail('Subtitles are written as SRT — name the file .srt, or drop --out to print them.')
    }
    const body = formatSrt(cues)
    if (!out) return text(body)
    const resolved = resolveFilePath(out, roots)
    if (!resolved.ok) return fail(resolved.error)
    const target = resolved.path
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
    } catch (error) {
      return fail(`Could not write ${resolved.path}: ${(error as Error).message}`)
    }
    return text(`Wrote ${cues.length} cue(s) as SRT from ${path} to ${resolved.path}.`)
  }

  // The cut as FCPXML: the structure (timing, layers, sources) another editor can open.
  if (verb === 'fcpxml') {
    if (clipsOf(doc).length === 0) return text('This cut has no clips to export yet.')
    const xml = toFcpxml(doc, {
      fileFor: (src) => {
        const resolved = resolveFilePath(src, roots)
        return resolved.ok ? resolved.path : resolve(projectDir, src)
      },
    })
    const out = (flags.get('out') ?? '').trim()
    if (!out) return text(xml)
    const resolved = resolveFilePath(out, roots)
    if (!resolved.ok) return fail(resolved.error)
    const target = resolved.path
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, xml)
    } catch (error) {
      return fail(`Could not write ${resolved.path}: ${(error as Error).message}`)
    }
    return text(
      `Wrote ${path} as FCPXML to ${resolved.path}. Picture, timing and layers travel; transitions, overlays and grades stay in the .reel.`,
    )
  }

  // Every other verb returned above; `apply` is the only one left.
  const opsValue = flags.get('ops')
  if (!opsValue) {
    return text(
      'apply needs --ops <json|@file>, e.g. ' +
        `--ops '[{"op":"move_clip","id":"clip-1","start":0}]'.\n\n${HELP}`,
    )
  }
  let ops: Array<Record<string, unknown>>
  try {
    const raw = opsValue.startsWith('@')
      ? (() => {
          const resolved = resolveFilePath(opsValue.slice(1), roots)
          if (!resolved.ok) throw new Error(resolved.error)
          return readFileSync(resolved.path, 'utf8')
        })()
      : opsValue
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('--ops must be a non-empty JSON array')
    if (parsed.length > 50) throw new Error('a batch is at most 50 operations')
    ops = parsed as Array<Record<string, unknown>>
  } catch (error) {
    return fail(`Could not read --ops: ${(error as Error).message}`)
  }

  const stated = flags.has('expected-revision') ? Number(flags.get('expected-revision')) : doc.revision
  if (stated !== doc.revision) {
    return fail(`This cut is at revision ${doc.revision}, not ${stated}. Read it again, then retry.`)
  }

  // A batch may add clips without saying how long they are. The host reads that from the
  // container, so it is asked once for the whole batch — and only for the sources that need it.
  const probed = new Map<string, number>()
  const probeErrors = new Map<string, string>()
  const unresolved = [
    ...new Set(
      ops
        .filter((op) => op.op === 'add_clip' && !(Number(op.duration) > 0))
        .map((op) => (typeof op.src === 'string' ? op.src : ''))
        .filter((src) => src.length > 0),
    ),
  ]
  const probe = reelProbe()
  if (probe && unresolved.length) {
    const files: Array<{ path: string }> = []
    for (const src of unresolved) {
      const file = resolveFilePath(src, roots)
      if (file.ok) files.push({ path: file.path })
    }
    if (files.length) {
      const infos = await probe(files.map((entry) => entry.path))
      for (const info of infos) {
        if (info.duration && info.duration > 0) probed.set(info.path, info.duration)
        else if (info.message) probeErrors.set(info.path, info.message)
      }
    }
  }

  /**
   * How long the material itself is, when the host can say. `null` means "unknown", and an unknown
   * source is let through: refusing a trim because a host has no probe would be worse than showing
   * the held edge frame in a snapshot.
   */
  const unknownSources = new Set<string>()
  const sourceLength = async (src: string): Promise<number | null> => {
    if (STILL.test(src)) return null
    const file = resolveFilePath(src, roots)
    if (!file.ok) return null
    const known = probed.get(file.path)
    if (known !== undefined) return known
    if (unknownSources.has(file.path)) return null
    const host = reelProbe()
    if (!host) return null
    const [info] = await host([file.path])
    if (info?.duration && info.duration > 0) {
      probed.set(file.path, info.duration)
      return info.duration
    }
    unknownSources.add(file.path)
    return null
  }

  // Applied on a copy: a batch lands whole or not at all, like every other write in this app.
  let next = doc
  // A change the batch made on the caller's behalf (a clamped transition length, say). The write
  // stands; saying so here is what keeps the reply honest about what the file now holds.
  const notes: string[] = []
  try {
    for (const [index, op] of ops.entries()) {
      // A locked track refuses edits to its clips — the same rule the panel enforces. Changing
      // the track's own flags (`set_track`, `set_track_audio`, keyed by trackId) is still allowed,
      // so a track can always be unlocked.
      const targetId = typeof op.id === 'string' ? op.id : ''
      if (targetId) {
        const targetClip = findClip(next, targetId)
        const targetTrack = targetClip ? trackOfClip(next, targetClip.id) : undefined
        if (targetTrack?.locked) throw new Error(`track ${targetTrack.id} is locked (unlock it with set_track)`)
      }
      switch (op.op) {
        case 'add_track': {
          const kind = op.kind === 'audio' ? 'audio' : op.kind === 'video' ? 'video' : null
          if (!kind) throw new Error('add_track needs kind: "video" or "audio"')
          next = addTrack(next, kind)
          break
        }
        case 'add_clip': {
          const src = typeof op.src === 'string' ? op.src : ''
          if (!src) throw new Error('add_clip needs a src (project-relative, e.g. assets/a.mp4)')
          const file = resolveFilePath(src, roots)
          const inPoint = op.in === undefined ? 0 : Number(op.in)
          if (!Number.isFinite(inPoint) || inPoint < 0) throw new Error('add_clip.in must be >= 0')
          const startPoint = op.start === undefined ? undefined : Number(op.start)
          if (startPoint !== undefined && (!Number.isFinite(startPoint) || startPoint < 0)) {
            throw new Error('add_clip.start must be >= 0')
          }
          const stated = Number(op.duration)
          let duration: number | null = Number.isFinite(stated) && stated > 0 ? stated : null
          // The material's own length decides the window: an unstated duration is the rest of the
          // file after `in` (not the whole file), and a stated one may not ask for more than exists.
          const length = await sourceLength(src)
          if (duration === null) {
            if (length === null) {
              const why = file.ok ? probeErrors.get(file.path) : file.error
              throw new Error(
                why
                  ? `add_clip could not read how long ${src} is: ${why}`
                  : 'add_clip needs a duration in seconds — read it from the file before placing it',
              )
            }
            duration = length - inPoint
            if (duration < MIN_CLIP) {
              throw new Error(
                `add_clip.in ${inPoint.toFixed(2)}s is at or past the end of ${src} (${length.toFixed(2)}s)`,
              )
            }
          } else if (length !== null && inPoint + duration > length + SOURCE_SLACK) {
            throw new Error(
              `add_clip would run past the source: ${src} is ${length.toFixed(2)}s, but in ` +
                `${inPoint.toFixed(2)}s + ${duration.toFixed(2)}s needs ${(inPoint + duration).toFixed(2)}s`,
            )
          }
          const trackId = typeof op.trackId === 'string' ? op.trackId : undefined
          if (trackId && !next.tracks.some((track) => track.id === trackId)) {
            throw new Error(`no track ${trackId} in this cut`)
          }
          if (trackId && next.tracks.find((track) => track.id === trackId)?.locked) {
            throw new Error(`track ${trackId} is locked (unlock it with set_track)`)
          }
          next = addClip(next, {
            src,
            duration,
            in: inPoint,
            start: startPoint,
            ...(trackId ? { trackId } : {}),
            ...(Number.isFinite(Number(op.volume)) ? { volume: Number(op.volume) } : {}),
            ...(op.muted === true ? { muted: true } : {}),
            ...(Number.isFinite(Number(op.fadeIn)) ? { fadeIn: Number(op.fadeIn) } : {}),
            ...(Number.isFinite(Number(op.fadeOut)) ? { fadeOut: Number(op.fadeOut) } : {}),
          })
          break
        }
        case 'auto_edit': {
          const trackId = String(op.trackId ?? op.id ?? '')
          const track = next.tracks.find((candidate) => candidate.id === trackId)
          if (!track) throw new Error(`no track ${trackId} in this cut (state lists them)`)
          if (track.kind !== 'video') {
            throw new Error(`auto_edit fills a video track; ${trackId} is an audio track`)
          }
          if (track.locked) throw new Error(`track ${trackId} is locked (unlock it with set_track)`)

          const mode = op.mode === 'downbeats' || op.mode === 'segments' ? op.mode : 'beats'
          const start = Number(op.start ?? 0)
          if (!Number.isFinite(start) || start < 0) throw new Error('auto_edit.start must be >= 0')

          // Beats are data the caller already has (`beats --json`), so this op takes them as
          // numbers or as the {time,strength} objects that command prints — no second decode.
          const beatPoints: BeatPoint[] = []
          if (Array.isArray(op.beats)) {
            op.beats.forEach((entry, index) => {
              if (typeof entry === 'number' && Number.isFinite(entry)) {
                beatPoints.push({ time: entry, strength: 1, index })
                return
              }
              if (!entry || typeof entry !== 'object') return
              const value = entry as Record<string, unknown>
              const time = Number(value.time)
              if (!Number.isFinite(time)) return
              const strength = Number(value.strength)
              beatPoints.push({ time, strength: Number.isFinite(strength) ? strength : 1, index })
            })
          }
          const downbeats = Array.isArray(op.downbeats)
            ? op.downbeats.map(Number).filter((time) => Number.isFinite(time))
            : []
          if (mode === 'downbeats' ? downbeats.length < 2 : beatPoints.length < 2) {
            throw new Error(
              mode === 'downbeats'
                ? 'auto_edit mode "downbeats" needs downbeats[...] — `beats --clip <id> --json` has them'
                : 'auto_edit needs beats[...] (numbers or {time,strength}) — `beats --clip <id> --json` has them',
            )
          }

          const sensitivity = Number(op.sensitivity ?? 0.5)
          const beatsPerCut = Number(op.beatsPerCut ?? 4)
          const cutPoints = cutPointsFromBeats(
            {
              bpm: Number(op.bpm) || 0,
              confidence: 0,
              duration: 0,
              onsets: [],
              beats: beatPoints,
              downbeats,
            },
            {
              mode,
              sensitivity: Number.isFinite(sensitivity) ? sensitivity : 0.5,
              beatsPerCut: Number.isFinite(beatsPerCut) ? beatsPerCut : 4,
              start,
            },
          )

          const listed: unknown[] = Array.isArray(op.sources)
            ? op.sources
            : typeof op.src === 'string'
              ? [op.src]
              : []
          if (listed.length === 0) {
            throw new Error('auto_edit needs sources[...] (project-relative paths, or {src,duration})')
          }
          const sources: ArrangeSource[] = []
          for (const entry of listed) {
            if (typeof entry === 'string') {
              const src = entry.trim()
              if (!src) continue
              const file = resolveFilePath(src, roots)
              if (!file.ok) throw new Error(file.error)
              const length = await sourceLength(src)
              if (length === null || !(length > 0)) {
                throw new Error(
                  `auto_edit could not read how long ${src} is — pass {"src":"${src}","duration":<seconds>}`,
                )
              }
              sources.push({ src, duration: length })
              continue
            }
            if (entry && typeof entry === 'object') {
              const value = entry as Record<string, unknown>
              const src = typeof value.src === 'string' ? value.src.trim() : ''
              const duration = Number(value.duration)
              if (!src || !Number.isFinite(duration) || duration <= 0) continue
              const file = resolveFilePath(src, roots)
              if (!file.ok) throw new Error(file.error)
              sources.push({ src, duration })
            }
          }
          if (sources.length === 0) throw new Error('auto_edit needs at least one source with a duration')

          const minClip = Number(op.minClipDuration ?? 0.3)
          const maxClip = Number(op.maxClipDuration ?? 10)
          const total = op.totalDuration === undefined ? undefined : Number(op.totalDuration)
          const plan = arrangeOnCutPoints({
            cutPoints,
            sources,
            minClipDuration: minClip > 0 ? minClip : 0.3,
            maxClipDuration: maxClip > 0 ? maxClip : 10,
            start,
            ...(total !== undefined && Number.isFinite(total) ? { totalDuration: total } : {}),
            inPoint: op.inPoint === 'hold' ? 'hold' : 'walk',
          })
          if (plan.clips.length === 0) {
            throw new Error(
              'auto_edit produced no clips — the beats are closer together than minClipDuration, or the sources are too short',
            )
          }

          if (op.replace !== false) {
            next = {
              ...next,
              tracks: next.tracks.map((candidate) =>
                candidate.id === trackId ? { ...candidate, clips: [] } : candidate,
              ),
            }
          }
          for (const clip of plan.clips) {
            next = addClip(next, {
              src: clip.src,
              start: clip.start,
              in: clip.in,
              duration: clip.duration,
              trackId,
            })
          }
          const span = plan.clips.reduce(
            (furthest, clip) => Math.max(furthest, clip.start + clip.duration),
            0,
          )
          notes.push(
            `auto_edit placed ${plan.clips.length} clip(s) on ${trackId} over ${span.toFixed(2)}s` +
              (plan.skipped ? `, dropping ${plan.skipped} cut point(s) closer than ${minClip}s` : '') +
              (plan.shortened ? `, shortening ${plan.shortened} clip(s) to fit the source` : '') +
              '.',
          )
          break
        }
        case 'move_clip': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const start = Number(op.start)
          if (!Number.isFinite(start) || start < 0) throw new Error('move_clip needs a start >= 0')
          next = moveClip(next, id, start)
          break
        }
        case 'trim_clip': {
          const id = String(op.id ?? '')
          const clip = findClip(next, id)
          if (!clip) throw new Error(`no clip ${id} in this cut`)
          const edge = op.head !== undefined || op.tail !== undefined
          if (edge && (op.in !== undefined || op.duration !== undefined)) {
            throw new Error('trim_clip takes head/tail (timeline seconds) or in/duration, not both')
          }
          if (edge) {
            const head = Number(op.head ?? 0)
            const tail = Number(op.tail ?? 0)
            if (!Number.isFinite(head) || head < 0) throw new Error('trim_clip.head must be >= 0')
            if (!Number.isFinite(tail) || tail < 0) throw new Error('trim_clip.tail must be >= 0')
            if (head + tail >= clip.duration - MIN_CLIP) {
              throw new Error(
                `trim_clip would leave ${id} shorter than ${MIN_CLIP}s — trim less from head/tail`,
              )
            }
            next = trimEdges(next, id, { head, tail })
            break
          }
          const change: { in?: number; duration?: number } = {}
          if (op.in !== undefined) {
            const value = Number(op.in)
            if (!Number.isFinite(value) || value < 0) throw new Error('trim_clip.in must be >= 0')
            change.in = value
          }
          if (op.duration !== undefined) {
            const value = Number(op.duration)
            if (!Number.isFinite(value) || value <= 0) throw new Error('trim_clip.duration must be > 0')
            change.duration = value
          }
          if (change.in === undefined && change.duration === undefined) {
            throw new Error('trim_clip needs head/tail, in, or duration')
          }
          // A window is `in` plus `duration × speed` seconds of material; asking for more than the
          // file holds would preview as a held last frame and export as a missing sample.
          if (!clip.freeze) {
            const length = await sourceLength(clip.src)
            if (length !== null) {
              const windowIn = change.in ?? clip.in
              const windowDuration = change.duration ?? clip.duration
              const need = windowIn + windowDuration * clipSpeed(clip)
              if (need > length + SOURCE_SLACK) {
                throw new Error(
                  `trim_clip would run past the source: ${clip.src} is ${length.toFixed(2)}s, but ` +
                    `in ${windowIn.toFixed(2)}s + ${windowDuration.toFixed(2)}s × ${clipSpeed(clip)}x ` +
                    `needs ${need.toFixed(2)}s`,
                )
              }
            }
          }
          next = trimClip(next, id, change)
          break
        }
        case 'split_clip': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const at = Number(op.at)
          if (!Number.isFinite(at) || at < 0) throw new Error('split_clip needs an `at` in seconds')
          const before = clipsOf(next).length
          next = splitClip(next, id, at)
          if (clipsOf(next).length === before) {
            throw new Error(`split_clip at ${at}s is not inside clip ${id}`)
          }
          break
        }
        case 'remove_clip': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = removeClip(next, id)
          break
        }
        case 'cut_at': {
          if (!Array.isArray(op.times) || op.times.length === 0) {
            throw new Error('cut_at needs times[...] in seconds (e.g. a beat grid)')
          }
          const times = op.times.map(Number).filter((time) => Number.isFinite(time) && time >= 0)
          if (times.length === 0) throw new Error('cut_at needs at least one time >= 0')
          const before = clipsOf(next).length
          next = cutAt(next, times)
          if (clipsOf(next).length === before) {
            throw new Error('cut_at found no clip spanning those times')
          }
          break
        }
        case 'add_overlay': {
          const raw = op.overlay
          if (!raw || typeof raw !== 'object') {
            throw new Error('add_overlay needs an overlay object (kind text|media, start, duration; text or src)')
          }
          const input = raw as Record<string, unknown>
          const templateId = typeof input.template === 'string' ? input.template : ''
          const template = templateId ? textTemplateOf(templateId) : undefined
          if (templateId && !template) {
            throw new Error(`unknown text template ${templateId} (${TEXT_TEMPLATE_IDS.join(', ')})`)
          }
          const { template: _template, ...rest } = input
          // A template supplies the look; anything stated beside it wins, so a caller can start
          // from a catalog entry and change one number.
          const overlay = template
            ? {
                ...rest,
                kind: 'text',
                text: typeof rest.text === 'string' ? rest.text : template.sample,
                box: rest.box ?? template.box,
                preset: rest.preset ?? template.preset,
                style: {
                  ...template.style,
                  ...(rest.style && typeof rest.style === 'object'
                    ? (rest.style as Record<string, unknown>)
                    : {}),
                },
                ...(rest.animation === undefined && template.animation
                  ? { animation: template.animation }
                  : {}),
              }
            : rest
          next = appendOverlay(next, overlay)
          break
        }
        case 'add_subtitles': {
          let cues: SubtitleCue[] = []
          if (typeof op.srt === 'string') {
            cues = parseSrt(op.srt)
          } else if (typeof op.path === 'string' && op.path.trim()) {
            const resolved = resolveFilePath(op.path.trim(), roots)
            if (!resolved.ok) throw new Error(resolved.error)
            cues = parseSrt(readFileSync(resolved.path, 'utf8'))
          } else if (Array.isArray(op.cues)) {
            cues = normalizeCues(op.cues)
          }
          if (cues.length === 0) {
            throw new Error(
              'add_subtitles needs srt text, a path to an .srt file, or cues[{start,end,text}] — and found no cues',
            )
          }
          const style = op.style && typeof op.style === 'object' ? (op.style as TextStyle) : undefined
          for (const overlay of overlaysFromCues(cues, {
            ...(typeof op.preset === 'string' ? { preset: op.preset as TextPreset } : {}),
            ...(style ? { style } : {}),
            ...(typeof op.z === 'number' && Number.isFinite(op.z) ? { z: op.z } : {}),
          })) {
            next = appendOverlay(next, overlay)
          }
          break
        }
        case 'clear_subtitles': {
          const before = subtitleOverlaysOf(next).length
          if (before === 0) throw new Error('this cut has no subtitle overlays to clear')
          next = clearSubtitles(next, subtitleRange(op))
          if (subtitleOverlaysOf(next).length === before) {
            throw new Error('clear_subtitles found no subtitle starting inside that from/to range')
          }
          break
        }
        case 'shift_subtitles': {
          if (subtitleOverlaysOf(next).length === 0) {
            throw new Error('this cut has no subtitle overlays to shift')
          }
          const by = Number(op.by)
          if (!Number.isFinite(by)) throw new Error('shift_subtitles needs `by` in seconds')
          next = shiftSubtitles(next, by, subtitleRange(op))
          break
        }
        case 'replace_subtitle_text': {
          if (subtitleOverlaysOf(next).length === 0) {
            throw new Error('this cut has no subtitle overlays to edit')
          }
          const find = typeof op.find === 'string' ? op.find : ''
          if (!find) throw new Error('replace_subtitle_text needs a non-empty `find`')
          next = replaceSubtitleText(
            next,
            find,
            typeof op.replace === 'string' ? op.replace : '',
            {
              ...(op.matchCase === true ? { matchCase: true } : {}),
              ...(op.wholeWords === true ? { wholeWords: true } : {}),
            },
          )
          break
        }
        case 'dedupe_subtitles': {
          if (subtitleOverlaysOf(next).length === 0) {
            throw new Error('this cut has no subtitle overlays to dedupe')
          }
          const window = op.window === undefined ? 0.02 : Number(op.window)
          if (!Number.isFinite(window) || window < 0) {
            throw new Error('dedupe_subtitles.window must be >= 0')
          }
          next = dedupeSubtitles(next, window)
          break
        }
        case 'style_subtitles': {
          if (subtitleOverlaysOf(next).length === 0) {
            throw new Error('this cut has no subtitle overlays to style')
          }
          if (!op.style || typeof op.style !== 'object') {
            throw new Error('style_subtitles needs a style object')
          }
          if (op.preset !== undefined && !isTextPreset(op.preset)) {
            throw new Error(`style_subtitles.preset must be one of ${Object.keys(TEXT_PRESETS).join(', ')}`)
          }
          next = styleSubtitles(next, op.style as TextStyle, {
            ...(op.preset === undefined ? {} : { preset: op.preset }),
            range: subtitleRange(op),
          })
          break
        }
        case 'update_overlay': {
          const id = String(op.id ?? '')
          const existing = findOverlay(next, id)
          if (!existing) throw new Error(`no overlay ${id} in this cut`)
          const change = op.change
          if (!change || typeof change !== 'object') throw new Error('update_overlay needs a change object')
          const merged = normalizeOverlay(
            { ...existing, ...(change as Record<string, unknown>), id },
            next.overlays.indexOf(existing),
          )
          if (!merged) throw new Error('update_overlay produced an invalid overlay')
          next = updateOverlay(next, id, merged)
          break
        }
        case 'remove_overlay': {
          const id = String(op.id ?? '')
          if (!findOverlay(next, id)) throw new Error(`no overlay ${id} in this cut`)
          next = removeOverlay(next, id)
          break
        }
        case 'set_audio': {
          const id = String(op.id ?? '')
          const change: { volume?: number; muted?: boolean } = {}
          if (op.volume !== undefined) {
            const value = Number(op.volume)
            if (!Number.isFinite(value) || value < 0 || value > 1) {
              throw new Error('set_audio.volume must be between 0 and 1')
            }
            change.volume = value
          }
          if (typeof op.muted === 'boolean') change.muted = op.muted
          if (Object.keys(change).length === 0) throw new Error('set_audio needs volume (0..1) or muted')
          if (findClip(next, id)) {
            next = setClipAudio(next, id, change)
            break
          }
          const overlay = findOverlay(next, id)
          if (!overlay) throw new Error(`no clip or overlay ${id} in this cut`)
          if (overlay.kind !== 'media') throw new Error(`overlay ${id} has no sound`)
          next = updateOverlay(next, id, change)
          break
        }
        case 'detach_audio': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const after = detachAudio(next, id)
          if (after === next) {
            throw new Error(`clip ${id} is already a sound clip, or its sound is already on a sound track`)
          }
          next = after
          break
        }
        case 'set_fade': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const change: { fadeIn?: number; fadeOut?: number } = {}
          for (const key of ['fadeIn', 'fadeOut'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value) || value < 0) throw new Error(`set_fade.${key} must be >= 0`)
            change[key] = value
          }
          if (Object.keys(change).length === 0) throw new Error('set_fade needs fadeIn or fadeOut')
          next = setClipFade(next, id, change)
          break
        }
        case 'set_track_audio': {
          const trackId = String(op.trackId ?? '')
          if (!next.tracks.some((track) => track.id === trackId)) throw new Error(`no track ${trackId} in this cut`)
          const change: { muted?: boolean; solo?: boolean } = {}
          if (typeof op.muted === 'boolean') change.muted = op.muted
          if (typeof op.solo === 'boolean') change.solo = op.solo
          if (Object.keys(change).length === 0) throw new Error('set_track_audio needs muted or solo')
          next = setTrackAudio(next, trackId, change)
          break
        }
        case 'set_track': {
          const trackId = String(op.trackId ?? op.id ?? '')
          if (!next.tracks.some((track) => track.id === trackId)) throw new Error(`no track ${trackId} in this cut`)
          const change: {
            name?: string | null
            locked?: boolean
            hidden?: boolean
            muted?: boolean
            solo?: boolean
          } = {}
          if (op.name !== undefined) change.name = op.name === null ? null : String(op.name)
          for (const key of ['locked', 'hidden', 'muted', 'solo'] as const) {
            if (typeof op[key] === 'boolean') change[key] = op[key] as boolean
          }
          if (Object.keys(change).length === 0) {
            throw new Error('set_track needs a name, locked, hidden, muted or solo')
          }
          next = setTrack(next, trackId, change)
          break
        }
        case 'remove_track': {
          const trackId = String(op.trackId ?? op.id ?? '')
          const track = next.tracks.find((item) => item.id === trackId)
          if (!track) throw new Error(`no track ${trackId} in this cut`)
          if (track.kind === 'video' && next.tracks.filter((item) => item.kind === 'video').length === 1) {
            throw new Error(
              `track ${trackId} is this cut's only video track — add another video track before removing it`,
            )
          }
          next = removeTrack(next, trackId)
          break
        }
        case 'move_track': {
          const trackId = String(op.trackId ?? op.id ?? '')
          if (!next.tracks.some((track) => track.id === trackId)) throw new Error(`no track ${trackId} in this cut`)
          const index = Number(op.index)
          if (!Number.isFinite(index)) throw new Error('move_track needs an index (0-based, in the track stack)')
          next = moveTrack(next, trackId, index)
          break
        }
        case 'set_automation': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          if (!Array.isArray(op.points)) throw new Error('set_automation needs points[{time,value}]')
          const points: Array<{ time: number; value: number }> = []
          for (const entry of op.points) {
            if (!entry || typeof entry !== 'object') continue
            const value = entry as Record<string, unknown>
            const time = Number(value.time)
            const gain = Number(value.value)
            if (!Number.isFinite(time) || !Number.isFinite(gain) || time < 0) {
              throw new Error('set_automation points need time >= 0 and value between 0 and 1')
            }
            points.push({ time, value: gain })
          }
          next = setClipAutomation(next, id, points)
          break
        }
        case 'clear_ducking': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = clearClipDucking(next, id)
          break
        }
        case 'set_transform': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const change: Partial<ClipTransform> & { opacity?: number } = {}
          for (const key of ['x', 'y', 'scale', 'rotation', 'radius', 'opacity'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value)) throw new Error(`set_transform.${key} must be a number`)
            change[key] = value
          }
          if (op.flipX !== undefined) change.flipX = op.flipX === true
          if (Object.keys(change).length === 0) {
            throw new Error('set_transform needs x, y, scale, rotation, radius, opacity or flipX')
          }
          next = setClipTransform(next, id, change)
          break
        }
        case 'set_keyframes': {
          const id = String(op.id ?? '')
          const clip = findClip(next, id)
          if (!clip) throw new Error(`no clip ${id} in this cut`)
          const raw = Array.isArray(op.keyframes) ? op.keyframes : []
          if (raw.length === 0) {
            throw new Error('set_keyframes needs at least one keyframe; use clear_keyframes to remove them')
          }
          if (raw.length > 50) throw new Error('a clip takes at most 50 placement keyframes')
          const frames: TransformKeyframe[] = raw.map((entry, index) => {
            const value = (entry ?? {}) as Record<string, unknown>
            const time = Number(value.time)
            if (!Number.isFinite(time) || time < 0) {
              throw new Error(`keyframe ${index} needs a time in seconds >= 0`)
            }
            const transform: Partial<ClipTransform> = {}
            const transformValue =
              value.transform && typeof value.transform === 'object'
                ? (value.transform as Record<string, unknown>)
                : {}
            for (const key of ['x', 'y', 'scale', 'rotation', 'radius'] as const) {
              const field = transformValue[key]
              if (field === undefined) continue
              const parsed = Number(field)
              if (!Number.isFinite(parsed)) throw new Error(`keyframe ${index}.${key} must be a number`)
              transform[key] = parsed
            }
            const opacityValue = value.opacity
            if (opacityValue !== undefined && !Number.isFinite(Number(opacityValue))) {
              throw new Error(`keyframe ${index}.opacity must be a number between 0 and 1`)
            }
            const easing = value.easing
            if (easing !== undefined && !isKeyframeEasing(easing)) {
              throw new Error(
                `keyframe ${index}.easing must be linear, ease-in, ease-out or ease-in-out`,
              )
            }
            return {
              // Clamped to the clip by `setClipKeyframes`, which knows its duration.
              time,
              transform: { ...NEUTRAL_TRANSFORM, ...transform },
              ...(opacityValue === undefined ? {} : { opacity: Number(opacityValue) }),
              ...(isKeyframeEasing(easing) ? { easing } : {}),
            }
          })
          next = setClipKeyframes(next, id, frames)
          break
        }
        case 'clear_keyframes': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = setClipKeyframes(next, id, null)
          break
        }
        case 'set_crop': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          if (op.clear === true) {
            next = setClipCrop(next, id, null)
            break
          }
          const change: Partial<CropRect> = {}
          for (const key of ['x', 'y', 'w', 'h'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value)) throw new Error(`set_crop.${key} must be a number between 0 and 1`)
            change[key] = value
          }
          if (Object.keys(change).length === 0) {
            throw new Error('set_crop needs x, y, w, h or clear')
          }
          next = setClipCrop(next, id, change)
          break
        }
        case 'set_overlay_frame': {
          const id = String(op.id ?? '')
          if (!findOverlay(next, id)) throw new Error(`no overlay ${id} in this cut`)
          if (op.clear === true) {
            next = setOverlayFrame(next, id, null)
            break
          }
          const width = op.width === undefined ? 6 : Number(op.width)
          if (!Number.isFinite(width) || width < 0) {
            throw new Error('set_overlay_frame.width must be a number of pixels >= 0')
          }
          const radius = op.radius === undefined ? 0 : Number(op.radius)
          if (!Number.isFinite(radius) || radius < 0) {
            throw new Error('set_overlay_frame.radius must be a number >= 0')
          }
          const color = typeof op.color === 'string' && op.color.trim() ? op.color.trim() : '#ffffff'
          next = setOverlayFrame(next, id, { width, color, radius })
          break
        }
        case 'set_mask': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const shapeFlag = String(op.shape ?? 'rectangle')
          if (shapeFlag !== 'rectangle' && shapeFlag !== 'ellipse' && shapeFlag !== 'polygon') {
            throw new Error('set_mask.shape must be rectangle, ellipse or polygon')
          }
          const patch: {
            shape: MaskShape
            x?: number
            y?: number
            width?: number
            height?: number
            feather?: number
            expansion?: number
            inverted?: boolean
            opacity?: number
            points?: Array<{ x: number; y: number }>
            keyframes?: MaskKeyframe[]
          } = { shape: shapeFlag }
          for (const key of ['x', 'y', 'width', 'height'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value)) throw new Error(`set_mask.${key} must be a number (0..1)`)
            patch[key] = value
          }
          for (const key of ['feather', 'expansion'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value)) throw new Error(`set_mask.${key} must be a number of pixels`)
            patch[key] = value
          }
          if (op.opacity !== undefined) {
            const value = Number(op.opacity)
            if (!Number.isFinite(value)) throw new Error('set_mask.opacity must be 0..1')
            patch.opacity = value
          }
          if (op.inverted !== undefined) patch.inverted = op.inverted === true
          if (op.points !== undefined) {
            if (!Array.isArray(op.points)) throw new Error('set_mask.points must be an array')
            const points = op.points.flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return []
              const point = entry as Record<string, unknown>
              const x = Number(point.x)
              const y = Number(point.y)
              if (!Number.isFinite(x) || !Number.isFinite(y)) return []
              return [{ x, y }]
            })
            if (points.length < 3) {
              throw new Error('set_mask.points needs at least three {x,y} vertices in 0..1')
            }
            patch.points = points
          }
          if (op.keyframes !== undefined) {
            if (!Array.isArray(op.keyframes)) throw new Error('set_mask.keyframes must be an array')
            if (op.keyframes.length > 50) {
              throw new Error('a mask takes at most 50 keyframes')
            }
            patch.keyframes = op.keyframes.map((entry, index) => {
              const value = (entry ?? {}) as Record<string, unknown>
              const time = Number(value.time)
              if (!Number.isFinite(time) || time < 0) {
                throw new Error(`set_mask keyframe ${index} needs a time in seconds >= 0`)
              }
              const box: Partial<Record<'x' | 'y' | 'width' | 'height', number>> = {}
              for (const key of ['x', 'y', 'width', 'height'] as const) {
                const parsed = Number(value[key])
                if (!Number.isFinite(parsed)) {
                  throw new Error(`set_mask keyframe ${index}.${key} must be a number (0..1)`)
                }
                box[key] = parsed
              }
              const opacity = Number(value.opacity)
              if (value.opacity !== undefined && !Number.isFinite(opacity)) {
                throw new Error(`set_mask keyframe ${index}.opacity must be 0..1`)
              }
              const easing = value.easing
              if (easing !== undefined && !isKeyframeEasing(easing)) {
                throw new Error(
                  `set_mask keyframe ${index}.easing must be linear, ease-in, ease-out or ease-in-out`,
                )
              }
              return {
                // Times are clip-local and clamped to the clip by `setMask`.
                time,
                x: box.x!,
                y: box.y!,
                width: box.width!,
                height: box.height!,
                ...(value.opacity === undefined ? {} : { opacity }),
                ...(isKeyframeEasing(easing) ? { easing } : {}),
              }
            })
          }
          next = setMask(next, { clipId: id, ...patch })
          break
        }
        case 'clear_mask': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = clearMask(next, id)
          break
        }
        case 'freeze_frame': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          const at = Number(op.at)
          if (!Number.isFinite(at) || at < 0) {
            throw new Error('freeze_frame needs `at` — the timeline moment to hold, in seconds')
          }
          const duration = Number(op.duration)
          if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error('freeze_frame needs a duration > 0')
          }
          if (duration > 60) throw new Error('a freeze frame holds for at most 60 seconds')
          const ripple = op.ripple === undefined ? 'all' : String(op.ripple)
          if (ripple !== 'track' && ripple !== 'all') {
            throw new Error('freeze_frame.ripple must be "track" or "all"')
          }
          const held = insertFreezeFrame(next, id, at, duration, { ripple })
          if (!held) throw new Error(`nothing to hold at ${at}s in ${id} — the moment is on or outside its edges`)
          next = held
          break
        }
        case 'set_speed': {
          const id = String(op.id ?? '')
          const clip = findClip(next, id)
          if (!clip) throw new Error(`no clip ${id} in this cut`)
          // Speed is a property of moving material. A held frame or a still has no rate — its
          // length is what a caller actually wants to change.
          if (clip.freeze) {
            throw new Error(`${id} is a held frame — change its duration with trim_clip, not its speed`)
          }
          if (STILL.test(clip.src)) {
            throw new Error(`${id} is a still — change its duration with trim_clip, not its speed`)
          }
          const value = Number(op.speed)
          if (!Number.isFinite(value) || value <= 0) throw new Error('set_speed needs speed > 0')
          next = setClipSpeed(next, id, value, { ripple: op.ripple !== false })
          break
        }
        case 'set_effect': {
          const id = String(op.id ?? '')
          const clip = findClip(next, id)
          if (!clip) throw new Error(`no clip ${id} in this cut`)
          if (
            op.preset !== undefined &&
            (typeof op.preset !== 'string' || !(op.preset in EFFECT_PRESETS))
          ) {
            throw new Error(
              `unknown effect preset ${String(op.preset)} (${Object.keys(EFFECT_PRESETS).join(', ')})`,
            )
          }
          const named =
            typeof op.preset === 'string' && op.preset !== 'none'
              ? (op.preset as EffectPreset)
              : undefined
          // Only what the caller names is stored; a preset alone stays a preset, so its numbers
          // keep resolving fresh and the panel's sliders still show them.
          const effect: ClipEffect = {}
          for (const key of ['brightness', 'contrast', 'saturation', 'hue', 'blur'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value)) throw new Error(`set_effect.${key} must be a number`)
            effect[key] = value
          }
          const cleared = op.clear === true || op.preset === 'none'

          // Local blur/mosaic rectangles travel with the grade. Naming none keeps the ones the
          // clip already has; `regions` replaces the list, `clearRegions` drops it.
          if (Array.isArray(op.regions)) {
            const regions = op.regions.flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return []
              const region = entry as Record<string, unknown>
              if (region.mode !== undefined && region.mode !== 'blur' && region.mode !== 'mosaic') {
                throw new Error('set_effect.regions[].mode must be "blur" or "mosaic"')
              }
              const mode = region.mode === 'mosaic' ? ('mosaic' as const) : ('blur' as const)
              const x = Number(region.x ?? 0)
              const y = Number(region.y ?? 0)
              const w = Number(region.w ?? 0.3)
              const h = Number(region.h ?? 0.15)
              const strength = Number(region.strength ?? (mode === 'mosaic' ? 16 : 12))
              if (![x, y, w, h, strength].every((value) => Number.isFinite(value))) {
                throw new Error('set_effect.regions[] needs numeric x, y, w, h and strength')
              }
              return [{ x, y, w, h, mode, strength }]
            })
            if (regions.length > 0) effect.regions = regions
          } else if (op.clearRegions !== true && !cleared && clip.effect?.regions?.length) {
            effect.regions = clip.effect.regions
          }
          if (op.clearRegions === true) delete effect.regions

          // Removing only the regions is its own edit: keep the grade the clip already has.
          const namesGrade = ['brightness', 'contrast', 'saturation', 'hue', 'blur'].some(
            (key) => op[key] !== undefined,
          )
          if (
            op.clearRegions === true &&
            !cleared &&
            !namesGrade &&
            op.preset === undefined &&
            op.regions === undefined
          ) {
            const base: ClipEffect = { ...(clip.effect ?? {}) }
            delete base.regions
            next = setClipEffect(next, id, Object.keys(base).length > 0 ? base : null)
            break
          }

          if (named) effect.preset = named
          // Leaving the preset out means "keep the look's name"; `preset: "none"` drops it.
          else if (!cleared && op.preset === undefined && clip.effect?.preset) {
            effect.preset = clip.effect.preset
          }
          if (!cleared && Object.keys(effect).length === 0) {
            throw new Error(
              'set_effect needs a preset, a value (brightness/contrast/saturation/hue/blur), regions or clear',
            )
          }
          next = setClipEffect(next, id, Object.keys(effect).length > 0 ? effect : null)
          break
        }
        case 'set_audio_effect': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          if (op.clear === true) {
            next = setClipAudioEffect(next, id, null)
            break
          }
          const change: AudioEffect = {}
          if (op.highpass !== undefined) {
            const value = Number(op.highpass)
            if (!Number.isFinite(value)) throw new Error('set_audio_effect.highpass must be a number (Hz)')
            change.highpass = value
          }
          for (const key of ['bass', 'mid', 'treble'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value)) throw new Error(`set_audio_effect.${key} must be a number (dB)`)
            change[key] = value
          }
          if (typeof op.compress === 'boolean') change.compress = op.compress
          if (typeof op.normalize === 'boolean') change.normalize = op.normalize
          if (typeof op.denoise === 'boolean') change.denoise = op.denoise
          if (Object.keys(change).length === 0) {
            throw new Error(
              'set_audio_effect needs highpass, bass, mid, treble, compress, normalize, denoise or clear',
            )
          }
          next = setClipAudioEffect(next, id, change)
          break
        }
        case 'duplicate_clip': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = duplicateClip(next, id)
          break
        }
        case 'ripple_delete': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = rippleDelete(next, id)
          break
        }
        case 'close_gap': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = closeGap(next, id)
          break
        }
        case 'remove_gaps': {
          const trackId = typeof op.trackId === 'string' ? op.trackId : undefined
          if (trackId && !next.tracks.some((track) => track.id === trackId)) {
            throw new Error(`no track ${trackId} in this cut`)
          }
          next = removeGaps(next, trackId)
          break
        }
        case 'set_transition': {
          const id = String(op.id ?? '')
          const clip = findClip(next, id)
          if (!clip) throw new Error(`no clip ${id} in this cut`)
          const kind = String(op.kind ?? '')
          if (!(kind in TRANSITIONS)) {
            throw new Error(
              `unknown transition ${JSON.stringify(kind)} — pick one of ${Object.keys(TRANSITIONS).join(', ')}`,
            )
          }
          const wanted = Number(op.duration ?? 0.6)
          if (!Number.isFinite(wanted) || wanted <= 0) {
            throw new Error('set_transition.duration must be > 0 (seconds)')
          }
          const track = trackOfClip(next, id)
          // Adjacency is read on the frame grid: a batch is quantized after the loop, so a
          // neighbour that was written here may sit a hair off the exact cut.
          const before = track?.clips
            .filter((item) => item.id !== id && Math.abs(item.start + item.duration - clip.start) <= 0.001)
            .sort((left, right) => left.start - right.start)
            .at(-1)
          if (!before) {
            const ends = (track?.clips ?? [])
              .filter((item) => item.id !== id)
              .map((item) => (item.start + item.duration).toFixed(2))
              .join(', ')
            throw new Error(
              `clip ${id} starts at ${clip.start.toFixed(2)}s, but no adjacent clip on ${track?.id ?? 'its track'} ends there` +
                (ends
                  ? ` (existing ends: ${ends}s). A transition is centred on a cut, so move this clip onto one first.`
                  : '. Put a clip before it on the same track.'),
            )
          }
          // Centred on the cut, so it may not outrun either side.
          const limit = Math.min(clip.duration, before.duration)
          next = setTransition(next, id, {
            kind: kind as TransitionKind,
            duration: Math.min(wanted, limit),
          })
          const applied = findClip(next, id)?.transition?.duration
          if (applied !== undefined && Math.abs(applied - wanted) > 1e-6) {
            notes.push(
              `${id}: transition ${kind} is ${applied.toFixed(3)}s, not the requested ${wanted.toFixed(3)}s — ` +
                `it is centred on the cut and may not be longer than either neighbour (${before.duration.toFixed(2)}s before, ${clip.duration.toFixed(2)}s here).`,
            )
          }
          break
        }
        case 'clear_transition': {
          const id = String(op.id ?? '')
          if (!findClip(next, id)) throw new Error(`no clip ${id} in this cut`)
          next = clearTransition(next, id)
          break
        }
        case 'add_marker': {
          const time = Number(op.time)
          if (!Number.isFinite(time) || time < 0) {
            throw new Error('add_marker needs a time >= 0 (timeline seconds)')
          }
          next = addMarker(next, {
            time,
            ...(typeof op.name === 'string' ? { name: op.name } : {}),
          })
          break
        }
        case 'remove_marker': {
          const markerId = String(op.markerId ?? op.id ?? '')
          if (!markerId) throw new Error('remove_marker needs markerId')
          if (!markersOf(next).some((marker) => marker.id === markerId)) {
            throw new Error(`no marker ${markerId} in this cut (state lists them)`)
          }
          next = removeMarker(next, markerId)
          break
        }
        case 'rename': {
          const name = typeof op.name === 'string' ? op.name.trim() : ''
          if (!name) throw new Error('rename needs a name')
          next = renameDocument(next, name)
          break
        }
        case 'set_settings': {
          const change: Record<string, number> = {}
          for (const key of ['width', 'height', 'frameRate'] as const) {
            if (op[key] === undefined) continue
            const value = Number(op[key])
            if (!Number.isFinite(value) || value <= 0) throw new Error(`set_settings.${key} must be positive`)
            change[key] = value
          }
          if (Object.keys(change).length === 0) throw new Error('set_settings needs width, height or frameRate')
          next = resizeComposition(next, change, { rescale: op.rescale !== false })
          break
        }
        default:
          throw new Error(`unknown op ${String(op.op)} (index ${index})`)
      }
    }
  } catch (error) {
    return fail(`Nothing was written: ${(error as Error).message}`)
  }

  // A batch lands on the frame grid: every cut, cue and keyframe written here is frame accurate.
  next = quantizeDocument(next)

  const written: EditDocument = { ...next, revision: doc.revision + 1 }
  try {
    // Re-read right before writing. The panel writes the same file, and it may have landed a
    // revision between this call's read and this line — applying our batch over it would replace
    // their edit while claiming the revision we read. Refuse instead; the caller re-reads.
    const latest = readCut(path)
    if (latest.revision !== doc.revision) {
      return fail(
        `This cut moved to revision ${latest.revision} while the batch was being built (you read ${doc.revision}). Read it again, then retry.`,
      )
    }
    writeFileSync(path, JSON.stringify(written, null, 2))
  } catch (error) {
    return fail(`Could not write ${path}: ${(error as Error).message}`)
  }

  const label = flags.get('label')
  return text(
    `Applied ${ops.length} operation(s) to ${path} — now revision ${written.revision}, ${durationOf(written).toFixed(2)}s (${Math.round(durationOf(written) * written.settings.frameRate)}f at ${written.settings.frameRate}fps)${label ? ` (${label})` : ''}.\n` +
      (notes.length ? `${notes.map((note) => `Note: ${note}`).join('\n')}\n` : '') +
      'Timeline times are seconds on that frame grid; `state --json` has the exact values.\n' +
      'An open panel takes the new revision as one undo step; a panel that owes its own write asks before reloading.',
  )
}
