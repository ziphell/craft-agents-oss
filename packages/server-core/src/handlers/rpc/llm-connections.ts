import { RPC_CHANNELS, type LlmConnectionSetup } from '@craft-agent/shared/protocol'
import { getLlmConnections, getLlmConnection, addLlmConnection, updateLlmConnection, deleteLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection, touchLlmConnection, isCompatProvider, isAnthropicProvider, getDefaultModelsForConnection, getDefaultModelForConnection, type LlmConnection, type LlmConnectionUpdate, type LlmConnectionWithStatus, toBedrockNativeId, deriveBedrockRegionPrefix } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { setSetupDeferred, applyLlmConnectionUpdate } from '@craft-agent/shared/config/storage'
import {
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '@craft-agent/shared/agent/backend'
import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers'
import { askOmniModel, askWorkspaceModel, OMNI_SINGLE_MEDIA_MESSAGE } from '@craft-agent/shared/media/workspace-model'
import { mimeOfFile } from '@craft-agent/shared/media'
import { kindOfPath } from '@craft-agent/shared/library'
import { parseTestConnectionError, createBuiltInConnection, validateModelList, piAuthProviderDisplayName, validateSetupTestInput, setupTestRequiresApiKey, resolveCustomEndpointSetup, resolveSetupTestApiKey, maskApiKey, isMaskedApiKey } from '@craft-agent/server-core/domain'
import { getWorkspaceOrThrow, buildBackendHostRuntimeContext, validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CLIENT_OPEN_EXTERNAL } from '@craft-agent/server-core/transport'

// Local OAuth state
let copilotOAuthAbort: AbortController | null = null

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.llm.COMPLETE,
  RPC_CHANNELS.chatgpt.START_OAUTH,
  RPC_CHANNELS.chatgpt.COMPLETE_OAUTH,
  RPC_CHANNELS.chatgpt.CANCEL_OAUTH,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,
  RPC_CHANNELS.copilot.START_OAUTH,
  RPC_CHANNELS.copilot.CANCEL_OAUTH,
  RPC_CHANNELS.copilot.GET_AUTH_STATUS,
  RPC_CHANNELS.copilot.LOGOUT,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,
] as const

