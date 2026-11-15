/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  copyFileSync,
  linkSync,
} from 'fs';
import { basename, extname, join, relative } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync, readJsonFileSync, getMimeType } from '../utils/files.ts';
import { kindOfPath } from '../library/merge.ts';
import { readGenerationRecord, writeGenerationRecord } from '../provenance/storage.ts';
import { toPosix } from '../provenance/paths.ts';
import { generateUniqueSlug } from '../utils/slug.ts';
import { debug } from '../utils/debug.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { estimateTokensDensityAware } from '../utils/large-response.ts';
import type {
  ProjectConfig,
  ProjectAsset,
  LoadedProject,
  CreateProjectInput,
} from './types.ts';

/**
 * Short-lived cache for `loadProjectById`.
 *
 * Browser routing asks the same question on every command, and resolving an id means scanning the
 * workspace's projects. Writes through this module clear the cache; the TTL only bounds staleness
 * from a config.json edited outside the app.
 */
const projectByIdCache = new Map<string, { readAt: number; project: LoadedProject | null }>();
const PROJECT_BY_ID_TTL_MS = 1_000;

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to workspace projects directory.
 */
export function getWorkspaceProjectsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'projects');
}

/**
 * Get path to a project folder within a workspace.
 */
export function getProjectPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getWorkspaceProjectsPath(workspaceRootPath), projectSlug);
}

/**
 * Get path to a project's assets directory.
 */
export function getProjectAssetsPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), 'assets');
}

/** Filename of a project's agent-maintained "lessons learned" doc. */
export const MEMORY_FILENAME = 'MEMORY.md';

/**
 * Get path to a project's MEMORY.md. Deliberately a sibling of config.json
 * (outside assets/) so it never shows up in the asset manifest.
 */
export function getProjectMemoryPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), MEMORY_FILENAME);
}

/**
 * Ensure projects directory exists for a workspace.
 */
export function ensureProjectsDir(workspaceRootPath: string): void {
  const dir = getWorkspaceProjectsPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a project's assets directory exists.
 */
export function ensureProjectAssetsDir(workspaceRootPath: string, projectSlug: string): void {
  const dir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load project config.json.
 * Returns null if the config does not exist or fails to parse.
 */
export function loadProjectConfig(
  workspaceRootPath: string,
  projectSlug: string,
): ProjectConfig | null {
  const configPath = join(getProjectPath(workspaceRootPath, projectSlug), 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<ProjectConfig>(configPath);

    // Expand portable paths on read so consumers always see absolute paths.
    if (config.workingDirectory) {
      config.workingDirectory = expandPath(config.workingDirectory);
    }

    return config;
  } catch (error) {
    debug('[loadProjectConfig] Failed to read project config:', projectSlug, error);
    return null;
  }
}

/**
 * Save project config.json (atomic write, bumps updatedAt).
 */
export function saveProjectConfig(workspaceRootPath: string, config: ProjectConfig): void {
  const dir = getProjectPath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const storageConfig: ProjectConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  if (storageConfig.workingDirectory) {
    storageConfig.workingDirectory = toPortablePath(storageConfig.workingDirectory);
  }

  atomicWriteFileSync(join(dir, 'config.json'), JSON.stringify(storageConfig, null, 2));
  projectByIdCache.clear();
}

// ============================================================
// Memory Operations
// ============================================================

/**
 * Load a project's MEMORY.md, capped at `maxTokens` for prompt injection.
 *
 * Returns `null` when the file is missing or effectively empty. When the
 * content exceeds the budget it is **head-truncated** (the top is kept, since
 * the agent is instructed to write newest/most-important first) and a one-line
 * marker is appended. The returned string — marker included — stays within the
 * token budget.
 */
export function loadProjectMemory(
  workspaceRootPath: string,
  projectSlug: string,
  maxTokens = 5000,
): string | null {
  const memoryPath = getProjectMemoryPath(workspaceRootPath, projectSlug);
  if (!existsSync(memoryPath)) return null;

  let content: string;
  try {
    content = readFileSync(memoryPath, 'utf-8');
  } catch (error) {
    debug('[loadProjectMemory] Failed to read MEMORY.md:', projectSlug, error);
    return null;
  }

  if (!content.trim()) return null;

  const tokens = estimateTokensDensityAware(content);
  if (tokens <= maxTokens) return content;

  // Over budget: reserve room for the marker, then head-truncate. `charsPerToken`
  // is derived from the actual content so a density-corrected estimate (base64-heavy
  // memory) still maps back to a sensible character budget.
  const marker = `\n\n…[MEMORY.md truncated at ${maxTokens}-token cap — keep it shorter]`;
  const markerTokens = estimateTokensDensityAware(marker);
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  const charsPerToken = content.length / tokens;
  const charBudget = Math.floor(bodyBudget * charsPerToken);
  const head = content.slice(0, charBudget).trimEnd();
  return `${head}${marker}`;
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single project by slug.
 */
export function loadProject(
  workspaceRootPath: string,
  projectSlug: string,
): LoadedProject | null {
  const config = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!config) return null;

  const folderPath = getProjectPath(workspaceRootPath, projectSlug);
  const assetsPath = getProjectAssetsPath(workspaceRootPath, projectSlug);
  const workspaceId = basename(workspaceRootPath);

  return {
    config,
    folderPath,
    assetsPath,
    workspaceRootPath,
    workspaceId,
  };
}

/**
 * Load a project by id (scans workspace projects for a matching id).
 * Slugs are unique within a workspace, but callers may persist the project id
 * on a session (more stable across renames).
 *
 * Cached briefly: browser routing asks for the same project on every command, and the scan reads
 * every project's config.json. Writes through this module invalidate the cache, so a settings
 * change is visible immediately; the TTL only bounds staleness from edits made outside the app.
 */
export function loadProjectById(
  workspaceRootPath: string,
  projectId: string,
): LoadedProject | null {
  const key = `${workspaceRootPath}\u0000${projectId}`;
  const now = Date.now();
  const cached = projectByIdCache.get(key);
  if (cached && now - cached.readAt < PROJECT_BY_ID_TTL_MS) return cached.project;

  const project = loadWorkspaceProjects(workspaceRootPath).find((p) => p.config.id === projectId) ?? null;
  projectByIdCache.set(key, { readAt: now, project });
  return project;
}

/**
 * Load all projects for a workspace.
 */
export function loadWorkspaceProjects(workspaceRootPath: string): LoadedProject[] {
  ensureProjectsDir(workspaceRootPath);

  const projects: LoadedProject[] = [];
  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);

  if (!existsSync(projectsDir)) return projects;

  const entries = readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = loadProject(workspaceRootPath, entry.name);
    if (project) projects.push(project);
  }

  return projects;
}

