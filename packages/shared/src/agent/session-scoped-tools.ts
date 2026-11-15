/**
 * Session-Scoped Tools
 *
 * Tools that are scoped to a specific session. Each session gets its own
 * instance of these tools with session-specific callbacks and state.
 *
 * This file is a thin adapter that wraps the shared handlers from
 * @craft-agent/session-tools-core for use with the Claude SDK.
 *
 * All tool definitions, schemas, and handlers live in session-tools-core.
 * This adapter only handles:
 * - Session callback registry (per-session onPlanSubmitted, onAuthRequest, queryFn)
 * - Plan state management
 * - Claude SDK tool() wrapping with DOC_REF-enriched descriptions
 * - call_llm (backend-specific, not in registry)
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { getSessionPlansPath, getSessionPath } from '../sessions/storage.ts';
import { DOC_REFS } from '../docs/index.ts';
import { createClaudeContext } from './claude-context.ts';
import { basename } from 'node:path';

// Import from session-tools-core: registry + schemas + base descriptions
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  getSessionToolDefs,
  TOOL_DESCRIPTIONS as BASE_DESCRIPTIONS,
  // Types
  type ToolResult,
  type AuthRequest,
} from '@craft-agent/session-tools-core';
import { createLLMTool, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { createSpawnSessionTool, type SpawnSessionFn } from './spawn-session-tool.ts';
import { createBrowserTools } from './browser-tools.ts';
import { getBrowserHostState, getRecordingHostState } from './browser-host-state.ts';
import { createComputerTools } from './computer-tools.ts';
import { createDeviceTools } from './device-tools.ts';
import { createDrawioTools } from './drawio-tools.ts';
import { createMarkdownTools } from './markdown-tools.ts';
import { createHtmlTools } from './html-tools.ts';
import { createMediaTools } from './media-tools.ts';
import { createAsrTools } from './asr-tools.ts';
import { createRecordingTools } from './recording-tools.ts';
import { createOfficeTools } from './office-tools.ts';
import type { BrowserPaneFns } from './browser-pane.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { getBrowserToolEnabled, getComputerUseEnabled } from '../config/storage.ts';
import { isDecisionFeatureActive } from '../decisions/resolve.ts';
import { readMediaChannels } from '../media/channels.ts';
import { asrReady } from '../media/asr.ts';
import { mediaCapabilities, mediaToolBrief } from '../media/tool-brief.ts';

// Re-export types for backward compatibility
export type {
  CredentialInputMode,
  AuthRequestType,
  AuthRequest,
  AuthResult,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  GoogleService,
  SlackService,
  MicrosoftService,
} from '@craft-agent/session-tools-core';

// Re-export browser pane types for session manager wiring
export type { BrowserPaneFns } from './browser-pane.ts';

// ============================================================
// Session-Scoped Tool Callbacks (re-exported from dedicated registry module)
// ============================================================

// Re-export for all downstream consumers (index.ts, claude-agent.ts, pi-agent.ts, etc.)
export {
  type SessionScopedToolCallbacks,
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';

// Local imports for use within this file's factory function
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

/** Backend-executed session tools currently supported by the Claude adapter layer. */
export const CLAUDE_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'call_llm',
  'spawn_session',
  'browser_tool',
  'device_tool',
  'drawio_tool',
  'markdown_tool',
  'html_tool',
  'media_tool',
  'asr_tool',
  'recording_tool',
  'docx_tool',
  'xlsx_tool',
  'pptx_tool',
  'pdf_tool',
  'convert_tool',
  'computer_tool',
]);

/**
 * Guardrail: ensure Claude adapter wiring stays in sync with backend-mode tools
 * declared in session-tools-core. Fail fast during setup instead of runtime drift.
 */
function assertClaudeBackendSessionToolParity(): void {
  const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
    (name) => !CLAUDE_BACKEND_SESSION_TOOL_NAMES.has(name),
  );

  if (missing.length > 0) {
    throw new Error(
      `Claude session tools missing backend adapter implementations: ${missing.join(', ')}`,
    );
  }
}

// ============================================================
// Plan State Management
// ============================================================

// Map of sessionId -> last submitted plan path (for retrieval after submission)
const sessionPlanFilePaths = new Map<string, string>();

/**
 * Get the last submitted plan file path for a session
 */
export function getLastPlanFilePath(sessionId: string): string | null {
  return sessionPlanFilePaths.get(sessionId) ?? null;
}

