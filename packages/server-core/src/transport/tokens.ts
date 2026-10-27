/**
 * Credentials a hub accepts, and what each one is allowed to do.
 *
 * Two kinds share one registry:
 *
 * - the **server** token, which lives in the config and authenticates this machine's windows and
 *   clients that were handed it before device tokens existed;
 * - **device** tokens, created as slots in the hub's device list. A slot starts unbound
 *   (`deviceId: null`) and is claimed by the first device that connects with it; from then on it
 *   only accepts that device, never expires, and cannot be transferred. Removing a slot deletes
 *   the record — there is no "back to pending".
 *
 * Scope decides what a caller may do: `client` can call server channels, `device` may only answer
 * capability calls (a machine lending its shell, not a window), `both` may do either.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

export type TokenScope = 'client' | 'device' | 'both'
export type TokenKind = 'server' | 'device'

/** What a validated token is: which record, what kind, and what it may do. */
export interface TokenGrant {
  tokenId: string
  scope: TokenScope
  /** `device` = a one-to-one pairing token; `server` = this hub's own master token. */
  kind?: TokenKind
  /** True for a reachability check — the slot is not claimed and the connection may do nothing. */
  probe?: boolean
}

export interface TokenSpec {
  token: string
  /** Shown in the server's own list of credentials. */
  label: string
  scope: TokenScope
  kind: TokenKind
}

/** A record safe to show in the hub's device list. */
export interface TokenSummary {
  id: string
  label: string
  scope: TokenScope
  kind: TokenKind
  /** The device that claimed this slot; null until then. */
  deviceId: string | null
  /**
   * The plaintext token while the slot is still pending, so it stays copyable after creation.
   * Cleared when the slot is claimed — the device already holds it, and the hub keeps only a hash.
   */
  token: string | null
  createdAt: number
  lastUsedAt: number | null
}

/** The on-disk shape of a device token (the server token stays in the config). */
export interface PersistedToken {
  id: string
  label: string
  scope: TokenScope
  hash: string
  /** Present only while the slot is pending, for the copy button in the device list. */
  token?: string
  deviceId: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface TokenRegistryOptions {
  /** Device tokens restored from disk. */
  deviceTokens?: PersistedToken[]
  /** Called with every device token whenever they change. */
  persist?: (tokens: PersistedToken[]) => void
}

export interface TokenContext {
  /** The device identity carried by the handshake, when it advertised one. */
  deviceId: string | null
  /** A reachability check: validate the credential, but do not claim an unbound slot. */
  probe?: boolean
}

interface TokenEntry extends TokenGrant {
  kind: TokenKind
  hash: string
  /** Plaintext while a device slot is pending; null for the server token and claimed slots. */
  secret: string | null
  label: string
  deviceId: string | null
  createdAt: number
  lastUsedAt: number | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** A 48-character random token, suitable for handing to one device. */
export function generateDeviceToken(): string {
  return randomBytes(24).toString('hex')
}

/** `Bearer <token>` → token. Shared by the Web UI's HTTP bearer paths. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]! : null
}

export class ServerTokenRegistry {
  private readonly entries = new Map<string, TokenEntry>()
  private readonly byHash = new Map<string, string>()
  private persistFn: ((tokens: PersistedToken[]) => void) | null = null

  constructor(options: TokenRegistryOptions = {}) {
    this.persistFn = options.persist ?? null
    this.restore(options.deviceTokens ?? [])
  }

  /** Load device tokens from disk. Does not write back. */
  restore(deviceTokens: PersistedToken[]): void {
    for (const record of deviceTokens) {
      if (!record?.id || !record.hash) continue
      this.entries.set(record.id, {
        tokenId: record.id,
        scope: record.scope === 'device' || record.scope === 'client' ? record.scope : 'both',
        kind: 'device',
        hash: record.hash,
        secret: record.token ?? null,
        label: record.label || 'Device',
        deviceId: record.deviceId ?? null,
        createdAt: record.createdAt ?? Date.now(),
        lastUsedAt: record.lastUsedAt ?? null,
      })
      this.byHash.set(record.hash, record.id)
    }
  }

  /** Where device tokens are written. Call after `restore`. */
  setPersist(persist: ((tokens: PersistedToken[]) => void) | null): void {
    this.persistFn = persist
  }

