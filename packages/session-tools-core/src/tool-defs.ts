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

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionToolContext } from './context.ts';
import type { ToolResult } from './types.ts';

// Handlers
import { handleSubmitPlan } from './handlers/submit-plan.ts';
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
  model: z.string().optional().describe('Model ID or short name. Defaults to a fast model.'),
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

// Video tool schema — the same CLI-like shape, one command per call (no batching).
export const VideoToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Video command as a string (e.g., "sample demo.mp4") or array (e.g., ["sample", "demo.mp4", "--out", "frames"]). One command per call — batches are not supported here.'),
});

// Drawio tool schema — the same CLI-like shape, one command per call (no batching).
export const DrawioToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Drawio command as a string (e.g., "export flow.drawio --to flow.png --format png") or array (e.g., ["export", "flow.drawio", "--to", "flow.png", "--format", "png"]). One command per call — batches are not supported here.'),
});

export const SpawnSessionSchema = z.object({
  help: z.boolean().optional().describe('If true, returns available connections, models, and sources instead of creating a session'),
  prompt: z.string().optional().describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional().describe('Session name'),
  llmConnection: z.string().optional().describe('Connection slug (e.g., "anthropic-api", "codex")'),
  model: z.string().optional().describe('Model ID override'),
  enabledSourceSlugs: z.array(z.string()).optional().describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional().describe('Permission mode for the new session'),
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

  browser_tool: `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward, reload) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

\`evaluate --file <path>\` runs a script that is kept in a file instead of in the command (a relative path
counts from the workspace root): write it once with the Write tool and name it here, so the same code is
never spelled out a second time in a command. Use it for anything longer than a one-line probe. What it
runs is **not registered**, so a reload drops it.
Detailed rules and the full command reference: docs/browser-tools.md — read it before using this tool.

The window is one and its tabs are many: every command can name the tab it acts on with \`--tab <id>\`
(\`tabs\` lists them). Without one it acts on **your** tab — the tab you have been working from, which
\`tabs\` marks as \`your tab\` — and only on the tab on screen when you have none yet; the person
switching tabs does not move your commands. A session spawned by another one is the exception: it works
in the tab it was given (\`tab-assign\`) or opens one with \`tab-new\`, and never takes over the tab on
screen.

There is **one browser window per workspace**, shared by every conversation in it and by the user — so \`open\`
adds a tab to it instead of making a window, and the window is not yours to close: use \`tab-close <id>\` for
the tabs of your task (the ones you opened, the ones handed to you, and the tabs opened from them — a Task's
node tabs included, so a finished DAG can be tidied up), or \`release\` to drop your overlay. \`tabs\` says
what each tab is, whose work it is in and who is working on it — another conversation's **work** is refused
(a tab the person opened is nobody's work, and another conversation working from it does not
change that), and \`tab-assign <tab-id> <session>\` is how a parent hands a tab to a session it spawned,
so that parallel sessions each work in their own tab. A tab's work outlives the session that opened it: a
Task node's tab belongs to that node, so a re-run of a node finds its predecessor's tab in \`tabs\` — read it
before opening one, because \`tab-new\` always adds a tab. There is no window list to read, because there is
one window.

Examples:
- \`--help\`
- \`open\`
- \`navigate https://example.com\`
- \`snapshot\`
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
- \`snapshot --tab tab-3\` — act on a named tab (the window shows it while the command runs)
- \`tab-new https://example.com\` — add a tab to the window
- \`tab-assign tab-3 260915-brave-fox\` — hand a tab to a session you spawned
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
- \`focus [windowId]\` — focus a browser window (no new window)
- \`release [windowId|all]\` — dismiss the agent control overlay when done
- \`close [windowId]\` — close a window of your own; the shared window is refused
- \`hide [windowId]\` — hide the window while preserving state

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

The file is a video, and reading it is \`video_tool\` (\`understand\` asks a question about it,
\`sample\` pulls frames out). Recording first and working out what to ask afterwards is the normal
order.

Examples:
- \`record-start --tab tab-3 --ttl 30s\`
- \`record-start --tab tab-3 --ttl 1m --wait\`
- \`record-stop --tab tab-3\``,

  video_tool: `Read a recording — by asking a model about it, or by looking at its frames yourself
(one command per call — string or array input, no batching).

\`understand <path> --prompt <question>\` decodes the recording into frames, sends them to a model
together with the moment each one was taken from, and answers with what the model said. You get the
reading, not the pictures — use it to find out what happened, in what order, and when. \`--changes\`
keeps only the frames that moved, \`--every <dur>\` sets their spacing, \`--max <n>\` is the ceiling on
how many are sent (the one knob that bounds a model's bill), and \`--model <id>\` picks the model.

\`sample <path>\` is the same frames without the model, handed back to you as images — for when you
would rather look at them yourself. \`--out <dir>\` writes them as \`frame-0001.jpg\`,
\`frame-0002.jpg\`, … and names them; without it they exist only in the reply.

The decoding is Chromium's — the browser the app already ships, in a hidden window of its own — so
there is no ffmpeg to install. mp4 (H.264), webm and most mov files read; HEVC reads only where the
machine has a hardware decoder for it, and ProRes not at all. A recording that cannot be read is
refused by name instead of half-read. A relative \`<path>\` or \`<dir>\`
counts from the workspace root. \`understand\` needs a model configured for this conversation; when
there is none it says so, and \`sample\` still works.

Examples:
- \`--help\`
- \`understand demo.mp4 --prompt "what did the user do, and when?"\`
- \`understand demo.mp4 --prompt "did the total change?" --changes --max 20\`
- \`sample demo.mp4 --out research/demo --every 500ms\``,

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
from the workspace root.

Read \`docs/drawio-tools.md\` before your first drawio command: it is the whole guide — the file
format and the rules that fail silently, where the shapes come from, and how a diagram takes part in
a spec.

Examples:
- \`--help\`
- \`export flows/checkout.drawio --to out/checkout.svg\`
- \`export flows/checkout.drawio --to out/checkout.png --format png --scale 2\`
- \`render flows/checkout.drawio\``,

  call_llm: `Invoke a secondary LLM for focused subtasks. Use for:
- Cost optimization: use a smaller model for simple tasks (summarization, classification)
- Structured output: JSON schema compliance via prompt instructions
- Parallel processing: call multiple times in one message - all run simultaneously
- Context isolation: process content without polluting main context

Put text/content directly in the 'prompt' parameter. Do NOT pass inline text via attachments.
Only use 'attachments' for existing file paths on disk - the tool loads file content automatically.
For large files (>2000 lines), use {path, startLine, endLine} to select a portion.`,

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
  { name: 'spawn_session', description: TOOL_DESCRIPTIONS.spawn_session, inputSchema: SpawnSessionSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  { name: 'browser_tool', description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Video tool (backend-specific — the same pane runtime, decoding a recording in a hidden window)
  { name: 'video_tool', description: TOOL_DESCRIPTIONS.video_tool, inputSchema: VideoToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  { name: 'drawio_tool', description: TOOL_DESCRIPTIONS.drawio_tool, inputSchema: DrawioToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
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
}

/**
 * Return session tools with optional feature filtering.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across the Claude and Pi backends.
 */
export function getSessionToolDefs(options?: SessionToolFilterOptions): SessionToolDef[] {
  const includeDeveloperFeedback = options?.includeDeveloperFeedback ?? true;

  return SESSION_TOOL_DEFS.filter(def => {
    if (!includeDeveloperFeedback && def.name === 'send_developer_feedback') {
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
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(opts?: {
  prefix?: string;
  includeDeveloperFeedback?: boolean;
}): JsonSchemaToolDef[] {
  const prefix = opts?.prefix || '';
  const defs = getSessionToolDefs({
    includeDeveloperFeedback: opts?.includeDeveloperFeedback,
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
