import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isTerminalStatus,
  listMediaTasks,
  readMediaTask,
  removeMediaTask,
  taskPathFor,
  writeMediaTask,
  type MediaTask,
} from '../tasks.ts'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-tasks-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const task = (overrides: Partial<MediaTask> = {}): MediaTask => ({
  id: 't1',
  requestVersion: 1,
  status: 'running',
  outPath: join(dir, 'out', 'clip.mp4'),
  channelId: 'relay',
  kind: 'video',
  prompt: 'a wave',
  references: [],
  attempts: 0,
  createdAt: 1000,
  updatedAt: 1000,
  expiresAt: 2000,
  ...overrides,
})

describe('a task file sits beside the artifact it will become', () => {
  test('the path is the artifact plus .task.json', () => {
    expect(taskPathFor('/p/canvas/assets/clip.mp4')).toBe('/p/canvas/assets/clip.mp4.task.json')
  })

  test('writing creates the folder and reading returns the same task', () => {
    const written = writeMediaTask(task(), 5000)
    expect(existsSync(taskPathFor(task().outPath))).toBe(true)
    expect(written.updatedAt).toBe(5000)

    const read = readMediaTask(task().outPath)
    expect(read?.prompt).toBe('a wave')
    expect(read?.providerTaskId).toBeUndefined()
    expect(read?.expiresAt).toBe(2000)
  })

  test('the provider id survives a round trip — it is what a resume needs', () => {
    writeMediaTask(task({ providerTaskId: 'p-9', attempts: 3 }))
    expect(readMediaTask(task().outPath)?.providerTaskId).toBe('p-9')
    expect(readMediaTask(task().outPath)?.attempts).toBe(3)
  })

  test('the conversation that asked survives too, so the finished note can say it', () => {
    writeMediaTask(task({ sessionId: 's-7' }))
    expect(readMediaTask(task().outPath)?.sessionId).toBe('s-7')
  })

  test('a renamed artifact is remembered at the requested path', () => {
    const requested = join(dir, 'out', 'speech.mp3')
    const finalPath = join(dir, 'out', 'speech.wav')
    writeMediaTask(
      task({ status: 'succeeded', kind: 'music', outPath: requested, finalPath }),
    )

    expect(readMediaTask(requested)?.finalPath).toBe(finalPath)
    expect(readMediaTask(finalPath)).toBeNull()
  })

  test('removing it is how a finished job stops being a job', () => {
    writeMediaTask(task())
    removeMediaTask(task().outPath)
    expect(readMediaTask(task().outPath)).toBeNull()
  })

  test('a file that is not a task, and a task that is not readable, are both null', () => {
    expect(readMediaTask(join(dir, 'nothing.png'))).toBeNull()
    mkdirSync(join(dir, 'out'), { recursive: true })
    writeFileSync(taskPathFor(task().outPath), '{ broken')
    expect(readMediaTask(task().outPath)).toBeNull()
  })

  test('a task without a channel is not a task', () => {
    const path = taskPathFor(task().outPath)
    mkdirSync(join(dir, 'out'), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...task(), channelId: undefined }))
    expect(readMediaTask(task().outPath)).toBeNull()
  })

  test('an older task file is read as the state it meant', () => {
    const path = taskPathFor(task().outPath)
    mkdirSync(join(dir, 'out'), { recursive: true })
    const { requestVersion: _version, ...withoutVersion } = task()
    writeFileSync(
      path,
      JSON.stringify({ ...withoutVersion, status: 'interrupted' }),
    )

    const read = readMediaTask(task().outPath)
    expect(read?.status).toBe('submission_unknown')
    expect(read?.requestVersion).toBe(1)
  })
})

describe('what is still running in a folder', () => {
  test('finds tasks at any depth, oldest first, and ignores everything else', () => {
    writeMediaTask(task({ id: 'later', createdAt: 30, outPath: join(dir, 'a', 'b', 'x.mp4') }))
    writeMediaTask(task({ id: 'earlier', createdAt: 10, outPath: join(dir, 'y.png') }))
    writeFileSync(join(dir, 'notes.md'), 'hello')

    const found = listMediaTasks(dir)
    expect(found.map((item) => item.id)).toEqual(['earlier', 'later'])
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('hello')
  })

  test('skips tooling folders — a task there is not this project’s work', () => {
    writeMediaTask(task({ outPath: join(dir, 'node_modules', 'pkg', 'x.png') }))
    writeMediaTask(task({ outPath: join(dir, 'canvas', 'y.png') }))
    expect(listMediaTasks(dir).map((item) => item.outPath)).toEqual([join(dir, 'canvas', 'y.png')])
  })
})

describe('terminal states', () => {
  test('only a finished, failed or cancelled task is over', () => {
    expect(isTerminalStatus('succeeded')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('submission_unknown')).toBe(false)
    expect(isTerminalStatus('queued')).toBe(false)
  })
})