// ============================================================
// Create / Update / Delete
// ============================================================

/**
 * Generate a URL-safe, workspace-unique project slug.
 */
export function generateProjectSlug(workspaceRootPath: string, name: string): string {
  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }
  return generateUniqueSlug(name, existingSlugs, 'project');
}

/**
 * Create a new project in a workspace.
 */
export function createProject(
  workspaceRootPath: string,
  input: CreateProjectInput,
): ProjectConfig {
  const slug = generateProjectSlug(workspaceRootPath, input.name);
  const now = Date.now();

  const config: ProjectConfig = {
    id: `proj_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    workingDirectory: input.workingDirectory,
    details: input.details,
    colorTheme: input.colorTheme,
    createdAt: now,
    updatedAt: now,
  };

  saveProjectConfig(workspaceRootPath, config);
  ensureProjectAssetsDir(workspaceRootPath, slug);

  return config;
}

/**
 * Optional text on a project that a person can clear.
 *
 * A clear travels as `''`, not `undefined`: the RPC transport is JSON, which drops keys
 * whose value is undefined, so a removed key would arrive as "no change at all" and the
 * old value would survive the save. An empty string is never a meaningful value for any
 * of these — stored, it would read back as *set* (`workingDirectory: ''` is not nullish,
 * so it would beat the project folder) — so `''` is the clear, and the empty string is
 * dropped here rather than written.
 */
const CLEARABLE_TEXT_FIELDS = ['description', 'details', 'color', 'workingDirectory', 'browserProfile'] as const;

/**
 * Update a project's config with a partial patch.
 * `id` and `slug` cannot be changed.
 */
export function updateProject(
  workspaceRootPath: string,
  projectSlug: string,
  patch: Partial<Omit<ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
): ProjectConfig {
  const existing = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!existing) {
    throw new Error(`Project not found: ${projectSlug}`);
  }

  const updated: ProjectConfig = {
    ...existing,
    ...patch,
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  for (const field of CLEARABLE_TEXT_FIELDS) {
    if (updated[field] === '') {
      delete updated[field];
    }
  }

  saveProjectConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Delete a project (removes folder and all assets).
 * Caller is responsible for unsetting `projectId` on sessions that referenced it.
 */
export function deleteProject(workspaceRootPath: string, projectSlug: string): void {
  const dir = getProjectPath(workspaceRootPath, projectSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  projectByIdCache.clear();
}

/**
 * Check if a project exists in a workspace.
 */
export function projectExists(workspaceRootPath: string, projectSlug: string): boolean {
  return existsSync(join(getProjectPath(workspaceRootPath, projectSlug), 'config.json'));
}

// ============================================================
// Asset Operations
// ============================================================

/**
 * Sanitize an upload filename so it stays inside the assets directory.
 * Strips path separators and leading dots; falls back to a uuid name if empty.
 */
export function sanitizeAssetFilename(filename: string): string {
  // Strip path separators AND control chars (NUL/newlines/DEL) so a crafted upload name can't
  // escape the assets dir or, once listed, forge new lines in the <project_assets> prompt block.
  // eslint-disable-next-line no-control-regex
  const base = basename(filename).replace(/[\\/\x00-\x1f\x7f]+/g, '').replace(/^\.+/, '');
  if (!base) return `asset_${randomUUID().slice(0, 8)}`;
  return base.slice(0, 255);
}

/**
 * List all assets for a project (sorted newest first).
 */
export function listProjectAssets(
  workspaceRootPath: string,
  projectSlug: string,
): ProjectAsset[] {
  ensureProjectAssetsDir(workspaceRootPath, projectSlug);

  const assetsDir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  if (!existsSync(assetsDir)) return [];

  const assets: ProjectAsset[] = [];
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = join(assetsDir, entry.name);
    try {
      const stats = statSync(filePath);
      assets.push({
        filename: entry.name,
        sizeBytes: stats.size,
        mimeType: getMimeType(filePath),
        uploadedAt: stats.mtimeMs,
        absolutePath: filePath,
      });
    } catch (error) {
      debug('[listProjectAssets] Failed to stat asset:', filePath, error);
    }
  }

  assets.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return assets;
}

export interface UploadProjectAssetInput {
  filename: string;
  /** Base64-encoded contents (preferred for cross-process IPC) */
  base64?: string;
  /** Raw text contents (for small text/markdown uploads) */
  text?: string;
  /** Absolute source path on disk; copied into the assets folder */
  sourcePath?: string;
  /**
   * Prefer a hard link when the source is on the same volume, so a generated file already in the
   * project costs no second copy. Falls back to a copy on filesystems that do not support links.
   */
  link?: boolean;
}

export interface AddedProjectAsset {
  asset: ProjectAsset;
  /** True when `assets/<name>` is a hard link to the source: no bytes were copied. */
  linked: boolean;
}

/**
 * Put the source bytes in the library.
 *
 * A hard link is the cheap path: the generation and the library entry are one file with two names,
 * so the same media is not stored twice. It only works on the same volume and a filesystem that
 * supports links; anything else falls back to a copy rather than failing the add.
 *
 * **Only media is linked.** A picture, a clip or a recording is treated as immutable once it was
 * made, so sharing its bytes with the history is safe. A document is not: editing it in place
 * through either path would write through the link and change the other name too, so an editable
 * format is always copied. (An atomic save — temp file + rename — would break the link by itself,
 * but not every editor saves that way, and a rule that depends on the editor is not a rule.)
 */
function placeSourceFile(sourcePath: string, targetPath: string, link: boolean): boolean {
  if (link) {
    try {
      linkSync(sourcePath, targetPath);
      return true;
    } catch (error) {
      debug('[uploadProjectAsset] Hard link unavailable; copying instead:', sourcePath, error);
    }
  }
  copyFileSync(sourcePath, targetPath);
  return false;
}

/** Media the app treats as immutable. Everything else may be edited, so it is not linked. */
function mayHardLink(sourcePath: string): boolean {
  const kind = kindOfPath(sourcePath);
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

/**
 * A generated file's note follows it into the library.
 *
 * The note is what makes a file an *asset with a source* rather than a copy with a name. It is
 * rewritten to point at the asset's own path, so provenance and the library agree on one spelling.
 * A note that cannot be written is a lost line of history, never a failed copy.
 */
function carryGenerationRecord(sourcePath: string, targetPath: string, projectPath: string): void {
  try {
    const record = readGenerationRecord(sourcePath)
    if (!record) return
    writeGenerationRecord(targetPath, {
      ...record,
      file: toPosix(relative(projectPath, targetPath)),
    })
  } catch (error) {
    debug('[writeProjectAsset] Failed to carry generation record:', sourcePath, error)
  }
}

function writeProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  input: UploadProjectAssetInput,
): AddedProjectAsset {
  if (!projectExists(workspaceRootPath, projectSlug)) {
    throw new Error(`Project not found: ${projectSlug}`);
  }
  return writeAssetToContentRoot(getProjectPath(workspaceRootPath, projectSlug), input);
}

/**
 * The folder-level form: copy a file into `<contentRoot>/assets/`, note included.
 *
 * A project's root is its folder; a conversation outside a project has a root too (its session
 * folder), so the library's `add` works in both without a second copy of this logic.
 */
function writeAssetToContentRoot(contentRoot: string, input: UploadProjectAssetInput): AddedProjectAsset {
  const assetsDir = join(contentRoot, 'assets');
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });

  const safeName = sanitizeAssetFilename(input.filename);
  const targetPath = resolveUniqueAssetPath(assetsDir, safeName);

  let linked = false;
  if (input.base64 !== undefined) {
    writeFileSync(targetPath, Buffer.from(input.base64, 'base64'));
  } else if (input.text !== undefined) {
    writeFileSync(targetPath, input.text, 'utf-8');
  } else if (input.sourcePath) {
    if (!existsSync(input.sourcePath)) {
      throw new Error(`Source file does not exist: ${input.sourcePath}`);
    }
    linked = placeSourceFile(input.sourcePath, targetPath, input.link === true && mayHardLink(input.sourcePath));
    carryGenerationRecord(input.sourcePath, targetPath, contentRoot);
  } else {
    throw new Error('uploadProjectAsset requires one of: base64, text, sourcePath');
  }

  const stats = statSync(targetPath);
  return {
    asset: {
      filename: basename(targetPath),
      sizeBytes: stats.size,
      mimeType: getMimeType(targetPath),
      uploadedAt: stats.mtimeMs,
      absolutePath: targetPath,
    },
    linked,
  };
}

/**
 * Upload (write) an asset into the project's assets directory.
 * Accepts base64, text, or a sourcePath to copy from.
 * Resolves filename collisions by appending `-{n}` before the extension.
 */
export function uploadProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  input: UploadProjectAssetInput,
): ProjectAsset {
  return writeProjectAsset(workspaceRootPath, projectSlug, input).asset;
}

/**
 * Add an existing project file — a generation, a download — to the asset library.
 *
 * This is the explicit bridge from history to library. The source stays where it is; when the
 * volume allows it the library entry is a hard link, so no second copy of a large clip is made.
 */
export function addProjectAssetFromPath(
  workspaceRootPath: string,
  projectSlug: string,
  sourcePath: string,
  filename = basename(sourcePath),
): AddedProjectAsset {
  return writeProjectAsset(workspaceRootPath, projectSlug, {
    filename,
    sourcePath,
    link: true,
  });
}

/**
 * Delete a single asset from a project (no-op if missing).
 */
export function deleteProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  filename: string,
): void {
  const safe = sanitizeAssetFilename(filename);
  const target = join(getProjectAssetsPath(workspaceRootPath, projectSlug), safe);
  if (!existsSync(target)) return;

  // Refuse to follow path traversal — `safe` should already be the bare filename.
  if (basename(target) !== safe) {
    throw new Error(`Refusing to delete asset outside assets directory: ${filename}`);
  }

  try {
    unlinkSync(target);
  } catch (error) {
    debug('[deleteProjectAsset] Failed to delete asset:', target, error);
    throw error;
  }
}

/**
 * Resolve a target path inside `assetsDir` that does not collide with existing files.
 * Returns the original name if free; otherwise appends `-2`, `-3`, ... before the extension.
 */
function resolveUniqueAssetPath(assetsDir: string, filename: string): string {
  const candidate = join(assetsDir, filename);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;

  let counter = 2;
  while (existsSync(join(assetsDir, `${stem}-${counter}${ext}`))) counter++;
  return join(assetsDir, `${stem}-${counter}${ext}`);
}
