/**
 * The document as the painter wants it.
 *
 * `canvas-compositor` draws clips and knows nothing about tracks; the document stores them in
 * tracks. This is the one place that says how the two line up — track order is the paint order,
 * and a track's own `hidden` flag travels with every clip on it. The preview and a snapshot both
 * read the mapping from here, so a frame the agent photographs cannot disagree with the player.
 */

import type { RenderClip } from './canvas-compositor.ts'
import { masksForClip, type EditDocument } from './document.ts'

const STILL = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/i

/** A still picture, as opposed to a clip with frames. */
export const isStill = (src: string): boolean => STILL.test(src)

export function renderClipsOf(doc: EditDocument): RenderClip[] {
  return doc.tracks.flatMap((track, trackIndex) =>
    track.clips.map((clip) => {
      const masks = masksForClip(doc, clip.id)
      return {
        path: clip.src,
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
        transform: clip.transform,
        opacity: clip.opacity,
        keyframes: clip.keyframes,
        crop: clip.crop,
        freeze: clip.freeze,
        effect: clip.effect,
        transition: clip.transition,
        speed: clip.speed,
        hidden: track.hidden,
        ...(masks.length ? { masks } : {}),
      }
    }),
  )
}