  /** Add a credential. Returns what a caller holding it would be granted. */
  register(spec: TokenSpec): TokenGrant {
    const token = spec.token.trim()
    if (!token) throw new Error('A token cannot be empty')
    const entry: TokenEntry = {
      tokenId: randomUUID(),
      scope: spec.scope,
      kind: spec.kind,
      hash: hashToken(token),
      secret: spec.kind === 'device' ? token : null,
      label: spec.label,
      deviceId: null,
      createdAt: Date.now(),
      lastUsedAt: null,
    }
    this.entries.set(entry.tokenId, entry)
    this.byHash.set(entry.hash, entry.tokenId)
    if (entry.kind === 'device') this.persist()
    return { tokenId: entry.tokenId, scope: entry.scope, kind: entry.kind }
  }

  /**
   * Resolve a presented token for a WebSocket handshake.
   *
   * A device token's first use binds it to the handshake's device identity; later uses must come
   * from that same device. The server token binds to nothing and works from anywhere.
   *
   * A probe (see `TokenContext.probe`) is a reachability check: it validates the credential and
   * returns its scope, but does not claim a pending slot. A bound slot still only answers its own
   * device, so a probe cannot be used to test somebody else's credential.
   */
  authorize(token: string, context: TokenContext): TokenGrant | null {
    const entry = this.lookup(token)
    if (!entry) return null
    const probe = context.probe === true

    if (entry.kind === 'device') {
      const deviceId = context.deviceId?.trim()
      // A slot is for a machine: a client that does not say which machine it is cannot claim it.
      if (!deviceId) return null
      if (entry.deviceId === null) {
        if (!probe) {
          entry.deviceId = deviceId
          // The device now holds the token; the hub keeps only its hash.
          entry.secret = null
          this.persist()
        }
      } else if (entry.deviceId !== deviceId) {
        return null
      }
    }

    entry.lastUsedAt = Date.now()
    return probe
      ? { tokenId: entry.tokenId, scope: entry.scope, kind: entry.kind, probe: true }
      : { tokenId: entry.tokenId, scope: entry.scope, kind: entry.kind }
  }

  /** Resolve a token without a handshake (HTTP bearer paths, e.g. export downloads). */
  validate(token: string): TokenGrant | null {
    const entry = this.lookup(token)
    if (!entry) return null
    entry.lastUsedAt = Date.now()
    return { tokenId: entry.tokenId, scope: entry.scope, kind: entry.kind }
  }

  /** Delete a device slot. The server token lives in the config and cannot be removed here. */
  remove(tokenId: string): boolean {
    const entry = this.entries.get(tokenId)
    if (!entry || entry.kind !== 'device') return false
    this.entries.delete(tokenId)
    this.byHash.delete(entry.hash)
    this.persist()
    return true
  }

  /** Change what a device token may do — e.g. drop it to `device` to revoke remote windows. */
  setScope(tokenId: string, scope: TokenScope): boolean {
    const entry = this.entries.get(tokenId)
    if (!entry) return false
    entry.scope = scope
    if (entry.kind === 'device') this.persist()
    return true
  }

  /** Every credential this hub holds. The UI filters to `kind: 'device'`. */
  list(): TokenSummary[] {
    return [...this.entries.values()].map(summaryOf)
  }

  private lookup(token: string): TokenEntry | null {
    const tokenId = this.byHash.get(hashToken(token))
    if (!tokenId) return null
    const entry = this.entries.get(tokenId)
    if (!entry) return null
    return entry
  }

  private persist(): void {
    this.persistFn?.(this.deviceTokens())
  }

  private deviceTokens(): PersistedToken[] {
    return [...this.entries.values()]
      .filter((entry) => entry.kind === 'device')
      .map((entry) => ({
        id: entry.tokenId,
        label: entry.label,
        scope: entry.scope,
        hash: entry.hash,
        ...(entry.secret ? { token: entry.secret } : {}),
        deviceId: entry.deviceId,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      }))
  }
}

function summaryOf(entry: TokenEntry): TokenSummary {
  return {
    id: entry.tokenId,
    label: entry.label,
    scope: entry.scope,
    kind: entry.kind,
    deviceId: entry.deviceId,
    token: entry.secret,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  }
}
