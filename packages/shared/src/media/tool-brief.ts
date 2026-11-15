/**
 * What `media_tool` says about itself, given what this machine can actually do.
 *
 * A tool description is paid for by every session, and a brief that promises a capability the
 * machine does not have is worse than a shorter one: the model spends a call discovering the
 * refusal. So the brief names exactly the kinds that are configured — an account with only an
 * image endpoint must not be described as if it also filmed clips or spoke.
 *
 * The detail still lives in `media_tool help`; this is the index, not the manual.
 */

import {
  isChannelEnabled,
  isLegacyChatChannel,
  mediaChannelKinds,
  type MediaChannel,
  type MediaKind,
} from './channels.ts'

export interface MediaCapabilities {
  /** The kinds this machine can generate, in the order image, video, music, speech. */
  generate: MediaKind[]
}

const GENERATIVE: MediaKind[] = ['image', 'video', 'music', 'tts']

/**
 * Read off the same channel list a generation would use.
 *
 * An enabled account that offers a kind is what makes it available: there is no separate
 * permission switch, so the brief can only promise what a call would actually find.
 */
export function mediaCapabilities(channels: MediaChannel[]): MediaCapabilities {
  const kinds = new Set<string>()
  for (const channel of channels) {
    if (isLegacyChatChannel(channel) || !isChannelEnabled(channel)) continue
    for (const kind of mediaChannelKinds(channel)) kinds.add(kind)
  }
  return {
    generate: GENERATIVE.filter((kind) => kinds.has(kind)),
  }
}

/** `image`, `image/video`, `image, video and audio` — whichever reads cleanly for the list. */
function listKinds(kinds: readonly string[]): string {
  if (kinds.length <= 1) return kinds[0] ?? ''
  return `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`
}

/** The flags that make sense for the kinds actually present, in the order a person reads them. */
function choiceFlags(generate: MediaKind[]): string[] {
  const available = new Set<string>()
  for (const kind of generate) {
    for (const flag of kind === 'image'
      ? ['--ratio', '--quality']
      : kind === 'video'
        ? ['--duration', '--quality', '--ratio']
        : kind === 'music'
          ? ['--format', '--lyrics']
          : ['--voice', '--format']) {
      available.add(flag)
    }
  }
  return ['--duration', '--quality', '--ratio', '--lyrics', '--voice', '--format'].filter(
    (flag) => available.has(flag),
  )
}

/**
 * The brief for `media_tool`, or `null` when this machine has nothing to make.
 *
 * A machine with no generation account gets no tool at all: the description is the largest part of
 * the cost, and a door that can only refuse is worse than an absent one. Reading is never here: a
 * picture goes to `call_llm`, a recording is composed from `recording_tool`.
 */
export function mediaToolBrief(capabilities: MediaCapabilities): string | null {
  const { generate } = capabilities
  // Nothing configured is not a brief saying "do not call": it is no brief.
  if (generate.length === 0) return null

  const missing = GENERATIVE.filter((kind) => !generate.includes(kind))
  const flags = choiceFlags(generate)
  const kinds =
    generate.length === 1
      ? `\`${generate[0]}\` only`
      : generate.map((kind) => `\`${kind}\``).join(' / ')
  const lines: string[] = [
    'Make a media file through a configured account. One command per call.',
    '',
    '`generate --prompt <text|@file> [--out <path>] [flags]` — one prompt, one file. Omitted, ' +
      '`--out` lands under the conversation’s `assets/` (the project’s, or its own folder in a plain ' +
      'conversation) with its source note beside it. ' +
      '`--prompt` is repeatable and takes `@file`; `--input` attaches references in order ' +
      '(`{{ref N}}`), `--first-frame` / `--last-frame` are roles. `--channel` / `--model` name the ' +
      `account and model; \`--kind\` is ${kinds} here${
        missing.length > 0 ? ` — ${listKinds(missing)} ${missing.length === 1 ? 'is' : 'are'} not configured` : ''
      }. ${generate.includes('tts') ? '`tts` speaks through the first account that offers it unless `--channel` names one. ' : ''}${
        flags.length > 0 ? `${flags.map((flag) => `\`${flag}\``).join(', ')} and ` : ''
      }` +
      '`--param key=value` are the choices `channels` lists. A provider that answers with a task ' +
      'id returns before the file exists: `task --out <path>` says how it is doing, `tasks` lists ' +
      'the unfinished ones, `detach --out <path>` stops waiting.',
    '',
  ]

  lines.push(
    "Reading media is not this door's. What a picture shows is read by `call_llm` with its path as an attachment; the words printed on one are `img-tool text` (local, exact characters, no account). A recording is composed: `recording_tool probe` for its length, `recording_tool frames` for the pictures (or `--out <dir>` to keep them), then `call_llm` with those images and the moment each came from — at most 20 images per call, so read long recordings in windows or batches.",
    '',
    '`channels` — which accounts exist and what each one can make, including the values each model accepts. `models --channel <id>` — how to call one account: parameter names, voices, formats, limits and usage. `help` prints every flag.',
    '',
    "Local pixel changes (crop, rotate, flip, resize, convert, watermark, composite) are `img-tool`'s.",
  )

  return lines.join('\n')
}
