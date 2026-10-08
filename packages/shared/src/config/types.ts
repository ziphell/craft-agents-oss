/**
 * Config Types (Browser-safe)
 *
 * Pure type definitions for configuration.
 * Re-exports from @craft-agent/core for compatibility.
 */

// Re-export all config types from core (single source of truth)
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

/**
 * Where the app's proxy comes from: nowhere (`direct`), the operating system's
 * own settings (`system`), or the ones below (`custom`).
 */
export type NetworkProxyMode = 'direct' | 'system' | 'custom';

/** App-level network proxy configuration. */
export interface NetworkProxySettings {
  mode: NetworkProxyMode;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  /**
   * Whether loopback (127.0.0.1, ::1, localhost) bypasses the proxy in custom
   * mode. Defaults to true — the app's own local connections depend on it.
   */
  bypassLoopback?: boolean;
}
