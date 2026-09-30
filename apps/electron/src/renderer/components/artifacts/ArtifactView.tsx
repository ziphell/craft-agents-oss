/**
 * ArtifactView — one artifact, open in the app.
 *
 * A second-level page, not a window: the app already has the drawio editor (the
 * same `DrawioEditorPane` a conversation block and the prototype page open), and
 * an artifact's page is that editor with a header that says which file it is. Its
 * main area is the editor in an iframe; read/write/conflict are the editor's own
 * (`useFileWriter`), so nothing about the file is decided here.
 *
 * The one thing this page must work out is the absolute path the editor is bound
 * to: navigation carries the artifact's workspace-relative path (its identity),
 * and the editor reads and writes a file — so the path is joined onto the active
 * workspace's root, the same way the prototype page resolves a folder-relative
 * path. Nothing is stored; the list and this header both come from the atom.
 *
 * The origins line beneath the header is the link back: the conversations that
 * wrote this file, read from their own history (`artifacts:origins`) rather than
 * from anything this page keeps.
 */

import * as React from 'react'
import { ArrowLeft, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { DrawioEditorPane, useDrawioOrigin } from '@craft-agent/ui'
import { artifactAbsolutePath } from '@craft-agent/shared/artifacts'
import type { ArtifactOrigin } from '@craft-agent/shared/artifacts'
import { useNavigation } from '@/contexts/NavigationContext'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import { artifactsAtom } from '@/atoms/artifacts'
import { sessionMetaMapAtom } from '@/atoms/sessions'

interface ArtifactViewProps {
  /** Workspace-relative path, POSIX separators — the artifact's identity. */
  relativePath: string
}

export function ArtifactView({ relativePath }: ArtifactViewProps) {
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const workspace = useActiveWorkspace()
  const artifacts = useAtomValue(artifactsAtom)
  const sessionMeta = useAtomValue(sessionMetaMapAtom)
  const { origin, problem: originProblem } = useDrawioOrigin()
  const dark = document.documentElement.classList.contains('dark')
  const [origins, setOrigins] = React.useState<ArtifactOrigin[]>([])

  // The list is the title's one home; if this path is no longer in it (the file was
  // renamed or deleted under the page) fall back to the file's own name, never a blank.
  const title = React.useMemo(
    () => artifacts.find(artifact => artifact.path === relativePath)?.title ?? fileNameWithoutExtension(relativePath),
    [artifacts, relativePath],
  )

  // Re-read the origins when the file itself changes: the watcher's push carries the new
  // mtime, so the line follows a write the same way the list does, without its own watcher.
  const mtimeMs = artifacts.find(artifact => artifact.path === relativePath)?.mtimeMs
  const workspaceId = workspace?.id ?? null

  React.useEffect(() => {
    if (!workspaceId) {
      setOrigins([])
      return
    }
    let cancelled = false
    window.electronAPI
      .getArtifactOrigins(workspaceId, relativePath)
      .then((result) => {
        if (!cancelled) setOrigins(Array.isArray(result) ? result : [])
      })
      .catch((err) => {
        console.error('[ArtifactView] Failed to load artifact origins:', err)
        if (!cancelled) setOrigins([])
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, relativePath, mtimeMs])

  const src = workspace ? artifactAbsolutePath(workspace.rootPath, relativePath) : null
  const problem = !workspace
    ? t('artifacts.noWorkspace')
    : originProblem

  const handleBack = React.useCallback(() => navigate(routes.view.artifacts()), [navigate])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header: back, title, where the file lives. */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t('artifacts.backToArtifacts')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Workflow className="h-3.5 w-3.5 shrink-0 text-foreground/60" />
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground/40" title={relativePath}>
          {relativePath}
        </span>
      </div>

      {/* The link back: the conversations that wrote this file. Nothing when nobody
          did — the file may have been made by hand, and a line that said otherwise
          would be a claim the history cannot back. */}
      {origins.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
          <span className="shrink-0 text-[11px] text-foreground/50">{t('artifacts.fromConversations')}</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {origins.map((origin) => {
              const label = originLabel(origin.sessionId, sessionMeta)
              return (
                <button
                  key={origin.sessionId}
                  type="button"
                  onClick={() => navigate(routes.view.allSessions(origin.sessionId))}
                  title={label}
                  className="max-w-[16rem] truncate rounded px-1.5 py-0.5 text-[11px] text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* The editor, filling the rest. */}
      <div className="flex-1 min-h-0 flex flex-col p-3">
        {problem ? (
          <div className="flex flex-1 min-h-0 items-center justify-center px-6 text-center">
            <span className="text-destructive/70 text-[13px]">{problem}</span>
          </div>
        ) : origin && src ? (
          <DrawioEditorPane src={src} origin={origin} dark={dark} title={title} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * What to call an origin conversation: its own title when the app already has one,
 * else its id. A name the session list has not loaded is not worth a fetch for a line
 * of text — the id is still a working link.
 */
function originLabel(sessionId: string, names: ReadonlyMap<string, { name?: string }>): string {
  return names.get(sessionId)?.name ?? sessionId
}

/** The file's own name without its extension — the fallback title. */
function fileNameWithoutExtension(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? relativePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
