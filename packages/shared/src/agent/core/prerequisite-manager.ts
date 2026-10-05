/**
 * PrerequisiteManager - Prerequisite Reading System
 *
 * Blocks tool calls until specified files have been read in the current context window.
 *
 * The set of reads is persisted per session and restored when a fresh agent instance picks the
 * session back up (an app restart): the conversation is resumed with its history intact, so the
 * guide's text is still in context and the gate has nothing left to ask for. It is cleared only
 * when the model really loses that text — on context compaction, and when the history is cleared.
 *
 * Key responsibilities:
 * - Track which files have been read via the Read tool
 * - Check prerequisites before tool execution (e.g., guide.md for sources)
 * - Reset state on context compaction
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { expandPath } from './path-processor.ts';
import { getBrowserToolEnabled } from '../../config/storage.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

// ============================================================
// Types
// ============================================================

export interface PrerequisiteRule {
  /** Match tool names that require prerequisites */
  toolMatcher: (toolName: string) => boolean;
  /** Resolve the required file path for a matched tool. Returns null to skip. */
  resolveRequiredPath: (toolName: string, workspaceRootPath: string) => string | null;
  /** Block message template. {filePath} is replaced with the required path. */
  blockMessage: string;
  /** If true, always block until file is read (no graceful fallback). */
  strict?: boolean;
}

export interface PrerequisiteCheckResult {
  allowed: boolean;
  blockReason?: string;
}

export interface PrerequisiteManagerConfig {
  workspaceRootPath: string;
  onDebug?: (message: string) => void;
  /**
   * File to persist the set of reads in, so a restarted agent picks the session back up without
   * re-asking for guides the conversation already holds. Omitted keeps the state in memory only.
   */
  readStatePath?: string;
}

// ============================================================
// Constants
// ============================================================

/** Slugs that are exempt from prerequisite checks (internal sources) */
const EXEMPT_SLUGS = new Set(['session']);

/** Global browser tools docs path required before browser tool usage. */
const BROWSER_TOOLS_DOC_PATH = resolve(join(CONFIG_DIR, 'docs', 'browser-tools.md'));

/** Global drawio docs path required before `drawio_tool` usage. */
const DRAWIO_TOOLS_DOC_PATH = resolve(join(CONFIG_DIR, 'docs', 'drawio-tools.md'));

// ============================================================
// Rules
// ============================================================

/**
 * Static prerequisite rules. Each rule defines:
 * - Which tools it applies to
 * - What file must be read first
 * - What message to show when blocking
 */
