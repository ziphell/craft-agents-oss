import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefaultWebuiRuntime, createNodeRuntime } from '../runtime'

const dir = mkdtempSync(join(tmpdir(), 'craft-webui-runtime-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createNodeRuntime', () => {
  const runtime = createNodeRuntime()

  it('streams an existing asset', async () => {
    const filePath = join(dir, 'index.html')
    writeFileSync(filePath, '<h1>hi</h1>')

    const stream = await runtime.openAsset(filePath)

    expect(stream).not.toBeNull()
    expect(await new Response(stream).text()).toBe('<h1>hi</h1>')
  })

  it('returns null for a missing path', async () => {
    expect(await runtime.openAsset(join(dir, 'nope.html'))).toBeNull()
  })

  it('returns null for a directory', async () => {
    const sub = join(dir, 'sub')
    mkdirSync(sub, { recursive: true })

    expect(await runtime.openAsset(sub)).toBeNull()
  })

  it('hashes and verifies a password', async () => {
    const hash = await runtime.hashPassword('s3cret')

    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await runtime.verifyPassword('s3cret', hash)).toBe(true)
    expect(await runtime.verifyPassword('wrong', hash)).toBe(false)
  })

  it('rejects a malformed hash', async () => {
    expect(await runtime.verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})

describe('createDefaultWebuiRuntime', () => {
  // These tests run under Bun, so the default resolves to the Bun implementation.
  const runtime = createDefaultWebuiRuntime()

  it('round-trips a password', async () => {
    const hash = await runtime.hashPassword('pw')

    expect(await runtime.verifyPassword('pw', hash)).toBe(true)
    expect(await runtime.verifyPassword('nope', hash)).toBe(false)
  })
})
