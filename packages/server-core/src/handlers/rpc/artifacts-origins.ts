/**
 * Artifacts → originating conversations, host-side.
 *
 * This is a **cache, not a source of truth**: read that as a claim about the whole
 * file. Nothing here is written to disk, there is no index file and no sidecar, and
 * if this module's map is thrown away the next call rebuilds it from the sessions —
 * the conversations' own records are the only thing stored, and this merely avoids
 * re-reading them for every artifact opened.
 *
 * Keyed by the session file's mtime: a `session.jsonl` that has not moved since the
 * last look is not parsed again, and one that has is re-read whole (a JSONL is appended
 * to and rewritten atomically, so there is no smaller unit to invalidate). The per-path
 * links are then the merge `deriveArtifactLinks` already owns — this adds the IO and the
 * guarding, and no second grouping.
 */

import { readdirSync, statSync } from 'node:fs'
import { getWorkspaceSessionsPath } from '@craft-agent/shared/workspaces'
import { getSessionFilePath, loadSession } from '@craft-agent/shared/sessions'
import {
  artifactWriteEventsFromMessages,
  deriveArtifactLinks,
  normalizeArtifactPath,
} from '@craft-agent/shared/artifacts'
import type { ArtifactOrigin, ArtifactWriteEvent } from '@craft-agent/shared/artifacts'

/** One session's writes, plus the file mtime they were read at. */
interface CachedSession {
  mtimeMs: number
  events: ArtifactWriteEvent[]
}

interface WorkspaceIndex {
  sessions: Map<string, CachedSession>
  /** The merged answer, replaced whole whenever any session changes. */
  links: Map<string, ArtifactOrigin[]>
}

/** Keyed by workspace root path — the workspace is what the sessions belong to. */
const indexes = new Map<string, WorkspaceIndex>()

/**
 * The conversations that wrote a workspace-relative artifact path, most recent first
 * (the order `deriveArtifactLinks` keeps). Empty when nobody did, or when the path is
 * not one the workspace holds.
 */
export function artifactOriginsForWorkspace(
  workspaceRootPath: string,
  relativePath: string,
): ArtifactOrigin[] {
  const index = indexes.get(workspaceRootPath) ?? { sessions: new Map(), links: new Map() }
  indexes.set(workspaceRootPath, index)

  refresh(index, workspaceRootPath)
  return index.links.get(normalizeArtifactPath(relativePath)) ?? []
}

/** Re-read every session whose file moved since the last look, then re-merge if any did. */
function refresh(index: WorkspaceIndex, workspaceRootPath: string): void {
  let changed = false
  const present = new Set<string>()

  for (const sessionId of listSessionIds(workspaceRootPath)) {
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    let mtimeMs: number
    try {
      mtimeMs = statSync(sessionFile).mtimeMs
    } catch {
      // No session.jsonl yet (an empty session folder) — nothing to read.
      continue
    }
    present.add(sessionId)

    const cached = index.sessions.get(sessionId)
    if (cached && cached.mtimeMs === mtimeMs) continue

    const session = loadSession(workspaceRootPath, sessionId)
    index.sessions.set(sessionId, {
      mtimeMs,
      events: session
        ? artifactWriteEventsFromMessages(sessionId, session.messages, workspaceRootPath)
        : [],
    })
    changed = true
  }

  // A deleted session must stop being an origin. Dropping what is gone is what keeps
  // this a cache of the sessions that exist rather than of every session ever seen.
  for (const sessionId of [...index.sessions.keys()]) {
    if (!present.has(sessionId)) {
      index.sessions.delete(sessionId)
      changed = true
    }
  }

  if (changed) {
    const events = [...index.sessions.values()].flatMap((entry) => entry.events)
    index.links = deriveArtifactLinks(events)
  }
}

/**
 * The workspace's session ids, read from its sessions directory.
 *
 * The directory, not `listSessions`: that parses every header and counts plan files,
 * which is more than a change check needs — here the id and the file's mtime are all
 * this reads, and only a session that moved is parsed in full.
 */
function listSessionIds(workspaceRootPath: string): string[] {
  try {
    return readdirSync(getWorkspaceSessionsPath(workspaceRootPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No sessions directory yet — nothing was ever written here.
    return []
  }
}
