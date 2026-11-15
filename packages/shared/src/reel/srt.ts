/**
 * SubRip (`.srt`) in and out — because that is what speech recognition hands back.
 *
 * An ASR step does not return a paragraph; it returns **text with times**. SRT is the smallest
 * common shape for that, so it is the interchange here: a transcript file becomes subtitle
 * overlays, and the cut's subtitles can be written back out for a translator or another tool.
 *
 * The parser is deliberately forgiving: BOM, CRLF, cues without a number, a missing blank line
 * between cues, and `,` or `.` before milliseconds all appear in files produced in the wild, and
 * refusing them would make "import what the ASR wrote" fail for no good reason. It is strict
 * about one thing only — a cue needs an end after its start and words to show.
 *
 * Pure functions: no `fs`, no DOM.
 */

import type { EditOverlay, TextPreset, TextStyle } from './overlay.ts'

export interface SubtitleCue {
  /** Seconds from the start of the cut. */
  start: number
  /** Seconds, exclusive. */
  end: number
  text: string
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** `hh:mm:ss,mmm`, `mm:ss,mmm`, and `.` for the decimal separator all parse. */
const STAMP = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/

function secondsOf(value: string): number | null {
  const match = STAMP.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (minutes > 59 || seconds > 59) return null
  const milliseconds = match[4] ? Number(match[4].padEnd(3, '0')) : 0
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

/** The next line that carries anything is the timing of the next cue. */
function nextIsTiming(lines: readonly string[], from: number): boolean {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (!line) continue
    return line.includes('-->')
  }
  return false
}

/** Everything a `.srt` file says, in order. Bad blocks are skipped, not fatal. */
export function parseSrt(source: string): SubtitleCue[] {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const cues: SubtitleCue[] = []
  let current: { start: number; end: number; text: string[] } | null = null

  const flush = () => {
    if (!current) return
    const text = current.text.join('\n').trim()
    if (text && current.end > current.start) {
      cues.push({ start: current.start, end: current.end, text })
    }
    current = null
  }

  for (const [index, raw] of lines.entries()) {
    const arrow = raw.indexOf('-->')
    if (arrow >= 0) {
      flush()
      const start = secondsOf(raw.slice(0, arrow))
      // A position after the end time (some exporters append `X1:…`) is not part of the stamp.
      const end = secondsOf((raw.slice(arrow + 3).trim().split(/\s+/)[0] ?? '').trim())
      current = start !== null && end !== null ? { start, end, text: [] } : null
      continue
    }
    if (!current) continue
    if (!raw.trim()) {
      flush()
      continue
    }
    // With no blank line between cues, a bare number is the next cue's index, not a line of text.
    if (current.text.length > 0 && /^\d+$/.test(raw.trim()) && nextIsTiming(lines, index + 1)) {
      flush()
      continue
    }
    current.text.push(raw.trim())
  }
  flush()
  return cues
}

/** Cues from a JSON ASR result: `{ start, end | duration, text }`. */
export function normalizeCues(raw: unknown): SubtitleCue[] {
  if (!Array.isArray(raw)) return []
  const cues: SubtitleCue[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const start = finite(value.start)
    const end = finite(value.end) ?? (start === undefined ? undefined : start + (finite(value.duration) ?? 0))
    const text = typeof value.text === 'string' ? value.text.trim() : ''
    if (start === undefined || end === undefined || !text) continue
    if (start < 0 || end <= start) continue
    cues.push({ start, end, text })
  }
  return cues
}

const pad = (value: number, width: number) => String(Math.floor(value)).padStart(width, '0')

/** `hh:mm:ss,mmm`, rounded to the millisecond. */
export function stampOf(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000))
  const milliseconds = total % 1000
  const whole = Math.floor(total / 1000)
  return `${pad(Math.floor(whole / 3600), 2)}:${pad(Math.floor((whole % 3600) / 60), 2)}:${pad(
    whole % 60,
    2,
  )},${String(milliseconds).padStart(3, '0')}`
}

/** The file a translator, a player or another tool can take. */
export function formatSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .filter((cue) => cue.text.trim())
    .map((cue, index) => {
      const end = Math.max(cue.end, cue.start + 0.001)
      return `${index + 1}\n${stampOf(cue.start)} --> ${stampOf(end)}\n${cue.text.trim()}\n`
    })
    .join('\n')
}

export interface CueOverlayOptions {
  preset?: TextPreset
  style?: TextStyle
  /** Paint order; subtitles sit above the picture and below nothing else by default. */
  z?: number
}

/** Cues as text overlays — the same shape the panel and the exporter already handle. */
export function overlaysFromCues(
  cues: readonly SubtitleCue[],
  options: CueOverlayOptions = {},
): Array<Omit<EditOverlay, 'id'>> {
  return cues.map((cue) => ({
    kind: 'text',
    text: cue.text,
    start: cue.start,
    duration: Math.max(0.05, cue.end - cue.start),
    preset: options.preset ?? 'subtitle',
    ...(options.style ? { style: options.style } : {}),
    ...(options.z !== undefined ? { z: options.z } : {}),
  }))
}

/**
 * A text overlay that is dialogue rather than a graphic: the subtitle preset, or a hand-written
 * text with no preset (most likely a subtitle). Titles and 花字 are excluded.
 */
export const isSubtitleOverlay = (overlay: EditOverlay): boolean =>
  overlay.kind === 'text' && (!overlay.preset || overlay.preset === 'subtitle')

/**
 * The cut's subtitles, as cues.
 *
 * A title or a 花字 is text too, but it is not a subtitle: exporting it would put "Episode 1" in
 * the middle of dialogue. So only subtitle-preset overlays (and hand-written ones with no preset,
 * which are most likely subtitles) are written out.
 */
export function cuesFromOverlays(overlays: readonly EditOverlay[]): SubtitleCue[] {
  return overlays
    .filter(isSubtitleOverlay)
    .map((overlay) => ({
      start: overlay.start,
      end: overlay.start + overlay.duration,
      text: (overlay.text ?? '').trim(),
    }))
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}
