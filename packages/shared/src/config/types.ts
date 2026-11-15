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

/**
 * Which service the agent searches the web with.
 *
 * `auto` follows the active model connection: its own search when it has one
 * (OpenAI, ChatGPT, OpenRouter, Google, DeepSeek), DuckDuckGo when it does not.
 * `duckduckgo` and `deepseek` name a service explicitly; DeepSeek needs the
 * search key stored in Settings → AI. Whether search exists at all is the
 * separate `webSearchEnabled` switch.
 */
export const WEB_SEARCH_PROVIDER_PREFERENCES = [
  'auto',
  'duckduckgo',
  'deepseek',
] as const;

export type WebSearchProviderPreference = (typeof WEB_SEARCH_PROVIDER_PREFERENCES)[number];

export function isWebSearchProviderPreference(value: unknown): value is WebSearchProviderPreference {
  return typeof value === 'string' && (WEB_SEARCH_PROVIDER_PREFERENCES as readonly string[]).includes(value);
}

/**
 * How `web_fetch` reads a page.
 *
 * `direct` fetches and extracts in the app (free, handles PDF/images/JSON).
 * `deepseek` asks DeepSeek's fetch tool for the page as Markdown (billed per
 * request); binary content and failed requests still fall back to `direct`.
 */
export const WEB_FETCH_MODES = ['direct', 'deepseek'] as const;

export type WebFetchMode = (typeof WEB_FETCH_MODES)[number];

export function isWebFetchMode(value: unknown): value is WebFetchMode {
  return typeof value === 'string' && (WEB_FETCH_MODES as readonly string[]).includes(value);
}
