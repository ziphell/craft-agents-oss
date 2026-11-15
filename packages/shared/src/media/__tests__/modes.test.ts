import { describe, expect, it } from 'bun:test'
import {
  modelMode,
  paramsForMode,
  videoEditProblem,
  videoModeOf,
  withoutFixedDuration,
} from '../modes.ts'

describe('model modes', () => {
  it('reads a model mode, defaulting to generate', () => {
    const channel = { modelModes: { 'edit-1': 'video-edit' as const } }
    expect(modelMode(channel, 'edit-1')).toBe('video-edit')
    expect(modelMode(channel, 'generate-1')).toBe('generate')
    expect(modelMode(channel, undefined)).toBe('generate')
    expect(modelMode(undefined, 'edit-1')).toBe('generate')
  })

  it('hides the duration only for a video edit', () => {
    const specs = [
      { key: 'ratio', type: 'select' as const, options: ['16:9'] },
      { key: 'duration', type: 'select' as const, options: [4, 8] },
    ]
    expect(paramsForMode(specs, 'video-edit').map((spec) => spec.key)).toEqual(['ratio'])
    expect(paramsForMode(specs, 'generate').map((spec) => spec.key)).toEqual(['ratio', 'duration'])
    expect(paramsForMode(undefined, 'video-edit')).toEqual([])
  })

  it('accepts exactly one video and nothing else', () => {
    expect(videoEditProblem({ videos: 1 })).toBeUndefined()
    expect(videoEditProblem({ videos: 0 })).toBe('needs-one-video')
    expect(videoEditProblem({ videos: 2 })).toBe('needs-one-video')
    expect(videoEditProblem({ videos: 1, images: 1 })).toBe('video-only')
    expect(videoEditProblem({ videos: 1, audios: 1 })).toBe('video-only')
    expect(videoEditProblem({ videos: 1, frames: 1 })).toBe('video-only')
  })

  it('never sends a duration for a video edit', () => {
    expect(withoutFixedDuration({ duration: 8, ratio: '16:9' }, 'video-edit')).toEqual({
      ratio: '16:9',
    })
    expect(withoutFixedDuration({ duration: 8 }, 'generate')).toEqual({ duration: 8 })
  })
})

describe('the shape a request has', () => {
  it('reads text, frames, references and edits from the inputs', () => {
    expect(videoModeOf({}, 'vid', {})).toBe('text')
    expect(videoModeOf({}, 'vid', { firstFrame: true })).toBe('first_frame')
    expect(videoModeOf({}, 'vid', { lastFrame: true })).toBe('first_frame')
    expect(videoModeOf({}, 'vid', { firstFrame: true, lastFrame: true })).toBe('first_last_frame')
    expect(videoModeOf({}, 'vid', { images: 2 })).toBe('reference')
    expect(videoModeOf({ modelModes: { vid: 'video-edit' } }, 'vid', { videos: 1 })).toBe(
      'video_edit',
    )
  })
})
