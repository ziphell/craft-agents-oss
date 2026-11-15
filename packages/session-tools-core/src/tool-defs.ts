/**
 * Session Tool Definitions — Single Source of Truth
 *
 * Canonical Zod schemas, descriptions, and handler registry for all
 * session-scoped tools. Consumers derive what they need:
 *
 * - Claude SDK  → `.shape` extracts the plain `{ key: z.string() }` literal
 * - MCP / Pi    → `getToolDefsAsJsonSchema()` auto-converts to JSON Schema
 *
 * Adding a new tool: define the schema, description, handler import, and
 * one entry in SESSION_TOOL_DEFS.
 */

import { z } from 'zod'
import { OFFICE_DOMAINS } from './office-domains.ts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionToolContext } from './context.ts';
import type { ToolResult } from './types.ts';

// Handlers
import { handleSubmitPlan } from './handlers/submit-plan.ts';
import { handleReelTool } from './handlers/reel.ts';
import { handleConfigValidate } from './handlers/config-validate.ts';
import { handleSkillValidate } from './handlers/skill-validate.ts';
import { handleMermaidValidate } from './handlers/mermaid-validate.ts';
import { handleSourceTest } from './handlers/source-test.ts';
import {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
} from './handlers/source-oauth.ts';
import { handleCredentialPrompt } from './handlers/credential-prompt.ts';
import { handleUpdatePreferences } from './handlers/update-preferences.ts';
import { handleTransformData } from './handlers/transform-data.ts';
import { handleScriptSandbox } from './handlers/script-sandbox.ts';
import { handleRenderTemplate } from './handlers/render-template.ts';
import { handleSendDeveloperFeedback } from './handlers/send-developer-feedback.ts';
import { handleSetSessionLabels } from './handlers/set-session-labels.ts';
import { handleSetSessionStatus } from './handlers/set-session-status.ts';
import { handleGetSessionInfo } from './handlers/get-session-info.ts';
import { handleListSessions } from './handlers/list-sessions.ts';
import { handleListBackgroundTasks } from './handlers/list-background-tasks.ts';
import { handleCreateTask } from './handlers/create-task.ts';
import {
  handleListTweaks,
  handleGetTweak,
  handleCreateTweak,
  handleUpdateTweak,
  handleDeleteTweak,
} from './handlers/tweaks.ts';
import { handleArchiveSession } from './handlers/archive-session.ts';
import { handleSendAgentMessage } from './handlers/send-agent-message.ts';
import { handleDecide } from './handlers/decide.ts';

// ============================================================
// Canonical Zod Schemas
// ============================================================

export const SubmitPlanSchema = z.object({
  planPath: z.string().describe('Absolute path to the plan markdown file you wrote'),
});

export const ConfigValidateSchema = z.object({
  target: z.enum(['config', 'sources', 'statuses', 'preferences', 'permissions', 'automations', 'tool-icons', 'all'])
    .describe('Which config file(s) to validate'),
  sourceSlug: z.string().optional().describe('Validate a specific source by slug'),
});

export const SkillValidateSchema = z.object({
  skillSlug: z.string().describe('The slug of the skill to validate'),
});

export const MermaidValidateSchema = z.object({
  code: z.string().describe('The mermaid diagram code to validate'),
  render: z.boolean().optional().describe('Also attempt to render (catches layout errors)'),
});

export const SourceTestSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to test'),
  autoEnable: z
    .boolean()
    .optional()
    .describe(
      'Automatically enable and activate the source in the current session on successful validation. Defaults to true. Pass false to keep pure validation behavior.'
    ),
});

export const SourceOAuthTriggerSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
});

export const CredentialPromptSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
  mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
  labels: z.object({
    credential: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional().describe('Custom field labels'),
  description: z.string().optional().describe('Description shown to user'),
  hint: z.string().optional().describe('Hint about where to find credentials'),
  headerNames: z.array(z.string()).optional().describe('Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])'),
  passwordRequired: z.boolean().optional().describe('For basic auth: whether password is required'),
});

export const CallLlmSchema = z.object({
  prompt: z.string().describe('Instructions for the LLM'),
  attachments: z.array(z.union([
    z.string().describe('Simple file path'),
    z.object({
      path: z.string().describe('File path'),
      startLine: z.number().optional().describe('First line (1-indexed)'),
      endLine: z.number().optional().describe('Last line (1-indexed)'),
    }),
  ])).optional().describe('File paths on disk to attach (max 20). NOT for inline text — put text in prompt instead. Use {path, startLine, endLine} for large files.'),
  systemPrompt: z.string().optional().describe('Optional system prompt'),
  maxTokens: z.number().optional().describe('Max output tokens (1-64000). Defaults to 4096'),
  temperature: z.number().optional().describe('Sampling temperature 0-1'),
  thinking: z.boolean().optional().describe('Enable extended thinking. Incompatible with outputFormat/outputSchema'),
  thinkingBudget: z.number().optional().describe('Token budget for thinking (1024-100000). Defaults to 10000'),
  outputFormat: z.enum(['summary', 'classification', 'extraction', 'analysis', 'comparison', 'validation']).optional()
    .describe('Predefined output format'),
  outputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }).optional().describe('Custom JSON Schema for structured output'),
});

const DecideQuestionSchema = z.object({
  type: z.enum(['choice', 'score', 'noul']).describe("'choice' picks one of your named options, 'score' places the state on an ordered rubric, 'noul' answers yes/no with a probability."),
  instructions: z.union([z.string(), z.record(z.string(), z.unknown())])
    .describe('The question, in English. One short sentence, or an object such as { question, focus }.'),
  criteria: z.union([
    z.record(z.string(), z.union([z.string(), z.null(), z.record(z.string(), z.unknown())])),
    z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  ]).optional().describe("choice: object of option key → one-sentence description (2–255 options; null when the key is self-explanatory). score: ordered array of level descriptions, lowest first (2–10). noul: optional { true: '...', false: '...' } descriptions."),
});

export const DecideSchema = z.object({
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional()
    .describe('What to judge: text, a JSON object, or an array of strings. Required unless items is given.'),
  items: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).max(200).optional()
    .describe('Batch mode: judge every item as its own state with the same questions (max 200). Results keep the input order.'),
  questions: z.record(z.string(), DecideQuestionSchema)
    .describe('Question key → question (max 20 per call). Keys are echoed in the answers.'),
  deadlineMs: z.number().int().min(250).max(60000).optional()
    .describe('Time budget per call in ms (default 10000).'),
});

export const UpdatePreferencesSchema = z.object({
  name: z.string().optional().describe("The user's preferred name or how they'd like to be addressed"),
  timezone: z.string().optional().describe("The user's timezone in IANA format (e.g., 'America/New_York', 'Europe/London')"),
  city: z.string().optional().describe("The user's city"),
  region: z.string().optional().describe("The user's state/region/province"),
  country: z.string().optional().describe("The user's country"),
  notes: z.string().optional().describe('Additional notes about the user that would be helpful to remember (preferences, context, etc.). Replaces any existing notes.'),
  includeCoAuthoredBy: z.boolean().optional().describe("Whether to include 'Co-Authored-By: Craft Agent' trailer on git commits. Defaults to true."),
});

export const TransformDataSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Transform script source code. Receives input file paths as command-line args (sys.argv[1:] or process.argv.slice(2)), last arg is the output file path.'),
  inputFiles: z.array(z.string()).describe('Input file paths relative to session dir (e.g., "long_responses/stripe_txns.txt")'),
  outputFile: z.string().describe('Output file name relative to session data/ dir (e.g., "transactions.json")'),
});

export const ScriptSandboxSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Inline script source to execute in a sandboxed subprocess.'),
  inputFiles: z.array(z.string()).optional().describe('Optional input file paths relative to the session directory.'),
  stdin: z.string().optional().describe('Optional stdin payload passed to the script process.'),
  timeoutMs: z.number().min(1).max(15000).optional().describe('Optional timeout in milliseconds (default 5000, max 15000).'),
});

export const RenderTemplateSchema = z.object({
  source: z.string().describe('Source slug (e.g., "linear", "gmail")'),
  template: z.string().describe('Template ID (e.g., "issue-detail", "issue-list")'),
  data: z.record(z.string(), z.unknown()).describe('JSON data to render into the template'),
});

export const SendDeveloperFeedbackSchema = z.object({
  message: z.string().describe('Freeform markdown feedback — be detailed, use headings, lists, code blocks. Include what happened, what you expected, what would help, or any ideas/suggestions.'),
});

// Browser tool schema (single CLI-like tool for all browser actions)
export const BrowserToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
});

// Device tool schema — one meta-tool: name the device, then the tool to run there.
export const DeviceToolSchema = z.object({
  tool: z
    .enum(['devices', 'bash', 'read', 'write', 'edit', 'list', 'stat', 'glob', 'grep', 'browser', 'computer'])
    .describe('The tool to run. Use "devices" first to see the devices you can reach.'),
  device: z
    .string()
    .optional()
    .describe('Device id (preferred) or display name, as "devices" reports them. Omit only for tool: "devices".'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Arguments for the nested tool. bash: {command, cwd?, timeoutMs?}. ' +
      'read: {path, offset?, limit?}. write: {path, content}. edit: {path, oldString, newString, replaceAll?}. ' +
      'list/stat: {path}. glob: {path, pattern}. grep: {path, pattern, glob?, ignoreCase?, maxResults?}. ' +
      'browser: {command} — the same command line browser_tool takes. ' +
      // That device's own desktop — this process's desktop is the separate `computer_tool`.
      'computer: {command} — that device\'s desktop (docs/computer-use.md).',
    ),
});

// Desktop tool schema — the same CLI-like shape, one command per call (no batching).
export const ComputerToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Desktop command as a string (e.g., "snapshot") or array (e.g., ["windows", "snapshot"]). One command per call.'),
});

// Drawio tool schema — the same CLI-like shape, one command per call (no batching).
export const OfficeToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Document command as a string (e.g., "create notes.md --out notes.docx") or array (e.g., ["create", "notes.md", "--out", "notes.docx"]). One command per call — batches are not supported here.'),
});