export function registerLlmConnectionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  // Fire-and-forget model-list refresh after a credential change (setup, re-auth,
  // validation). Re-auth can switch to an account with different model
  // entitlements, so the cached list from the previous account must be replaced
  // (#820). Never throws into the caller — a failed refresh must not fail the
  // credential flow that triggered it.
  const refreshModelsInBackground = (slug: string, context: string) => {
    try {
      getModelRefreshService().refreshNow(slug).catch(err => {
        deps.platform.logger?.warn(`Model refresh after ${context} failed for ${slug}: ${err instanceof Error ? err.message : err}`)
      })
    } catch (err) {
      deps.platform.logger?.warn(`Model refresh service unavailable after ${context} for ${slug}: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Unified handler for LLM connection setup
  server.handle(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, async (_ctx, setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }> => {
    try {
      const manager = getCredentialManager()

      // Ensure connection exists in config
      let connection = getLlmConnection(setup.slug)
      let isNewConnection = false
      if (!connection) {
        // Reauth guard: if updateOnly is set, the connection must already exist.
        // Clean up any orphaned credentials from a preceding OAuth flow.
        if (setup.updateOnly) {
          await manager.deleteLlmCredentials(setup.slug).catch(() => {})
          deps.platform.logger?.warn(`[SETUP_LLM_CONNECTION] updateOnly rejected for missing slug: ${setup.slug}`)
          return { success: false, error: 'Connection not found. Cannot re-authenticate a non-existent connection.' }
        }
        // Create connection with appropriate defaults based on slug
        connection = createBuiltInConnection(setup.slug, setup.baseUrl)
        isNewConnection = true
      }

      const updates: LlmConnectionUpdate = {};
      const hasConfiguredBaseUrl = !!setup.baseUrl?.trim();
      if (setup.baseUrl !== undefined) {
        // Explicit null = clear the stored baseUrl (merge semantics).
        updates.baseUrl = setup.baseUrl?.trim() || null;

        // Only mutate providerType for API key connections (not OAuth connections)
        if (isAnthropicProvider(connection.providerType) && connection.authType !== 'oauth') {
          if (hasConfiguredBaseUrl) {
            updates.providerType = 'pi_compat'
            updates.authType = 'api_key_with_endpoint'
            updates.customEndpoint = { api: 'anthropic-messages' }
          } else {
            updates.providerType = 'anthropic'
            updates.authType = 'api_key'
            updates.models = getDefaultModelsForConnection('anthropic')
            updates.defaultModel = getDefaultModelForConnection('anthropic')
          }
        }

        // Pi API key flow: store baseUrl on the connection (Pi SDK doesn't use it yet,
        // but it's persisted for future backend support)

      }

      if (setup.defaultModel !== undefined) {
        updates.defaultModel = setup.defaultModel ?? null
      }
      if (setup.fastModel !== undefined) {
        // Merge semantics: `null` deletes the key (back to the name-based
        // guess), `''` is stored as-is and means "follow the default model".
        updates.fastModel = setup.fastModel ?? null
      }
      if (setup.visionModel !== undefined) {
        // Merge semantics: `null` deletes the key (back to the chain's next
        // candidate), `''` is stored as-is.
        updates.visionModel = setup.visionModel ?? null
      }
      if (setup.omniModel !== undefined) {
        // Same tri-state: `null` clears the role, an id stores it.
        updates.omniModel = setup.omniModel ?? null
      }
      if (setup.models !== undefined) {
        updates.models = setup.models ?? null
      }
      if (setup.modelSelectionMode !== undefined) {
        updates.modelSelectionMode = setup.modelSelectionMode
      }

      const customEndpoint = hasConfiguredBaseUrl ? setup.customEndpoint : undefined
      const isCustomEndpointCompat = !!customEndpoint
      if (customEndpoint) {
        updates.customEndpoint = customEndpoint
        updates.providerType = 'pi_compat'
        const branch = resolveCustomEndpointSetup({
          baseUrl: setup.baseUrl ?? undefined,
          credential: setup.credential ?? undefined,
          customEndpointApi: customEndpoint.api,
        })
        updates.authType = branch.authType
        if (branch.name !== undefined) updates.name = branch.name
        if (branch.piAuthProvider !== undefined) updates.piAuthProvider = branch.piAuthProvider

        // Brand-name override on first setup only (user-renamed connections aren't clobbered on re-save).
        if (isNewConnection && !updates.name && setup.baseUrl?.toLowerCase().includes('manifest.build')) {
          updates.name = 'Manifest'
        }
      } else if (setup.baseUrl !== undefined) {
        // Base URL was explicitly updated without custom protocol config.
        // Treat this as non-custom mode and clear stale custom endpoint metadata.
        // Explicit null (not undefined) is what clear means under merge semantics.
        // Only downgrade existing connections — new ones already have the correct
        // providerType from createBuiltInConnection().
        updates.customEndpoint = null
        if (connection.providerType === 'pi_compat' && connection.authType !== 'oauth' && !isNewConnection) {
          updates.providerType = 'pi'
          updates.authType = 'api_key'
        }
      }

      // Pi API key flow: set piAuthProvider from setup data (e.g. 'anthropic', 'google', 'openai').
      // Skip when custom endpoint protocol is driving routing.
      if (setup.piAuthProvider && !isCustomEndpointCompat) {
        updates.piAuthProvider = setup.piAuthProvider
        // Update connection name to show the actual provider (e.g. "Craft Agents Backend (Google AI Studio)")
        const providerName = piAuthProviderDisplayName(setup.piAuthProvider)
        if (providerName) {
          updates.name = `Craft Agents Backend (${providerName})`
        }
        // Only set default models when using standard Pi provider AND user didn't pick explicit models
        if (!hasConfiguredBaseUrl && !setup.models?.length) {
          updates.models = getDefaultModelsForConnection('pi', setup.piAuthProvider)
          updates.defaultModel = getDefaultModelForConnection('pi', setup.piAuthProvider)
          updates.modelSelectionMode ??= 'automaticallySyncedFromProvider'
        }
      }

      // Pi+Bedrock auth method override — set authType for IAM or environment auth.
      // providerType stays 'pi' (Bedrock routes through Pi SDK).
      if (setup.bedrockAuthMethod) {
        updates.authType = setup.bedrockAuthMethod
      }

      // Resolved Anthropic OAuth identity (issue #838). Threaded through SETUP so
      // it persists on both the new-connection path (addLlmConnection) and the
      // re-auth path (updateLlmConnection) via the shared pendingConnection/updates
      // flow below. Fail-soft: only stamp when at least one identity block arrived.
      const oauthIdentity = setup.oauthIdentity
      if (oauthIdentity?.account || oauthIdentity?.organization) {
        // Set only fields that are actually present, so `updates` never carries an
        // explicit `undefined` (matches the guarded-assignment style used above and
        // keeps the update intent clean). Missing sub-fields are simply not touched;
        // on re-auth the storage allowlist then preserves any prior value.
        if (oauthIdentity.account?.uuid) updates.oauthAccountUuid = oauthIdentity.account.uuid
        if (oauthIdentity.account?.emailAddress) updates.oauthAccountEmail = oauthIdentity.account.emailAddress
        if (oauthIdentity.organization?.uuid) updates.oauthOrganizationUuid = oauthIdentity.organization.uuid
        if (oauthIdentity.organization?.name) updates.oauthOrganizationName = oauthIdentity.organization.name
        updates.oauthProfileVerifiedAt = Date.now()
      }

      const effectiveProviderType = updates.providerType ?? connection.providerType
      if (effectiveProviderType === 'pi') {
        const isBedrockPi = (updates.piAuthProvider ?? connection.piAuthProvider) === 'amazon-bedrock'
        // For Pi+Bedrock, normalize bare Anthropic IDs to Bedrock-native before adding pi/ prefix
        // so that resolvePiModel() can find them in the amazon-bedrock registry.
        // Use the configured AWS region to select the correct inference profile prefix (us/eu).
        const regionPrefix = isBedrockPi ? deriveBedrockRegionPrefix(setup.awsRegion) : undefined
        const toPiModelId = (id: string) => {
          const bare = id.startsWith('pi/') ? id.slice(3) : id
          const normalized = isBedrockPi ? toBedrockNativeId(bare, regionPrefix) : bare
          return `pi/${normalized}`
        }
        if (Array.isArray(updates.models)) {
          updates.models = updates.models.map(m => typeof m === 'string' ? toPiModelId(m) : { ...m, id: toPiModelId(m.id) })
        }
        if (typeof updates.defaultModel === 'string') {
          updates.defaultModel = toPiModelId(updates.defaultModel)
        }
        // Same convention as defaultModel: on a Pi connection every model id in
        // config.json carries the `pi/` prefix. `''` ("follow the default") is
        // left alone rather than turned into a bare `pi/`.
        if (typeof updates.fastModel === 'string' && updates.fastModel) {
          updates.fastModel = toPiModelId(updates.fastModel)
        }
      }

      // Same merge the storage layer will apply on save — a plain spread would
      // keep `null` markers in the pending shape (schema rejects null).
      const pendingConnection: LlmConnection = applyLlmConnectionUpdate(connection, updates)

      if (pendingConnection.providerType === 'pi') {
        const modelIds = (pendingConnection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
        deps.platform.logger?.info('Pi setup pending connection snapshot', {
          slug: pendingConnection.slug,
          piAuthProvider: pendingConnection.piAuthProvider,
          modelSelectionMode: pendingConnection.modelSelectionMode,
          defaultModel: pendingConnection.defaultModel,
          modelCount: modelIds.length,
          modelsFirst5: modelIds.slice(0, 5),
          setupModelCount: setup.models?.length,
          setupDefaultModel: setup.defaultModel,
        })
      }

      if (pendingConnection.providerType === 'pi' && pendingConnection.piAuthProvider && !pendingConnection.modelSelectionMode) {
        const inferredMode = setup.models?.length
          ? 'userDefined3Tier'
          : 'automaticallySyncedFromProvider'
        pendingConnection.modelSelectionMode = inferredMode
        updates.modelSelectionMode = inferredMode
      }

      if (updates.models && updates.models.length > 0) {
        const validation = validateModelList(updates.models, pendingConnection.defaultModel)
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }
        if (validation.resolvedDefaultModel) {
          pendingConnection.defaultModel = validation.resolvedDefaultModel
          updates.defaultModel = validation.resolvedDefaultModel
        }
      }

      if (isCompatProvider(pendingConnection.providerType) && !pendingConnection.defaultModel) {
        return { success: false, error: 'Default model is required for compatible endpoints.' }
      }

      if (isNewConnection) {
        const added = addLlmConnection(pendingConnection)
        if (!added) {
          deps.platform.logger?.error(`Failed to persist LLM connection: ${setup.slug} (config may be inaccessible)`)
          return { success: false, error: 'Failed to save connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Created LLM connection: ${setup.slug}`)
      } else if (Object.keys(updates).length > 0) {
        const updated = updateLlmConnection(setup.slug, updates)
        if (!updated) {
          deps.platform.logger?.error(`Failed to update LLM connection: ${setup.slug}`)
          return { success: false, error: 'Failed to update connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Updated LLM connection settings: ${setup.slug}`)
      }

      // Store credential if provided (skip masked placeholders from GET_API_KEY)
      const isMasked = isMaskedApiKey(setup.credential)
      if (setup.credential && !isMasked) {
        const authType = pendingConnection.authType
        if (authType === 'oauth') {
          await manager.setLlmOAuth(setup.slug, { accessToken: setup.credential })
          deps.platform.logger?.info('Saved OAuth access token to LLM connection')
        } else {
          await manager.setLlmApiKey(setup.slug, setup.credential)
          deps.platform.logger?.info('Saved API key to LLM connection')
        }
      }

      // Pi+Bedrock IAM credentials — stored separately from API keys
      if (setup.iamCredentials) {
        await manager.setLlmIamCredentials(setup.slug, {
          ...setup.iamCredentials,
          region: setup.awsRegion,
        })
        deps.platform.logger?.info('Saved IAM credentials to LLM connection')
      }

      // Set as default only if no default exists yet (first connection)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(setup.slug)
        deps.platform.logger?.info(`Set default LLM connection: ${setup.slug}`)
      }

      // Fetch available models before returning to the UI.
      // Always refresh for auto-synced connections (e.g. Copilot, Bedrock) — the static
      // catalog from setup is just a seed that needs replacing with live API data
      // filtered by the user's policy. For user-defined connections, only refresh
      // when no models were populated during setup.
      // Awaited so the model selector shows real available models immediately.
      const pendingModels = Array.isArray(pendingConnection.models) ? pendingConnection.models : []
      const isAutoSynced = pendingConnection.modelSelectionMode === 'automaticallySyncedFromProvider'
      if (!pendingModels.length || isAutoSynced) {
        try {
          await getModelRefreshService().refreshNow(setup.slug)
        } catch (err) {
          deps.platform.logger?.warn(`Model refresh after setup failed for ${setup.slug}: ${err instanceof Error ? err.message : err}`)
        }
      }

      // Reinitialize auth for the connection that was just created/updated,
      // not the global default (which may be a different connection).
      await sessionManager.reinitializeAuth(setup.slug)
      deps.platform.logger?.info('Reinitialized auth after LLM connection setup')

      // Clear "Setup later" flag now that user has configured a provider
      setSetupDeferred(false)

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error('Failed to setup LLM connection:', message)
      return { success: false, error: message }
    }
  })

  // Unified connection test — uses the agent factory to spawn a real agent subprocess
  // and validate credentials via runMiniCompletion(). Same code path as actual chat.
  server.handle(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, async (_ctx, params: import('@craft-agent/shared/protocol').TestLlmConnectionParams): Promise<import('@craft-agent/shared/protocol').TestLlmConnectionResult> => {
    const { provider, apiKey, baseUrl, model, piAuthProvider, customEndpoint, connectionSlug } = params
    const allowEmptyApiKey = !setupTestRequiresApiKey(baseUrl)

    // The edit form echoes the stored key back as the GET_API_KEY placeholder;
    // resolve it to the real credential instead of testing the bullets (OSS #1048).
    const keyResolution = await resolveSetupTestApiKey(
      { apiKey, connectionSlug, allowEmptyApiKey },
      (slug) => getCredentialManager().getLlmApiKey(slug),
    )
    if (!keyResolution.ok) {
      return { success: false, error: keyResolution.error }
    }
    if (keyResolution.source === 'stored') {
      deps.platform.logger?.info(`[testLlmConnectionSetup] Using the stored API key of ${connectionSlug}`)
    }
    const trimmedKey = keyResolution.apiKey

    const setupValidation = validateSetupTestInput({ provider, baseUrl, piAuthProvider })
    if (!setupValidation.valid) {
      return { success: false, error: setupValidation.error }
    }

    const hint = resolveSetupTestConnectionHint({ provider, baseUrl, piAuthProvider, customEndpoint })
    deps.platform.logger?.info(`[testLlmConnectionSetup] Testing: provider=${provider}${piAuthProvider ? ` piAuth=${piAuthProvider}` : ''}${baseUrl ? ` baseUrl=${baseUrl}` : ''} hasCustomEndpoint=${!!customEndpoint} hintProvider=${hint.providerType}`)

    const startedAt = Date.now()
    try {
      const testModel = model || getDefaultModelForConnection(provider, piAuthProvider)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Resolved model: ${testModel}`)
      const result = await testBackendConnection({
        provider,
        apiKey: trimmedKey,
        allowEmptyApiKey,
        model: testModel,
        baseUrl,
        timeoutMs: 45000,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        connection: hint,
      })
      const elapsed = Date.now() - startedAt

      if (!result.success) {
        deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=false`)
        deps.platform.logger?.info(`[testLlmConnectionSetup] Raw error: ${(result.error || '').slice(0, 1000)}`)
        return { success: false, error: parseTestConnectionError(result.error || 'Unknown error') }
      }
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=true`)
      return { success: true }
    } catch (error) {
      const elapsed = Date.now() - startedAt
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, threw: ${msg.slice(0, 1000)}`)
      return { success: false, error: parseTestConnectionError(msg) }
    }
  })

  // ============================================================
  // Pi Provider Discovery (main process only — Pi SDK can't run in renderer)
  // ============================================================

  server.handle(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS, async () => {
    const { getPiApiKeyProviders } = await import('@craft-agent/shared/config')
    return getPiApiKeyProviders()
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL, async (_ctx, provider: string) => {
    const { getPiProviderBaseUrl } = await import('@craft-agent/shared/config')
    return getPiProviderBaseUrl(provider)
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_MODELS, async (_ctx, provider: string) => {
    const { getModels } = await import('@earendil-works/pi-ai/compat')
    try {
      const models = getModels(provider as Parameters<typeof getModels>[0])
      const sorted = [...models].sort((a, b) => b.cost.output - a.cost.output || b.cost.input - a.cost.input)
      return {
        models: sorted.map(m => ({
          id: m.id.startsWith('pi/') ? m.id : `pi/${m.id}`,
          name: m.name,
          costInput: m.cost.input,
          costOutput: m.cost.output,
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
        })),
        totalCount: models.length,
      }
    } catch {
      return { models: [], totalCount: 0 }
    }
  })

  // ============================================================
  // LLM Connections (provider configurations)
  // ============================================================

  // List all LLM connections (includes built-in and custom)
  server.handle(RPC_CHANNELS.llmConnections.LIST, async (): Promise<LlmConnection[]> => {
    return getLlmConnections()
  })

  // List all LLM connections with authentication status
  server.handle(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS, async (): Promise<LlmConnectionWithStatus[]> => {
    const connections = getLlmConnections()
    const credentialManager = getCredentialManager()
    const defaultSlug = getDefaultLlmConnection()

    return Promise.all(connections.map(async (conn): Promise<LlmConnectionWithStatus> => {
      // Check if credentials exist for this connection
      const hasCredentials = await credentialManager.hasLlmCredentials(conn.slug, conn.authType)
      return {
        ...conn,
        isAuthenticated: conn.authType === 'none' || hasCredentials,
        isDefault: conn.slug === defaultSlug,
      }
    }))
  })

  // Get a specific LLM connection by slug
  server.handle(RPC_CHANNELS.llmConnections.GET, async (_ctx, slug: string): Promise<LlmConnection | null> => {
    return getLlmConnection(slug)
  })

  // Get stored API key for an LLM connection (masked — for edit form display only)
  server.handle(RPC_CHANNELS.llmConnections.GET_API_KEY, async (_ctx, slug: string): Promise<string | null> => {
    const manager = getCredentialManager()
    const key = await manager.getLlmApiKey(slug)
    if (!key) return null
    // Provider prefix + mask + last four; the test handler resolves this back by slug
    return maskApiKey(key)
  })

  // Save (create or update) an LLM connection
  // If connection.slug exists and is found, updates it; otherwise creates new
  server.handle(RPC_CHANNELS.llmConnections.SAVE, async (_ctx, connection: LlmConnection): Promise<{ success: boolean; error?: string }> => {
    try {
      // Check if this is an update or create
      const existing = getLlmConnection(connection.slug)
      if (existing) {
        // Update existing connection (can't change slug)
        const { slug: _slug, ...updates } = connection
        const success = updateLlmConnection(connection.slug, updates)
        if (!success) {
          return { success: false, error: 'Failed to update connection' }
        }
      } else {
        // Create new connection
        const success = addLlmConnection(connection)
        if (!success) {
          return { success: false, error: 'Connection with this slug already exists' }
        }
      }
      deps.platform.logger?.info(`LLM connection saved: ${connection.slug}`)
      // Push runtime updates (e.g. supportsImages toggle) to live sessions on
      // this connection. Detached so SAVE doesn't block on the per-session
      // 15s `update_runtime_config` timeout when subprocesses are slow or
      // wedged. SessionManager serializes the refresh with the next send via
      // its per-session mutex, and the lazy `getOrCreateAgent` refresh remains
      // the correctness backstop if the detached push fails.
      sessionManager.refreshConnectionRuntime(connection.slug).catch(error => {
        deps.platform.logger?.warn(
          `Detached runtime push failed for ${connection.slug}: ${error instanceof Error ? error.message : error}`,
        )
      })
      // Reinitialize auth if the saved connection is the current default
      // (updates env vars and summarization model override)
      const defaultSlug = getDefaultLlmConnection()
      if (defaultSlug === connection.slug) {
        await sessionManager.reinitializeAuth()
      }
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to save LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Delete an LLM connection (at least one connection must remain)
  server.handle(RPC_CHANNELS.llmConnections.DELETE, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }
      // deleteLlmConnection handles the "at least one must remain" check
      const success = deleteLlmConnection(slug)
      if (success) {
        // Stop any periodic model refresh timer for this connection
        getModelRefreshService().stopConnection(slug)
        // Also delete associated credentials
        const credentialManager = getCredentialManager()
        await credentialManager.deleteLlmCredentials(slug)
        deps.platform.logger?.info(`LLM connection deleted: ${slug}`)
      }
      return { success }
    } catch (error) {
      deps.platform.logger?.error('Failed to delete LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Test an LLM connection (validate credentials and connectivity with actual API call)
  server.handle(RPC_CHANNELS.llmConnections.TEST, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await validateStoredBackendConnection({
        slug,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      })

      if (!result.success) {
        return { success: false, error: result.error }
      }

      touchLlmConnection(slug)

      if (result.shouldRefreshModels) {
        refreshModelsInBackground(slug, 'validation')
      }

      deps.platform.logger?.info(`LLM connection validated: ${slug}`)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[LLM_CONNECTION_TEST] Error for ${slug}: ${msg.slice(0, 500)}`)
      const { parseValidationError } = await import('@craft-agent/shared/config')
      return { success: false, error: parseValidationError(msg) }
    }
  })

  // Set global default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_DEFAULT, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const success = setDefaultLlmConnection(slug)
      if (success) {
        deps.platform.logger?.info(`Global default LLM connection set to: ${slug}`)
        // Reinitialize auth so env vars and summarization model override match the new default
        await sessionManager.reinitializeAuth()
      }
      return { success, error: success ? undefined : 'Connection not found' }
    } catch (error) {
      deps.platform.logger?.error('Failed to set default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Set workspace default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT, async (_ctx, workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }> => {
    try {
      const workspace = getWorkspaceOrThrow(workspaceId)

      // Validate connection exists if setting (not clearing)
      if (slug) {
        const connection = getLlmConnection(slug)
        if (!connection) {
          return { success: false, error: 'Connection not found' }
        }
      }

      const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
      const config = loadWorkspaceConfig(workspace.rootPath)
      if (!config) {
        return { success: false, error: 'Failed to load workspace config' }
      }

      // Update workspace defaults
      config.defaults = config.defaults || {}
      if (slug) {
        config.defaults.defaultLlmConnection = slug
      } else {
        delete config.defaults.defaultLlmConnection
      }

      saveWorkspaceConfig(workspace.rootPath, config)
      deps.platform.logger?.info(`Workspace ${workspaceId} default LLM connection set to: ${slug}`)
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to set workspace default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Refresh available models for a connection (dynamic model discovery)
  server.handle(RPC_CHANNELS.llmConnections.REFRESH_MODELS, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }

      await getModelRefreshService().refreshNow(slug)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error(`Failed to refresh models for ${slug}: ${msg}`)
      return { success: false, error: msg }
    }
  })

  // One prompt in, one answer out. Not streamed: the caller writes the whole answer as a file.
  // Files named by the caller are read here, so a 4K picture never travels over the wire:
  // - no files → a plain completion;
  // - pictures → the named Vision/Omni model, via the workspace wire;
  // - sound or video → the named Omni model, with any pictures alongside. One media file per
  //   request (our own rule: a video already carries its soundtrack, and one file fits every
  //   provider we target).
  // The model and its connection are always named — no fallback to "the default one".
  server.handle(
    RPC_CHANNELS.llm.COMPLETE,
    async (
      ctx,
      request: {
        prompt: string
        /** Files to read; images, audio, video and text (text is context). */
        paths?: string[]
        connectionSlug?: string
        model?: string
        systemPrompt?: string
        maxTokens?: number
      },
    ) => {
      const model = request.model?.trim()
      const connectionSlug = request.connectionSlug?.trim()
      const prompt = request.prompt?.trim()
      if (!prompt) return { ok: false, message: '需要一句 prompt：想让它回答什么？' }
      if (!model || !connectionSlug) {
        return { ok: false, message: '需要显式选择连接和模型' }
      }
      try {
        const paths = Array.isArray(request.paths)
          ? request.paths.filter((path) => typeof path === 'string' && path.trim().length > 0)
          : []

        if (paths.length === 0) {
          const answer = await askWorkspaceModel({
            instruction: prompt,
            connectionSlug,
            model,
            systemPrompt: request.systemPrompt,
            maxTokens: request.maxTokens,
          })
          return answer.ok && answer.text
            ? { ok: true, text: answer.text, model: answer.model, connection: answer.connection }
            : { ok: false, message: answer.message ?? 'No model available to write text' }
        }

        const workspaceId =
          ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
        const images: string[] = []
        const audios: string[] = []
        const videos: string[] = []
        const texts: string[] = []
        for (const target of paths) {
          const safePath = await validateFilePath(
            target,
            getWorkspaceAllowedDirs(workspaceId, { sessionManager }),
          )
          if (!safePath) return { ok: false, message: `找不到文件：${target}` }
          const kind = mediaKindOfPath(safePath)
          if (kind === 'image') images.push(safePath)
          else if (kind === 'audio') audios.push(safePath)
          else if (kind === 'video') videos.push(safePath)
          else if (kind === 'text') texts.push(safePath)
          else return { ok: false, message: `${basename(safePath)} 不是图片、录音、录像或文本。` }
        }

        // Text references are context, in the order they were attached, ahead of the prompt.
        const context = await textContextOf(texts)
        const instruction = context ? `${context}\n\n${prompt}` : prompt

        if (audios.length > 0 || videos.length > 0) {
          if (audios.length > 1) return { ok: false, message: '一次只能带一段音频。' }
          if (videos.length > 1) return { ok: false, message: '一次只能带一段视频。' }
          // One media file per request; checked before reading or converting either file, so a
          // redundant combination costs nothing.
          if (audios.length > 0 && videos.length > 0) {
            return { ok: false, message: OMNI_SINGLE_MEDIA_MESSAGE }
          }
          const answer = await askOmniModel({
            instruction,
            ...(images.length ? { images: await Promise.all(images.map(imageDataUrlOf)) } : {}),
            ...(audios[0]
              ? {
                  audio: {
                    data: await audioBytesOf(audios[0], deps),
                    format: audioFormatOf(audios[0]),
                  },
                }
              : {}),
            ...(videos[0]
              ? {
                  video: {
                    data: new Uint8Array(await readFile(videos[0])),
                    format: extensionOf(videos[0]),
                  },
                }
              : {}),
            model,
            connectionSlug,
          })
          return answer.ok && answer.text
            ? { ok: true, text: answer.text, model: answer.model, connection: connectionSlug, via: 'omni' }
            : { ok: false, message: answer.message ?? 'Omni 模型没有给出答案。' }
        }

        const answer = await askWorkspaceModel({
          images: await Promise.all(images.map(imageDataUrlOf)),
          instruction,
          model,
          connectionSlug,
        })
        return answer.ok && answer.text
          ? { ok: true, text: answer.text, model: answer.model, connection: answer.connection, via: 'workspace-model' }
          : { ok: false, message: answer.message ?? '没有可用的模型来生成文本' }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  // ============================================================
  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  // Server-owned: prepare + exchange happen here, browser + callback on client.
  // ============================================================

  interface PendingChatGptFlow {
    flowId: string
    state: string
    codeVerifier: string
    connectionSlug: string
    ownerClientId: string
    createdAt: number
  }
  const pendingChatGptFlows = new Map<string, PendingChatGptFlow>()
  const CHATGPT_FLOW_TTL_MS = 5 * 60 * 1000

  function cleanupExpiredChatGptFlows() {
    const now = Date.now()
    for (const [state, flow] of pendingChatGptFlows) {
      if (now - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
        pendingChatGptFlows.delete(state)
      }
    }
  }

  // chatgpt:startOAuth — prepare PKCE + auth URL, store flow, return to client
  server.handle(RPC_CHANNELS.chatgpt.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    authUrl: string
    state: string
    flowId: string
  }> => {
    cleanupExpiredChatGptFlows()
    const { prepareChatGptOAuth } = await import('@craft-agent/shared/auth')

    const prepared = prepareChatGptOAuth()
    const flowId = randomUUID()

    pendingChatGptFlows.set(prepared.state, {
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      connectionSlug,
      ownerClientId: ctx.clientId,
      createdAt: Date.now(),
    })

    deps.platform.logger?.info(`[ChatGPT OAuth] Flow started for ${connectionSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  // chatgpt:completeOAuth — exchange code for tokens and store credentials
  server.handle(RPC_CHANNELS.chatgpt.COMPLETE_OAUTH, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }): Promise<{ success: boolean; error?: string }> => {
    const { flowId, code, state } = args
    const flow = pendingChatGptFlows.get(state)

    if (!flow) throw new Error('Unknown or expired ChatGPT OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')
    if (flow.ownerClientId !== ctx.clientId) throw new Error('OAuth flow owned by different client')
    if (Date.now() - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
      pendingChatGptFlows.delete(state)
      throw new Error('ChatGPT OAuth flow expired')
    }

    try {
      const { exchangeChatGptTokens } = await import('@craft-agent/shared/auth')
      const credentialManager = getCredentialManager()

      const tokens = await exchangeChatGptTokens(code, flow.codeVerifier)

      await credentialManager.setLlmOAuth(flow.connectionSlug, {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })

      pendingChatGptFlows.delete(state)
      deps.platform.logger?.info(`[ChatGPT OAuth] Flow complete for ${flow.connectionSlug}`)
      refreshModelsInBackground(flow.connectionSlug, 'ChatGPT auth')
      return { success: true }
    } catch (error) {
      pendingChatGptFlows.delete(state)
      deps.platform.logger?.error('[ChatGPT OAuth] Token exchange failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      }
    }
  })

  // Cancel ongoing ChatGPT OAuth flow
  server.handle(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, async (ctx, args?: { state?: string }): Promise<{ success: boolean }> => {
    if (args?.state) {
      const flow = pendingChatGptFlows.get(args.state)
      if (flow && flow.ownerClientId === ctx.clientId) {
        pendingChatGptFlows.delete(args.state)
        deps.platform.logger?.info(`[ChatGPT OAuth] Flow cancelled for ${flow.connectionSlug}`)
      }
    }
    return { success: true }
  })

  // Get ChatGPT authentication status
  server.handle(RPC_CHANNELS.chatgpt.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
    expiresAt?: number
    hasRefreshToken?: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      if (!creds) {
        return { authenticated: false }
      }

      // Check if expired (with 5-minute buffer)
      const isExpired = creds.expiresAt && Date.now() > creds.expiresAt - 5 * 60 * 1000

      return {
        authenticated: !isExpired || !!creds.refreshToken, // Can refresh if has refresh token
        expiresAt: creds.expiresAt,
        hasRefreshToken: !!creds.refreshToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get ChatGPT auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from ChatGPT (clear stored tokens)
  server.handle(RPC_CHANNELS.chatgpt.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('ChatGPT credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear ChatGPT credentials:', error)
      return { success: false }
    }
  })

  // ============================================================
  // GitHub Copilot OAuth
  // ============================================================

  // Start GitHub Copilot OAuth flow (device flow via Pi SDK)
  server.handle(RPC_CHANNELS.copilot.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      const { loginGitHubCopilot } = await import('@craft-agent/shared/auth')
      const credentialManager = getCredentialManager()

      // Cancel any previous in-flight flow
      copilotOAuthAbort?.abort()
      copilotOAuthAbort = new AbortController()

      deps.platform.logger?.info(`Starting GitHub Copilot OAuth device flow for connection: ${connectionSlug}`)

      // App-owned login flow (pi-ai 0.81.x no longer exports one) — handles the
      // device code flow AND the critical Copilot token exchange that determines
      // the correct API endpoint for the user's subscription tier via proxy-ep.
      const credentials = await loginGitHubCopilot({
        onDeviceCode: ({ userCode, verificationUri }) => {
          deps.platform.logger?.info(`[GitHub OAuth] Device code: ${userCode}`)
          pushTyped(server, RPC_CHANNELS.copilot.DEVICE_CODE, { to: 'client', clientId: ctx.clientId }, {
            userCode,
            verificationUri,
          })
          // Open GitHub device code page on the client's machine
          server.invokeClient(ctx.clientId, CLIENT_OPEN_EXTERNAL, verificationUri).catch(err => {
            deps.platform.logger?.warn(`Failed to open browser for GitHub OAuth: ${err}`)
          })
        },
        onProgress: (message) => {
          deps.platform.logger?.info(`[GitHub OAuth] ${message}`)
        },
        signal: copilotOAuthAbort.signal,
      })

      copilotOAuthAbort = null

      // Store the full OAuth credential:
      // - accessToken = Copilot API token (contains proxy-ep for correct endpoint)
      // - refreshToken = GitHub access token (used to refresh the Copilot token)
      // - expiresAt = Copilot token expiry (short-lived, ~1 hour)
      await credentialManager.setLlmOAuth(connectionSlug, {
        accessToken: credentials.access,
        refreshToken: credentials.refresh,
        expiresAt: credentials.expires,
      })

      deps.platform.logger?.info('GitHub Copilot OAuth completed successfully')
      refreshModelsInBackground(connectionSlug, 'Copilot auth')
      return { success: true }
    } catch (error) {
      copilotOAuthAbort = null
      deps.platform.logger?.error('GitHub Copilot OAuth failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OAuth authentication failed',
      }
    }
  })

  // Cancel ongoing GitHub OAuth flow
  server.handle(RPC_CHANNELS.copilot.CANCEL_OAUTH, async (): Promise<{ success: boolean }> => {
    if (copilotOAuthAbort) {
      copilotOAuthAbort.abort()
      copilotOAuthAbort = null
      deps.platform.logger?.info('GitHub Copilot OAuth cancelled')
    }
    return { success: true }
  })

  // Get GitHub Copilot authentication status
  server.handle(RPC_CHANNELS.copilot.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      return {
        authenticated: !!creds?.accessToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get GitHub auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from Copilot (clear stored tokens)
  server.handle(RPC_CHANNELS.copilot.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('Copilot credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear Copilot credentials:', error)
      return { success: false }
    }
  })
}

/** The sound formats the omni wire names; anything else is decoded here first. */
const OMNI_AUDIO_FORMATS: Record<string, 'mp3' | 'wav' | 'm4a' | 'aac'> = {
  mp3: 'mp3',
  wav: 'wav',
  m4a: 'm4a',
  aac: 'aac',
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

/** What a file is, by the same extension rule the library uses. */
function mediaKindOfPath(path: string): 'image' | 'audio' | 'video' | 'text' | null {
  const kind = kindOfPath(path)
  return kind === 'other' ? null : kind
}

/** Text references as context blocks, in the order given; capped so a node cannot carry a book. */
const MAX_TEXT_CONTEXT_BYTES = 2_000_000

async function textContextOf(files: string[]): Promise<string> {
  if (files.length === 0) return ''
  const blocks: string[] = []
  let total = 0
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    total += Buffer.byteLength(content)
    if (total > MAX_TEXT_CONTEXT_BYTES) {
      throw new Error('文本上下文超过 2MB：先精简，或分开生成。')
    }
    blocks.push(`<file path="${basename(file)}">\n${content.trim()}\n</file>`)
  }
  return blocks.join('\n\n')
}

async function imageDataUrlOf(path: string): Promise<string> {
  const mimeType = mimeOfFile(path)
  if (!mimeType.startsWith('image/')) {
    throw new Error('这张图片的格式还不能直接读：先转成 png、jpg 或 webp。')
  }
  const bytes = await readFile(path)
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

function audioFormatOf(path: string): 'mp3' | 'wav' | 'm4a' | 'aac' {
  // flac / ogg / opus are not names on the omni wire, so the bytes below are decoded to wav.
  return OMNI_AUDIO_FORMATS[extensionOf(path)] ?? 'wav'
}

async function audioBytesOf(path: string, deps: HandlerDeps): Promise<Uint8Array> {
  if (OMNI_AUDIO_FORMATS[extensionOf(path)]) {
    return new Uint8Array(await readFile(path))
  }
  // The machine already has a decoder (`recording_tool audio` uses the same one): a format the
  // wire does not name becomes the 16 kHz mono wav it does.
  const manager = deps.browserPaneManager
  if (!manager) throw new Error('这段音频需要先转成 wav，而这台机器没有可用的解码器。')
  const dir = join(tmpdir(), 'craft-listen')
  await mkdir(dir, { recursive: true })
  const out = join(dir, `${randomUUID()}.wav`)
  try {
    await manager.extractAudio(path, out)
    return new Uint8Array(await readFile(out))
  } finally {
    await rm(out, { force: true })
  }
}
