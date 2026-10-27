/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  EVENT_BUFFER_MAX_SIZE,
  EVENT_BUFFER_TTL_MS,
  DISCONNECTED_CLIENT_TTL_MS,
  RPC_CHANNELS,
  isErrorCode,
  type MessageEnvelope,
  type PushTarget,
  type ErrorCode,
  type ConnectedClientInfo,
} from '@craft-agent/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from './types'
import type { TokenContext, TokenGrant, TokenKind, TokenScope } from './tokens'
import { scopePermits, type ConnectionRole } from './capabilities'
import { serializeEnvelope, deserializeEnvelope } from './codec'
import { createLogger } from '@craft-agent/shared/utils'

// ---------------------------------------------------------------------------
// Client connection state
// ---------------------------------------------------------------------------

/**
 * Events that are a live view rather than state: they go out and are never replayed.
 *
 * A browser frame is one picture of a tab. Buffering it would fill the replay window with
 * megabytes no viewer can use after the fact, and a reconnecting client would receive a burst
 * of stale pictures before the live one. Losing a frame is free — the next one lands.
 */
const EPHEMERAL_CHANNELS = new Set<string>([
  RPC_CHANNELS.browserPane.STREAM_FRAME,
])

interface BufferedEvent {
  seq: number
  /** Shared serialized envelope — one allocation referenced by all client buffers. */
  data: string
  timestamp: number
}

interface ClientConnection {
  id: string
  ws: WebSocket
  workspaceId: string | null
  webContentsId: number | null
  capabilities: Set<string>
  /** Identity advertised on handshake — shown in the server's client list. */
  name: string
  /** Stable device identity (survives reconnects); null for clients that don't send one. */
  deviceId: string | null
  /** Folders this device authorized for this server (device access only). */
  allowedRoots: string[]
  /** Root of this device's per-hub working directories (`<base>/<hub device id>/<workspace id>`). */
  hubRootBase: string | null
  platform: string | null
  /** App version the client advertised; diagnostics only, never a compatibility gate. */
  version: string | null
  /** Local = this server's own windows; remote = thin clients / browser clients. */
  mode: 'local' | 'remote'
  /** What the client declared this connection for; null for a client that predates the field. */
  role: ConnectionRole | null
  /** The credential this client authenticated with; null for a cookie session. */
  tokenId: string | null
  /** What kind of credential that is — a device pairing token or this hub's server token. */
  tokenKind: TokenKind | null
  /** What that credential permits. `device` clients answer calls and issue none. */
  scope: TokenScope
  /** False once a credential is revoked: the connection is dropped and not held for reconnect. */
  retainForReconnect: boolean
  connectedAt: number
  missedPongs: number
  alive: boolean
  /** Ring buffer of recent events for replay on reconnect. */
  eventBuffer: BufferedEvent[]
  /** Highest per-client seq the client has acknowledged. */
  lastAckedSeq: number
  /** Highest per-client seq assigned to this client. */
  lastSentSeq: number
}

interface PendingInvoke {
  clientId: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface WsRpcTlsOptions {
  /** PEM-encoded certificate (or Buffer). */
  cert: string | Buffer
  /** PEM-encoded private key (or Buffer). */
  key: string | Buffer
  /** Optional PEM-encoded CA chain for client certificate verification. */
  ca?: string | Buffer
  /** Optional passphrase for encrypted private keys. */
  passphrase?: string
}

export interface WsRpcServerOptions {
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string
  /** Port to bind to. 0 = random available port. Default: 0 */
  port?: number
  /** Whether to require a bearer token on handshake. Default: false */
  requireAuth?: boolean
  /**
   * Token validator. Called when requireAuth is true. Returning a grant authenticates the client
   * as that credential; returning null refuses the handshake. The caller decides what the grant
   * means — scope, device binding and revocation live in the registry, not here.
   */
  validateToken?: (token: string, context: TokenContext) => Promise<TokenGrant | null>
  /**
   * Optional cookie-based session validator (for web UI auth).
   * Called with the Cookie header from the HTTP upgrade request.
   * If provided, a valid session cookie is accepted as an alternative to a bearer token.
   */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<boolean>
  /** Server identity stamp on outgoing events. Default: 'local' */
  serverId?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /** Maximum concurrent clients. 0 = unlimited. Default: 50 */
  maxClients?: number
  /** Called when a client completes handshake. */
  onClientConnected?: (info: {
    clientId: string
    webContentsId: number | null
    workspaceId: string | null
    capabilities: string[]
    mode: 'local' | 'remote'
    name: string
  }) => void
  /** Called when a client disconnects. */
  onClientDisconnected?: (clientId: string) => void
  /**
   * Optional HTTP request handler for non-WebSocket requests.
   * When provided, regular HTTP requests to the server's port are
   * routed here instead of being rejected. This enables serving the
   * WebUI from the same port as the WebSocket server.
   * Must use Node.js HTTP callback signature (IncomingMessage, ServerResponse).
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

const transportLog = createLogger('ws-rpc-server')

// ---------------------------------------------------------------------------
// WsRpcServer
// ---------------------------------------------------------------------------

export class WsRpcServer implements RpcServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private httpsServer: HttpsServer | null = null
  private clients = new Map<string, ClientConnection>()
  private handlers = new Map<string, HandlerFn>()
  private pendingInvokes = new Map<string, PendingInvoke>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _port = 0
  private _protocol: 'ws' | 'wss' = 'ws'

  /** Recently disconnected clients retained for reconnect replay. */
  private disconnectedClients = new Map<string, { client: ClientConnection; timer: ReturnType<typeof setTimeout> }>()

