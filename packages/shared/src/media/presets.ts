/**
 * Known providers, as data.
 *
 * Every field here came from somebody's source rather than from guessing: metaso's MiniMax endpoint
 * from the request that produced a real video, the volcengine and xAI paths from BeefTV's protocol
 * catalogue.
 *
 * A channel in `media-channels.json` may name a preset and say only three things — `id`, `preset`,
 * and where its key lives. Everything else (base URL, paths, auth header, body shape, options) is
 * filled in from here. That is the difference between "configure a provider" and "reverse engineer a
 * provider".
 */

import type { MediaBodyShape, MediaChannel, ModelIdSource } from './channels.ts'
import type { MediaParamSpec } from './params.ts'

/**
 * The parameters the speech body shapes actually read.
 *
 * Declared once because the account presets and the per-capability presets must agree; a name the
 * body reads but the preset does not list would be refused by validation before it could be sent.
 */
const OPENAI_TTS_PARAMS: MediaParamSpec[] = [
  {
    key: 'voice',
    type: 'select',
    options: [
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
    ],
    default: 'alloy',
    allowCustom: true,
  },
  {
    key: 'format',
    type: 'select',
    options: ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'],
    default: 'mp3',
  },
  { key: 'speed', type: 'number', default: 1 },
]

const MINIMAX_TTS_PARAMS: MediaParamSpec[] = [
  {
    key: 'voice',
    type: 'select',
    options: [
      'male-qn-qingse',
      'male-qn-jingying',
      'male-qn-badao',
      'male-qn-daxuesheng',
      'female-shaonv',
      'female-yujie',
      'female-chengshu',
      'female-tianmei',
    ],
    default: 'male-qn-qingse',
    allowCustom: true,
  },
  { key: 'format', type: 'select', options: ['mp3', 'wav', 'flac', 'pcm'], default: 'mp3' },
  { key: 'speed', type: 'number', default: 1 },
  { key: 'vol', type: 'number', default: 1 },
  { key: 'pitch', type: 'number', default: 0 },
  { key: 'emotion', type: 'text' },
]

const MINIMAX_MUSIC_PARAMS: MediaParamSpec[] = [
  // The lyrics are the card's port, not a knob: one text node fills it. The card's own text is the
  // style brief, which the API calls `prompt`.
  { key: 'lyrics', type: 'text' },
  { key: 'format', type: 'select', options: ['mp3', 'wav', 'pcm'], default: 'mp3' },
  { key: 'sample_rate', type: 'number' },
  { key: 'bitrate', type: 'number' },
]

const VOLCENGINE_AUDIO_PARAMS: MediaParamSpec[] = [
  {
    key: 'voice',
    type: 'select',
    // Seed-Audio's built-in speakers. A recorded sample is named the same way, so custom ids stay
    // allowed; the list is what the panel can show without a lookup call.
    options: [
      'zh_female_vv_uranus_bigtts',
      'zh_female_xiaohe_uranus_bigtts',
      'zh_male_m191_uranus_bigtts',
      'zh_male_taocheng_uranus_bigtts',
      'zh_male_liufei_uranus_bigtts',
      'zh_female_sophie_uranus_bigtts',
      'zh_female_qingxinnvsheng_uranus_bigtts',
      'zh_female_cancan_uranus_bigtts',
      'zh_female_tianmeitaozi_uranus_bigtts',
      'zh_male_ruyayichen_uranus_bigtts',
    ],
    default: 'zh_female_vv_uranus_bigtts',
    allowCustom: true,
  },
  { key: 'format', type: 'select', options: ['wav', 'mp3', 'pcm', 'ogg_opus'], default: 'wav' },
  { key: 'speed', type: 'number' },
  { key: 'sample_rate', type: 'number' },
]

const BAILIAN_TTS_PARAMS: MediaParamSpec[] = [
  {
    key: 'voice',
    type: 'select',
    options: ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Dylan', 'Jada', 'Sunny'],
    default: 'Cherry',
    allowCustom: true,
  },
  { key: 'format', type: 'select', options: ['mp3', 'wav', 'pcm', 'opus'], default: 'mp3' },
  { key: 'language', type: 'text' },
]

/**
 * Ratio × quality charts for models that only accept one `size` string.
 *
 * The card speaks ratio + quality; these models do not. Each chart is the vendor's own pixel grid,
 * so a pair that is not listed is refused instead of rounded into a neighbouring size.
 */
const QWEN_IMAGE_SIZES: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024' },
  '16:9': { '1K': '1664x928' },
  '9:16': { '1K': '928x1664' },
}

