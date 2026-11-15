import { describe, expect, test } from 'bun:test'
import type { EditDocument } from '../document.ts'
import type { EditOverlay } from '../overlay.ts'
import { exportPlanOf } from '../export-job.ts'

const pathOf = (src: string) => `/project/${src}`

const doc = (tracks: EditDocument['tracks']): EditDocument => ({
  schemaVersion: 1,
  revision: 1,
  name: '预告',
  settings: { width: 1080, height: 1920, frameRate: 30 },
  tracks,
  overlays: [
    { id: 'ov-1', kind: 'media', src: 'assets/pip.mp4', start: 1, duration: 2 } as EditOverlay,
  ],
})

describe('exportPlanOf', () => {
  test('flattens tracks with absolute sources and carries each clip’s own fields', () => {
    const plan = exportPlanOf(
      doc([
        {
          id: 'video-1',
          kind: 'video',
          clips: [
            {
              id: 'c1',
              src: 'assets/a.mp4',
              start: 0,
              in: 1,
              duration: 4,
              speed: 2,
              opacity: 0.8,
              fade: { fadeIn: 0.5, fadeOut: 0 },
              keyframes: [
                { time: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, radius: 0 } },
                { time: 4, transform: { x: 0.3, y: 0, scale: 1.5, rotation: 0, radius: 0 } },
              ],
              crop: { x: 0.1, y: 0, w: 0.8, h: 1 },
              freeze: true,
            },
          ],
        },
        {
          id: 'video-2',
          kind: 'video',
          hidden: true,
          clips: [{ id: 'c2', src: 'assets/b.png', start: 1, in: 0, duration: 2 }],
        },
      ]),
      pathOf,
    )

    expect(plan.width).toBe(1080)
    expect(plan.height).toBe(1920)
    expect(plan.fps).toBe(30)
    expect(plan.clips).toHaveLength(2)

    // A still source is an image, a clip is video, and every path is the file on disk.
    expect(plan.clips[0]).toMatchObject({
      path: '/project/assets/a.mp4',
      kind: 'video',
      track: 0,
      speed: 2,
      opacity: 0.8,
      fadeIn: 0.5,
    })
    // Placement keyframes travel with the clip, so the export animates what the preview shows.
    expect(plan.clips[0]?.keyframes).toHaveLength(2)
    // So does the crop window.
    expect(plan.clips[0]?.crop).toEqual({ x: 0.1, y: 0, w: 0.8, h: 1 })
    // And the held frame is a still in the export too.
    expect(plan.clips[0]?.freeze).toBe(true)
    expect(plan.clips[1]).toMatchObject({
      path: '/project/assets/b.png',
      kind: 'image',
      track: 1,
      hidden: true,
    })
    expect(plan.overlays[0]?.src).toBe('/project/assets/pip.mp4')
  })

  test('a muted track silences its clips; solo silences the others', () => {
    const plan = exportPlanOf(
      doc([
        {
          id: 'video-1',
          kind: 'video',
          solo: true,
          clips: [{ id: 'c1', src: 'assets/a.mp4', start: 0, in: 0, duration: 2 }],
        },
        {
          id: 'audio-1',
          kind: 'audio',
          clips: [{ id: 'c2', src: 'assets/music.mp3', start: 0, in: 0, duration: 2, volume: 0.6 }],
        },
        {
          id: 'audio-2',
          kind: 'audio',
          muted: true,
          clips: [{ id: 'c3', src: 'assets/room.wav', start: 0, in: 0, duration: 2 }],
        },
      ]),
      pathOf,
    )

    // The soloed picture track keeps its own sound; the two sound tracks are silenced.
    expect(plan.clips[0]?.muted).toBeUndefined()
    expect(plan.clips[1]?.muted).toBe(true)
    expect(plan.clips[1]?.volume).toBe(0.6)
    expect(plan.clips[2]?.muted).toBe(true)
    // The picture of a silenced track still travels.
    expect(plan.clips[0]?.kind).toBe('video')
  })
})
