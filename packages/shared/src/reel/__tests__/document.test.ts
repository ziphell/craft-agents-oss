import { describe, expect, test } from 'bun:test'
import {
  addClip,
  addOverlay,
  addTrack,
  arrivalStyle,
  audioClipsAt,
  clipGainAt,
  clipSourceTime,
  clipSpeed,
  clipVolume,
  clipsOf,
  clearClipDucking,
  closeGap,
  cutAt,
  detachAudio,
  duplicateClip,
  durationOf,
  emptyDocument,
  isLayeredTransition,
  isStaleRevision,
  nextRevision,
  clipVisualAt,
  insertFreezeFrame,
  setClipCrop,
  setClipKeyframes,
  setOverlayFrame,
  moveTrack,
  normalizeDocument,
  normalizeFrameRate,
  NEUTRAL_TRANSFORM,
  quantizeDocument,
  resizeComposition,
  removeGaps,
  removeOverlay,
  removeTrack,
  addMarker,
  clearMask,
  markersOf,
  maskAt,
  masksForClip,
  removeClip,
  removeMarker,
  setMask,
  sliceDocument,
  rippleDelete,
  setClipAudio,
  setClipAudioEffect,
  setClipAutomation,
  setClipDucking,
  setClipEffect,
  setClipFade,
  setClipSpeed,
  setClipTransform,
  setSettings,
  setTrack,
  setTrackAudio,
  setTransition,
  splitClip,
  trackAudible,
  transitionAt,
  trimEdges,
  updateOverlay,
  videoClipAt,
} from '../document.ts'
import { ownerAt } from '../canvas-compositor.ts'
import { renderClipsOf } from '../render-clips.ts'
import {
  normalizeOverlay,
  overlaysAt,
  resolveOverlayBox,
  resolveOverlayVolume,
  resolveTextStyle,
  textAnimationAt,
} from '../overlay.ts'
import {
  effectFilter,
  isNeutralEffect,
  normalizeEffect,
  resolveEffect,
} from '../effects.ts'
import { maskBoundsPx, maskPolygonPx } from '../masks.ts'
import type { EditMask } from '../document.ts'

const withClip = (
  doc: ReturnType<typeof emptyDocument>,
  trackId: string,
  start: number,
  duration: number,
) => {
  const placed = addClip(doc, { src: 'assets/a.mp4', duration, start, trackId })
  const track = placed.tracks.find((candidate) => candidate.id === trackId)!
  return { doc: placed, clip: track.clips[track.clips.length - 1]! }
}

describe('a cut with more than one track', () => {
  test('a new track gets an id no other track uses', () => {
    const doc = addTrack(addTrack(emptyDocument('cut'), 'audio'), 'audio')
    expect(doc.tracks.map((track) => track.id)).toEqual(['video-1', 'audio-1', 'audio-2'])
  })

  test('the later video track is what the viewer sees when pictures overlap', () => {
    const base = addTrack(emptyDocument('cut'), 'video')
    const first = withClip(base, 'video-1', 0, 6)
    const second = addClip(first.doc, {
      src: 'assets/b.mp4',
      duration: 4,
      start: 1,
      trackId: 'video-2',
    })

    expect(videoClipAt(second, 0.5)?.clip.src).toBe('assets/a.mp4')
    // Both are under the playhead here; the higher track wins.
    expect(videoClipAt(second, 2)?.track.id).toBe('video-2')
    expect(videoClipAt(second, 5.5)?.clip.src).toBe('assets/a.mp4')
    expect(videoClipAt(second, 9)).toBeNull()
  })

  test('every sound track under the playhead is sounding, and none of them is the picture', () => {
    let doc = addTrack(addTrack(emptyDocument('cut'), 'audio'), 'audio')
    doc = withClip(doc, 'audio-1', 0, 6).doc
    doc = withClip(doc, 'audio-2', 2, 6).doc

    expect(audioClipsAt(doc, 1).map(({ track }) => track.id)).toEqual(['audio-1'])
    expect(audioClipsAt(doc, 3).map(({ track }) => track.id)).toEqual(['audio-1', 'audio-2'])
    expect(audioClipsAt(doc, 8)).toEqual([])
    // A sound-only clip never becomes the picture.
    expect(videoClipAt(doc, 3)).toBeNull()
  })

  test('the cut lasts as long as its furthest clip, gaps included', () => {
    let doc = emptyDocument('cut')
    doc = withClip(doc, 'video-1', 0, 2).doc
    doc = withClip(doc, 'video-1', 10, 2).doc
    expect(durationOf(doc)).toBe(12)
  })
})

describe('colour grading — the 效果 tab', () => {
  test('a preset resolves to numbers, and explicit values pin the look', () => {
    const cinema = resolveEffect({ preset: 'cinema' })
    expect(cinema.contrast).toBeCloseTo(1.14)
    expect(resolveEffect({ preset: 'cinema', brightness: 1.2 }).brightness).toBe(1.2)
    expect(isNeutralEffect(resolveEffect())).toBe(true)
    expect(isNeutralEffect(cinema)).toBe(false)
  })

  test('the filter string is one expression both renderers can use', () => {
    expect(effectFilter(resolveEffect())).toBe('none')
    expect(
      effectFilter({ brightness: 1.2, contrast: 1, saturation: 0, hue: 0, blur: 2 }),
    ).toBe('brightness(1.2) saturate(0) blur(2px)')
  })

  test('a hand-written grade drops neutral values, and an empty one is no grade', () => {
    expect(normalizeEffect({ brightness: 1, contrast: 1.5, preset: 'nope' })).toEqual({
      contrast: 1.5,
    })
    expect(normalizeEffect({ brightness: 1 })).toBeUndefined()
    expect(normalizeEffect({ preset: 'none' })).toBeUndefined()
  })

  test('setting a grade replaces it, and null clears it', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const graded = setClipEffect(doc, clip.id, { preset: 'mono' })
    expect(graded.tracks[0]!.clips[0]!.effect).toEqual({ preset: 'mono' })

    const pinned = setClipEffect(graded, clip.id, {
      ...resolveEffect(graded.tracks[0]!.clips[0]!.effect),
      brightness: 1.1,
      preset: 'mono',
    })
    expect(pinned.tracks[0]!.clips[0]!.effect?.brightness).toBeCloseTo(1.1)
    expect(pinned.tracks[0]!.clips[0]!.effect?.preset).toBe('mono')

    const cleared = setClipEffect(pinned, clip.id, null)
    expect(cleared.tracks[0]!.clips[0]!.effect).toBeUndefined()
  })
})

describe('audio tone — the lower half of the effects tab', () => {
  test('a tone merges into what the clip already has, and neutral values vanish', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const toned = setClipAudioEffect(doc, clip.id, { highpass: 120, compress: true })
    expect(toned.tracks[0]!.clips[0]!.audioEffect).toEqual({ highpass: 120, compress: true })

    const tweaked = setClipAudioEffect(toned, clip.id, { bass: 3 })
    expect(tweaked.tracks[0]!.clips[0]!.audioEffect).toEqual({
      highpass: 120,
      compress: true,
      bass: 3,
    })

    // Turning the compressor off and the cut back to zero leaves only the bass.
    const quieter = setClipAudioEffect(tweaked, clip.id, { compress: false, highpass: 0 })
    expect(quieter.tracks[0]!.clips[0]!.audioEffect).toEqual({ bass: 3 })

    const cleared = setClipAudioEffect(quieter, clip.id, { bass: 0 })
    expect(cleared.tracks[0]!.clips[0]!.audioEffect).toBeUndefined()
  })

  test('a hand-written tone survives a reload', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              {
                id: 'c1',
                src: 'assets/a.mp4',
                start: 0,
                in: 0,
                duration: 2,
                audioEffect: { highpass: 5000, bass: -20, compress: true, nonsense: 1 },
              },
            ],
          },
        ],
      },
      'cut',
    )
    expect(doc.tracks[0]!.clips[0]!.audioEffect).toEqual({
      highpass: 500,
      bass: -12,
      compress: true,
    })
  })
})

