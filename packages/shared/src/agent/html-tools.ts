/**
 * The html tool (`html_tool`).
 *
 * An `.html` file is written by the agent with `Write`/`Edit`, like any other file. What those cannot do is speak about
 * the page the way the visual editor does — one **element** at a time, addressed by its path of element-child indices,
 * which is how a change lands in the page's own source without reformatting it. This door is that vocabulary:
 * `elements` says what the page is made of.
 *
 * It is a door of its own rather than a corner of `office_tool`, and the difference is where the work happens.
 * `office_tool` is file-level: GenOffice's command line does the work in the background. This one is about a page
 * somebody may have **open** in the visual editor, where an edit has to land in that frame — which is what
 * `drawio_tool` is about too, and why the two are shaped alike.
 *
 * Read-only for now: nothing here writes a byte.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { executeHtmlToolCommand } from './html-commands.ts';
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

export interface HtmlToolOptions {
  sessionId: string;
  workspaceRootPath?: string;
  /** Live read: the conversation's project binding can change during its life. */
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null;
  /**
   * Ask the editor showing a page to make one change, or `null` when nothing is showing it.
   *
   * The same callback `office_tool` uses for its anchored edit: only the editor holding the page can change it
   * without racing whoever is typing in it.
   */
  applyEdit?: ToolCommandArgs['applyEdit'];
  /** `html_tool shot` — see `ToolCommandArgs.captureWebShot`. */
  captureWebShot?: ToolCommandArgs['captureWebShot'];
}

/**
 * `markdown_tool` — the same brief as the Pi door, from one source.
 *
 * Nothing here needs a browser or an engine: the element offsets are read off the file's own bytes
 * (`@craft-agent/shared/html/source-edits`), so this door runs wherever the session runs.
 */
export function createHtmlTools(options: HtmlToolOptions) {
  return [
    tool(
      'html_tool',
      TOOL_DESCRIPTIONS.html_tool,
      {
        command: z.union([z.string(), z.array(z.string())]).describe(
          'HTML command as a string (e.g., "elements page.html") or array (e.g., ["elements", "page.html"]). One command per call — batches are not supported here.',
        ),
      },
      async (args) => {
        try {
          const session = options.getSessionInfo?.();
          const result = await executeHtmlToolCommand({
            command: args.command,
            workspaceRootPath: options.workspaceRootPath,
            sessionId: options.sessionId,
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.workingDirectory ? { sessionWorkingDirectory: session.workingDirectory } : {}),
            applyEdit: options.applyEdit,
            captureWebShot: options.captureWebShot,
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