/**
 * Set the last submitted plan file path for a session
 */
export function setLastPlanFilePath(sessionId: string, path: string): void {
  sessionPlanFilePaths.set(sessionId, path);
}

/**
 * Clear plan file state for a session
 */
export function clearPlanFileState(sessionId: string): void {
  sessionPlanFilePaths.delete(sessionId);
}

// ============================================================
// Plan Path Helpers
// ============================================================

/**
 * Get the plans directory for a session
 */
export function getSessionPlansDir(workspacePath: string, sessionId: string): string {
  return getSessionPlansPath(workspacePath, sessionId);
}

/**
 * Check if a path is within a session's plans directory
 */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  const plansDir = getSessionPlansDir(workspacePath, sessionId);
  return path.startsWith(plansDir);
}

// ============================================================
// Tool Result Converter
// ============================================================

/**
 * Convert shared ToolResult to SDK format
 */
function convertResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: result.content.map(c => ({ type: 'text' as const, text: c.text })),
    ...(result.isError ? { isError: true } : {}),
  };
}

// ============================================================
// Cache for Session-Scoped Tools
// ============================================================

// Cache tools by session to avoid recreating them on every query.
// We cache the tools array (expensive to build) but NOT the MCP server wrapper,
// because createSdkMcpServer returns an MCP Server instance that holds transport
// state. The SDK's query() calls connect() on it, setting _transport. On the next
// query(), connect() is called again — but if the previous Query's subprocess hasn't
// fully exited yet, _transport is still set and connect() throws
// "Already connected to a transport". Creating a fresh server wrapper per query avoids this.
const sessionToolsCache = new Map<string, ReturnType<typeof tool>[]>();

/**
 * Invalidate ALL session tool caches (e.g., when a global setting like browserToolEnabled changes).
 * This forces tools to be rebuilt on the next message for every session.
 */
export function invalidateAllSessionToolsCaches(): void {
  sessionToolsCache.clear();
}

/**
 * Clean up cached tools for a session
 */
export function cleanupSessionScopedTools(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of sessionToolsCache.keys()) {
    if (key.startsWith(prefix)) {
      sessionToolsCache.delete(key);
    }
  }
}

// ============================================================
// Tool Descriptions (base from registry + Claude-specific DOC_REFS)
// ============================================================

const TOOL_DESCRIPTIONS: Record<string, string> = {
  ...BASE_DESCRIPTIONS,
  // Claude-specific enrichments with DOC_REFs
  config_validate: BASE_DESCRIPTIONS.config_validate + `\n\n**Reference:** ${DOC_REFS.sources}`,
  skill_validate: BASE_DESCRIPTIONS.skill_validate + `\n\n**Reference:** ${DOC_REFS.skills}`,
  mermaid_validate: BASE_DESCRIPTIONS.mermaid_validate + `\n\n**Reference:** ${DOC_REFS.mermaid}`,
  source_test: BASE_DESCRIPTIONS.source_test + `\n\n**Reference:** ${DOC_REFS.sources}`,
};

// ============================================================
// Main Factory Function
// ============================================================

/**
 * Get or create session-scoped tools for a session.
 * Returns an MCP server with all session-scoped tools registered.
 *
 * All tools come from the canonical SESSION_TOOL_DEFS registry in session-tools-core,
 * except call_llm which is backend-specific.
 */
