/**
 * Source Types
 *
 * Sources are external data connections (MCP servers, APIs, local filesystems).
 * They replace the old "connections" concept with a more flexible, folder-based architecture.
 *
 * File structure:
 * ~/.craft-agent/workspaces/{workspaceId}/sources/{sourceSlug}/
 *   ├── config.json   - Source settings
 *   └── guide.md      - Usage guidelines + cached data (in YAML frontmatter)
 */

/**
 * Source types - how we connect to the source
 */
export type SourceType = 'mcp' | 'api' | 'local' | 'web';

/**
 * MCP source authentication types (for individual source connections)
 * Note: Different from workspace McpAuthType which uses 'workspace_oauth' | 'workspace_bearer' | 'public'
 */
export type SourceMcpAuthType = 'oauth' | 'bearer' | 'none';

/**
 * API authentication types
 */
export type ApiAuthType = 'bearer' | 'header' | 'query' | 'basic' | 'oauth' | 'none';

/**
 * Google service types for OAuth scope selection
 */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'searchconsole';

/**
 * Slack service types for OAuth scope selection
 */
export type SlackService = 'messaging' | 'channels' | 'users' | 'files' | 'full';

/**
 * Microsoft service types for OAuth scope selection
 */
export type MicrosoftService = 'outlook' | 'microsoft-calendar' | 'onedrive' | 'teams' | 'sharepoint';

/**
 * Infer Google service from API baseUrl.
 * Returns undefined if URL doesn't match a known Google API pattern.
 *
 * Uses proper URL parsing to avoid false positives from arbitrary path matching.
 */
export function inferGoogleServiceFromUrl(baseUrl: string | undefined): GoogleService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return undefined;
  }

  // Match by hostname (most reliable)
  if (hostname === 'calendar.googleapis.com') return 'calendar';
  if (hostname === 'drive.googleapis.com') return 'drive';
  if (hostname === 'gmail.googleapis.com') return 'gmail';
  if (hostname === 'docs.googleapis.com') return 'docs';
  if (hostname === 'sheets.googleapis.com') return 'sheets';
  if (hostname === 'youtube.googleapis.com') return 'youtube';
  if (hostname === 'searchconsole.googleapis.com' || hostname === 'webmasters.googleapis.com') return 'searchconsole';

  // Fallback: check path patterns only on googleapis.com domains
  if (hostname === 'www.googleapis.com' || hostname === 'googleapis.com') {
    if (pathname.startsWith('/calendar/')) return 'calendar';
    if (pathname.startsWith('/drive/')) return 'drive';
    if (pathname.startsWith('/gmail/')) return 'gmail';
    if (pathname.startsWith('/v1/documents') || pathname.startsWith('/documents/')) return 'docs';
    if (pathname.startsWith('/v4/spreadsheets') || pathname.startsWith('/spreadsheets/')) return 'sheets';
    if (pathname.startsWith('/youtube/')) return 'youtube';
    if (pathname.startsWith('/webmasters/')) return 'searchconsole';
  }

  return undefined;
}

/**
 * Infer Slack service from API baseUrl.
 * Returns 'full' by default if URL matches Slack API pattern.
 */
export function inferSlackServiceFromUrl(baseUrl: string | undefined): SlackService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }

  // Match Slack API hostname
  if (hostname === 'slack.com' || hostname === 'api.slack.com') {
    return 'full'; // Default to full service for Slack
  }

  return undefined;
}

/**
 * Infer Microsoft service from API baseUrl.
 * Microsoft Graph API uses graph.microsoft.com for all services.
 * Returns undefined if service cannot be determined from URL path.
 */
export function inferMicrosoftServiceFromUrl(baseUrl: string | undefined): MicrosoftService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return undefined;
  }

  // Match Microsoft Graph API hostname
  if (hostname === 'graph.microsoft.com') {
    // Try to infer service from path
    if (pathname.includes('/me/messages') || pathname.includes('/me/mailfolders') || pathname.includes('/mail')) {
      return 'outlook';
    }
    if (pathname.includes('/me/calendar') || pathname.includes('/me/events')) {
      return 'microsoft-calendar';
    }
    if (pathname.includes('/me/drive') || pathname.includes('/drives')) {
      return 'onedrive';
    }
    if (pathname.includes('/teams') || pathname.includes('/chats')) {
      return 'teams';
    }
    if (pathname.includes('/sites')) {
      return 'sharepoint';
    }
    // Cannot determine service from generic Graph URL - require explicit microsoftService config
    return undefined;
  }

  // Match Outlook-specific API (legacy, but still used)
  if (hostname === 'outlook.office.com' || hostname === 'outlook.office365.com') {
    return 'outlook';
  }

  return undefined;
}