const WAN_IMAGE_SIZES: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024*1024' },
  '16:9': { '1K': '1280*720' },
  '9:16': { '1K': '720*1280' },
  '3:4': { '1K': '832*1248' },
  '4:3': { '1K': '1248*832' },
}

const WAN_VIDEO_SIZES: Record<string, Record<string, string>> = {
  '16:9': { '720P': '1280*720' },
  '9:16': { '720P': '720*1280' },
  '1:1': { '720P': '960*960' },
}

const GPT_IMAGE_SIZES: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024' },
  '2:3': { '1K': '1024x1536' },
  '3:2': { '1K': '1536x1024' },
}

const WAN_3_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']
const MINIMAX_H3_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

/**
 * How a submit body is shaped. Providers agree on almost nothing, so this is an enum, not a guess:
 * `{ model, prompt, n }` (OpenAI images and most relays), `{ model, content: […] }` (MiniMax H3),
 * `{ model, contents: […] }` (Gemini), and one shape per speech vendor.
 */
export type BodyShape = MediaBodyShape

export interface ChannelPreset extends Partial<MediaChannel> {
  id: string
  name: string
  /** Who the account is with; shared by presets that front the same vendor. */
  providerType?: string
  /** Whether the vendor's catalogue is authoritative, or a relay may invent ids. */
  modelIdSource?: ModelIdSource
  /** Where the key can be created, for the person filling this in. */
  docs?: string
  auth?: { header: string; prefix?: string }
  bodyShape?: BodyShape
}

/**
 * The catalogue.
 *
 * `baseUrl` values are the vendors' own defaults; a channel may override any of them. Paths use
 * `{model}` and `{taskId}` placeholders, substituted at call time.
 *
 * `models` is a starting point, not an authority: vendors rename and retire model ids faster than
 * this file changes. A preset with no `models` is one whose ids could not be checked — the settings
 * page says so and offers to read the account's own list instead of storing an empty channel.
 */
