import { describe, expect, test } from 'bun:test'
import { arrangeOnCutPoints } from '../arrange.ts'

const sources = [
  { src: 'assets/a.mp4', duration: 10 },
  { src: 'assets/b.mp4', duration: 10 },
]

describe('卡点 arrangement — one clip per accepted cut point', () => {
  test('places a clip at each beat and takes the sources in turn', () => {
    const plan = arrangeOnCutPoints({ cutPoints: [0, 1, 2, 3], sources })
    expect(plan.clips.map((clip) => clip.start)).toEqual([0, 1, 2])
    expect(plan.clips.map((clip) => clip.src)).toEqual([
      'assets/a.mp4',
      'assets/b.mp4',
      'assets/a.mp4',
    ])
    expect(plan.clips.every((clip) => clip.duration === 1)).toBe(true)
    expect(plan.skipped).toBe(0)
  })

  test('drops cut points closer than the minimum clip length', () => {
    const plan = arrangeOnCutPoints({
      cutPoints: [0, 0.5, 1, 2, 2.4, 4],
      sources,
      minClipDuration: 1.5,
    })
    // 0, 2, 4 survive; 0.5 / 1 / 2.4 are too close to the accepted one before them.
    expect(plan.clips.map((clip) => clip.start)).toEqual([0, 2])
    expect(plan.clips.map((clip) => clip.duration)).toEqual([2, 2])
    expect(plan.skipped).toBe(3)
  })

  test('caps a long gap at maxClipDuration and leaves the rest as a hole', () => {
    const plan = arrangeOnCutPoints({
      cutPoints: [0, 5, 10],
      sources,
      minClipDuration: 0.3,
      maxClipDuration: 2,
    })
    expect(plan.clips.map((clip) => clip.start)).toEqual([0, 5])
    expect(plan.clips.map((clip) => clip.duration)).toEqual([2, 2])
  })

  test('a source shorter than its gap is shortened, and that is reported', () => {
    const plan = arrangeOnCutPoints({
      cutPoints: [0, 4],
      sources: [{ src: 'assets/short.mp4', duration: 1.5 }],
    })
    expect(plan.clips).toHaveLength(1)
    expect(plan.clips[0]!.duration).toBe(1.5)
    expect(plan.shortened).toBe(1)
  })

  test('walk advances through a source; hold always starts at its beginning', () => {
    const walked = arrangeOnCutPoints({ cutPoints: [0, 2, 4, 6], sources: [sources[0]!] })
    expect(walked.clips.map((clip) => clip.in)).toEqual([0, 2, 4])

    const held = arrangeOnCutPoints({
      cutPoints: [0, 2, 4, 6],
      sources: [sources[0]!],
      inPoint: 'hold',
    })
    expect(held.clips.map((clip) => clip.in)).toEqual([0, 0, 0])
  })

  test('stops at totalDuration and refuses an empty source list', () => {
    const plan = arrangeOnCutPoints({
      cutPoints: [0, 1, 2, 3, 4],
      sources,
      totalDuration: 2.5,
    })
    expect(plan.clips.map((clip) => clip.start)).toEqual([0, 1, 2])

    expect(arrangeOnCutPoints({ cutPoints: [0, 1], sources: [] }).clips).toEqual([])
  })
})