describe('speed — one number the preview and the file share', () => {
  test('changing speed keeps the source window and scales the timeline', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const faster = setClipSpeed(doc, clip.id, 2)
    const piece = faster.tracks[0]!.clips[0]!
    expect(piece.speed).toBe(2)
    expect(piece.duration).toBe(2)
    // The source window is unchanged: a faster clip covers the same material in less time.
    expect(piece.in + piece.duration * clipSpeed(piece)).toBeCloseTo(4)

    const back = setClipSpeed(faster, clip.id, 1)
    expect(back.tracks[0]!.clips[0]!.duration).toBeCloseTo(4)
    expect(back.tracks[0]!.clips[0]!.speed).toBeUndefined()
  })

  test('a speed change ripples its own track and leaves other lanes alone', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const withNext = addClip(doc, { src: 'assets/b.mp4', duration: 2 })
    const withSound = addClip(addTrack(withNext, 'audio'), {
      src: 'assets/music.mp3',
      duration: 4,
      trackId: 'audio-1',
    })
    const fast = setClipSpeed(withSound, clip.id, 2)
    expect(fast.tracks[0]!.clips[0]!.duration).toBe(2)
    // The next picture pulls left so the packed cut stays packed.
    expect(fast.tracks[0]!.clips[1]!.start).toBe(2)
    // The sound lane is a different track: untouched.
    expect(fast.tracks[1]!.clips[0]!.start).toBe(0)
  })

  test('ripple: false rescales the clip alone', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const withNext = addClip(doc, { src: 'assets/b.mp4', duration: 2 })
    const fast = setClipSpeed(withNext, clip.id, 2, { ripple: false })
    expect(fast.tracks[0]!.clips[0]!.duration).toBe(2)
    expect(fast.tracks[0]!.clips[1]!.start).toBe(4)
  })

  test('overlapping clips: the later start owns the moment, in the document and in paint', () => {
    const doc = addClip(
      addClip(emptyDocument('cut'), { src: 'assets/a.mp4', duration: 4 }),
      { src: 'assets/b.mp4', duration: 4, start: 2 },
    )
    expect(videoClipAt(doc, 1)?.clip.src).toBe('assets/a.mp4')
    expect(videoClipAt(doc, 3)?.clip.src).toBe('assets/b.mp4')
    expect(ownerAt(renderClipsOf(doc), 3)?.path).toBe('assets/b.mp4')
  })

  test('clipSourceTime walks the source at the clip speed', () => {
    const clip = {
      ...withClip(emptyDocument('cut'), 'video-1', 0, 4).clip,
      in: 10,
      duration: 4,
      speed: 2,
    }
    expect(clipSourceTime(clip, 0)).toBe(10)
    expect(clipSourceTime(clip, 1)).toBe(12)
    expect(clipSourceTime(clip, 4)).toBeCloseTo(17.999)
  })

  test('a split keeps each half on its own source frames, at speed', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const fast = setClipSpeed(doc, clip.id, 2) // duration 2, source 0..4
    const cut = splitClip(fast, clip.id, 1)
    const [head, tail] = cut.tracks[0]!.clips
    expect(head!.duration).toBe(1)
    expect(head!.in + head!.duration * 2).toBeCloseTo(tail!.in)
    expect(tail!.in).toBeCloseTo(2)
  })

  test('speed survives a reload', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              { id: 'c1', src: 'assets/a.mp4', start: 0, in: 2, duration: 3, speed: 4 },
            ],
          },
        ],
      },
      'cut',
    )
    expect(doc.tracks[0]!.clips[0]!.speed).toBe(4)
  })
})

describe('a composition frame rate', () => {
  test('is clamped to a rate the exporter and FCPXML can honour', () => {
    expect(normalizeFrameRate(0)).toBe(30)
    expect(normalizeFrameRate(-5)).toBe(30)
    expect(normalizeFrameRate(100000)).toBe(240)
    expect(normalizeFrameRate(29.97)).toBe(29.97)
  })

  test('is clamped on load and on a settings write', () => {
    const doc = normalizeDocument({ settings: { frameRate: 100000 } }, 'cut')
    expect(doc.settings.frameRate).toBe(240)
    expect(setSettings(doc, { frameRate: 0.1 }).settings.frameRate).toBe(1)
  })
})

describe('resizing the composition', () => {
  test('scales pixel-measured looks by the height ratio and keeps normalized ones', () => {
    let doc = emptyDocument('cut')
    doc = addOverlay(doc, {
      kind: 'text',
      text: '字',
      start: 0,
      duration: 2,
      style: { fontSize: 46, strokeWidth: 2, shadowBlur: 8 },
    })
    doc = addOverlay(doc, {
      kind: 'media',
      src: 'assets/face.mp4',
      start: 0,
      duration: 2,
      frame: { width: 6, color: '#ffffff' },
    })

    const resized = resizeComposition(doc, { width: 1080, height: 1920 })
    expect(resized.settings).toEqual({ width: 1080, height: 1920, frameRate: 30 })
    // 1920 / 1080 = 1.777…, applied to every composition-pixel measure.
    expect(resized.overlays[0]!.style!.fontSize).toBeCloseTo(81.8)
    expect(resized.overlays[0]!.style!.strokeWidth).toBeCloseTo(3.6)
    expect(resized.overlays[0]!.style!.shadowBlur).toBeCloseTo(14.2)
    expect(resized.overlays[1]!.frame!.width).toBeCloseTo(10.7)
    // Boxes are fractions of the frame, so they need no rewrite.
    expect(resized.overlays[1]!.box).toBeUndefined()
  })

  test('rescale: false changes the canvas alone', () => {
    const doc = addOverlay(emptyDocument('cut'), {
      kind: 'text',
      text: '字',
      start: 0,
      duration: 2,
      style: { fontSize: 46 },
    })
    const resized = resizeComposition(doc, { width: 1080, height: 1920 }, { rescale: false })
    expect(resized.settings.width).toBe(1080)
    expect(resized.overlays[0]!.style!.fontSize).toBe(46)
  })
})

describe('frame grid', () => {
  test('snaps cuts, cues, keyframes and durations, and is idempotent', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 1.13, start: 0.17, in: 0.11 })
    doc = addOverlay(doc, { kind: 'text', text: '字', start: 0.17, duration: 1.13 })
    doc = setClipKeyframes(doc, doc.tracks[0]!.clips[0]!.id, [
      { time: 0.17, transform: { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 } },
      { time: 1.1, transform: { x: 1, y: 0, scale: 1, rotation: 0, radius: 0 } },
    ])

    const snapped = quantizeDocument(doc)
    const clip = snapped.tracks[0]!.clips[0]!
    expect(clip.start).toBeCloseTo(5 / 30)
    // Source time is that file's own timebase, not the project grid.
    expect(clip.in).toBeCloseTo(0.11)
    expect(clip.duration).toBeCloseTo(34 / 30)
    expect(snapped.overlays[0]!.start).toBeCloseTo(5 / 30)
    expect(snapped.overlays[0]!.duration).toBeCloseTo(34 / 30)
    expect(clip.keyframes![0]!.time).toBeCloseTo(5 / 30)
    expect(clip.keyframes![1]!.time).toBeCloseTo(33 / 30)
    expect(quantizeDocument(snapped)).toEqual(snapped)
  })

  test('the grid follows the project frame rate, and a duration keeps at least one frame', () => {
    const doc = addClip(emptyDocument('cut'), { src: 'assets/a.mp4', duration: 0.05, start: 0.11 })
    expect(quantizeDocument(doc).tracks[0]!.clips[0]!.start).toBeCloseTo(3 / 30)
    expect(quantizeDocument(doc).tracks[0]!.clips[0]!.duration).toBeCloseTo(2 / 30)
    const at24 = quantizeDocument(setSettings(doc, { frameRate: 24 }))
    expect(at24.tracks[0]!.clips[0]!.start).toBeCloseTo(3 / 24)
  })
})

