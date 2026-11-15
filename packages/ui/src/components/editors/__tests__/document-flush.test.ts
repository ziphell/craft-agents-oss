import { beforeEach, describe, expect, it } from 'bun:test'
import {
  clearDocumentFlushers,
  flushDocument,
  registerDocumentFlusher,
} from '../document-flush'

/**
 * "Save what you are holding" — the editors' end.
 *
 * What is under test is the contract an agent's read depends on: a path either has an editor behind
 * it that can save, or the answer is `false` and the caller knows the file may be older than the
 * screen. Nothing here pretends a flush happened.
 */
beforeEach(() => {
  clearDocumentFlushers()
})

describe('flushing a document before it is read', () => {
  it('saves what is registered for the path, and says it did', async () => {
    const saved: string[] = []
    registerDocumentFlusher('/ws/a.drawio', async () => {
      saved.push('a')
      return true
    })

    expect(await flushDocument('/ws/a.drawio')).toBe(true)
    expect(saved).toEqual(['a'])
  })

  it('saves every editor showing the same file — a window and a block are both authoritative', async () => {
    const saved: string[] = []
    registerDocumentFlusher('/ws/a.drawio', async () => {
      saved.push('window')
      return true
    })
    registerDocumentFlusher('/ws/a.drawio', async () => {
      saved.push('block')
      return true
    })

    expect(await flushDocument('/ws/a.drawio')).toBe(true)
    expect(saved.sort()).toEqual(['block', 'window'])
  })

  it('answers "no" when nothing is showing the file, rather than a quiet success', async () => {
    expect(await flushDocument('/ws/nothing.drawio')).toBe(false)
  })

  it('answers "no" when an editor saved nothing — a conflict is not a save', async () => {
    // The editor declined in its own words rather than throwing: a conflict it cannot resolve on its
    // own. The file is now knowingly behind the screen, and the caller has to be told.
    registerDocumentFlusher('/ws/a.docx', async () => false)

    expect(await flushDocument('/ws/a.docx')).toBe(false)
  })

  it('answers "no" when an editor refuses — a conflict cannot be saved by the host', async () => {
    registerDocumentFlusher('/ws/a.docx', async () => {
      throw new Error('conflict')
    })

    expect(await flushDocument('/ws/a.docx')).toBe(false)
  })

  it('stops saving when the editor goes away', async () => {
    const saved: string[] = []
    const stop = registerDocumentFlusher('/ws/a.md', async () => {
      saved.push('a')
    })

    stop()

    expect(await flushDocument('/ws/a.md')).toBe(false)
    expect(saved).toEqual([])
  })

  it('reaching the same document by either separator or case', async () => {
    const saved: string[] = []
    registerDocumentFlusher('C:\\Users\\Ryan\\a.drawio', async () => {
      saved.push('a')
      return true
    })

    // The host resolves paths its own way; a flush that misses because of that is the failure this
    // module exists to prevent, so the comparison is deliberately loose.
    expect(await flushDocument('c:/users/ryan/a.drawio')).toBe(true)
    expect(saved).toEqual(['a'])
  })

  it('keeps one editor’s departure from taking the other with it', async () => {
    const saved: string[] = []
    const stop = registerDocumentFlusher('/ws/a.drawio', async () => {
      saved.push('first')
      return true
    })
    registerDocumentFlusher('/ws/a.drawio', async () => {
      saved.push('second')
      return true
    })

    stop()

    expect(await flushDocument('/ws/a.drawio')).toBe(true)
    expect(saved).toEqual(['second'])
  })
})
