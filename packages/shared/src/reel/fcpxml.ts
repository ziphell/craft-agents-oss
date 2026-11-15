/**
 * A cut as FCPXML — the interchange file Final Cut Pro, DaVinci Resolve and Premiere read.
 *
 * The document is the truth; this is a projection of it. One `sequence` at the cut's own size and
 * rate, one `asset` per unique source, and a `spine` built from the **first video track** — the
 * base layer. Every other layer (upper video tracks, then sound tracks) becomes connected clips
 * with `lane` numbers, attached to the spine element that covers their start, exactly as FCP models
 * a layered timeline. Holes stay holes: a gap element keeps the picture where the cut has one.
 *
 * What is **not** carried is stated plainly instead of guessed at: transitions, overlays, colour
 * grades, fades and per-clip volume are renderer properties this project keeps in its own file.
 * The picture and the timing — the structure of the cut — are what travel.
 *
 * Pure functions only: the panel writes the returned text, the agent prints it.
 */

import { clipSpeed, durationOf, tracksOf, type EditClip, type EditDocument } from './document.ts'

export interface FcpxmlOptions {
  /** Absolute path (or URL) for a project-relative source like `assets/a.mp4`. */
  fileFor: (src: string) => string
  /** Event name; defaults to the cut's own name. */
  eventName?: string
}

const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i

/** XML text for a value that may contain `&`, `<`, quotes or an em dash. */
const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * The frame rate as an exact rational. NTSC rates are 1001-based; everything else is 1/fps, so a
 * cut on a 25 fps timeline lands on whole frames in the file too.
 */
function frameRate(fps: number): { num: number; den: number } {
  if (Math.abs(fps - 23.976) < 0.01) return { num: 1001, den: 24000 }
  if (Math.abs(fps - 29.97) < 0.01) return { num: 1001, den: 30000 }
  if (Math.abs(fps - 59.94) < 0.01) return { num: 1001, den: 60000 }
  return { num: 1, den: Math.max(1, Math.round(fps)) }
}

const gcd = (left: number, right: number): number =>
  right === 0 ? Math.abs(left) : gcd(right, left % right)

/** A moment as FCPXML time, rounded to the timeline's own frame and reduced to lowest terms. */
function clock(seconds: number, rate: { num: number; den: number }): string {
  const frames = Math.max(0, Math.round((seconds * rate.den) / rate.num))
  if (frames === 0) return '0s'
  const divisor = gcd(frames * rate.num, rate.den)
  const num = (frames * rate.num) / divisor
  const den = rate.den / divisor
  return den === 1 ? `${num}s` : `${num}/${den}s`
}

/** `file:///C:/a/b.mp4` — each path segment is encoded, a drive colon is not. */
function fileUrl(path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) return path
  const parts = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((part, index) => (index === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)))
  return `file:///${parts.join('/')}`
}

interface Asset {
  id: string
  src: string
  name: string
  /** At least as long as the furthest window this cut uses. */
  duration: number
  hasVideo: boolean
  hasAudio: boolean
}