describe('trimming edges — timeline seconds, speed-aware', () => {
  test('head moves the start and leaves the rest of the piece where it was', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 2, 4)
    const piece = trimEdges(doc, clip.id, { head: 1.5 }).tracks[0]!.clips[0]!
    expect(piece.start).toBeCloseTo(3.5)
    expect(piece.in).toBeCloseTo(1.5)
    expect(piece.duration).toBeCloseTo(2.5)
    // The tail keeps its timeline moment — that is what "trim the front" means.
    expect(piece.start + piece.duration).toBeCloseTo(6)
  })

  test('head advances the source window by head × speed', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const fast = setClipSpeed(doc, clip.id, 2) // duration 2, source 0..4
    const piece = trimEdges(fast, clip.id, { head: 0.5 }).tracks[0]!.clips[0]!
    expect(piece.start).toBeCloseTo(0.5)
    expect(piece.in).toBeCloseTo(1)
    expect(piece.duration).toBeCloseTo(1.5)
  })

  test('a held frame keeps its source moment', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const frozen = insertFreezeFrame(doc, clip.id, 1, 2)!
    const hold = frozen.tracks[0]!.clips.find((piece) => piece.freeze)!
    const trimmed = trimEdges(frozen, hold.id, { head: 0.5 }).tracks[0]!.clips.find(
      (piece) => piece.id === hold.id,
    )!
    expect(trimmed.in).toBe(hold.in)
    expect(trimmed.start).toBeCloseTo(hold.start + 0.5)
    expect(trimmed.duration).toBeCloseTo(hold.duration - 0.5)
  })

  test('head and tail together never leave less than MIN_CLIP', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const piece = trimEdges(doc, clip.id, { head: 3, tail: 3 }).tracks[0]!.clips[0]!
    // The tail gives way first, so the piece stops at the 0.05s floor.
    expect(piece.duration).toBeCloseTo(0.05)
    expect(piece.start).toBeCloseTo(3)
  })
})

describe('cutting on a grid', () => {
  test('cutAt cuts every track at those moments, once each', () => {
    let doc = withClip(emptyDocument('cut'), 'video-1', 0, 10).doc
    doc = addTrack(doc, 'audio')
    doc = withClip(doc, 'audio-1', 0, 10).doc

    const cut = cutAt(doc, [2.5, 5, 5, 7.5, 0, 10])
    expect(cut.tracks[0]!.clips.map((clip) => clip.start)).toEqual([0, 2.5, 5, 7.5])
    expect(cut.tracks[0]!.clips.map((clip) => clip.duration)).toEqual([2.5, 2.5, 2.5, 2.5])
    expect(cut.tracks[1]!.clips.map((clip) => clip.start)).toEqual([0, 2.5, 5, 7.5])
  })

  test('a split keeps sound settings, and keeps fades and the transition on their own edges', () => {
    let doc = withClip(emptyDocument('cut'), 'video-1', 0, 4).doc
    doc = withClip(doc, 'video-1', 4, 4).doc
    const second = doc.tracks[0]!.clips[1]!
    doc = setTransition(doc, second.id, { kind: 'crossfade', duration: 1 })
    doc = setClipAudio(doc, second.id, { volume: 0.4 })
    doc = setClipFade(doc, second.id, { fadeIn: 0.5, fadeOut: 1 })
    doc = setClipAutomation(doc, second.id, [
      { time: 0, value: 1 },
      { time: 4, value: 0.2 },
    ])

    const cut = cutAt(doc, [6])
    const [head, tail] = cut.tracks[0]!.clips.slice(1)
    expect(head!.duration).toBe(2)
    expect(tail!.start).toBe(6)
    expect(tail!.in).toBe(2)
    expect(head!.volume).toBe(0.4)
    expect(tail!.volume).toBe(0.4)
    // A cut in the middle of a shot must not invent a fade.
    expect(head!.fade).toEqual({ fadeIn: 0.5, fadeOut: 0 })
    expect(tail!.fade).toEqual({ fadeIn: 0, fadeOut: 1 })
    // The incoming transition belongs to the head; the tail joins the same shot.
    expect(head!.transition?.kind).toBe('crossfade')
    expect(tail!.transition).toBeUndefined()
    // Automation is continuous across the cut.
    expect(head!.automation?.at(-1)?.time).toBe(2)
    expect(tail!.automation?.[0]?.time).toBe(0)
    expect(tail!.automation?.[0]?.value).toBeCloseTo(head!.automation?.at(-1)?.value ?? -1)
    expect(tail!.automation?.[0]?.value).toBeCloseTo(0.6)
  })
})

describe('tracks: name, lock, hide and order', () => {
  test('a hidden video track keeps its clips but stops being the picture', () => {
    let doc = addTrack(emptyDocument('cut'), 'video')
    doc = withClip(doc, 'video-1', 0, 4).doc
    doc = withClip(doc, 'video-2', 0, 4).doc
    expect(videoClipAt(doc, 1)?.track.id).toBe('video-2')

    const hidden = setTrack(doc, 'video-2', { hidden: true })
    expect(videoClipAt(hidden, 1)?.track.id).toBe('video-1')
    // Hiding is about the picture: the clips are still there, so their sound is still mixed.
    expect(clipsOf(hidden)).toHaveLength(2)
  })

  test('a track can be renamed, cleared, locked and reordered', () => {
    let doc = addTrack(emptyDocument('cut'), 'video')
    doc = setTrack(doc, 'video-1', { name: ' 主画面 ', locked: true })
    expect(doc.tracks[0]!.name).toBe('主画面')
    expect(doc.tracks[0]!.locked).toBe(true)

    // Video tracks paint in document order, so raising the second one puts it on top.
    const reordered = moveTrack(doc, 'video-2', 0)
    expect(reordered.tracks.map((track) => track.id)).toEqual(['video-2', 'video-1'])

    const cleared = setTrack(reordered, 'video-1', { name: null, locked: false })
    expect(cleared.tracks[1]!.name).toBeUndefined()
    expect(cleared.tracks[1]!.locked).toBeUndefined()
  })

  test('a track can be removed with its clips, and a later add reuses the free id', () => {
    let doc = addTrack(emptyDocument('cut'), 'video')
    doc = withClip(doc, 'video-1', 0, 4).doc
    doc = withClip(doc, 'video-2', 0, 4).doc

    const removed = removeTrack(doc, 'video-2')
    expect(removed.tracks.map((track) => track.id)).toEqual(['video-1'])
    expect(clipsOf(removed)).toHaveLength(1)
    expect(addTrack(removed, 'video').tracks.map((track) => track.id)).toEqual([
      'video-1',
      'video-2',
    ])
  })

  test('a hand-written track keeps its flags through a reload', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          { id: 'video-1', kind: 'video', clips: [], name: 'A-cam', locked: true, hidden: true },
        ],
      },
      'cut',
    )
    expect(doc.tracks[0]!.name).toBe('A-cam')
    expect(doc.tracks[0]!.locked).toBe(true)
    expect(doc.tracks[0]!.hidden).toBe(true)
  })
})

