/**
 * PromptBuilder - System Prompt and Context Building
 *
 * Provides utilities for building system prompts and context blocks that both
 * ClaudeAgent and PiAgent can use. Handles workspace capabilities, recovery
 * context, and user preferences formatting.
 *
 * Key responsibilities:
 * - Build workspace capabilities context
 * - Format recovery context for session resume failures
 * - Build session state context blocks
 * - Format user preferences for prompt injection
 */

import { isLocalMcpEnabled } from '../../workspaces/storage.ts';
import { formatPreferencesForPrompt } from '../../config/preferences.ts';
import { formatSessionState } from '../mode-manager.ts';
import { getDateTimeContext, getWorkingDirectoryContext } from '../../prompts/system.ts';
import { formatModeContextForPrompt } from '../../projects/mode-prompt.ts';
import {
  formatStableGitDeveloperContext,
  formatVolatileGitDeveloperContext,
} from '../../prompts/developer-context.ts';
import { getSessionPlansPath, getSessionDataPath, getSessionPath } from '../../sessions/storage.ts';
import type { SessionMode } from '../../sessions/types.ts';
import type {
  PromptBuilderConfig,
  ContextBlockOptions,
  RecoveryMessage,
} from './types.ts';

/**
 * Sentinel for "the session-mode block has never been announced in this session".
 * Distinct from both `null` (mode off, already announced) and a `SessionMode` value.
 */
const MODE_NOT_ANNOUNCED = Symbol('mode-not-announced');

/**
 * PromptBuilder provides utilities for building prompts and context blocks.
 *
 * Usage:
 * ```typescript
 * const promptBuilder = new PromptBuilder({
 *   workspace,
 *   session,
 *   debugMode: { enabled: true },
 * });
 *
 * // Build context blocks for a user message
 * const contextParts = promptBuilder.buildContextParts({
 *   permissionMode: 'explore',
 *   plansFolderPath: '/path/to/plans',
 * });
 * ```
 */