/**
 * Known providers for special handling (OAuth flows, icons, etc.)
 * These have well-known OAuth endpoints or special behavior.
 */
export type KnownProvider =
  | 'google' // Google APIs (Gmail, etc.) - uses Google OAuth
  | 'microsoft' // Microsoft APIs (Outlook, OneDrive, etc.) - uses Microsoft OAuth
  | 'linear' // Linear - standard MCP OAuth
  | 'github' // GitHub - standard MCP OAuth
  | 'notion' // Notion - standard MCP OAuth
  | 'slack' // Slack - standard MCP OAuth
  | 'exa'; // Exa search API

/**
 * API providers that use OAuth for authentication.
 * These providers store credentials as source_oauth and use SourceCredentialManager.
 */
export const API_OAUTH_PROVIDERS = ['google', 'microsoft', 'slack'] as const;
export type ApiOAuthProvider = typeof API_OAUTH_PROVIDERS[number];

/**
 * Check if a provider uses OAuth for API authentication
 */
export function isApiOAuthProvider(provider: string | undefined): provider is ApiOAuthProvider {
  return API_OAUTH_PROVIDERS.includes(provider as ApiOAuthProvider);
}

/**
 * Check if a source uses OAuth authentication (for proactive token refresh).
 *
 * Returns true for:
 * - MCP sources with authType: 'oauth'
 * - API sources with OAuth providers (google, slack, microsoft)
 */
export function isOAuthSource(source: LoadedSource): boolean {
  // MCP OAuth sources
  if (source.config.type === 'mcp') {
    return source.config.mcp?.authType === 'oauth';
  }

  // API OAuth sources (Google, Slack, Microsoft)
  if (source.config.type === 'api') {
    if (isApiOAuthProvider(source.config.provider)) return true;
    // Generic OAuth API sources (e.g. GitHub, Linear)
    if (isGenericOAuthSource(source)) return true;
  }

  return false;
}

/**
 * Check if a source uses generic OAuth (not Google/Slack/Microsoft provider-specific).
 * Matches API sources with authType 'oauth' — either explicit oauth config block
 * or auto-discovery from baseUrl via RFC 9728/8414.
 */
export function isGenericOAuthSource(source: LoadedSource): boolean {
  return (
    source.config.type === 'api' &&
    source.config.api?.authType === 'oauth' &&
    !isApiOAuthProvider(source.config.provider)
  );
}

/**
 * Check if an API source has a token renew endpoint configured.
 */
export function hasRenewEndpoint(source: LoadedSource): boolean {
  return source.config.type === 'api' && !!source.config.api?.renewEndpoint?.path;
}

/**
 * Check if a source can auto-refresh its token.
 * Returns true for OAuth sources OR sources with a renewEndpoint.
 *
 * Use this as the single guard for "can this source refresh?" instead of
 * sprinkling provider/authType/renewEndpoint checks in multiple places.
 */
export function isRefreshableSource(source: LoadedSource): boolean {
  return isOAuthSource(source) || hasRenewEndpoint(source);
}

/**
 * MCP transport type for sources
 * - 'http': HTTP-based MCP server (URL endpoint)
 * - 'sse': Server-Sent Events MCP server (URL endpoint)
 * - 'stdio': Local subprocess MCP server (spawned command)
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * MCP-specific configuration
 * Supports both HTTP-based and local stdio-based MCP servers.
 */
export interface McpSourceConfig {
  /**
   * Transport type. Defaults to 'http' if not specified.
   */
  transport?: McpTransport;

  // === HTTP/SSE transport fields ===
  /**
   * URL endpoint for HTTP or SSE transport.
   * Required when transport is 'http' or 'sse' (or undefined).
   */
  url?: string;

