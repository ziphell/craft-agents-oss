/**
 * Video Tool (`video_tool`)
 *
 * Turns a recording into frames a model can look at. The decoding is Chromium's — the browser the
 * app already ships, in a hidden window of its own — so nothing here depends on ffmpeg. It shares
 * the pane's capability surface with the other doors, and is a door of its own because reading a
 * recording is not driving a window.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { requireBrowserPaneFns, type BrowserPaneToolOptions } from './browser-pane.ts';
import { executeVideoToolCommand } from './video-commands.ts';

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
 * `video_tool` — one command, and the whole brief for it.
 *
 * Self-contained on purpose: an agent that has never used this tool has to be able to tell, from
 * this text alone, that a recording becomes frames it can look at, that the frames come back as
 * images, that nothing is written unless `--out` says so, and that the decoding is the app's own
 * browser rather than something it has to install. The text itself lives in
 * `TOOL_DESCRIPTIONS.video_tool` in `session-tools-core`, so the Claude door and the Pi door show
 * the same brief from one source.
 */
const VIDEO_TOOL_DESCRIPTION = TOOL_DESCRIPTIONS.video_tool;

/**
 * `video_tool` — the same pane runtime as the other two doors, reached by its own name.
 *
 * It takes the same `fns` because the decoding happens on the pane's side; what is separate is the
 * **subject** — a recording, and nothing else.
 */
export function createVideoTools(options: BrowserPaneToolOptions) {
  return [
    tool(
      'video_tool',
      VIDEO_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Video command as a string (e.g., "sample demo.mp4") or array (e.g., ["sample", "demo.mp4", "--out", "frames"]). One command per call — batches are not supported here.'),
      },
      async (args) => {
        try {
          const result = await executeVideoToolCommand({
            command: args.command,
            fns: requireBrowserPaneFns(options),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          // Every sampled frame goes into the reply as an image: the point of the command is that
          // a model looks at the recording, and the pictures are the only way it can.
          const images = result.images ?? [];
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
