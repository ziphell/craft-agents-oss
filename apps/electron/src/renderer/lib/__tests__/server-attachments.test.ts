import { afterEach, describe, expect, it } from 'bun:test'
import { readServerAttachment } from '../server-attachments'

const globalScope = globalThis as unknown as { window?: unknown }
const originalWindow = globalScope.window

function stubReadFileBinary(path: string, bytes: Uint8Array): void {
  globalScope.window = {
    electronAPI: {
      readFileBinary: async (requested: string) => {
        expect(requested).toBe(path)
        return bytes
      },
    },
  }
}

afterEach(() => {
  globalScope.window = originalWindow
})

describe('readServerAttachment', () => {
  it('marks the attachment as server-backed and infers a text file', async () => {
    stubReadFileBinary('/srv/data/notes.md', new TextEncoder().encode('hello'))

    const attachment = await readServerAttachment('/srv/data/notes.md')

    expect(attachment).toEqual({
      type: 'text',
      path: '/srv/data/notes.md',
      name: 'notes.md',
      mimeType: 'text/markdown',
      base64: 'aGVsbG8=',
      size: 5,
      fromServer: true,
    })
  })

  it('infers images and office documents by extension', async () => {
    stubReadFileBinary('/srv/pic.PNG', new Uint8Array([1, 2, 3]))
    expect((await readServerAttachment('/srv/pic.PNG')).type).toBe('image')

    stubReadFileBinary('/srv/report.docx', new Uint8Array([1]))
    expect((await readServerAttachment('/srv/report.docx')).type).toBe('office')
  })

  it('uses the Windows separator when reading the filename', async () => {
    stubReadFileBinary('C:\\data\\log.txt', new TextEncoder().encode('x'))

    const attachment = await readServerAttachment('C:\\data\\log.txt')

    expect(attachment.name).toBe('log.txt')
    expect(attachment.type).toBe('text')
  })
})