  private readonly host: string
  private readonly requestedPort: number
  private readonly requireAuth: boolean
  private readonly validateToken: WsRpcServerOptions['validateToken'] | null
  private readonly validateSessionCookie: ((cookieHeader: string | null) => Promise<boolean>) | null
  private readonly serverId: string
  private readonly tlsOptions: WsRpcTlsOptions | null
  private readonly serverVersion: string
  private readonly maxClients: number
  private readonly onClientConnected: WsRpcServerOptions['onClientConnected']
  private readonly onClientDisconnected: WsRpcServerOptions['onClientDisconnected']
  private readonly httpHandler: WsRpcServerOptions['httpHandler']

  constructor(opts?: WsRpcServerOptions) {
    this.host = opts?.host ?? '127.0.0.1'
    this.requestedPort = opts?.port ?? 0
    this.requireAuth = opts?.requireAuth ?? false
    this.validateToken = opts?.validateToken ?? null
    this.validateSessionCookie = opts?.validateSessionCookie ?? null
    this.serverId = opts?.serverId ?? 'local'
    this.serverVersion = opts?.serverVersion ?? ''
    this.tlsOptions = opts?.tls ?? null
    this.maxClients = opts?.maxClients ?? 50
    this.onClientConnected = opts?.onClientConnected
    this.onClientDisconnected = opts?.onClientDisconnected
    this.httpHandler = opts?.httpHandler
  }

  /** The actual port the server is listening on (available after listen()). */
  get port(): number {
    return this._port
  }

  /** The protocol the server is using: 'wss' when TLS is configured, 'ws' otherwise. */
  get protocol(): 'ws' | 'wss' {
    return this._protocol
  }

  /** Number of currently connected (handshake-completed) clients. */
  getConnectedClientCount(): number {
    return this.clients.size
  }

  /**
   * Snapshot of every live connection — windows, thin clients and app-level device links.
   * Devices are derived from this in `SessionManager`, which is what the hub's UI and
   * `device_tool` list.
   */
  getConnectedClients(): ConnectedClientInfo[] {
    return [...this.clients.values()].map((client) => ({
      clientId: client.id,
      deviceId: client.deviceId,
      allowedRoots: client.allowedRoots,
      hubRootBase: client.hubRootBase,
      name: client.name,
      platform: client.platform,
      version: client.version,
      mode: client.mode,
      workspaceId: client.workspaceId,
      webContentsId: client.webContentsId,
      capabilities: [...client.capabilities],
      scope: client.scope,
      tokenKind: client.tokenKind,
      role: client.role,
      connectedAt: client.connectedAt,
    }))
  }

  /** Whether the client runs on this server's own machine (a local window). */
  isLocalClient(clientId: string): boolean {
    return this.clients.get(clientId)?.mode === 'local'
  }

