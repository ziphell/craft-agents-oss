/**
 * Browser Tools (`browser_tool`)
 *
 * Session-scoped tooling that enables the agent to interact with built-in
 * in-app browser windows via a single CLI-like command wrapper.
 * Commands delegate to BrowserPaneFns callbacks wired by Electron's
 * SessionManager to BrowserPaneManager.
 *
 * The session → browser instance mapping is handled by the callback provider
 * (getOrCreateForSession pattern), so commands don't need instance IDs.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { requireBrowserPaneFns, type BrowserPaneToolOptions } from './browser-pane.ts';
import { executeBrowserToolCommand } from './browser-commands.ts';

// Tool result type - matches MCP CallToolResult content blocks
type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
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

const BROWSER_RELEASE_HINT = '\n\nWhen you are done using the browser, call browser_tool with command "close" to close the window entirely, or "release" to dismiss the overlay and let the user continue browsing.';

// ============================================================================
// Tool Descriptions
// ============================================================================

const BROWSER_TOOL_DESCRIPTION = `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward, reload) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

\`evaluate --file <path>\` runs a script that is kept in a file instead of in the command (a relative path
counts from the workspace root): write it once — with the Write tool, or as the patch you already wrote —
and name it here, so the same code is never spelled out a second time in a command. Use it for anything
longer than a one-line probe. What it runs is **not registered**, so a reload drops it: a change that has to
survive one is a patch file under \`patches/\`, applied by \`prototype_tool apply\`.

Prototypes are a **separate tool**: \`prototype_tool\` — a prototype's own files (its pages, its patches, its
brief, its contract and its deliverables) and the flow they describe. It drives this same window, and
\`prototype_tool open\` adds a tab to it. Both tools take bare command names, so \`browser_tool open\` and
\`prototype_tool open\` are different commands.
Detailed rules and the full command reference: docs/browser-tools.md for this tool, and docs/prototypes.md
for \`prototype_tool\` — read the one you are about to use first.

The window is one and its tabs are many: every command can name the tab it acts on with \`--tab <id>\`
(\`tabs\` lists them). Without one it acts on **your** tab — the tab you have been working from, which
\`tabs\` marks as \`your tab\` — and only on the tab on screen when you have none yet; the person
switching tabs does not move your commands. A session spawned by another one is the exception: it works
in the tab it was given (\`tab-assign\`) or opens one with \`tab-new\`, and never takes over the tab on
screen. \`prototype_tool open\` always opens a tab of its own, which is what lets two prototypes be worked
on at once rather than replacing each other.

There is **one browser window per workspace**, shared by every conversation in it and by the user — so \`open\`
adds a tab to it instead of making a window, and the window is not yours to close: use \`tab-close <id>\` for
the tabs of your task (the ones you opened, the ones handed to you, and the tabs opened from them — a Task's
node tabs included, so a finished DAG can be tidied up), or \`release\` to drop your overlay. \`tabs\` says
what each tab is, whose work it is in and who is working on it — another conversation's tab is refused,
prototype or not, and \`tab-assign <tab-id> <session>\` is how a parent hands a tab to a session it spawned,
so that parallel sessions each work in their own tab. A tab's work outlives the session that opened it: a
Task node's tab belongs to that node, so a re-run of a node finds its predecessor's tab in \`tabs\` — read it
before opening one, because \`tab-new\` always adds a tab. There is no window list to read, because there is
one window. Which prototype a command means is read from the tab it acts on — your own tab first, then the
one in front of you — so several prototypes can be driven from one conversation without binding any of them.

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
- \`reload\` — reload this page. A page of ours is rendered from disk, so an edit to it or to a patch it carries shows up on the next render; nothing waits for the load, so \`wait network-idle\` before reading it, and re-\`snapshot\` (every ref is stale)
- \`evaluate document.title\`
- \`evaluate --file prototypes/cart/patches/ui-002-total.js\` — a script kept in a file
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
- \`window-resize 1440 900\`
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`
- \`focus [windowId]\` — focus a browser window (no new window)
- \`release [windowId|all]\` — dismiss the agent control overlay when done
- \`close [windowId]\` — close a window of your own; the shared window is refused
- \`hide [windowId]\` — hide the window while preserving state`;

// ============================================================================
// Tool Factories
// ============================================================================

export function createBrowserTools(options: BrowserPaneToolOptions) {
  return [
    // Single CLI-like tool for all browser actions
    tool(
      'browser_tool',
      BROWSER_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
      },
      async (args) => {
        try {
          const result = await executeBrowserToolCommand({
            command: args.command,
            fns: requireBrowserPaneFns(options),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          const text = result.appendReleaseHint
            ? result.output + BROWSER_RELEASE_HINT
            : result.output;

          if (result.image) {
            return {
              content: [
                { type: 'text' as const, text },
                { type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType },
              ],
            };
          }

          return successResponse(text);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
