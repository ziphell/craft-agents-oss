/**
 * SourceInfoPage
 *
 * Displays source details including connection info, authentication status,
 * documentation (guide.md), and metadata. View-only.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { AlertCircle } from 'lucide-react'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { Button } from '@/components/ui/button'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SourceMenu } from '@/components/app-shell/SourceMenu'
import { cn } from '@/lib/utils'
import { routes, navigate } from '@/lib/navigate'
import { useNavigation } from '@/contexts/NavigationContext'
import { useAskAgent } from '@/hooks/useAskAgent'
import { toast } from 'sonner'
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Alert,
  Info_Markdown,
  PermissionsDataTable,
  ToolsDataTable,
  type PermissionRow,
  type ToolRow,
} from '@/components/info'
import type { LoadedSource, McpToolWithPermission } from '../../shared/types'
import type { PermissionsConfigFile } from '@craft-agent/shared/agent/modes'
import { WEB_SNAPSHOT_FILE, webSnapshotBody } from '@craft-agent/shared/sources/types'

interface SourceInfoPageProps {
  sourceSlug: string
  workspaceId: string
  /** Optional callback when source is deleted */
  onDelete?: () => void
}

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: number | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!timestamp) return t('common.never')

  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return t('common.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: days })
}

/** A byte count in the units a person reads. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Get source URL for display
 */
function getSourceUrl(source: LoadedSource): string | null {
  const { type, mcp, api, local, web } = source.config

  if (type === 'mcp' && mcp?.url) return mcp.url
  if (type === 'api' && api?.baseUrl) return api.baseUrl
  if (type === 'local' && local?.path) return local.path
  if (type === 'web' && web?.url) return web.url

  return null
}

/**
 * Convert permissions config to PermissionRow[] for API/local sources
 */
function buildApiPermissionsData(config: PermissionsConfigFile): PermissionRow[] {
  const rows: PermissionRow[] = []

  // Blocked Tools
  config.blockedTools?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'blocked', type: 'tool', pattern, comment })
  })

  // Allowed Bash Patterns
  config.allowedBashPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'allowed', type: 'bash', pattern, comment })
  })

  // Allowed API Endpoints
  config.allowedApiEndpoints?.forEach((item) => {
    const pattern = `${item.method} ${item.path}`
    const comment = typeof item === 'object' && 'comment' in item ? item.comment : null
    rows.push({ access: 'allowed', type: 'api', pattern, comment })
  })

  return rows
}

/**
 * Convert permissions config to PermissionRow[] for MCP sources
 */
function buildMcpPermissionsData(config: PermissionsConfigFile): PermissionRow[] {
  const rows: PermissionRow[] = []

  // Blocked Tools
  config.blockedTools?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'blocked', type: 'mcp', pattern, comment })
  })

  // Allowed MCP Patterns
  config.allowedMcpPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'allowed', type: 'mcp', pattern, comment })
  })

  return rows
}

/**
 * Convert MCP tools to ToolRow[]
 */
function buildToolsData(tools: McpToolWithPermission[]): ToolRow[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    permission: tool.allowed ? 'allowed' : 'requires-permission',
  }))
}

/**
 * Get contextual description for Connection section based on source type
 */
function getConnectionDescription(source: LoadedSource, t: (key: string) => string): string {
  const { type, mcp } = source.config

  if (type === 'mcp') {
    if (mcp?.transport === 'stdio') {
      return t('sourceInfo.localCommand')
    }
    return t('sourceInfo.serverUrl')
  }
  if (type === 'api') {
    return t('sourceInfo.baseUrl')
  }
  if (type === 'local') {
    return t('sourceInfo.filesystemPath')
  }
  if (type === 'web') {
    return t('sourceInfo.pageUrl')
  }
  return t('sourceInfo.connectionDetails')
}

/**
 * Get contextual description for Permissions section based on source type
 */
function getPermissionsDescription(source: LoadedSource, t: (key: string) => string): string {
  const { type } = source.config

  if (type === 'mcp') {
    return t('sourceInfo.toolPatternsAllowed')
  }
  if (type === 'api') {
    return t('sourceInfo.apiEndpointsAllowed')
  }
  return t('sourceInfo.accessRules')
}

