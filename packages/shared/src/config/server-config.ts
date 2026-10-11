/**
 * Server mode configuration — controls whether the Electron app
 * accepts remote connections from other machines.
 *
 * When enabled, the app binds to 0.0.0.0 on a fixed port instead of
 * localhost on a random port, allowing thin clients to connect.
 */

export interface ServerConfig {
  /** Whether remote server mode is active (fixed port vs a random localhost port) */
  enabled: boolean
  /** Fixed port to listen on (default 9100) */
  port: number
  /**
   * Bind to all interfaces (0.0.0.0) so other machines can connect. When false the
   * server only listens on 127.0.0.1. Defaults to true, preserving the historical
   * behaviour where enabling server mode exposed the app on the network.
   */
  allowExternal: boolean
  /** Path to PEM certificate file (enables TLS / wss://) */
  tlsCertPath?: string
  /** Path to PEM private key file (required when cert is set) */
  tlsKeyPath?: string
  /** Stable auth token for remote clients (auto-generated on first enable) */
  token?: string
  /**
   * Public WebSocket URL the WebUI should connect to. Needed when browsers reach
   * the server through a reverse proxy or a port mapping whose external port
   * differs from `port` (e.g. `wss://agents.example.com/craft`). When unset, the
   * URL is derived from the request host and `port`.
   */
  publicWsUrl?: string
}

export interface ServerStatus {
  /** Whether the server is currently running */
  running: boolean
  /** Current bind address */
  host: string
  /** Current port */
  port: number
  /** Whether TLS is active */
  tls: boolean
  /** Full connection URL (ws:// or wss://) */
  url: string
  /** Current auth token */
  token: string
  /** Whether saved config differs from running config (restart needed) */
  needsRestart: boolean
  /** True when server is bound to a network address without TLS */
  insecureWarning: boolean
  /** Whether the running server is bound to a network address (0.0.0.0) */
  allowExternal: boolean
  /** Configured public WS URL (reverse proxy / port mapping), when set */
  publicWsUrl?: string
  /** Set when the configured port was unavailable and a random one was used instead */
  bindError?: string
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  enabled: false,
  port: 9100,
  allowExternal: true,
}