export const CHANNEL_PRESETS: ChannelPreset[] = [
  {
    id: 'metaso',
    name: '秘塔 MiniMax H3（视频）',
    providerType: 'metaso',
    modelIdSource: 'registered',
    modelCatalogId: { 'MiniMax-H3': 'minimax-h3' },
    docs: 'https://metaso.cn/minimax-h3',
    protocol: 'openai-image',
    kind: 'video',
    baseUrl: 'https://metaso.cn/api/minimax',
    submitPath: '/v2/video_generation',
    pollPath: '/v2/query/video_generation/{taskId}',
    statusPath: 'task.status',
    resultPath: 'task.content.url',
    bodyShape: 'content',
    models: ['MiniMax-H3'],
    defaultModel: 'MiniMax-H3',
    paramSpecs: [
      { key: 'duration', type: 'select', options: [4, 5, 6, 8, 10, 15, 20, 25, 30], default: 4 },
      { key: 'ratio', type: 'select', options: WAN_3_RATIOS, default: '16:9' },
      // MiniMax calls the quality tier `resolution`; the card calls it 画质.
      { key: 'quality', type: 'select', options: ['768P', '2K'], default: '768P', wire: 'resolution' },
    ],
  },
  {
    id: 'openai-image',
    name: 'OpenAI（图片）',
    providerType: 'openai',
    modelIdSource: 'open',
    modelCatalogId: { 'gpt-image-1': 'gpt-image-1' },
    protocol: 'openai-image',
    kind: 'image',
    baseUrl: 'https://api.openai.com/v1',
    submitPath: '/images/generations',
    bodyShape: 'prompt',
    models: ['gpt-image-1'],
    defaultModel: 'gpt-image-1',
    paramSpecs: [
      { key: 'ratio', type: 'select', options: ['1:1', '2:3', '3:2'], default: '1:1' },
      // gpt-image-1 has one size per shape, so 1K is the only tier it knows.
      { key: 'quality', type: 'select', options: ['1K'], default: '1K', sizes: GPT_IMAGE_SIZES },
    ],
  },
  {
    id: 'grok-image',
    name: 'xAI Grok（图片）',
    providerType: 'xai',
    modelIdSource: 'registered',
    modelCatalogId: {
      'grok-2-image': 'grok-2-image',
      'grok-imagine-image': 'grok-imagine-image',
    },
    docs: 'https://docs.x.ai',
    protocol: 'openai-image',
    kind: 'image',
    baseUrl: 'https://api.x.ai/v1',
    submitPath: '/images/generations',
    bodyShape: 'prompt',
    models: ['grok-2-image', 'grok-imagine-image'],
    defaultModel: 'grok-2-image',
  },
  {
    id: 'volcengine-ark-image',
    name: '火山方舟（图片）',
    providerType: 'volcengine-ark',
    modelIdSource: 'registered',
    modelCatalogId: {
      'doubao-seedream-5-0-260128': 'seedream-5.0',
      'doubao-seedream-5-0-lite-260128': 'seedream-5.0-lite',
    },
    docs: 'https://www.volcengine.com/docs/82379',
    protocol: 'openai-image',
    kind: 'image',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    submitPath: '/images/generations',
    bodyShape: 'prompt',
    models: ['doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128'],
    defaultModel: 'doubao-seedream-5-0-260128',
  },
  {
    id: 'volcengine-ark-video',
    name: '火山方舟（视频）',
    providerType: 'volcengine-ark',
    modelIdSource: 'registered',
    modelCatalogId: {
      'doubao-seedance-2-5-260628': 'seedance-2.5',
      'doubao-seedance-2-0-260128': 'seedance-2.0',
    },
    protocol: 'openai-image',
    kind: 'video',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    submitPath: '/contents/generations/tasks',
    pollPath: '/contents/generations/tasks/{taskId}',
    statusPath: 'status',
    resultPath: 'content.video_url',
    bodyShape: 'content',
    models: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128'],
    defaultModel: 'doubao-seedance-2-5-260628',
    // Ark video takes the shape and the tier at the top level, next to `content`.
    paramSpecs: [
      { key: 'ratio', type: 'select', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], default: '16:9' },
      { key: 'quality', type: 'select', options: ['480P', '720P', '1080P'], default: '720P', wire: 'resolution' },
    ],
  },
  {
    id: 'bailian-account',
    name: '阿里云百炼',
    providerType: 'bailian',
    modelIdSource: 'registered',
    docs: 'https://help.aliyun.com/zh/model-studio/',
    protocol: 'openai-image',
    // One host and one key, three capabilities. The account base is the DashScope door most of them
    // use; Qwen-Image's own door says so on its endpoint.
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    endpoints: [
      {
        kind: 'image',
        models: [
          'qwen-image-3.0-pro',
          'qwen-image-3.0',
          'qwen-image-2.1-pro',
          'qwen-image-2.1-turbo',
          'wan2.5-t2i-preview',
          'wan2.2-t2i-flash',
          'wan2.2-t2i-plus',
          'wanx2.1-t2i-turbo',
          'wanx2.1-t2i-plus',
        ],
        defaultModel: 'qwen-image-3.0',
        modelCatalogId: {
          'qwen-image-3.0-pro': 'qwen-image-3.0-pro',
          'qwen-image-3.0': 'qwen-image-3.0',
          'qwen-image-2.1-pro': 'qwen-image-2.1-pro',
          'qwen-image-2.1-turbo': 'qwen-image-2.1-turbo',
          'wan2.5-t2i-preview': 'wan-2.5-t2i',
          'wan2.2-t2i-flash': 'wan-2.2-t2i-flash',
          'wan2.2-t2i-plus': 'wan-2.2-t2i-plus',
          'wanx2.1-t2i-turbo': 'wanx-2.1-t2i-turbo',
          'wanx2.1-t2i-plus': 'wanx-2.1-t2i-plus',
        },
        // Qwen-Image answers at once on the OpenAI-compatible door.
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        submitPath: '/images/generations',
        bodyShape: 'prompt',
        // The Wan t2i models behind the same capability queue a task instead: the protocol id is
        // the reference, so the wire lives once in `protocols.ts`.
        modelProtocols: {
          'wan2.5-t2i-preview': 'dashscope-image-task',
          'wan2.2-t2i-flash': 'dashscope-image-task',
          'wan2.2-t2i-plus': 'dashscope-image-task',
          'wanx2.1-t2i-turbo': 'dashscope-image-task',
          'wanx2.1-t2i-plus': 'dashscope-image-task',
        },
        // Only the host differs from Qwen-Image's door; the protocol supplies the rest.
        modelWires: {
          'wan2.5-t2i-preview': { baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
          'wan2.2-t2i-flash': { baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
          'wan2.2-t2i-plus': { baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
          'wanx2.1-t2i-turbo': { baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
          'wanx2.1-t2i-plus': { baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
        },
        paramSpecs: [
          {
            key: 'ratio',
            type: 'select',
            options: ['1:1', '16:9', '9:16'],
            default: '1:1',
            models: ['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo'],
          },
          {
            key: 'quality',
            type: 'select',
            options: ['1K'],
            default: '1K',
            models: ['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo'],
            sizes: QWEN_IMAGE_SIZES,
          },
          {
            key: 'ratio',
            type: 'select',
            options: ['1:1', '16:9', '9:16', '3:4', '4:3'],
            default: '1:1',
            models: ['wan2.5-t2i-preview', 'wan2.2-t2i-flash', 'wan2.2-t2i-plus', 'wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus'],
          },
          {
            key: 'quality',
            type: 'select',
            options: ['1K'],
            default: '1K',
            models: ['wan2.5-t2i-preview', 'wan2.2-t2i-flash', 'wan2.2-t2i-plus', 'wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus'],
            sizes: WAN_IMAGE_SIZES,
          },
        ],
      },
      {
        kind: 'video',
        models: ['wan3.0-video', 'wan2.6-t2v', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus'],
        defaultModel: 'wan3.0-video',
        modelCatalogId: {
          'wan3.0-video': 'wan-3.0-video',
          'wan2.6-t2v': 'wan-2.6-t2v',
          'wan2.5-t2v-preview': 'wan-2.5-t2v',
          'wan2.2-t2v-plus': 'wan-2.2-t2v',
        },
        submitPath: '/services/aigc/video-generation/video-synthesis',
        pollPath: '/tasks/{taskId}',
        taskIdPath: 'output.task_id',
        statusPath: 'output.task_status',
        resultPath: 'output.video_url',
        bodyShape: 'dashscope-video',
        submitHeaders: { 'X-DashScope-Async': 'enable' },
        pollMs: 10000,
        paramSpecs: [
          { key: 'duration', type: 'number', min: 2, max: 15, default: 5 },
          {
            key: 'ratio',
            type: 'select',
            options: WAN_3_RATIOS,
            default: '16:9',
            models: ['wan3.0-video'],
          },
          {
            key: 'quality',
            type: 'select',
            options: ['480P', '720P', '1080P'],
            default: '720P',
            models: ['wan3.0-video'],
            wire: 'resolution',
          },
          {
            key: 'ratio',
            type: 'select',
            options: ['16:9', '9:16', '1:1'],
            default: '16:9',
            models: ['wan2.6-t2v', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus'],
          },
          {
            key: 'quality',
            type: 'select',
            options: ['720P'],
            default: '720P',
            models: ['wan2.6-t2v', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus'],
            sizes: WAN_VIDEO_SIZES,
          },
        ],
      },
      {
        kind: 'tts',
        models: ['qwen3-tts-flash'],
        defaultModel: 'qwen3-tts-flash',
        modelCatalogId: { 'qwen3-tts-flash': 'qwen3-tts-flash' },
        submitPath: '/services/aigc/multimodal-generation/generation',
        bodyShape: 'dashscope-tts',
        resultPath: 'output.audio.url',
        paramSpecs: BAILIAN_TTS_PARAMS,
        params: { voice: 'Cherry' },
      },
    ],
  },
  {
    id: 'bailian-tts',
    name: '阿里云百炼 Qwen-TTS（语音合成）',
    providerType: 'bailian',
    modelIdSource: 'registered',
    modelCatalogId: { 'qwen3-tts-flash': 'qwen3-tts-flash' },
    docs: 'https://help.aliyun.com/zh/model-studio/qwen-tts-api',
    protocol: 'openai-image',
    kind: 'tts',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    submitPath: '/services/aigc/multimodal-generation/generation',
    bodyShape: 'dashscope-tts',
    resultPath: 'output.audio.url',
    models: ['qwen3-tts-flash'],
    defaultModel: 'qwen3-tts-flash',
    paramSpecs: BAILIAN_TTS_PARAMS,
    // The API requires a voice; without one the request is refused. Cherry is the documented default.
    params: { voice: 'Cherry' },
  },
  {
    id: 'bailian-image',
    name: '阿里云百炼 Qwen-Image（图片）',
    providerType: 'bailian',
    modelIdSource: 'registered',
    modelCatalogId: {
      'qwen-image-3.0-pro': 'qwen-image-3.0-pro',
      'qwen-image-3.0': 'qwen-image-3.0',
      'qwen-image-2.1-pro': 'qwen-image-2.1-pro',
      'qwen-image-2.1-turbo': 'qwen-image-2.1-turbo',
    },
    docs: 'https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference',
    protocol: 'openai-image',
    kind: 'image',
    // The OpenAI-compatible door: same `/images/generations` shape a relay speaks, so reference
    // images travel in `image` on the same call — text-to-image when it is absent, editing when it is.
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    submitPath: '/images/generations',
    bodyShape: 'prompt',
    models: [
      'qwen-image-3.0-pro',
      'qwen-image-3.0',
      'qwen-image-2.1-pro',
      'qwen-image-2.1-turbo',
    ],
    defaultModel: 'qwen-image-3.0',
    paramSpecs: [
      { key: 'ratio', type: 'select', options: ['1:1', '16:9', '9:16'], default: '1:1' },
      { key: 'quality', type: 'select', options: ['1K'], default: '1K', sizes: QWEN_IMAGE_SIZES },
    ],
  },
  {
    id: 'bailian-wan-image',
    name: '阿里云百炼 万相（图片）',
    providerType: 'bailian',
    modelIdSource: 'registered',
    modelCatalogId: {
      'wan2.5-t2i-preview': 'wan-2.5-t2i',
      'wan2.2-t2i-flash': 'wan-2.2-t2i-flash',
      'wan2.2-t2i-plus': 'wan-2.2-t2i-plus',
      'wanx2.1-t2i-turbo': 'wanx-2.1-t2i-turbo',
      'wanx2.1-t2i-plus': 'wanx-2.1-t2i-plus',
    },
    docs: 'https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference',
    protocol: 'openai-image',
    kind: 'image',
    // Wan's own door answers with a task id, unlike Qwen-Image's OpenAI-compatible one.
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    submitPath: '/services/aigc/text2image/image-synthesis',
    pollPath: '/tasks/{taskId}',
    taskIdPath: 'output.task_id',
    statusPath: 'output.task_status',
    resultPath: 'output.results.0.url',
    bodyShape: 'dashscope-image',
    submitHeaders: { 'X-DashScope-Async': 'enable' },
    models: [
      'wan2.5-t2i-preview',
      'wan2.2-t2i-flash',
      'wan2.2-t2i-plus',
      'wanx2.1-t2i-turbo',
      'wanx2.1-t2i-plus',
    ],
    defaultModel: 'wan2.5-t2i-preview',
    pollMs: 5000,
    paramSpecs: [
      { key: 'ratio', type: 'select', options: ['1:1', '16:9', '9:16', '3:4', '4:3'], default: '1:1' },
      { key: 'quality', type: 'select', options: ['1K'], default: '1K', sizes: WAN_IMAGE_SIZES },
    ],
  },
  {
    id: 'bailian-video',
    name: '阿里云百炼 万相（视频）',
    providerType: 'bailian',
    modelIdSource: 'registered',
    modelCatalogId: {
      'wan3.0-video': 'wan-3.0-video',
      'wan2.6-t2v': 'wan-2.6-t2v',
      'wan2.5-t2v-preview': 'wan-2.5-t2v',
      'wan2.2-t2v-plus': 'wan-2.2-t2v',
    },
    docs: 'https://help.aliyun.com/zh/model-studio/text-to-video-guide/',
    protocol: 'openai-image',
    kind: 'video',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    submitPath: '/services/aigc/video-generation/video-synthesis',
    pollPath: '/tasks/{taskId}',
    taskIdPath: 'output.task_id',
    statusPath: 'output.task_status',
    resultPath: 'output.video_url',
    bodyShape: 'dashscope-video',
    // Without this header the same endpoint answers as a synchronous call, not a queued task.
    submitHeaders: { 'X-DashScope-Async': 'enable' },
    models: ['wan3.0-video', 'wan2.6-t2v', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus'],
    defaultModel: 'wan3.0-video',
    pollMs: 10000,
    paramSpecs: [
      { key: 'duration', type: 'number', min: 2, max: 15, default: 5 },
      {
        key: 'ratio',
        type: 'select',
        options: WAN_3_RATIOS,
        default: '16:9',
        models: ['wan3.0-video'],
      },
      {
        key: 'quality',
        type: 'select',
        options: ['480P', '720P', '1080P'],
        default: '720P',
        models: ['wan3.0-video'],
        wire: 'resolution',
      },
      {
        key: 'ratio',
        type: 'select',
        options: ['16:9', '9:16', '1:1'],
        default: '16:9',
        models: ['wan2.6-t2v', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus'],
      },
      {
        key: 'quality',
        type: 'select',
        options: ['720P'],
        default: '720P',
        models: ['wan2.6-t2v', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus'],
        sizes: WAN_VIDEO_SIZES,
      },
    ],
  },
  {
    id: 'volcengine-audio',
    name: '火山引擎豆包语音（音频生成 / TTS）',
    providerType: 'volcengine',
    modelIdSource: 'registered',
    modelCatalogId: { 'seed-audio-1.0': 'seed-audio-1.0' },
    docs: 'https://docs.volcengine.com/docs/doubao-voice/audio-generation-http?lang=zh',
    protocol: 'openai-image',
    kind: 'tts',
    baseUrl: 'https://openspeech.bytedance.com/api',
    submitPath: '/v3/tts/create',
    bodyShape: 'volcengine-audio',
    resultPath: 'url',
    auth: { header: 'X-Api-Key', prefix: '' },
    models: ['seed-audio-1.0'],
    defaultModel: 'seed-audio-1.0',
    paramSpecs: VOLCENGINE_AUDIO_PARAMS,
  },
  {
    id: 'volcengine-music',
    name: '火山豆包音频生成（音乐 / 音效）',
    providerType: 'volcengine',
    modelIdSource: 'registered',
    // The same model composes sound as it does speech; the prompt is where the difference lives.
    modelCatalogId: { 'seed-audio-1.0': 'seed-audio-1.0' },
    docs: 'https://docs.volcengine.com/docs/doubao-voice/audio-generation-http?lang=zh',
    protocol: 'openai-image',
    kind: 'music',
    baseUrl: 'https://openspeech.bytedance.com/api',
    submitPath: '/v3/tts/create',
    bodyShape: 'volcengine-audio',
    resultPath: 'url',
    auth: { header: 'X-Api-Key', prefix: '' },
    models: ['seed-audio-1.0'],
    defaultModel: 'seed-audio-1.0',
    paramSpecs: VOLCENGINE_AUDIO_PARAMS,
  },
  {
    id: 'openai-tts',
    name: 'OpenAI 语音合成（TTS）',
    providerType: 'openai',
    modelIdSource: 'registered',
    modelCatalogId: {
      'gpt-4o-mini-tts': 'gpt-4o-mini-tts',
      'tts-1': 'tts-1',
      'tts-1-hd': 'tts-1-hd',
    },
    docs: 'https://platform.openai.com/docs/guides/text-to-speech',
    protocol: 'openai-image',
    kind: 'tts',
    baseUrl: 'https://api.openai.com/v1',
    submitPath: '/audio/speech',
    bodyShape: 'openai-speech',
    responseShape: 'binary',
    models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    defaultModel: 'gpt-4o-mini-tts',
    paramSpecs: OPENAI_TTS_PARAMS,
  },
  {
    id: 'minimax-video',
    name: 'MiniMax 视频（H3）',
    providerType: 'minimax',
    modelIdSource: 'registered',
    modelCatalogId: {
      'MiniMax-H3': 'minimax-h3',
      'MiniMax-H3-Max': 'minimax-h3-max',
      'MiniMax-H3-Highspeed': 'minimax-h3-highspeed',
      'MiniMax-H3-Lite': 'minimax-h3-lite',
    },
    docs: 'https://platform.minimax.cn/docs/api-reference/video-generation-v2-create',
    protocol: 'openai-image',
    kind: 'video',
    baseUrl: 'https://api.minimax.cn',
    submitPath: '/v2/video_generation',
    pollPath: '/v2/query/video_generation/{taskId}',
    statusPath: 'task.status',
    resultPath: 'task.content.url',
    bodyShape: 'content',
    models: ['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite'],
    defaultModel: 'MiniMax-H3',
    pollMs: 5000,
    // Reference images/audio/video are uploaded first and written as `mm_file://…`: the request
    // body stays small, and MiniMax validates the file at upload time.
    upload: {
      path: '/v1/files/upload',
      purpose: 'video_generation_input',
      refPrefix: 'mm_file://',
    },
    paramSpecs: [
      { key: 'duration', type: 'select', options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], default: 4 },
      { key: 'ratio', type: 'select', options: MINIMAX_H3_RATIOS, default: '16:9' },
      { key: 'quality', type: 'select', options: ['768P', '2K'], default: '768P', wire: 'resolution' },
    ],
  },
  {
    id: 'minimax-image',
    name: 'MiniMax 图像（image-01）',
    providerType: 'minimax',
    modelIdSource: 'registered',
    modelCatalogId: {
      'image-01': 'image-01',
      'image-01-live': 'image-01-live',
    },
    docs: 'https://platform.minimaxi.com/docs/guides/image-generation',
    protocol: 'openai-image',
    kind: 'image',
    baseUrl: 'https://api.minimax.cn/v1',
    submitPath: '/image_generation',
    bodyShape: 'minimax-image',
    models: ['image-01', 'image-01-live'],
    defaultModel: 'image-01',
    options: {
      ratio: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'],
    },
  },
  {
    id: 'minimax-h3-image',
    name: 'MiniMax H3 图像（H3-Image）',
    providerType: 'minimax',
    modelIdSource: 'registered',
    modelCatalogId: {
      'MiniMax-H3-Image': 'minimax-h3-image',
      'MiniMax-H3-Image-Highspeed': 'minimax-h3-image-highspeed',
    },
    docs: 'https://platform.minimax.cn/docs/api-reference/image-generation-h3-generations',
    protocol: 'openai-image',
    kind: 'image',
    baseUrl: 'https://api.minimax.cn',
    // Text-to-image and reference editing are two paths of the same capability: the shape picks
    // the path from whether the request carries references.
    submitPath: '/v1/images/generations',
    editPath: '/v1/images/edits',
    bodyShape: 'minimax-h3-image',
    referenceLabels: { image: '图{n}' },
    models: ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'],
    defaultModel: 'MiniMax-H3-Image',
    paramSpecs: [
      {
        key: 'ratio',
        type: 'select',
        options: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '3:1', '1:3'],
        default: 'auto',
      },
      { key: 'quality', type: 'select', options: ['1K', '2K', '4K'], default: '2K', wire: 'area' },
      { key: 'format', type: 'select', options: ['jpeg', 'png', 'webp'], default: 'jpeg' },
      { key: 'compression', type: 'number', min: 0, max: 100, default: 95 },
    ],
  },
  {
    id: 'minimax-tts',
    name: 'MiniMax 语音合成（speech-2.8）',
    providerType: 'minimax',
    modelIdSource: 'registered',
    modelCatalogId: {
      'speech-2.8-hd': 'speech-2.8-hd',
      'speech-2.8-turbo': 'speech-2.8-turbo',
      'speech-2.6-hd': 'speech-2.6-hd',
      'speech-2.6-turbo': 'speech-2.6-turbo',
      'speech-02-hd': 'speech-02-hd',
      'speech-02-turbo': 'speech-02-turbo',
    },
    docs: 'https://platform.minimaxi.com/docs/api-reference/speech-t2a-http',
    protocol: 'openai-image',
    kind: 'tts',
    baseUrl: 'https://api.minimax.cn/v1',
    submitPath: '/t2a_v2',
    bodyShape: 'minimax-tts',
    resultPath: 'data.audio',
    models: [
      'speech-2.8-hd',
      'speech-2.8-turbo',
      'speech-2.6-hd',
      'speech-2.6-turbo',
      'speech-02-hd',
      'speech-02-turbo',
    ],
    defaultModel: 'speech-2.8-hd',
    paramSpecs: MINIMAX_TTS_PARAMS,
  },
  {
    id: 'minimax-music',
    name: 'MiniMax 音乐生成（music-1.5）',
    providerType: 'minimax',
    modelIdSource: 'registered',
    modelCatalogId: { 'music-1.5': 'music-1.5' },
    docs: 'https://platform.minimaxi.com/document/Music%20Generation?key=667cd92e3be2027f69b723dd',
    protocol: 'openai-image',
    kind: 'music',
    baseUrl: 'https://api.minimax.cn/v1',
    submitPath: '/music_generation',
    bodyShape: 'minimax-music',
    resultPath: 'data.audio',
    models: ['music-1.5'],
    defaultModel: 'music-1.5',
    // The card's text is the lyrics; style travels as a parameter.
    textRole: 'lyrics',
    paramSpecs: MINIMAX_MUSIC_PARAMS,
  },
  {
    id: 'minimax-account',
    name: 'MiniMax 官方',
    providerType: 'minimax',
    modelIdSource: 'registered',
    docs: 'https://platform.minimax.cn/docs',
    protocol: 'openai-image',
    baseUrl: 'https://api.minimax.cn',
    // One key, three capabilities. The paths differ per kind, so they live on the endpoint and the
    // account keeps only what the three share: the host and the key.
    endpoints: [
      {
        kind: 'video',
        models: ['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite'],
        defaultModel: 'MiniMax-H3',
        modelCatalogId: {
          'MiniMax-H3': 'minimax-h3',
          'MiniMax-H3-Max': 'minimax-h3-max',
          'MiniMax-H3-Highspeed': 'minimax-h3-highspeed',
          'MiniMax-H3-Lite': 'minimax-h3-lite',
        },
        submitPath: '/v2/video_generation',
        pollPath: '/v2/query/video_generation/{taskId}',
        statusPath: 'task.status',
        resultPath: 'task.content.url',
        bodyShape: 'content',
        pollMs: 5000,
        upload: {
          path: '/v1/files/upload',
          purpose: 'video_generation_input',
          refPrefix: 'mm_file://',
        },
        paramSpecs: [
          { key: 'duration', type: 'select', options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], default: 4 },
          { key: 'ratio', type: 'select', options: MINIMAX_H3_RATIOS, default: '16:9' },
          { key: 'quality', type: 'select', options: ['768P', '2K'], default: '768P', wire: 'resolution' },
        ],
      },
      {
        kind: 'image',
        models: ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'],
        defaultModel: 'MiniMax-H3-Image',
        modelCatalogId: {
          'MiniMax-H3-Image': 'minimax-h3-image',
          'MiniMax-H3-Image-Highspeed': 'minimax-h3-image-highspeed',
        },
        submitPath: '/v1/images/generations',
        editPath: '/v1/images/edits',
        bodyShape: 'minimax-h3-image',
        referenceLabels: { image: '图{n}' },
        paramSpecs: [
          {
            key: 'ratio',
            type: 'select',
            options: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '3:1', '1:3'],
            default: 'auto',
          },
          { key: 'quality', type: 'select', options: ['1K', '2K', '4K'], default: '2K', wire: 'area' },
          { key: 'format', type: 'select', options: ['jpeg', 'png', 'webp'], default: 'jpeg' },
          { key: 'compression', type: 'number', min: 0, max: 100, default: 95 },
        ],
      },
      {
        kind: 'tts',
        models: [
          'speech-2.8-hd',
          'speech-2.8-turbo',
          'speech-2.6-hd',
          'speech-2.6-turbo',
          'speech-02-hd',
          'speech-02-turbo',
        ],
        defaultModel: 'speech-2.8-hd',
        modelCatalogId: {
          'speech-2.8-hd': 'speech-2.8-hd',
          'speech-2.8-turbo': 'speech-2.8-turbo',
          'speech-2.6-hd': 'speech-2.6-hd',
          'speech-2.6-turbo': 'speech-2.6-turbo',
          'speech-02-hd': 'speech-02-hd',
          'speech-02-turbo': 'speech-02-turbo',
        },
        submitPath: '/v1/t2a_v2',
        bodyShape: 'minimax-tts',
        resultPath: 'data.audio',
        paramSpecs: MINIMAX_TTS_PARAMS,
      },
      {
        kind: 'music',
        models: ['music-1.5'],
        defaultModel: 'music-1.5',
        modelCatalogId: { 'music-1.5': 'music-1.5' },
        submitPath: '/v1/music_generation',
        bodyShape: 'minimax-music',
        resultPath: 'data.audio',
        // The card's text is the lyrics; style travels as a parameter.
        textRole: 'lyrics',
        paramSpecs: MINIMAX_MUSIC_PARAMS,
      },
    ],
  },
  {
    id: 'gemini-image',
    name: 'Google Gemini（图片）',
    providerType: 'google',
    modelIdSource: 'registered',
    modelCatalogId: { 'gemini-3-pro-image': 'gemini-3-pro-image' },
    docs: 'https://ai.google.dev',
    protocol: 'openai-image',
    kind: 'image',
    baseUrl: 'https://generativelanguage.googleapis.com',
    submitPath: '/v1beta/models/{model}:generateContent',
    bodyShape: 'gemini',
    auth: { header: 'x-goog-api-key' },
    models: ['gemini-3-pro-image'],
    defaultModel: 'gemini-3-pro-image',
    // Gemini takes both inside `imageConfig`: the shape is `aspectRatio`, the tier `imageSize`.
    paramSpecs: [
      {
        key: 'ratio',
        type: 'select',
        options: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
        default: '1:1',
      },
      { key: 'quality', type: 'select', options: ['1K', '2K', '4K'], default: '1K' },
    ],
  },
]

/**
 * What Settings › Media channels may add.
 *
 * Every preset here is a generation account. Recognition is not one: its wire lives beside the
 * speech settings (`asr-config.ts`) and is reached with the person's own key.
 */
export const GENERATION_CHANNEL_PRESETS = CHANNEL_PRESETS

export function findChannelPreset(id: string | undefined): ChannelPreset | null {
  if (!id) return null
  return CHANNEL_PRESETS.find((preset) => preset.id === id) ?? null
}