export function getSessionScopedTools(
  sessionId: string,
  workspaceRootPath: string,
  workspaceId: string | undefined,
  /**
   * Whether the conversation is bound to a project. Required rather than defaulted: a caller that
   * forgot it would either lose the project-scoped door (cuts) or advertise one the handler then
   * refuses, and both failures are silent. Media generation is offered either way — its output
   * follows the content root.
   */
  hasProject: boolean,
): ReturnType<typeof createSdkMcpServer> {
  // Whether this hub has ever paired a device. Read per call rather than cached in the tool list,
  // so a machine paired in Settings is offered from the next list build on. `undefined` means the
  // host has no opinion (tests, hosts without a device registry) and keeps the tool.
  const hasDevices = getSessionScopedToolCallbacks(sessionId)?.hasDevicesFn?.() ?? true;
  const cacheKey = `${sessionId}::${workspaceRootPath}::${hasProject ? 'project' : 'session'}::${hasDevices ? 'devices' : 'no-devices'}`;

  // Return cached tools if available, but always create a fresh MCP server wrapper
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: any[] | undefined = sessionToolsCache.get(cacheKey);
  if (!tools) {
    // Create Claude context with full capabilities
    const ctx = createClaudeContext({
      sessionId,
      workspacePath: workspaceRootPath,
      workspaceId: workspaceId || basename(workspaceRootPath) || '',
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionId, planPath);
        const callbacks = getSessionScopedToolCallbacks(sessionId);
        callbacks?.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        const callbacks = getSessionScopedToolCallbacks(sessionId);
        callbacks?.onAuthRequest?.(request as AuthRequest);
      },
    });

    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Helper to create a tool from the canonical registry.
    // The `as any` on schema bridges a Zod generic-variance issue when .shape
    // types (ZodType<string>) flow into Record<string, ZodType<unknown>>.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function registryTool(name: string, schema: any) {
      const def = SESSION_TOOL_REGISTRY.get(name)!;
      return tool(name, TOOL_DESCRIPTIONS[name] || def.description, schema, async (args: any) => {
        const result = await def.handler!(ctx, args);
        return convertResult(result);
      }, def.readOnly ? { annotations: { readOnlyHint: true } } : undefined);
    }

    // Ensure backend-mode tool wiring is in sync with core metadata.
    assertClaudeBackendSessionToolParity();

    // Create tools from the canonical registry — all tools with handlers.
    // Tool visibility is centrally filtered in session-tools-core to avoid backend drift.
    tools = getSessionToolDefs({
      includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
      // `decide` is advertised only while the decision layer is on; the tool list
      // is built per agent, so toggling the setting applies to new sessions.
      includeDecide: isDecisionFeatureActive('decideTool'),
      // A conversation without a project is not offered project-scoped tools.
      hasProject,
      // A hub that has never paired a machine is not offered the device door.
      hasDevices,
    })
      .filter(def => def.handler !== null) // Skip backend-specific tools (call_llm)
      .map(def => registryTool(def.name, def.inputSchema.shape));

    // Add call_llm — backend-specific (not in registry handler)
    const sessionPath = getSessionPath(workspaceRootPath, sessionId);
    tools.push(
      createLLMTool({
        sessionId,
        sessionPath,
        getQueryFn: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.queryFn;
        },
        getImageModel: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.getImageModelFn?.();
        },
      }),
    );

    // Add spawn_session — backend-specific (not in registry handler)
    tools.push(
      createSpawnSessionTool({
        sessionId,
        getSpawnSessionFn: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.spawnSessionFn;
        },
      }),
    );

    // Add browser_* tools — backend-specific (requires BrowserPaneManager in Electron)
    // Gated by the "Built-in browser" setting so users with external browser tools
    // (Playwright, Puppeteer, etc.) can disable the built-in one, and by the host's own answer:
    // a headless hub has no browser, so every call could only refuse. That machine's browser work
    // is `device_tool`, which stays registered.
    if (getBrowserToolEnabled() && getBrowserHostState(sessionId) !== false) {
      tools.push(
        ...createBrowserTools({
          sessionId,
          workspaceRootPath,
          getBrowserPaneFns: () => {
            const callbacks = getSessionScopedToolCallbacks(sessionId);
            return callbacks?.browserPaneFns;
          },
        }),
      );
    }

    // The desktop door — its own tool beside the browser's, because driving a GUI and reaching
    // another machine are different questions. Opt-in: while the person has it off, the tool is
    // not offered at all, so no schema suggests a capability that needs OS grants and a lease.
    // Enabled on a host without a driver, it stays registered and refuses with a sentence.
    if (getComputerUseEnabled()) {
      tools.push(
        ...createComputerTools({
          sessionId,
          workspaceRootPath,
          getComputerPaneFns: async () => {
            const callbacks = getSessionScopedToolCallbacks(sessionId);
            return callbacks?.getComputerPaneFns?.();
          },
        }),
      );
    }

    // Device meta-tool — one door onto another connected machine. Offered only while this hub has
    // a paired device: with none, the tool could only answer "no devices" and its brief (the
    // largest per-door cost after media) would be paid on every request for nothing. The gate is
    // the pairing record, not connectivity, so a device that is merely asleep keeps the door
    // offered; pairing or forgetting a device changes the cache key, so the next list build
    // reflects it.
    if (hasDevices) {
      tools.push(
        ...createDeviceTools({
          sessionId,
          workspaceRootPath,
          getDeviceFns: () => {
            const callbacks = getSessionScopedToolCallbacks(sessionId);
            return callbacks?.deviceFns;
          },
        }),
      );
    }

    // Frames out of a recording are decoded by Chromium — the app's browser in a hidden window, or
    // a hub's render host — and diagrams are drawn by the app's own drawio (another hidden window,
    // or the same render host). Both are on this runtime,
    // but neither is the browser door, so neither follows the "Built-in browser" setting: what they
    // need is the engine behind the pane, which a runtime either has or has not. A door without it
    // refuses by name.
    //
    // Media is the opposite case: the brief is the largest part of the tool list, and with no
    // generation account every call could only refuse. No brief means no tool. Saving channels
    // invalidates this cache, so an account added in Settings is offered from the next turn on.
    const mediaBrief = mediaToolBrief(mediaCapabilities(readMediaChannels().channels))
    tools.push(
      ...createHtmlTools({
        sessionId,
        workspaceRootPath,
        getSessionInfo: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.getSessionInfoFn?.() ?? null;
        },
        applyEdit: (path, edit) => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.officeApplyEditFn?.(path, edit) ?? Promise.resolve(null);
        },
      }),
      // Accounts are not project work: a generated file and its source note land in the
      // conversation's content root, which is the session folder when it is in no project.
      ...(mediaBrief
        ? createMediaTools({
            workspaceRootPath,
            sessionId,
            // Read per call, like the library: a conversation moved into a project lands there next.
            getSessionInfo: () => {
              const callbacks = getSessionScopedToolCallbacks(sessionId);
              return callbacks?.getSessionInfoFn?.() ?? null;
            },
            // The brief names only the kinds this machine actually has, read once when the session's
            // tool list is built: an image-only account must not be described as if it also filmed
            // clips.
            description: mediaBrief,
          })
        : []),
      // Recognition is not an account door and not a decoder: it follows the person's choice of
      // where transcription runs, on either side of the same door. With neither a local model nor
      // cloud recognition set up, every call could only refuse — so the door is not offered.
      ...(asrReady()
        ? createAsrTools({
            workspaceRootPath,
            sessionId,
            getSessionInfo: () => {
              const callbacks = getSessionScopedToolCallbacks(sessionId);
              return callbacks?.getSessionInfoFn?.() ?? null;
            },
          })
        : []),
      // Decoding is Chromium's, so a host needs a browser to offer this door — but not a *pane*.
      // A desktop answers with a hidden window of its own, a hub with the render host it staged;
      // `getRecordingHostState` is the host's answer, and the old pane rule covers a caller that has
      // not said (`undefined`).
      ...((getRecordingHostState(sessionId) ?? (getBrowserHostState(sessionId) !== false))
        ? createRecordingTools({
            workspaceRootPath,
            sessionId,
            getSessionInfo: () => {
              const callbacks = getSessionScopedToolCallbacks(sessionId);
              return callbacks?.getSessionInfoFn?.() ?? null;
            },
            getBrowserPaneFns: () => getSessionScopedToolCallbacks(sessionId)?.browserPaneFns,
            getRecordingFns: () => getSessionScopedToolCallbacks(sessionId)?.recordingFns,
          })
        : []),
      ...createMarkdownTools({
        sessionId,
        workspaceRootPath,
        getSessionInfo: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.getSessionInfoFn?.() ?? null;
        },
        applyEdit: (path, edit) => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.officeApplyEditFn?.(path, edit) ?? Promise.resolve(null);
        },
      }),
      ...createDrawioTools({
        sessionId,
        workspaceRootPath,
        getSessionInfo: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.getSessionInfoFn?.() ?? null;
        },
        getBrowserPaneFns: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.browserPaneFns;
        },
        // A hub has no pane to draw in: this is the launcher that drives the same drawio in a
        // headless browser, and it is what makes `drawio_tool` work with nobody signed in.
        getDrawioFns: () => getSessionScopedToolCallbacks(sessionId)?.drawioRenderFns,
      }),
    );

    sessionToolsCache.set(cacheKey, tools);
  }

  // Always create a fresh MCP server wrapper to avoid "Already connected to a transport"
  // race condition when queries are sent back-to-back (see comment on sessionToolsCache).
  return createSdkMcpServer({
    name: 'session',
    version: '1.0.0',
    tools,
  });
}
