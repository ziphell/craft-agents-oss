import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getProjectLibraryFilePath,
  listProjectLibrary,
  scanProjectAssets,
  setProjectAssetLayout,
  setProjectAssetNote,
  setProjectAssetTags,
} from '../library.ts'
import { writeMediaTask, type MediaTask } from '../../media/tasks.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-library-'))
  mkdirSync(join(root, 'projects', 'demo', 'assets'), { recursive: true })
  mkdirSync(join(root, 'projects', 'demo', 'canvas', 'assets'), { recursive: true })
  writeFileSync(join(root, 'projects', 'demo', 'assets', 'photo.png'), 'x')
  writeFileSync(join(root, 'projects', 'demo', 'assets', 'brief.md'), 'x')
  writeFileSync(join(root, 'projects', 'demo', 'canvas', 'assets', 'clip.mp4'), 'x')
  writeFileSync(join(root, 'projects', 'demo', 'config.json'), '{}')
  writeFileSync(join(root, 'projects', 'demo', 'assets', '.DS_Store'), 'x')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('what the library scans', () => {
  it('lists the assets folder recursively, and nothing outside it', () => {
    writeFileSync(join(root, 'projects', 'demo', 'assets', 'photo.gen.json'), '{}')
    writeFileSync(join(root, 'projects', 'demo', 'assets', 'clip.task.json'), '{}')
    const paths = scanProjectAssets(root, 'demo').map((file) => file.path).sort()
    expect(paths).toEqual(['assets/brief.md', 'assets/photo.png'])
    // Generation history has its own view; a file under `canvas/` is not a second source here.
    expect(paths).not.toContain('canvas/assets/clip.mp4')
    expect(paths).not.toContain('config.json')
  })

  it('shows an unannotated file with no tags', () => {
    const { assets, facets } = listProjectLibrary(root, 'demo')
    expect(assets).toHaveLength(2)
    expect(assets.every((asset) => asset.tags.length === 0)).toBe(true)
    expect(facets).toEqual([])
  })
})

describe('a generated file carries its source', () => {
  it('reads the note beside the asset and attaches it to the library entry', () => {
    writeFileSync(
      join(root, 'projects', 'demo', 'assets', 'photo.gen.json'),
      JSON.stringify({
        file: 'assets/photo.png',
        prompt: 'a lighthouse at dusk',
        references: ['assets/brief.md'],
        channel: 'relay',
        model: 'image-model',
        at: 1,
      }),
    )
    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/photo.png')
    expect(asset?.source).toMatchObject({
      file: 'assets/photo.png',
      prompt: 'a lighthouse at dusk',
      references: ['assets/brief.md'],
      channel: 'relay',
      model: 'image-model',
    })
  })

  it('shows an upload with no source note as having none', () => {
    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/brief.md')
    expect(asset?.source).toBeUndefined()
  })
})

describe('what people and agents say about it', () => {
  it('tags one file without touching the others', () => {
    setProjectAssetTags(root, 'demo', 'assets/photo.png', ['角色:小美'], 'agent')
    const { assets, facets } = listProjectLibrary(root, 'demo')
    expect(assets.find((asset) => asset.path === 'assets/photo.png')?.tags).toEqual(['角色:小美'])
    expect(assets.find((asset) => asset.path === 'assets/brief.md')?.tags).toEqual([])
    expect(facets).toEqual([{ dimension: '角色', values: ['小美'] }])
  })

  it('keeps a note when the tags are cleared', () => {
    setProjectAssetTags(root, 'demo', 'assets/photo.png', ['角色:小美'])
    setProjectAssetNote(root, 'demo', 'assets/photo.png', '开场用')
    setProjectAssetTags(root, 'demo', 'assets/photo.png', [])
    const asset = listProjectLibrary(root, 'demo').assets.find((a) => a.path === 'assets/photo.png')
    expect(asset).toMatchObject({ tags: [], note: '开场用' })
  })

  it('writes the index inside assets as a dotfile, so it is never an asset', () => {
    setProjectAssetTags(root, 'demo', 'assets/photo.png', ['角色:小美'])
    const file = getProjectLibraryFilePath(root, 'demo')
    expect(file.endsWith(join('projects', 'demo', 'assets', '.index.json'))).toBe(true)
    expect(scanProjectAssets(root, 'demo').some((a) => a.path.includes('.index'))).toBe(false)
  })
})

describe('files change outside the app', () => {
  it('forgets the tags of a file that was deleted, without failing', () => {
    setProjectAssetTags(root, 'demo', 'assets/photo.png', ['角色:小美'])
    unlinkSync(join(root, 'projects', 'demo', 'assets', 'photo.png'))
    const { assets } = listProjectLibrary(root, 'demo')
    expect(assets.some((asset) => asset.path === 'assets/photo.png')).toBe(false)
  })

  it('shows a file dropped in by hand immediately', () => {
    writeFileSync(join(root, 'projects', 'demo', 'assets', 'new.webp'), 'x')
    expect(listProjectLibrary(root, 'demo').assets.some((a) => a.path === 'assets/new.webp')).toBe(true)
  })
})

