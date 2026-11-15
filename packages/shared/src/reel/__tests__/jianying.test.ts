import { describe, expect, test } from 'bun:test'
import {
  addClip,
  addOverlay,
  addTrack,
  emptyDocument,
  insertFreezeFrame,
  setClipAudio,
  setClipFade,
  setClipTransform,
  type EditDocument,
} from '../document.ts'
import { toJianyingDraft } from '../jianying.ts'

const NOW = 1_700_000_000_000

const base = (): EditDocument => {
  let doc = emptyDocument('预告')
  doc = addClip(doc, { src: 'assets/a.mp4', duration: 4, start: 0 })
  doc = setClipAudio(doc, doc.tracks[0]!.clips[0]!.id, { volume: 0.8 })
  doc = setClipFade(doc, doc.tracks[0]!.clips[0]!.id, { fadeIn: 0.5 })
  doc = setClipTransform(doc, doc.tracks[0]!.clips[0]!.id, { x: 0.1, scale: 0.9 })
  doc = addTrack(doc, 'audio')
  doc = addClip(doc, {
    src: 'assets/music.mp3',
    duration: 2,
    start: 1,
    trackId: 'audio-1',
  })
  doc = addOverlay(doc, {
    kind: 'text',
    text: '你好',
    start: 0.5,
    duration: 1.5,
    preset: 'subtitle',
  })
  return doc
}

