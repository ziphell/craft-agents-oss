/**
 * The media tool (`media_tool`) — the door to **accounts**: make a file.
 *
 * Everything here costs somebody money at a provider: `generate` posts a prompt. The local halves
 * live in their own doors — `recording_tool` decodes recordings, `img-tool` edits pictures, and reading
 * pixels into words is `call_llm`'s. Keeping the account door free of models and decoders is what
 * lets the brief stay honest about what a configured account can make.
 *
 * Nothing here touches a board: a generated file is a file.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { executeMediaToolCommand } from './media-commands.ts';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

// Tool result type - matches MCP CallToolResult content blocks
type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface MediaToolOptions {
  workspaceRootPath?: string;
  sessionId?: string;
  /** Live read: the conversation's project binding can change during its life. */
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null;
  readOnly?: boolean;
  /**
   * What this machine can actually do, as the brief the model reads. Omitted, the full brief is
   * used — the right answer for a test, and the wrong one for a machine with no accounts.
   */
  description?: string;
}

/**
 * `media_tool` — the same brief as the Pi door, from one source.
 */
export function createMediaTools(options: MediaToolOptions) {
  return [
    tool(
      'media_tool',
      options.description ?? TOOL_DESCRIPTIONS.media_tool,
      {
        command: z.union([z.string(), z.array(z.string())]).describe(
          'Media command as a string (e.g., "generate --prompt \\"a lighthouse\\" --out out.png") or array. One command per call — batches are not supported here.',
        ),
      },
      async (args) => {
        try {
          const result = await executeMediaToolCommand({
            command: args.command,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.getSessionInfo ? { getSessionInfo: options.getSessionInfo } : {}),
            ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
          });
          // A text product is words; a refusal is words, not an exception.
          const images = result.images ?? [];
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
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
