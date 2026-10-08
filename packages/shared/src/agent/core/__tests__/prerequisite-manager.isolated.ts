/**
 * Tests for PrerequisiteManager
 *
 * Tests the prerequisite reading system that blocks tool calls
 * until required files (like guide.md) have been read.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { PrerequisiteManager } from '../prerequisite-manager.ts';

// Mock fs to control guide.md existence and to stand in for the session's state file
let mockExistsPaths: Set<string> = new Set();
const mockFiles = new Map<string, string>();

mock.module('node:fs', () => ({
  existsSync: (path: string) => mockExistsPaths.has(path) || mockFiles.has(path),
  readFileSync: (path: string) => {
    const content = mockFiles.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  },
  writeFileSync: (path: string, data: string) => {
    mockFiles.set(path, String(data));
  },
}));

const WORKSPACE_ROOT = '/test/workspace';

function guidePath(slug: string): string {
  return resolve(WORKSPACE_ROOT, 'sources', slug, 'guide.md');
}

function browserDocPath(): string {
  return resolve(join(process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent'), 'docs', 'browser-tools.md'));
}

function drawioDocPath(): string {
  return resolve(join(homedir(), '.craft-agent', 'docs', 'drawio-tools.md'));
}

function designsDocPath(): string {
  return resolve(join(process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent'), 'docs', 'designs.md'));
}

describe('PrerequisiteManager', () => {
  let manager: PrerequisiteManager;
  let debugMessages: string[];

  beforeEach(() => {
    debugMessages = [];
    mockExistsPaths = new Set();
    mockFiles.clear();
    manager = new PrerequisiteManager({
      workspaceRootPath: WORKSPACE_ROOT,
      onDebug: (msg) => debugMessages.push(msg),
    });
  });

  // ============================================================
  // Rule Matching
  // ============================================================

  describe('rule matching', () => {
    it('matches MCP source tools (mcp__{slug}__{tool})', () => {
      mockExistsPaths.add(guidePath('linear'));
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('matches API source tools (api_{slug})', () => {
      mockExistsPaths.add(guidePath('github'));
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('does not match built-in tools', () => {
      const result = manager.checkPrerequisites('Read');
      expect(result.allowed).toBe(true);
    });

    it('does not match Bash tool', () => {
      const result = manager.checkPrerequisites('Bash');
      expect(result.allowed).toBe(true);
    });

    it('does not match Write tool', () => {
      const result = manager.checkPrerequisites('Write');
      expect(result.allowed).toBe(true);
    });

    it('exempts session MCP tools', () => {
      mockExistsPaths.add(guidePath('session'));
      const result = manager.checkPrerequisites('mcp__session__SubmitPlan');
      expect(result.allowed).toBe(true);
    });

    it('handles malformed MCP tool names (fewer than 3 parts)', () => {
      const result = manager.checkPrerequisites('mcp__linear');
      expect(result.allowed).toBe(true);
    });

    it('matches native browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('browser_snapshot');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });

    it('matches session browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('mcp__session__browser_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });

    it('matches drawio_tool and blocks until the diagrams guide is read', () => {
      const docsPath = drawioDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('drawio_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('diagrams guide');
      expect(result.blockReason).toContain(docsPath);
    });

    it('matches the session spelling of drawio_tool', () => {
      const docsPath = drawioDocPath();
      mockExistsPaths.add(docsPath);

      expect(manager.checkPrerequisites('mcp__session__drawio_tool').allowed).toBe(false);
    });

    it('matches the design authoring tools and blocks until the designs guide is read', () => {
      const docsPath = designsDocPath();
      mockExistsPaths.add(docsPath);

      for (const tool of ['create_design', 'update_design', 'mcp__session__create_design', 'mcp__session__update_design']) {
        const result = manager.checkPrerequisites(tool);
        expect(result.allowed).toBe(false);
        expect(result.blockReason).toContain('designs guide');
        expect(result.blockReason).toContain(docsPath);
      }
    });

    // Only the tools that carry `content` need the authoring guide; reading or feeding a design
    // does not, so they must not be caught by the rule's matcher.
    it('does not gate the design tools that do not author HTML', () => {
      mockExistsPaths.add(designsDocPath());

      for (const tool of ['list_designs', 'get_design', 'write_design_data', 'delete_design']) {
        expect(manager.checkPrerequisites(tool).allowed).toBe(true);
      }
    });

    it('allows design tools when the guide is not installed', () => {
      expect(manager.checkPrerequisites('create_design').allowed).toBe(true);
      expect(manager.checkPrerequisites('update_design').allowed).toBe(true);
    });

    // The other door on the same runtime is not gated: `video_tool` reads a recording off a
    // hidden window and has no silent failure modes.
    it('does not gate the neighbouring door', () => {
      mockExistsPaths.add(drawioDocPath());

      expect(manager.checkPrerequisites('video_tool').allowed).toBe(true);
    });

    it('allows drawio_tool when the guide is not installed', () => {
      // Nothing in mockExistsPaths: a checkout that never ran the asset sync has no docs, and a
      // prerequisite that cannot be satisfied is not a prerequisite.
      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(true);
    });
  });

  // ============================================================
  // Path Resolution
  // ============================================================

  describe('path resolution', () => {
    it('resolves guide.md path from MCP tool name', () => {
      const expected = guidePath('linear');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });

    it('resolves guide.md path from API tool name', () => {
      const expected = guidePath('slack');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('api_slack');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });
  });

  // ============================================================
  // Read Tracking
  // ============================================================

  describe('read tracking', () => {
    it('allows tool after guide.md has been read', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Before reading - blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Track the read
      manager.trackReadTool({ file_path: guideFile });

      // After reading - allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('tracks reads using path parameter', () => {
      const guideFile = guidePath('github');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ path: guideFile });
      expect(manager.checkPrerequisites('api_github').allowed).toBe(true);
    });

    it('ignores trackReadTool with no path', () => {
      manager.trackReadTool({});
      expect(manager.hasRead('/any/path')).toBe(false);
    });

    it('tracks multiple reads independently', () => {
      const linearGuide = guidePath('linear');
      const slackGuide = guidePath('slack');
      mockExistsPaths.add(linearGuide);
      mockExistsPaths.add(slackGuide);

      manager.trackReadTool({ file_path: linearGuide });

      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);
    });
  });

  // ============================================================
  // Reset
  // ============================================================

  describe('reset', () => {
    it('clears all read state', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ file_path: guideFile });
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);

      manager.resetReadState();
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('logs debug message on reset', () => {
      manager.trackReadTool({ file_path: '/some/file' });
      manager.resetReadState();
      expect(debugMessages.some((m) => m.includes('reset read state'))).toBe(true);
    });
  });

  // ============================================================
  // Guide Nonexistence
  // ============================================================

  describe('guide nonexistence', () => {
    it('allows tool when guide.md does not exist', () => {
      // Don't add to mockExistsPaths — guide.md doesn't exist
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(true);
    });

    it('allows API tool when guide.md does not exist', () => {
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(true);
    });
  });

  // ============================================================
  // Path Normalization
  // ============================================================

  describe('path normalization', () => {
    it('normalizes tilde paths in trackReadTool', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Track with tilde path that expands to the same absolute path
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/home/user';
      const tildeRelative = `~/some-file.md`;
      manager.trackReadTool({ file_path: tildeRelative });

      // The expanded path should be tracked
      expect(manager.hasRead(tildeRelative)).toBe(true);
    });
  });

  // ============================================================
  // Max Rejection (graceful fallback)
  // ============================================================

  describe('max rejection', () => {
    it('blocks on first attempt, allows on second for same path', () => {
      mockExistsPaths.add(guidePath('linear'));

      // First attempt — blocked
      const first = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(first.allowed).toBe(false);

      // Second attempt (same source, guide still not read) — allowed through
      const second = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(second.allowed).toBe(true);
    });

    it('tracks rejection counts per source independently', () => {
      mockExistsPaths.add(guidePath('linear'));
      mockExistsPaths.add(guidePath('slack'));

      // Block linear once
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Slack should still block on first attempt
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);

      // Linear second attempt — allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('resets rejection counts on resetReadState', () => {
      mockExistsPaths.add(guidePath('linear'));

      // Exhaust rejections
      manager.checkPrerequisites('mcp__linear__createIssue'); // blocked
      manager.checkPrerequisites('mcp__linear__createIssue'); // allowed (max reached)

      // Reset
      manager.resetReadState();

      // Should block again (rejection count reset)
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('allows different tools from same source after one rejection', () => {
      mockExistsPaths.add(guidePath('linear'));

      // First tool blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Different tool from same source — same guide path, already rejected once
      expect(manager.checkPrerequisites('mcp__linear__listIssues').allowed).toBe(true);
    });

    it('does not bypass strict browser prerequisite after repeated rejections', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      expect(manager.checkPrerequisites('browser_open').allowed).toBe(false);
      expect(manager.checkPrerequisites('browser_open').allowed).toBe(false);

      manager.trackReadTool({ file_path: docsPath });
      expect(manager.checkPrerequisites('browser_open').allowed).toBe(true);
    });

    // Strict, like the browser's: the diagrams guide carries rules whose failure is silent (a
    // compressed `.drawio` is unreadable to everything but draw.io; an unbundled shape draws as a
    // plain box), so repeated attempts must not wear the block down.
    it('does not bypass the diagrams guide after repeated rejections', () => {
      const docsPath = drawioDocPath();
      mockExistsPaths.add(docsPath);

      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(false);
      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(false);
      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(false);

      manager.trackReadTool({ file_path: docsPath });
      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(true);
    });

    // The state is per context window, so a compaction puts the gate back: the model no longer
    // holds the rules it read.
    it('blocks drawio_tool again after a context reset', () => {
      const docsPath = drawioDocPath();
      mockExistsPaths.add(docsPath);

      manager.trackReadTool({ file_path: docsPath });
      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(true);

      manager.resetReadState();
      expect(manager.checkPrerequisites('drawio_tool').allowed).toBe(false);
    });

    // Strict too: the failures the designs guide prevents are silent (an external request inside
    // design HTML is blocked with nothing to see; an unrecognized bridge message never arrives),
    // so repeated attempts must not wear the block down.
    it('does not bypass the designs guide after repeated rejections', () => {
      const docsPath = designsDocPath();
      mockExistsPaths.add(docsPath);

      expect(manager.checkPrerequisites('create_design').allowed).toBe(false);
      expect(manager.checkPrerequisites('create_design').allowed).toBe(false);
      expect(manager.checkPrerequisites('create_design').allowed).toBe(false);

      manager.trackReadTool({ file_path: docsPath });
      expect(manager.checkPrerequisites('create_design').allowed).toBe(true);
    });
  });

  // ============================================================
  // Bash Skill Read Tracking
  // ============================================================

  describe('trackBashSkillRead', () => {
    it('clears skill prerequisite when Bash command contains the skill path', () => {
      const skillPath = '/test/workspace/skills/my-skill/SKILL.md';
      manager.registerSkillPrerequisites([skillPath]);

      // WebSearch should be blocked (skill prerequisite pending)
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);

      // Reset rejection count so we can test the block again after clearing
      manager.resetReadState();
      manager.registerSkillPrerequisites([skillPath]);

      // Bash cat targeting the skill path should clear the prerequisite
      const result = manager.trackBashSkillRead({ command: `cat ${skillPath}` });
      expect(result).toBe(true);

      // Now other tools should be allowed
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
    });

    it('returns false when Bash command does not contain a pending skill path', () => {
      const skillPath = '/test/workspace/skills/my-skill/SKILL.md';
      manager.registerSkillPrerequisites([skillPath]);

      const result = manager.trackBashSkillRead({ command: 'ls -la /some/other/path' });
      expect(result).toBe(false);
    });

    it('returns false when there are no pending skill paths', () => {
      const result = manager.trackBashSkillRead({ command: 'cat /any/file' });
      expect(result).toBe(false);
    });

    it('returns false when command is missing', () => {
      manager.registerSkillPrerequisites(['/some/skill/SKILL.md']);
      const result = manager.trackBashSkillRead({});
      expect(result).toBe(false);
    });

    it('clears multiple skill prerequisites from a single command', () => {
      const skill1 = '/test/workspace/skills/alpha/SKILL.md';
      const skill2 = '/test/workspace/skills/beta/SKILL.md';
      manager.registerSkillPrerequisites([skill1, skill2]);

      // Command that contains both paths
      const result = manager.trackBashSkillRead({
        command: `cat ${skill1} && cat ${skill2}`,
      });
      expect(result).toBe(true);

      // Both should be cleared
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
    });

    it('logs debug message when clearing via Bash', () => {
      const skillPath = '/test/workspace/skills/my-skill/SKILL.md';
      manager.registerSkillPrerequisites([skillPath]);

      manager.trackBashSkillRead({ command: `cat ${skillPath}` });
      expect(debugMessages.some(m => m.includes('cleared skill prerequisite via Bash'))).toBe(true);
    });
  });

  // ============================================================
  // Session Persistence
  // ============================================================

  // A restart rebuilds the manager but resumes the same conversation, whose history still holds the
  // guide. The reads therefore outlive the instance — until the conversation itself drops them.
  describe('read state persistence', () => {
    const readStatePath = '/test/session/prerequisite-reads.json';
    const guide = guidePath('linear');

    // The state is written beside an existing session folder; without one there is nothing to remember.
    function withSessionDir(): void {
      mockExistsPaths.add(dirname(readStatePath));
    }

    function makeManager(): PrerequisiteManager {
      return new PrerequisiteManager({
        workspaceRootPath: WORKSPACE_ROOT,
        onDebug: (msg) => debugMessages.push(msg),
        readStatePath,
      });
    }

    it('restores the reads an earlier instance of the session recorded', () => {
      withSessionDir();
      const before = makeManager();
      before.trackReadTool({ file_path: guide });

      const after = makeManager();
      expect(after.hasRead(guide)).toBe(true);
    });

    it('clears the persisted reads on reset, so a restart asks for the guide again', () => {
      withSessionDir();
      const before = makeManager();
      before.trackReadTool({ file_path: guide });
      before.resetReadState(); // compaction: the model lost the guide

      const after = makeManager();
      expect(after.hasRead(guide)).toBe(false);
    });

    it('writes nothing when the session has no folder of its own', () => {
      const before = makeManager();
      before.trackReadTool({ file_path: guide });

      expect(mockFiles.has(readStatePath)).toBe(false);
    });

    it('keeps the state in memory only when no state path is configured', () => {
      const before = new PrerequisiteManager({ workspaceRootPath: WORKSPACE_ROOT });
      before.trackReadTool({ file_path: guide });
      expect(before.hasRead(guide)).toBe(true);

      const after = new PrerequisiteManager({ workspaceRootPath: WORKSPACE_ROOT });
      expect(after.hasRead(guide)).toBe(false);
    });
  });

  // ============================================================
  // Debug Logging
  // ============================================================

  describe('debug logging', () => {
    it('logs when a tool is blocked', () => {
      mockExistsPaths.add(guidePath('linear'));
      manager.checkPrerequisites('mcp__linear__createIssue');
      expect(debugMessages.some((m) => m.includes('Prerequisite blocked'))).toBe(true);
    });

    it('logs when a read is tracked', () => {
      manager.trackReadTool({ file_path: '/some/file.md' });
      expect(debugMessages.some((m) => m.includes('tracked read'))).toBe(true);
    });
  });
});
