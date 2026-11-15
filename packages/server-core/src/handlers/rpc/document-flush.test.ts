import { beforeEach, describe, expect, it } from 'bun:test'
import { clearOpenDocuments, openDocument, setDocumentDirty } from '@craft-agent/shared/office/open-documents'
import { CLIENT_DOCUMENT_FLUSH } from '../../transport/capabilities'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { requestDirtyDocumentFlush, requestDocumentFlush } from './office'

/**
 * "Save what you are holding" — the routing half.
 *
 * A flush is addressed to the connection that said it had the document open, so these cases are
 * about the address rather than about saving: nobody showing it (nothing to ask), an editor that
 * refuses (a conflict), and a client that never answers (a hung tool call is worse than an older
 * file).
 */
function server(answer?: (path: string) => unknown): { server: RpcServer; calls: Array<{ clientId: string; channel: string; path: string }> } {
  const calls: Array<{ clientId: string; channel: string; path: string }> = []
  return {
    calls,
    server: {
      handle() {},
      push() {},
      async invokeClient(clientId: string, channel: string, ...args: unknown[]) {
        const path = (args[0] as { path: string }).path
        calls.push({ clientId, channel, path })
        if (!answer) return undefined
        const result = answer(path)
        if (result instanceof Promise) return result
        return result
      },
      hasClientCapability() {
        return false
      },
      findClientsWithCapability() {
        return []
      },
    } as unknown as RpcServer,
  }
}

beforeEach(() => clearOpenDocuments())

describe('asking an editor to save what it holds', () => {
  it('asks the client that has the document open', async () => {
    openDocument('/ws/a.docx', 'client-7')
    const { server: rpc, calls } = server(() => ({ ok: true }))

    expect(await requestDocumentFlush(rpc, '/ws/a.docx')).toEqual({ ok: true })
    expect(calls).toEqual([{ clientId: 'client-7', channel: CLIENT_DOCUMENT_FLUSH, path: '/ws/a.docx' }])
  })

  it('asks nobody when no editor is showing it — the file is already the newest thing there is', async () => {
    const { server: rpc, calls } = server(() => ({ ok: true }))

    expect(await requestDocumentFlush(rpc, '/ws/not-open.docx')).toBeNull()
    expect(calls).toEqual([])
  })

  it('carries the editor’s refusal, rather than reporting a save that did not happen', async () => {
    openDocument('/ws/a.docx', 'client-1')
    const { server: rpc } = server(() => ({ ok: false, message: 'a conflict is open' }))

    expect(await requestDocumentFlush(rpc, '/ws/a.docx')).toEqual({ ok: false, message: 'a conflict is open' })
  })

  it('turns a broken connection into an answer instead of an exception', async () => {
    openDocument('/ws/a.docx', 'client-1')
    const { server: rpc } = server(() => {
      throw new Error('that client is gone')
    })

    expect(await requestDocumentFlush(rpc, '/ws/a.docx')).toEqual({ ok: false, message: 'that client is gone' })
  })
})

describe('flushing everything that is holding work', () => {
  it('asks only about the documents with unsaved work', async () => {
    openDocument('/ws/a.docx', 'client-1')
    openDocument('/ws/b.drawio', 'client-2')
    setDocumentDirty('/ws/b.drawio', true)
    const { server: rpc, calls } = server(() => ({ ok: true }))

    const results = await requestDirtyDocumentFlush(rpc, ['/ws/b.drawio'])

    expect(results).toEqual([{ path: '/ws/b.drawio', ok: true }])
    expect(calls.map((call) => call.clientId)).toEqual(['client-2'])
  })

  it('asks in parallel, so a document and its diagram do not queue behind each other', async () => {
    openDocument('/ws/a.docx', 'client-1')
    openDocument('/ws/b.drawio', 'client-2')
    const seen: string[] = []
    const { server: rpc } = server((path) => {
      seen.push(path)
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5))
    })

    const results = await requestDirtyDocumentFlush(rpc, ['/ws/a.docx', '/ws/b.drawio'])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(seen).toHaveLength(2)
  })

  it('gives up rather than holding a tool call open forever', async () => {
    openDocument('/ws/a.docx', 'client-1')
    // A client that never answers is a real case: a page mid-reload, or one that crashed.
    const { server: rpc } = server(() => new Promise(() => {}))

    const results = await requestDirtyDocumentFlush(rpc, ['/ws/a.docx'], 20)

    expect(results).toEqual([
      { path: '/ws/a.docx', ok: false, message: 'the editor did not answer in time' },
    ])
  })

  it('does nothing at all when nothing is owed', async () => {
    const { server: rpc, calls } = server(() => ({ ok: true }))

    expect(await requestDirtyDocumentFlush(rpc, [])).toEqual([])
    expect(calls).toEqual([])
  })
})