export const DrawioToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Drawio command as a string (e.g., "export flow.drawio --to flow.png --format png") or array (e.g., ["export", "flow.drawio", "--to", "flow.png", "--format", "png"]). One command per call — batches are not supported here.'),
});

export const MediaToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Media command as a string (e.g., "generate --prompt @brief.md --out out.png") or array. One command per call — batches are not supported here.'),
});

export const AsrToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Transcription command as a string (e.g., "transcribe words.wav") or array. One command per call — batches are not supported here.'),
});

export const RecordingToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Recording command as a string (e.g., "probe demo.mp4" or "frames demo.mp4 --out frames/demo") or array. One command per call — batches are not supported here.'),
});

export const ReelToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Reel command as a string (e.g., "apply --ops @ops.json") or array. One command per call.'),
});

export const HtmlToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('HTML command as a string (e.g., "elements page.html") or array (e.g., ["elements", "page.html"]). One command per call — batches are not supported here.'),
});

export const MarkdownToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Markdown command as a string (e.g., "blocks docs/spec.md") or array (e.g., ["frontmatter", "SKILL.md"]). One command per call — batches are not supported here.'),
});


export const SpawnSessionSchema = z.object({
  help: z.boolean().optional().describe('If true, returns available connections, models, and sources instead of creating a session'),
  prompt: z.string().optional().describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional().describe('Session name'),
  llmConnection: z.string().optional().describe('Connection slug (e.g., "anthropic-api", "codex")'),
  model: z.string().optional().describe('Model ID override'),
  enabledSourceSlugs: z.array(z.string()).optional().describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['safe', 'ask', 'guarded', 'allow-all']).optional().describe('Permission mode for the new session. Never looser than the spawning session\'s current mode (safe < ask < guarded < allow-all); a looser value is lowered to it.'),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
  labels: z.array(z.string()).optional().describe('Labels for the new session'),
  workingDirectory: z.string().optional().describe('Working directory for the new session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the prompt'),
});

// Session self-management tools
export const SetSessionLabelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  labels: z.array(z.string()).describe('Labels to set (replaces all existing labels)'),
});

export const SetSessionStatusSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  status: z.string().describe('Status to set (e.g., "todo", "in_progress", "done")'),
});

export const GetSessionInfoSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to query. Omit to get info about the current session.'),
});

export const ArchiveSessionSchema = z.object({
  sessionId: z.string().describe('Session ID to archive or unarchive. Required — you cannot archive your own session.'),
  archived: z.boolean().optional().describe('true to archive (default), false to unarchive.'),
});

export const CreateTaskSchema = z.object({
  title: z.string().describe('Short task title shown on the board (also drives the slug)'),
  description: z.string().describe('What the task should accomplish — becomes the task goal and the initial node prompt'),
  acceptanceCriteria: z.string().optional().describe('Freeform rubric the final result is verified against'),
  sources: z.array(z.string()).optional().describe('Source slugs to enable on the task sessions'),
  skills: z.array(z.string()).optional().describe('Skill slugs applied to dispatched task prompts'),
  llmConnection: z.string().optional().describe('LLM connection slug serving the model'),
  model: z.string().optional().describe('Model ID for the task sessions (workspace default when omitted)'),
  workingDirectory: z.string().optional().describe('Working directory for the task sessions'),
  projectId: z.string().optional().describe("Project ID to bind the task to (defaults to the invoking session's project)"),
});

// ---------------------------------------------------------------------------
// Tweaks
// ---------------------------------------------------------------------------

export const ListTweaksSchema = z.object({});

export const GetTweakSchema = z.object({
  slug: z.string().describe('Tweak slug (from list_tweaks or create_tweak)'),
});

export const CreateTweakSchema = z.object({
  name: z.string().describe('Tweak name (also drives the slug)'),
  description: z.string().optional().describe('Short note on what it is for'),
  matches: z
    .array(z.string())
    .describe(
      'Chrome match patterns for the pages this tweak runs on, e.g. ["*://*.example.com/admin/*"]. At least one is required.',
    ),
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Leave out unless the user asked for this change to take effect: a tweak injects into pages they are signed in to. Default false.',
    ),
  css: z.string().optional().describe('Written to tweak.css — the stylesheet the matching pages get'),
  js: z.string().optional().describe('Written to tweak.js — JS that runs on every matching page'),
});

export const UpdateTweakSchema = z.object({
  slug: z.string().describe('Tweak slug'),
  name: z.string().optional().describe('New name'),
  description: z.string().nullable().optional().describe('New note (null clears it)'),
  matches: z.array(z.string()).optional().describe('Replace the match patterns'),
  enabled: z.boolean().optional().describe('Switch the tweak on or off'),
});

export const DeleteTweakSchema = z.object({
  slug: z.string().describe('Slug of the tweak to delete'),
});

export const ListSessionsSchema = z.object({
  status: z.string().optional().describe('Filter by status'),
  label: z.string().optional().describe('Filter by label'),
  search: z.string().optional().describe('Substring match on session name'),
  sortBy: z.enum(['recent', 'name', 'status']).optional().describe('Sort order (default: recent)'),
  limit: z.number().optional().describe('Max sessions to return (default 20, max 100)'),
  offset: z.number().optional().describe('Skip first N results (for pagination)'),
});

export const ListBackgroundTasksSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to query. Omit to list background tasks for the current session.'),
});

// Inter-session messaging
export const SendAgentMessageSchema = z.object({
  sessionId: z.string().describe('Target session ID to send the message to'),
  message: z.string().describe('The message to send to the target session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the message'),
});

// ============================================================
// Canonical Tool Descriptions (base — no DOC_REFS)
// ============================================================

