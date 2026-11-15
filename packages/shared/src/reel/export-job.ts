/**
 * A cut, flattened into what a renderer needs.
 *
 * The panel and the agent both hand a `.reel` to the exporter, and both must hand over the same
 * thing: one entry per clip with the source named **absolutely** (the hidden render page has no
 * project folder), gaps kept, and the track's own sound decision baked in — a muted track, or a
 * track that is neither soloed nor audible while something else is, is marked `muted`; its picture
 * still travels.
 *
 * Keeping this here is what stops the two doors from drifting: a change to how tracks are read is
 * one edit, and a frame the person exports is the frame the agent exports.
 */

import type {
  ClipTransform,
  CropRect,
  EditDocument,
  EditMask,
  TransformKeyframe,
  TransitionKind,
} from './document.ts'
import { masksForClip } from './document.ts'
import type { EditOverlay } from './overlay.ts'
import type { VolumePoint } from './ducking.ts'
import type { ClipEffect } from './effects.ts'
import type { AudioEffect } from './audio-effects.ts'
import { isStill } from './render-clips.ts'

export interface EditExportClip {
  /** Absolute path of the source media. */
  path: string
  /** Seconds into the source where this piece starts. */
  in: number
  /** Seconds of the source that are used. */
  duration: number
  /** Where the piece sits on the timeline. A gap stays a gap. */
  start: number
  /** What the source is. Images are held for the whole duration; audio is mixed, never drawn. */
  kind: 'video' | 'image' | 'audio'
  /** Higher tracks sit above lower ones when pictures overlap. */
  track: number
  /** 0..1; omitted means full. */
  volume?: number
  /** The clip's own sound is off — a detached audio clip carries it instead. */
  muted?: boolean
  /** Seconds of fade at each end of the clip's sound. */
  fadeIn?: number
  fadeOut?: number
  /** Volume keyframes inside the clip (ducking and hand-written automation). */
  automation?: VolumePoint[]
  /** Placement of the picture inside the composition. */
  transform?: ClipTransform
  /** 0..1; omitted means fully opaque. */
  opacity?: number
  /** Placement over time; when present it replaces `transform`/`opacity`. */
  keyframes?: TransformKeyframe[]
  /** A window onto the source, in fractions of its frame. */
  crop?: CropRect
  /** A held frame: the source time stays at `in`. */
  freeze?: true
  /** Colour grading (brightness/contrast/saturation/hue/blur). */
  effect?: ClipEffect
  /** Tone of the clip's own sound (EQ + compressor). */
  audioEffect?: AudioEffect
  /** Playback speed: picture and sound both run at this rate. */
  speed?: number
  /** The transition that brings this clip in from the clip immediately before it. */
  transition?: { kind: TransitionKind; duration: number }
  /** A hidden video track keeps its sound; no picture is drawn for it. */
  hidden?: boolean
  /** Shape masks over this clip, applied after its transform. */
  masks?: EditMask[]
}

export interface ReelExportPlan {
  clips: EditExportClip[]
  /** Words and picture-in-picture boxes painted above the tracks. */
  overlays: EditOverlay[]
  width: number
  height: number
  fps: number
}

/**
 * The whole cut, ready to encode. `pathOf` turns a project-relative source into the file on disk;
 * an overlay's picture-in-picture source goes through it too.
 */
export function exportPlanOf(
  doc: EditDocument,
  pathOf: (src: string) => string,
): ReelExportPlan {
  const soloed = doc.tracks.some((track) => track.solo)
  const clips: EditExportClip[] = doc.tracks.flatMap((track, trackIndex) => {
    const audible = !track.muted && (!soloed || track.solo === true)
    return track.clips.map((clip) => {
      const masks = masksForClip(doc, clip.id)
      return {
        path: pathOf(clip.src),
        in: clip.in,
        duration: clip.duration,
        start: clip.start,
        kind:
          track.kind === 'audio'
            ? ('audio' as const)
            : isStill(clip.src)
              ? ('image' as const)
              : ('video' as const),
        track: trackIndex,
        ...(clip.volume !== undefined ? { volume: clip.volume } : {}),
        ...(clip.muted || !audible ? { muted: true } : {}),
        ...(clip.fade?.fadeIn ? { fadeIn: clip.fade.fadeIn } : {}),
        ...(clip.fade?.fadeOut ? { fadeOut: clip.fade.fadeOut } : {}),
        ...(clip.automation?.length ? { automation: clip.automation } : {}),
        ...(clip.transform ? { transform: clip.transform } : {}),
        ...(clip.opacity !== undefined ? { opacity: clip.opacity } : {}),
        ...(clip.keyframes?.length ? { keyframes: clip.keyframes } : {}),
        ...(clip.crop ? { crop: clip.crop } : {}),
        ...(clip.freeze ? { freeze: true as const } : {}),
        ...(clip.effect ? { effect: clip.effect } : {}),
        ...(clip.audioEffect ? { audioEffect: clip.audioEffect } : {}),
        ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
        ...(clip.transition ? { transition: clip.transition } : {}),
        ...(track.hidden ? { hidden: true } : {}),
        ...(masks.length ? { masks } : {}),
      }
    })
  })

  return {
    clips,
    overlays: doc.overlays.map((overlay) =>
      overlay.src ? { ...overlay, src: pathOf(overlay.src) } : overlay,
    ),
    width: doc.settings.width,
    height: doc.settings.height,
    fps: doc.settings.frameRate,
  }
}