  /**
   * Authentication type for HTTP/SSE servers.
   */
  authType?: SourceMcpAuthType;

  /**
   * OAuth client ID (stored in config, not secret).
   */
  clientId?: string;

  // === Stdio transport fields ===
  /**
   * Command to spawn for stdio transport.
   * Required when transport is 'stdio'.
   */
  command?: string;

  /**
   * Arguments to pass to the command.
   */
  args?: string[];

  /**
   * Environment variables for the spawned process.
   */
  env?: Record<string, string>;

  // === HTTP/SSE custom headers ===
  /**
   * Custom headers to include in every MCP request.
   * Auth headers (e.g. Authorization) are merged on top when authType is set.
   */
  headers?: Record<string, string>;

  /**
   * Header names for credential-store auth (e.g., ["X-API-Key"]).
   * Values are stored as JSON in the credential store, same as API multi-header auth.
   * Precedence: static headers < credential-store headerNames < Authorization bearer.
   */
  headerNames?: string[];
}

/**
 * API test endpoint configuration for connection validation
 */
export interface ApiTestEndpoint {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>; // For POST requests
  headers?: Record<string, string>; // Custom headers for the test request
}

/**
 * Generic OAuth configuration for API sources.
 * Allows any OAuth 2.0 provider to be configured via config.json
 * without needing an MCP server or manual PAT.
 */
export interface ApiOAuthConfig {
  /** OAuth authorization endpoint URL (REQUIRED) */
  authorizationUrl: string;
  /** OAuth token exchange endpoint URL (REQUIRED) */
  tokenUrl: string;
  /** OAuth client ID (REQUIRED) */
  clientId: string;
  /** OAuth client secret (optional for public PKCE clients) */
  clientSecret?: string;
  /** Requested OAuth scopes */
  scopes?: string[];
  /** Auth0-style audience parameter */
  audience?: string;
  /**
   * RFC 8707 resource indicator: set for resource-bound servers that require the
   * issued token to be audience-scoped to a specific resource URI. Sent on the
   * authorization, token and refresh requests.
   */
  resource?: string;
  /** Additional parameters to include in the authorization URL */
  extraParams?: Record<string, string>;
}

/**
 * Token renewal endpoint configuration for non-OAuth API sources.
 * Allows custom bearer-token APIs to auto-renew expired tokens by calling
 * a provider-specific endpoint (not OAuth-compliant).
 *
 * MVP scope: access-token-based renewal only. The current access token is
 * sent via the Authorization header and/or substituted into body/headers
 * using the {{token}} placeholder.
 */
export interface ApiRenewEndpoint {
  /** Renew URL — relative path (resolved against baseUrl) or absolute URL */
  path: string;
  /** HTTP method (default: POST) */
  method?: 'GET' | 'POST';
  /** Request body — {{token}} in string leaves is substituted with current access token.
   *  Supports nested objects (recursive substitution on string leaves). */
  body?: Record<string, unknown>;
  /** Extra headers for the renew request — {{token}} substitution applies here too.
   *  Merged on top of defaultHeaders. Authorization header is always sent unless
   *  explicitly overridden here. */
  headers?: Record<string, string>;
  /** JSON field name for the new access token in response (default: "access_token") */
  tokenField?: string;
  /** JSON field name for expiry in seconds in response (default: "expires_in") */
  expiresInField?: string;
  /** Fallback TTL in seconds when renew response doesn't include expiry (optional).
   *  Without this, missing expiry causes refresh on every session start (safe but noisy). */
  fallbackTtlSecs?: number;
}

/**
 * API-specific configuration
 */
export interface ApiSourceConfig {
  baseUrl: string;
  authType: ApiAuthType;
  headerName?: string; // For 'header' auth (e.g., "X-API-Key")
  headerNames?: string[]; // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
  queryParam?: string; // For 'query' auth (e.g., "api_key")
  authScheme?: string; // For 'bearer' auth (default: "Bearer", could be "Token")
  defaultHeaders?: Record<string, string>; // Headers to include with every request
  testEndpoint?: ApiTestEndpoint; // Endpoint to use for connection testing
  renewEndpoint?: ApiRenewEndpoint; // Optional token renewal endpoint for non-OAuth sources

