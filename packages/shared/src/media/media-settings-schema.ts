/**
 * The shape of the person's media choices, and nothing that touches a disk.
 *
 * The settings page imports this to read and normalise a form; keeping `node:fs` and
 * `config/paths` out of it is what lets a browser bundle import the same facts. Reading and
 * writing the file live in `media-settings.ts`.
 *
 * An account says what it *can* do; this file says where speech synthesis runs. The account list
 * is the capability: an enabled account that offers a kind is what makes the agent able to use it.
 *
 * Recognition is not here: it has its own file (`asr.json`) and its own key, because it is a route
 * (local model or one cloud provider), not a list of generation accounts.
 */

export const MEDIA_SETTINGS_FILE = 'media-settings.json'

/**
 * Where speech synthesis runs: an account, and only an account.
 *
 * There is no local side to choose, so there is no `mode`: the address is the choice. Empty means
 * "the first enabled account that can speak", which keeps a single-account machine from having to
 * name the one account it has.
 */
export interface TtsChoice {
  channelId?: string
  model?: string
}

export interface MediaSettings {
  version: 1
  speech: {
    tts: TtsChoice
  }
}

/** What a person who has decided nothing gets: synthesis uses the first account that can speak. */
export function defaultMediaSettings(): MediaSettings {
  return {
    version: 1,
    speech: {
      tts: {},
    },
  }
}

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || undefined
}

/** A synthesis choice read from disk: an account, and the model it should speak with. */
const ttsChoice = (value: unknown): TtsChoice => {
  const source = (value ?? {}) as Record<string, unknown>
  const channelId = text(source.channelId)
  const model = text(source.model)
  return {
    ...(channelId ? { channelId } : {}),
    ...(model ? { model } : {}),
  }
}

/** A file on disk read as the settings this app understands; unknown keys are dropped. */
export function normalizeMediaSettings(value: unknown): MediaSettings {
  const source = (value ?? {}) as {
    speech?: { tts?: unknown }
  }
  return {
    version: 1,
    speech: {
      tts: ttsChoice(source.speech?.tts),
    },
  }
}