describe('剪映 draft — the JSON 剪映 opens', () => {
  test('canvas, frame rate, duration and platform are written the way 剪映 expects', () => {
    const draft = toJianyingDraft(base(), { now: NOW })
    const content = draft.content

    expect(content.version).toBe(360000)
    expect(content.new_version).toBe('110.0.0')
    expect(content.canvas_config).toEqual({ width: 1920, height: 1080, ratio: '16:9' })
    expect(content.fps).toBe(30)
    expect(content.duration).toBe(4_000_000)
    expect((content.platform as { os: string }).os).toBe('windows')
    expect(draft.meta.tm_duration).toBe(4_000_000)
    expect(draft.meta.tm_draft_create).toBe(NOW * 1000)
  })

  test('each source is one material, named by its file, and listed in the draft meta', () => {
    const draft = toJianyingDraft(base(), { now: NOW })
    const materials = draft.content.materials as {
      videos: Array<Record<string, unknown>>
      audios: Array<Record<string, unknown>>
    }

    expect(materials.videos).toHaveLength(1)
    expect(materials.videos[0]!.path).toBe('a.mp4')
    expect(materials.videos[0]!.material_name).toBe('a.mp4')
    expect(materials.videos[0]!.duration).toBe(4_000_000)
    expect(materials.audios).toHaveLength(1)
    expect(materials.audios[0]!.type).toBe('extract_music')

    const meta = (draft.meta.draft_materials as Array<{ value: Array<Record<string, unknown>> }>)[0]!
    expect(meta.value.map((entry) => entry.file_Path)).toEqual(['a.mp4', 'music.mp3'])
    expect(draft.media).toEqual([
      { src: 'assets/a.mp4', destName: 'a.mp4' },
      { src: 'assets/music.mp3', destName: 'music.mp3' },
    ])
  })

  test('the picture segment carries its window, volume, fade and transform', () => {
    const draft = toJianyingDraft(base(), { now: NOW })
    const tracks = draft.content.tracks as Array<{
      type: string
      segments: Array<Record<string, any>>
    }>
    expect(tracks.map((track) => track.type)).toEqual(['video', 'audio', 'text'])

    const segment = tracks[0]!.segments[0]!
    expect(segment.source_timerange).toEqual({ start: 0, duration: 4_000_000 })
    expect(segment.target_timerange).toEqual({ start: 0, duration: 4_000_000 })
    expect(segment.volume).toBeCloseTo(0.8)
    expect(segment.last_nonzero_volume).toBeCloseTo(0.8)
    // The document's x is a fraction of the frame; 剪映 wants -1..1 of a half-frame.
    expect(segment.clip.transform.x).toBeCloseTo(0.2)
    expect(segment.clip.scale.x).toBeCloseTo(0.9)
    // speed + channel mapping + canvas + audio fade
    expect(segment.extra_material_refs).toHaveLength(4)

    const materials = draft.content.materials as {
      audio_fades: Array<Record<string, unknown>>
      canvases: Array<Record<string, unknown>>
      speeds: Array<Record<string, unknown>>
    }
    expect(materials.audio_fades).toHaveLength(1)
    expect(materials.audio_fades[0]!.fade_in_duration).toBe(500_000)
    expect(materials.canvases).toHaveLength(1)
    expect(materials.speeds).toHaveLength(2)
  })

  test('a muted track is written as zero volume', () => {
    let doc = base()
    doc = setClipAudio(doc, doc.tracks[1]!.clips[0]!.id, { muted: true })
    const tracks = toJianyingDraft(doc, { now: NOW }).content.tracks as Array<{
      type: string
      segments: Array<Record<string, unknown>>
    }>
    const audio = tracks.find((track) => track.type === 'audio')!
    expect(audio.segments[0]!.volume).toBe(0)
  })

  test('a subtitle becomes a text material and segment on its own lane', () => {
    const draft = toJianyingDraft(base(), { now: NOW })
    const materials = draft.content.materials as { texts: Array<Record<string, any>> }
    expect(materials.texts).toHaveLength(1)

    const material = materials.texts[0]!
    expect(material.text_size).toBeCloseTo(46 / 3)
    expect(material.alignment).toBe(1)
    const content = JSON.parse(material.content as string) as {
      text: string
      styles: Array<{ size: number }>
    }
    expect(content.text).toBe('你好')
    expect(content.styles[0]!.size).toBeCloseTo(46 / 3)

    const tracks = draft.content.tracks as Array<{ type: string; segments: Array<Record<string, any>> }>
    const text = tracks.find((track) => track.type === 'text')!
    expect(text.segments[0]!.target_timerange).toEqual({ start: 500_000, duration: 1_500_000 })
    expect(text.segments[0]!.render_index).toBe(14_000)
  })

  test('two overlays that overlap get two text lanes', () => {
    let doc = base()
    doc = addOverlay(doc, { kind: 'text', text: '第二句', start: 1, duration: 1 })
    doc = addOverlay(doc, { kind: 'text', text: '第三句', start: 3, duration: 1 })
    const tracks = toJianyingDraft(doc, { now: NOW }).content.tracks as Array<{ type: string }>
    expect(tracks.filter((track) => track.type === 'text')).toHaveLength(2)
  })

  test('a held frame becomes a near-zero speed segment', () => {
    let doc = emptyDocument('预告')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 4, start: 0 })
    doc = insertFreezeFrame(doc, doc.tracks[0]!.clips[0]!.id, 2, 1.5)!

    const tracks = toJianyingDraft(doc, { now: NOW }).content.tracks as Array<{
      type: string
      segments: Array<Record<string, any>>
    }>
    const freeze = tracks[0]!.segments.find((segment) => segment.speed === 0.01)!
    expect(freeze.target_timerange).toEqual({ start: 2_000_000, duration: 1_500_000 })
    // `source = target × speed` — the invariant 剪映's draft format keeps.
    expect(freeze.source_timerange.duration).toBe(15_000)
  })

  test('sources with the same name are given unique files, and unsupported layers are reported', () => {
    let doc = base()
    doc = addAddOn(doc)
    const draft = toJianyingDraft(doc, { now: NOW })
    expect(draft.media.map((file) => file.destName)).toEqual([
      'a.mp4',
      'a_2.mp4',
      'music.mp3',
    ])
    expect(draft.warnings.join('\n')).toContain('画中画')
  })
})

/** A cut with a same-named source from another folder and a picture-in-picture overlay. */
function addAddOn(doc: EditDocument): EditDocument {
  let next = addClip(doc, { src: 'other/a.mp4', duration: 1, start: 6 })
  next = addOverlay(next, {
    kind: 'media',
    src: 'assets/face.mp4',
    start: 0,
    duration: 1,
    box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 },
  })
  return next
}