  // Google OAuth fields (used when provider is 'google')
  googleService?: GoogleService; // Predefined service for scope selection
  googleScopes?: string[]; // Custom scopes (overrides googleService)
  // User-provided OAuth credentials (for OSS users who create their own Google Cloud project)
  googleOAuthClientId?: string; // User's Google OAuth Client ID
  googleOAuthClientSecret?: string; // User's Google OAuth Client Secret

  // Slack OAuth fields (used when provider is 'slack')
  // Uses user_scope for user authentication (posts as the user, not a bot)
  slackService?: SlackService; // Predefined service for scope selection
  slackUserScopes?: string[]; // Custom user scopes (overrides slackService)

  // Microsoft OAuth fields (used when provider is 'microsoft')
  microsoftService?: MicrosoftService; // Predefined service for scope selection
  microsoftScopes?: string[]; // Custom scopes (overrides microsoftService)

  // Generic OAuth config (used when authType is 'oauth' and provider is not google/slack/microsoft)
  oauth?: ApiOAuthConfig;
}

/**
 * Local filesystem/app configuration
 */
export interface LocalSourceConfig {
  path: string;
  format?: string; // Optional hint: 'filesystem' | 'obsidian' | 'git' | 'sqlite' | etc.
}

/**
 * Web page configuration
 *
 * A web source is a bookmark: the url is the entry point, and the workspace
 * browser window (with its own logged-in session) captures the page into a
 * snapshot file next to this config. The snapshot is what gets reused across
 * sessions — the url only says where to refresh it from.
 */
export interface WebSourceConfig {
  url: string;
}

/** The note a captured page is written to, beside `config.json`. */
export const WEB_SNAPSHOT_FILE = 'snapshot.md';

/**
 * The folder a note's images live in — named after the note, so a folder on disk says which file it
 * belongs to without either of them being read. `snapshot.md` → `snapshot.assets`.
 *
 * A naming convention rather than a secret, and one the writer and the reader share: `read --save`
 * writes into it, and a source's detail page counts what is in it.
 */
export function snapshotAssetsDirName(noteFileName: string): string {
  const stem = noteFileName.replace(/\.[a-z0-9]+$/i, '');
  return `${stem || 'snapshot'}.assets`;
}

/**
 * Source connection status
 * - 'connected': Source is connected and working
 * - 'needs_auth': Source requires authentication
 * - 'failed': Connection failed with error
 * - 'untested': Connection has not been tested
 * - 'local_disabled': Stdio source is disabled (local MCP servers off)
 */
export type SourceConnectionStatus = 'connected' | 'needs_auth' | 'failed' | 'untested' | 'local_disabled';

// ============================================================================
// Source Brand
// ============================================================================

/**
 * Brand theming for a source's UI elements.
 * Uses the EntityColor system for light/dark mode support.
 */
export interface SourceBrand {
  /** Primary brand color — used for source-branded UI elements.
   *  Can be a system color name ("accent", "info") or custom { light, dark } values.
   *  Defaults to "accent" if not set. */
  color?: import('../colors/types').EntityColor;
}

// ============================================================================
// Main Source Config
// ============================================================================

/**
 * Main source configuration (stored in config.json)
 */
export interface FolderSourceConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;

  // Provider is a freeform label (e.g., "linear", "todoist", "my-custom-api")
  provider: string;

  // Connection type determines which config block is used
  type: SourceType;

  // Type-specific configuration (exactly one should be present)
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  web?: WebSourceConfig;

  // Icon: emoji or URL
  // Config is the source of truth. Local icon files are auto-discovered only when icon is undefined.
  // Priority: emoji > URL > local file (auto-discovered)
  icon?: string;

  // Short description for agent context (e.g., "Issue tracking, bugs, tasks, sprints")
  // If not set, extracted from guide.md first paragraph
  tagline?: string;

  // Brand theming for this source's UI elements
  brand?: SourceBrand;

  // Status tracking
  isAuthenticated?: boolean;
  connectionStatus?: SourceConnectionStatus;
  connectionError?: string; // Error message if status is 'failed'
  lastTestedAt?: number;

  // Metadata (optional - manually created configs may not have them)
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Parsed guide.md content with embedded cache
 */
export interface SourceGuide {
  // Full raw markdown
  raw: string;

