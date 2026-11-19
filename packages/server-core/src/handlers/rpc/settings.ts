import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ServerConfig, ServerStatus } from '@craft-agent/shared/config/server-config'
import { getPreferencesPath, getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts, getWorkspaceByNameOrId, getDefaultThinkingLevel, setDefaultThinkingLevel } from '@craft-agent/shared/config'
import { isValidThinkingLevel, normalizeThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { getWorkspaceOrThrow } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { ServerHandlerContext } from '@craft-agent/server-core/bootstrap'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@craft-agent/server-core/transport'
import { isValidWorkingDirectory } from '../../utils/path-validation'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.GET_COMPUTER_USE_ENABLED,
  RPC_CHANNELS.tools.SET_COMPUTER_USE_ENABLED,
  RPC_CHANNELS.tools.GET_WEB_SEARCH_PROVIDER,
  RPC_CHANNELS.tools.SET_WEB_SEARCH_PROVIDER,
  RPC_CHANNELS.tools.GET_WEB_SEARCH_ENABLED,
  RPC_CHANNELS.tools.SET_WEB_SEARCH_ENABLED,
  RPC_CHANNELS.tools.GET_WEB_FETCH_ENABLED,
  RPC_CHANNELS.tools.SET_WEB_FETCH_ENABLED,
  RPC_CHANNELS.tools.GET_WEB_FETCH_MODE,
  RPC_CHANNELS.tools.SET_WEB_FETCH_MODE,
  RPC_CHANNELS.tools.GET_DEEPSEEK_SEARCH_KEY_STATUS,
  RPC_CHANNELS.tools.SET_DEEPSEEK_SEARCH_KEY,
  RPC_CHANNELS.tools.GET_DEEPSEEK_FETCH_KEY_STATUS,
  RPC_CHANNELS.tools.SET_DEEPSEEK_FETCH_KEY,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.settings.GET_SERVER_CONFIG,
  RPC_CHANNELS.settings.SET_SERVER_CONFIG,
  RPC_CHANNELS.settings.GET_SERVER_STATUS,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,
] as const

/**
 * The hub's listener is configured by its environment, not by the desktop app's
 * saved Server Mode config. These helpers present that environment in the same
 * shape the settings page reads (`ServerConfig` / `ServerStatus`), so the page
 * works in a browser and the credentials can be copied out to other machines.
 */
const HUB_HOST = process.env.CRAFT_RPC_HOST?.trim() || '127.0.0.1'
const HUB_PORT = Number(process.env.CRAFT_RPC_PORT ?? 9100) || 9100
const HUB_TLS = Boolean(process.env.CRAFT_RPC_TLS_CERT && process.env.CRAFT_RPC_TLS_KEY)
const HUB_PUBLIC_WS_URL = process.env.CRAFT_WEBUI_WS_URL?.trim() || undefined

function hubAllowsExternal(): boolean {
  return HUB_HOST === '0.0.0.0' || HUB_HOST === '::'
}

/** Address another machine on this network would use; loopback-only hosts still report one. */
function hubLanHost(): string {
  const candidates: string[] = []
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      candidates.push(net.address)
    }
  }
  const isPrivateIpv4 = (ip: string): boolean =>
    ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  return candidates.find(isPrivateIpv4) ?? candidates[0] ?? '127.0.0.1'
}

function hubServerConfig(ctx?: ServerHandlerContext): ServerConfig {
  return {
    enabled: true,
    port: HUB_PORT,
    allowExternal: hubAllowsExternal(),
    tlsCertPath: process.env.CRAFT_RPC_TLS_CERT?.trim() || undefined,
    tlsKeyPath: process.env.CRAFT_RPC_TLS_KEY?.trim() || undefined,
    publicWsUrl: HUB_PUBLIC_WS_URL,
    // The browser access token is the credential this page hands out: a hub is
    // administered from a browser, and the Web UI password is what another person
    // needs to sign in. The server token stays in the environment — remote windows
    // hold it already, and the desktop app never shows it.
    webuiPassword: ctx?.webuiPassword ?? process.env.CRAFT_WEBUI_PASSWORD?.trim() ?? undefined,
  }
}