const RULES: PrerequisiteRule[] = [
  // MCP source tools: mcp__{slug}__* format
  {
    toolMatcher: (toolName: string) => {
      if (!toolName.startsWith('mcp__')) return false;
      const parts = toolName.split('__');
      if (parts.length < 3) return false;
      const slug = parts[1]!;
      return !EXEMPT_SLUGS.has(slug);
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const parts = toolName.split('__');
      const slug = parts[1]!;
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Please read the file at {filePath} first, then retry.',
  },

  // API source tools: api_{slug} format
  {
    toolMatcher: (toolName: string) => {
      return toolName.startsWith('api_');
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const slug = toolName.slice(4); // Remove 'api_' prefix
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Please read the file at {filePath} first, then retry.',
  },

  // Built-in browser tool: require browser-tools.md first.
  // Only matches the session-scoped tool (not external MCP browser tools like mcp__playwright__*),
  // and skipped entirely when the built-in browser tool is disabled.
  {
    toolMatcher: (toolName: string) =>
      getBrowserToolEnabled() &&
      (toolName === 'browser_tool' || toolName === 'mcp__session__browser_tool'),
    resolveRequiredPath: () => {
      return existsSync(BROWSER_TOOLS_DOC_PATH) ? BROWSER_TOOLS_DOC_PATH : null;
    },
    blockMessage:
      'You must read the browser tools guide before using browser automation. Please read the file at {filePath} first, then retry.',
    strict: true,
  },

  // Built-in drawio tool: require drawio-tools.md first.
  //
  // What is behind the gate is a file format whose failures are silent — a compressed `.drawio`
  // is unreadable to everything but draw.io, a shape outside the bundled sets draws as a plain
  // box, and neither says anything at the time. Reading the guide is the difference between
  // a diagram that is right and one that merely looks plausible, so this is strict, like the
  // browser's: the guide is not a suggestion.
  {
    toolMatcher: (toolName: string) =>
      toolName === 'drawio_tool' || toolName === 'mcp__session__drawio_tool',
    resolveRequiredPath: () => {
      return existsSync(DRAWIO_TOOLS_DOC_PATH) ? DRAWIO_TOOLS_DOC_PATH : null;
    },
    blockMessage:
      'You must read the drawio guide before using drawio_tool. Please read the file at {filePath} first, then retry.',
    strict: true,
  },
];

// ============================================================
// PrerequisiteManager
// ============================================================

export class PrerequisiteManager {
  /** Max times to block a tool for the same prerequisite before allowing through */
  private static readonly MAX_REJECTIONS = 1;

  private readFiles: Set<string> = new Set();
  private rejectionCounts: Map<string, number> = new Map();
  private pendingSkillPaths: Set<string> = new Set();
  private workspaceRootPath: string;
  private readStatePath?: string;
  private onDebug?: (message: string) => void;

  constructor(config: PrerequisiteManagerConfig) {
    this.workspaceRootPath = config.workspaceRootPath;
    this.readStatePath = config.readStatePath;
    this.onDebug = config.onDebug;
    this.loadReadState();
  }

  /**
   * Restore the reads an earlier agent instance recorded for this session. A missing or unreadable
   * file is not an error: it just means the session has not been through here before, and the
   * guides will be asked for again.
   */
  private loadReadState(): void {
    if (!this.readStatePath) return;
    try {
      if (!existsSync(this.readStatePath)) return;
      const raw = JSON.parse(readFileSync(this.readStatePath, 'utf-8')) as { reads?: unknown };
      if (!Array.isArray(raw.reads)) return;
      for (const path of raw.reads) {
        if (typeof path === 'string' && path.length > 0) this.readFiles.add(path);
      }
      this.onDebug?.(`Prerequisite: restored ${this.readFiles.size} read(s) from session state`);
    } catch (error) {
      this.onDebug?.(`Prerequisite: could not restore read state — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Write the current reads out so the next agent instance for this session starts where this one left off. */
  private persistReadState(): void {
    if (!this.readStatePath) return;
    try {
      // A session with no folder of its own is a temporary agent (title, summary), not a conversation
      // whose memory is worth keeping — and writing would put a stray session folder on disk.
      if (!existsSync(dirname(this.readStatePath))) return;
      writeFileSync(this.readStatePath, JSON.stringify({ reads: [...this.readFiles] }), 'utf-8');
    } catch (error) {
      this.onDebug?.(`Prerequisite: could not persist read state — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Register skill SKILL.md paths as prerequisites.
   * All tool calls (except Read targeting these paths) are blocked
   * until the files have been read.
   */
  registerSkillPrerequisites(paths: string[]): void {
    for (const path of paths) {
      const expanded = expandPath(path);
      this.pendingSkillPaths.add(expanded);
      this.onDebug?.(`Prerequisite: registered skill prerequisite ${expanded}`);
    }
  }

  /**
   * Check if a tool call's prerequisites are met.
   * Iterates rules, checks if required files have been read.
   * After MAX_REJECTIONS blocks for the same path, allows through gracefully.
   */
  checkPrerequisites(toolName: string): PrerequisiteCheckResult {
    // Check dynamic skill prerequisites first
    const skillResult = this.checkSkillPrerequisites(toolName);
    if (!skillResult.allowed) return skillResult;

    for (const rule of RULES) {
      if (!rule.toolMatcher(toolName)) continue;

      const requiredPath = rule.resolveRequiredPath(toolName, this.workspaceRootPath);
      if (!requiredPath) continue; // No guide.md exists, skip

      if (!this.readFiles.has(requiredPath)) {
        const count = (this.rejectionCounts.get(requiredPath) ?? 0) + 1;
        this.rejectionCounts.set(requiredPath, count);

        const blockReason = rule.blockMessage.replace('{filePath}', requiredPath);

        if (rule.strict) {
          this.onDebug?.(`Prerequisite blocked (strict): ${toolName} requires ${requiredPath}`);
          return { allowed: false, blockReason };
        }

        if (count <= PrerequisiteManager.MAX_REJECTIONS) {
          this.onDebug?.(`Prerequisite blocked (${count}/${PrerequisiteManager.MAX_REJECTIONS}): ${toolName} requires ${requiredPath}`);
          return { allowed: false, blockReason };
        }
        // Exceeded max rejections — allow through gracefully
        this.onDebug?.(`Prerequisite: allowing ${toolName} after ${count} rejections (max reached)`);
      }
    }

    return { allowed: true };
  }

  /**
   * Check dynamic skill prerequisites.
   * If pending skill paths exist and the tool is NOT a Read targeting one of them, block.
   */
  private checkSkillPrerequisites(toolName: string): PrerequisiteCheckResult {
    if (this.pendingSkillPaths.size === 0) return { allowed: true };

    // Allow Read tool through — trackReadTool will clear the prerequisite
    if (toolName === 'Read') return { allowed: true };

    const pendingList = [...this.pendingSkillPaths].join(', ');
    const key = `skill:${pendingList}`;
    const count = (this.rejectionCounts.get(key) ?? 0) + 1;
    this.rejectionCounts.set(key, count);

    if (count <= PrerequisiteManager.MAX_REJECTIONS) {
      const blockReason = `You must read the skill instruction files before proceeding. Use Read or \`cat\` via Bash to read: ${pendingList}`;
      this.onDebug?.(`Skill prerequisite blocked (${count}/${PrerequisiteManager.MAX_REJECTIONS}): ${toolName} — pending: ${pendingList}`);
      return { allowed: false, blockReason };
    }

    // Exceeded max rejections — allow through and clear
    this.onDebug?.(`Skill prerequisite: allowing ${toolName} after ${count} rejections (max reached)`);
    this.pendingSkillPaths.clear();
    return { allowed: true };
  }

  /**
   * Track a Read tool call. Extracts file_path from tool input,
   * normalizes it, and adds to the read set.
   * Also clears matching pending skill paths.
   */
  trackReadTool(toolInput: Record<string, unknown>): void {
    const filePath = (toolInput.file_path as string) || (toolInput.path as string);
    if (!filePath) return;

    const expanded = expandPath(filePath);
    const isNew = !this.readFiles.has(expanded);
    this.readFiles.add(expanded);

    // Clear matching pending skill path
    if (this.pendingSkillPaths.has(expanded)) {
      this.pendingSkillPaths.delete(expanded);
      this.onDebug?.(`Prerequisite: cleared skill prerequisite ${expanded}`);
    }

    if (isNew) this.persistReadState();
    this.onDebug?.(`Prerequisite: tracked read of ${expanded}`);
  }

  /**
   * Check if a Bash command is reading a pending skill file.
   * If it matches, clear the prerequisite and return true.
   * Called from the pre-tool-use pipeline to allow targeted Bash reads through.
   */
  trackBashSkillRead(input: Record<string, unknown>): boolean {
    const command = input.command as string;
    if (!command || this.pendingSkillPaths.size === 0) return false;

    let matched = false;
    for (const path of this.pendingSkillPaths) {
      if (command.includes(path)) {
        this.pendingSkillPaths.delete(path);
        this.readFiles.add(path);
        this.persistReadState();
        this.onDebug?.(`Prerequisite: cleared skill prerequisite via Bash: ${path}`);
        matched = true;
      }
    }
    return matched;
  }

  /**
   * Reset read state. Called on context compaction since the LLM
   * loses the guide content and needs to re-read.
   * Also clears pending skill paths (model lost the directive).
   *
   * The persisted copy is emptied too, so a restart afterwards starts from nothing as well —
   * what the session remembers has to match what the conversation still holds.
   */
  resetReadState(): void {
    const count = this.readFiles.size;
    const skillCount = this.pendingSkillPaths.size;
    this.readFiles.clear();
    this.rejectionCounts.clear();
    this.pendingSkillPaths.clear();
    this.persistReadState();
    this.onDebug?.(`Prerequisite: reset read state (cleared ${count} reads, ${skillCount} skill prerequisites)`);
  }

  /**
   * Check if a specific file has been read (for testing).
   */
  hasRead(filePath: string): boolean {
    return this.readFiles.has(expandPath(filePath));
  }
}