  /**
   * Drop every connection authenticated with one credential, and forget their replay buffers.
   *
   * Revocation has to reach live sockets: the registry only refuses *new* handshakes, so without
   * this a revoked window would keep working until it happened to reconnect.
   */
  disconnectTokenClients(tokenId: string, reason = 'Credential revoked'): number {
    let dropped = 0
    for (const client of [...this.clients.values()]) {
      if (client.tokenId !== tokenId) continue
      client.retainForReconnect = false
      client.ws.close(4005, reason)
      dropped++
    }
    for (const [id, entry] of [...this.disconnectedClients]) {
      if (entry.client.tokenId !== tokenId) continue
      clearTimeout(entry.timer)
      this.disconnectedClients.delete(id)
    }
    return dropped
  }

  /**
   * Adopt a changed credential scope on the sockets that already hold it.
   *
   * The handshake decides scope once, but a slot's scope can change underneath a live link.
   * Narrowing must take effect at once (a device link must stop calling the hub), and widening must
   * too (the same link must be able to read the hub again after remote control is turned back on).
   * Neither needs a reconnect: scope is consulted per request, never baked into the socket.
   */
  applyTokenScope(tokenId: string, scope: TokenScope): number {
    let changed = 0
    for (const client of this.clients.values()) {
      if (client.tokenId !== tokenId) continue
      client.scope = scope
      // The client keeps its own copy for the UI; tell it rather than waiting for a reconnect.
      this.push(RPC_CHANNELS.server.TOKEN_SCOPE, { to: 'client', clientId: client.id }, scope)
      changed++
    }
    for (const entry of this.disconnectedClients.values()) {
      if (entry.client.tokenId !== tokenId) continue
      entry.client.scope = scope
    }
    return changed
  }

  /**
   * Re-check every connection holding one credential and drop only the ones its scope no longer
   * permits.
   *
   * A scope change is not a revocation. "This machine may no longer open windows here" says
   * nothing about the same machine serving this hub as a device, and both connections carry the
   * same credential — so dropping by credential made them knock each other over: closing remote
   * access bounced the device link and forced it to reconnect for no reason. Asking each
   * connection what it answers, and keeping the ones still allowed, is exactly the question the
   * handshake asks; a scope change just asks it again.
   */
  revalidateTokenClients(
    tokenId: string,
    stillPermitted: (client: { capabilities: ReadonlySet<string>; role: ConnectionRole | null }) => boolean,
    reason = 'Credential scope changed',
  ): number {
    let dropped = 0
    for (const client of [...this.clients.values()]) {
      if (client.tokenId !== tokenId) continue
      if (stillPermitted({ capabilities: client.capabilities, role: client.role })) continue
      client.retainForReconnect = false
      client.ws.close(4005, reason)
      dropped++
    }
    for (const [id, entry] of [...this.disconnectedClients]) {
      if (entry.client.tokenId !== tokenId) continue
      if (stillPermitted({ capabilities: entry.client.capabilities, role: entry.client.role })) continue
      clearTimeout(entry.timer)
      this.disconnectedClients.delete(id)
    }
    return dropped
  }

  // -------------------------------------------------------------------------
  // RpcServer interface
  // -------------------------------------------------------------------------

  handle(channel: string, handler: HandlerFn): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for channel: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  push(channel: string, target: PushTarget, ...args: any[]): void {
    const timestamp = Date.now()

    for (const client of this.clients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, true)
    }