describe('overlays: subtitles, 花字 and picture-in-picture', () => {
  test('a subtitle uses its preset box and look until the overlay overrides them', () => {
    const overlay = normalizeOverlay(
      { kind: 'text', text: '你好', start: 0, duration: 2, preset: 'subtitle' },
      0,
    )!
    expect(resolveOverlayBox(overlay)).toEqual({ x: 0.08, y: 0.78, w: 0.84, h: 0.16 })
    const style = resolveTextStyle(overlay)
    expect(style.fontSize).toBe(46)
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0.45)')

    const tweaked = normalizeOverlay(
      { ...overlay, style: { fontSize: 60, color: '#ffe066' } },
      0,
    )!
    expect(resolveTextStyle(tweaked).fontSize).toBe(60)
    expect(resolveTextStyle(tweaked).color).toBe('#ffe066')
    // The preset still supplies what the override did not name.
    expect(resolveTextStyle(tweaked).align).toBe('center')
  })

  test('a text animation arrives and leaves on one formula', () => {
    const overlay = normalizeOverlay(
      {
        kind: 'text',
        text: 'abcdef',
        start: 1,
        duration: 2,
        animation: { preset: 'typewriter', inDuration: 1, outDuration: 0.5 },
      },
      0,
    )!
    expect(overlay.animation).toEqual({ preset: 'typewriter', inDuration: 1, outDuration: 0.5 })

    // Nothing typed yet, part of the text while typing, all of it once the hold begins.
    expect(textAnimationAt(overlay, 0).visible).toBe(0)
    expect(textAnimationAt(overlay, 0.5).visible).toBeGreaterThan(0)
    expect(textAnimationAt(overlay, 1).visible).toBe(6)
    // It fades out over the last half second.
    expect(textAnimationAt(overlay, 1.9).opacity).toBeLessThan(0.2)
    expect(textAnimationAt(overlay, 2).opacity).toBe(0)
  })

  test('slide and scale presets start offset, and settle by the time the window holds', () => {
    const slide = normalizeOverlay(
      { kind: 'text', text: 'x', start: 0, duration: 2, animation: { preset: 'slide-left' } },
      0,
    )!
    expect(textAnimationAt(slide, 0).offsetX).toBeCloseTo(-0.2)
    expect(textAnimationAt(slide, 1).offsetX).toBeCloseTo(0)

    const scale = normalizeOverlay(
      { kind: 'text', text: 'x', start: 0, duration: 2, animation: { preset: 'scale' } },
      0,
    )!
    expect(textAnimationAt(scale, 0).scale).toBeCloseTo(0.6)
    expect(textAnimationAt(scale, 1).scale).toBeCloseTo(1)
  })

  test('an unknown animation preset is dropped, not fatal', () => {
    const overlay = normalizeOverlay(
      { kind: 'text', text: 'x', start: 0, duration: 1, animation: { preset: 'wobble' } },
      0,
    )!
    expect(overlay.animation).toBeUndefined()
    expect(textAnimationAt(overlay, 0.2)).toEqual({
      opacity: 1,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      visible: 1,
    })
  })

  test('a media overlay is a picture-in-picture box and needs a source', () => {
    expect(normalizeOverlay({ kind: 'media', start: 0, duration: 2 }, 0)).toBeNull()
    const pip = normalizeOverlay(
      { kind: 'media', src: 'assets/face.mp4', start: 1, duration: 3, box: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } },
      1,
    )!
    expect(pip.kind).toBe('media')
    expect(pip.id).toBe('ov-2')
    expect(resolveOverlayBox(pip)).toEqual({ x: 0.7, y: 0.1, w: 0.2, h: 0.2 })
  })

  test('overlays mix in paint order under a moment', () => {
    const overlays = [
      normalizeOverlay({ kind: 'text', text: 'under', start: 0, duration: 5, z: 0 }, 0)!,
      normalizeOverlay({ kind: 'text', text: 'over', start: 1, duration: 2, z: 5 }, 1)!,
      normalizeOverlay({ kind: 'text', text: 'later', start: 6, duration: 1 }, 2)!,
    ]
    expect(overlaysAt(overlays, 1.5).map((overlay) => overlay.text)).toEqual(['under', 'over'])
    expect(overlaysAt(overlays, 3.5)).toEqual([overlays[0]!])
    expect(overlaysAt(overlays, 6.2).map((overlay) => overlay.text)).toEqual(['later'])
  })

  test('adding, changing and removing an overlay keeps the document whole', () => {
    let doc = addOverlay(emptyDocument('cut'), {
      kind: 'text',
      text: '第一句',
      start: 0,
      duration: 2,
      preset: 'subtitle',
    })
    expect(doc.overlays).toHaveLength(1)
    const overlayId = doc.overlays[0]!.id

    doc = updateOverlay(doc, overlayId, { text: '改过的', start: 1 })
    expect(doc.overlays[0]!.text).toBe('改过的')
    expect(doc.overlays[0]!.start).toBe(1)

    // An overlay can outlast the picture; the cut is as long as either.
    expect(durationOf(doc)).toBe(3)

    doc = removeOverlay(doc, overlayId)
    expect(doc.overlays).toEqual([])
  })

  test('a file written before overlays existed still opens, and a hand-edited one is repaired', () => {
    const old = normalizeDocument({ schemaVersion: 1, revision: 2, name: '旧' }, '旧')
    expect(old.overlays).toEqual([])

    const repaired = normalizeDocument(
      {
        schemaVersion: 1,
        revision: 3,
        name: '新',
        overlays: [
          { kind: 'text', text: 'a', start: -3, duration: 0 },
          { kind: 'media', src: 'assets/x.png', start: 0, duration: 'nope', box: { x: -1, y: 2, w: 0, h: 9 } },
          { kind: 'text' },
        ],
      },
      '新',
    )
    expect(repaired.overlays).toHaveLength(3)
    expect(repaired.overlays[0]!.start).toBe(0)
    expect(repaired.overlays[0]!.duration).toBe(0.05)
    expect(repaired.overlays[1]!.box).toEqual({ x: 0, y: 1, w: 0.01, h: 1 })
  })
})

describe('each clip carries its own sound', () => {
  test('volume is clamped, and mute overrides it', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 5)
    expect(clipVolume(clip)).toBe(1)

    const loud = setClipAudio(doc, clip.id, { volume: 2 })
    expect(clipVolume(loud.tracks[0]!.clips[0]!)).toBe(1)

    const quiet = setClipAudio(doc, clip.id, { volume: 0.4 })
    expect(clipVolume(quiet.tracks[0]!.clips[0]!)).toBe(0.4)

    const muted = setClipAudio(quiet, clip.id, { muted: true })
    expect(clipVolume(muted.tracks[0]!.clips[0]!)).toBe(0)
  })

  test('detaching moves the sound to an audio track and mutes the picture', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 2, 5)

    const detached = detachAudio(doc, clip.id)
    const picture = detached.tracks.find((track) => track.id === 'video-1')!.clips[0]!
    expect(picture.muted).toBe(true)
    expect(picture.start).toBe(2)
    expect(picture.duration).toBe(5)

    const audioTrack = detached.tracks.find((track) => track.kind === 'audio')!
    expect(audioTrack).toBeDefined()
    expect(audioTrack.clips).toHaveLength(1)
    expect(audioTrack.clips[0]).toMatchObject({ src: clip.src, start: 2, in: 0, duration: 5 })
    // The picture is no longer the thing that is heard; the new clip is.
    expect(clipVolume(audioTrack.clips[0]!)).toBe(1)

    // Detaching twice would double the sound, so the second call is a no-op.
    expect(detachAudio(detached, clip.id)).toBe(detached)
    // An audio clip is already the sound.
    expect(detachAudio(detached, audioTrack.clips[0]!.id)).toBe(detached)
  })

  test('a picture-in-picture is silent until it is told otherwise', () => {
    const silent = normalizeOverlay({ kind: 'media', src: 'assets/face.mp4', start: 0, duration: 2 }, 0)!
    expect(resolveOverlayVolume(silent)).toBe(0)
    expect(resolveOverlayVolume({ ...silent, muted: false })).toBe(1)
    expect(resolveOverlayVolume({ ...silent, muted: false, volume: 0.25 })).toBe(0.25)
    expect(resolveOverlayVolume({ ...silent, volume: 0.25 })).toBe(0)
  })
})

