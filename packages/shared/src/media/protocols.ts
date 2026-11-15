/**
 * The wire shapes a model can speak, as data.
 *
 * A model is a name plus a protocol: where it posts, how the body is shaped, and whether it answers
 * at once or queues a task. Vendor models come with their protocol from `presets.ts`; a model a
 * person adds themselves picks one from this list — the point is that two providers with the same
 * shape share one entry, not that every provider needs its own settings page.
 *
 * Paths are relative to the connection's base URL, exactly like the preset wires they came from.
 */

import type { MediaKind, MediaModelWire } from './channels.ts'

export interface MediaProtocol {
  id: string
  /** Shown in the protocol picker; says the vendor shape, not a product name. */
  name: string
  /** The capabilities this shape can serve. */
  kinds: MediaKind[]
  wire: MediaModelWire
}

const DASHSCOPE_ASYNC = { 'X-DashScope-Async': 'enable' }

export const MEDIA_PROTOCOLS: MediaProtocol[] = [
  {
    id: 'openai-images',
    name: 'OpenAI Images（同步）',
    kinds: ['image'],
    wire: { submitPath: '/images/generations', bodyShape: 'prompt' },
  },
  {
    id: 'minimax-image',
    name: 'MiniMax 图像（同步）',
    kinds: ['image'],
    wire: { submitPath: '/v1/image_generation', bodyShape: 'minimax-image' },
  },
  {
    id: 'minimax-h3-image',
    name: 'MiniMax H3 图像（同步）',
    kinds: ['image'],
    wire: {
      submitPath: '/v1/images/generations',
      editPath: '/v1/images/edits',
      bodyShape: 'minimax-h3-image',
    },
  },
  {
    id: 'dashscope-image-task',
    name: '百炼万相图片（异步任务）',
    kinds: ['image'],
    wire: {
      submitPath: '/services/aigc/text2image/image-synthesis',
      pollPath: '/tasks/{taskId}',
      taskIdPath: 'output.task_id',
      statusPath: 'output.task_status',
      resultPath: 'output.results.0.url',
      bodyShape: 'dashscope-image',
      submitHeaders: DASHSCOPE_ASYNC,
      pollMs: 5000,
    },
  },
  {
    id: 'gemini-image',
    name: 'Gemini 图片（同步）',
    kinds: ['image'],
    wire: { submitPath: '/v1beta/models/{model}:generateContent', bodyShape: 'gemini' },
  },
  {
    id: 'content-video-task',
    name: '火山方舟视频（异步任务）',
    kinds: ['video'],
    wire: {
      submitPath: '/contents/generations/tasks',
      pollPath: '/contents/generations/tasks/{taskId}',
      statusPath: 'status',
      resultPath: 'content.video_url',
      bodyShape: 'content',
    },
  },
  {
    id: 'minimax-video-task',
    name: 'MiniMax 视频（异步任务）',
    kinds: ['video'],
    wire: {
      submitPath: '/v2/video_generation',
      pollPath: '/v2/query/video_generation/{taskId}',
      statusPath: 'task.status',
      resultPath: 'task.content.url',
      bodyShape: 'content',
      pollMs: 5000,
    },
  },
  {
    id: 'dashscope-video-task',
    name: '百炼万相视频（异步任务）',
    kinds: ['video'],
    wire: {
      submitPath: '/services/aigc/video-generation/video-synthesis',
      pollPath: '/tasks/{taskId}',
      taskIdPath: 'output.task_id',
      statusPath: 'output.task_status',
      resultPath: 'output.video_url',
      bodyShape: 'dashscope-video',
      submitHeaders: DASHSCOPE_ASYNC,
      pollMs: 10000,
    },
  },
  {
    id: 'openai-speech',
    name: 'OpenAI 语音合成（同步，二进制）',
    kinds: ['tts'],
    wire: {
      submitPath: '/audio/speech',
      bodyShape: 'openai-speech',
      responseShape: 'binary',
    },
  },
  {
    id: 'dashscope-tts',
    name: '百炼语音合成（同步）',
    kinds: ['tts'],
    wire: {
      submitPath: '/services/aigc/multimodal-generation/generation',
      bodyShape: 'dashscope-tts',
      resultPath: 'output.audio.url',
    },
  },
  {
    id: 'minimax-tts',
    name: 'MiniMax 语音合成（同步）',
    kinds: ['tts'],
    wire: { submitPath: '/v1/t2a_v2', bodyShape: 'minimax-tts', resultPath: 'data.audio' },
  },
  {
    id: 'volcengine-audio',
    name: '火山音频生成（同步）',
    kinds: ['tts', 'music'],
    wire: {
      submitPath: '/v3/tts/create',
      bodyShape: 'volcengine-audio',
      resultPath: 'url',
    },
  },
  {
    id: 'minimax-music',
    name: 'MiniMax 音乐（同步）',
    kinds: ['music'],
    wire: { submitPath: '/v1/music_generation', bodyShape: 'minimax-music', resultPath: 'data.audio' },
  },
]

export function protocolsForKind(kind: MediaKind): MediaProtocol[] {
  return MEDIA_PROTOCOLS.filter((protocol) => protocol.kinds.includes(kind))
}

export function findMediaProtocol(id: string | undefined): MediaProtocol | null {
  return MEDIA_PROTOCOLS.find((protocol) => protocol.id === id) ?? null
}