    for (const { client } of this.disconnectedClients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, false)
    }
  }

  hasClientCapability(clientId: string, capability: string): boolean {
    const client = this.clients.get(clientId)
    return !!client && client.capabilities.has(capability)
  }

  findClientsWithCapability(capability: string, opts?: {
    workspaceId?: string
    deviceId?: string
    includeWorkspaceAgnostic?: boolean
  }): string[] {
    const results: string[] = []
    for (const [clientId, client] of this.clients) {
      if (!client.capabilities.has(capability)) continue
      if (opts?.deviceId !== undefined && client.deviceId !== opts.deviceId) continue
      if (opts?.workspaceId !== undefined && client.workspaceId !== opts.workspaceId) {
        // Device links have no workspace of their own; they act in the workspace the call names.
        if (!(opts.includeWorkspaceAgnostic && client.workspaceId === null)) continue
      }
      results.push(clientId)
    }
    return results
  }

  getClientDeviceId(clientId: string): string | null {
    return this.clients.get(clientId)?.deviceId ?? null
  }

  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any> {
    return this.invokeClientWithTimeout(clientId, channel, args, 30_000)
  }

  invokeClientWithTimeout(clientId: string, channel: string, args: any[], timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = this.clients.get(clientId)

      // Check connection
      if (!client) {
        const err = new Error(`Client not connected: ${clientId}`)
        ;(err as any).code = 'CLIENT_DISCONNECTED'
        reject(err)
        return
      }

      // Check capability
      if (!client.capabilities.has(channel)) {
        const err = new Error(`Client lacks capability: ${channel}`)
        ;(err as any).code = 'CAPABILITY_UNAVAILABLE'
        reject(err)
        return
      }

      const id = randomUUID()
      const timeout = setTimeout(() => {
        this.pendingInvokes.delete(id)
        const err = new Error(`Client request timeout: ${channel} (${timeoutMs}ms)`)
        ;(err as any).code = 'CLIENT_REQUEST_TIMEOUT'
        reject(err)
      }, timeoutMs)

      this.pendingInvokes.set(id, { clientId, resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
        serverId: this.serverId,
      }
      this.safeSend(client.ws, serializeEnvelope(envelope))
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.tlsOptions) {
        // TLS mode: create HTTPS server, attach WebSocketServer to it.
        // When httpHandler is set, regular HTTP requests are served by it
        // (e.g. WebUI), while ws intercepts WebSocket upgrade requests.
        this._protocol = 'wss'
        this.httpsServer = createHttpsServer(
          {
            cert: this.tlsOptions.cert,
            key: this.tlsOptions.key,
            ca: this.tlsOptions.ca,
            passphrase: this.tlsOptions.passphrase,
          },
          this.httpHandler,
        )

        this.wss = new WebSocketServer({ server: this.httpsServer })

        this.httpsServer.on('error', (err) => reject(err))

        this.httpsServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpsServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else if (this.httpHandler) {
        // Plain WS + HTTP handler: create an HTTP server for both.
        this._protocol = 'ws'
        this.httpServer = createHttpServer(this.httpHandler)
        this.wss = new WebSocketServer({ server: this.httpServer })

        this.httpServer.on('error', (err) => reject(err))

        this.httpServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else {
        // Plain WS mode, no HTTP handler
        this._protocol = 'ws'
        this.wss = new WebSocketServer({
          host: this.host,
          port: this.requestedPort,
        })

        this.wss.on('listening', () => {
          const addr = this.wss!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })

        this.wss.on('error', (err) => {
          reject(err)
        })
      }

      this.wss.on('connection', (ws, req) => {
        this.onConnection(ws, req.headers.cookie ?? null)
      })
    })
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // Reject all pending invokes before tearing down connections
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timeout)
      const err = new Error('Server shutting down')
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
    for (const client of this.clients.values()) {
      client.ws.terminate()
    }
    this.clients.clear()
    // Clean up disconnected client timers
    for (const entry of this.disconnectedClients.values()) {
      clearTimeout(entry.timer)
    }
    this.disconnectedClients.clear()
    this.wss?.close()
    this.wss = null
    this.httpServer?.close()
    this.httpServer = null
    this.httpsServer?.close()
    this.httpsServer = null
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket, upgradeRequestCookie: string | null): void {
    // Reject if at capacity
    if (this.maxClients > 0 && this.clients.size >= this.maxClients) {
      transportLog.warn('Connection rejected: at capacity', {
        maxClients: this.maxClients,
        current: this.clients.size,
      })
      ws.close(4008, 'Server at capacity')
      return
    }

    let handshakeCompleted = false
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null

    // Give the client 5 seconds to send a handshake
    handshakeTimeout = setTimeout(() => {
      if (!handshakeCompleted) {
        ws.close(4001, 'Handshake timeout')
      }
    }, 5_000)

    ws.on('message', async (raw) => {
      let envelope: MessageEnvelope
      try {
        envelope = deserializeEnvelope(raw.toString())
      } catch {
        ws.close(4002, 'Invalid JSON')
        return
      }

      if (!handshakeCompleted) {
        if (envelope.type !== 'handshake') {
          ws.close(4003, 'Expected handshake')
          return
        }

        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout)
          handshakeTimeout = null
        }

        // Protocol version check (required)
        if (!envelope.protocolVersion || typeof envelope.protocolVersion !== 'string') {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Missing protocolVersion. This server speaks protocol ${PROTOCOL_VERSION}; ` +
            'upgrade the client — it predates version negotiation.')
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        const clientMajor = parseInt(envelope.protocolVersion.split('.')[0] ?? '0', 10)
        const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0] ?? '0', 10)
        if (clientMajor !== serverMajor) {
          // App versions are allowed to differ; only the wire shape has to agree. Say both numbers
          // and the way out, because "protocol unsupported" alone leaves the person with no move.
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Incompatible protocol: this server speaks ${PROTOCOL_VERSION}, the client speaks ` +
            `${envelope.protocolVersion}. App versions may differ, but the protocol major must ` +
            'match — upgrade either side.')
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        // Auth check — bearer token OR session cookie (web UI)
        let grant: { tokenId: string | null; scope: TokenScope; kind?: TokenKind; probe?: boolean } | null = null
        if (this.requireAuth) {
          // 1. Bearer token (standard path). The registry decides scope, and claims/binds a
          //    device slot on its first use. A probe validates without claiming.
          if (envelope.token && this.validateToken) {
            grant = await this.validateToken(envelope.token, {
              deviceId: envelope.clientInfo?.deviceId?.trim() || null,
              probe: envelope.clientInfo?.probe === true,
            })
          }

          // 2. Fallback: cookie session from the HTTP upgrade request (web UI path). A session is
          //    always a full client of this hub; it belongs to no bearer record.
          if (!grant && this.validateSessionCookie && upgradeRequestCookie) {
            if (await this.validateSessionCookie(upgradeRequestCookie)) {
              grant = { tokenId: null, scope: 'client' }
            }
          }

          if (!grant) {
            const reason = envelope.token ? 'Invalid token' : 'Token required'
            this.sendError(ws, envelope.id, 'AUTH_FAILED', reason)
            ws.close(4005, 'Auth failed')
            return
          }
        }

        // A probe asked only "can I reach this server, and what may this credential do?". It is
        // answered from the handshake and never becomes a client: no device record, no slot claim,
        // and no channel access. That is what lets Test Connection run before the connection (and
        // its device access / allowed folders) has been saved.
        if (grant?.probe) {
          handshakeCompleted = true
          this.safeSend(ws, serializeEnvelope({
            id: envelope.id,
            type: 'handshake_ack',
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: this.serverVersion || undefined,
            clientId: `probe-${randomUUID()}`,
            // A probe may call nothing; an empty list says so without relying on the client.
            registeredChannels: [],
            tokenScope: grant.scope,
          }))
          return
        }

        // What the credential may do and what this connection will do are two different claims,
        // and the handshake carries both. A scoped credential can be narrowed while a socket is
        // still open — that is what revoking access from the hub's device list does — and the
        // client reconnects under the same still-valid token. Refusing here is what makes that a
        // single readable refusal at connect time instead of a SCOPE_FORBIDDEN on every call
        // from a window that should not have been allowed back at all.
        //
        // After the probe branch above: a probe declares no capabilities and exists to learn
        // what a credential may do, so it must not be refused by its own answer.
        if (grant && !scopePermits(grant.scope, envelope.clientInfo?.role, envelope.clientCapabilities ?? [])) {
          // The credential may only lend this machine, and this connection is a window. Device
          // use is not a scope question, so a device link is never refused here — even when it
          // declares no tools because the person turned device use off.
          const message =
            'This credential cannot open windows on this server: remote control is not allowed for it.'
          this.sendError(ws, envelope.id, 'REMOTE_CONTROL_DENIED', message)
          ws.close(4005, message)
          return
        }

        // ── Reconnect attempt ──
        if (envelope.reconnectClientId && envelope.lastSeq != null) {
          const entry = this.disconnectedClients.get(envelope.reconnectClientId)
          if (entry) {
            const prevClient = entry.client

            // Identity must match (workspace + webContentsId)
            const identityMatch =
              prevClient.workspaceId === (envelope.workspaceId ?? null) &&
              prevClient.webContentsId === (envelope.webContentsId ?? null)

            if (identityMatch) {
              // Valid reconnect — prepare client state but do NOT add to
              // this.clients yet. The client stays in disconnectedClients
              // during replay so that push() can't interleave new events
              // between replayed ones. (Currently safe due to Node.js
              // single-threading, but this ordering makes the invariant
              // explicit and future-proof.)
              clearTimeout(entry.timer)

              prevClient.ws = ws
              prevClient.alive = true
              prevClient.missedPongs = 0
              // The handshake carries identity again; roots can change while a client was away
              // (a workspace added, a config dir moved), so the reconnected connection takes the
              // latest answer instead of the one it disconnected with.
              if (envelope.clientInfo?.allowedRoots) {
                prevClient.allowedRoots = envelope.clientInfo.allowedRoots
              }
              if (envelope.clientInfo?.hubRootBase) {
                prevClient.hubRootBase = envelope.clientInfo.hubRootBase
              }
              // A device can be upgraded while its connection is merely asleep; the latest
              // advertised version is the one the client list should show.
              const advertisedVersion = envelope.clientInfo?.version?.trim()
              if (advertisedVersion) prevClient.version = advertisedVersion
              // A reconnect presents a credential again; the connection carries the one it just
              // proved, not the one it disconnected with.
              if (grant) {
                prevClient.tokenId = grant.tokenId
                prevClient.scope = grant.scope
              }
              handshakeCompleted = true

              // Determine replay vs stale using the per-client delivery sequence.
              // Retained buffers continue collecting events while the client is disconnected,
              // but TTL eviction still applies during the reconnect window.
              this.evictBuffer(prevClient)

              const lastSeq = envelope.lastSeq as number
              const hasMissedEvents = lastSeq < prevClient.lastSentSeq
              const firstBufferedSeq = prevClient.eventBuffer[0]?.seq
              const canReplay = !hasMissedEvents
                ? true
                : firstBufferedSeq != null && lastSeq >= firstBufferedSeq - 1

              if (canReplay) {
                const replayEvents = prevClient.eventBuffer.filter(e => e.seq > lastSeq)

                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  tokenScope: prevClient.scope,
                  reconnected: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                // Replay missed events in order
                for (const event of replayEvents) {
                  this.safeSend(ws, event.data)
                }

                transportLog.info('Client reconnected with replay', {
                  clientId: prevClient.id,
                  replayedCount: replayEvents.length,
                  lastSeq,
                })
              } else {
                // Buffer evicted — client must full-refresh
                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  tokenScope: prevClient.scope,
                  reconnected: true,
                  stale: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                transportLog.info('Client reconnected as stale', {
                  clientId: prevClient.id,
                  lastSeq,
                  firstBufferedSeq,
                  lastSentSeq: prevClient.lastSentSeq,
                })
              }

              // Atomic state transition: move from disconnected → active
              // AFTER replay is complete so push() can't target this client mid-replay.
              this.disconnectedClients.delete(envelope.reconnectClientId)
              this.clients.set(prevClient.id, prevClient)

              this.setupClientHandlers(ws, prevClient)
              this.onClientConnected?.({
                clientId: prevClient.id,
                webContentsId: prevClient.webContentsId,
                workspaceId: prevClient.workspaceId,
                capabilities: [...prevClient.capabilities],
                mode: prevClient.mode,
                name: prevClient.name,
              })
              return
            }

            // Identity mismatch — fall through to fresh connect
            transportLog.warn('Reconnect identity mismatch', {
              reconnectClientId: envelope.reconnectClientId,
            })
          }
          // reconnectClientId not found — fall through to fresh connect
        }

        // ── Normal fresh connect ──
        const clientId = randomUUID()
        const client: ClientConnection = {
          id: clientId,
          ws,
          workspaceId: envelope.workspaceId ?? null,
          webContentsId: envelope.webContentsId ?? null,
          capabilities: new Set(envelope.clientCapabilities ?? []),
          name: envelope.clientInfo?.name?.trim() || 'Unknown client',
          deviceId: envelope.clientInfo?.deviceId?.trim() || null,
          allowedRoots: envelope.clientInfo?.allowedRoots ?? [],
          hubRootBase: envelope.clientInfo?.hubRootBase ?? null,
          platform: envelope.clientInfo?.platform ?? null,
          version: envelope.clientInfo?.version?.trim() || null,
          mode: envelope.clientInfo?.mode === 'local' ? 'local' : 'remote',
          role: envelope.clientInfo?.role === 'window' || envelope.clientInfo?.role === 'device'
            ? envelope.clientInfo.role
            : null,
          tokenId: grant?.tokenId ?? null,
          tokenKind: grant?.kind ?? null,
          scope: grant?.scope ?? 'client',
          retainForReconnect: true,
          connectedAt: Date.now(),
          missedPongs: 0,
          alive: true,
          eventBuffer: [],
          lastAckedSeq: 0,
          lastSentSeq: 0,
        }
        this.clients.set(clientId, client)
        handshakeCompleted = true

        // Send handshake_ack
        const ack: MessageEnvelope = {
          id: envelope.id,
          type: 'handshake_ack',
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: this.serverVersion || undefined,
          clientId,
          registeredChannels: [...this.handlers.keys()],
          tokenScope: grant?.scope ?? 'client',
        }
        this.safeSend(ws, serializeEnvelope(ack))

        // Notify lifecycle listener
        transportLog.info('Client connected', {
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
        })
        this.onClientConnected?.({
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
          capabilities: [...client.capabilities],
          mode: client.mode,
          name: client.name,
        })

        this.setupClientHandlers(ws, client)
        return
      }

      // Post-handshake: find the client for this ws
      const client = this.findClientByWs(ws)
      if (!client) {
        ws.close(4006, 'Unknown client')
        return
      }

      if (envelope.type === 'request') {
        await this.onRequest(client, envelope)
      } else if (envelope.type === 'response') {
        this.onClientResponse(envelope)
      } else if (envelope.type === 'sequence_ack') {
        const ackSeq = envelope.lastSeq
        if (typeof ackSeq === 'number' && ackSeq > client.lastAckedSeq) {
          client.lastAckedSeq = ackSeq
          // Evict acknowledged events
          const buf = client.eventBuffer
          let removeCount = 0
          while (removeCount < buf.length && buf[removeCount]!.seq <= ackSeq) {
            removeCount++
          }
          if (removeCount > 0) {
            buf.splice(0, removeCount)
          }
        }
      }
    })

    ws.on('error', () => {
      // Connection errors are handled by the close event
    })
  }

  // -------------------------------------------------------------------------
  // Request dispatching
  // -------------------------------------------------------------------------

  /** Server-side timeout for RPC handler execution (ms). */
  private static readonly HANDLER_TIMEOUT_MS = 60_000

  private async onRequest(client: ClientConnection, envelope: MessageEnvelope): Promise<void> {
    const { channel, id, args } = envelope

    if (!channel) {
      this.sendResponseError(client.ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel')
      return
    }

    // A device credential lends this machine's shell and files to the hub; it is not a way to
    // drive the hub. Refusing here is what keeps a leaked device token from becoming a client.
    if (client.scope === 'device') {
      this.sendResponseError(
        client.ws, id, channel, 'SCOPE_FORBIDDEN',
        'This credential may only serve device capabilities; it cannot call server channels.',
      )
      return
    }

    const handler = this.handlers.get(channel)
    if (!handler) {
      this.sendResponseError(client.ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`)
      return
    }

    const ctx: RequestContext = {
      clientId: client.id,
      workspaceId: client.workspaceId,
      webContentsId: client.webContentsId,
    }

    try {
      const result = await Promise.race([
        handler(ctx, ...(args ?? [])),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Handler timeout: ${channel} (${WsRpcServer.HANDLER_TIMEOUT_MS}ms)`)),
            WsRpcServer.HANDLER_TIMEOUT_MS),
        ),
      ])
      const response: MessageEnvelope = {
        id,
        type: 'response',
        channel,
        result,
      }
      this.safeSend(client.ws, serializeEnvelope(response))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rawCode = (err as { code?: unknown } | null)?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR'
      this.sendResponseError(client.ws, id, channel, code, message)
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [, client] of this.clients) {
        // Skip sockets that are already closing/closed (e.g. terminated on a previous tick)
        if (client.ws.readyState !== client.ws.OPEN) continue

        if (!client.alive) {
          client.missedPongs++
          if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
            // Let the close handler (setupClientHandlers) handle all cleanup:
            // clients.delete, buffer retention for reconnect, onClientDisconnected.
            client.ws.terminate()
            continue
          }
        }
        client.alive = false
        client.ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Wire up close + pong handlers for a WebSocket ↔ ClientConnection pair. */
  private setupClientHandlers(ws: WebSocket, client: ClientConnection): void {
    ws.on('close', () => {
      transportLog.info('Client disconnected', { clientId: client.id })
      this.clients.delete(client.id)

      // Retain buffer for potential reconnect — unless the credential behind this connection was
      // revoked. Reviving a revoked client would hand it its pending events on the next handshake.
      if (client.retainForReconnect) {
        const timer = setTimeout(() => {
          this.disconnectedClients.delete(client.id)
        }, DISCONNECTED_CLIENT_TTL_MS)
        this.disconnectedClients.set(client.id, { client, timer })

        // Cap disconnectedClients to prevent unbounded growth
        if (this.disconnectedClients.size > 50) {
          const oldestKey = this.disconnectedClients.keys().next().value
          if (oldestKey) {
            const oldest = this.disconnectedClients.get(oldestKey)
            if (oldest) clearTimeout(oldest.timer)
            this.disconnectedClients.delete(oldestKey)
          }
        }
      }

      this.rejectPendingInvokesForClient(client.id)
      this.onClientDisconnected?.(client.id)
    })

    ws.on('pong', () => {
      client.alive = true
      client.missedPongs = 0
    })
  }

  /** Assign a per-client seq, retain the event for replay, and optionally send it immediately. */
  private bufferAndMaybeSendEvent(
    client: ClientConnection,
    channel: string,
    args: any[],
    timestamp: number,
    shouldSend: boolean,
  ): void {
    client.lastSentSeq += 1
    const seq = client.lastSentSeq

    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: 'event',
      channel,
      args,
      serverId: this.serverId,
      seq,
    }

    const data = serializeEnvelope(envelope)

    // A live view goes out and is forgotten: no buffer entry, no replay after a reconnect.
    if (EPHEMERAL_CHANNELS.has(channel)) {
      if (shouldSend) this.safeSend(client.ws, data)
      return
    }

    client.eventBuffer.push({ seq, data, timestamp })
    this.evictBuffer(client)

    if (shouldSend) {
      this.safeSend(client.ws, data)
    }
  }

  /** Evict stale/oversized entries from a client's event buffer via batch splice. */
  private evictBuffer(client: ClientConnection): void {
    const buf = client.eventBuffer
    if (buf.length === 0) return

    const now = Date.now()
    let removeCount = 0

    // Evict by TTL
    while (removeCount < buf.length &&
           now - buf[removeCount]!.timestamp > EVENT_BUFFER_TTL_MS) {
      removeCount++
    }

    // Evict by size (keep at most EVENT_BUFFER_MAX_SIZE after TTL eviction)
    const remaining = buf.length - removeCount
    if (remaining > EVENT_BUFFER_MAX_SIZE) {
      removeCount += remaining - EVENT_BUFFER_MAX_SIZE
    }

    // Single splice instead of O(n) shift loop
    if (removeCount > 0) {
      buf.splice(0, removeCount)
    }
  }

  private matchesTarget(client: ClientConnection, target: PushTarget): boolean {
    switch (target.to) {
      case 'all':
        return target.exclude ? client.id !== target.exclude : true
      case 'workspace':
        if (target.exclude && client.id === target.exclude) return false
        return client.workspaceId === target.workspaceId
      case 'client':
        return client.id === target.clientId
      default:
        return false
    }
  }

  /** Update a client's workspaceId (called after SWITCH_WORKSPACE so push routing stays correct). */
  updateClientWorkspace(clientId: string, workspaceId: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.workspaceId = workspaceId
    }
  }

  private findClientByWs(ws: WebSocket): ClientConnection | undefined {
    for (const client of this.clients.values()) {
      if (client.ws === ws) return client
    }
    return undefined
  }

  /** Handler/request errors — sent as type:'response' with error field. */
  private sendResponseError(
    ws: WebSocket, id: string, channel: string | undefined,
    code: ErrorCode, message: string,
  ): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'response',
      channel,
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  /** Protocol-level errors only (handshake rejection, version mismatch). May close connection. */
  private sendError(ws: WebSocket, id: string, code: ErrorCode, message: string): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'error',
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  private onClientResponse(envelope: MessageEnvelope): void {
    const pending = this.pendingInvokes.get(envelope.id)
    if (!pending) return

    this.pendingInvokes.delete(envelope.id)
    clearTimeout(pending.timeout)

    if (envelope.error) {
      const err = new Error(envelope.error.message)
      ;(err as any).code = envelope.error.code
      ;(err as any).data = envelope.error.data
      pending.reject(err)
    } else {
      pending.resolve(envelope.result)
    }
  }

  private rejectPendingInvokesForClient(clientId: string): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.clientId !== clientId) continue
      clearTimeout(pending.timeout)
      const err = new Error(`Client disconnected: ${clientId}`)
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(data)
    }
  }
}