export const TOOL_DESCRIPTIONS = {

  // The five document doors. The table in `office-domains.ts` says which tool answers what;
  // the briefs live here with every other tool's, because a brief is prompt text and this is where
  // prompt text is kept.
  docx_tool: `Make and change **Word** documents. One command per call — string or array input, no batching. A flag this tool does not
read is an error, never a silent default; a relative path counts from the session.

A \`.docx\` is a file, not a reply: reach for it when the deliverable is something a person opens in
Word or in the app's own editor. **You never write its bytes** — it is a zip of XML parts that must
agree, and a file that half-agrees opens in one program and not the next, days later. The engine
writes it; this is the door. Read \`docs/docx-tools.md\` before your first command.

\`create <source.md> --out <file.docx> [--force]\` — write the Markdown first; headings, lists, tables,
code and links carry over, and an existing \`--out\` is refused without \`--force\`.
\`read <file.docx>\` — its blocks, numbered. Those ids are what \`apply\` addresses: a guessed index
lands in the wrong paragraph without complaint.
\`apply <file.docx> --ops <ops.json> [--dry-run] [--track]\` — structured edits in place; \`--track\`
makes them revisions of an author a person accepts or rejects, which is the right call on a document
you did not write. Only what you change is rewritten.
\`edit-selection <file> --from N --to M --expect "…" --text "…"\` — one span, changed **inside the
editor showing the file**: one undo step, nothing on disk until the person saves.
\`merge <template.docx> --data <json|file> --out <file>\` — fill \`{{key}}\` placeholders.
\`compare <a.docx> <b.docx> --out <redline.docx>\` — the difference, as tracked revisions.
\`check <file.docx>\` — stale TOC, broken refs, leftover placeholders; changes nothing.
\`render <file.docx> [--page n]\` — a page as a picture, drawn by the document's own editor (no print, no PDF).

Another format is another tool: \`.xlsx\` → \`xlsx_tool\`, \`.pptx\` → \`pptx_tool\`, \`.pdf\` → \`pdf_tool\`.
Turning one format into another, including \`--to pdf\`, is \`convert_tool\`.`,
  xlsx_tool: `Make and change **Excel** workbooks. One command per call — string or array input, no batching. A flag this tool does not
read is an error, never a silent default; a relative path counts from the session.

A \`.xlsx\` is a file, not a reply, and **you never write its bytes** — the engine does, through the
same write path the app's editor uses. Read \`docs/xlsx-tools.md\` before your first command.

\`create <source.csv|source.json> --out <file.xlsx> [--header] [--force]\` — the first row is the
header; a \`.json\` is a 2-D array of rows or \`{"sheets":[{"name","rows"}]}\`, and a string starting
with \`=\` is a formula. **A Markdown table is not read** — write the CSV first.
\`sheets from <file.md|file.html> --out <file.xlsx>\` — the tables a document holds, one sheet each.
\`read <file.xlsx> [--sheet <n>] [--stats]\` — sheets, used ranges, formulas; cells as \`A1:B2\`.
\`apply <file.xlsx> --ops <ops.json> [--dry-run] [--track]\` — cell, range and sheet ops.
\`write-range <file.xlsx> --range A1:B2 --values <rows.json> [--expect-empty | --expect <rows.json>]\`
— one block of cells, written **inside the editor showing the workbook**: one undoable step, and the
fingerprint is required, because a block that no longer holds what you read must not be overwritten.
\`merge <template.xlsx> --data <json|file> --out <file>\` — fill \`{{key}}\` placeholders.
\`check <file.xlsx>\` — formula errors and broken names; changes nothing.
\`shot <file.xlsx> [--sheet <name>] [--range A1] [--out <file>]\` — a picture of the grid in the reply: column widths, conditional colours, whether it reads as a table. It scrolls to that cell and photographs the window; a sheet has no pages, so this is not \`render\` and the picture is not the whole sheet.

Another format is another tool: \`.docx\` → \`docx_tool\`, \`.pptx\` → \`pptx_tool\`, \`.pdf\` → \`pdf_tool\`;
conversions are \`convert_tool\`.`,
  pptx_tool: `Make and change **PowerPoint** decks. One command per call — string or array input, no batching. A flag this tool does not
read is an error, never a silent default; a relative path counts from the session.

A \`.pptx\` is a file, not a reply, and **you never write its bytes** — the engine does. Prose is not a
deck: the builder will not decide a layout for you. Read \`docs/pptx-tools.md\` before your first
command.

\`create --ops <ops.json> --out <file.pptx>\` — a JSON array of slide ops (\`guide slides\` prints them).
\`create --spec <spec.json|dir> --out <file.pptx>\` — pages of px-positioned elements on a 1280×720
canvas (\`guide slides spec\`). Up to about five slides, one \`create\` is enough.
\`read <file.pptx> [--slide n]\` — slides and element ids; those ids are what \`apply\` addresses.
\`apply <file.pptx> --ops <ops.json> [--dry-run]\` — text, element, table and slide ops.
\`replace-slide-text <file.pptx> --slide N --find "…" --replace "…" --count <n>\` — one phrase, changed
**inside the editor showing the deck**: one undo step, formatting kept, and \`--count\` is the
fingerprint that stops a half-replacement.
\`merge <template.pptx> --data <json|file> --out <file>\` — fill \`{{key}}\` placeholders.
\`check <file.pptx>\` — overflow, out-of-bounds, overlaps; changes nothing.
\`render <file.pptx> [--slide n]\` — a slide as a picture, drawn by the deck editor's own slideshow (no print, no PDF).

A deck someone will present is built in stages, one page at a time, and the folder is the state:
\`deck_start <dir> --style <style.md> --outline <outline.json>\`, then \`deck_page <dir> --index <n>
--page <page.json>\` per page, then \`deck_build <dir>\`; \`deck_replace\` rebuilds one slide. A page
that fails its check is not kept. The staged flow is in the guide.

Another format is another tool, and conversions are \`convert_tool\`.`,
  pdf_tool: `Read, split and mark **PDF** files. One command per call — string or array input, no batching. A flag this tool does not
read is an error, never a silent default; a relative path counts from the session.

None of this needs a renderer: pdfium and pdf-lib do the work in this process, so a host with no
Chromium can still read and assemble pages. Read \`docs/pdf-tools.md\` before your first command.

\`pdf <file.pdf> [--page n | --range a-b] [--password <pw>]\` — the text layer, page by page (1-based),
with the page size and title. A scanned page comes back empty: that is a scan — ask \`pdf ocr\` for
one page, or a vision model for what it means.
\`pdf ocr <file.pdf> --page n [--json] [--out <file>] [--force]\` — the words on one page, read by this
machine's OCR (no upload). One page per call; \`--out\` writes .txt, .md or .json. A page whose own
text layer already says enough is answered with that text instead (\`engine: "text-layer"\`), and only
a scan — no text, or one picture across most of the page — is read from its pixels; \`--force\` reads
them anyway.
\`pdf help\` — every page-and-mark verb: \`info\`, \`split\`, \`reorder\`, \`duplicate\`, \`crop\`, \`nup\`,
\`merge\`, \`rotate\`, \`watermark\`, \`header-footer\`, \`from-image\`, \`fill-form\`. One file in, one file
out, \`--out\` required, pages counted from 1.
\`render <file.pdf> [--page n] [--scale n]\` — a page as a picture, from pdfium, no window.

A form's fields are \`pdf info\` and \`pdf fill-form\`; text this tool *draws* (a watermark, a header)
uses a standard Latin-1 font, so Chinese comes back as \`?\` — the app's editor embeds your fonts and
is the way to get Chinese onto a page. No encryption writing and no redaction here; those are the
app's.

Making a PDF from something else is \`convert_tool\`'s job, not this one.`,
  convert_tool: `Turn one document format into another. One command per call — string or array input, no batching. A flag this tool does not
read is an error, never a silent default; a relative path counts from the session.

\`convert <file> --to pdf|docx|xlsx|pptx|md|html|csv [--out <file>] [--sheet <n>] [--password <pw>]\`

This is the one door whose source and target disagree, which is why conversions live here and not in
the format tools: whichever way you go, there is nothing to look up. Read \`docs/convert-tools.md\`
before your first command — it is the matrix, and it names the directions that do not exist.

What runs where: \`md\`, \`csv\` and the other text targets are engine work and run anywhere. \`--to pdf\`,
and \`--to html\` from a Word file, are **prints** — something has to lay the document out, and that is
the app on a desktop or a headless Chromium on a hub. When this host has neither, the command says
so by name instead of half-doing it.

The output format also decides who reads the result next: a \`.xlsx\` you just made is \`xlsx_tool\`'s to
change, a \`.docx\` is \`docx_tool\`'s.`,
  SubmitPlan: `Submit a plan for user review.

Call this after you have written your plan to a markdown file using the Write tool.
The plan will be displayed to the user in a special formatted view.

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to present the plan to the user
- No further tool calls or text output will be processed after this tool returns
- The conversation will resume when the user responds (accept, modify, or reject the plan)
- Do NOT include any text or tool calls after SubmitPlan - they will not be executed`,

  config_validate: `Validate Craft Agent configuration files.

Use this after editing configuration files to check for errors before they take effect.
Returns structured validation results with errors, warnings, and suggestions.

**Targets:**
- \`config\`: Validates config.json (workspaces, model, settings)
- \`sources\`: Validates all source config.json files
- \`statuses\`: Validates statuses config.json
- \`preferences\`: Validates preferences.json
- \`permissions\`: Validates permissions.json files
- \`automations\`: Validates automations.json configuration
- \`tool-icons\`: Validates tool-icons.json
- \`all\`: Validates all configuration files`,

  skill_validate: `Validate a skill's SKILL.md file.

Checks:
- Slug format (lowercase alphanumeric with hyphens)
- SKILL.md exists and is readable
- YAML frontmatter is valid with required fields (name, description)
- Content is non-empty after frontmatter
- Icon format if present (svg/png/jpg)`,

  mermaid_validate: `Validate Mermaid diagram syntax before outputting.

Use this when:
- Creating complex diagrams with many nodes/relationships
- Writing a mind map (\`mindmap\`), which is validated here too
- Unsure about syntax for a specific diagram type
- Debugging a diagram that failed to render

Returns validation result with specific error messages if invalid.`,

  source_test: `Validate, test, and (by default) activate a source configuration.

**This tool performs:**
1. **Schema validation**: Validates config.json structure
2. **Icon handling**: Checks/downloads icon if configured
3. **Completeness check**: Warns about missing guide.md/icon/tagline
4. **Connection test**: Tests if the source is reachable
5. **Auth status**: Checks if source is authenticated
6. **Auto-enable** (default): If validation passes, flip \`enabled: true\` in config (if needed) and activate the source in the running session so its tools become available without a restart.

Pass \`autoEnable: false\` to keep pure validation behavior (no config or session mutations).`,

  source_oauth_trigger: `Start OAuth authentication for an MCP source.

This tool initiates the OAuth 2.0 + PKCE flow for sources that require authentication.

**Prerequisites:**
- Source must exist in the current workspace
- Source must be type 'mcp' with authType 'oauth'
- Source must have a valid MCP URL

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_google_oauth_trigger: `Trigger Google OAuth authentication for a Google API source.

Opens a browser window for the user to sign in with their Google account.

**Supported services:** Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_slack_oauth_trigger: `Trigger Slack OAuth authentication for a Slack API source.

Opens a browser window for the user to sign in with their Slack account.

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_microsoft_oauth_trigger: `Trigger Microsoft OAuth authentication for a Microsoft API source.

Opens a browser window for the user to sign in with their Microsoft account.

**Supported services:** Outlook, Calendar, OneDrive, Teams, SharePoint

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_credential_prompt: `Prompt the user to enter credentials for a source.

Use this when a source requires authentication that isn't OAuth.
The user will see a secure input UI with appropriate fields based on the auth mode.

**Auth Modes:**
- \`bearer\`: Single token field (Bearer Token, API Key)
- \`basic\`: Username and Password fields
- \`header\`: API Key with custom header name shown
- \`query\`: API Key for query parameter auth
- \`multi-header\`: Multiple API keys with custom header names

**IMPORTANT:** After calling this tool, execution will be paused for user input.`,

  update_user_preferences: `Update stored user preferences. Use this when you learn information about the user that would be helpful to remember for future conversations. This includes their name, timezone, location, or any other relevant notes. Only update fields you have confirmed information about - don't guess.`,

  transform_data: `Transform data files using a script and write structured output for datatable/spreadsheet blocks, or extract HTML content for html-preview blocks.

Use this tool when you need to transform large datasets (20+ rows) into structured JSON for display, or extract/decode content for rich previews. Write a transform script that reads the input file and produces an output file, then reference it via \`"src"\` in your datatable/spreadsheet/html-preview/pdf-preview/image-preview block.

**Workflow:**
1. Call \`transform_data\` with a script that reads input files and writes output
2. Output a datatable/spreadsheet block with \`"src": "data/output.json"\`, an html-preview block with \`"src": "data/output.html"\`, a pdf-preview block with \`"src": "data/output.pdf"\`, or an image-preview block with \`"src": "data/output.png"\`

**Script conventions:**
- Input file paths are passed as command-line arguments (last arg = output file path)
- Python: \`sys.argv[1:-1]\` = input files, \`sys.argv[-1]\` = output path
- Node/Bun: \`process.argv.slice(2, -1)\` = input files, \`process.argv.at(-1)\` = output path
- For datatable/spreadsheet: output must be valid JSON: \`{"title": "...", "columns": [...], "rows": [...]}\`
- For html-preview: output is an HTML file (any valid HTML)

**Security:** Runs in an isolated subprocess with no access to API keys or credentials. 30-second timeout.`,

  script_sandbox: `Run quick inline diagnostics in a sandboxed subprocess with network isolation.

Use this for short Python/Node/Bun snippets when strict Explore-mode Bash parsing blocks inline diagnostics.

**Behavior:**
- Executes script source from \`script\` in a temporary file
- Returns stdout/stderr, exit code, duration, and timeout status
- Accepts optional input files and stdin
- Requires enforced network and filesystem isolation; if unsupported or unusable, execution is blocked

**Safety:**
- Sensitive credential env vars are stripped
- Input files are restricted to the current session directory
- Filesystem writes are restricted to the current session directory
- Timeout is capped (default 5000ms, max 15000ms)
- Network/filesystem isolation is required in all permission modes; if unavailable, execution is blocked`,

  render_template: `Render a source's HTML template with data.

Use this when a source provides HTML templates for rich rendering of its data (e.g., issue detail views, email threads, ticket summaries).

**Workflow:**
1. Fetch data from the source (via MCP tools or API calls)
2. Call \`render_template\` with the source slug, template ID, and data
3. Output an \`html-preview\` block with the returned file path as \`"src"\`

**Available templates** are documented in each source's \`guide.md\` under the "Templates" section.

Templates use Mustache syntax — the tool handles rendering and writes the output HTML to the session data folder.`,

  device_tool: `Run a tool on a named device — this machine or another one connected to this hub.

If \`browser_tool\` is not in your tool list, this server has no browser of its own: the \`browser\`
proxy below is the browser door here, and \`{"command":"--help"}\` is its command reference.

Two kinds of call, and they are never mixed:
- **Meta** — \`{"tool":"devices"}\` — what devices exist: id, name, platform, which capabilities each
  one allows (shell / files / browser / computer), and the workspace directories that may be touched.
  Names no device.
- **Proxy** — \`{"device":"…","tool":"bash"|…,"args":{…}}\` — runs exactly on the device that was
  named, and nowhere else.

**A proxy call never falls back.** The hub does not choose a device from who is asking, from the
client that sent the conversation's last message, or from whatever else happens to be connected. If
the named device is offline, its name fits more than one machine, or it does not allow that
capability, the call fails and says so rather than running somewhere else. For the server's own
machine, name that device's id exactly as \`devices\` reports it.

Nested proxy tools (all in \`args\`):
- \`bash\` — \`{command, cwd?, timeoutMs?}\` — run a shell command, cwd inside a workspace root
- \`read\` — \`{path, offset?, limit?}\` — read a text file (offset/limit are 1-based lines)
- \`write\` — \`{path, content}\` — write a file, creating parent directories
- \`edit\` — \`{path, oldString, newString, replaceAll?}\` — replace text in a file
- \`list\` — \`{path}\` — one directory's entries
- \`stat\` — \`{path}\` — type, size and mtime
- \`glob\` — \`{path, pattern}\` — files below \`path\` matching a glob (\`**\` supported)
- \`grep\` — \`{path, pattern, glob?, ignoreCase?, maxResults?}\` — regex search in files
- \`browser\` — \`{command}\` — the Browser Tools command line (same syntax, same guide, same
  \`--help\`), run on that device's browser. Only a device whose \`devices\` row lists \`browser\` can
  answer it; the connection does not fall back to this machine's browser when it cannot.

Paths must be absolute and inside one of the roots \`devices\` reports for that machine — the folders
it authorized for this hub. The device checks this itself and refuses anything else. Omitting \`cwd\`
runs in the fixed per-hub directory \`devices\` reports as \`default\`, which is always usable but is
not one of the granted roots. Use the local shell/file tools when the work is on this machine — this
one earns its keep when the machine is another one, or when two machines are compared.

Examples:
- \`{"tool":"devices"}\`
- \`{"device":"office-mac","tool":"bash","args":{"command":"git status --short","cwd":"…/repo"}}\`
- \`{"device":"office-mac","tool":"grep","args":{"path":"…/repo","pattern":"TODO","glob":"*.ts"}}\`
- \`{"device":"build-pc","tool":"browser","args":{"command":"navigate https://example.com"}}\``,

  browser_tool: `Run browser actions using a CLI-like command (string or array input).

This tool drives **this server's** browser only. Another machine's browser is \`device_tool\` with
\`{"tool":"browser"}\` — same commands, but the machine is named and never chosen for you.

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward, reload) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

\`evaluate\` is the one command that reads its argument **verbatim** either way: the expression is source
code, so quotes inside it are part of the program (\`evaluate document.title + ' | ' + location.href\` runs
that, quotes and all). A string argument is otherwise parsed like a shell line, which is why a value with
spaces in it needs its quotes.

\`evaluate --file <path>\` runs a script that is kept in a file instead of in the command (a relative path
counts from the workspace root): write it once with the Write tool and name it here, so the same code is
never spelled out a second time in a command. Use it for anything longer than a one-line probe. What it
runs is **not registered**, so a reload drops it.
Detailed rules and the full command reference: docs/browser-tools.md — read it before using this tool.

The window is one profile's and its tabs are many: every command can name the tab it acts on with \`--tab <id>\`
(\`tabs\` lists them). Without one it acts on **your** tab — the tab you have been working from, which
\`tabs\` marks as \`your tab\` and \`tab-select <id>\` sets. With none yet, \`navigate <url>\` **gives you one of
your own** (a new tab behind the person's — or the tab the window was born with, when the command is what
opens it) — that is the usual first command, and it
is the recommended one because it is **idempotent**: calling it again acts in the same tab, where
\`tab-new <url>\` adds a tab every time. If the page you need is already open on the person's tab, \`tabs\` shows
it — \`tab-select <id>\` first, or \`--tab <id>\` on the command itself, works in *their* tab, as something said
rather than something that happened by itself. Every other command, with no tab of yours, says so instead of
picking one and names the ways out. What the person happens to be looking at never decides where your commands
land. A session spawned by another one takes no tab of its own choosing: it works in the tab the parent
handed over (\`tab-assign\`) or opens one with \`tab-new <url>\`.

There is **one browser window per workspace and browser profile**, shared by every conversation
working in that profile and by the user — so \`tab-new\` adds a tab to the window you are working in instead
of making a window (a profile with no window gets one when a tab is first opened), and the window is not yours
to close: use \`tab-close <id>\` for
the tabs of your task (the ones you opened, the ones handed to you, and the tabs opened from them — a Task's
node tabs included, so a finished DAG can be tidied up). \`tab-show <id>\` makes a tab the one the window
shows, without raising the window — your reply is what tells the person to look; \`tab-show <id> --handover\`
also drops your overlay and hold, so the page is theirs to use until your next command takes it back. \`tabs\` says
what each tab is, whose work it is in and who is working on it — another conversation's **work** is refused
(a tab the person opened is nobody's work, and another conversation working from it does not
change that), and \`tab-assign <tab-id> <session>\` is how a parent hands one of its own tabs to a session it spawned,
so that parallel sessions each work in their own tab. A tab's work outlives the session that opened it: a
Task node's tab belongs to that node, so a re-run of a node finds its predecessor's tab in \`tabs\` — read it
before opening one, because \`tab-new\` always gives you a tab of your own (when it is what opens the window it
opens into the tab that window was born with; a window that already exists gets one more).

Every command can also name the **profile** it works in: \`--profile <name-or-id>\` (\`profiles\` lists them by
name and id) moves that one command to that profile's window; \`navigate\`/\`tab-new\` open that window when it
is not up, while the other commands report that there is no window instead of opening one. A command that
names no profile uses the profile this conversation is set to — its own pick, then its project's default,
then the workspace default, then Default — and does not fall back to Default while another one is selected.
A name that does not exist is refused rather than mapped to Default. That is how **one conversation can drive
two profiles at once**. \`tabs\`
lists every window with its profile; a tab id is unique inside one window, so two profiles can both have a
\`tab-1\`, and \`--profile\` says which one \`--tab\` means.
A spawned session inherits its parent's browser profile the way it inherits the parent's working directory, so
its unnamed commands keep working in that profile.

Examples:
- \`--help\`
- \`navigate https://example.com\` — go there in your tab, taking one if you have none yet (this also opens the window)
- \`tab-new https://example.com\` — one more page, in a tab of its own behind the person's
- \`profiles\` — the browser profiles a command can name
- \`navigate https://app.example.com --profile Work\` — work in that profile's window (opened if needed)
- \`snapshot\`
- \`read --save notes/my-page.md\` — read the page as an article (markdown + the facts it states); \`--save\` keeps it in a file, and \`--images\` also keeps its images beside it in \`notes/my-page.assets/\`; without \`--save\` the note comes back instead of being written
- \`find login button\` — search elements by keyword
- \`click @e12\`
- \`click-at 350 200\` — click at pixel coordinates (for canvas elements)
- \`drag 100 200 300 400\` — drag from (100,200) to (300,400)
- \`fill @e5 user@example.com\`
- \`type Hello World\` — type into currently focused element (no ref needed)
- \`select @e3 optionValue\`
- \`select @e75 CNAME --assert-text Target --timeout 3000\`
- \`set-clipboard Name\\tAge\\nAlice\\t30\` — write text to clipboard
- \`get-clipboard\` — read clipboard text content
- \`paste Name\\tAge\\nAlice\\t30\` — set clipboard and trigger Ctrl/Cmd+V
- \`upload @e3 /path/to/file.pdf\` — attach local file(s) to a file input
- \`scroll down 800\`
- \`reload\` — reload this page. A page of ours is rendered from disk, so an edit to it shows up on the next render; nothing waits for the load, so \`wait network-idle\` before reading it, and re-\`snapshot\` (every ref is stale)
- \`evaluate document.title\`
- \`evaluate --file scripts/probe.js\` — a script kept in a file
- \`pick\` — ask the user to click an element; returns a stable selector + geometry
- \`tabs\` — which tabs this window has, each with what it is and whose work it is in
- \`snapshot --tab tab-3\` — act on a named tab (it becomes the tab you work from; the window is not moved)
- \`tab-new https://example.com\` — one more tab for you, behind the person's
- \`tab-select tab-3\` — make a tab the one you work from (the window shows what it showed)
- \`tab-show tab-3\` — make it the tab the window shows, without raising the window
- \`tab-show tab-3 --handover\` — make it the shown tab and drop your overlay and hold so they can use it
- \`tab-assign tab-3 260915-brave-fox\` — hand one of your own tabs to a session you spawned
- \`tab-close tab-2\` — close one tab (closing the last one closes the window)
- \`console 50 error\`
- \`screenshot\` — raw screenshot
- \`screenshot --annotated\` — screenshot with @eN labels overlaid on interactive elements
- \`screenshot-region 100 200 640 480\`
- \`screenshot-region --ref @e12 --padding 8\`
- \`screenshot-region --selector div[data-testid="chart"]\`
- \`viewport-resize 1440 900\` — give the tab you act on this viewport. The window follows when that tab is the one on screen (its viewport *is* the window's page area); a tab working behind the person keeps its new size to itself, and their window is not touched
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`

**A screenshot may be scaled before the model sees it.** A large image can be downscaled by the
vision input, which makes the coordinates read off it inaccurate. If a coordinate seems off, shrink
the shot — \`viewport-resize\`, or a \`screenshot-region\` — and take it again.

**Recording a tab.** \`record-start --tab <id> --ttl <dur> [--wait]\` records one named tab for at
most <dur> and stops on its own when that is up (the ceiling is ten minutes). \`record-stop --tab
<id>\` ends one early. Both name the tab: nothing is recorded by default, and a stop that guessed
would land on a different recording than the one it meant.

A recording is not part of a turn. It ends when its time runs out, when the tab or its window goes
away, or when you stop it — never because a turn ended — and its length is settled when it starts,
so nothing has to be kept open or closed by hand. Without \`--wait\` the answer comes back as soon
as it is recording; with it, the answer *is* the finished recording. Recording two tabs at once is
ordinary: start one, work, start another, and the first keeps going. The tab you are recording is
recorded whether or not you are looking at it.

A recording is two files: the film, and \`<stem>.events.jsonl\` beside it — navigations, requests,
clicks and fills, each stamped on the film's own clock. Read the sidecar first. For the film
itself, understanding is one call (\`recording_tool understand <file> --prompt "<question>"\`); a
transcript is \`recording_tool audio <file> --out words.wav\` then \`asr_tool transcribe words.wav\`;
pictures you already hold are \`recording_tool frames\` then \`call_llm\`. Recording first and working
out what to ask afterwards is the normal order.

Examples:
- \`record-start --tab tab-3 --ttl 30s\`
- \`record-start --tab tab-3 --ttl 1m --wait\`
- \`record-stop --tab tab-3\``,

  computer_tool: `Drive this machine's desktop — read a window's accessibility tree, act on an element
by the token that snapshot printed, and fall back to coordinates only where no tree exists
(one command per call — string or array input, no batching).

Read **docs/computer-use.md** before the first call: command table, token rules, and the sessions
that refuse input (locked, remote). \`status\` answers what this session can do before you plan.

  computer_tool "status"
  computer_tool "snapshot"
  computer_tool ["click s00000001:12", "snapshot"]`,


  reel_tool: `A conversation's cuts — a timeline the person and you both edit, stored as one JSON document at <project>/reels/<slug>.reel.

Commands: list · create · state [--json] · probe --src <path> · snapshot [--at <s>] [--out <path>] [--clip <id> [--edge first|last]] · export [--out <path>] [--status [<id>]] · subtitles [--out <path>] · fcpxml [--out <path>] · apply --ops <json|@file>.

A clip is { id, src, start, in, duration }: src is project-relative (\`assets/a.mp4\`), start is where it sits on the timeline, in/duration are the source window it uses — omit duration and the host reads it from the file. Overlays above the picture carry subtitles, 花字 and picture-in-picture.

Beat-synced cuts: \`beats --src <path> --clip <id> --json\` gives BPM and beat/downbeat times; \`auto_edit\` fills a track from them.

Read first: state prints settings, duration, every clip and overlay id. apply writes against the revision you read, and a stale one is refused — re-read, then retry. One call is one batch of 1–50 ops, applied whole or not at all. An open panel takes a new revision as one undo step.

\`reel_tool help\` is the compact reference — commands, units, op groups, transition rules; \`reel_tool help all\` lists every op shape and field. Read the short one before the first write, the long one when an op's fields are unclear.`,
  media_tool: `Make a media file through a configured account. One command per call. Nothing that writes a file runs without an account.

\`channels\` — which accounts exist, what each one can make (one account may make several kinds), the models each capability can reach, and the values each model accepts. \`models --channel <id> [--kind <k>] [--model <m>]\` is the detailed guide for one account: parameter names, voices, formats, limits and usage.

\`generate --prompt <text|@file> [--out <path>] [flags]\` — one prompt, one file. \`--out\` is optional: omitted, the file lands under \`<contentRoot>/assets/<timestamp>-<slug>.<ext>\` (ext picked from \`--kind\`), already an asset with its source note beside it. The content root is the project this conversation is in, or its own session folder when it is in none. A path may be a handle (\`assets/x.png\`, \`session:\`, \`project:\`, \`cwd:\`, \`workspace:\`) or absolute; replies print the absolute path. The provider's bytes are written as they arrive (or, when the channel answers with a task id, later — the call returns as soon as it is submitted). A note is left beside the result recording the prompt, the references and the channel.

\`--prompt\` takes the text itself, or \`@briefs/shot.md\` to read it from a file. It is repeatable: the values are joined in order, so a brief can be one argument and the direction for this shot the next.

\`--input\` a reference file to send with the prompt, repeatable. Images, videos and audios may be mixed; text is not a reference (put it in \`--prompt\`). Order matters: \`{{ref 1}}\` in the prompt names the first input, and the channel rewrites it to its own wording (\`图片1\`, \`Image 1\`…). \`--first-frame\` / \`--last-frame\` pick those two frame roles for a clip.

Reading a **picture** or a **recording** is not this door's: what a picture *shows* goes to \`call_llm\` with its path as an attachment, while the **words printed on one** are \`img-tool text\` (local, exact characters, no account). A recording is understood with \`recording_tool understand\`, or transcribed with \`recording_tool audio\` then \`asr_tool transcribe\`.

Local pixel changes (crop, rotate, flip, resize, convert, watermark, composite) are \`img-tool\`'s.

\`task --out <path>\` — how the task behind that file is doing: running, failed with its reason, or gone because the file landed.
\`tasks [--kind image|video|music|tts] [--status <s>]\` — every unfinished job under the conversation's content root, with the path each will land at, so a path can be found again.
\`detach --out <path>\` — stop waiting. Most providers cannot stop a job they already accepted, so the file may still arrive later; this only changes whether anything is watching.

\`--channel\` an id from \`channels\`; omitted, the first account that makes this kind. One account may make several kinds, so the same id can answer for a picture and for a clip.
\`--model\`   a model that channel lists; omitted, the channel's default.
\`--kind\`    \`image\` (default), \`video\`, \`music\` or \`tts\`. A speech channel reads text aloud through an account that offers it; without one, \`tts\` is refused.
\`--duration\`, \`--quality\`, \`--ratio\`, \`--lyrics\`, \`--voice\`, \`--format\` — the choices \`channels\` lists for that account. Omitted: its default. \`--lyrics\` is \`--kind music\` only and takes text or \`@song.txt\`; the prompt is the style brief.
\`--param\`   a parameter the model lists, \`key=value\`, repeatable; \`channels\` prints the names and values each one accepts.

Failures name their layer — 上传失败 / 审核不通过 / 生成失败 / 下载失败 — because the four are fixed differently: a rejected asset is not retried, a failed download is not regenerated.

A generation writes a file. The asset library and the project graph read the folder, so the result appears without a second write: do not write an index for it.`,

  asr_tool: `Read an audio file into words. One command per call.

\`transcribe <audio> [--out <path>] [--format text|srt|json] [--language auto|zh|en|ja|ko|yue]\` — the words. Without \`--out\` the reply is text by default, or SRT/JSON when \`--format\` asks for it; \`--out\` writes them, and the name decides (.txt, .md, .srt, .json) unless \`--format\` overrides.

wav and mp3 are read everywhere; other containers only where this machine's side can decode them. A video is not audio: \`recording_tool audio <file> --out words.wav\` first.`,

  recording_tool: `Read a recording — what it is, the frames inside it, its sound, and one answer about it. One command per call.

\`probe <path>\` — duration and picture size, header only (no frames).

\`frames <path> [--out <dir>] [flags]\` — decode frames. Without \`--out\` they are the reply, as images; with it they are written as \`frame-0001.jpg\`, … and named in the reply. \`--every <dur>\` sets the spacing (default 1s), \`--changes\` keeps only frames that moved (with \`--threshold <0-1>\`), \`--from\` / \`--to\` bound the window (\`--to\` omitted means the end), \`--first\` / \`--last\` pick the two ends instead of a scan, \`--max <n>\` is the ceiling (default 1000; a longer recording is read more coarsely, not cut short), \`--max-edge <n>\` caps the longest edge (default: the recording's own size).

\`audio <path> --out <file> [--format wav|mp3] [--bitrate <kbps>]\` — the recording's sound as 16 kHz mono WAV (the file \`asr_tool transcribe\` reads) or MP3 (32 kbps by default); the name decides, \`--format\` overrides. A clip or an audio-only file (m4a, ogg, flac) both work; a file with no audio track is refused by name.

\`understand <path> --prompt "<question>" [--frames <n|off>] [--audio off] [--mode <route>]\` — one answer about the whole recording. The route is chosen from the person's settings (a short clip whole, frames + sound, one modality, or a transcript); \`--mode\` overrides it, and \`--audio off\` / \`--frames off\` drop a modality. Up to 30 minutes.

The decoder is Chromium's — no ffmpeg. mp4 (H.264), webm and most mov read; HEVC needs a hardware decoder, ProRes not at all.

For pictures you already hold, compose: \`frames\` then \`call_llm\` with the images and the moment each came from. Speech-to-text is \`asr_tool transcribe\`.`,


  html_tool: `Read and change an HTML file the way the editor sees it (one command per call).

The visual editor changes a page one **element** at a time, addressed by its path of element-child indices — the same
address this tool takes. That is what lets a change land in the page's own source without reformatting it.

\`elements <file>\` lists the page's elements in document order: the path, the tag, and the first words of the element's
own text. A path nobody printed is a path that was guessed, so read this first. Text is shown only for elements that
hold text and nothing else.

\`set <file> --path <p> --html "<markup>"\` replaces one element — its tags and everything inside — and keeps every other
byte of the file, indentation included. The markup is inserted as written.

\`edit <file> --expect "<text>" --text "<text>"\` changes **one occurrence**, and only when it is unambiguous. If the page
is open in the app, the change lands in that editor rather than the disk. An \`--expect\` that is no longer there, or
appears twice, is refused.

\`shot <file> [--width n] [--height n] [--out <dir>]\` draws the page and puts the picture in the reply — the file
itself, at its own address, with **its scripts run**, so the picture is the page a person opens: a chart it builds with a
CDN library is in the picture, and so is a stylesheet beside it. The draw waits for the page's own resources and for the
work its scripts started; a page that never settles is photographed after four seconds anyway.

Paths count from the conversation's content root (the project folder, or the session folder).

Examples:
- \`elements previews/report.html\`
- \`set previews/report.html --path 1/1/0 --html "<p>新的第一段。</p>"\`
- \`edit previews/report.html --expect "旧标题" --text "新标题"\`
`,

  markdown_tool: `Read and change a markdown file the way the editor sees it (one command per call).

A \`.md\` file is written with \`Write\`/\`Edit\`, like any other file of your work. What those cannot say is how the
file is **divided** — which top-level blocks it has, and which part of it is frontmatter rather than document. This
tool speaks that way, so a change can name a block instead of a string.

\`blocks <file>\` lists the file's top-level blocks in order, numbered from 0. Each line names the block's kind and its
first line. Read it before naming a block: a number nobody printed is a number that was guessed.

\`set <file> --block <n> --text "<markdown>"\` replaces one top-level block **in place**: every byte around it is kept,
so a table's own column alignment and the blank lines between blocks survive. A \`--text\` that would become two
blocks is refused rather than written, because it would renumber everything you were told about.

\`edit <file> --expect "<text>" --text "<text>"\` changes **one occurrence**, and only when it is unambiguous. If the
document is open in the app, the change lands in that editor — one step of the person's undo, with their caret
mapped through it, and their unsaved work intact. If nothing is showing the file, the same edit is applied to the
bytes and written. An \`--expect\` that is no longer there, or appears twice, is refused: an edit that could mean two
places is not an edit.

\`frontmatter <file>\` prints the YAML above the body, without its fences; \`--set "<yaml>"\` replaces it and \`--remove\`
takes it off. Frontmatter is not a block and never appears in \`blocks\`.

\`shot <file> [--width n] [--height n] [--out <dir>]\` draws the document **as an outside reader sees it** and puts the
picture in the reply: what the file says — headings, tables, code, and the fences whose content is in the fence
(\`mermaid\`, \`latex\`, \`datatable\`, \`diff\`, \`json\`, \`image-preview\`) — without the fences that only mean "open this in
Craft". Those are not standard markdown, so anyone opening the file in another editor gets a code block; the picture
shows exactly that, which is how you check what you are about to hand over.

Paths count from the conversation's content root (the project folder, or the session folder).

Examples:
- \`blocks docs/spec.md\`
- \`set docs/spec.md --block 3 --text "## 新标题"\`
- \`edit docs/spec.md --expect "旧的一句。" --text "新的一句。"\`
- \`frontmatter SKILL.md --set "name: daily\ndescription: 日报"\`
`,

  drawio_tool: `Make and draw diagrams (one command per call — string or array input, no batching).

A \`.drawio\` file is written by you, with \`Write\`/\`Edit\`, like every other file of your work — the
format, and the rules that fail silently, are in \`docs/drawio-tools.md\`. What this tool does is
*draw* one.

\`pages <diagram-file>\` lists the pages the file holds — a \`.drawio\` file, or an SVG exported with a
copy of its document inside (\`--editable\`). What it prints is what \`--page\` takes, in the order the
document has them; read it before naming a page, because the name is the document's own and cannot be
guessed.

\`export <diagram-file> --to <path> [--format svg|png|html|drawio] [--editable] [--page <name>] [--scale <n>] [--theme <t>]\`
draws a \`.drawio\` file into a file that travels. \`svg\` (the default) is the picture and nothing else —
what you show someone. Add \`--editable\` and the picture carries the drawing's own document as well, so
whoever might have to change it opens that file in draw.io as the real diagram — its pages and shapes,
not a picture of one — and hands it back; it is the bigger file, because the document rides along.
\`drawio\` is not a drawing at all: the document itself, written out with every page uncompressed — how
a file someone else saved compressed is made readable again (\`pages\` says when that is the case), and
the one format whose suffix matters, because a diagram is opened by its \`.drawio\` name. A \`--to\` path
that names no suffix gets the format's. \`--theme\` (svg and png) says what the drawing is made for:
\`auto\` (the default), \`light\`, or \`dark\` — an svg states it in the file, so it follows whoever shows
it or is pinned; a png is drawn that way.

\`render <diagram-file> [--page <name>] [--scale <n>] [--theme <t>]\` draws it as a picture and puts the
picture in the reply, writing nothing. Reach for it to check what you drew: XML that is well-formed
is not a diagram that reads well, and a wall of overlapping boxes can only be seen.

A file can hold several pages, and drawing is always one of them: \`--page <name>\` names it the way
the document does, and with no \`--page\` it is the first page. A name no page has — or one that two
pages share — is refused rather than drawn.

The drawing is the drawio webapp the app already ships, in a hidden window of its own — no window of
yours is involved, nothing is installed, and no diagram reaches the network. A relative path counts
from the conversation's content root (the project folder, or the session folder).

Read \`docs/drawio-tools.md\` before your first drawio command: it is the whole guide — the file
format and the rules that fail silently, where the shapes come from, and how a diagram takes part in
a spec.

Examples:
- \`--help\`
- \`export flows/checkout.drawio --to out/checkout.svg\`
- \`export flows/checkout.drawio --to out/checkout.png --format png --scale 2\`
- \`render flows/checkout.drawio\``,

  call_llm: `Invoke a secondary LLM for focused subtasks. Use for:
- Cost optimization: the session's fast model answers, not the main one
- Structured output: JSON schema compliance via prompt instructions
- Parallel processing: call multiple times in one message - all run simultaneously
- Context isolation: process content without polluting main context

Put text/content directly in the 'prompt' parameter. Do NOT pass inline text via attachments.
Only use 'attachments' for existing file paths on disk - the tool loads file content automatically.
Images are supported: give an image's file path and a vision-capable model reads it (the connection's vision model, or the main model when it can see). Use this when the image cannot be sent to you directly.
For large files (>2000 lines), use {path, startLine, endLine} to select a portion.`,

  decide: `Ask the decision model (Jev, TypeSafe System One) typed questions about text or JSON. It answers with probabilities, never prose: 'choice' picks one of your named options, 'score' places the state on an ordered rubric, 'noul' gives a yes/no probability. Fast (~0.1–0.5 s per call) and cheap; batch mode judges up to 200 items in one call.

Use it to classify, route, tag, rank or triage many items (emails, tickets, rows, search hits), for yes/no checks over a list, or to score against a rubric. Do NOT use it for anything that needs generated text, value extraction or reasoning — use call_llm for those.

Question design: short option keys with a one-sentence description each (null when self-explanatory); English instructions; score levels ordered lowest → highest; add an 'other' or 'unclear' option when the categories are not exhaustive. Ask several questions per call instead of several calls.

Read answers honestly: confidence below 0.5 means the model is unsure — say so or ask the user instead of acting on it; choose noul thresholds for the stakes (0.8+ when a false yes is costly). Answers are hints, never permission: re-check before acting on them.

Privacy: the state is sent to the user's configured decision provider (TypeSafe, OpenRouter, Vercel AI Gateway or their own server). Do not include secrets or content that must not leave the machine. Only available when the user enabled the decision model in Settings > AI.`,

  spawn_session: `Create a new session that runs independently with its own prompt, connection, model, and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available connections, models, and sources.
When spawning, the 'prompt' parameter is required.

Optional overrides: \`model\`, \`llmConnection\`, \`permissionMode\`, \`thinkingLevel\`, \`enabledSourceSlugs\`, \`labels\`, \`workingDirectory\`. Omitted fields inherit from the spawning session or the workspace default.

\`thinkingLevel\` is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring. Use it when you want to force deeper reasoning on a supported model, or set it to \`off\` when spawning a session that doesn't need to think.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,

  send_developer_feedback: `Send freeform feedback to the Craft Agent development team.

Use this to share anything that would help improve the product — issues you hit, ideas for better tools, suggestions for improved workflows, or patterns you notice. Write in markdown with as much detail as possible. This is your direct line to the developers.`,

  set_session_labels: `Set labels on the current session or a specific session by ID. Replaces all existing labels.

Use this to tag sessions for filtering or to trigger label-based automations (LabelAdd/LabelRemove events).
Pass an empty array to clear all labels. Omit sessionId to target the current session.`,

  set_session_status: `Set the status of the current session or a specific session by ID (e.g., "todo", "in_progress").

Use this to reflect progress or trigger status-based automations (SessionStatusChange events).
Omit sessionId to target the current session.

IMPORTANT: never move a task into a closed status (such as "done" or "cancelled") yourself — closing a task is the user's decision, made on the board. You may prepare and hand off work by setting an open status like "needs-review"; the user reviews and closes it. Closed-status calls are rejected.`,

  archive_session: `Archive or unarchive another session in this workspace by ID.

Archiving removes a session from the active list and unread counts — it does NOT delete it (pass archived=false to restore). Use it to tidy up finished or superseded sessions.
Requires an explicit sessionId and cannot target your own session. Use list_sessions / get_session_info to find the target session's ID.`,

  create_task: `Create a Craft Agents Task on the kanban board — writes tasks/<slug>/task.yaml and creates its orchestrator session. CREATION ONLY: the task lands in "todo" and is NOT run; starting it is the user's (or an automation's) decision.

Provide title + description (the description becomes the task goal and the initial node prompt). Optional: acceptanceCriteria (verification rubric), sources / skills (workspace slugs), llmConnection + model, workingDirectory, projectId. When projectId is omitted, the task inherits the invoking session's project.

Returns { slug, orchestratorSessionId, taskLabelId, warnings } — unknown source/skill slugs are reported as warnings, not errors. Use it when the user asks to capture or queue work as a task; to execute work right now, use the current session or spawn_session instead.`,

  list_tweaks: `List the workspace's tweaks — standing edits that run on pages nobody here owns (an admin console, a vendor's dashboard, a tool that is almost right). Each one is a folder at tweaks/{slug}/: a tweak.json naming the pages it is for, and tweak.css and/or tweak.js holding what it does. A tweak that is off does nothing anywhere.

Returns compact summaries: slug, name, the match patterns it is for, whether it is on, and whether it has code to inject. Use get_tweak for one in detail, including whether what it is aimed at has stopped matching.`,

  get_tweak: `Get one tweak: its config, the files it has, when its javascript runs, every selector it declares with a \`@target\` comment, and when each last matched.

A target with \`stale: true\` matched before and did not the last time the tweak ran — the page moved and the selector needs updating. Read \`cssPath\`/\`jsPath\` to see the code itself; nothing here returns it inline.`,

  create_tweak: `Create a tweak: the standing edit for the pages you name. Give it the match patterns and the code (\`css\`, \`js\`, or both).

Read \`~/.craft-agent/docs/tweaks.md\` before your first tweak: it is the whole guide — the folder, when a tweak runs and what a reload is for, the \`@target\` markers, and how a tweak reaches a browser this app is not in.

**It is created off.** A tweak injects into pages the user is signed in to, so naming those pages is not the same consent as agreeing to run this code in them. Switch it on (\`update_tweak\` with \`enabled: true\`) when the user asked for the change to take effect, and say plainly that it is off when they have not.

**Seeing it.** The code is read on the next load of each matching page, so nothing here reaches a page that is already open — not the code, and not switching it on either. \`browser_tool\`'s \`reload\` is how to look at a change, and it is also the check worth trusting: a reload gives a clean document, where the one already open has been through other things.

\`matches\` is Chrome's own grammar — \`*://*.example.com/admin/*\` — which is also what the loadable extension needs, so the same tweak works both ways. Write the code for the way it runs: every load of every matching page, in a browser that is not this app, so it must not depend on anything here. Its stylesheet is inserted before the DOM exists; its javascript runs at \`document_end\` (the DOM is complete) unless the code declares otherwise with a \`/* @run-at document_start|document_end|document_idle */\` comment — the browser's own three moments, which the exported extension maps straight through. Mark what it is aimed at with a \`/* @target <selector> */\` comment: that is what lets "stopped matching" be told from "never matched" later.`,

  update_tweak: `Update an existing tweak: its name, description, the pages it matches, and whether it is on.

Switching it on is the same judgement as creating it on: a tweak runs in pages the user is signed in to, so enable it when they asked for the change to take effect, not by default. Only provided fields change; \`description: null\` clears it.

The code is read on the next load of each matching page, so nothing here reaches a page that is already open — not an edit, not a switch-off, and not switching it on either. Use \`browser_tool\`'s \`reload\` to see it (and see \`create_tweak\` for why a reload is the check worth trusting).`,

  delete_tweak: `Delete a tweak — its folder, its code and its record. DESTRUCTIVE: confirm with the user first unless they explicitly asked for the deletion.`,
  get_session_info: `Get metadata about the current session or a specific session by ID.

Returns labels, status, name, permission mode, projectId (if the session is bound to a project), workingDirectory, and other details.
Call with no arguments to introspect your own session state.`,

  list_sessions: `List sessions in the workspace. Returns total count + paginated results.

Use filters (status, label, search) to narrow results instead of fetching everything. Default limit is 20 sessions.
Use get_session_info for full details on a specific session (list-then-detail pattern).`,

  list_background_tasks: `List background agents/tasks tracked for a session (running, finished, or orphaned).

This is the authoritative way to answer a "what background work is running / what's the status?" question.
It reads the main-process registry, which tracks tasks ACROSS turns — unlike the SDK's in-subprocess task tools,
which only see tasks launched in the current subprocess and lose visibility of tasks from prior turns.

Status meanings:
- running: backgrounded and not yet reported finished.
- completed / failed / stopped: a terminal notification was received.
- orphaned: the turn that launched the task ended before it finished, so it was terminated with that turn's subprocess.

kind is agent, workflow, shell (a background Bash command) or task (Monitor, MCP...). untracked: true marks a completion for a task this session's agent did not launch (typically a subagent's own background command). Tasks without startTime have an unknown start.

Never guess or claim "the app restarted" — report exactly what this tool returns. Omit sessionId for the current session.`,

  send_agent_message: `Send a message to another session. The message is delivered with your session ID so the target can reply back.

Use this to coordinate with spawned sessions, send follow-up instructions, or relay information between sessions.
Use list_sessions to find session IDs, or use the sessionId returned by spawn_session.

The target session receives your message with a sender envelope containing your session ID, so it can use send_agent_message to reply.`,
} as const;

