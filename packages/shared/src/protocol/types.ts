/**
 * Wire protocol types for the WS-based RPC layer.
 *
 * Shared between server (main process / headless) and client (renderer / Node).
 */

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'request'
  | 'response'
  | 'event'
  | 'error'
  | 'sequence_ack'

export interface MessageEnvelope {
  /** Correlation ID. UUIDv4 for requests; echoed in responses. */
  id: string
  type: MessageType
  /** Required for request / response / event / error. */
  channel?: string
  /** Request args or event payload. */
  args?: unknown[]
  /** Response payload. */
  result?: unknown
  /** Structured error. */
  error?: WireError
  /** Sent on handshake / handshake_ack. */
  protocolVersion?: string
  /** Sent on handshake by the client. */
  workspaceId?: string
  /** Sent on handshake for remote auth. */
  token?: string
  /** Assigned by server in handshake_ack. */
  clientId?: string
  /** Server identity stamp on outgoing events. For MultiClient source disambiguation. */
  serverId?: string
  /** Electron webContents.id, sent on handshake by local clients. */
  webContentsId?: number
  /** Client capabilities advertised on handshake. */
  clientCapabilities?: string[]
  /** Client identity advertised on handshake — shown in the server's client list. */
  clientInfo?: ClientInfo
  /** Server-registered channels, sent in handshake_ack. Clients use this to avoid calling unavailable channels. */
  registeredChannels?: string[]
  /**
   * What the credential behind this connection may do, sent in handshake_ack. A probe receives it
   * without being bound to a device slot.
   */
  tokenScope?: 'client' | 'device' | 'both'

  // -- Reliable delivery fields --

  /** Per-client monotonic delivery sequence number, assigned when an event is targeted to that client. */
  seq?: number
  /** Client's last processed per-client seq — sent in sequence_ack and reconnect handshake. */
  lastSeq?: number
  /** Previous clientId — sent by client on reconnect handshake. */
  reconnectClientId?: string
  /** True when handshake_ack is for a reconnection (vs fresh connect). */
  reconnected?: boolean
  /** True when server buffer was evicted — client must do a full state refresh. */
  stale?: boolean
  /** Server app version, sent in handshake_ack. Clients can use this for compatibility checks. */
  serverVersion?: string
}

/**
 * Identity a client advertises on handshake. All fields are optional so older
 * clients (and non-Electron transports such as the CLI) keep working; the
 * server fills in sensible fallbacks for the client list.
 */
export interface ClientInfo {
  /** Human-readable device name (hostname for desktop clients). */
  name?: string
  /** `process.platform` / browser platform string. */
  platform?: string
  /** Whether the client runs on the server's machine or connects from elsewhere. */
  mode?: 'local' | 'remote'
  /**
   * What this connection is for, declared by the client: a view of the hub (`window`) or this
   * machine lending itself (`device`). Declared rather than inferred from capabilities, because a
   * device may turn its own authorization off and declare no tools while remaining a device link.
   *
   * Absent for older clients; the server then falls back to the capability-based inference.
   */
  role?: 'window' | 'device'
  /** Stable per-install id — survives reconnects, unlike `clientId`. */
  deviceId?: string
  /**
   * Folders this device authorized **for the server it is connected to** — a per-connection list,
   * not this install's workspace list. `device_tool` is path-based and does not follow workspaces.
   */
  allowedRoots?: string[]
  /**
   * The directory under which this install keeps one working directory per (hub, workspace):
   * `<hubRootBase>/<hub device id>/<workspace id>`, used when a call omits `cwd`. Informational:
   * the hub does not derive authorization from it.
   */
  hubRootBase?: string
  /**
   * App version this client runs, for diagnostics only.
   *
   * Deliberately **not** a compatibility gate: two installs on different app versions are expected
   * to work, and features that one side lacks are negotiated per channel ({@link
   * MessageEnvelope.registeredChannels}), not by comparing versions.
   */
  version?: string
  /**
   * This handshake only checks that the server is reachable and the credential is valid.
   *
   * A probe is acknowledged with its `tokenScope` and is never registered as a client: it does not
   * claim a device slot, does not appear in the device list, and may not call any channel.
   */
  probe?: boolean
}

/**
 * One device slot on a hub.
 *
 * Created in the hub's device list with a token shown once. It stays `deviceId: null` until a
 * machine connects with that token; from then on the token only accepts that device and cannot be
 * transferred. Removing the slot deletes the record.
 */
export interface DeviceTokenInfo {
  id: string
  label: string
  scope: 'client' | 'device' | 'both'
  /** The device that claimed this slot; null while it is still waiting. */
  deviceId: string | null
  /**
   * The plaintext token while the slot is pending, so it can be copied later. Null once a device
   * has claimed it — the hub then keeps only a hash.
   */
  token: string | null
  createdAt: number
  lastUsedAt: number | null
}

