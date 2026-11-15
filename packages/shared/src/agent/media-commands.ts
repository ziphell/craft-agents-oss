/**
 * `media_tool` — the door to accounts: make a media file.
 *
 * The machine's answer is a **channel**: a provider account with a base URL, a key and the models
 * it can reach (`media-channels.json`). That is the whole vocabulary — no workflow files, no
 * per-provider adapter, nothing that only works on one machine. The tool asks a channel for bytes
 * and leaves them where the caller says, then writes the note that says what they were made from.
 *
 * What is deliberately **not** here: decoding a recording (`recording_tool`), editing a picture
 * (`img-tool`), and reading pixels into words (`call_llm`). Those need no account, and mixing them
 * in would make this door's brief promise work this machine cannot do.
 *
 * ```
 * generate --prompt <text|@file> --out <path> [--channel <id>] [--model <m>] [--quality <tier>]
 *          [--kind image|video] [--param key=value]… [--input <file>]…
 * channels | task --out <path> | cancel --out <path>
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  advanceMediaTask,
  cancelOrDetachMediaTask,
  createMediaTask,
  dataUrlOfFile,
  fileNameForMime,
  generateMedia,
  isChannelEnabled,
  isLegacyChatChannel,
  isMediaFile,
  isSubtitleFile,
  listMediaTasks,
  MediaFailure,
  mediaKindOfFile,
  readMediaTask,
  rewritePromptReferences,
  validateMediaRequest,
  writeMediaTask,
} from '../media/index.ts'
import {
  channelForChoice,
  channelForKind,
  enabledChannelsFor,
  endpointsOf,
  isSoundKind,
  mediaChannelKey,
  mediaChannelModel,
  mediaChannelForModel,
  mediaChannelsPath,
  modelInfoOf,
  modelMode,
  paramsForModel,
  paramSpecsOf,
  readMediaChannels,
  readMediaSettings,
  videoEditProblem,
  withStoredKeys,
  type MediaChannel,
  type MediaParamSpec,
  type MediaSettings,
} from '../media/index.ts'
import { toPosix } from '../provenance/paths.ts'
import { writeGenerationRecord } from '../provenance/storage.ts'
import {
  isInside,
  resolveContentRoots,
  resolveFilePath,
  type ContentRoots,
} from './content-paths.ts'
import {
  resolveLocalPath,
  tokenizeCommand,
  type BrowserCommandResult,
} from './command-cli.ts'

const say = (output: string, failed = false): BrowserCommandResult => ({
  output: failed ? `Error: ${output}` : output,
  appendReleaseHint: failed,
})

/** What `generate` may make. Transcription is not generation: it has its own tool. */
const GENERATE_KINDS = ['image', 'video', 'music', 'tts'] as const

/** What a task may be, for `tasks --status`. Mirrors `MediaTaskStatus`. */
const TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'submission_unknown',
] as const

const isGenerateKind = (value: string | undefined): value is (typeof GENERATE_KINDS)[number] =>
  typeof value === 'string' && (GENERATE_KINDS as readonly string[]).includes(value)

/**
 * Leave the note beside the file: what it was made from, so the project can read the lineage back
 * later. A file outside the conversation's content root gets none — there is nowhere that would
 * read it.
 *
 * Written after the bytes are on disk, and never allowed to fail the run: the picture is the
 * answer, the note is only how it is found again.
 */
function noteGeneration(
  filePath: string,
  roots: ContentRoots,
  facts: {
    prompt: string
    references: string[]
    /** The frames, when the run used roles instead of numbered references. */
    firstFrame?: string
    lastFrame?: string
    channel: string
    params?: Record<string, string | number>
    /** The conversation that asked, so the file can be traced back from the library. */
    session?: string
  },
): void {
  try {
    // A project's notes are project-relative; a session's are relative to its own root. Either
    // way the library that reads them walks the same folder.
    const recordRoot = roots.projectDir ?? roots.contentRoot
    if (!isInside(recordRoot, filePath)) return
    const asRecorded = (path: string) =>
      isInside(recordRoot, path) ? toPosix(relative(recordRoot, path)) : path
    writeGenerationRecord(filePath, {
      file: asRecorded(filePath),
      prompt: facts.prompt,
      references: facts.references.map(asRecorded),
      ...(facts.firstFrame ? { firstFrame: asRecorded(facts.firstFrame) } : {}),
      ...(facts.lastFrame ? { lastFrame: asRecorded(facts.lastFrame) } : {}),
      channel: facts.channel,
      params: facts.params,
      session: facts.session,
      at: Date.now(),
    })
  } catch {
    // The file is the answer; the note only says where it came from.
  }
}

