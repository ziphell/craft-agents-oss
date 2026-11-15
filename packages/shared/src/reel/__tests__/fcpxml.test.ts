import { describe, expect, test } from 'bun:test'
import {
  addClip,
  addTrack,
  emptyDocument,
  insertFreezeFrame,
  setClipSpeed,
  setSettings,
  setTrack,
} from '../document.ts'
import { toFcpxml } from '../fcpxml.ts'

const fileFor = (src: string) => `/project/${src}`

describe('FCPXML — the cut as an interchange file', () => {
  test('header, sequence format and one asset per source', () => {
    let doc = emptyDocument('预告')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 4, start: 0 })
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 2, start: 6 })

    const xml = toFcpxml(doc, { fileFor })
    expect(xml).toContain('<fcpxml version="1.9">')
    expect(xml).toContain('frameDuration="1/30s" width="1920" height="1080"')
    // One source, used twice, is one asset.
    expect(xml.match(/<asset /g)).toHaveLength(1)
    expect(xml).toContain('src="file:///project/assets/a.mp4"')
    expect(xml).toContain('duration="8s"')
  })

  test('the base track is the spine, and a hole stays a gap', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 2, start: 0 })
    doc = addClip(doc, { src: 'assets/b.mp4', duration: 2, start: 5 })

    const xml = toFcpxml(doc, { fileFor })
    expect(xml).toContain('<gap offset="2s" start="0s" duration="3s"/>')
    expect(xml).toContain('<asset-clip ref="r3" offset="5s" start="0s" duration="2s" name="b.mp4"/>')
  })

  test('upper tracks and sound tracks become connected clips with lanes', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/base.mp4', duration: 6, start: 0 })
    doc = addTrack(doc, 'video')
    doc = addClip(doc, { src: 'assets/face.mp4', duration: 2, start: 1, trackId: 'video-2' })
    doc = addTrack(doc, 'audio')
    doc = addClip(doc, { src: 'assets/music.mp3', duration: 6, start: 0, trackId: 'audio-1' })

    const xml = toFcpxml(doc, { fileFor })
    // Lane 1 sits above the spine; its offset is relative to the parent clip.
    expect(xml).toContain('lane="1" offset="1s"')
    // Sound sits below it.
    expect(xml).toContain('lane="-1" offset="0s"')
    expect(xml).toContain('audioRole="dialogue"')
  })

  test('a hidden video track is not exported as a layer', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/base.mp4', duration: 4, start: 0 })
    doc = addTrack(doc, 'video')
    doc = addClip(doc, { src: 'assets/face.mp4', duration: 2, start: 1, trackId: 'video-2' })
    doc = setTrack(doc, 'video-2', { hidden: true })

    expect(toFcpxml(doc, { fileFor })).not.toContain('lane="1"')
  })

  test('an upper clip that starts in a gap is connected to the gap', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 2, start: 0 })
    doc = addTrack(doc, 'video')
    doc = addClip(doc, { src: 'assets/b.mp4', duration: 2, start: 4, trackId: 'video-2' })

    const xml = toFcpxml(doc, { fileFor })
    expect(xml).toContain('<gap offset="2s" start="0s" duration="4s">')
    // The connected offset is measured from the gap's start, not the sequence's.
    expect(xml).toContain('lane="1" offset="2s"')
  })

  test('names are escaped and paths are encoded', () => {
    let doc = emptyDocument('A & B')
    doc = addClip(doc, { src: 'assets/a & b.mp4', duration: 1, start: 0 })

    const xml = toFcpxml(doc, { fileFor })
    expect(xml).toContain('<event name="A &amp; B">')
    expect(xml).toContain('<project name="A &amp; B">')
    expect(xml).toContain('name="a &amp; b.mp4"')
    expect(xml).toContain('src="file:///project/assets/a%20%26%20b.mp4"')
    // A whole second on 30 fps is one second, not 30/30.
    expect(xml).toContain('duration="1s"')
  })

  test('NTSC rates keep their 1001-based frame duration', () => {
    let doc = setSettings(emptyDocument('cut'), { frameRate: 29.97 })
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 1, start: 0 })

    const xml = toFcpxml(doc, { fileFor })
    expect(xml).toContain('frameDuration="1001/30000s"')
    expect(xml).toContain('duration="1001/1000s"')
  })

  test('a speeded clip is retimed with a timeMap', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 4, start: 0 })
    doc = setClipSpeed(doc, doc.tracks[0]!.clips[0]!.id, 2)

    const xml = toFcpxml(doc, { fileFor })
    expect(xml).toContain('<timeMap>')
    expect(xml).toContain('<timept time="0s" value="0s" interp="linear"/>')
    // The clip occupies 2 s on the timeline and walks 4 s of source.
    expect(xml).toContain('<timept time="2s" value="4s" interp="linear"/>')
    expect(xml).not.toContain('<asset-clip ref="r2" offset="0s" start="0s" duration="2s" name="a.mp4"/>')
  })

  test('a held frame is a constant timeMap, so the source does not advance', () => {
    let doc = emptyDocument('cut')
    doc = addClip(doc, { src: 'assets/a.mp4', duration: 4, start: 0 })
    doc = insertFreezeFrame(doc, doc.tracks[0]!.clips[0]!.id, 2, 1.5)!

    const xml = toFcpxml(doc, { fileFor })
    // 1.5 s of timeline, zero seconds of source — a hold, not a play-forward.
    expect(xml).toContain('<timept time="3/2s" value="0s" interp="linear"/>')
    expect(xml).toContain('start="2s" duration="3/2s"')
  })
})
