/**
 * Asking a vision model what a picture is.
 *
 * "反推提示词" is the one feature that turns a node into a prompt: give it an image, get back the
 * words that would have made it. It is a chat call rather than an image call, so it lives beside the
 * image adapters but does not share their shape.
 *
 * The answer is asked for as **a prompt**, not a description: a description reads like a caption and
 * produces a caption back, while what the next node needs is somebody's instructions.
 */

import { MediaFailure } from '../types.ts'

export interface DescribeImageRequest {
  baseUrl: string
  apiKey: string
  model: string
  /** The image as a data URL — nothing here needs to reach a CDN. */
  imageDataUrl: string
  /** Extra direction from the panel, e.g. "capture the lighting". */
  instruction?: string
  auth?: { header: string; prefix?: string }
  fetch?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_INSTRUCTION =
  'Look at this image and write a single image-generation prompt that would reproduce it: ' +
  'subject, composition, lighting, colour, style, camera. Answer with the prompt only — no preamble, ' +
  'no quotes, no list.'

export async function describeImageOverApi(request: DescribeImageRequest): Promise<string> {
  const fetchImpl = request.fetch ?? fetch
  const base = request.baseUrl.replace(/\/+$/, '')
  const header = request.auth?.header ?? 'Authorization'
  const prefix = request.auth?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '')
  const timeoutMs = request.timeoutMs ?? 90_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { [header]: `${prefix}${request.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: request.instruction?.trim() || DEFAULT_INSTRUCTION },
              { type: 'image_url', image_url: { url: request.imageDataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    }).catch((error: unknown) => {
      throw new MediaFailure(
        'generate',
        controller.signal.aborted
          ? `反推失败：${Math.round(timeoutMs / 1000)} 秒内没有回答`
          : `反推失败：连不上 ${base}（${error instanceof Error ? error.message : String(error)}）`,
      )
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new MediaFailure(
        'generate',
        response.status === 401 || response.status === 403
          ? '反推失败：密钥被拒绝'
          : `反推失败：HTTP ${response.status} ${body.slice(0, 160)}`,
      )
    }

    const payload = (await response.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: unknown } }> }
      | null
    const content = payload?.choices?.[0]?.message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
              .join('')
          : ''
    const cleaned = text.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()
    if (!cleaned) throw new MediaFailure('generate', '反推失败：模型没有给出内容')
    return cleaned
  } finally {
    clearTimeout(timer)
  }
}
