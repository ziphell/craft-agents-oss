/**
 * Tests for a project's work report.
 *
 * Real temp directories: the report is derived from disk, so the disk is the fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildProjectLayers } from '../specs.ts';
import { createProject, getProjectPath } from '../storage.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'project-specs-'));
  workspaceRoot = join(tempDir, 'workspace');
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('buildProjectLayers', () => {
  it('is empty for a project nothing has been written into', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const report = buildProjectLayers(workspaceRoot, slug);

    expect(report.goal).toBeNull();
    expect(report.entry).toBeNull();
    expect(report.pieces).toEqual([]);
    expect(report.files).toEqual([]);
    expect(report.brokenLinkNotices).toEqual([]);
    expect(report.dir).toBe(getProjectPath(workspaceRoot, slug));
  });

  it('reads a project folder the way the workbench reads a folder', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const dir = getProjectPath(workspaceRoot, slug);

    writeFileSync(join(dir, 'spec.md'), '# Cart\n\nThe index.\n');
    writeFileSync(join(dir, 'cart.spec.md'), '# Cart total\n\nRounds half up.\n');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'flows.spec.md'), '# Checkout flows\n');

    const report = buildProjectLayers(workspaceRoot, slug);

    // The entry is the specification's first row whether or not it states anything.
    expect(report.entry?.name).toBe('spec.md');
    // Each layer file is one piece, grouped by the stem its name carries — a spec in a subfolder
    // keeps its subfolder in the stem, and its title is its own first heading.
    expect(report.pieces).toEqual([
      { stem: 'cart', spec: { file: 'cart.spec.md', title: 'Cart total' }, plan: null },
      { stem: 'docs/flows', spec: { file: 'docs/flows.spec.md', title: 'Checkout flows' }, plan: null },
    ]);
    expect(report.files).toEqual([]);
  });

  it('leaves out the app-owned names and says which links point at nothing', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const dir = getProjectPath(workspaceRoot, slug);

    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'wireframe.png'), 'not really a png');
    writeFileSync(join(dir, 'notes.txt'), 'something the author put there');
    writeFileSync(
      join(dir, 'spec.md'),
      '# Cart\n\nSee [the total](cart.spec.md) and [the missing one](gone.spec.md).\n',
    );
    writeFileSync(join(dir, 'cart.spec.md'), '# Cart total\n');

    const report = buildProjectLayers(workspaceRoot, slug);

    // `config.json`, `MEMORY.md` and `assets/` are the app's, and the assets are named by the
    // Assets tab already; what is left is what the author put at the root as material.
    expect(report.files.map((file) => file.name)).toEqual(['notes.txt']);
    // A link that resolves is not a blocker; the one that resolves to nothing is.
    expect(report.unresolved.brokenLinks).toEqual([
      { from: 'spec.md', target: 'gone.spec.md' },
    ]);
    expect(report.brokenLinkNotices).toHaveLength(1);
  });

  // A spec and a plan that share a stem are the two layers of **one** piece of work: the report
  // groups them by stem rather than listing the files twice.
  it('groups a spec and a plan that share a stem into one piece', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const dir = getProjectPath(workspaceRoot, slug);

    writeFileSync(join(dir, 'cart.spec.md'), '# Cart total\n');
    writeFileSync(join(dir, 'cart.plan.md'), '# How the total is computed\n');

    const report = buildProjectLayers(workspaceRoot, slug);

    expect(report.pieces).toEqual([
      {
        stem: 'cart',
        spec: { file: 'cart.spec.md', title: 'Cart total' },
        plan: { file: 'cart.plan.md', title: 'How the total is computed' },
      },
    ]);
    expect(report.files).toEqual([]);
  });

  // A plan written with no spec beside it is still one piece: the missing layer is simply absent,
  // and the report raises nothing about it.
  it('makes a piece out of a plan that has no spec', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const dir = getProjectPath(workspaceRoot, slug);

    writeFileSync(join(dir, 'cart.plan.md'), '# How the total is computed\n');

    const report = buildProjectLayers(workspaceRoot, slug);

    expect(report.pieces).toEqual([
      { stem: 'cart', spec: null, plan: { file: 'cart.plan.md', title: 'How the total is computed' } },
    ]);
  });

  // The stem is the file's path relative to the folder with its layer suffix stripped, so two
  // files in a subfolder are paired by `docs/cart` rather than by `cart`.
  it('pairs layers in a subfolder by their folder-relative stem', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const dir = getProjectPath(workspaceRoot, slug);

    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'cart.spec.md'), '# Cart total\n');
    writeFileSync(join(dir, 'docs', 'cart.plan.md'), '# How the total is computed\n');

    const report = buildProjectLayers(workspaceRoot, slug);

    expect(report.pieces).toEqual([
      {
        stem: 'docs/cart',
        spec: { file: 'docs/cart.spec.md', title: 'Cart total' },
        plan: { file: 'docs/cart.plan.md', title: 'How the total is computed' },
      },
    ]);
  });

  // The goal is the root `goal.md`, read as its own layer — not as material, and not as a piece.
  it('reads the root goal.md as the goal, out of the material and the pieces', () => {
    const { slug } = createProject(workspaceRoot, { name: 'Cart' });
    const dir = getProjectPath(workspaceRoot, slug);

    writeFileSync(join(dir, 'goal.md'), '# Why the cart exists\n');
    writeFileSync(join(dir, 'cart.spec.md'), '# Cart total\n');

    const report = buildProjectLayers(workspaceRoot, slug);

    expect(report.goal?.file.name).toBe('goal.md');
    expect(report.goal?.title).toBe('Why the cart exists');
    expect(report.pieces.map((piece) => piece.stem)).toEqual(['cart']);
    expect(report.files).toEqual([]);
  });
});