export function mediaHelp(): string {
  return `Generate an image, a clip, music or speech through a channel this machine is configured with.

\`generate --prompt <text|@file> [--out <path>] [flags]\`
\`task --out <path>\` | \`detach --out <path>\` | \`tasks [--kind image|video|music|tts] [--status <s>]\`
\`channels\` | \`models --channel <id> [--kind <k>] [--model <m>]\`

- \`--out\`  where the file goes: an absolute path, or a handle — \`assets/x.png\` relative to this
  conversation's content root (its project folder, or its own folder in a plain conversation), or
  \`project:\` / \`session:\` / \`cwd:\` / \`workspace:\` naming a root. Replies print the absolute path.
  Omitted, it lands under \`<contentRoot>/assets/<timestamp>-<slug>.<ext>\` (ext picked from
  \`--kind\`), so a generated file is an asset with its source note beside it.
- \`--prompt\`  what to make. Repeatable; \`@briefs/shot.md\` reads it from a file.
- \`--input\`   a file to send as a reference, repeatable. Local files are read here and delivered
  the way the channel expects. Images, videos and audios may be mixed; a channel that cannot take
  one refuses the run instead of dropping it. In order, so \`{{ref 1}}\` names the first one and the
  channel rewrites it to its own wording (\`图片1\`, \`Image 1\`…). Text is not a reference: put it in
  \`--prompt\` or \`--prompt @file\`.
- \`--first-frame\`, \`--last-frame\`  the picture a clip starts on, and the one it must end on. Roles,
  not numbered references, so they are not part of the \`--input\` order.
- \`--channel\` which account to use, by id. Omitted: the first one that makes this kind. One
  account may make several kinds, so the same id can appear under \`--kind video\` and \`--kind image\`.
- \`--model\`   a model name that channel lists. Omitted: the channel's own default.
- \`--kind\`    \`image\` (default), \`video\`, \`music\` or \`tts\`. A speech channel reads text aloud;
  a music channel composes sound. Neither is a reference kind: \`--input\` still takes audio files.
- \`--duration\`, \`--quality\`, \`--ratio\`, \`--voice\`, \`--format\`  the choices \`channels\` lists for
  that account. Omitted: the channel's own default. A model marked \`video edit\` is the one exception:
  it takes exactly one \`--input\` video, nothing else beside it, and keeps that video's length, so
  \`--duration\` is refused.
- \`--quality\` the picture/video tier: images are usually \`1K\`/\`2K\`/\`4K\`, videos \`480P\`/\`720P\`/\`1080P\`
  or \`768P\`/\`2K\`, whichever that model lists. Copy the value as printed; the channel owns the pixels.
- \`--lyrics\`  \`--kind music\` only: the words, as text or \`@song.txt\`. The prompt is the style
  brief; a model that composes without words takes no lyrics.
- \`--param\`   a parameter the model lists, \`key=value\`, repeatable. Ask \`channels\` for the values
  each model accepts; a name the model does not declare is refused. A hand-written channel that
  names its own fields is followed as written (\`--param size=1024x1024\`).

\`channels\` lists the accounts, each model, and the values each model accepts. \`models --channel <id>\`
is the detail for one account: the parameter names, voices, formats, limits and one sentence of
usage. Ask \`channels\` first; two vendors spell the same choice differently, and \`models\` is where
that is said.

Reading media is not this door's: what a picture *shows* is read by \`call_llm\` with its path as an
attachment, the words printed on one are \`img-tool text\` (local, exact characters), and a recording
is understood with \`recording_tool understand <file> --prompt "<question>"\` or transcribed with
\`recording_tool audio <file> --out words.wav\` then \`asr_tool transcribe words.wav\`.

Local pixel changes (crop, rotate, flip, resize, convert, normalize, watermark, composite) are \`img-tool\`'s.
This door is for content that needs an account.

\`channels\` lists the accounts this machine has, each capability's models, and the parameters
each model offers — ask it before naming a channel, a model, or a parameter. A parameter it lists
is passed as \`--param key=value\`.

A channel that answers with a task id returns as soon as it is submitted: the file lands later,
and \`task --out <path>\` says how it is doing. \`tasks\` lists every unfinished job under the
conversation's content root, so a path can be found again after the reply scrolls away.
\`detach --out <path>\` stops waiting — most providers cannot actually stop a job, so the file may
still arrive later.

The file is written as the provider returned it, and the note beside it records the prompt, the
references, the channel and the model. A failure names its layer — 上传失败 / 审核不通过 / 生成失败 /
下载失败 — because the four are fixed differently.`
}

/** One sentence for a video-edit input rule, naming the channel it belongs to. */
function videoEditProblemText(problem: 'needs-one-video' | 'video-only', channel: string): string {
  return problem === 'needs-one-video'
    ? `"${channel}" needs exactly one video input for video edit — none is already wrong, two is ambiguous.`
    : `"${channel}" edits one video and takes nothing else: remove the images, audio or frames.`
}

/** One parameter as a phrase an agent can copy: `duration 4/5/8 (default 5)`, `strength 0..1`. */
function describeParam(spec: MediaParamSpec): string {
  if (spec.type === 'select' && spec.options?.length) {
    const fallback = spec.default !== undefined ? ` (default ${spec.default})` : ''
    return `${spec.key} ${spec.options.join('/')}${fallback}`
  }
  if (spec.type === 'number') {
    const range =
      spec.min !== undefined && spec.max !== undefined ? `${spec.min}..${spec.max}` : 'number'
    return `${spec.key} ${range}${spec.default !== undefined ? ` (default ${spec.default})` : ''}`
  }
  return `${spec.key} text`
}

