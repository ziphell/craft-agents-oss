import { describe, expect, it } from 'bun:test'
import {
  dimensionOf,
  emptyLibraryDoc,
  kindOfPath,
  mergeLibrary,
  normalizeTags,
  readLibraryFile,
  tagFacets,
  withNote,
  withoutEntry,
  withTags,
  writeLibraryFile,
  type AssetFileInfo,
  type LibraryAsset,
} from '../index.ts'
import type { GenerationRecord } from '../../provenance/types.ts'

const file = (path: string, modifiedAt = 0): AssetFileInfo => ({ path, sizeBytes: 1, modifiedAt })

describe('what a file is', () => {
  it('reads a kind from the extension, and calls anything else `other`', () => {
    expect(kindOfPath('assets/photo.PNG')).toBe('image')
    expect(kindOfPath('assets/clip.mp4')).toBe('video')
    expect(kindOfPath('assets/voice.m4a')).toBe('audio')
    expect(kindOfPath('assets/brief.md')).toBe('text')
    expect(kindOfPath('assets/transcript.srt')).toBe('text')
    expect(kindOfPath('assets/contract.pdf')).toBe('other')
    expect(kindOfPath('assets/no-extension')).toBe('other')
  })
})

describe('the index never asserts existence', () => {
  it('shows a file the index has never heard of, untagged', () => {
    const [asset] = mergeLibrary([file('assets/new.png')], emptyLibraryDoc())
    expect(asset).toMatchObject({ path: 'assets/new.png', tags: [], note: '', kind: 'image' })
  })

  it('does not return an entry whose file is gone', () => {
    const doc = withTags(emptyLibraryDoc(), 'assets/deleted.png', ['角色:小美'], 'human')
    expect(mergeLibrary([], doc)).toEqual([])
  })

  it('opens newest first', () => {
    const assets = mergeLibrary([file('assets/a.png', 1), file('assets/b.png', 5)], emptyLibraryDoc())
    expect(assets.map((asset) => asset.path)).toEqual(['assets/b.png', 'assets/a.png'])
  })
})

describe('tags', () => {
  it('trims, drops a leading #, collapses spaces and removes repeats', () => {
    expect(normalizeTags(['  #角色:小美 ', '角色:小美', '', '场景:  办公室'])).toEqual([
      '角色:小美',
      '场景: 办公室',
    ])
  })

  it('splits a dimension off the first colon only', () => {
    expect(dimensionOf('角色:小美')).toBe('角色')
    expect(dimensionOf('场景:办公室:夜')).toBe('场景')
    expect(dimensionOf('待定')).toBe('')
  })

  it('builds facets from the tags that exist, never from a fixed list', () => {
    const assets = mergeLibrary(
      [file('assets/a.png'), file('assets/b.png')],
      withTags(
        withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美', '场景:办公室'], 'human'),
        'assets/b.png',
        ['角色:阿强', '待定'],
        'agent',
      ),
    )
    expect(tagFacets(assets)).toEqual([
      { dimension: '场景', values: ['办公室'] },
      { dimension: '角色', values: ['小美', '阿强'] },
      { dimension: '', values: ['待定'] },
    ])
  })
})

describe('changes', () => {
  it('keeps who wrote an entry and when', () => {
    const doc = withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美'], 'agent', 42)
    expect(doc.entries['assets/a.png']).toEqual({ tags: ['角色:小美'], by: 'agent', at: 42 })
  })

  it('removes the entry when the last tag and the note are gone', () => {
    let doc = withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美'], 'human')
    doc = withTags(doc, 'assets/a.png', [], 'human')
    expect(doc.entries).toEqual({})
  })

  it('keeps an entry that has a note but no tags', () => {
    let doc = withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美'], 'human')
    doc = withNote(doc, 'assets/a.png', '开场用', 'human')
    doc = withTags(doc, 'assets/a.png', [], 'human')
    expect(doc.entries['assets/a.png']).toMatchObject({ tags: [], note: '开场用' })
  })

  it('forgets an entry without touching the document identity', () => {
    const doc = withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美'], 'human')
    expect(withoutEntry(doc, 'assets/a.png').entries).toEqual({})
    expect(withoutEntry(doc, 'assets/missing.png')).toBe(doc)
  })
})

describe('the index file', () => {
  it('round-trips', () => {
    const doc = withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美'], 'human', 7)
    const read = readLibraryFile(writeLibraryFile(doc))
    expect(read).toEqual({ ok: true, doc })
  })

  it('refuses a file that is not a library, without pretending it read one', () => {
    expect(readLibraryFile('nope').ok).toBe(false)
    expect(readLibraryFile('[]').ok).toBe(false)
    expect(readLibraryFile('{"schemaVersion":2,"entries":{}}').ok).toBe(false)
  })

  it('keeps the entries it can read and names the ones it could not', () => {
    const read = readLibraryFile(
      JSON.stringify({
        schemaVersion: 1,
        entries: { 'assets/a.png': { tags: ['角色:小美'] }, 'assets/b.png': 'oops' },
      }),
    )
    expect(read.ok).toBe(false)
    expect(read.doc.entries['assets/a.png']).toEqual({ tags: ['角色:小美'] })
    if (!read.ok) expect(read.message).toContain('assets/b.png')
  })
})

describe('merge is not affected by the index having extra detail', () => {
  it('carries tags and note onto the file', () => {
    const doc = withNote(
      withTags(emptyLibraryDoc(), 'assets/a.png', ['角色:小美'], 'agent'),
      'assets/a.png',
      '开场',
      'agent',
    )
    const assets: LibraryAsset[] = mergeLibrary([file('assets/a.png')], doc)
    expect(assets[0]).toMatchObject({ tags: ['角色:小美'], note: '开场', name: 'a.png' })
  })

  it('carries the generation note onto the asset that names it', () => {
    const record: GenerationRecord = {
      file: 'assets/a.png',
      prompt: 'a lighthouse at dusk',
      references: ['assets/ref.png'],
      channel: 'relay',
      model: 'image-model',
      at: 1,
    }
    const assets = mergeLibrary([file('assets/a.png')], emptyLibraryDoc(), [record])
    expect(assets[0]?.source).toEqual(record)
  })

  it('leaves an upload without a source, rather than inventing one', () => {
    const [asset] = mergeLibrary([file('assets/upload.png')], emptyLibraryDoc(), [])
    expect(asset?.source).toBeUndefined()
  })
})
