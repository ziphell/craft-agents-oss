/**
 * File-name predicates both halves of the app share.
 *
 * This module is pure on purpose: the renderer imports it, so it may not touch `node:fs`.
 * `inputs.ts` (which does read bytes) re-exports `isSubtitleFile` for the host side.
 */

/**
 * Whether the name is a subtitle file.
 *
 * A speech or music model reads words, not cue syntax, and none of the providers we call takes a
 * subtitle as an input format. Such a file is refused where plain text is expected rather than
 * silently reduced: the person can export the words first.
 */
export function isSubtitleFile(path: string): boolean {
  return /\.(srt|vtt)$/i.test(path)
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])

/**
 * Whether a path plays as video or audio.
 *
 * `classifyFile` deliberately leaves these to the system for a plain click in a document; the
 * players that *can* draw them (a side-panel tab, a full preview window) ask this instead of
 * keeping a second list of extensions.
 */
export function mediaKindOfFile(path: string): 'video' | 'audio' | null {
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return null
}
