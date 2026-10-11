/**
 * WebUI runtime abstraction.
 *
 * The WebUI HTTP handler is shared between the headless Bun server and (in a
 * later stage) the Electron main process, which runs on Node. A few operations
 * have no runtime-neutral built-in — static asset streaming and password
 * hashing — so they are collected behind this interface and resolved per runtime
 * instead of calling `Bun.*` (or Node `fs`/`crypto`) directly from the handler.
 *
 * Select a runtime with {@link createDefaultWebuiRuntime}, or pass an explicit
 * implementation via `WebuiHandlerOptions.runtime`.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

export interface WebuiRuntime {
  /**
   * Open a built asset for streaming as a response body.
   * Returns `null` when the path does not exist or is not a regular file.
   */
  openAsset(absPath: string): Promise<ReadableStream<Uint8Array> | null>
  /** Produce a self-describing password hash. */
  hashPassword(plaintext: string): Promise<string>
  /** Constant-time password verification against a hash from {@link hashPassword}. */
  verifyPassword(plaintext: string, hash: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Bun implementation — preserves existing headless behaviour
// ---------------------------------------------------------------------------

function createBunWebuiRuntime(): WebuiRuntime {
  return {
    async openAsset(absPath) {
      const file = Bun.file(absPath)
      if (!(await file.exists())) return null
      return file.stream() as ReadableStream<Uint8Array>
    },
    async hashPassword(plaintext) {
      return Bun.password.hash(plaintext, { algorithm: 'argon2id' })
    },
    async verifyPassword(plaintext, hash) {
      return Bun.password.verify(plaintext, hash)
    },
  }
}

// ---------------------------------------------------------------------------
// Node implementation — no extra dependencies
// ---------------------------------------------------------------------------

const SCRYPT_SCHEME = 'scrypt'
const SCRYPT_KEYLEN = 64
const SCRYPT_SALT_BYTES = 16

function scrypt(plaintext: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(plaintext, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

function createNodeWebuiRuntime(): WebuiRuntime {
  return {
    async openAsset(absPath) {
      try {
        const info = await stat(absPath)
        if (!info.isFile()) return null
      } catch {
        return null
      }
      return Readable.toWeb(createReadStream(absPath)) as unknown as ReadableStream<Uint8Array>
    },
    async hashPassword(plaintext) {
      const salt = randomBytes(SCRYPT_SALT_BYTES)
      const key = await scrypt(plaintext, salt)
      return `${SCRYPT_SCHEME}$${salt.toString('base64')}$${key.toString('base64')}`
    },
    async verifyPassword(plaintext, hash) {
      const parts = hash.split('$')
      if (parts.length !== 3 || parts[0] !== SCRYPT_SCHEME) return false
      const salt = Buffer.from(parts[1]!, 'base64')
      const expected = Buffer.from(parts[2]!, 'base64')
      const actual = await scrypt(plaintext, salt)
      if (actual.length !== expected.length) return false
      return timingSafeEqual(actual, expected)
    },
  }
}

/**
 * Pick the implementation matching the current runtime.
 *
 * `Bun` global presence is the discriminator, matching the check already used in
 * `bootstrap/headless-start.ts`. The password hash is per-process and never
 * persisted, so the differing hash formats are not a concern.
 */
export function createDefaultWebuiRuntime(): WebuiRuntime {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
    ? createBunWebuiRuntime()
    : createNodeWebuiRuntime()
}

/** Node runtime implementation, exported for tests and explicit wiring. */
export function createNodeRuntime(): WebuiRuntime {
  return createNodeWebuiRuntime()
}