/** One live connection, as the server's transport sees it. */
export interface ConnectedClientInfo {
  clientId: string
  /** Stable device identity, when the client advertises one. */
  deviceId: string | null
  /** Folders this connection authorized for this server (empty for a connection without device access). */
  allowedRoots: string[]
  /** Root of the per-hub working directories this device uses for calls that omit `cwd` (null when not advertised). */
  hubRootBase: string | null
  /** Display name — `clientInfo.name`, or a neutral fallback. */
  name: string
  platform: string | null
  /** App version the client advertised, when it sent one. Diagnostics, not a gate. */
  version: string | null
  /** Local clients are the hub's own windows; remote clients are thin clients elsewhere. */
  mode: 'local' | 'remote'
  /** The role the client declared; null for a client that predates the field. */
  role?: 'window' | 'device' | null
  workspaceId: string | null
  webContentsId: number | null
  capabilities: string[]
  /**
   * What the credential behind this connection permits. `client` means it is here as a window:
   * whatever it declared, this hub does not drive it.
   */
  scope: 'client' | 'device' | 'both'
  /**
   * What authenticated this connection. A one-to-one device pairing token (`device`) is what
   * makes a machine a device record; the hub's own server token (`server`) never does. Null for a
   * session-cookie connection (Web UI), which is a view of the hub.
   */
  tokenKind?: 'server' | 'device' | null
  /** Unix epoch (ms) when the handshake completed. */
  connectedAt: number
}

export interface WireError {
  code: ErrorCode
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'HANDLER_ERROR'
  | 'CHANNEL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'SCOPE_FORBIDDEN'
  /** The credential may not open windows on this server (remote control is off for it). */
  | 'REMOTE_CONTROL_DENIED'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'SESSION_NOT_IDLE'
  | 'SESSION_ID_CONFLICT'
  | 'ARTIFACT_NOT_PORTABLE'
  | 'TRANSFER_TOO_LARGE'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_VERIFICATION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CLIENT_DISCONNECTED'
  | 'CLIENT_REQUEST_TIMEOUT'
  | 'BROWSER_NO_CAPABLE_CLIENT'
  | 'BROWSER_INSTANCE_NOT_OWNED'
  | 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED'
  | 'BROWSER_REMOTE_EVALUATE_BLOCKED'
  | 'BROWSER_REMOTE_PICK_BLOCKED'
  | 'BROWSER_REMOTE_FETCH_BLOCKED'

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'HANDLER_ERROR',
  'CHANNEL_NOT_FOUND',
  'AUTH_FAILED',
  'SCOPE_FORBIDDEN',
  'REMOTE_CONTROL_DENIED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SESSION_NOT_IDLE',
  'SESSION_ID_CONFLICT',
  'ARTIFACT_NOT_PORTABLE',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_TIMEOUT',
  'TRANSFER_VERIFICATION_FAILED',
  'REQUEST_TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'BROWSER_NO_CAPABLE_CLIENT',
  'BROWSER_INSTANCE_NOT_OWNED',
  'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
  'BROWSER_REMOTE_EVALUATE_BLOCKED',
  'BROWSER_REMOTE_PICK_BLOCKED',
  'BROWSER_REMOTE_FETCH_BLOCKED',
])

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

/**
 * Sender-side helper for throwing transport errors with a typed `code`.
 *
 * Class identity is lost across the wire — the transport reconstructs a plain
 * `Error` with `.code` on the receiving side. Receivers MUST branch on
 * `err.code === 'X'`, never `err instanceof CodedError`.
 */
export class CodedError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CodedError'
  }
}

// ---------------------------------------------------------------------------
// Push target (server → clients)
// ---------------------------------------------------------------------------

export type PushTarget =
  | { to: 'all'; exclude?: string }
  | { to: 'workspace'; workspaceId: string; exclude?: string }
  | { to: 'client'; clientId: string }

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = '1.0'

/** Heartbeat interval in ms. Server pings every 30s. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Client that misses this many pongs gets terminated. */
export const HEARTBEAT_MAX_MISSED = 2

/** Default request timeout in ms. */
export const REQUEST_TIMEOUT_MS = 30_000

// -- Reliable delivery constants --

/** Max events to retain per client in the ring buffer. */
export const EVENT_BUFFER_MAX_SIZE = 500

/** Events older than this are evicted from the buffer. */
export const EVENT_BUFFER_TTL_MS = 30_000

/** How long to retain a disconnected client's buffer for potential reconnect. */
export const DISCONNECTED_CLIENT_TTL_MS = 60_000

/** Client sends a sequence_ack every N ms. */
export const SEQUENCE_ACK_INTERVAL_MS = 5_000
