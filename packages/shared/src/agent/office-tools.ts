/**
 * The document doors — five tools, one dispatcher.
 *
 * A `.docx`, a `.xlsx`, a `.pptx`, a `.pdf`, and a conversion: each is a door of its own, because a
 * session that writes a Word file should not carry the workbook's and the deck's instructions in its
 * prompt, nor read a guide that spends most of its length on formats it will never touch.
 *
 * Everything about which door owns what lives in `office-domains.ts` (so this file has no list of
 * its own to fall out of step), and every door ends at the same dispatcher — one implementation, five
 * fronts. A command that belongs to another door is refused there, by name:
 * `write-range` is not a Word command, and saying so is cheaper than a model guessing.
 *
 * Why the doors are not "one tool with a format flag": the flag would have to be filled in by the
 * caller *before* it knows what the file is, and the descriptions would still have to describe four
 * formats to every caller. Why they are not four tools plus conversion inside one of them: `convert`
 * is the only command whose source and target disagree, so it gets its own door and no other tool
 * has to say "to make a PDF, go elsewhere".
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { OFFICE_DOMAINS, TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core'
import { executeOfficeToolCommand } from './office-commands.ts'

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  isError?: boolean
}

const errorResponse = (message: string): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
})

const successResponse = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
})

export interface OfficeToolOptions {
  /** Where a relative path counts from — the session's working directory. */
  workspaceRootPath?: string
  /** Live read: the conversation's project binding can change during its life. */
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null
  /** The session whose files these are, when a door needs to find its content root. */
  sessionId?: string
}

const COMMAND_DESCRIPTION =
  'Document command as a string (e.g., "create notes.md --out notes.docx") or array (e.g., ["create", "notes.md", "--out", "notes.docx"]). One command per call — batches are not supported here.'

/** The five document tools, built from the table that also names their guides. */
export function createOfficeTools(options: OfficeToolOptions = {}) {
  return OFFICE_DOMAINS.map((entry) =>
    tool(
      entry.toolName,
      (TOOL_DESCRIPTIONS as Record<string, string>)[entry.toolName] as string,
      { command: z.union([z.string(), z.array(z.string())]).describe(COMMAND_DESCRIPTION) },
      async (args) => {
        try {
          const session = options.getSessionInfo?.()
          const result = await executeOfficeToolCommand({
            command: args.command,
            workspaceRootPath: options.workspaceRootPath,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.workingDirectory
              ? { sessionWorkingDirectory: session.workingDirectory }
              : {}),
            tool: entry.toolName,
          })

          // A rendering goes into the reply as pictures: the point of `render` is that a model looks
          // at the page, and the image is the only way it can. `browser_tool`'s screenshot and
          // `drawio_tool`'s render arrive the same way; the paths are in the text as well, so a page
          // that did not fit in the reply is still one `Read` away.
          const images = result.images ?? (result.image ? [result.image] : [])
          if (images.length) {
            return {
              content: [
                { type: 'text' as const, text: result.output },
                ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
              ],
            }
          }

          return successResponse(result.output)
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error))
        }
      },
    ),
  )
}