function hubServerStatus(): ServerStatus {
  const lanHost = hubLanHost()
  const protocol = HUB_TLS ? 'wss' : 'ws'
  const displayHost = hubAllowsExternal() ? lanHost : HUB_HOST
  return {
    running: true,
    host: HUB_HOST,
    port: HUB_PORT,
    tls: HUB_TLS,
    url: `${protocol}://${displayHost}:${HUB_PORT}`,
    needsRestart: false,
    insecureWarning: hubAllowsExternal() && !HUB_TLS,
    allowExternal: hubAllowsExternal(),
    lanHost,
    publicWsUrl: HUB_PUBLIC_WS_URL,
    // Every value above comes from the environment; nothing here is editable.
    configSource: 'env',
  }
}

export function registerSettingsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () => {
    return getDefaultThinkingLevel()
  })

  server.handle(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, async (_ctx, level: string) => {
    if (!isValidThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
    }
    const success = setDefaultThinkingLevel(level)
    if (!success) {
      throw new Error('Failed to persist default thinking level')
    }
    return { success: true }
  })

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(RPC_CHANNELS.sessions.GET_MODEL, async (_ctx, sessionId: string, _workspaceId: string): Promise<string | null> => {
    const session = await deps.sessionManager.getSession(sessionId)
    return session?.model ?? null
  })

  // Set session-specific model (and optionally connection)
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (_ctx, sessionId: string, workspaceId: string, model: string | null, connection?: string) => {
    await deps.sessionManager.updateSessionModel(sessionId, workspaceId, model, connection)
    deps.platform.logger.info(`Session ${sessionId} model updated to: ${model}${connection ? ` (connection: ${connection})` : ''}`)
  })

  // Open native folder dialog for selecting working directory (routed to client)
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get workspace settings (model, permission mode, working directory, credential strategy)
  server.handle(RPC_CHANNELS.workspace.SETTINGS_GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger.error(`Workspace not found: ${workspaceId}`)
      return null
    }

    // Load workspace config
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)

    return {
      name: config?.name,
      model: config?.defaults?.model,
      permissionMode: config?.defaults?.permissionMode,
      cyclablePermissionModes: config?.defaults?.cyclablePermissionModes,
      thinkingLevel: normalizeThinkingLevel(config?.defaults?.thinkingLevel),
      workingDirectory: config?.defaults?.workingDirectory,
      localMcpEnabled: config?.localMcpServers?.enabled ?? true,
      defaultLlmConnection: config?.defaults?.defaultLlmConnection,
      browserProfile: config?.defaults?.browserProfile,
      enabledSourceSlugs: config?.defaults?.enabledSourceSlugs ?? [],
    }
  })

  // Update a workspace setting
  server.handle(RPC_CHANNELS.workspace.SETTINGS_UPDATE, async (_ctx, workspaceId: string, key: string, value: unknown) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const normalizedValue = key === 'workingDirectory' && typeof value === 'string'
      ? value.trim()
      : value

    // Validate key is a known workspace setting
    const validKeys = ['name', 'model', 'enabledSourceSlugs', 'permissionMode', 'cyclablePermissionModes', 'thinkingLevel', 'workingDirectory', 'localMcpEnabled', 'defaultLlmConnection', 'browserProfile']
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    // Validate defaultLlmConnection exists before saving
    if (key === 'defaultLlmConnection' && normalizedValue !== undefined && normalizedValue !== null) {
      const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
      if (!getLlmConnection(normalizedValue as string)) {
        throw new Error(`LLM connection "${normalizedValue}" not found`)
      }
    }

    // A workspace may name a profile; clearing it means "the built-in one".
    if (key === 'browserProfile' && normalizedValue !== undefined && normalizedValue !== null) {
      const { getBrowserProfiles } = await import('@craft-agent/shared/config/storage')
      if (!getBrowserProfiles().some((profile) => profile.id === normalizedValue)) {
        throw new Error(`Browser profile "${normalizedValue}" not found`)
      }
    }

    if (key === 'workingDirectory' && normalizedValue !== undefined && normalizedValue !== null) {
      const validation = isValidWorkingDirectory(String(normalizedValue))
      if (!validation.valid) {
        throw new Error(validation.reason!)
      }
    }

    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${workspaceId}`)
    }

    // Handle 'name' specially - it's a top-level config property, not in defaults
    if (key === 'name') {
      config.name = String(normalizedValue).trim()
    } else if (key === 'localMcpEnabled') {
      // Store in localMcpServers.enabled (top-level, not in defaults)
      config.localMcpServers = config.localMcpServers || { enabled: true }
      config.localMcpServers.enabled = Boolean(normalizedValue)
    } else {
      // Update the setting in defaults
      config.defaults = config.defaults || {}
      ;(config.defaults as Record<string, unknown>)[key] = normalizedValue
    }

    // Save the config
    saveWorkspaceConfig(workspace.rootPath, config)
    deps.platform.logger.info(`Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`)
  })

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath()
    if (!existsSync(path)) {
      return { content: '{}', exists: false, path }
    }
    return { content: readFileSync(path, 'utf-8'), exists: true, path }
  })

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content) // Validate JSON
      const path = getPreferencesPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (_ctx, sessionId: string) => {
    return getSessionDraft(sessionId)
  })

  // Set draft for a session (empty drafts are cleared)
  server.handle(RPC_CHANNELS.drafts.SET, async (_ctx, sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft) => {
    setSessionDraft(sessionId, draft)
  })

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (_ctx, sessionId: string) => {
    deleteSessionDraft(sessionId)
  })

  // Get all drafts (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async () => {
    return getAllSessionDrafts()
  })

  // ============================================================
  // Input Settings
  // ============================================================

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    const { getSendMessageKey } = await import('@craft-agent/shared/config/storage')
    return getSendMessageKey()
  })

  // Set send message key setting
  server.handle(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY, async (_ctx, key: 'enter' | 'cmd-enter') => {
    const { setSendMessageKey } = await import('@craft-agent/shared/config/storage')
    setSendMessageKey(key)
  })

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    const { getSpellCheck } = await import('@craft-agent/shared/config/storage')
    return getSpellCheck()
  })

  // Set spell check setting
  server.handle(RPC_CHANNELS.input.SET_SPELL_CHECK, async (_ctx, enabled: boolean) => {
    const { setSpellCheck } = await import('@craft-agent/shared/config/storage')
    setSpellCheck(enabled)
  })

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    const { getKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
    return getKeepAwakeWhileRunning()
  })

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS, async () => {
    const { getRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    return getRichToolDescriptions()
  })

  // Set rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS, async (_ctx, enabled: boolean) => {
    const { setRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    setRichToolDescriptions(enabled)
  })

  // ============================================================
  // Prompt Caching Settings
  // ============================================================

  // Get extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE, async () => {
    const { getExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    return getExtendedPromptCache()
  })

  // Set extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE, async (_ctx, enabled: boolean) => {
    const { setExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    setExtendedPromptCache(enabled)
  })

  // Get 1M context window setting
  server.handle(RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT, async () => {
    const { getEnable1MContext } = await import('@craft-agent/shared/config/storage')
    return getEnable1MContext()
  })

  // Set 1M context window setting
  server.handle(RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT, async (_ctx, enabled: boolean) => {
    const { setEnable1MContext } = await import('@craft-agent/shared/config/storage')
    setEnable1MContext(enabled)
  })

  // ============================================================
  // RTK Token-Optimization Settings
  // ============================================================

  // Get rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.GET_ENABLED, async () => {
    const { getRtkEnabled } = await import('@craft-agent/shared/config/storage')
    return getRtkEnabled()
  })

  // Set rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setRtkEnabled } = await import('@craft-agent/shared/config/storage')
    setRtkEnabled(enabled)
  })

  // Detect rtk installation (used by Settings UI to swap install prompt ↔ toggle)
  server.handle(RPC_CHANNELS.rtk.GET_STATUS, async (_ctx, opts?: { forceRecheck?: boolean }) => {
    const { getRtkStatus } = await import('@craft-agent/shared/agent')
    return getRtkStatus(opts)
  })

  // Token-savings summary from `rtk gain --format json` (efficiency meter)
  server.handle(RPC_CHANNELS.rtk.GET_GAIN, async () => {
    const { getRtkGain } = await import('@craft-agent/shared/agent')
    return getRtkGain()
  })

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    const { getBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    return getBrowserToolEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED, async (_ctx, enabled: boolean) => {
    const { setBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    setBrowserToolEnabled(enabled)
  })

  server.handle(RPC_CHANNELS.tools.GET_COMPUTER_USE_ENABLED, async () => {
    const { getComputerUseEnabled } = await import('@craft-agent/shared/config/storage')
    return getComputerUseEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_COMPUTER_USE_ENABLED, async (_ctx, enabled: boolean) => {
    const { setComputerUseEnabled } = await import('@craft-agent/shared/config/storage')
    setComputerUseEnabled(enabled)
  })

  server.handle(RPC_CHANNELS.tools.GET_WEB_SEARCH_PROVIDER, async () => {
    const { getWebSearchProvider } = await import('@craft-agent/shared/config/storage')
    return getWebSearchProvider()
  })

  server.handle(RPC_CHANNELS.tools.SET_WEB_SEARCH_PROVIDER, async (_ctx, preference: string) => {
    const { isWebSearchProviderPreference } = await import('@craft-agent/shared/config')
    if (!isWebSearchProviderPreference(preference)) return
    const { setWebSearchProvider } = await import('@craft-agent/shared/config/storage')
    setWebSearchProvider(preference)
  })

  server.handle(RPC_CHANNELS.tools.GET_WEB_SEARCH_ENABLED, async () => {
    const { getWebSearchEnabled } = await import('@craft-agent/shared/config/storage')
    return getWebSearchEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_WEB_SEARCH_ENABLED, async (_ctx, enabled: boolean) => {
    const { setWebSearchEnabled } = await import('@craft-agent/shared/config/storage')
    setWebSearchEnabled(enabled)
  })

  server.handle(RPC_CHANNELS.tools.GET_WEB_FETCH_ENABLED, async () => {
    const { getWebFetchEnabled } = await import('@craft-agent/shared/config/storage')
    return getWebFetchEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_WEB_FETCH_ENABLED, async (_ctx, enabled: boolean) => {
    const { setWebFetchEnabled } = await import('@craft-agent/shared/config/storage')
    setWebFetchEnabled(enabled)
  })

  server.handle(RPC_CHANNELS.tools.GET_WEB_FETCH_MODE, async () => {
    const { getWebFetchMode } = await import('@craft-agent/shared/config/storage')
    return getWebFetchMode()
  })

  server.handle(RPC_CHANNELS.tools.SET_WEB_FETCH_MODE, async (_ctx, mode: string) => {
    const { isWebFetchMode } = await import('@craft-agent/shared/config')
    if (!isWebFetchMode(mode)) return
    const { setWebFetchMode } = await import('@craft-agent/shared/config/storage')
    setWebFetchMode(mode)
  })

  // The key itself never leaves the credential store; the UI only asks whether one exists.
  server.handle(RPC_CHANNELS.tools.GET_DEEPSEEK_SEARCH_KEY_STATUS, async () => {
    const { getCredentialManager } = await import('@craft-agent/shared/credentials/manager')
    return Boolean(await getCredentialManager().getSearchApiKey('deepseek'))
  })

  server.handle(RPC_CHANNELS.tools.SET_DEEPSEEK_SEARCH_KEY, async (_ctx, apiKey: string) => {
    const { getCredentialManager } = await import('@craft-agent/shared/credentials/manager')
    const manager = getCredentialManager()
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (trimmed) {
      await manager.setSearchApiKey('deepseek', trimmed)
    } else {
      await manager.deleteSearchApiKey('deepseek')
    }
  })

  server.handle(RPC_CHANNELS.tools.GET_DEEPSEEK_FETCH_KEY_STATUS, async () => {
    const { getCredentialManager } = await import('@craft-agent/shared/credentials/manager')
    return Boolean(await getCredentialManager().getFetchApiKey('deepseek'))
  })

  server.handle(RPC_CHANNELS.tools.SET_DEEPSEEK_FETCH_KEY, async (_ctx, apiKey: string) => {
    const { getCredentialManager } = await import('@craft-agent/shared/credentials/manager')
    const manager = getCredentialManager()
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (trimmed) {
      await manager.setFetchApiKey('deepseek', trimmed)
    } else {
      await manager.deleteFetchApiKey('deepseek')
    }
  })


  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    const { getNetworkProxySettings } = await import('@craft-agent/shared/config/storage')
    return getNetworkProxySettings()
  })

  // ============================================================
  // Server Mode (hub listener)
  // ============================================================
  //
  // A hub has no Electron main process, so the handlers the desktop app registers
  // for its embedded server do not exist here. The settings page still reads them
  // in a browser, so they answer from the hub's own environment.

  server.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => hubServerConfig(serverCtx))

  server.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async () => {
    throw new Error(
      'Server settings are provided by the host environment (CRAFT_RPC_HOST, CRAFT_RPC_PORT, ' +
        'CRAFT_RPC_TLS_CERT/KEY, CRAFT_WEBUI_WS_URL, CRAFT_SERVER_TOKEN, CRAFT_WEBUI_PASSWORD). ' +
        'Change them there and restart the service.',
    )
  })

  server.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => hubServerStatus())
}