export class PromptBuilder {
  private config: PromptBuilderConfig;
  private workspaceRootPath: string;
  private pinnedPreferencesPrompt: string | null = null;
  /**
   * The session mode last announced in a user message, or {@link MODE_NOT_ANNOUNCED} when none
   * has been. Comparing the live mode against this is what makes the `<work>` block a one-shot:
   * it goes out when the mode is set or changed, not on every turn. See buildSessionModeBlock().
   */
  private announcedSessionMode: SessionMode | null | typeof MODE_NOT_ANNOUNCED = MODE_NOT_ANNOUNCED;
  private stableDeveloperContextCache: { workingDirectory: string | undefined; value: string | null } | null = null;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = config.workspace?.rootPath ?? '';
  }

  // ============================================================
  // Context Building
  // ============================================================

  /**
   * Build all context parts for a user message (volatile blocks first, then
   * stable blocks). Returns an array of strings that should be prepended to the
   * user message.
   *
   * This is the Claude path: it composes {@link buildVolatileContextParts} and
   * {@link buildStableContextParts} so the output is byte-identical to the
   * pre-split behavior while adding git developer context in the correct stable
   * vs volatile half. The one-shot mode-change signal is consumed exactly once
   * per turn (only the volatile builder consumes
   * it). Callers that place volatile vs stable context in different locations
   * (e.g. the Pi adapter, to preserve prompt caching — issue #862) should call
   * the two halves directly instead of this method.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   * @returns Array of context strings
   */
  buildContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    return [
      ...this.buildVolatileContextParts(options, sourceStateBlock),
      ...this.buildStableContextParts(),
    ];
  }

  /**
   * Volatile context blocks — content that can change every turn, so it must
   * ride the user-message tail rather than the cached system prefix (issue
   * #862). Folding these into the system prompt re-stamps the cache prefix each
   * turn and kills prompt-cache reuse for all downstream history.
   *
   * Blocks (in order):
   *  1. date/time (minute precision)
   *  2. session_state (permission mode + plans/data paths; carries
   *     modeChangedAt/modeVersion and **consumes** the one-shot mode-change user
   *     signal — see {@link formatSessionState})
   *  3. source state (auth/connection status), when provided
   *  4. volatile git developer context, when the selected working directory is in a repo
   *
   * MUST be called exactly once per turn, because it consumes one-shot mode
   * state. Never call it a second time to compute a cache-debug hash — hash the
   * already-produced string instead.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   */
  buildVolatileContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    const parts: string[] = [];

    // Date/time first (kept on the user tail to preserve prompt caching)
    parts.push(getDateTimeContext());

    // Session state (permission mode, plans folder path, data folder path, project folder path).
    // Only this volatile builder may consume the one-shot mode-change signal.
    const sessionId = this.config.session?.id ?? `temp-${Date.now()}`;
    const plansFolderPath = options.plansFolderPath ??
      getSessionPlansPath(this.workspaceRootPath, sessionId);
    const dataFolderPath = options.dataFolderPath ??
      getSessionDataPath(this.workspaceRootPath, sessionId);
    // The project folder has no workspace-level default: it is the *session's* project that owns
    // one, and a session in no project names none — so it travels only when a caller resolved it.
    const projectFolderPath = options.projectFolderPath;
    parts.push(formatSessionState(sessionId, {
      plansFolderPath,
      dataFolderPath,
      projectFolderPath,
      consumeModeChangeUserSignal: true,
    }));

    // The session's work mode (`goal`/`spec`/`plan`), announced once when it is set or changed.
    // It rides the user tail for the same reason as the blocks above: the mode's rules must not
    // live in the cached system prefix, or setting/changing a mode would invalidate it.
    const modeBlock = this.buildSessionModeBlock(options.projectFolderPath);
    if (modeBlock) {
      parts.push(modeBlock);
    }

    // Source state if provided
    if (sourceStateBlock) {
      parts.push(sourceStateBlock);
    }

    const volatileDeveloperContext = this.getVolatileDeveloperContext();
    if (volatileDeveloperContext) {
      parts.push(volatileDeveloperContext);
    }

    return parts;
  }

  /**
   * Build the `<work mode="…" folder="…">` block — but only on the turn after the session's
   * mode is set or changed, and on the turn after compaction (see resetInjectedSessionMode()).
   *
   * Why once rather than every turn: the block states the whole rule set for the mode, so
   * repeating it on every user message would be pure noise. Why the user message rather than the
   * system prompt: the system prompt is the cached prefix, and a value that changes with the mode
   * would re-stamp it on every switch (the same reason date/time and safe-mode context already
   * live here). The block's own copy is one static string per mode, so re-emitting it after a
   * change costs only the tail of the new message — never the history behind it.
   *
   * The live mode is read from the session config, which the session layer keeps current through
   * `setSessionMode()`; a change is detected by comparing against the last announced value. A mode
   * on a session with no project folder names nowhere, so it renders as absent and is deliberately
   * left un-announced so it can go out once the session is bound.
   */
  private buildSessionModeBlock(projectFolderPath?: string): string | null {
    const mode = this.config.session?.mode ?? null;

    if (mode === this.announcedSessionMode) {
      return null;
    }

    // Mode off: nothing to say, and remember it so "off" is not re-checked every turn.
    if (mode == null) {
      this.announcedSessionMode = null;
      return null;
    }

    // Mode on but no project folder to point at: the block would name nowhere. Leave it
    // un-announced so it still goes out once a folder exists (or on the next mode change).
    if (!projectFolderPath) {
      return null;
    }

    this.announcedSessionMode = mode;
    return formatModeContextForPrompt({ mode, folderPath: projectFolderPath });
  }

  /**
   * Re-arm the session-mode block so the current mode is announced again on the next user
   * message. Called after context compaction: the block lives in user messages now, and
   * compaction rolls the earlier ones into a summary, so without this the model would come out of
   * compaction with no mode at all. A no-op when no mode is set — the next build sees "off".
   */
  resetInjectedSessionMode(): void {
    this.announcedSessionMode = MODE_NOT_ANNOUNCED;
  }

  /**
   * Stable context blocks — content that is invariant across a session, so it
   * can safely live in the cached system prefix (issue #862).
   *
   * Blocks (in order):
   *  1. workspace capabilities
   *  2. working directory, when available
   *  3. stable git developer context, when the selected working directory is in a repo
   *
   * Pure and idempotent: holds no one-shot state, so it is safe to call any
   * number of times per turn.
   */
  buildStableContextParts(): string[] {
    const parts: string[] = [];

    // Workspace capabilities
    parts.push(this.formatWorkspaceCapabilities());

    // Working directory context
    const workingDirContext = this.getWorkingDirectoryContext();
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    const stableDeveloperContext = this.getStableDeveloperContext();
    if (stableDeveloperContext) {
      parts.push(stableDeveloperContext);
    }

    return parts;
  }

  /**
   * Format workspace capabilities for prompt injection.
   * Informs the agent about what features are available in this workspace.
   */
  formatWorkspaceCapabilities(): string {
    const capabilities: string[] = [];

    // Check local MCP server capability
    const localMcpEnabled = isLocalMcpEnabled(this.workspaceRootPath);
    if (localMcpEnabled) {
      capabilities.push('local-mcp: enabled (stdio subprocess servers supported)');
    } else {
      capabilities.push('local-mcp: disabled (only HTTP/SSE servers)');
    }

    return `<workspace_capabilities>\n${capabilities.join('\n')}\n</workspace_capabilities>`;
  }

  /**
   * Get working directory context for prompt injection.
   */
  getWorkingDirectoryContext(): string | null {
    const sessionId = this.config.session?.id;
    const effectiveWorkingDir = this.config.session?.workingDirectory ??
      (sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : undefined);
    const isSessionRoot = !this.config.session?.workingDirectory && !!sessionId;

    return getWorkingDirectoryContext(
      effectiveWorkingDir,
      isSessionRoot,
      this.config.session?.sdkCwd
    );
  }

  private getSelectedWorkingDirectory(): string | undefined {
    // Developer context is only for an explicitly selected CWD. The default
    // session folder can contain attachments/plans but should not be treated as
    // a code repository even if it happens to live under git-controlled storage.
    return this.config.session?.workingDirectory;
  }

  getStableDeveloperContext(): string | null {
    const workingDirectory = this.getSelectedWorkingDirectory();
    const cached = this.stableDeveloperContextCache;
    if (cached && cached.workingDirectory === workingDirectory) {
      return cached.value;
    }

    const value = formatStableGitDeveloperContext(workingDirectory);
    this.stableDeveloperContextCache = { workingDirectory, value };
    return value;
  }

  getVolatileDeveloperContext(): string | null {
    return formatVolatileGitDeveloperContext(this.getSelectedWorkingDirectory());
  }

  // ============================================================
  // Recovery Context
  // ============================================================

  /**
   * Build recovery context from previous messages when SDK resume fails.
   * Called when we detect an empty response during resume.
   *
   * @param messages - Previous messages to include in recovery context
   * @returns Formatted recovery context string, or null if no messages
   */
  buildRecoveryContext(messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0) {
      return null;
    }

    // Format messages as a conversation block
    const formattedMessages = messages.map((m) => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid bloating context
      const content = m.content.length > 1000
        ? m.content.slice(0, 1000) + '...[truncated]'
        : m.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  // ============================================================
  // User Preferences
  // ============================================================

  /**
   * Format user preferences for prompt injection.
   * Preferences are pinned on first call to ensure consistency within a session.
   *
   * @param forceRefresh - Force refresh of cached preferences
   * @returns Formatted preferences string
   */
  formatPreferences(forceRefresh = false): string {
    // Return pinned preferences if available (ensures session consistency)
    if (this.pinnedPreferencesPrompt && !forceRefresh) {
      return this.pinnedPreferencesPrompt;
    }

    // Load and format preferences (function loads internally)
    this.pinnedPreferencesPrompt = formatPreferencesForPrompt();
    return this.pinnedPreferencesPrompt;
  }

  /**
   * Clear pinned preferences (called on session clear).
   */
  clearPinnedPreferences(): void {
    this.pinnedPreferencesPrompt = null;
  }

  clearDeveloperContextCache(): void {
    this.stableDeveloperContextCache = null;
  }

  // ============================================================
  // Configuration Accessors
  // ============================================================

  /**
   * Update the workspace configuration.
   */
  setWorkspace(workspace: PromptBuilderConfig['workspace']): void {
    this.config.workspace = workspace;
    this.workspaceRootPath = workspace?.rootPath ?? '';
    this.clearDeveloperContextCache();
  }

  /**
   * Update the session configuration.
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
    this.clearDeveloperContextCache();
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * Check if debug mode is enabled.
   */
  isDebugMode(): boolean {
    return this.config.debugMode?.enabled ?? false;
  }

  /**
   * Get the system prompt preset.
   */
  getSystemPromptPreset(): string {
    return this.config.systemPromptPreset ?? 'default';
  }
}
