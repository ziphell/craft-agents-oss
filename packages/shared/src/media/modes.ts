/**
 * What a model does with what it is given.
 *
 * Most models make a new picture or clip from a prompt. A few edit a clip that already exists: the
 * output is not a new film with a reference attached, it is *that* film, changed. The two facts that
 * follow — exactly one video in, and a length fixed by that video — are properties of the model, so
 * they are declared on the channel and read the same way by the panel, the agent and the adapter.
 */

import type { MediaParamSpec } from './params.ts'

export type MediaMode = 'generate' | 'video-edit'

/**
 * What a request *is*, as opposed to what a model does.
 *
 * The distinction matters before submission: a text-to-video model given a first frame is a
 * different request from the same model given a reference strip, and providers validate them
 * differently. Derived from the inputs; a caller may state it explicitly when it knows better.
 */
export type VideoMode = 'text' | 'first_frame' | 'first_last_frame' | 'reference' | 'video_edit'

/** What a model does. An undeclared model generates; the old channels keep working unchanged. */
export function modelMode(
  channel: { modelModes?: Record<string, MediaMode> } | null | undefined,
  model?: string | null,
): MediaMode {
  return model && channel?.modelModes?.[model] === 'video-edit' ? 'video-edit' : 'generate'
}

/** The request shape the inputs describe. Frames are roles, not numbered references. */
export function videoModeOf(
  channel: { modelModes?: Record<string, MediaMode> } | null | undefined,
  model: string | null | undefined,
  input: {
    images?: number
    videos?: number
    audios?: number
    firstFrame?: boolean
    lastFrame?: boolean
  },
): VideoMode {
  if (modelMode(channel, model) === 'video-edit') return 'video_edit'
  if (input.firstFrame && input.lastFrame) return 'first_last_frame'
  if (input.firstFrame || input.lastFrame) return 'first_frame'
  if ((input.images ?? 0) + (input.videos ?? 0) + (input.audios ?? 0) > 0) return 'reference'
  return 'text'
}

/** A video edit is as long as the video it edits, so the duration is not a choice to show. */
export function paramsForMode(
  specs: MediaParamSpec[] | undefined,
  mode: MediaMode,
): MediaParamSpec[] {
  if (!specs?.length) return []
  return mode === 'video-edit' ? specs.filter((spec) => spec.key !== 'duration') : specs
}

/** How many inputs of each kind a run brings. The rule is about counts, not files. */
export interface MediaInputCounts {
  videos?: number
  images?: number
  audios?: number
  /** First and last frame, together: both are pictures with a role. */
  frames?: number
}

export type VideoEditProblem = 'needs-one-video' | 'video-only'

/**
 * Why these inputs cannot be edited, or `undefined` when they can.
 *
 * Exactly one video: none means there is nothing to edit, and two means the provider would pick one
 * and the person would never learn which. Nothing else travels with it, because the clip is the
 * subject rather than a reference beside a prompt.
 */
export function videoEditProblem(counts: MediaInputCounts): VideoEditProblem | undefined {
  if ((counts.videos ?? 0) !== 1) return 'needs-one-video'
  if ((counts.images ?? 0) > 0 || (counts.audios ?? 0) > 0 || (counts.frames ?? 0) > 0) {
    return 'video-only'
  }
  return undefined
}

/** Drop the duration from a request: the clip keeps the input's length. */
export function withoutFixedDuration(
  params: Record<string, string | number>,
  mode: MediaMode,
): Record<string, string | number> {
  if (mode !== 'video-edit') return params
  const { duration: _duration, ...rest } = params
  return rest
}
