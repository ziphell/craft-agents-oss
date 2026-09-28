/**
 * The drawio tool (`drawio_tool`)
 *
 * A `.drawio` file is the form of a diagram that outlives the reply — a person can open it, edit
 * it and hand it on — and it is written by the agent, with `Write`/`Edit`, like every other file.
 * This door is where one becomes a **picture that travels**: an SVG, a PNG, a page, or a rendering
 * in the reply. It shares the pane's capability surface with the other doors for the same reason
 * `video_tool` does: the work is done by an engine the app already ships (drawio's webapp), in a
 * hidden window of its own, and is a door of its own because drawing a diagram is not driving a page.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { requireBrowserPaneFns, type BrowserPaneToolOptions } from './browser-pane.ts';
import { executeDrawioToolCommand } from './drawio-commands.ts';

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
 * `drawio_tool` — three commands, and the whole brief for them.
 *
 * Self-contained on purpose: an agent that has never used this tool has to be able to tell, from
 * this text alone, that the `.drawio` file is written by its own `Write`/`Edit`, which command
 * produces a file that travels, that `render` is how it checks its own drawing, that nothing is
 * written unless a path says so, and that the engine is the app's own drawio rather than something
 * it has to install. The text itself lives in `TOOL_DESCRIPTIONS.drawio_tool` in
 * `session-tools-core`, so the Claude door and the Pi door show the same brief from one source.
 */
const DRAWIO_TOOL_DESCRIPTION = TOOL_DESCRIPTIONS.drawio_tool;

/**
 * `drawio_tool` — the same pane runtime as the other doors, reached by its own name.
 *
 * It takes the same `fns` because the engine is the app's own; what is separate is the **subject**
 * — a diagram, and nothing else.
 */
export function createDrawioTools(options: BrowserPaneToolOptions) {
  return [
    tool(
      'drawio_tool',
      DRAWIO_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Drawio command as a string (e.g., "export flow.drawio --to flow.png --format png") or array (e.g., ["export", "flow.drawio", "--to", "flow.png", "--format", "png"]). One command per call — batches are not supported here.'),
      },
      async (args) => {
        try {
          const result = await executeDrawioToolCommand({
            command: args.command,
            fns: requireBrowserPaneFns(options),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          // A rendering goes into the reply as an image: the point of `render` is that a model
          // looks at the drawing, and the picture is the only way it can.
          if (result.image) {
            return {
              content: [
                { type: 'text' as const, text: result.output },
                {
                  type: 'image' as const,
                  data: result.image.data,
                  mimeType: result.image.mimeType,
                },
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
