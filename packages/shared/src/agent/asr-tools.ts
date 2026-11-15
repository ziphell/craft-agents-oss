/**
 * `asr_tool` — recordings into words.
 *
 * The route is the person's setting (`Settings › Speech`): this machine, or an account. Keeping the
 * choice behind one door is what lets the agent ask for "the words" without having to know which
 * side will do the work. Speaking text into a file is an account job, so it is `media_tool`'s.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import { executeAsrToolCommand } from './asr-commands.ts';

type ContentBlock = { type: 'text'; text: string };

export interface AsrToolOptions {
  workspaceRootPath?: string;
  sessionId?: string;
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null;
  /** What this machine / account pair can do, as the brief the model reads. */
  description?: string;
}

export function createAsrTools(options: AsrToolOptions) {
  return [
    tool(
      'asr_tool',
      options.description ?? (TOOL_DESCRIPTIONS as Record<string, string>).asr_tool ?? 'Speech to text.',
      {
        command: z.union([z.string(), z.array(z.string())]).describe(
          'Speech command as a string (e.g., "transcribe words.wav") or array. One command per call.',
        ),
      },
      async (args) => {
        try {
          const result = await executeAsrToolCommand({
            command: args.command,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.getSessionInfo ? { getSessionInfo: options.getSessionInfo } : {}),
          });
          const content: ContentBlock[] = [{ type: 'text' as const, text: result.output }];
          return { content };
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      },
    ),
  ];
}
