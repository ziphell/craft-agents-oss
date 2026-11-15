/**
 * Projects Module
 *
 * Public exports for project management and a project's specs.
 */

export type {
  ProjectConfig,
  ProjectAsset,
  CreateProjectInput,
  LoadedProject,
  ProjectPromptContext,
} from './types.ts';

export {
  // Path utilities
  ensureProjectsDir,
  ensureProjectAssetsDir,
  getWorkspaceProjectsPath,
  getProjectPath,
  getProjectAssetsPath,
  getProjectMemoryPath,
  MEMORY_FILENAME,
  // Config operations
  loadProjectConfig,
  saveProjectConfig,
  // Memory operations
  loadProjectMemory,
  // Load operations
  loadProject,
  loadProjectById,
  loadWorkspaceProjects,
  // Create/update/delete
  generateProjectSlug,
  createProject,
  updateProject,
  deleteProject,
  projectExists,
  // Asset operations
  listProjectAssets,
  uploadProjectAsset,
  addProjectAssetFromPath,
  deleteProjectAsset,
  sanitizeAssetFilename,
} from './storage.ts';

export type { UploadProjectAssetInput, AddedProjectAsset } from './storage.ts';

export { buildProjectLayers } from './specs.ts';

// The project's asset library: the files on disk, and what people and agents say about them.
export {
  getProjectLibraryFilePath,
  scanProjectAssets,
  readProjectLibrary,
  listProjectLibrary,
  setProjectAssetTags,
  setProjectAssetNote,
  setProjectAssetLayout,
  forgetProjectAsset,
} from './library.ts';
export type { ProjectLibraryRead, ProjectLibrarySnapshot } from './library.ts';


// A project's layers — the names, the parsing layer and the report.
export { GOAL_FILENAME, PLAN_SUFFIX, SPEC_ENTRY_FILENAME } from './spec-names.ts';
export { isMarkdownFile, listFiles } from './files.ts';
export type { FolderFile } from './files.ts';
export { extractLinkTargets, readSpecLinks } from './links.ts';
export type { SpecLink, SpecLinks } from './links.ts';
export { notice, rawNotice } from './notices.ts';
export type { SpecNotice, SpecNoticeCode, SpecNoticeParams } from './notices.ts';
export {
  buildWorkLayers,
  parseSpecDocument,
  readSpecDocuments,
  specEntryPath,
} from './specs.ts';
export type {
  SpecDocument,
  SpecDocuments,
  LayerDocument,
  WorkLayers,
} from './specs.ts';

export { formatModeContextForPrompt } from './mode-prompt.ts';
export type { ModePromptContext } from './mode-prompt.ts';