describe('fades, mute and solo — the audio controls OpenReel has', () => {
  test('a fade ramps the gain at the clip edges, and volume is the ceiling', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const faded = setClipFade(doc, clip.id, { fadeIn: 1, fadeOut: 2 })
    const target = faded.tracks[0]!.clips[0]!

    expect(clipGainAt(target, 0)).toBe(0)
    expect(clipGainAt(target, 0.5)).toBeCloseTo(0.5)
    expect(clipGainAt(target, 1.5)).toBe(1)
    expect(clipGainAt(target, 3)).toBeCloseTo(0.5)
    expect(clipGainAt(target, 4)).toBe(0)

    const quiet = setClipAudio(faded, clip.id, { volume: 0.5 })
    expect(clipGainAt(quiet.tracks[0]!.clips[0]!, 2)).toBe(0.5)

    const muted = setClipAudio(faded, clip.id, { muted: true })
    expect(clipGainAt(muted.tracks[0]!.clips[0]!, 2)).toBe(0)
  })

  test('clearing both fades leaves no fade object behind', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const faded = setClipFade(doc, clip.id, { fadeIn: 1, fadeOut: 1 })
    const cleared = setClipFade(faded, clip.id, { fadeIn: 0, fadeOut: 0 })
    expect(cleared.tracks[0]!.clips[0]!.fade).toBeUndefined()
  })

  test('muting a track silences its clips; soloing one track silences the rest', () => {
    let doc = addTrack(addTrack(emptyDocument('cut'), 'audio'), 'audio')
    doc = withClip(doc, 'video-1', 0, 5).doc
    doc = withClip(doc, 'audio-1', 0, 5).doc
    doc = withClip(doc, 'audio-2', 0, 5).doc
    expect(audioClipsAt(doc, 1).map(({ track }) => track.id)).toEqual(['audio-1', 'audio-2'])

    doc = setTrackAudio(doc, 'audio-1', { muted: true })
    expect(audioClipsAt(doc, 1).map(({ track }) => track.id)).toEqual(['audio-2'])

    doc = setTrackAudio(setTrackAudio(doc, 'audio-1', { muted: false }), 'audio-2', { solo: true })
    expect(audioClipsAt(doc, 1).map(({ track }) => track.id)).toEqual(['audio-2'])
    // Solo is about sound: the picture track is silenced but still shows its picture.
    expect(trackAudible(doc, doc.tracks.find((track) => track.id === 'video-1')!)).toBe(false)
    expect(videoClipAt(doc, 1)?.track.id).toBe('video-1')
  })

  test('a detached audio clip keeps the picture’s fade', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const faded = setClipFade(doc, clip.id, { fadeIn: 0.5, fadeOut: 1 })
    const detached = detachAudio(faded, clip.id)
    const sound = detached.tracks.find((track) => track.kind === 'audio')!.clips[0]!
    expect(sound.fade).toEqual({ fadeIn: 0.5, fadeOut: 1 })
  })

  test('keyframes multiply into the gain, and ducking keeps the settings it was baked from', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)

    const keyed = setClipAutomation(doc, clip.id, [
      { time: 0, value: 1 },
      { time: 2, value: 0.5 },
      { time: 4, value: 1 },
    ])
    expect(clipGainAt(keyed.tracks[0]!.clips[0]!, 1)).toBeCloseTo(0.75)

    const ducked = setClipDucking(
      doc,
      clip.id,
      { sourceTrackId: 'audio-1', threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2 },
      [
        { time: 0, value: 1 },
        { time: 2, value: 0.4 },
      ],
    )
    const target = ducked.tracks[0]!.clips[0]!
    expect(target.ducking?.sourceTrackId).toBe('audio-1')
    expect(clipGainAt(target, 2)).toBeCloseTo(0.4)

    const cleared = clearClipDucking(ducked, clip.id)
    expect(cleared.tracks[0]!.clips[0]!.automation).toBeUndefined()
    expect(cleared.tracks[0]!.clips[0]!.ducking).toBeUndefined()
  })

  test('hand-written keyframes are sorted and clamped, and ducking without a trigger is dropped', () => {
    const doc = normalizeDocument(
      {
        schemaVersion: 1,
        revision: 1,
        name: 'x',
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              {
                id: 'c1',
                src: 'assets/a.mp4',
                start: 0,
                in: 0,
                duration: 5,
                automation: [
                  { time: 3, value: 2 },
                  { time: 1, value: -1 },
                ],
                ducking: {
                  sourceTrackId: 'audio-1',
                  threshold: -120,
                  reduction: 5,
                  attack: 0,
                  release: -1,
                  holdTime: -2,
                },
              },
              {
                id: 'c2',
                src: 'assets/b.mp4',
                start: 5,
                in: 0,
                duration: 2,
                ducking: { threshold: -30 },
              },
            ],
          },
        ],
      },
      'x',
    )

    const clip = doc.tracks[0]!.clips[0]!
    expect(clip.automation).toEqual([
      { time: 1, value: 0 },
      { time: 3, value: 1 },
    ])
    expect(clip.ducking).toMatchObject({
      sourceTrackId: 'audio-1',
      threshold: -60,
      reduction: 1,
      attack: 0.01,
      release: 0.01,
      holdTime: 0,
    })
    // No trigger track means the setting cannot mean anything.
    expect(doc.tracks[0]!.clips[1]!.ducking).toBeUndefined()
  })
})

describe('transform and clip housekeeping — the adjust tab', () => {
  test('a transform is clamped, and going neutral clears it', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const moved = setClipTransform(doc, clip.id, {
      x: 2,
      scale: 10,
      rotation: 400,
      radius: 1,
      opacity: 0.5,
    })
    const target = moved.tracks[0]!.clips[0]!
    expect(target.transform).toEqual({ x: 1, y: 0, scale: 4, rotation: 360, radius: 0.5 })
    expect(target.opacity).toBe(0.5)

    const reset = setClipTransform(moved, clip.id, {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      radius: 0,
      opacity: 1,
    })
    expect(reset.tracks[0]!.clips[0]!.transform).toBeUndefined()
    expect(reset.tracks[0]!.clips[0]!.opacity).toBeUndefined()
  })

  test('duplicate sits right after, ripple delete pulls the track left, gaps close', () => {
    let doc = withClip(emptyDocument('cut'), 'video-1', 0, 4).doc
    doc = withClip(doc, 'video-1', 6, 2).doc
    const [first, second] = doc.tracks[0]!.clips

    const copied = duplicateClip(doc, first!.id)
    expect(copied.tracks[0]!.clips).toHaveLength(3)
    expect(copied.tracks[0]!.clips[2]!.start).toBe(4)

    const closed = closeGap(doc, second!.id)
    expect(closed.tracks[0]!.clips.find((clip) => clip.id === second!.id)!.start).toBe(4)

    const packed = removeGaps(doc)
    expect(packed.tracks[0]!.clips.map((clip) => clip.start)).toEqual([0, 4])

    const rippled = rippleDelete(doc, first!.id)
    const remaining = rippled.tracks[0]!.clips
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe(second!.id)
    expect(remaining[0]!.start).toBe(2)
  })
})