interface Segment {
  start: number
  duration: number
  /** Absent means a gap in the base layer. */
  clip?: EditClip
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path

/** Spine segments from the base video track, tiling [0, duration] without overlap. */
function spineOf(doc: EditDocument, total: number): Segment[] {
  const base = tracksOf(doc, 'video')[0]
  const segments: Segment[] = []
  let cursor = 0
  for (const clip of base ? [...base.clips].sort((left, right) => left.start - right.start) : []) {
    const start = Math.max(cursor, clip.start)
    const end = clip.start + clip.duration
    // A clip fully covered by an earlier one cannot be a spine element; the renderer plays the
    // first one too, so dropping the covered window keeps the file honest.
    if (end - start <= 1e-6) continue
    if (start > cursor + 1e-6) segments.push({ start: cursor, duration: start - cursor })
    segments.push({ start, duration: end - start, clip })
    cursor = end
  }
  if (cursor < total - 1e-6) segments.push({ start: cursor, duration: total - cursor })
  // A cut with no picture still needs a duration for the other layers to attach to.
  if (segments.length === 0) segments.push({ start: 0, duration: Math.max(total, 0.1) })
  return segments
}

/**
 * The cut as an FCPXML document (version 1.9).
 *
 * Assets are emitted once per source; the base video track becomes the spine (with gaps for
 * holes); every other track's clips become connected clips on their own lane, childed to the
 * spine element that covers their start.
 */
export function toFcpxml(doc: EditDocument, options: FcpxmlOptions): string {
  const rate = frameRate(doc.settings.frameRate)
  const total = Math.max(0.1, durationOf(doc))

  // ── Assets: one per source, long enough for the furthest window that uses it ────────────────
  const assets = new Map<string, Asset>()
  let nextId = 2 // r1 is the format
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const known = assets.get(clip.src)
      // A held frame uses one frame of material, not its whole hold: the timeMap below stays put.
      const needed = clip.freeze
        ? clip.in + 1 / Math.max(1, doc.settings.frameRate)
        : clip.in + clip.duration
      if (known) {
        known.duration = Math.max(known.duration, needed)
        known.hasVideo ||= track.kind === 'video'
        known.hasAudio ||= track.kind === 'video' ? !IMAGE.test(clip.src) : true
        continue
      }
      assets.set(clip.src, {
        id: `r${nextId}`,
        src: clip.src,
        name: nameOf(clip.src),
        duration: needed,
        // A video clip also carries its own sound; a still is picture only.
        hasVideo: track.kind === 'video',
        hasAudio: track.kind === 'video' ? !IMAGE.test(clip.src) : true,
      })
      nextId += 1
    }
  }

  const segments = spineOf(doc, total)
  const assetOf = (src: string) => assets.get(src)?.id ?? ''
  const laneFor = (index: number, above: boolean) => (above ? index + 1 : -(index + 1))

  // ── Connected clips: every layer above the base, then every sound track ─────────────────────
  const connected = new Map<Segment, Array<{ clip: EditClip; lane: number }>>()
  const attach = (clip: EditClip, lane: number) => {
    const segment = segments.find(
      (candidate) => clip.start >= candidate.start - 1e-6 &&
        clip.start < candidate.start + candidate.duration - 1e-6,
    )
    if (!segment) return
    const list = connected.get(segment) ?? []
    list.push({ clip, lane })
    connected.set(segment, list)
  }

  const videoTracks = tracksOf(doc, 'video')
  for (const [index, track] of videoTracks.entries()) {
    if (index === 0 || track.hidden) continue
    for (const clip of track.clips) attach(clip, laneFor(index - 1, true))
  }
  const audioTracks = tracksOf(doc, 'audio')
  for (const [index, track] of audioTracks.entries()) {
    for (const clip of track.clips) attach(clip, laneFor(index, false))
  }

  /**
   * A speeded clip is retimed with a `timeMap`: local timeline time → source time. FCP reads the
   * map, so a 2× clip still occupies its own timeline length but walks its source twice as fast.
   * A held frame is the same map with a **constant** value — the source never advances, which FCP
   * accepts (its own documentation shows a time map bending back to 0s).
   */
  const clipTag = (clip: EditClip, attributes: string[], indent: string): string => {
    if (clip.freeze) {
      return [
        `${indent}<asset-clip ${attributes.join(' ')}>`,
        `${indent}  <timeMap>`,
        `${indent}    <timept time="0s" value="0s" interp="linear"/>`,
        `${indent}    <timept time="${clock(clip.duration, rate)}" value="0s" interp="linear"/>`,
        `${indent}  </timeMap>`,
        `${indent}</asset-clip>`,
      ].join('\n')
    }
    const speed = clipSpeed(clip)
    if (speed === 1) return `${indent}<asset-clip ${attributes.join(' ')}/>`
    return [
      `${indent}<asset-clip ${attributes.join(' ')}>`,
      `${indent}  <timeMap>`,
      `${indent}    <timept time="0s" value="0s" interp="linear"/>`,
      `${indent}    <timept time="${clock(clip.duration, rate)}" value="${clock(clip.duration * speed, rate)}" interp="linear"/>`,
      `${indent}  </timeMap>`,
      `${indent}</asset-clip>`,
    ].join('\n')
  }

  const spineXml = segments
    .map((segment) => {
      const children = (connected.get(segment) ?? []).sort((left, right) => right.lane - left.lane)
      if (!segment.clip) {
        const gap = [
          `offset="${clock(segment.start, rate)}"`,
          `start="0s"`,
          `duration="${clock(segment.duration, rate)}"`,
        ]
        if (children.length === 0) return `            <gap ${gap.join(' ')}/>`
        return [
          `            <gap ${gap.join(' ')}>`,
          ...children.map(({ clip, lane }) => {
            const asset = assets.get(clip.src)
            const inner = [
              `ref="${assetOf(clip.src)}"`,
              `lane="${lane}"`,
              // A connected clip's offset is relative to its parent's start.
              `offset="${clock(clip.start - segment.start, rate)}"`,
              `start="${clock(clip.in, rate)}"`,
              `duration="${clock(clip.duration, rate)}"`,
              `name="${escape(asset?.name ?? nameOf(clip.src))}"`,
              ...(asset?.hasVideo ? [] : ['audioRole="dialogue"']),
            ]
            return clipTag(clip, inner, '              ')
          }),
          '            </gap>',
        ].join('\n')
      }

      const asset = assets.get(segment.clip.src)
      const attributes = [
        `ref="${assetOf(segment.clip.src)}"`,
        `offset="${clock(segment.start, rate)}"`,
        `start="${clock(segment.clip.in, rate)}"`,
        `duration="${clock(segment.duration, rate)}"`,
        `name="${escape(asset?.name ?? nameOf(segment.clip.src))}"`,
      ]
      if (children.length === 0) return clipTag(segment.clip, attributes, '            ')
      return [
        `            <asset-clip ${attributes.join(' ')}>`,
        ...children.map(({ clip, lane }) => {
          const childAsset = assets.get(clip.src)
          const inner = [
            `ref="${assetOf(clip.src)}"`,
            `lane="${lane}"`,
            `offset="${clock(clip.start - segment.start, rate)}"`,
            `start="${clock(clip.in, rate)}"`,
            `duration="${clock(clip.duration, rate)}"`,
            `name="${escape(childAsset?.name ?? nameOf(clip.src))}"`,
            ...(childAsset?.hasVideo ? [] : ['audioRole="dialogue"']),
          ]
          return clipTag(clip, inner, '              ')
        }),
        '            </asset-clip>',
      ].join('\n')
    })
    .join('\n')

  const assetXml = [...assets.values()]
    .map((asset) => {
      const attributes = [
        `id="${asset.id}"`,
        `name="${escape(asset.name)}"`,
        `start="0s"`,
        `duration="${clock(asset.duration, rate)}"`,
        `hasVideo="${asset.hasVideo ? 1 : 0}"`,
        `hasAudio="${asset.hasAudio ? 1 : 0}"`,
        ...(asset.hasVideo || IMAGE.test(asset.src) ? ['format="r1"'] : []),
      ]
      return [
        `    <asset ${attributes.join(' ')}>`,
        `      <media-rep kind="original-media" src="${escape(fileUrl(options.fileFor(asset.src)))}"/>`,
        '    </asset>',
      ].join('\n')
    })
    .join('\n')

  const label = escape(options.eventName ?? doc.name)
  const project = escape(doc.name)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.9">',
    '  <resources>',
    `    <format id="r1" name="FFVideoFormat${doc.settings.height}p${Math.round(doc.settings.frameRate)}" frameDuration="${rate.num}/${rate.den}s" width="${doc.settings.width}" height="${doc.settings.height}"/>`,
    assetXml,
    '  </resources>',
    '  <library>',
    `    <event name="${label}">`,
    `      <project name="${project}">`,
    `        <sequence format="r1" duration="${clock(total, rate)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '          <spine>',
    spineXml,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n')
}