// ============================================================
// Tool Definition Type
// ============================================================

/** Handler function signature for session tools. */
export type SessionToolHandler = (ctx: SessionToolContext, args: any) => Promise<ToolResult>;

/** Where a session tool is executed. */
export type SessionToolExecutionMode = 'registry' | 'backend';

/** Safe/Explore mode behavior for a session tool. */
export type SessionToolSafeMode = 'allow' | 'block';

interface SessionToolDefBase {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Whether this tool is allowed in Explore/Safe mode. */
  safeMode: SessionToolSafeMode;
  /** Whether this tool only reads data (no side effects). Enables parallel execution in backends that support it. */
  readOnly?: boolean;
}

/** Tool executed from the canonical registry (requires a concrete handler). */
export interface RegistrySessionToolDef extends SessionToolDefBase {
  executionMode: 'registry';
  handler: SessionToolHandler;
}

/** Tool executed by backend-specific adapters (Pi/Claude). */
export interface BackendSessionToolDef extends SessionToolDefBase {
  executionMode: 'backend';
  handler: null;
}

/** A single session tool definition combining name, description, schema, mode, and handler. */
export type SessionToolDef = RegistrySessionToolDef | BackendSessionToolDef;

// ============================================================
// Canonical Tool Registry
// ============================================================