/** What this machine can make — the answer to "which channel, which model, which parameters?". */
export function formatChannels(channels: MediaChannel[], problem?: string): string {
  if (problem) return problem
  if (channels.length === 0) {
    return (
      'No channels are configured. Write one in ' +
      `${mediaChannelsPath()}, for example:\n` +
      ' {"channels": [{"id": "relay", "name": "中转", "protocol": "openai-image", ' +
      '"baseUrl": "https://api.example.com/v1", "apiKeyEnv": "MY_IMAGE_KEY", ' +
      '"models": ["image-model"], "defaultModel": "image-model"}]}'
    )
  }
  return channels
    .flatMap((channel) => {
      const endpoints = endpointsOf(channel).filter((endpoint) => isGenerateKind(endpoint.kind))
      // Recognition is not this door's; a channel that only transcribes has nothing to list here.
      if (endpoints.length === 0) return []
      const kinds = [...new Set(endpoints.map((endpoint) => endpoint.kind))]
      const key = mediaChannelKey(channel) ? '' : '（缺密钥）'
      const off = isChannelEnabled(channel) ? '' : '（已停用）'
      // An account may offer several capabilities; each one has its own models and choices, so
      // each is a line — an agent that sees `image` on this id must not hand it a video prompt.
      const lines = [`${channel.id} — ${channel.name}, ${kinds.join('/')}${key}${off}`]
      for (const endpoint of endpoints) {
        const capability = channelForKind(channel, endpoint.kind) ?? channel
        const defaultModel = capability.defaultModel ? ` [default ${capability.defaultModel}]` : ''
        const modeNote = (model: string) =>
          modelMode(capability, model) === 'video-edit'
            ? ' (video edit: one video, keeps its length)'
            : ''
        const models =
          capability.models.length > 0
            ? `${capability.models.map((model) => `${model}${modeNote(model)}`).join(', ')}${defaultModel}`
            : '（没有列出模型）'
        // The choices, not just the model list: an agent that knows `duration 5/10` and
        // `voice Cherry/Serena` can fill the call without knowing the vendor's field names. A
        // duration is not offered when every model edits a video, because the input decides it.
        const specs = paramSpecsOf(capability)
        const allEdit =
          capability.models.length > 0 &&
          capability.models.every((model) => modelMode(capability, model) === 'video-edit')
        const shared = (specs ?? []).filter(
          (spec) => !spec.models?.length && !(spec.key === 'duration' && allEdit),
        )
        const byModel = new Map<string, MediaParamSpec[]>()
        for (const spec of specs ?? []) {
          for (const model of spec.models ?? []) {
            // A video edit keeps the input's length; listing a duration for it would invite a flag
            // that is refused.
            if (spec.key === 'duration' && modelMode(capability, model) === 'video-edit') continue
            byModel.set(model, [...(byModel.get(model) ?? []), spec])
          }
        }
        lines.push(`  ${endpoint.kind}: ${models}`)
        if (shared.length > 0) lines.push(`    options: ${shared.map(describeParam).join(' · ')}`)
        for (const [model, list] of byModel) {
          lines.push(`    ${model}: ${list.map(describeParam).join(' · ')}`)
        }
      }
      return [lines.join('\n')]
    })
    .join('\n')
}

function valueOf(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag)
  return index >= 0 ? tokens[index + 1] : undefined
}

function allOf(tokens: string[], flag: string): string[] {
  const values: string[] = []
  tokens.forEach((token, index) => {
    if (token === flag && tokens[index + 1]) values.push(tokens[index + 1]!)
  })
  return values
}

/**
 * The prompt, from one or more values.
 *
 * `@path` reads a value from a file: a value that starts with `@` names a file whose contents are
 * the value. `--prompt` is repeatable, and the values are joined
 * in the order they were written — so a brief can be a document and the direction for this shot can
 * be the next argument, instead of the agent pasting both into one quoted string.
 */
