import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasHistory } from '../history.ts'
import { canvasPath, canvasesDir, createCanvasFile, ensureCanvasFile, legacyCanvasPath, readCanvasFile } from '../files.ts'
import { CanvasFiles, CanvasWriteConflict } from '../store.ts'
import { applyCanvasOps, createCanvasDoc, type CanvasNode } from '../document.ts'

let project = ''
const image = (id: string, x = 0, y = 0): CanvasNode => ({
  id,
  type: 'image',
  src: `generations/${id}.png`,
  x,
  y,
  w: 100,
  h: 100,
  z: 0,
})

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'craft-canvas-'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

const files = () => new CanvasFiles()

describe('files', () => {
  test('a project has one canvas at its root', () => {
    const created = createCanvasFile(project, '品牌片 · 第一版')
    expect(created.slug).toBe('canvas')
    expect(created.path).toBe(canvasPath(project))
    expect(created.path.endsWith('canvas.json')).toBe(true)
    expect(readCanvasFile(created.path)).toEqual(created.doc)
    expect(JSON.parse(readFileSync(created.path, 'utf8')).version).toBe(3)
  })

  test('a version-1 canvas is migrated, and the old file is left alone', () => {
    mkdirSync(canvasesDir(project), { recursive: true })
    const legacy = legacyCanvasPath(project, '旧板')
    const legacyDoc = {
      ...createCanvasDoc('旧板'),
      version: 1,
      nodes: [
        { id: 't1', type: 'text', text: '旧的内嵌文字', x: 0, y: 0, w: 200, h: 40, z: 0 },
        { id: 'i1', type: 'image', src: 'assets/a.png', x: 0, y: 60, w: 100, h: 100, z: 1 },
      ],
    }
    writeFileSync(legacy, JSON.stringify(legacyDoc, null, 2))

    const { path, doc } = ensureCanvasFile(project)
    expect(path).toBe(canvasPath(project))
    expect(doc.version).toBe(3)
    expect(doc.nodes[0]).toMatchObject({ id: 't1', type: 'text', src: 'docs/nodes/t1.md' })
    expect(doc.nodes[0]!.text).toBeUndefined()
    expect(readFileSync(join(project, 'docs/nodes/t1.md'), 'utf8')).toBe('旧的内嵌文字')
    // The version-1 file is still on disk; it is not a second board in the app.
    expect(JSON.parse(readFileSync(legacy, 'utf8')).version).toBe(1)
  })

  test('the most recently edited legacy canvas becomes the project canvas', () => {
    mkdirSync(canvasesDir(project), { recursive: true })
    const older = legacyCanvasPath(project, 'older')
    const newer = legacyCanvasPath(project, 'newer')
    writeFileSync(older, JSON.stringify({ ...createCanvasDoc('older'), version: 1 }, null, 2))
    writeFileSync(newer, JSON.stringify({ ...createCanvasDoc('newer'), version: 1 }, null, 2))
    utimesSync(older, new Date(1000), new Date(1000))
    utimesSync(newer, new Date(2000), new Date(2000))

    expect(ensureCanvasFile(project).doc.name).toBe('newer')
    expect(readCanvasFile(canvasPath(project)).name).toBe('newer')
  })
})

describe('the editor saving what it holds', () => {
  test('the panel applies locally and saves; revision moves on the answer, not before', () => {
    const { path, doc } = createCanvasFile(project, '板')
    const store = files()
    const applied = applyCanvasOps(doc, [{ type: 'add_node', node: image('a') }])

    const saved = store.write(path, applied.doc, ['a'])
    expect(saved.doc.revision).toBe(1)
    expect(saved.ids).toEqual(['a'])
    expect(readCanvasFile(path).nodes.map((node) => node.id)).toEqual(['a'])
  })

  test('a save built on a stale revision is refused and hands back what is there', () => {
    const { path, doc } = createCanvasFile(project, '板')
    const store = files()
    const first = applyCanvasOps(doc, [{ type: 'add_node', node: image('a') }])
    store.write(path, first.doc, ['a'])

    // A panel that still thinks the file is at revision 0.
    const stale = applyCanvasOps(doc, [{ type: 'add_node', node: image('b') }])
    try {
      store.write(path, { ...stale.doc, revision: 0 })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasWriteConflict)
      expect((error as CanvasWriteConflict).actualRevision).toBe(1)
      expect((error as CanvasWriteConflict).doc.nodes.map((node) => node.id)).toEqual(['a'])
    }
    // The refused write changed nothing.
    expect(readCanvasFile(path).nodes.map((node) => node.id)).toEqual(['a'])
  })

  test('pan and zoom are written, never revisioned', () => {
    const { path } = createCanvasFile(project, '板')
    const store = files()
    const next = store.writeViewport(path, { x: -120, y: 40, scale: 0.75 })
    expect(next.revision).toBe(0)
    expect(readCanvasFile(path).viewport).toEqual({ x: -120, y: 40, scale: 0.75 })
  })
})

