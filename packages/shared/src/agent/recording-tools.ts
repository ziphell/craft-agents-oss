/**
 * `recording_tool` — recording work, beside `media_tool` (accounts) and `img-tool` (pictures).
 *
 * `probe` says what a file is, `frames` decodes its pictures, `audio` writes its sound, and
 * `understand` asks the person's omni model one question about it. The first three are local; only
 * the last spends money, and it says so.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import type { BrowserPaneFns } from './browser-pane.ts';
import { executeRecordingToolCommand } from './recording-commands.ts';
import type { RecordingFns } from '../recording/cli-fns.ts';

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

export interface RecordingToolOptions {
  workspaceRootPath?: string;
  sessionId?: string;
  /** Live read: a conversation moved into a project resolves its files there next call. */
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null;
  /** The pane's runtime: decoding is Chromium's, in a hidden window of its own. */
  getBrowserPaneFns?: () => BrowserPaneFns | undefined;
  /**
   * A decoder that is not a pane — a hub's render host (`createRecordingCliFns`).
   *
   * Registered beside `getBrowserPaneFns` rather than instead of it, because the two answer the
   * same question on different hosts; the pane wins when both exist, being one hop instead of two.
   */
  getRecordingFns?: () => RecordingFns | undefined;
  readOnly?: boolean
  /** Injected by a test so `understand` does not reach the network. */
  fetchImpl?: typeof fetch;
  /**
   * What this machine can actually do, as the brief the model reads. Omitted, the standard brief
   * is used — right for a test, and for a host whose decoder the lazy getter has not reported yet.
   */
  description?: string;
}

/** `recording_tool` — one command per call, decoded by the app's own browser. */
export function createRecordingTools(options: RecordingToolOptions) {
  return [
    tool(
      'recording_tool',
      options.description ?? TOOL_DESCRIPTIONS.recording_tool,
      {
        command: z.union([z.string(), z.array(z.string())]).describe(
          'Recording command as a string (e.g., "probe demo.mp4" or "frames demo.mp4 --out frames/demo") or array. One command per call — batches are not supported here.',
        ),
      },
      async (args) => {
        try {
          // The pane is the desktop's decoder; the render host is a hub's. This door reads only
          // `sampleVideo`, so a host that has that one capability can answer it without owning a
          // whole browser pane.
          const decoder = options.getBrowserPaneFns?.() ?? options.getRecordingFns?.();
          if (!decoder) {
            return errorResponse(
              'Reading a recording needs a decoder: frames are decoded by Chromium — ' +
                'the desktop app’s hidden window, or a hub’s render host. This host has neither.',
            );
          }
          const session = options.getSessionInfo?.();
          const result = await executeRecordingToolCommand({
            command: args.command,
            sessionId: options.sessionId ?? '',
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.workingDirectory ? { sessionWorkingDirectory: session.workingDirectory } : {}),
            // This door reads one method of the pane; a decoder-only value is the same method.
            fns: decoder as BrowserPaneFns,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
          });
          // Frames come back as images; a refusal is words, not an exception.
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
