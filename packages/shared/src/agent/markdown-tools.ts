/**
 * The markdown tool (`markdown_tool`).
 *
 * A `.md` file is written by the agent with `Write`/`Edit`, like every other file of its work. What those cannot do is
 * speak about the file the way the editor does — **blocks**, the unit a save may rewrite, and a **body under an
 * envelope** that carries the frontmatter. This door is that vocabulary: `blocks` says what the file is made of,
 * `frontmatter` reads the YAML above the body.
 *
 * It is a door of its own rather than a corner of `office_tool`, and the difference is where the work happens.
 * `office_tool` is file-level: GenOffice's command line does the work in the background. This one is about a document
 * somebody may have **open**, where the edit has to become one step of that editor's history — which is what
 * `drawio_tool` is about too, and why the two are shaped alike.
 *
 * Read-only for now: nothing here writes a byte.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { executeMarkdownToolCommand } from './markdown-commands.ts';
import type { ToolCommandArgs } from './command-cli.ts';

// Tool result type - matches MCP CallToolResult content blocks
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
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

export interface MarkdownToolOptions {
  sessionId: string;
  workspaceRootPath?: string;
  /** Live read: the conversation's project binding can change during its life. */
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null;
  /**
   * Ask the editor showing a document to make one change, or `null` when nothing is showing it.
   *
   * The same callback `office_tool` uses for its anchored edit: only the editor that has the document can change it
   * without racing whoever is typing in it.
   */
  applyEdit?: ToolCommandArgs['applyEdit'];
  /** `markdown_tool shot` — see `ToolCommandArgs.captureMarkdownShot`. */
  captureMarkdownShot?: ToolCommandArgs['captureMarkdownShot'];
}

/**
 * `markdown_tool` — the same brief as the Pi door, from one source.
 *
 * Nothing here needs a browser or an engine: the block offsets are read off the file's own bytes
 * (`@craft-agent/shared/markdown/blocks`), so this door runs wherever the session runs.
 */
export function createMarkdownTools(options: MarkdownToolOptions) {
  return [
    tool(
      'markdown_tool',
      TOOL_DESCRIPTIONS.markdown_tool,
      {
        command: z.union([z.string(), z.array(z.string())]).describe(
          'Markdown command as a string (e.g., "blocks docs/spec.md") or array (e.g., ["frontmatter", "SKILL.md"]). One command per call — batches are not supported here.',
        ),
      },
      async (args) => {
        try {
          const session = options.getSessionInfo?.();
          const result = await executeMarkdownToolCommand({
            command: args.command,
            workspaceRootPath: options.workspaceRootPath,
            sessionId: options.sessionId,
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.workingDirectory ? { sessionWorkingDirectory: session.workingDirectory } : {}),
            applyEdit: options.applyEdit,
            captureMarkdownShot: options.captureMarkdownShot,
          });
          // A refusal is words, not an exception: the command line says what it could not do and
          // the model reads that. `isError` is reserved for a command that threw.
          return successResponse(result.output);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