export default function SourceInfoPage({ sourceSlug, workspaceId, onDelete }: SourceInfoPageProps) {
  const { t } = useTranslation()
  const { navigateToSource } = useNavigation()
  const [source, setSource] = useState<LoadedSource | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permissionsConfig, setPermissionsConfig] = useState<PermissionsConfigFile | null>(null)
  const [mcpTools, setMcpTools] = useState<McpToolWithPermission[] | null>(null)
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false)
  const [mcpToolsError, setMcpToolsError] = useState<string | null>(null)
  const [localMcpEnabled, setLocalMcpEnabled] = useState(true)

  /**
   * "Hand it to the conversation", for this page's one agent-backed action: re-taking a web
   * source's snapshot, which needs the browser window and a command. A source belongs to the
   * workspace rather than to a project, so no project is named and any conversation here will do.
   */
  const askAgent = useAskAgent({ name: source?.config.name })


  // Load source data
  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)

    const loadSource = async () => {
      try {
        const sources = await window.electronAPI.getSources(workspaceId)

        if (!isMounted) return

        const found = sources.find((s) => s.config.slug === sourceSlug)
        if (found) {
          setSource(found)

          const config = await window.electronAPI.getSourcePermissionsConfig(workspaceId, sourceSlug)
          if (isMounted) {
            setPermissionsConfig(config)
          }
        } else {
          setError(t('sourceInfo.notFound'))
        }
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : t('sourceInfo.failedToLoad'))
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadSource()

    return () => {
      isMounted = false
    }
  }, [workspaceId, sourceSlug])

  // Load MCP tools when source is loaded and is MCP type
  useEffect(() => {
    if (!source || source.config.type !== 'mcp') {
      setMcpTools(null)
      setMcpToolsError(null)
      return
    }

    let isMounted = true
    setMcpToolsLoading(true)
    setMcpToolsError(null)

    const loadTools = async () => {
      try {
        const result = await window.electronAPI.getMcpTools(workspaceId, sourceSlug)
        if (!isMounted) return

        if (result.success && result.tools) {
          setMcpTools(result.tools)
        } else {
          setMcpToolsError(result.error || t('sourceInfo.failedToLoadTools'))
        }
      } catch (err) {
        if (!isMounted) return
        setMcpToolsError(err instanceof Error ? err.message : t('sourceInfo.failedToLoadTools'))
      } finally {
        if (isMounted) setMcpToolsLoading(false)
      }
    }

    loadTools()

    return () => {
      isMounted = false
    }
  }, [source, workspaceId, sourceSlug])

  // Load workspace settings (for localMcpEnabled)
  useEffect(() => {
    if (!workspaceId) return
    window.electronAPI.getWorkspaceSettings(workspaceId).then((settings) => {
      if (settings) {
        setLocalMcpEnabled(settings.localMcpEnabled ?? true)
      }
    }).catch((err) => {
      console.error('[SourceInfoPage] Failed to load workspace settings:', err)
    })
  }, [workspaceId])

  /**
   * The captured page's own text, read when this page asks for it rather than carried in the
   * sources list: a capture can be a whole article, and the list is read often. The path is what
   * the list carries (`snapshot.path`); the contents are the file's business.
   */
  const [snapshotText, setSnapshotText] = useState<string | null>(null)
  useEffect(() => {
    const path = source?.snapshot?.path
    if (!path) {
      setSnapshotText(null)
      return
    }

    let cancelled = false
    window.electronAPI
      .readFile(path)
      .then((text) => { if (!cancelled) setSnapshotText(text) })
      .catch((err) => {
        console.error('[SourceInfoPage] Failed to read the snapshot:', err)
        if (!cancelled) setSnapshotText(null)
      })

    return () => { cancelled = true }
  }, [source?.snapshot?.path])

  // Listen for source folder changes
  useEffect(() => {
    if (!window.electronAPI?.onSourcesChanged) return

    const cleanup = window.electronAPI.onSourcesChanged((changedWorkspaceId, sources) => {
      if (changedWorkspaceId !== workspaceId) return
      const updated = sources.find((s) => s.config.slug === sourceSlug)

      if (updated) {
        setSource(updated)

        const loadPermissionsConfig = async () => {
          try {
            const config = await window.electronAPI.getSourcePermissionsConfig(workspaceId, sourceSlug)
            setPermissionsConfig(config)
          } catch (err) {
            console.error('[SourceInfoPage] Failed to reload permissions config:', err)
          }
        }
        loadPermissionsConfig()
      }
    })

    return cleanup
  }, [sourceSlug, workspaceId])

  // Compute source URL
  const sourceUrl = useMemo(() => source ? getSourceUrl(source) : null, [source])

  // Build data for PermissionsDataTable
  const apiPermissionsData = useMemo(() => {
    if (!permissionsConfig || source?.config.type === 'mcp') return []
    return buildApiPermissionsData(permissionsConfig)
  }, [permissionsConfig, source])

  const mcpPermissionsData = useMemo(() => {
    if (!permissionsConfig || source?.config.type !== 'mcp') return []
    return buildMcpPermissionsData(permissionsConfig)
  }, [permissionsConfig, source])

  // Build data for ToolsDataTable
  const toolsData = useMemo(() => {
    if (!mcpTools) return []
    return buildToolsData(mcpTools)
  }, [mcpTools])

  /**
   * Hand a target to the app, which is the only place that knows what to do with it: an address
   * goes to the browser, a path to whatever shows that kind of file. One rule, used by the
   * Connection rows and by a link inside a captured page alike.
   */
  const openTarget = useCallback(async (target: string) => {
    if (!window.electronAPI) return
    if (target.startsWith('http://') || target.startsWith('https://')) {
      await window.electronAPI.openUrl(target)
    } else {
      await window.electronAPI.showInFolder(target)
    }
  }, [])

  // Handle opening URL (website or folder)
  const handleOpenUrl = useCallback(async () => {
    if (!source || !sourceUrl) return
    await openTarget(sourceUrl)
  }, [source, sourceUrl, openTarget])

  // Handle opening source folder
  const handleOpenSourceFolder = useCallback(async () => {
    if (!source) return
    if (window.electronAPI) {
      await window.electronAPI.showInFolder(source.folderPath)
    }
  }, [source])

  // Handle deleting source (navigates to source list, preserving current filter)
  const handleDelete = useCallback(async () => {
    if (!source) return
    try {
      await window.electronAPI.deleteSource(workspaceId, sourceSlug)
      toast.success(t('sourceInfo.deletedSource', { name: source.config.name }))
      navigateToSource() // Navigate to source list, preserving filter
      onDelete?.()
    } catch (err) {
      toast.error(t('sourceInfo.failedToDelete'), {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }, [source, workspaceId, sourceSlug, onDelete, navigateToSource])

  // Handle opening in new window
  const handleOpenInNewWindow = useCallback(() => {
    window.electronAPI.openUrl(`craftagents://sources/source/${sourceSlug}?window=focused`)
  }, [sourceSlug])

  /**
   * Reveal the captured page where it lives.
   *
   * The same gesture a local source's path row makes — the payload is a file in the source's own
   * folder, and this app's way of showing you a file is to show you where it is.
   */
  const handleOpenSnapshot = useCallback(() => {
    if (source?.snapshot) window.electronAPI.showInFolder(source.snapshot.path)
  }, [source])

  /**
   * Take the page again — which this page cannot do itself: it needs the browser window, a
   * navigation and a capture, all of which belong to a conversation. So the line goes into a
   * conversation's draft and **nothing is sent on its own** (`useAskAgent`), the same rule the
   * project page's notices follow.
   */
  const handleRefreshSnapshot = useCallback(() => {
    const url = source?.config.web?.url
    if (!source || !url) return
    void askAgent(
      `Refresh the snapshot of ${source.config.name}: open ${url} in the browser window and ` +
        `capture it again with browser_tool read --save sources/${source.config.slug}/${WEB_SNAPSHOT_FILE}.`,
    )
  }, [source, askAgent])

  // Get source name for header
  const sourceName = source?.config.name || sourceSlug

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!source && !loading && !error ? t('sourceInfo.notFound') : undefined}
    >
      <Info_Page.Header
        title={sourceName}
        titleMenu={
          <SourceMenu
            sourceSlug={sourceSlug}
            sourceName={sourceName}
            onOpenInNewWindow={handleOpenInNewWindow}
            onShowInFinder={handleOpenSourceFolder}
            onDelete={handleDelete}
          />
        }
      />

      {source && (
        <Info_Page.Content>
          {/* Hero: Avatar, title, and tagline */}
          <Info_Page.Hero
            avatar={<SourceAvatar source={source} fluid />}
            title={source.config.name}
            tagline={source.config.tagline}
          />

          {/* Disabled Warning */}
          {source.config.mcp?.transport === 'stdio' && !localMcpEnabled && (
            <Info_Alert variant="warning" icon={<AlertCircle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('sourceInfo.sourceDisabled')}</Info_Alert.Title>
              <Info_Alert.Description>
                {t('sourceInfo.localMcpDisabled')}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* Connection */}
          <Info_Section
            title={t('sourceInfo.connection')}
            description={getConnectionDescription(source, t)}
            actions={
              // EditPopover for AI-assisted config.json editing with "Edit File" as secondary action
              <EditPopover
                trigger={<EditButton />}
                {...getEditConfig('source-config', source.folderPath)}
                secondaryAction={{
                  label: t('common.editFile'),
                  filePath: `${source.folderPath}/config.json`,
                }}
              />
            }
          >
            <Info_Table
              footer={source.config.connectionError && (
                <div className="px-4 py-2 border-t border-border/30 bg-destructive/5">
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{source.config.connectionError}</span>
                  </div>
                </div>
              )}
            >
              <Info_Table.Row label={t('common.type')} value={source.config.type.toUpperCase()} />
              {sourceUrl && (
                <Info_Table.Row label={t('common.url')}>
                  <button
                    onClick={handleOpenUrl}
                    className="truncate hover:underline text-foreground focus:outline-none focus-visible:underline text-left block w-full"
                  >
                    {sourceUrl}
                  </button>
                </Info_Table.Row>
              )}
              {/* A web source has no server, so "last tested" would only ever read "never". */}
              {source.config.type !== 'web' && (
                <Info_Table.Row label={t('sourceInfo.lastTested')} value={formatRelativeTime(source.config.lastTestedAt, t)} />
              )}
            </Info_Table>
          </Info_Section>

          {/* Snapshot - what a web source is for: the page as it was captured */}
          {source.config.type === 'web' && (
            <>
              <Info_Section
                title={t('sourceInfo.snapshot')}
                description={source.snapshot ? t('sourceInfo.snapshotDesc') : t('sourceInfo.snapshotMissing')}
                bare={!source.snapshot}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshSnapshot}
                    className={cn(
                      'h-8 px-3 rounded-[6px] bg-background shadow-minimal text-foreground/70 hover:text-foreground',
                    )}
                  >
                    {t('sourceInfo.refreshSnapshot')}
                  </Button>
                }
              >
                {source.snapshot ? (
                  <Info_Table>
                    {source.snapshot.title && (
                      <Info_Table.Row label={t('sourceInfo.snapshotTitle')}>
                        {source.snapshot.title}
                      </Info_Table.Row>
                    )}
                    {source.snapshot.meta?.author && (
                      <Info_Table.Row label={t('sourceInfo.snapshotAuthor')}>
                        {source.snapshot.meta.author}
                      </Info_Table.Row>
                    )}
                    {source.snapshot.meta?.published && (
                      <Info_Table.Row label={t('sourceInfo.snapshotPublished')}>
                        {source.snapshot.meta.published}
                      </Info_Table.Row>
                    )}
                    {source.snapshot.meta?.wordCount !== undefined && (
                      <Info_Table.Row
                        label={t('sourceInfo.snapshotWords')}
                        value={String(source.snapshot.meta.wordCount)}
                      />
                    )}
                    <Info_Table.Row label={t('sourceInfo.snapshotFile')}>
                      <button
                        onClick={handleOpenSnapshot}
                        className="truncate hover:underline text-foreground focus:outline-none focus-visible:underline text-left block w-full"
                      >
                        {WEB_SNAPSHOT_FILE}
                      </button>
                    </Info_Table.Row>
                    <Info_Table.Row
                      label={t('sourceInfo.snapshotCaptured')}
                      value={`${formatSize(source.snapshot.bytes)} · ${formatRelativeTime(source.snapshot.writtenAt, t)}`}
                    />
                    {source.snapshot.imageCount > 0 && (
                      <Info_Table.Row
                        label={t('sourceInfo.snapshotImages')}
                        value={String(source.snapshot.imageCount)}
                      />
                    )}
                  </Info_Table>
                ) : null}
              </Info_Section>

              {/*
                The capture itself, rendered — the point of keeping it, and the same treatment a
                skill's instructions get (`Info_Markdown`, capped, expandable). `baseDir` is the
                source's folder, because the note's pictures were rewritten to sit beside it
                (`snapshot.assets/…`), and that is what resolves them; a link goes to the app, the
                way the Connection rows hand theirs over.
              */}
              {source.snapshot && snapshotText !== null && (
                <Info_Section title={t('sourceInfo.snapshotPage')}>
                  <Info_Markdown
                    maxHeight={540}
                    fullscreen
                    baseDir={source.folderPath}
                    onFileClick={openTarget}
                    onUrlClick={openTarget}
                  >
                    {webSnapshotBody(snapshotText).trim() || t('sourceInfo.snapshotEmpty')}
                  </Info_Markdown>
                </Info_Section>
              )}
            </>
          )}

          {/* Permissions - for API and local sources */}
          {source.config.type !== 'mcp' && permissionsConfig && apiPermissionsData.length > 0 && (
            <Info_Section
              title={t('sourceInfo.permissions')}
              description={getPermissionsDescription(source, t)}
              actions={
                // EditPopover for AI-assisted permissions.json editing
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('source-permissions', source.folderPath)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: `${source.folderPath}/permissions.json`,
                  }}
                />
              }
            >
              <PermissionsDataTable data={apiPermissionsData} fullscreen fullscreenTitle="Permissions" />
            </Info_Section>
          )}

          {/* Tools - for MCP sources */}
          {source.config.type === 'mcp' && (
            <Info_Section
              title={t('sourceInfo.tools')}
              description={t('sourceInfo.toolsDesc')}
              actions={
                // EditPopover for AI-assisted tool permissions editing
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('source-tool-permissions', source.folderPath)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: `${source.folderPath}/permissions.json`,
                  }}
                />
              }
            >
              <ToolsDataTable
                data={toolsData}
                loading={mcpToolsLoading}
                error={mcpToolsError ?? undefined}
              />
            </Info_Section>
          )}

          {/* Permissions - for MCP sources */}
          {source.config.type === 'mcp' && permissionsConfig && mcpPermissionsData.length > 0 && (
            <Info_Section
              title={t('sourceInfo.permissions')}
              description={getPermissionsDescription(source, t)}
              actions={
                // EditPopover for AI-assisted permissions.json editing
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('source-permissions', source.folderPath)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: `${source.folderPath}/permissions.json`,
                  }}
                />
              }
            >
              <PermissionsDataTable data={mcpPermissionsData} hideTypeColumn fullscreen fullscreenTitle="Permissions" />
            </Info_Section>
          )}

          {/* Documentation */}
          {source.guide?.raw && (
            <Info_Section
              title={t('sourceInfo.documentation')}
              description={t('sourceInfo.documentationDesc')}
              actions={
                // EditPopover for AI-assisted guide.md editing with "Edit File" as secondary action
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('source-guide', source.folderPath)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: `${source.folderPath}/guide.md`,
                  }}
                />
              }
            >
              <Info_Markdown maxHeight={540} fullscreen>
                {source.guide.raw}
              </Info_Markdown>
            </Info_Section>
          )}
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}