describe('a batch with nobody watching', () => {
  test('lands on the file, guarded by the revision the caller read', () => {
    const { path } = createCanvasFile(project, '板')
    const store = files()
    const applied = store.applyUnattended(path, {
      ops: [{ type: 'add_node', node: image('a') }],
      expectedRevision: 0,
    })
    expect(applied.doc.revision).toBe(1)
    expect(applied.ids).toEqual(['a'])
    expect(readCanvasFile(path).nodes).toHaveLength(1)
  })

  test('a stale revision is refused rather than applied over a newer file', () => {
    const { path } = createCanvasFile(project, '板')
    const store = files()
    store.applyUnattended(path, { ops: [{ type: 'add_node', node: image('a') }], expectedRevision: 0 })
    expect(() =>
      store.applyUnattended(path, { ops: [{ type: 'add_node', node: image('b') }], expectedRevision: 0 }),
    ).toThrow(CanvasWriteConflict)
    expect(readCanvasFile(path).nodes.map((node) => node.id)).toEqual(['a'])
  })

  test('a refused batch does not move the revision and writes nothing', () => {
    const { path } = createCanvasFile(project, '板')
    expect(() =>
      files().applyUnattended(path, { ops: [{ type: 'remove_nodes', ids: ['nobody'] }], expectedRevision: 0 }),
    ).toThrow(/no node nobody/)
    expect(readCanvasFile(path).revision).toBe(0)
  })
})

describe('the history the panel keeps', () => {
  test('one batch is one step, whoever asked for it', () => {
    const { doc } = createCanvasFile(project, '板')
    const history = new CanvasHistory()
    const afterHuman = applyCanvasOps(doc, [{ type: 'add_node', node: image('a') }]).doc
    history.record({ origin: 'user', label: '加一张图', before: doc, after: afterHuman })
    const afterAgent = applyCanvasOps(afterHuman, [{ type: 'set_node', id: 'a', patch: { w: 200 } }]).doc
    history.record({ origin: 'agent', label: '把这张放大', before: afterHuman, after: afterAgent })

    expect(history.state()).toMatchObject({ canUndo: true, undoLabel: '把这张放大' })
    expect(history.undo()!.nodes[0]!.w).toBe(100)
    expect(history.state().undoLabel).toBe('加一张图')
    expect(history.redo()!.nodes[0]!.w).toBe(200)
  })

  test('an edit after an undo drops the redo tail', () => {
    const base = createCanvasDoc('板')
    const history = new CanvasHistory()
    history.record({ origin: 'user', label: '一', before: base, after: { ...base, revision: 1 } })
    history.record({ origin: 'user', label: '二', before: { ...base, revision: 1 }, after: { ...base, revision: 2 } })
    history.undo()
    history.record({ origin: 'user', label: '三', before: { ...base, revision: 1 }, after: { ...base, revision: 3 } })
    expect(history.state().canRedo).toBe(false)
  })

  test('closing the panel and opening the canvas again starts clean', () => {
    const { path } = createCanvasFile(project, '板')
    const opened = new CanvasHistory()
    const base = readCanvasFile(path)
    opened.record({ origin: 'user', label: '加图', before: base, after: applyCanvasOps(base, [{ type: 'add_node', node: image('a') }]).doc })

    // A fresh mount makes a fresh stack — history is the open panel's, not the file's.
    const reopened = new CanvasHistory()
    expect(reopened.state().canUndo).toBe(false)
    expect(readCanvasFile(canvasPath(project, '板')).nodes).toHaveLength(0)
  })
})
