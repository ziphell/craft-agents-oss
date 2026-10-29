/**
 * `computer_tool` — the desktop door, as a Claude-SDK tool.
 *
 * Its own door, deliberately: `device_tool` answers **which machine** a call runs on, this answers
 * **this machine's GUI**. They are orthogonal, so neither is nested in the other — an agent that
 * wants another machine's desktop is asking a question this release does not answer, rather than a
 * question whose answer is silently this machine.
 *
 * Like `video_tool` and `drawio_tool`, the tool is registered unconditionally and refuses by name
 * when the host has no desktop: the schema is worth advertising, the refusal is a sentence.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { TOOL_DESCRIPTIONS, ComputerToolSchema } from '@craft-agent/session-tools-core'
import { executeComputerToolCommand } from './computer-commands.ts'
import type { ComputerPaneFns } from './computer-pane.ts'

export interface ComputerToolOptions {
  sessionId: string
  workspaceRootPath?: string
  /** Read at execution time: the desktop is resolved lazily, and may be absent. */
  getComputerPaneFns: () => Promise<ComputerPaneFns | undefined>
}

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  isError?: boolean
}

export function createComputerTools(options: ComputerToolOptions) {
  return [
    tool(
      'computer_tool',
      TOOL_DESCRIPTIONS.computer_tool,
      // The same zod-v3/v4 variance bridge `registryTool` uses in session-scoped-tools.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ComputerToolSchema.shape as any,
      async (input) => {
        const args = input as { command?: string | string[] }
        let fns: ComputerPaneFns | undefined
        try {
          fns = await options.getComputerPaneFns()
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
        if (!fns) {
          return errorResult(
            'Desktop control is not available on this host. It needs the Craft Agent desktop app ' +
            'with a desktop driver installed.',
          )
        }
        try {
          const result = await executeComputerToolCommand({
            command: args.command ?? '',
            fns,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
          })
          return toToolResult(result.output, result)
        } catch (error) {
          return errorResult(`computer_tool failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    ),
  ]
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/** Text, plus any image the command produced (a screenshot, or a capture's frame). */
function toToolResult(
  output: string,
  result: { image?: { data: string; mimeType: string }; images?: Array<{ data: string; mimeType: string }> },
): ToolResult {
  const images = result.images ?? (result.image ? [result.image] : [])
  return {
    content: [
      { type: 'text' as const, text: output },
      ...images.map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
  }
}