describe('transitions — a cut that blends', () => {
  test('the window is centred on the cut, and both halves report the same progress', () => {
    let doc = withClip(emptyDocument('cut'), 'video-1', 0, 4).doc
    doc = withClip(doc, 'video-1', 4, 3).doc
    const first = doc.tracks[0]!.clips[0]!
    const second = doc.tracks[0]!.clips[1]!
    const ready = setTransition(doc, second.id, { kind: 'crossfade', duration: 1 })

    const before = transitionAt(ready, 3.75)
    expect(before?.kind).toBe('crossfade')
    expect(before?.progress).toBeCloseTo(0.25)
    expect(before?.from.clip.id).toBe(first.id)
    expect(before?.to.clip.id).toBe(second.id)
    // The incoming side has not started yet, so it holds its first frame.
    expect(before?.to.offset).toBe(0)

    expect(transitionAt(ready, 4)?.progress).toBeCloseTo(0.5)

    const after = transitionAt(ready, 4.25)
    expect(after?.progress).toBeCloseTo(0.75)
    expect(after?.from.clip.id).toBe(first.id)
    // The outgoing side has ended, so it holds its last frame.
    expect(after?.from.offset).toBeCloseTo(3.999)

    // Outside the window the picture is simply one clip.
    expect(transitionAt(ready, 3)).toBeNull()
    expect(transitionAt(ready, 5)).toBeNull()
  })

  test('every renderable kind shares the centred window', () => {
    let doc = withClip(emptyDocument('cut'), 'video-1', 0, 4).doc
    doc = withClip(doc, 'video-1', 4, 3).doc
    const second = doc.tracks[0]!.clips[1]!

    for (const kind of ['crossfade', 'wipe-left', 'slide-left', 'zoom', 'dip-black', 'dip-white'] as const) {
      const ready = setTransition(doc, second.id, { kind, duration: 1 })
      expect(ready.tracks[0]!.clips[1]!.transition?.kind).toBe(kind)
      expect(transitionAt(ready, 3.75)?.kind).toBe(kind)
      expect(transitionAt(ready, 4)?.progress).toBeCloseTo(0.5)
    }

    // Layered kinds draw both pictures; dips pass through a colour instead.
    expect(isLayeredTransition('crossfade')).toBe(true)
    expect(isLayeredTransition('wipe-left')).toBe(true)
    expect(isLayeredTransition('slide-left')).toBe(true)
    expect(isLayeredTransition('zoom')).toBe(true)
    expect(isLayeredTransition('dip-black')).toBe(false)
    expect(isLayeredTransition('dip-white')).toBe(false)
  })

  test('the arrival formula moves and fades the incoming picture', () => {
    expect(arrivalStyle('crossfade', 0.5)).toEqual({ opacity: 0.5, scale: 1, wipe: 1, slide: 0 })
    expect(arrivalStyle('wipe-left', 0.5)).toEqual({ opacity: 1, scale: 1, wipe: 0.5, slide: 0 })
    expect(arrivalStyle('slide-left', 0.5)).toEqual({ opacity: 1, scale: 1, wipe: 1, slide: 0.5 })
    const zoom = arrivalStyle('zoom', 0)
    expect(zoom.opacity).toBe(0)
    expect(zoom.scale).toBeCloseTo(0.85)
    expect(arrivalStyle('zoom', 1).scale).toBeCloseTo(1)
    // Progress is clamped, so a held edge frame never overshoots.
    expect(arrivalStyle('crossfade', 2).opacity).toBe(1)
    expect(arrivalStyle('crossfade', -1).opacity).toBe(0)
  })

  test('a transition with no adjacent predecessor is stored but never rendered', () => {
    let doc = withClip(emptyDocument('cut'), 'video-1', 0, 2).doc
    doc = withClip(doc, 'video-1', 4, 2).doc
    const second = doc.tracks[0]!.clips[1]!
    const ready = setTransition(doc, second.id, { kind: 'dip-black', duration: 1 })

    expect(ready.tracks[0]!.clips[1]!.transition).toEqual({ kind: 'dip-black', duration: 1 })
    expect(transitionAt(ready, 4)).toBeNull()
    expect(transitionAt(ready, 4.2)).toBeNull()
  })

  test('duration is clamped, and clearing removes the transition', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const long = setTransition(doc, clip.id, { kind: 'crossfade', duration: 99 })
    expect(long.tracks[0]!.clips[0]!.transition?.duration).toBe(5)

    const cleared = setTransition(long, clip.id, null)
    expect(cleared.tracks[0]!.clips[0]!.transition).toBeUndefined()
  })
})

describe('revision arithmetic across two writers', () => {
  test('a write lands past what is on disk, even when both read the same base', () => {
    // The panel and the agent both read revision 7: the second write must not land on 8 again.
    expect(nextRevision(7, 7)).toBe(8)
    expect(nextRevision(7, 8)).toBe(9)
    expect(nextRevision(7, null)).toBe(8)
  })

  test('a write based on an older revision is stale, and a fresh one is not', () => {
    expect(isStaleRevision(7, 8)).toBe(true)
    expect(isStaleRevision(7, 7)).toBe(false)
    // No file yet: there is nothing to be stale against.
    expect(isStaleRevision(7, null)).toBe(false)
  })
})

describe('placement keyframes', () => {
  test('interpolates between two keyframes and holds at the ends', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const keyed = setClipKeyframes(doc, clip.id, [
      { time: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 }, opacity: 1 },
      { time: 4, transform: { x: 0.5, y: 0, scale: 2, rotation: 90, radius: 0 }, opacity: 0 },
    ])
    const framed = keyed.tracks[0]!.clips[0]!

    expect(clipVisualAt(framed, 2).transform).toEqual({
      x: 0.25,
      y: 0,
      scale: 1.5,
      rotation: 45,
      radius: 0,
    })
    expect(clipVisualAt(framed, 2).opacity).toBeCloseTo(0.5)
    // Outside the span the nearest keyframe holds.
    expect(clipVisualAt(framed, -1).transform.x).toBe(0)
    expect(clipVisualAt(framed, 9).transform.x).toBe(0.5)
  })

  test('a clip without keyframes reads its own transform', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const moved = setClipTransform(doc, clip.id, { scale: 1.2, opacity: 0.5 })
    const visual = clipVisualAt(moved.tracks[0]!.clips[0]!, 2)
    expect(visual.transform.scale).toBe(1.2)
    expect(visual.opacity).toBe(0.5)
  })

  test('a keyframe carries the easing of the segment arriving at it', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 2)
    const base = { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 }
    const at = (easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out') =>
      setClipKeyframes(doc, clip.id, [
        { time: 0, transform: base },
        { time: 2, transform: { ...base, x: 1 }, ...(easing ? { easing } : {}) },
      ]).tracks[0]!.clips[0]!

    // Halfway through: ease-in has travelled a quarter, ease-out three quarters.
    expect(clipVisualAt(at(), 1).transform.x).toBeCloseTo(0.5)
    expect(clipVisualAt(at('ease-in'), 1).transform.x).toBeCloseTo(0.25)
    expect(clipVisualAt(at('ease-out'), 1).transform.x).toBeCloseTo(0.75)
    expect(clipVisualAt(at('ease-in-out'), 1).transform.x).toBeCloseTo(0.5)
    // A linear segment stores no easing at all.
    expect(at().keyframes?.[1]?.easing).toBeUndefined()
    expect(at('ease-in').keyframes?.[1]?.easing).toBe('ease-in')
  })

  test('keyframes sort, clamp to the clip, survive a reload, and clear back', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const keyed = setClipKeyframes(doc, clip.id, [
      { time: 9, transform: { x: 0.2, y: 0, scale: 1, rotation: 0, radius: 0 } },
      { time: -1, transform: { x: -0.2, y: 0, scale: 1, rotation: 0, radius: 0 } },
    ])
    const frames = keyed.tracks[0]!.clips[0]!.keyframes!
    expect(frames.map((frame) => frame.time)).toEqual([0, 4])
    expect(frames[1]!.transform.x).toBe(0.2)

    // The file round-trip keeps them — a reload must not silently flatten the animation.
    const reloaded = normalizeDocument(JSON.parse(JSON.stringify(keyed)), 'cut')
    expect(reloaded.tracks[0]!.clips[0]!.keyframes).toHaveLength(2)

    const cleared = setClipKeyframes(keyed, clip.id, null)
    expect(cleared.tracks[0]!.clips[0]!.keyframes).toBeUndefined()
  })

  test('a split re-anchors the animation on both halves', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const keyed = setClipKeyframes(doc, clip.id, [
      { time: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 } },
      { time: 4, transform: { x: 0.4, y: 0, scale: 1, rotation: 0, radius: 0 } },
    ])
    const cut = splitClip(keyed, clip.id, 2)
    const [head, tail] = cut.tracks[0]!.clips

    // The head ends at the look the cut moment had; the tail starts there.
    expect(head!.keyframes!.map((frame) => frame.time)).toEqual([0, 2])
    expect(head!.keyframes![1]!.transform.x).toBeCloseTo(0.2)
    expect(tail!.keyframes!.map((frame) => frame.time)).toEqual([0, 2])
    expect(tail!.keyframes![0]!.transform.x).toBeCloseTo(0.2)
    expect(tail!.keyframes![1]!.transform.x).toBeCloseTo(0.4)
  })
})

describe('crop and picture-in-picture frame', () => {
  test('a crop stays inside the source frame and clears back to nothing', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const cropped = setClipCrop(doc, clip.id, { x: 0.6, y: 0.1, w: 0.6, h: 0.5 })
    // Right edge cannot pass 1: x is pulled back to 1 - w.
    expect(cropped.tracks[0]!.clips[0]!.crop).toEqual({ x: 0.4, y: 0.1, w: 0.6, h: 0.5 })

    const cleared = setClipCrop(cropped, clip.id, null)
    expect(cleared.tracks[0]!.clips[0]!.crop).toBeUndefined()
  })

  test('a frame survives a reload; no width means no frame', () => {
    const base = addOverlay(emptyDocument('cut'), {
      kind: 'media',
      src: 'assets/pip.mp4',
      start: 0,
      duration: 2,
    })
    const overlayId = base.overlays[0]!.id
    const framed = setOverlayFrame(base, overlayId, { width: 8, color: '#ffcc00', radius: 0.2 })

    const reloaded = normalizeDocument(JSON.parse(JSON.stringify(framed)), 'cut')
    expect(reloaded.overlays[0]!.frame).toEqual({ width: 8, color: '#ffcc00', radius: 0.2 })

    expect(setOverlayFrame(framed, overlayId, null).overlays[0]!.frame).toBeUndefined()
    expect(
      setOverlayFrame(framed, overlayId, { width: 0, color: '#ffffff' }).overlays[0]!.frame,
    ).toBeUndefined()
  })
})

