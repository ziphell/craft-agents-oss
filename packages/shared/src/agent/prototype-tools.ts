import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { requireBrowserPaneFns, type BrowserPaneToolOptions } from './browser-pane.ts';
import { executePrototypeToolCommand } from './prototype-commands.ts';

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

/**
 * `prototype_tool` — the prototype workbench's own commands.
 *
 * The description says what these commands act on — a prototype as a **folder**: the brief it is
 * specified by and the files that implement it — and then points at `docs/prototypes.md` for the
 * rules. The folder's layout used to be spelled out here too; it is the guide's, kept in one copy
 * instead of one per surface, and this door says to read it before the first command. The browser's
 * own primitives — refs, snapshots, `evaluate`, console, network — are not here either; they belong
 * to `browser_tool`.
 */
const PROTOTYPE_TOOL_DESCRIPTION = TOOL_DESCRIPTIONS.prototype_tool;

/**
 * `prototype_tool` — the same command table as `browser_tool`, reached through the other door.
 *
 * It takes the same `fns` because the two are one runtime, reading one main-process capability
 * surface. What is separate is the **subject** — and with it the description, the help, and the guide
 * a session is asked to read first.
 */
export function createPrototypeTools(options: BrowserPaneToolOptions) {
  return [
    tool(
      'prototype_tool',
      PROTOTYPE_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Prototype command as a string (e.g., "list") or array (e.g., ["create", "Landing page"]). One command per call — batches are not supported here.'),
      },
      async (args) => {
        try {
          const result = await executePrototypeToolCommand({
            command: args.command,
            fns: requireBrowserPaneFns(options),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          // The pictures go into the reply as well as the text: a screenshot is one, a recording
          // is a session of them, and a frame capture exists because a model can read a frame
          // — the files are the record, this is the reading.
          const images = [...(result.image ? [result.image] : []), ...(result.images ?? [])];
          if (images.length > 0) {
            return {
              content: [
                { type: 'text' as const, text: result.output },
                ...images.map((image) => ({
                  type: 'image' as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              ],
            };
          }

          return successResponse(result.output);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
