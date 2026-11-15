/**
 * The document tools, as a table: five doors, one dispatcher, and **no prose**.
 *
 * `office_tool` was one door with thirteen commands for four formats, and every caller paid for it:
 * a session that only wrote a Word file carried the workbook's and the deck's instructions in its
 * prompt, and read one guide that spent most of its length on formats it would never touch. So the
 * door is split by what the caller is holding — `.docx`, `.xlsx`, `.pptx`, `.pdf` — and **conversion
 * gets a door of its own**, because it is the only command whose source and target disagree. That
 * one decision is what keeps the split honest: no other tool has to say "to make a PDF, go
 * elsewhere", and ownership stays one line per command.
 *
 * What is **not** here is the brief each door shows a model. That is prompt text, and prompt text
 * lives in `TOOL_DESCRIPTIONS` (`tool-defs.ts`) with every other tool's, for two reasons: five long
 * descriptions would be 55% of this file and hide the table they sit in, and a brief is read by a
 * model while this table is read by the registry. Structure here, words there.
 *
 * A sixth format is a row in this table and a brief in that object — not five edits in five files.
 */

export type OfficeDomain = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'convert'

export interface OfficeDomainDef {
  domain: OfficeDomain
  /** The MCP tool name. */
  toolName: string
  /** What the UI calls it. */
  label: string
  /** The guide this tool blocks on until it has been read (beside the other docs). */
  docFile: string
  /** The commands this tool answers. Anything else is refused, naming the tool that owns it. */
  commands: readonly string[]
}

export const OFFICE_DOMAINS: readonly OfficeDomainDef[] = [
  {
    domain: 'docx',
    toolName: 'docx_tool',
    label: 'Word',
    docFile: 'docx-tools.md',
    commands: ['create', 'read', 'apply', 'edit-selection', 'merge', 'compare', 'check', 'render'],
  },
  {
    domain: 'xlsx',
    toolName: 'xlsx_tool',
    label: 'Excel',
    docFile: 'xlsx-tools.md',
    // No `render`: a workbook has no pages until it is printed, and page layout is not what a
    // workbook is read for. `read` / `sheets` answer its values, which is what an agent acts on;
    // a person's picture of it is the grid the app draws (see the poster route). Printing it to
    // see where a column breaks is a thing a person does in Excel, not a thing a model is asked.
    commands: ['create', 'read', 'apply', 'write-range', 'sheets', 'merge', 'check', 'shot'],
  },
  {
    domain: 'pptx',
    toolName: 'pptx_tool',
    label: 'PowerPoint',
    docFile: 'pptx-tools.md',
    commands: [
      'create',
      'read',
      'apply',
      'replace-slide-text',
      'deck_start',
      'deck_page',
      'deck_build',
      'deck_replace',
      'merge',
      'check',
      'render',
    ],
  },
  {
    domain: 'pdf',
    toolName: 'pdf_tool',
    label: 'PDF',
    docFile: 'pdf-tools.md',
    commands: ['pdf', 'render'],
  },
  {
    domain: 'convert',
    toolName: 'convert_tool',
    label: 'Convert',
    docFile: 'convert-tools.md',
    commands: ['convert'],
  },
]

/** The five tool names, in the order they are offered. */
export const OFFICE_TOOL_NAMES: readonly string[] = OFFICE_DOMAINS.map((entry) => entry.toolName)

const BY_TOOL = new Map(OFFICE_DOMAINS.map((entry) => [entry.toolName, entry]))

export function officeDomainOf(tool: string): OfficeDomainDef | undefined {
  return BY_TOOL.get(tool)
}

/** Which tool owns a command — for the refusal a wrong door gives, and for the ownership test. */
export function officeDomainForCommand(command: string): OfficeDomainDef | undefined {
  return OFFICE_DOMAINS.find((entry) => entry.commands.includes(command))
}
