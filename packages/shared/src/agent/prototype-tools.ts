import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { requireBrowserPaneFns, type BrowserPaneToolOptions } from './browser-pane.ts';
import { executePrototypeToolCommand } from './prototype-commands.ts';

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

/**
 * `prototype_tool` — the prototype workbench's own commands.
 *
 * The description is written around the two things these commands work through, because those
 * are what a session has to understand before any of them means anything: **the files** (a
 * prototype is a folder, and the folder is the work) and **the window** (where the flow is looked
 * at). The browser's own primitives — refs, snapshots, `evaluate`, console, network — are not
 * here; they belong to `browser_tool`, and this tool only ever drives the window as a flow.
 */
const PROTOTYPE_TOOL_DESCRIPTION = `Run a prototype's own commands (one command per call — string or array input, no batching).

A prototype is a **folder** plus a **flow of pages**. The folder holds the work; the flow is looked at
in the workspace's browser window. Each page is one of two kinds, fixed when the page is added:
- **scratch** — a page of ours: \`<name>.html\` in that folder. The change *is* an edit to that file, and
  the file *is* the page (writing it is what makes one; the table only orders it).
- **overlay** — a live page someone else owns, patched in place. It is never copied or frozen: it *is*
  that address, with its own JavaScript, its own session and its own data, so study it with
  \`browser_tool\` before writing selectors.
One flow may mix both.

A prototype is **not a project**: projects are separate containers that group sessions, tasks and
shared assets, and a prototype is never nested inside one.

**The files** are the prototype, and they are yours to organize — \`{workspace}/prototypes/{slug}/\`:
- \`PRD.md\` — the brief: one \`## R-001 …\` entry per requirement, and the **only** file requirements are
  read from. What sits beside it is material in any format (personas, the flow as it stands today, a
  glossary, a screenshot of the old screen), and your other pages (\`<name>.html\` is a page, and
  \`_layout.html\`, once you write one, is the layout they share).
- \`patches/\` — the change layer: \`{writer}-{nnn}-{name}.{css,js}\` applies to every page, \`patches/<page>/…\`
  to that page only. The writer segment is your identity, and a name the scanner cannot parse is **silently
  never replayed**.
- \`config.json\` — the page table: their order, which one the address root opens, and which pages stand on
  their own (\`"useLayout": false\` = the shared layout does not wrap that page). A \`config.json\` holding
  only \`pages\` is the normal shape; prototypes written before pages had kinds are read as this same table.
- \`services/{svc}/\` — the contract: \`paths/*.yaml\` fragments, \`fixtures/\`, \`state.json\`, and the composed
  \`openapi.yaml\`.
- \`research/\`, \`reviews/\` — what you learned and the argument against it. Neither ships.
- \`dist/\` — the deliverables.
Pages and patches are written with the Write/Edit tools: no command here writes them for you, and none of
them changes what the person sees until you say so.

**The window** is \`browser_tool\`'s: \`open\` adds a tab of its own — which is what lets two prototypes be
worked on at once instead of replacing each other — and \`apply\` replays the patches into the tab you are
on. Name a tab with \`--tab <id>\`; the window itself, its tabs and every page primitive are that tool's.

**A page's name is its identity on every surface**: \`--page <name>\` on the commands, \`/<name>\` on the
address, \`patches/<name>/\` for its own changes, and the \`page\` a \`snapshot\` reports. The page table gives
their order and which page the address root opens: \`entry <name>\` marks one, \`entry none\`
goes back to the generated **index** that lists every page — reachable at \`/_index\` whatever the root opens.
Export gives a loadable Chrome extension (it ships our documents, applies the patches to the live pages, and
lists every page in its options page) plus a spec a developer translates onto them.
Prototypes are independent — each keeps its own patches, and studying one while building another never
merges or copies the two: what a prototype is built with in view is written down in its own folder, beside
\`PRD.md\`, which is also where a stand-in's address or a screenshot's path belongs.

Read \`docs/prototypes.md\` before your first prototype command: it is the whole guide, and what is above is
the short version of it. Run \`--help\` for the commands, their flags and examples.

Examples:
- \`list\` — every prototype with its pages
- \`create Landing page\` — a container for pages. It starts with none: write \`cart.html\` (or add a live page) and that is the first page
- \`create Rival checkout --no-bind\` — create one *without* stealing this session's binding (the one to use when you only mean to study it)
- \`pages\` — the flow's pages, in order, each with its kind. \`--add payment=https://app.example.com/pay\` adds a live page, \`--add cart\` places an existing document, plus \`--rename\` and \`--remove\`
- \`entry cart\` — make \`cart\` the page the address root opens; \`entry none\` goes back to the generated index
- \`pages --change pay=https://staging.example.com/pay\` — point one live page at the same page in another environment, and say what goes stale with it: windows already open keep the old page, and the patches were written against the old DOM. A page of ours is refused — its document *is* the page, so an address for it means nothing
- \`open\` — open the prototype in a tab of its own (its entry page, or the generated index when there is none)
- \`open --page cart\` — open one page of it
- \`apply\` — replay the prototype's patches into the page you are on (they survive a reload). Reports each declared \`@target\`: one that matched nothing is named, and one that used to match and does not means the page moved
- \`apply --file prototypes/cart/patches/ui-002-total.js\` — put one patch on the page, the one just written. The patches already registered stay registered; a page of ours already carries it, so the answer is that the change shows on reload
- \`apply checkout-flow\` — same, for an explicitly named prototype
- \`clear\` — remove those patches from the page
- \`verify\` — answer the checks the brief declares (\`check: selector [data-total]\`, \`check: endpoint GET /api/cart\`) and write \`dist/acceptance.md\`. Page checks need a page open; without one they are reported as skipped, not failed. It says which round this is and what *moved* since the round before (newly red / still red / fixed), so "this change broke it" can be told from "it was already broken", and it hands over the \`about:\` line for each failure
- \`sample-video ~/Desktop/demo.mp4\` — frames out of a recording you made elsewhere: it is copied into \`research/videos/\` and sampled every 2 s (\`--every 500ms\`, \`--changes\` for only what moved, \`--max 40\`). Chromium does the decoding, so a codec it cannot read fails loudly instead of quietly. \`--slug <slug>\` aims it at a prototype other than the bound one. The frames come back in the reply as well as going to disk
- \`export\` — build the deliverables (a loadable extension + dist/static/ pages of ours as single files) + dist/dev-spec.md. It names anything still outstanding (a requirement nothing implements, a dispute nobody answered, a check that failed, a response the contract declares but nobody wrote) and \`export --strict\` refuses to build while there is any — use that when nobody is reading the output
- \`status\` — inspect pages, patches, services, exports, the disputes that still stand, and the last acceptance round
- \`contract-compose\` — fragments → services/<svc>/openapi.yaml
- \`contract-export\` — dist/openapi.yaml + dist/contract.md + fixtures
- \`mock-apply\` — serve the contract's x-mock responses on the tab you are on (it replaces the program that was there)
- \`mock-clear\` — take that program back off the tab

Which prototype a command means is read from the page this session is on, when it is on one — your own tab
first, then the one in front — and only then this session's binding. A command that takes no slug therefore
still works with no window open, as long as this conversation is bound; with neither, name one (and
\`sample-video\`, whose positional is a path, takes \`--slug\`). Binding is the person's: they set it in the
app, or a \`create\` binds what it made. Only \`open\`, \`apply\`, \`clear\`, \`record\` and the mocks need a tab
to act on — the rest work on files alone.`;

/**
 * `prototype_tool` — the same command table as `browser_tool`, reached through the other door.
 *
 * It takes the same `fns` because the two are one runtime: prototype commands drive the same
 * window (`open`, `apply`, `mock-apply`) and read the same main-process
 * capability surface. What is separate is the **subject** — and with it the description, the help,
 * and the guide a session is asked to read first.
 */
export function createPrototypeTools(options: BrowserPaneToolOptions) {
  return [
    tool(
      'prototype_tool',
      PROTOTYPE_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Prototype command as a string (e.g., "list") or array (e.g., ["apply", "--file", "prototypes/cart/patches/ui-002-total.js"]). One command per call — batches are not supported here.'),
      },
      async (args) => {
        try {
          const result = await executePrototypeToolCommand({
            command: args.command,
            fns: requireBrowserPaneFns(options),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          // The pictures go into the reply as well as the text: a screenshot is one, a recording
          // is a session of them, and a frame capture exists because a model can read a frame
          // (plan §20.3) — the files are the record, this is the reading.
          const images = [...(result.image ? [result.image] : []), ...(result.images ?? [])];
          if (images.length > 0) {
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
          }

          return successResponse(result.output);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
