/**
 * Prompt markers for ordered references.
 *
 * Most providers take references as arrays and expect the prompt to name them the way their own
 * docs do: `图片1`, `Image 1`, `@图片1`, or `首帧` / `尾帧`. The canvas keeps one order — the
 * numbered strip in the composer — and the marker `{{ref N}}` points at item N of that order.
 *
 * This module is the one place that turns markers into a provider's words. It is pure: the renderer
 * and the tool both call it before a request is built, so a task file stores the same text that
 * was sent.
 */

import { MediaFailure } from './types.ts'

export type PromptReferenceType = 'image' | 'video' | 'audio' | 'firstFrame' | 'lastFrame'

/** One item in the order the composer shows. `index` is the zero-based index inside its own array. */
export interface PromptReference {
  type: PromptReferenceType
  index?: number
}

/**
 * How a channel names its references. `{n}` is replaced by the one-based number inside that array.
 * A channel that omits a kind keeps the default (`图片{n}` / `视频{n}` / `音频{n}`).
 */
export interface PromptReferenceLabels {
  image?: string
  video?: string
  audio?: string
  firstFrame?: string
  lastFrame?: string
}

const DEFAULT_LABELS: Required<PromptReferenceLabels> = {
  image: '图片{n}',
  video: '视频{n}',
  audio: '音频{n}',
  firstFrame: '首帧',
  lastFrame: '尾帧',
}

const MARKER = /\{\{ref (\d+)\}\}/g

/**
 * Replace every `{{ref N}}` with the label of item N.
 *
 * A marker with no item is refused: letting it reach the provider would generate with a prompt
 * that refers to something that was never sent, and the failure would look like a bad model.
 */
export function rewritePromptReferences(
  prompt: string,
  references: readonly PromptReference[] = [],
  labels: PromptReferenceLabels = {},
): string {
  return prompt.replace(MARKER, (marker, raw: string) => {
    const position = Number(raw)
    const reference = references[position - 1]
    if (!reference) {
      throw new MediaFailure('generate', `提示词里的 ${marker} 没有对应素材，请重新选择参考。`, {
        code: 'invalid_request',
        field: 'prompt',
      })
    }
    if (reference.type === 'firstFrame' || reference.type === 'lastFrame') {
      return labels[reference.type] ?? DEFAULT_LABELS[reference.type]
    }
    const index = reference.index
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      throw new MediaFailure('generate', `${marker} 的素材编号无效。`, {
        code: 'invalid_request',
        field: 'prompt',
      })
    }
    const template = labels[reference.type] ?? DEFAULT_LABELS[reference.type]
    return template.replace('{n}', String(index + 1))
  })
}