function writeTask(path: string, status: MediaTask['status']): void {
  writeMediaTask({
    id: `task-${path}`,
    requestVersion: 1,
    status,
    outPath: join(root, 'projects', 'demo', path),
    channelId: 'channel',
    kind: 'image',
    prompt: 'a task that declares its artifact',
    references: [],
    attempts: 0,
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 99_999_999_999,
  })
}

describe('the asset registry', () => {
  it('keeps a generated asset whose file is gone as missing', () => {
    writeFileSync(
      join(root, 'projects', 'demo', 'assets', 'gone.gen.json'),
      JSON.stringify({
        file: 'assets/gone.png',
        prompt: 'a lighthouse at dusk',
        references: [],
        at: 10,
      }),
    )

    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/gone.png')
    expect(asset).toMatchObject({
      path: 'assets/gone.png',
      status: 'missing',
      sizeBytes: 0,
      kind: 'image',
      source: { prompt: 'a lighthouse at dusk' },
    })
  })

  it('shows a running generation as pending, before its file exists', () => {
    writeTask('assets/pending.png', 'running')

    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/pending.png')
    expect(asset).toMatchObject({ status: 'pending', kind: 'image' })
    expect(asset?.source).toBeUndefined()
  })

  it('shows a failed generation without an artifact as failed', () => {
    writeTask('assets/broken.png', 'failed')

    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/broken.png')
    expect(asset?.status).toBe('failed')
  })

  it('carries a layout from the index onto the asset', () => {
    setProjectAssetLayout(root, 'demo', 'assets/photo.png', { x: 10, y: 20, w: 100, h: 80, z: 2 })

    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/photo.png')
    expect(asset?.layout).toMatchObject({ x: 10, y: 20, w: 100, h: 80, z: 2 })
  })

  it('keeps a layout-only record for a path with no file', () => {
    setProjectAssetLayout(root, 'demo', 'assets/not-yet.png', { x: 1, y: 2 })

    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/not-yet.png')
    expect(asset).toMatchObject({ status: 'missing', layout: { x: 1, y: 2 } })
  })

  it('moves an entry to where a renamed sound artifact landed', () => {
    setProjectAssetLayout(root, 'demo', 'assets/speech.mp3', { x: 5, y: 6, w: 100, h: 40 })
    writeFileSync(join(root, 'projects', 'demo', 'assets', 'speech.wav'), 'x')
    writeMediaTask({
      id: 'task-renamed',
      requestVersion: 1,
      status: 'succeeded',
      outPath: join(root, 'projects', 'demo', 'assets', 'speech.mp3'),
      finalPath: join(root, 'projects', 'demo', 'assets', 'speech.wav'),
      channelId: 'channel',
      kind: 'music',
      prompt: 'a jingle',
      references: [],
      attempts: 0,
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 99_999_999_999,
    })

    const { assets } = listProjectLibrary(root, 'demo')
    expect(assets.find((item) => item.path === 'assets/speech.wav')?.layout).toMatchObject({
      x: 5,
      y: 6,
    })
    expect(assets.some((item) => item.path === 'assets/speech.mp3')).toBe(false)

    // A write is where the stale entry is cleaned up for real, not only on the next read.
    setProjectAssetNote(root, 'demo', 'assets/speech.wav', 'the dub')
    const doc = JSON.parse(readFileSync(getProjectLibraryFilePath(root, 'demo'), 'utf8')) as {
      entries: Record<string, unknown>
    }
    expect(doc.entries['assets/speech.mp3']).toBeUndefined()
  })

  it('clears a layout without deleting the tag or note beside it', () => {
    setProjectAssetTags(root, 'demo', 'assets/photo.png', ['角色:小美'])
    setProjectAssetLayout(root, 'demo', 'assets/photo.png', { x: 10, y: 20 })
    setProjectAssetLayout(root, 'demo', 'assets/photo.png', null)

    const asset = listProjectLibrary(root, 'demo').assets.find((item) => item.path === 'assets/photo.png')
    expect(asset?.layout).toBeUndefined()
    expect(asset?.tags).toEqual(['角色:小美'])
  })
})

describe('a damaged index', () => {
  it('is reported and read as empty rather than replaced', () => {
    writeFileSync(getProjectLibraryFilePath(root, 'demo'), 'not json')
    const snapshot = listProjectLibrary(root, 'demo')
    expect(snapshot.warning).toBeTruthy()
    expect(snapshot.assets).toHaveLength(2)
    expect(() => setProjectAssetTags(root, 'demo', 'assets/photo.png', ['角色:小美'])).toThrow()
  })
})
