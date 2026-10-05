/**
 * Tests for Project Storage — MEMORY.md loading.
 *
 * Uses real temp directories to exercise actual filesystem operations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { estimateTokensDensityAware } from '../../utils/large-response.ts';
import {
  createProject,
  getProjectMemoryPath,
  loadProjectConfig,
  loadProjectMemory,
  sanitizeAssetFilename,
  updateProject,
} from '../storage.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'projects-test-'));
  workspaceRoot = join(tempDir, 'workspace');
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeProjectSlug(name = 'Memory Test'): string {
  return createProject(workspaceRoot, { name }).slug;
}

describe('sanitizeAssetFilename', () => {
  it('strips control chars and NUL bytes (the literal-NUL regex fix)', () => {
    // A NUL, newline, and tab are all removed — the source regex no longer carries a literal NUL.
    expect(sanitizeAssetFilename('re\x00port\n\t.pdf')).toBe('report.pdf');
  });

  it('strips path separators and leading dots so an upload stays in the assets dir', () => {
    // Forward slashes are separators on every platform, so the trailing component
    // is deterministic here.
    expect(sanitizeAssetFilename('../../etc/passwd')).toBe('passwd');

    // Backslash variants are neutralized too: the result never keeps a separator
    // or a leading '..' (the exact surviving substring differs by platform because
    // basename() only treats '\' as a separator on Windows).
    const backslash = sanitizeAssetFilename('..\\..\\etc\\passwd');
    expect(backslash).not.toMatch(/[\\/]/);
    expect(backslash).not.toContain('..');
  });

  it('falls back to a generated name when the input reduces to empty', () => {
    expect(sanitizeAssetFilename('\x00\n\t')).toMatch(/^asset_[0-9a-f]{8}$/);
  });
});

describe('updateProject', () => {
  it('sets a working directory', () => {
    const slug = makeProjectSlug();
    // Read back from disk rather than compared to the literal: the config normalises path
    // separators, and the returned patch keeps what was handed in.
    updateProject(workspaceRoot, slug, { workingDirectory: '/code/cart' });
    expect(loadProjectConfig(workspaceRoot, slug)?.workingDirectory).toBeTruthy();
  });

  it("clears it when the patch carries '' — the shape a cleared field arrives in", () => {
    const slug = makeProjectSlug();
    updateProject(workspaceRoot, slug, { workingDirectory: '/code/cart' });

    const updated = updateProject(workspaceRoot, slug, { workingDirectory: '' });

    // Nothing is left behind, on disk either: absent, not ''. A stored '' would read back
    // as *set* and win over the project's own folder.
    expect(updated.workingDirectory).toBeUndefined();
    expect(loadProjectConfig(workspaceRoot, slug)?.workingDirectory).toBeUndefined();
  });

  it("never writes '' for a field that was already unset", () => {
    const slug = makeProjectSlug();
    updateProject(workspaceRoot, slug, { description: '', details: '', color: '' });
    const config = loadProjectConfig(workspaceRoot, slug);
    expect(config?.description).toBeUndefined();
    expect(config?.details).toBeUndefined();
    expect(config?.color).toBeUndefined();
  });

  it('still keeps a real value beside a cleared one', () => {
    const slug = makeProjectSlug();
    updateProject(workspaceRoot, slug, { workingDirectory: '/code/cart', description: 'A cart' });

    updateProject(workspaceRoot, slug, { workingDirectory: '' });

    const config = loadProjectConfig(workspaceRoot, slug);
    expect(config?.workingDirectory).toBeUndefined();
    expect(config?.description).toBe('A cart');
  });

  it('a patch that omits the key changes nothing (which is why cleared text travels as \'\')', () => {
    // The renderer used to send `workingDirectory: undefined` to mean "clear". The transport
    // is JSON, which drops undefined keys, so the key never arrived and the old value stayed —
    // the save looked like it worked and silently restored what was there before.
    const slug = makeProjectSlug();
    updateProject(workspaceRoot, slug, { workingDirectory: '/code/cart' });
    const before = loadProjectConfig(workspaceRoot, slug)?.workingDirectory;

    updateProject(workspaceRoot, slug, { name: 'Renamed' });

    expect(loadProjectConfig(workspaceRoot, slug)?.workingDirectory).toBe(before as string);
  });
});

describe('loadProjectMemory', () => {
  it('returns null when MEMORY.md does not exist', () => {
    const slug = makeProjectSlug();
    expect(loadProjectMemory(workspaceRoot, slug)).toBeNull();
  });

  it('returns null when MEMORY.md is whitespace-only', () => {
    const slug = makeProjectSlug();
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), '   \n\t\n');
    expect(loadProjectMemory(workspaceRoot, slug)).toBeNull();
  });

  it('returns content verbatim when under the token cap', () => {
    const slug = makeProjectSlug();
    const content = '# Lessons\n\n- Always read the guide first.\n- Cache is king.';
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), content);
    expect(loadProjectMemory(workspaceRoot, slug)).toBe(content);
  });

  it('head-truncates and appends a marker when over the cap, staying within budget', () => {
    const slug = makeProjectSlug();
    const maxTokens = 50;
    // ~2000 chars of plain text => ~500 tokens, well over the 50-token cap.
    const body = 'TOP-OF-MEMORY ' + 'lorem ipsum dolor sit amet '.repeat(74) + ' BOTTOM-OF-MEMORY';
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), body);

    const result = loadProjectMemory(workspaceRoot, slug, maxTokens);
    expect(result).not.toBeNull();
    const text = result as string;

    // Head kept (newest-first authoring), tail dropped.
    expect(text).toContain('TOP-OF-MEMORY');
    expect(text).not.toContain('BOTTOM-OF-MEMORY');

    // Marker present and budget respected (marker included).
    expect(text).toContain(`truncated at ${maxTokens}-token cap`);
    expect(estimateTokensDensityAware(text)).toBeLessThanOrEqual(maxTokens);
  });
});