  // Parsed sections (extracted via regex/parsing)
  scope?: string;
  guidelines?: string;
  context?: string;
  apiNotes?: string;

  // Embedded cache data (from YAML frontmatter)
  cache?: Record<string, unknown>;
}

/**
 * A captured page's note, split into the block that describes it and the page itself.
 *
 * The note's shape is fixed and written by `renderWebSnapshotNote`; this is the reader's half of
 * it, shared by the loader (which reads the fields back) and by anything drawing the note (which
 * wants the page, not the envelope — a markdown renderer has no concept of frontmatter, and would
 * set `---` as a rule and `title: …` as a run-on paragraph). Only the leading block counts: a
 * `---` line further down is a horizontal rule.
 */
export function splitWebSnapshotNote(note: string): { frontmatter: string; body: string } {
  const match = note.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (!match) return { frontmatter: '', body: note }
  return { frontmatter: match[1] ?? '', body: note.slice(match[0].length) }
}

/** The page itself, without the envelope. See {@link splitWebSnapshotNote}. */
export function webSnapshotBody(note: string): string {
  return splitWebSnapshotNote(note).body
}

/**
 * Page facts worth keeping, as much as the page was willing to state them.
 *
 * One type for both halves: extraction fills it in (`extractWebSnapshot`, from the page's own
 * metadata) and it is written into the note's frontmatter, from which the loader reads it back.
 * Where it lives is why it is here rather than beside the extractor — a source's detail page shows
 * these fields, and that page may not import a Node-only module (the extractor pulls in Defuddle).
 */
export interface WebSnapshotMeta {
  author?: string
  published?: string
  description?: string
  site?: string
  language?: string
  wordCount?: number
}

/**
 * The captured page a **web** source keeps.
 *
 * Pre-computed while the source is loaded, for the same reason `iconPath` is: a source's detail
 * page has to say what was captured, how big it is and when, and the renderer has no filesystem of
 * its own. Absent means nothing has been captured yet — or this is not a web source.
 */
export interface LoadedSourceSnapshot {
  /** Absolute path to the note. */
  path: string;
  /** What the capture called the page. */
  title?: string;
  /** Bytes, as written. */
  bytes: number;
  /** When the note was last written, ms since epoch. */
  writtenAt: number;
  /** How many images sit beside it, when any do. */
  imageCount: number;
  /** What the capture wrote about itself. Absent when the note carries no frontmatter. */
  meta?: WebSnapshotMeta;
}

/**
 * Fully loaded source with all files
 */
export interface LoadedSource {
  config: FolderSourceConfig;
  guide: SourceGuide | null;

  /** Absolute path to source folder (for resolving relative icon paths) */
  folderPath: string;

  /** Absolute path to workspace folder (e.g., ~/.craft-agent/workspaces/xxx) */
  workspaceRootPath: string;

  /**
   * Workspace this source belongs to.
   * Used for credential lookups: source_oauth::{workspaceId}::{sourceSlug}
   */
  workspaceId: string;

  /**
   * Pre-computed path to local icon file (icon.svg, icon.png, etc.) if it exists.
   * Computed during source loading so renderer doesn't need filesystem access.
   */
  iconPath?: string;

  /** The captured page, for a web source that has one. See {@link LoadedSourceSnapshot}. */
  snapshot?: LoadedSourceSnapshot;
}

/**
 * Source creation input (without auto-generated fields)
 */
export interface CreateSourceInput {
  name: string;
  provider: string;
  type: SourceType;
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  web?: WebSourceConfig;
  icon?: string; // Emoji or URL (auto-downloaded)
  enabled?: boolean;
}

/**
 * REST API configuration for API sources
 * Used by api-tools.ts to create dynamic API tools
 */
export interface ApiConfig {
  name: string;
  baseUrl: string;
  auth?: {
    type: 'none' | 'header' | 'bearer' | 'query' | 'basic';
    headerName?: string;
    headerNames?: string[]; // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
    queryParam?: string;
    authScheme?: string;
    credentialLabel?: string;
    secretLabel?: string;
  };
  headers?: Record<string, string>;
  documentation?: string;
  docsUrl?: string;
  defaultHeaders?: Record<string, string>;
  logo?: string;
  workspaceId?: string;
}
