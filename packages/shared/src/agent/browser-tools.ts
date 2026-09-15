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
import type { PickedElement } from '../protocol/dto.ts';
import type { PrototypeEntry, PrototypeExportResult } from '../prototypes/export.ts';
import type { CreatedPrototype } from '../prototypes/create.ts';
import type { ImportedPrototype } from '../prototypes/import.ts';
import type { PrototypeKind, PrototypeConfig } from '../prototypes/config.ts';
import type { ContractExportResult } from '../prototypes/contract.ts';
import type { PrototypeStatus } from '../prototypes/status.ts';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';

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
// Browser Pane Function Interface
// ============================================================================

/**
 * Abstraction over BrowserPaneManager for use in session-scoped tools.
 * The Electron session manager creates this by binding to a specific session's
 * browser instance via getOrCreateForSession(sessionId).
 */
export interface BrowserScreenshotArgs {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
}

export interface BrowserConsoleArgs {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserScreenshotRegionArgs {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserWindowResizeArgs {
  width: number
  height: number
}

export interface BrowserNetworkArgs {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadsArgs {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserLifecycleActionResult {
  action: 'closed' | 'hidden' | 'released' | 'noop'
  requestedInstanceId?: string
  resolvedInstanceId?: string
  affectedIds: string[]
  reason?: string
}

export interface BrowserPaneFns {
  openPanel: (options?: { background?: boolean }) => Promise<{ instanceId: string }>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  snapshot: () => Promise<{ url: string; title: string; nodes: Array<{ ref: string; role: string; name: string; value?: string; description?: string; focused?: boolean; checked?: boolean; disabled?: boolean }> }>;
  click: (ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }) => Promise<void>;
  clickAt: (x: number, y: number) => Promise<void>;
  drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  fill: (ref: string, value: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  select: (ref: string, value: string) => Promise<void>;
  setClipboard: (text: string) => Promise<void>;
  getClipboard: () => Promise<string>;
  screenshot: (args?: BrowserScreenshotArgs) => Promise<BrowserScreenshotResult>;
  screenshotRegion: (args: BrowserScreenshotRegionArgs) => Promise<BrowserScreenshotResult>;
  getConsoleLogs: (args?: BrowserConsoleArgs) => Promise<Array<{ timestamp: number; level: 'log' | 'info' | 'warn' | 'error'; message: string }>>;
  windowResize: (args: BrowserWindowResizeArgs) => Promise<{ width: number; height: number }>;
  getNetworkLogs: (args?: BrowserNetworkArgs) => Promise<Array<{ timestamp: number; method: string; url: string; status: number; resourceType: string; ok: boolean }>>;
  waitFor: (args: BrowserWaitArgs) => Promise<{ ok: true; kind: string; elapsedMs: number; detail: string }>;
  sendKey: (args: BrowserKeyArgs) => Promise<void>;
  getDownloads: (args?: BrowserDownloadsArgs) => Promise<Array<{ id: string; timestamp: number; url: string; filename: string; state: string; bytesReceived: number; totalBytes: number; mimeType: string; savePath?: string }>>;
  upload: (ref: string, filePaths: string[]) => Promise<void>;
  scroll: (direction: 'up' | 'down' | 'left' | 'right', amount?: number) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  /** Prompt the user to click an element; resolves null on cancel/timeout. */
  pick: (options?: { timeoutMs?: number }) => Promise<PickedElement | null>;
  /**
   * The prototype this session is bound to, or null when unbound.
   *
   * Every `prototype-*` command falls back to this when no slug is passed,
   * which is what lets a bound conversation be driven without naming artifacts.
   */
  getBoundPrototypeSlug?: () => string | null;
  /** Every prototype in the workspace, with its derived status. */
  listPrototypes: () => Promise<PrototypeStatus[]>;
  /** Create a prototype. `kind` defaults to `scratch`. */
  createPrototype: (input: {
    name: string;
    kind?: PrototypeKind;
    /** `overlay` only, and required for it: the page this prototype injects into. */
    targetUrl?: string;
  }) => Promise<CreatedPrototype>;
  /**
   * Point an overlay at a different page — the same page in another environment,
   * usually. Only the kind's own rules are enforced; whether the patches still fit
   * the new page is the caller's risk, and saying so is part of the command's
   * output (see target.ts).
   */
  setPrototypeTarget: (slug: string, targetUrl: string) => Promise<PrototypeConfig>;
  /** Bind (or unbind, with null) this session's prototype. */
  bindPrototype: (slug: string | null) => Promise<void>;
  /**
   * Declare that `slug` studies `referenceSlug` (plan §14). The two stay separate
   * prototypes, which is what keeps the reference's patches out of `slug`'s
   * deliverable — so this is the only supported way to connect them.
   */
  linkPrototypeReference: (slug: string, referenceSlug: string) => Promise<{ references: string[] }>;
  /** Drop the relation. Idempotent, and how a dangling reference is cleaned up. */
  unlinkPrototypeReference: (slug: string, referenceSlug: string) => Promise<{ references: string[] }>;
  /**
   * Replay a prototype's patches in this session's browser and register
   * them for future documents (so they survive a reload).
   *
   * Patches the page already carries — a page opened from the workbench arrives
   * with them inlined — are left alone and reported in `skipped`, so a JS patch
   * cannot run a second time over a document that already has its effect.
   */
  applyPrototype: (slug: string) => Promise<{ slug: string; applied: number; files: string[]; skipped: string[] }>;
  /** Remove a prototype's patches from this session's browser. */
  clearPrototype: (slug: string) => Promise<{ slug: string; removed: string[] }>;
  /**
   * Copy another prototype's page and patches in as this one's starting point.
   *
   * Material, not identity: the target keeps its own kind, its own target page
   * and its own references, and any patch file name it already has is left alone
   * (`skippedPatches`) rather than overwritten.
   */
  importPrototype: (slug: string, sourceSlug: string) => Promise<ImportedPrototype>;
  /**
   * Write a prototype's deliverables: a self-contained HTML plus a change spec.
   * Does not need a browser window — it is a pure file export.
   */
  exportPrototype: (slug: string) => Promise<PrototypeExportResult>;
  /**
   * Compose `services/{svc}/paths/*.yaml` fragments into `services/{svc}/openapi.yaml`.
   * `service` may be omitted when the prototype has exactly one service.
   */
  composeContract: (options: { slug: string; service?: string }) => Promise<{
    service: string;
    endpoints: number;
    conflicts: string[];
    missingFixtures: string[];
  }>;
  /** Write the backend deliverables (`dist/openapi.yaml` + `dist/contract.md` + fixtures). */
  exportContract: (options: { slug: string; service?: string }) => Promise<ContractExportResult>;
  /**
   * Serve the service's `x-mock` responses at the browser's network layer, so
   * the prototype runs before the backend exists.
   */
  applyMock: (options: { slug: string; service?: string }) => Promise<{
    service: string;
    routes: number;
    missingFixtures: string[];
    unmocked: string[];
  }>;
  /** Stop serving the mock; requests fall through to the real network. */
  clearMock: () => Promise<void>;
  /**
   * Inspect a prototype: patches, services, contract coverage, exports
   * and ownership violations. Pure file inspection — no browser needed.
   */
  prototypeStatus: (slug: string) => Promise<PrototypeStatus>;
  /**
   * Resolve which file to show for a prototype (the exported deliverable when it
   * exists, otherwise `base.html`) and return the URL to open it at.
   */
  prototypeEntry: (options: { slug: string }) => Promise<PrototypeEntry>;
  focusWindow: (instanceId?: string) => Promise<{ instanceId: string; title: string; url: string }>;
  releaseControl: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  closeWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  hideWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  listWindows: () => Promise<Array<{
    id: string;
    title: string;
    url: string;
    isVisible: boolean;
    ownerType: 'session' | 'manual';
    ownerSessionId: string | null;
    boundSessionId: string | null;
    agentControlActive?: boolean;
  }>>;
  detectChallenge: () => Promise<{ detected: boolean; provider: string; signals: string[] }>;
}

// ============================================================================
// Tool Factory Options
// ============================================================================

export interface BrowserToolsOptions {
  sessionId: string;
  /**
   * Lazy resolver for browser pane functions.
   * Called at execution time to get the current callback from the session registry.
   */
  getBrowserPaneFns: () => BrowserPaneFns | undefined;
}

// ============================================================================
// Tool Descriptions
// ============================================================================

const BROWSER_TOOL_DESCRIPTION = `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

Prototypes — one per requirement, each a folder with \`patches/\` and, for a from-scratch prototype, a
\`base.html\`. A prototype is NOT a project: projects are separate containers that group sessions, tasks
and shared assets, and a prototype is never nested inside one.
Two kinds, fixed when the prototype is created:
- **overlay** — patches injected on top of a page that belongs to someone else. That page is never
  copied or frozen: it *is* the live address, with its own JS and its own session, so study it with
  this tool (and have the user sign in here when it needs it) before writing selectors. Export gives
  two things: a spec a developer translates onto that page, and a preview carrier — a draggable
  bookmarklet (plus the same bundle for the console, since a page with a strict CSP refuses
  bookmarklets) so someone without this workbench can see it on the real page.
- **scratch** — \`base.html\` is ours, so there is no external page to keep in sync; export gives the
  page itself, self-contained.
Prototypes are independent — each keeps its own patches, and one can *reference* another without merging
them. Referencing is how you build one thing by studying another. \`prototype-list\` shows every
prototype with its kind, target page, and which ones reference which.

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
- \`evaluate document.title\`
- \`pick\` — ask the user to click an element; returns a stable selector + geometry
- \`prototype-list\` — every prototype with its kind, target page, and references (both directions)
- \`prototype-create Landing page\` — a from-scratch prototype that owns its own base.html (the default kind)
- \`prototype-create Checkout flow --url https://app.example.com/checkout\` — an overlay on a real page. The address is required: that page *is* this prototype's page, so there is nothing to fall back on without it
- \`prototype-create Rival checkout --url https://rival.example.com --no-bind\` — create one *without* stealing this session's binding (used to make a reference)
- \`prototype-target https://staging.example.com/checkout\` — point the bound overlay at the same page in another environment. Say what goes stale with it: windows already open keep the old page, and the patches were written against the old DOM
- \`prototype-reference rival-checkout\` — study another prototype from the bound one, whatever kind either is. Its patches were written against a different document: read them for intent, never copy them into the bound prototype's patches/ (they would ship silently inside its deliverable)
- \`prototype-bind checkout-flow\` — bind this session (or \`prototype-bind --clear\` to unbind)
- \`prototype-apply\` — replay the bound prototype's patches (survives reload)
- \`prototype-apply checkout-flow\` — same, for an explicitly named prototype
- \`prototype-clear\` — remove the bound prototype's patches
- \`prototype-export\` — write the HTML deliverable + dist/dev-spec.md
- \`prototype-contract-compose\` — fragments → services/<svc>/openapi.yaml
- \`prototype-contract-export\` — dist/openapi.yaml + dist/contract.md + fixtures
- \`prototype-mock-apply\` — serve the contract's x-mock responses
- \`prototype-mock-clear\` — stop serving the mock
- \`prototype-status\` — inspect patches, services, exports, ownership
- \`prototype-open\` — open the exported page (or base.html)
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
- \`focus [windowId]\` — focus existing browser window (no new window)
- \`windows\` — list current browser windows and ownership state
- \`release [windowId|all]\` — dismiss the agent control overlay when done
- \`close [windowId]\` — close and destroy the browser window
- \`hide [windowId]\` — hide the window while preserving state

The prototype-* commands default to the prototype this session is bound to, so a slug is
optional for all of them except list/create/bind.`;

// ============================================================================
// Tool Factories
// ============================================================================

export function createBrowserTools(options: BrowserToolsOptions) {
  function getBrowserFns(): BrowserPaneFns {
    const fns = options.getBrowserPaneFns();
    if (!fns) {
      throw new Error('Browser window controls are not available. This tool requires the desktop app.');
    }
    return fns;
  }

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
            fns: getBrowserFns(),
            sessionId: options.sessionId,
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