describe('freeze frames', () => {
  test('a held clip keeps its source time, and the insert ripples the track', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const withNeighbour = withClip(doc, 'video-1', 6, 2).doc

    const held = insertFreezeFrame(withNeighbour, clip.id, 2, 1.5)!
    const clips = held.tracks[0]!.clips
    expect(clips.map((item) => item.start)).toEqual([0, 2, 3.5, 7.5])
    expect(clips.map((item) => item.duration)).toEqual([2, 1.5, 2, 2])

    const still = clips[1]!
    expect(still.freeze).toBe(true)
    expect(still.muted).toBe(true)
    expect(still.in).toBe(clipSourceTime(clip, 2))
    // Every moment of a held clip shows the same source frame.
    expect(clipSourceTime(still, 0)).toBe(still.in)
    expect(clipSourceTime(still, 1.4)).toBe(still.in)

    // Nothing is overwritten: the neighbour moved right by the hold.
    expect(clips[3]!.start).toBe(7.5)
  })

  test('by default the hold moves the other lanes and overlays too', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    let built = addClip(doc, { src: 'assets/b.mp4', duration: 2, start: 6 })
    built = addTrack(built, 'audio')
    built = addClip(built, { src: 'assets/music.mp3', duration: 8, start: 0, trackId: 'audio-1' })
    built = addOverlay(built, { kind: 'text', text: '字幕', start: 5, duration: 1, preset: 'subtitle' })
    built = addOverlay(built, { kind: 'text', text: '早', start: 1, duration: 1, preset: 'subtitle' })

    const held = insertFreezeFrame(built, clip.id, 2, 1.5)!
    expect(held.tracks[0]!.clips.find((item) => item.src === 'assets/b.mp4')!.start).toBeCloseTo(7.5)
    // A bed that began before the hold stays continuous.
    expect(held.tracks[1]!.clips[0]!.start).toBe(0)
    expect(held.overlays.find((overlay) => overlay.text === '字幕')!.start).toBeCloseTo(6.5)
    expect(held.overlays.find((overlay) => overlay.text === '早')!.start).toBe(1)
  })

  test('ripple: track keeps the other lanes where they are', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    let built = addClip(doc, { src: 'assets/b.mp4', duration: 2, start: 6 })
    built = addTrack(built, 'audio')
    built = addClip(built, { src: 'assets/music.mp3', duration: 8, start: 0, trackId: 'audio-1' })
    built = addOverlay(built, { kind: 'text', text: '字幕', start: 5, duration: 1, preset: 'subtitle' })

    const held = insertFreezeFrame(built, clip.id, 2, 1.5, { ripple: 'track' })!
    // The frozen lane still ripples; only the other lanes and overlays stay put.
    expect(held.tracks[0]!.clips.find((item) => item.src === 'assets/b.mp4')!.start).toBeCloseTo(7.5)
    expect(held.tracks[0]!.clips.find((item) => item.freeze)!.start).toBe(2)
    expect(held.tracks[1]!.clips[0]!.start).toBe(0)
    expect(held.overlays[0]!.start).toBe(5)
  })

  test('a moment on an edge, or a clip that is not there, holds nothing', () => {
    const { doc, clip } = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    expect(insertFreezeFrame(doc, clip.id, 0, 1)).toBeNull()
    expect(insertFreezeFrame(doc, clip.id, 4, 1)).toBeNull()
    expect(insertFreezeFrame(doc, 'nope', 2, 1)).toBeNull()
  })
})

describe('markers and a sliced range', () => {
  test('markers are kept in time order, and removing the last one clears the field', () => {
    let doc = emptyDocument('cut')
    doc = addMarker(doc, { time: 5, name: ' 第二章 ' })
    doc = addMarker(doc, { time: 1 })
    expect(markersOf(doc).map((marker) => marker.time)).toEqual([1, 5])
    expect(markersOf(doc)[1]!.name).toBe('第二章')

    const ids = markersOf(doc).map((marker) => marker.id)
    doc = removeMarker(doc, ids[0]!)
    doc = removeMarker(doc, ids[1]!)
    expect(markersOf(doc)).toEqual([])
    expect(doc.markers).toBeUndefined()
  })

  test('a slice keeps the overlapping material and rebases everything to 0', () => {
    const doc = normalizeDocument(
      {
        settings: { width: 1920, height: 1080, frameRate: 30 },
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              {
                id: 'a',
                src: 'assets/a.mp4',
                start: 0,
                in: 0,
                duration: 4,
                speed: 2,
                keyframes: [
                  { time: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 } },
                  { time: 2, transform: { x: 0, y: 0, scale: 1.2, rotation: 0, radius: 0 } },
                  { time: 4, transform: { x: 0, y: 0, scale: 1.4, rotation: 0, radius: 0 } },
                ],
                automation: [
                  { time: 0, value: 1 },
                  { time: 4, value: 0.2 },
                ],
                fade: { fadeIn: 2, fadeOut: 1 },
              },
              {
                id: 'b',
                src: 'assets/b.mp4',
                start: 4,
                in: 1,
                duration: 4,
                transition: { kind: 'crossfade', duration: 0.5 },
              },
            ],
          },
        ],
        overlays: [
          { id: 'ov-1', kind: 'text', text: '你好', start: 0.5, duration: 3, preset: 'subtitle' },
        ],
        markers: [
          { id: 'm1', time: 2, name: 'two' },
          { id: 'm2', time: 7 },
        ],
      },
      'cut',
    )

    const sliced = sliceDocument(doc, 1, 6)
    const [first, second] = sliced.tracks[0]!.clips
    // Clip A loses one timeline second of head, which is two source seconds at 2×.
    expect(first!.id).toBe('a')
    expect(first!.start).toBe(0)
    expect(first!.in).toBe(2)
    expect(first!.duration).toBe(3)
    expect(first!.keyframes!.map((keyframe) => keyframe.time)).toEqual([1, 3])
    expect(first!.automation!.map((point) => point.time)).toEqual([3])
    expect(first!.fade).toEqual({ fadeIn: 1, fadeOut: 1 })

    // Clip B starts at 4s, inside the range: its cut survives, moved to 3s.
    expect(second!.id).toBe('b')
    expect(second!.start).toBe(3)
    expect(second!.in).toBe(1)
    expect(second!.duration).toBe(2)
    expect(second!.transition).toEqual({ kind: 'crossfade', duration: 0.5 })

    expect(sliced.overlays[0]!.start).toBe(0)
    expect(sliced.overlays[0]!.duration).toBe(2.5)
    expect(markersOf(sliced)).toHaveLength(1)
    expect(markersOf(sliced)[0]!.time).toBe(1)
  })

  test('a slice that cuts through a clip head drops the transition it used to carry', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              { id: 'a', src: 'assets/a.mp4', start: 0, in: 0, duration: 4 },
              {
                id: 'b',
                src: 'assets/b.mp4',
                start: 4,
                in: 1,
                duration: 4,
                transition: { kind: 'crossfade', duration: 0.5 },
              },
            ],
          },
        ],
      },
      'cut',
    )
    const sliced = sliceDocument(doc, 4.5, 6)
    expect(sliced.tracks[0]!.clips).toHaveLength(1)
    expect(sliced.tracks[0]!.clips[0]!.start).toBe(0)
    expect(sliced.tracks[0]!.clips[0]!.in).toBeCloseTo(1.5)
    expect(sliced.tracks[0]!.clips[0]!.transition).toBeUndefined()

    expect(sliceDocument(doc, 2, 2).tracks[0]!.clips).toEqual([])
  })
})

