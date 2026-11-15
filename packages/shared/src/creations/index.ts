/**
 * Creations — the works an agent produced, derived from transcripts + the filesystem.
 *
 * Nothing here owns a file, a folder, or an id: a creation *is* the file at its path, and the
 * origin list is read back out of the session transcripts. Delete the cache and it rebuilds.
 */

export type {
  Creation,
  CreationFormat,
  CreationOrigin,
  CreationPlace,
  CreationsQuery,
  CreationsScanStats,
  CreationsSnapshot,
} from './types'
export { CREATIONS_INDEX_VERSION } from './types'

export { expandPath, formatOfPath, normalizeArtifactPath, placeOfPath, samePath, titleOfPath } from './paths'
export type { PathContext, PathPlace } from './paths'

export { ARTIFACT_TOOLS, extractArtifacts, firstPositional, outFlags, splitCommand } from './extract'
export type { ArtifactHit } from './extract'

export { createCreationsCache, knownCreationPaths, refreshCreations } from './scan'
export type { CreationsCache, SessionEntry } from './scan'
export { mergeSnapshot } from './merge'
export { CREATIONS_CACHE_FILE, loadCache, saveCache } from './cache-file'
export {
  VERSIONS_KEPT,
  currentVersion,
  listVersions,
  readVersion,
  recordIfChanged,
  recordVersion,
  suggestedVersionName,
  type CreationVersion,
} from './versions'
