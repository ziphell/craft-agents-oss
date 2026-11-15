/**
 * Where the person's media choices live on disk.
 *
 * The shape and its normalisation are in `media-settings-schema.ts`, so the settings page can
 * import them without dragging `node:fs` or `os.homedir()` into a browser bundle. This file adds
 * the file: `~/.craft-agent/media-settings.json`, beside the accounts rather than inside them,
 * because one `media-channels.json` may be shared by a workspace while each person decides
 * differently what the agent may spend.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../config/paths.ts'
import {
  defaultMediaSettings,
  normalizeMediaSettings,
  MEDIA_SETTINGS_FILE,
  type MediaSettings,
} from './media-settings-schema.ts'

export * from './media-settings-schema.ts'

export function mediaSettingsPath(): string {
  return join(CONFIG_DIR, MEDIA_SETTINGS_FILE)
}

export function readMediaSettings(): { settings: MediaSettings; problem?: string } {
  const path = mediaSettingsPath()
  if (!existsSync(path)) return { settings: defaultMediaSettings() }
  try {
    return { settings: normalizeMediaSettings(JSON.parse(readFileSync(path, 'utf8'))) }
  } catch (error) {
    return {
      settings: defaultMediaSettings(),
      problem: `${path} 读不了：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function writeMediaSettings(settings: MediaSettings): void {
  const path = mediaSettingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(normalizeMediaSettings(settings), null, 2)}\n`, 'utf8')
}