export const SESSION_TOOL_DEFS: SessionToolDef[] = [
  { name: 'SubmitPlan', description: TOOL_DESCRIPTIONS.SubmitPlan, inputSchema: SubmitPlanSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSubmitPlan },
  { name: 'config_validate', description: TOOL_DESCRIPTIONS.config_validate, inputSchema: ConfigValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleConfigValidate },
  { name: 'skill_validate', description: TOOL_DESCRIPTIONS.skill_validate, inputSchema: SkillValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleSkillValidate },
  { name: 'mermaid_validate', description: TOOL_DESCRIPTIONS.mermaid_validate, inputSchema: MermaidValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleMermaidValidate },
  { name: 'source_test', description: TOOL_DESCRIPTIONS.source_test, inputSchema: SourceTestSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSourceTest },
  { name: 'source_oauth_trigger', description: TOOL_DESCRIPTIONS.source_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSourceOAuthTrigger },
  { name: 'source_google_oauth_trigger', description: TOOL_DESCRIPTIONS.source_google_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleGoogleOAuthTrigger },
  { name: 'source_slack_oauth_trigger', description: TOOL_DESCRIPTIONS.source_slack_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSlackOAuthTrigger },
  { name: 'source_microsoft_oauth_trigger', description: TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleMicrosoftOAuthTrigger },
  { name: 'source_credential_prompt', description: TOOL_DESCRIPTIONS.source_credential_prompt, inputSchema: CredentialPromptSchema, executionMode: 'registry', safeMode: 'block', handler: handleCredentialPrompt },
  { name: 'update_user_preferences', description: TOOL_DESCRIPTIONS.update_user_preferences, inputSchema: UpdatePreferencesSchema, executionMode: 'registry', safeMode: 'block', handler: handleUpdatePreferences },
  { name: 'transform_data', description: TOOL_DESCRIPTIONS.transform_data, inputSchema: TransformDataSchema, executionMode: 'registry', safeMode: 'allow', handler: handleTransformData },
  { name: 'script_sandbox', description: TOOL_DESCRIPTIONS.script_sandbox, inputSchema: ScriptSandboxSchema, executionMode: 'registry', safeMode: 'allow', handler: handleScriptSandbox },
  { name: 'render_template', description: TOOL_DESCRIPTIONS.render_template, inputSchema: RenderTemplateSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRenderTemplate },
  { name: 'send_developer_feedback', description: TOOL_DESCRIPTIONS.send_developer_feedback, inputSchema: SendDeveloperFeedbackSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSendDeveloperFeedback },
  { name: 'call_llm', description: TOOL_DESCRIPTIONS.call_llm, inputSchema: CallLlmSchema, executionMode: 'backend', safeMode: 'allow', readOnly: true, handler: null },
  // Decision model (registry — uses ctx.decide from SessionManager; hidden unless the user enabled the decision layer)
  { name: 'decide', description: TOOL_DESCRIPTIONS.decide, inputSchema: DecideSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleDecide },
  { name: 'spawn_session', description: TOOL_DESCRIPTIONS.spawn_session, inputSchema: SpawnSessionSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  { name: 'browser_tool', description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Device tool (backend-specific — reaches shell/files/browser on any connected device)
  { name: 'device_tool', description: TOOL_DESCRIPTIONS.device_tool, inputSchema: DeviceToolSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  // Media tool (backend — accounts only: generate / tasks)
  { name: 'media_tool', description: TOOL_DESCRIPTIONS.media_tool, inputSchema: MediaToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Transcription (backend — recordings into words, routed by the person's setting)
  { name: 'asr_tool', description: TOOL_DESCRIPTIONS.asr_tool, inputSchema: AsrToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Video tool (backend — local decoding: probe / frames; needs the app's Chromium)
  { name: 'recording_tool', description: TOOL_DESCRIPTIONS.recording_tool, inputSchema: RecordingToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Desktop door (backend-specific — needs this machine's accessibility session)
  { name: 'computer_tool', description: TOOL_DESCRIPTIONS.computer_tool, inputSchema: ComputerToolSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  { name: 'drawio_tool', description: TOOL_DESCRIPTIONS.drawio_tool, inputSchema: DrawioToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // HTML tool (backend — the element vocabulary the visual editor patches by)
  { name: 'html_tool', description: TOOL_DESCRIPTIONS.html_tool, inputSchema: HtmlToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Reel tool (registry — a cut is a file; this reads and writes it without an editor open)
  { name: 'reel_tool', description: TOOL_DESCRIPTIONS.reel_tool, inputSchema: ReelToolSchema, executionMode: 'registry', safeMode: 'allow', handler: handleReelTool },
  // Markdown tool (backend — the same block vocabulary the editor saves by)
  { name: 'markdown_tool', description: TOOL_DESCRIPTIONS.markdown_tool, inputSchema: MarkdownToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Document tool (backend-specific — file-level; the GenOffice command line does the work)
  // The document doors — five tools, one dispatcher. Names, briefs and guide files come from
  // `office-domains.ts`, so a sixth format is a row there rather than five edits here.
  ...OFFICE_DOMAINS.map((entry) => ({
    name: entry.toolName,
    description: (TOOL_DESCRIPTIONS as Record<string, string>)[entry.toolName] as string,
    inputSchema: OfficeToolSchema,
    executionMode: 'backend' as const,
    safeMode: 'allow' as const,
    handler: null,
  })),
  // Session self-management tools (registry — use context callbacks to reach SessionManager)
  { name: 'set_session_labels', description: TOOL_DESCRIPTIONS.set_session_labels, inputSchema: SetSessionLabelsSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionLabels },
  { name: 'set_session_status', description: TOOL_DESCRIPTIONS.set_session_status, inputSchema: SetSessionStatusSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionStatus },
  { name: 'archive_session', description: TOOL_DESCRIPTIONS.archive_session, inputSchema: ArchiveSessionSchema, executionMode: 'registry', safeMode: 'block', handler: handleArchiveSession },
  { name: 'create_task', description: TOOL_DESCRIPTIONS.create_task, inputSchema: CreateTaskSchema, executionMode: 'registry', safeMode: 'block', handler: handleCreateTask },
  // Tweaks tools (registry — grouped ctx.tweaks callbacks)
  { name: 'list_tweaks', description: TOOL_DESCRIPTIONS.list_tweaks, inputSchema: ListTweaksSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListTweaks },
  { name: 'get_tweak', description: TOOL_DESCRIPTIONS.get_tweak, inputSchema: GetTweakSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleGetTweak },
  { name: 'create_tweak', description: TOOL_DESCRIPTIONS.create_tweak, inputSchema: CreateTweakSchema, executionMode: 'registry', safeMode: 'block', handler: handleCreateTweak },
  { name: 'update_tweak', description: TOOL_DESCRIPTIONS.update_tweak, inputSchema: UpdateTweakSchema, executionMode: 'registry', safeMode: 'block', handler: handleUpdateTweak },
  { name: 'delete_tweak', description: TOOL_DESCRIPTIONS.delete_tweak, inputSchema: DeleteTweakSchema, executionMode: 'registry', safeMode: 'block', handler: handleDeleteTweak },
  { name: 'get_session_info', description: TOOL_DESCRIPTIONS.get_session_info, inputSchema: GetSessionInfoSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleGetSessionInfo },
  { name: 'list_sessions', description: TOOL_DESCRIPTIONS.list_sessions, inputSchema: ListSessionsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListSessions },
  { name: 'list_background_tasks', description: TOOL_DESCRIPTIONS.list_background_tasks, inputSchema: ListBackgroundTasksSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListBackgroundTasks },
  // Inter-session messaging
  { name: 'send_agent_message', description: TOOL_DESCRIPTIONS.send_agent_message, inputSchema: SendAgentMessageSchema, executionMode: 'registry', safeMode: 'block', handler: handleSendAgentMessage },
];

export interface SessionToolFilterOptions {
  /** Include the experimental send_developer_feedback tool. */
  includeDeveloperFeedback?: boolean;
  /**
   * Include the `decide` tool (decision layer). Defaults to FALSE: the tool is
   * only offered when the user enabled the decision model, so a caller that
   * forgets the option hides it instead of advertising a tool that cannot run.
   */
  includeDecide?: boolean;
  /**
   * Whether this conversation is bound to a project.
   *
   * `false` hides the tools whose work belongs to a project's own store — cuts — so a conversation
   * without one is never invited to call them. `undefined` keeps them for callers that do not know
   * the binding (tests, hosts). Media generation is not here: a file and its source note are
   * meaningful wherever the conversation lives.
   */
  hasProject?: boolean;
  /**
   * Whether this hub has any paired device (online or offline).
   *
   * `false` hides `device_tool`: a hub that has never paired a machine pays for its brief and
   * schema on every request for a door that can only report "no devices". `undefined` keeps it for
   * callers that do not know the pairing state (tests, hosts).
   */
  hasDevices?: boolean;
}

/** Tools whose output is project-scoped; they are not offered without a project. */
const PROJECT_SCOPED_TOOL_NAMES = new Set(['reel_tool']);

/**
 * Return session tools with optional feature filtering.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across the Claude and Pi backends.
 */
export function getSessionToolDefs(options?: SessionToolFilterOptions): SessionToolDef[] {
  const includeDeveloperFeedback = options?.includeDeveloperFeedback ?? true;
  const includeDecide = options?.includeDecide ?? false;
  const hasProject = options?.hasProject !== false;
  return SESSION_TOOL_DEFS.filter(def => {
    if (!includeDeveloperFeedback && def.name === 'send_developer_feedback') {
      return false;
    }
    if (!includeDecide && def.name === 'decide') {
      return false;
    }
    if (!hasProject && PROJECT_SCOPED_TOOL_NAMES.has(def.name)) {
      return false;
    }
    if (options?.hasDevices === false && def.name === 'device_tool') {
      return false;
    }
    return true;
  });
}

/**
 * Build a name->definition registry with optional feature filtering.
 */
export function getSessionToolRegistry(options?: SessionToolFilterOptions): Map<string, SessionToolDef> {
  return new Map(getSessionToolDefs(options).map(def => [def.name, def]));
}

/**
 * Return session tool names with optional feature filtering.
 */
export function getSessionToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).map(def => def.name));
}

/**
 * Return backend-executed tool names with optional feature filtering.
 */
export function getSessionBackendToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'backend').map(d => d.name));
}

/**
 * Return registry-executed tool names with optional feature filtering.
 */
export function getSessionRegistryToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'registry').map(d => d.name));
}

export interface SessionToolNameOptions extends SessionToolFilterOptions {
  /** Optional name prefix for consumers (e.g. 'mcp__session__'). */
  prefix?: string;
}

/**
 * Return session tool names that are allowed in Explore/Safe mode.
 */
export function getSessionSafeAllowedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'allow')
      .map(def => `${prefix}${def.name}`)
  );
}

/**
 * Return session tool names that are blocked in Explore/Safe mode.
 */
export function getSessionSafeBlockedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'block')
      .map(def => `${prefix}${def.name}`)
  );
}