describe('masks — a shape over one clip', () => {
  test('a mask is clamped into the frame, and a mask without its clip is dropped', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [{ id: 'c1', src: 'assets/a.mp4', start: 0, in: 0, duration: 4 }],
          },
        ],
        masks: [
          {
            id: 'm1',
            clipId: 'c1',
            shape: 'ellipse',
            x: 0.8,
            y: -0.2,
            width: 0.5,
            height: 0.4,
            feather: 300,
            expansion: -500,
            inverted: true,
            opacity: 2,
          },
          { id: 'm2', clipId: 'gone', shape: 'rectangle', width: 0.2, height: 0.2 },
        ],
      },
      'cut',
    )
    expect(doc.masks).toHaveLength(1)
    const mask = doc.masks![0]!
    expect(mask.x).toBeCloseTo(0.5)
    expect(mask.y).toBeCloseTo(0)
    expect(mask.width).toBeCloseTo(0.5)
    expect(mask.feather).toBe(200)
    expect(mask.expansion).toBe(-200)
    expect(mask.opacity).toBe(1)
    expect(mask.inverted).toBe(true)
  })

  test('a mask follows the picture through a split and a duplicate, and leaves with the clip', () => {
    const placed = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    let doc = placed.doc
    const clipId = placed.clip.id
    doc = setMask(doc, { clipId, shape: 'ellipse', feather: 12 })
    expect(masksForClip(doc, clipId)).toHaveLength(1)
    expect(doc.masks![0]!.width).toBeCloseTo(0.5)

    const duplicated = duplicateClip(doc, clipId)
    expect(duplicated.masks).toHaveLength(2)

    const cut = splitClip(doc, clipId, 2)
    expect(cut.tracks[0]!.clips).toHaveLength(2)
    expect(cut.masks).toHaveLength(2)
    for (const clip of cut.tracks[0]!.clips) {
      expect(masksForClip(cut, clip.id)).toHaveLength(1)
    }

    const removed = removeClip(cut, cut.tracks[0]!.clips[0]!.id)
    expect(removed.masks).toHaveLength(1)

    const cleared = clearMask(doc, clipId)
    expect(cleared.masks).toBeUndefined()
  })

  test('geometry turns fractions into pixels and expansion moves every edge', () => {
    const mask: EditMask = {
      id: 'm',
      clipId: 'c',
      shape: 'rectangle',
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      feather: 0,
      expansion: 10,
      inverted: false,
      opacity: 1,
    }
    const bounds = maskBoundsPx(mask, 1000, 500)
    expect(bounds.x).toBeCloseTo(240)
    expect(bounds.y).toBeCloseTo(115)
    expect(bounds.width).toBeCloseTo(520)
    expect(bounds.height).toBeCloseTo(270)

    const polygon = maskPolygonPx({ ...mask, shape: 'polygon' }, 1000, 500)
    expect(polygon).toHaveLength(5)
    expect(polygon[0]!.x).toBeCloseTo(500)
    expect(polygon[0]!.y).toBeCloseTo(115)
  })

  test('an animated mask interpolates between keyframes and holds at both ends', () => {
    const placed = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const doc = setMask(placed.doc, {
      clipId: placed.clip.id,
      shape: 'rectangle',
      keyframes: [
        { time: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.2, opacity: 1 },
        { time: 3, x: 0.5, y: 0.3, width: 0.4, height: 0.2, opacity: 0.5, easing: 'linear' },
      ],
    })
    const mask = masksForClip(doc, placed.clip.id)[0]!
    expect(mask.keyframes).toHaveLength(2)
    expect(maskAt(mask, 0).x).toBeCloseTo(0.1)
    expect(maskAt(mask, 2).x).toBeCloseTo(0.3)
    expect(maskAt(mask, 2).width).toBeCloseTo(0.3)
    expect(maskAt(mask, 2).opacity).toBeCloseTo(0.75)
    expect(maskAt(mask, 4).x).toBeCloseTo(0.5)
  })

  test('mask keyframes are sorted, de-duplicated and clamped to the clip', () => {
    const placed = withClip(emptyDocument('cut'), 'video-1', 0, 2)
    const doc = setMask(placed.doc, {
      clipId: placed.clip.id,
      shape: 'rectangle',
      keyframes: [
        { time: 9, x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
        { time: 0, x: 0, y: 0, width: 0.2, height: 0.2 },
        { time: 0, x: 0.1, y: 0, width: 0.2, height: 0.2 },
      ],
    })
    const frames = masksForClip(doc, placed.clip.id)[0]!.keyframes!
    expect(frames).toHaveLength(2)
    expect(frames[0]!.time).toBe(0)
    expect(frames[0]!.x).toBeCloseTo(0.1)
    expect(frames[1]!.time).toBe(2)
  })

  test('a split and a slice move each new piece\'s animation to its own origin', () => {
    const placed = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const doc = setMask(placed.doc, {
      clipId: placed.clip.id,
      shape: 'ellipse',
      keyframes: [
        { time: 0.5, x: 0, y: 0, width: 0.4, height: 0.4 },
        { time: 1.5, x: 0.2, y: 0, width: 0.4, height: 0.4 },
        { time: 3.5, x: 0.4, y: 0, width: 0.4, height: 0.4 },
      ],
    })

    const cut = splitClip(doc, placed.clip.id, 2)
    const tail = cut.tracks[0]!.clips[1]!
    expect(masksForClip(cut, tail.id)[0]!.keyframes!.map((frame) => frame.time)).toEqual([1.5])

    const sliced = sliceDocument(doc, 0.5, 3.5)
    const kept = masksForClip(sliced, placed.clip.id)[0]!.keyframes!
    expect(kept.map((frame) => frame.time)).toEqual([0, 1, 3])
  })

  test('quantizing puts mask keyframes on the frame grid', () => {
    const placed = withClip(emptyDocument('cut'), 'video-1', 0, 4)
    const doc = setMask(placed.doc, {
      clipId: placed.clip.id,
      shape: 'rectangle',
      keyframes: [{ time: 0.016, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
    })
    const snapped = quantizeDocument(doc)
    expect(masksForClip(snapped, placed.clip.id)[0]!.keyframes![0]!.time).toBe(0)
  })
})

describe('mirror and regional blur', () => {
  test('flipX survives a reload, clears back to none, and switches halfway in a keyframe segment', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              {
                id: 'c',
                src: 'assets/a.mp4',
                start: 0,
                in: 0,
                duration: 4,
                transform: { x: 0, y: 0, scale: 1, rotation: 0, radius: 0, flipX: true },
              },
            ],
          },
        ],
      },
      'cut',
    )
    const clip = doc.tracks[0]!.clips[0]!
    expect(clip.transform?.flipX).toBe(true)

    const cleared = setClipTransform(doc, 'c', { flipX: false })
    expect(cleared.tracks[0]!.clips[0]!.transform).toBeUndefined()

    const keyed = setClipKeyframes(doc, 'c', [
      { time: 0, transform: { ...NEUTRAL_TRANSFORM } },
      { time: 4, transform: { ...NEUTRAL_TRANSFORM, flipX: true } },
    ])
    const clipKeyed = keyed.tracks[0]!.clips[0]!
    expect(clipVisualAt(clipKeyed, 1).transform.flipX).toBeUndefined()
    expect(clipVisualAt(clipKeyed, 3).transform.flipX).toBe(true)
  })

  test('regional blur is clamped into the frame and stays with the grade', () => {
    const doc = normalizeDocument(
      {
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            clips: [
              {
                id: 'c',
                src: 'assets/a.mp4',
                start: 0,
                in: 0,
                duration: 4,
                effect: {
                  brightness: 1.2,
                  regions: [{ x: 0.9, y: -1, w: 0.4, h: 0.2, mode: 'mosaic', strength: 100 }],
                },
              },
            ],
          },
        ],
      },
      'cut',
    )
    const effect = doc.tracks[0]!.clips[0]!.effect!
    expect(effect.brightness).toBeCloseTo(1.2)
    expect(effect.regions).toEqual([
      { x: 0.6, y: 0, w: 0.4, h: 0.2, mode: 'mosaic', strength: 60 },
    ])
  })
})
