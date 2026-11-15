/**
 * Where a channel's key actually lives.
 *
 * A key pasted into the settings page is written to the encrypted credential store, not to
 * `media-channels.json`: the file is a description of an account, not a vault. The renderer never
 * receives the key back — it only ever learns whether one exists.
 *
 * Resolution order stays what it always was for a channel: environment variable first, then an
 * inline key left in the file by an older version, then this store. `withStoredKey` fills the stored
 * one into the channel so the rest of the media code keeps seeing a plain `MediaChannel`.
 *
 * Speech recognition's cloud key lives here too, under its provider id: it belongs to the person,
 * not to a media generation account, so it is stored under `asr_api_key::{provider}`.
 */

import { getCredentialManager } from '../credentials/index.ts'
import type { CredentialId } from '../credentials/types.ts'
import type { AsrCloudProvider } from './asr-config.ts'
import type { MediaChannel } from './channels.ts'

function secretId(channelId: string): CredentialId {
  return { type: 'media_channel_api_key', name: channelId }
}

export async function readMediaChannelSecret(channelId: string): Promise<string | null> {
  if (!channelId) return null
  try {
    const stored = await getCredentialManager().get(secretId(channelId))
    const value = stored?.value?.trim()
    return value ? value : null
  } catch {
    // A credential store that cannot be read is the same as no stored key: the env var or the
    // inline key still work, and the request will say what is missing.
    return null
  }
}

export async function writeMediaChannelSecret(channelId: string, apiKey: string): Promise<void> {
  await getCredentialManager().set(secretId(channelId), { value: apiKey.trim() })
}

export async function clearMediaChannelSecret(channelId: string): Promise<boolean> {
  try {
    return await getCredentialManager().delete(secretId(channelId))
  } catch {
    return false
  }
}

/** The channel, with the stored key filled in when it has no key of its own. */
export async function withStoredKey(channel: MediaChannel): Promise<MediaChannel> {
  if (channel.apiKey?.trim()) return channel
  const stored = await readMediaChannelSecret(channel.id)
  return stored ? { ...channel, apiKey: stored } : channel
}

/** The same, for a list — one store read per channel that needs it. */
export async function withStoredKeys(channels: MediaChannel[]): Promise<MediaChannel[]> {
  return Promise.all(channels.map((channel) => withStoredKey(channel)))
}

function asrSecretId(provider: string): CredentialId {
  return { type: 'asr_api_key', name: provider }
}

export async function readAsrCloudSecret(provider: AsrCloudProvider): Promise<string | null> {
  try {
    const stored = await getCredentialManager().get(asrSecretId(provider))
    const value = stored?.value?.trim()
    return value ? value : null
  } catch {
    // An unreadable store is the same as no key: the request says what is missing.
    return null
  }
}

export async function writeAsrCloudSecret(provider: AsrCloudProvider, apiKey: string): Promise<void> {
  await getCredentialManager().set(asrSecretId(provider), { value: apiKey.trim() })
}

export async function clearAsrCloudSecret(provider: AsrCloudProvider): Promise<boolean> {
  try {
    return await getCredentialManager().delete(asrSecretId(provider))
  } catch {
    return false
  }
}