// ============================================================
// Derived Lookups
// ============================================================

/** Set of session tool names for quick membership checks. */
export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(d => d.name));

/** Session tool names that must be handled by backend-specific adapters (Pi/Claude). */
export const SESSION_BACKEND_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'backend').map(d => d.name)
);

/** Session tool names that are always executable from the canonical registry. */
export const SESSION_REGISTRY_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'registry').map(d => d.name)
);

/** Session tool names allowed in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_ALLOWED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'allow').map(d => d.name)
);

/** Session tool names blocked in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_BLOCKED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'block').map(d => d.name)
);

/** Map from tool name → definition for O(1) lookup. */
export const SESSION_TOOL_REGISTRY = new Map(SESSION_TOOL_DEFS.map(d => [d.name, d]));

// ============================================================
// JSON Schema Converter (for MCP / Pi consumers)
// ============================================================

export interface JsonSchemaToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Convert session tool definitions to JSON Schema format.
 *
 * @param opts.prefix - Optional prefix for tool names (e.g., 'mcp__session__' for Pi)
 * @param opts.includeDeveloperFeedback - Include experimental feedback tool in output
 * @param opts.includeDecide - Include the decision-layer `decide` tool (default false)
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(opts?: {
  prefix?: string;
  includeDeveloperFeedback?: boolean;
  includeDecide?: boolean;
  /** False hides project-scoped tools; see `SessionToolFilterOptions`. */
  hasProject?: boolean;
  /** False hides `device_tool`; see `SessionToolFilterOptions`. */
  hasDevices?: boolean;
}): JsonSchemaToolDef[] {
  const prefix = opts?.prefix || '';
  const defs = getSessionToolDefs({
    includeDeveloperFeedback: opts?.includeDeveloperFeedback,
    includeDecide: opts?.includeDecide,
    hasProject: opts?.hasProject,
    hasDevices: opts?.hasDevices,
  });

  return defs.map(def => {
    // Explicit `as any` avoids TS2589 ("type instantiation is excessively deep")
    // caused by zodToJsonSchema inferring deep generic chains from union schemas.
    const jsonSchema = zodToJsonSchema(def.inputSchema as any, { $refStrategy: 'none' }) as Record<string, unknown>;
    // Strip metadata not needed by MCP/Pi consumers
    delete jsonSchema.$schema;
    delete jsonSchema.additionalProperties;
    return {
      name: prefix + def.name,
      description: def.description,
      inputSchema: jsonSchema,
    };
  });
}