export function resolvePrompt(
  raw_values: readonly string[],
  cwd: string,
): { prompt: string } | { error: string } {
  if (raw_values.length === 0) {
    return { error: 'generate needs --prompt <text|@file> — what to make.' }
  }
  const parts: string[] = []
  for (const raw of raw_values) {
    if (!raw.startsWith('@')) {
      if (raw.trim()) parts.push(raw.trim())
      continue
    }
    const file = raw.slice(1).trim()
    if (!file) return { error: '--prompt @<file> needs a file path.' }
    if (isSubtitleFile(file)) {
      return { error: 'A subtitle file is not a prompt: export its words to .txt or .md first.' }
    }
    try {
      const text = readFileSync(resolveLocalPath(file, cwd), 'utf8').trim()
      if (!text) return { error: `The prompt file ${file} is empty.` }
      parts.push(text)
    } catch (error) {
      return {
        error: `Cannot read the prompt file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return parts.length > 0
    ? { prompt: parts.join('\n\n') }
    : { error: 'generate needs a non-empty --prompt.' }
}

export async function executeMediaToolCommand(args: {
  command: string | string[]
  workspaceRootPath?: string | undefined
  sessionId?: string | undefined
  /** The session's own working directory — the project folder when the session is in one. */
  sessionWorkingDirectory?: string | undefined
  /** The workspace project the conversation is bound to, when the caller knows it. */
  projectId?: string | undefined
  /** Live read, so a conversation moved into (or out of) a project lands in the new place. */
  getSessionInfo?: (() => { projectId?: string; workingDirectory?: string } | null) | undefined
  /** Injected by a test; the desktop leaves it out and the real `fetch` is used. */
  fetchImpl?: typeof fetch
  /** Injected by a test, so a run does not depend on the machine's `media-channels.json`. */
  channels?: MediaChannel[]
  /** Injected by a test, so a run does not depend on the machine's `media-settings.json`. */
  settings?: MediaSettings
}): Promise<BrowserCommandResult> {
  // Array mode is already tokenised: re-splitting it would eat the spaces inside a value
  // (`--prompt "a lighthouse"`), which is exactly what the tool's own description promises it will not do.
  const tokens = Array.isArray(args.command) ? args.command : tokenizeCommand(args.command ?? '')

  const command = tokens[0]?.toLowerCase()
  if (!command || command === 'help' || command === '--help' || command === '-h') return say(mediaHelp())

  // Keys live in the credential store, not in the JSON file; fill them in once so every branch below
  // (listing, generating, cancelling) sees the same channels a generation would.
  const onDisk = args.channels ? null : readMediaChannels()
  const configured = onDisk
    ? { channels: await withStoredKeys(onDisk.channels), problem: onDisk.problem }
    : { channels: args.channels ?? [], problem: undefined }
  // A legacy `chat` row is not a media account at all: it is text/vision, which lives in the AI
  // connection now.
  const usable = configured.channels.filter((channel) => !isLegacyChatChannel(channel))
  // A disabled account stays visible in `channels` — its key and models are kept — but nothing
  // selects it automatically, and naming it is refused with the reason instead of a failed run.
  const enabled = usable.filter(isChannelEnabled)

  if (command === 'channels') {
    return say(formatChannels(usable, configured.problem))
  }

  /**
   * What each model wants, in the words this tool speaks.
   *
   * `channels` says which accounts exist; this says how to call one model without knowing the
   * vendor's field names — the unified parameter names, the voices and formats, the limits, and one
   * sentence of usage. Only kinds the person handed to the agent are listed.
   */
  if (command === 'models') {
    const kindFilter = valueOf(tokens, '--kind')
    const channelFilter = valueOf(tokens, '--channel')
    const modelFilter = valueOf(tokens, '--model')
    if (kindFilter && !isGenerateKind(kindFilter)) {
      return say(`--kind must be ${GENERATE_KINDS.join(', ')}.`, true)
    }
    // `channels` is the inventory and already prints each model's choices. This command is the
    // second step — usage, limits, voices — so it needs to know which account it is talking about.
    if (!channelFilter) {
      return say(
        'models needs --channel <id> — ask `channels` for the ids; it also lists each model’s choices.',
        true,
      )
    }
    const namedChannel = usable.find((channel) => channel.id === channelFilter)
    if (!namedChannel) {
      return say(`No channel named "${channelFilter}". Ask \`channels\` for what this machine has.`, true)
    }
    if (!isChannelEnabled(namedChannel)) {
      return say(
        `Channel "${namedChannel.name}" is disabled. Enable it in Settings, or name another.`,
        true,
      )
    }
    const lines: string[] = []
    for (const endpoint of endpointsOf(namedChannel)) {
      if (kindFilter && endpoint.kind !== kindFilter) continue
      const capability = channelForKind(namedChannel, endpoint.kind) ?? namedChannel
      const specs = paramSpecsOf(capability)
      lines.push(`${namedChannel.id} · ${endpoint.kind} — ${namedChannel.name}`)
      if (capability.models.length === 0) {
        lines.push('  （没有列出模型）')
        continue
      }
      for (const model of modelInfoOf(capability, capability.models)) {
        if (modelFilter && model.id !== modelFilter) continue
        const marker = model.id === capability.defaultModel ? ' [default]' : ''
        lines.push(`  ${model.id}${marker}`)
        const params = model.guide?.params ?? specs?.map((spec) => spec.key)
        const voices = model.guide?.voices ?? capability.options?.voice
        const formats = model.guide?.formats ?? capability.options?.format
        if (params?.length) lines.push(`    params: ${params.join(', ')}`)
        if (voices?.length) lines.push(`    voices: ${voices.join(', ')}`)
        if (formats?.length) lines.push(`    formats: ${formats.join(', ')}`)
        const limits: string[] = []
        if (model.capabilities?.maxPromptCharacters !== undefined) {
          limits.push(`prompt ≤ ${model.capabilities.maxPromptCharacters} chars`)
        }
        if (model.capabilities?.maxReferences !== undefined) {
          limits.push(`references ≤ ${model.capabilities.maxReferences}`)
        }
        if (limits.length) lines.push(`    limits: ${limits.join(' · ')}`)
        if (model.guide?.usage) lines.push(`    usage: ${model.guide.usage}`)
      }
    }
    return say(
      lines.length > 0
        ? lines.join('\n')
        : `No model is available with that filter on "${namedChannel.name}".`,
    )
  }

  // Where a file lands or is read from. Resolved once per call from the conversation's live
  // binding: a conversation moved into a project writes into the project from the next call on.
  const info = args.getSessionInfo?.()
  const resolvedRoots = resolveContentRoots({
    sessionId: args.sessionId,
    workspaceRootPath: args.workspaceRootPath,
    projectId: args.projectId ?? info?.projectId,
    workingDirectory: args.sessionWorkingDirectory ?? info?.workingDirectory,
  })
  if (!resolvedRoots.ok) return say(resolvedRoots.error, true)
  const roots = resolvedRoots.roots

  if (command === 'task') {
    const out = valueOf(tokens, '--out')
    if (!out) return say('task needs --out <path> — the file the task will produce.', true)
    const target = resolveFilePath(out, roots)
    if (!target.ok) return say(target.error, true)
    const task = readMediaTask(target.path)
    if (!task) {
      return say(existsSync(target.path) ? `${target.path} is done.` : `No task is waiting for ${target.path}.`)
    }
    const when = task.nextPollAt
      ? `; next check at ${new Date(task.nextPollAt).toLocaleTimeString()}`
      : ''
    // A finished sound task may have landed under another extension; the requested path is still
    // the handle, and this says where the bytes are.
    const landed = task.finalPath && task.finalPath !== task.outPath ? ` at ${task.finalPath}` : ''
    return say(`${task.status}${landed}${task.error ? `: ${task.error}` : ''}${when}`)
  }

  if (command === 'detach') {
    const out = valueOf(tokens, '--out')
    if (!out) return say('detach needs --out <path> — the file the task will produce.', true)
    const target = resolveFilePath(out, roots)
    if (!target.ok) return say(target.error, true)
    const task = readMediaTask(target.path)
    if (!task) return say(`No task is waiting for ${target.path}.`)

    const result = await cancelOrDetachMediaTask(task, {
      channels: usable,
      ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
    })
    return say(
      result.detached
        ? `Stopped waiting for ${target.path}. The provider is still working${
            result.message ? ` (${result.message})` : ''
          } — the file will land in the background.`
        : `Cancelled ${target.path}.`,
    )
  }

  if (command === 'tasks') {
    const kindFilter = valueOf(tokens, '--kind')
    if (kindFilter && !isGenerateKind(kindFilter)) {
      return say(`--kind must be ${GENERATE_KINDS.join(', ')}.`, true)
    }
    const statusFilter = valueOf(tokens, '--status')
    if (statusFilter && !(TASK_STATUSES as readonly string[]).includes(statusFilter)) {
      return say(`--status must be ${TASK_STATUSES.join(', ')}.`, true)
    }
    const tasks = listMediaTasks(roots.contentRoot).filter(
      (task) =>
        (!kindFilter || task.kind === kindFilter) && (!statusFilter || task.status === statusFilter),
    )
    if (tasks.length === 0) return say(`No media task is waiting under ${roots.contentRoot}.`)
    // The path is the whole address: it is what `task --out` and `detach --out` take back.
    const lines = tasks.map((task) => {
      const prompt = task.prompt.replace(/\s+/g, ' ').trim()
      const brief = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt
      const when = task.nextPollAt
        ? ` · next check ${new Date(task.nextPollAt).toLocaleTimeString()}`
        : ''
      // The requested path stays the handle; a renamed artifact is shown beside it.
      const landed =
        task.finalPath && task.finalPath !== task.outPath ? ` → ${task.finalPath}` : ''
      return `${task.status}\t${task.outPath}${landed}\t${task.channelId} · ${task.kind}${brief ? ` — "${brief}"` : ''}${when}`
    })
    return say(
      [
        `${tasks.length} task${tasks.length === 1 ? '' : 's'} under ${roots.contentRoot}:`,
        ...lines,
        '',
        '`task --out <path>` reports one; `detach --out <path>` stops waiting.',
      ].join('\n'),
    )
  }

  if (command !== 'generate') {
    return say(
      `Unknown command "${tokens[0]}". Commands: channels, models --channel <id>, generate --prompt <text> [--out <path>], task --out <path>, tasks, detach --out <path>. One command per call — "--help" lists them.`,
      true,
    )
  }

  // ---- generate ----
  const outPathRaw = valueOf(tokens, '--out')
  // The old --node flag is gone: this door writes files. Refuse it rather than ignoring it.
  if (valueOf(tokens, '--node') !== undefined) {
    return say('generate --node is gone: this tool now writes files only. Use --out or let it fall into the conversation’s assets/.', true)
  }
  const nodeFlags = ['--input-node', '--prompt-node', '--first-frame-node', '--last-frame-node', '--at']
  const hasNodeFlag = nodeFlags.some((flag) => valueOf(tokens, flag) !== undefined) ||
    allOf(tokens, '--input-node').length > 0 ||
    allOf(tokens, '--prompt-node').length > 0
  if (hasNodeFlag) {
    return say(
      'Node flags are gone (--input-node, --prompt-node, --first-frame-node, --last-frame-node, --at). ' +
      'Use --input, --prompt, --first-frame, --last-frame for file references.',
      true,
    )
  }

  let rawPrompt = ''
  const promptValues = allOf(tokens, '--prompt')
  if (promptValues.length > 0) {
    const resolvedPrompt = resolvePrompt(promptValues, roots.contentRoot)
    if ('error' in resolvedPrompt) return say(resolvedPrompt.error, true)
    rawPrompt = resolvedPrompt.prompt
  }

  const kindFlag = valueOf(tokens, '--kind') ?? 'image'
  if (!isGenerateKind(kindFlag)) {
    return say(`--kind must be ${GENERATE_KINDS.join(', ')}.`, true)
  }
  const kind = kindFlag

  const mediaSettings = args.settings ?? readMediaSettings().settings
  // Speech synthesis has no separate account to name here: an account that offers `tts` is what
  // makes it possible, and an empty choice resolves to the first one that can.
  const speechTts = kind === 'tts' ? mediaSettings.speech.tts : undefined
  if (kind === 'tts' && !channelForChoice(usable, 'tts', mediaSettings.speech.tts)) {
    return say(
      mediaSettings.speech.tts.channelId
        ? `语音合成设置的账号「${mediaSettings.speech.tts.channelId}」不可用（已停用或没有合成能力）：换一个账号。`
        : '语音合成还没有可用的云端账号：先在「媒体生成」里添加一个支持语音的账号。',
      true,
    )
  }

  if (enabled.length === 0) {
    const disabled = usable.filter((channel) => !isChannelEnabled(channel))
    return say(
      disabled.length > 0
        ? `No enabled channel makes ${GENERATE_KINDS.join(', ')}. ${disabled
            .map((channel) => `"${channel.name}"`)
            .join(', ')} ${disabled.length === 1 ? 'is' : 'are'} disabled — enable one in Settings.`
        : `No channel on this machine makes ${GENERATE_KINDS.join(', ')}. Add one in the settings, or write one in ${mediaChannelsPath()}.`,
      true,
    )
  }
  const requestedModel = valueOf(tokens, '--model') ?? speechTts?.model
  const named = valueOf(tokens, '--channel') ?? speechTts?.channelId
  const namedChannel = named ? usable.find((candidate) => candidate.id === named) : undefined
  if (named && !namedChannel) {
    return say(`No channel named "${named}". Ask \`channels\` for what this machine has.`, true)
  }
  if (namedChannel && !isChannelEnabled(namedChannel)) {
    return say(
      `Channel "${namedChannel.name}" is disabled. Enable it in Settings, or name another.`,
      true,
    )
  }
  const chosen =
    namedChannel ??
    // Best first: an account that lists the requested model, then one that can actually run
    // (a key and models), then the rest — never one that was turned off.
    enabledChannelsFor(usable, kind, requestedModel)[0]
  const channel = chosen ? channelForKind(chosen, kind) : null
  if (!channel) {
    return say(
      named
        ? `Channel "${named}" does not make ${kind}. Ask \`channels\` for what it can make.`
        : `No channel makes ${kind}. Ask \`channels\` for what this machine has.`,
      true,
    )
  }

  if (rawPrompt.trim().length === 0) {
    return say('generate needs --prompt <text> — what to make.', true)
  }

  const inputs: Array<{ path: string; dataUrl: string }> = []
  for (const file of allOf(tokens, '--input')) {
    const resolved = resolveFilePath(file, roots)
    if (!resolved.ok) return say(resolved.error, true)
    // An unknown extension used to be read as an image; a brief passed here would be uploaded as
    // one. Words belong in `--prompt` (or `--prompt @file`), not in the reference list.
    if (!isMediaFile(resolved.path)) {
      return say(
        `--input "${file}" is not an image, video or audio file. Put text in --prompt (or --prompt @file).`,
        true,
      )
    }
    try {
      inputs.push({ path: resolved.path, dataUrl: dataUrlOfFile(resolved.path) })
    } catch (error) {
      return say(
        `Cannot read input ${resolved.path}: ${error instanceof Error ? error.message : String(error)}`,
        true,
      )
    }
  }

  // A frame is a role, not another numbered reference: the provider knows where it goes.
  let frames: { first?: { path: string; dataUrl: string }; last?: { path: string; dataUrl: string } } = {}
  try {
    const readFrame = (flag: string) => {
      const file = valueOf(tokens, flag)
      if (!file) return undefined
      const resolved = resolveFilePath(file, roots)
      if (!resolved.ok) throw new Error(resolved.error)
      if (!isMediaFile(resolved.path) || mediaKindOfFile(resolved.path) !== 'image') {
        throw new Error(`${file} is not an image, so it cannot be a frame.`)
      }
      return { path: resolved.path, dataUrl: dataUrlOfFile(resolved.path) }
    }
    frames = { first: readFrame('--first-frame'), last: readFrame('--last-frame') }
  } catch (error) {
    return say(`Cannot read a frame: ${error instanceof Error ? error.message : String(error)}`, true)
  }

  // `--input` order is the API order, so `{{ref 1}}` means the first item given.
  const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }
  const mediaInputs: Record<'image' | 'video' | 'audio', string[]> = { image: [], video: [], audio: [] }
  const referenceOrder = inputs.map((input) => {
    if (frames.first && input.path === frames.first.path) return { type: 'firstFrame' as const }
    if (frames.last && input.path === frames.last.path) return { type: 'lastFrame' as const }
    const type = mediaKindOfFile(input.path)
    mediaInputs[type].push(input.dataUrl)
    return { type, index: counters[type]++ }
  })
  let prompt: string
  try {
    prompt = rewritePromptReferences(rawPrompt, referenceOrder, channel.referenceLabels)
  } catch (error) {
    return say(error instanceof Error ? error.message : String(error), true)
  }

  // A video edit is the clip it was given, at that clip's length: one video, nothing beside it,
  // and no duration to set. Refused before a task file exists.
  const effectiveModel = mediaChannelModel(channel, requestedModel)
  const mode = modelMode(channel, effectiveModel)
  if (mode === 'video-edit') {
    const problem = videoEditProblem({
      videos: mediaInputs.video.length,
      images: mediaInputs.image.length,
      audios: mediaInputs.audio.length,
      frames: (frames.first ? 1 : 0) + (frames.last ? 1 : 0),
    })
    if (problem) return say(videoEditProblemText(problem, channel.name), true)
  }

  const params: Record<string, string | number> = {}
  for (const pair of allOf(tokens, '--param')) {
    const at = pair.indexOf('=')
    if (at <= 0) return say(`--param must be key=value, got "${pair}".`, true)
    const key = pair.slice(0, at)
    const raw = pair.slice(at + 1)
    const numeric = Number(raw)
    params[key] = raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw
  }
  // What the selected model accepts. A channel written with typed specs has no legacy `options`,
  // so validation reads the same list the panel shows — including specs scoped to this model.
  const specs = paramsForModel(paramSpecsOf(channel), effectiveModel)

  // Named choices, so an agent does not have to know a vendor's field names. A value the channel
  // does not offer is refused here, with the list — not sent to the provider to become a 400.
  const picks: Record<string, string | number> = {}
  const durationRaw = valueOf(tokens, '--duration')
  if (durationRaw !== undefined) {
    if (mode === 'video-edit') {
      return say('This model keeps the input video’s length; do not pass --duration.', true)
    }
    const seconds = Number(durationRaw)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return say('--duration must be a number of seconds.', true)
    }
    picks.duration = seconds
  }
  for (const [flag, key] of [
    ['--ratio', 'ratio'],
    ['--voice', 'voice'],
    ['--format', 'format'],
  ] as const) {
    const value = valueOf(tokens, flag)
    if (value !== undefined) picks[key] = value
  }
  // One spelling above the wire: `--quality`. A hand-written channel that still calls the field
  // `resolution` is reached through `--param resolution=…`, not by a second named flag.
  const qualityChoice = valueOf(tokens, '--quality')
  if (qualityChoice !== undefined) picks.quality = qualityChoice
  // Music has two inputs: the prompt is the style brief, the lyrics are the words. `@file` is what
  // makes a full song practical to pass; `--param lyrics=…` remains for a short one.
  const lyricsRaw = valueOf(tokens, '--lyrics')
  if (lyricsRaw !== undefined && kind !== 'music') {
    return say('--lyrics is for --kind music: it is the words the song is sung from.', true)
  }
  if (lyricsRaw !== undefined) {
    let lyrics = lyricsRaw
    if (lyrics.startsWith('@')) {
      const file = lyrics.slice(1).trim()
      if (!file) return say('--lyrics @<file> needs a file path.', true)
      if (isSubtitleFile(file)) {
        return say('A subtitle file is not lyrics: export its words to .txt or .md first.', true)
      }
      try {
        lyrics = readFileSync(resolveLocalPath(file, roots.contentRoot), 'utf8').trim()
      } catch (error) {
        return say(
          `Cannot read the lyrics file ${file}: ${error instanceof Error ? error.message : String(error)}`,
          true,
        )
      }
      if (!lyrics) return say(`The lyrics file ${file} is empty.`, true)
    }
    if (!lyrics.trim()) return say('--lyrics needs text, or @<file> with words in it.', true)
    picks.lyrics = lyrics
  }

  // What the selected model accepts. A channel written with typed specs has no legacy `options`,
  // so validation reads the same list the panel shows — including specs scoped to this model.
  const offeredBy = (key: string): Array<string | number> | undefined => {
    const spec = specs.find((candidate) => candidate.key === key)
    return spec?.type === 'select' ? spec.options : undefined
  }
  const legacy = channel.options as Record<string, Array<string | number> | undefined> | undefined
  for (const [key, value] of Object.entries(picks)) {
    const allowed = offeredBy(key) ?? legacy?.[key]
    if (allowed?.length && !allowed.map(String).includes(String(value))) {
      return say(
        `${key} "${value}" is not offered by "${channel.name}". Choose one of: ${allowed.join(', ')}.`,
        true,
      )
    }
  }
  // A named flag is the clearer statement, so it wins over the same key passed with --param.
  Object.assign(params, picks)
  // `--param duration=…` is the escape hatch, but a video edit still has no duration to choose.
  if (mode === 'video-edit') delete params.duration

  // The same refusals the task path runs, before either path runs. A synchronous provider would
  // otherwise be the only place that noticed an out-of-range duration, an undeclared parameter or
  // too many references — as a 400 that names none of them.
  try {
    validateMediaRequest(channel, {
      prompt,
      ...(requestedModel ? { model: requestedModel } : {}),
      params,
      counts: {
        image: mediaInputs.image.length,
        video: mediaInputs.video.length,
        audio: mediaInputs.audio.length,
      },
      firstFrame: Boolean(frames.first),
      lastFrame: Boolean(frames.last),
    })
  } catch (error) {
    if (error instanceof MediaFailure) return say(error.message, true)
    throw error
  }

  // Resolve output path: explicit --out, or auto-fall into the content root's assets/. A generated
  // file is an asset from the moment it exists, with its source note beside it.
  const ext = kind === 'video' ? 'mp4' : isSoundKind(kind) ? 'mp3' : 'png'
  let outPath: string
  if (outPathRaw) {
    const resolved = resolveFilePath(outPathRaw, roots)
    if (!resolved.ok) return say(resolved.error, true)
    outPath = resolved.path
  } else {
    const slug = (rawPrompt.trim().split(/\s+/).slice(0, 3).join('-') || 'result').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()
    outPath = join(roots.contentRoot, 'assets', `${Date.now().toString(36)}-${slug || 'gen'}.${ext}`)
  }

  try {
    const target = outPath
    // The model, not the capability, decides whether this is a task: one Bailian image account
    // holds Qwen-Image (one reply) and Wan (a queued job).
    const wire = mediaChannelForModel(channel, effectiveModel)
    const isTask = Boolean(wire.pollPath)

    // An async channel answers with a task id, so the call returns now and the bytes come later.
    // The task file is the handover: the host's clock picks it up even if this process is gone.
    if (isTask) {
      const task = createMediaTask({
        outPath: target,
        channelId: channel.id,
        kind,
        prompt,
        references: inputs.map((input) => input.path),
        ...(frames.first ? { firstFrame: frames.first.path } : {}),
        ...(frames.last ? { lastFrame: frames.last.path } : {}),
        model: requestedModel,
        params: Object.keys(params).length > 0 ? params : undefined,
        sessionId: args.sessionId,
        channel,
      })
      writeMediaTask(task)
      const step = await advanceMediaTask(task, {
        channels: usable,
        ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
      })
      if (step.task.status === 'succeeded' && step.artifact) {
        // A sound artifact may have been renamed to its real container; name the file that exists.
        return say(
          `Wrote ${step.artifact.path} (${Math.round(step.artifact.byteLength / 1024)} KB, ${step.artifact.mimeType}) — ${channel.name}.`,
        )
      }
      if (step.task.status === 'failed' || step.task.status === 'submission_unknown') {
        return say(
          step.task.error ??
            (step.task.status === 'submission_unknown'
              ? 'The submit result is unknown — the provider may already be working. Query the task before resubmitting.'
              : 'The task did not start.'),
          true,
        )
      }
      return say(
        `Submitted \`${target}\` — ${channel.name} has it. Check it with \`task --out "${target}"\`.`,
      )
    }

    const result = await generateMedia({
      channel,
      kind,
      prompt,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(mediaInputs.image.length > 0 ? { images: mediaInputs.image } : {}),
      ...(mediaInputs.video.length > 0 ? { videos: mediaInputs.video } : {}),
      ...(mediaInputs.audio.length > 0 ? { audios: mediaInputs.audio } : {}),
      ...(frames.first ? { firstFrame: frames.first.dataUrl } : {}),
      ...(frames.last ? { lastFrame: frames.last.dataUrl } : {}),
      ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
    })

    // The bytes decide the container: a speech or music channel may answer with wav while `--out`
    // said mp3.
    const finalTarget = isSoundKind(channel.kind)
      ? fileNameForMime(target, result.mimeType)
      : target
    mkdirSync(dirname(finalTarget), { recursive: true })
    writeFileSync(finalTarget, result.bytes)
    noteGeneration(finalTarget, roots, {
      prompt,
      references: inputs.map((input) => input.path),
      ...(frames.first ? { firstFrame: frames.first.path } : {}),
      ...(frames.last ? { lastFrame: frames.last.path } : {}),
      channel: channel.name,
      params: Object.keys(params).length > 0 ? params : undefined,
      session: args.sessionId,
    })
    const modelName = effectiveModel
    const summary =
      `Wrote ${finalTarget} (${Math.round(result.bytes.length / 1024)} KB, ${result.mimeType}) — ` +
      `${channel.name}${modelName ? ` · ${modelName}` : ''}.`
    return say(summary)
  } catch (error) {
    if (error instanceof MediaFailure) return say(error.message, true)
    return say(error instanceof Error ? error.message : String(error), true)
  }
}
