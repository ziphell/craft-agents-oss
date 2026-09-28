/**
 * Browser Tools (`browser_tool`)
 *
 * Session-scoped tooling that enables the agent to interact with built-in
 * in-app browser windows via a single CLI-like command wrapper.
 * Commands delegate to BrowserPaneFns callbacks wired by Electron's
 * SessionManager to BrowserPaneManager.
 *
 * The session → browser instance mapping is handled by the callback provider
 * (getOrCreateForSession pattern), so commands don't need instance IDs.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { requireBrowserPaneFns, type BrowserPaneToolOptions } from './browser-pane.ts';
import { executeBrowserToolCommand } from './browser-commands.ts';

// Tool result type - matches MCP CallToolResult content blocks
type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

const BROWSER_RELEASE_HINT = '\n\nWhen you are done using the browser, call browser_tool with command "close" to close the window entirely, or "release" to dismiss the overlay and let the user continue browsing.';

// ============================================================================
// Tool Descriptions
// ============================================================================

const BROWSER_TOOL_DESCRIPTION = TOOL_DESCRIPTIONS.browser_tool;

// ============================================================================
// Tool Factories
// ============================================================================

export function createBrowserTools(options: BrowserPaneToolOptions) {
  return [
    // Single CLI-like tool for all browser actions
    tool(
      'browser_tool',
      BROWSER_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
      },
      async (args) => {
        try {
          const result = await executeBrowserToolCommand({
            command: args.command,
            fns: requireBrowserPaneFns(options),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          const text = result.appendReleaseHint
            ? result.output + BROWSER_RELEASE_HINT
            : result.output;

          if (result.image) {
            return {
              content: [
                { type: 'text' as const, text },
                { type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType },
              ],
            };
          }

          return successResponse(text);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
