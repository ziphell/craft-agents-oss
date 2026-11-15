/**
 * Drafts: a media card being composed, before it is a file.
 *
 * A draft is the one place a generation is described — kind, prompt, account, model, parameters,
 * references. It is client state, not a project record: `sessionStorage` survives a reload and a
 * view switch, and disappears with the window, which is exactly the lifetime of something that is
 * still being written. Once a run starts, the task and the library index own the asset and the
 * draft goes.
 *
 * The state lives here rather than inside the board because the composer is not the board's: the
 * library's grid and the board are two views of one collection, and a person may start a card in
 * either. Both call into this hook, so there is one draft per draft — not one per view.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileText, Image as ImageIcon, Music2, Video as VideoIcon } from 'lucide-react'
import type { LibraryAsset } from '@craft-agent/shared/library'
import {
  paramSpecsOf,
  paramsForModel,
  pruneParams,
  withParamDefaults,
} from '@craft-agent/shared/media/params'
import { modelMode, paramsForMode, videoEditProblem } from '@craft-agent/shared/media/modes'
import { isSubtitleFile } from '@craft-agent/shared/media/file-kind'
import type { MediaKind } from '@craft-agent/shared/media/channels'
import { getOmniModel, getVisionModel, modelSupportsImages, resolveEffectiveConnectionSlug } from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

export type DraftKind = 'image' | 'video' | 'audio' | 'text'

export interface Draft {
  /** A session-local key; never written anywhere. */
  id: string
  kind: DraftKind
  x: number
  y: number
  w: number
  h: number
  z: number
  prompt: string
  channelId: string | null
  modelId: string | null
  params: Record<string, string | number>
  references: string[]
  /** Pictures with a role, not numbered references. Only video drafts use them. */
  firstFrame: string | null
  lastFrame: string | null
  /**
   * The text node this card reads.
   *
   * Music takes it as the lyrics; image and video take it as context prepended to the prompt. It is
   * one node, not part of the numbered media references, so a shared brief stays a shared brief.
   */
  textSource: string | null
  /**
   * The text draft a port is waiting for.
   *
   * One click from an empty port creates that node; when it finishes, its file becomes the port's
   * source and this marker clears. Until then the port says it is waiting, rather than pretending
   * to have text.
   */
  pendingTextFrom?: string | null
  generating: boolean
}

export const DRAFT_KINDS: DraftKind[] = ['image', 'video', 'audio', 'text']

export const DRAFT_SIZE: Record<DraftKind, { w: number; h: number }> = {
  image: { w: 260, h: 180 },
  video: { w: 280, h: 180 },
  audio: { w: 280, h: 112 },
  text: { w: 320, h: 200 },
}

export const DRAFT_ICON: Record<DraftKind, React.ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: Music2,
  text: FileText,
}

export type MediaChannel = Awaited<ReturnType<typeof window.electronAPI.mediaChannels>>['channels'][number]

export interface MediaCapability {
  id: string
  name: string
  kind: DraftKind
  models: string[]
  defaultModel?: string
  paramSpecs?: ReturnType<typeof paramSpecsOf>
  modelModes?: Record<string, 'generate' | 'video-edit'>
  /** `lyrics` means the composer's main text is the lyrics, not a prompt. */
  textRole?: 'lyrics'
  enabled?: boolean
  hasKey?: boolean
}

export type LlmConnection = Awaited<ReturnType<typeof window.electronAPI.listLlmConnectionsWithStatus>>[number]

const DRAFT_CACHE_VERSION = 1
const DRAFT_CACHE_MAX = 20
const DRAFT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function draftCacheKey(projectFolder: string): string {
  return `craft:asset-board:drafts:${projectFolder.replace(/[\\/]+$/, '')}`
}

function isDraftKind(value: unknown): value is DraftKind {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'text'
}

function readDraftParams(value: unknown): Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const params: Record<string, string | number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (!key || key.length > 64) continue
    if (typeof entry === 'string' && entry.length <= 200) params[key] = entry
    else if (typeof entry === 'number' && Number.isFinite(entry)) params[key] = entry
  }
  return params
}

function readDraftCache(key: string): Draft[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: unknown; updatedAt?: unknown; drafts?: unknown }
    if (parsed.version !== DRAFT_CACHE_VERSION || !Array.isArray(parsed.drafts)) return []
    if (typeof parsed.updatedAt === 'number' && Date.now() - parsed.updatedAt > DRAFT_CACHE_MAX_AGE_MS) {
      window.sessionStorage.removeItem(key)
      return []
    }
    const seen = new Set<string>()
    const drafts: Draft[] = []
    for (const value of parsed.drafts.slice(0, DRAFT_CACHE_MAX)) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      if (!isDraftKind(record.kind)) continue
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (!id || seen.has(id)) continue
      const size = DRAFT_SIZE[record.kind]
      const finite = (candidate: unknown, fallback: number) =>
        typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback
      const firstFrame = typeof record.firstFrame === 'string' ? record.firstFrame : null
      const lastFrame = typeof record.lastFrame === 'string' ? record.lastFrame : null
      const references = Array.isArray(record.references)
        ? [
            ...new Set(
              record.references.filter(
                (ref): ref is string =>
                  typeof ref === 'string' && !!ref && ref !== firstFrame && ref !== lastFrame,
              ),
            ),
          ].slice(0, record.kind === 'text' ? 1 : 16)
        : []
      seen.add(id)
      drafts.push({
        id,
        kind: record.kind,
        x: Math.max(-100_000, Math.min(100_000, finite(record.x, 0))),
        y: Math.max(-100_000, Math.min(100_000, finite(record.y, 0))),
        w: Math.min(2400, Math.max(160, finite(record.w, size.w))),
        h: Math.min(2400, Math.max(100, finite(record.h, size.h))),
        z: 2000 + drafts.length,
        prompt: typeof record.prompt === 'string' ? record.prompt.slice(0, 4000) : '',
        channelId: typeof record.channelId === 'string' ? record.channelId : null,
        modelId: typeof record.modelId === 'string' ? record.modelId : null,
        params: readDraftParams(record.params),
        references,
        firstFrame,
        lastFrame,
        textSource: typeof record.textSource === 'string' ? record.textSource : null,
        pendingTextFrom:
          typeof record.pendingTextFrom === 'string' ? record.pendingTextFrom : null,
        generating: false,
      })
    }
    return drafts
  } catch {
    return []
  }
}

function writeDraftCache(key: string, drafts: readonly Draft[]): void {
  if (typeof window === 'undefined') return
  try {
    const stored = drafts
      .filter((draft) => !draft.generating)
      .slice(0, DRAFT_CACHE_MAX)
      .map(
        ({
          id,
          kind,
          x,
          y,
          w,
          h,
          prompt,
          channelId,
          modelId,
          params,
          references,
          firstFrame,
          lastFrame,
          textSource,
          pendingTextFrom,
        }) => ({
          id,
          kind,
          x,
          y,
          w,
          h,
          prompt,
          channelId,
          modelId,
          params,
          references,
          firstFrame,
          lastFrame,
          textSource,
          pendingTextFrom,
        }),
      )
    if (!stored.length) {
      window.sessionStorage.removeItem(key)
      return
    }
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ version: DRAFT_CACHE_VERSION, updatedAt: Date.now(), drafts: stored }),
    )
  } catch {
    // Storage can be unavailable; the in-memory drafts still work.
  }
}

/**
 * The generation kind a card asks for.
 *
 * An `audio` card is a music card: speech is the TTS flow beside the library, not a media
 * generation. `text` asks a language model, which is a different door entirely.
 */
const mediaKindOfDraft = (kind: DraftKind): MediaKind | null =>
  kind === 'text' ? null : kind === 'audio' ? 'music' : kind

/** One account as the draft's kind sees it: its endpoint, flattened. */
export function capabilityFor(channel: MediaChannel, kind: DraftKind): MediaCapability | null {
  const wanted = mediaKindOfDraft(kind)
  if (!wanted) return null
  const endpoints = channel.endpoints?.length
    ? channel.endpoints
    : [
        {
          kind: (channel.kind ?? 'image') as MediaKind,
          models: channel.models,
          defaultModel: channel.defaultModel,
          modelModes: channel.modelModes,
          paramSpecs: channel.paramSpecs,
          options: channel.options,
          params: channel.params,
          textRole: channel.textRole,
        },
      ]
  const endpoint = endpoints.find((entry) => entry.kind === wanted)
  if (!endpoint) return null
  return {
    id: channel.id,
    name: channel.name,
    kind,
    models: endpoint.models,
    defaultModel: endpoint.defaultModel,
    paramSpecs: paramSpecsOf(endpoint),
    modelModes: endpoint.modelModes,
    textRole: endpoint.textRole,
    enabled: channel.enabled,
    hasKey: channel.hasKey,
  }
}

export function modelIdsOf(connection: LlmConnection): string[] {
  const ids = (connection.models ?? [])
    .map((model) => (typeof model === 'string' ? model : model.id))
    .filter((id): id is string => typeof id === 'string' && !!id)
  const vision = connection.visionModel?.trim()
  if (vision && !ids.includes(vision)) ids.unshift(vision)
  const fast = connection.fastModel?.trim()
  if (fast && !ids.includes(fast)) ids.unshift(fast)
  const omni = getOmniModel(connection)
  if (omni && !ids.includes(omni)) ids.push(omni)
  const fallback = connection.defaultModel?.trim()
  if (fallback && !ids.includes(fallback)) ids.push(fallback)
  return ids
}

/**
 * Models on this connection a picture may be sent to, in the order the composer offers them: the
 * explicit vision role first, then the connection's own default model, then the rest.
 *
 * Capability is the shared fact (`modelSupportsImages`): an explicit `false` excludes a model, an
 * unmarked one counts as able to see — authoritative on a custom endpoint (this app's own model
 * definition declares image input) and the upstream default on a built-in catalog. This is a
 * display policy, not automatic routing: `resolveImageModel` never guesses a cheap small model,
 * and the list does not reuse that rule, or a built-in connection would always be empty.
 */
export function imageModelsFor(connection: LlmConnection): string[] {
  const listed = (connection.models ?? [])
    .map((model) => (typeof model === 'string' ? model : model.id))
    .filter((id): id is string => typeof id === 'string' && !!id)
  // The roles the connection names are worth offering even when they are stored outside the list;
  // the omni role is not injected: it means "listens", and a picture pick needs `visionModel`.
  const preferred = [getVisionModel(connection), connection.defaultModel?.trim()].filter(
    (id): id is string => !!id,
  )
  return [...new Set([...preferred, ...listed])].filter((id) =>
    modelSupportsImages(connection, id),
  )
}

/**
 * The connection a text card speaks through, by the same fallback chain the rest of the app uses
 * (`resolveEffectiveConnectionSlug`): the card's own pick, the workspace default, the global
 * default, then the first connection. One function for both the composer and the run, so what the
 * form shows and what gets sent cannot be two different connections.
 */
export function pickTextConnection(
  connections: LlmConnection[],
  channelId: string | null | undefined,
  workspaceDefault?: string,
): LlmConnection | null {
  const slug = resolveEffectiveConnectionSlug(channelId ?? undefined, workspaceDefault, connections)
  // A stored pick may name a connection that has since been deleted; fall through to the rest of
  // the chain rather than showing a card with no model.
  return (
    connections.find((connection) => connection.slug === slug) ??
    connections.find((connection) => connection.isDefault) ??
    connections[0] ??
    null
  )
}

const absolute = (projectFolder: string, relative: string): string =>
  `${projectFolder.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`

/**
 * The project-relative path of a file the server named.
 *
 * A sound answer may arrive in a different container than the one asked for — a speech or music
 * channel can return WAV for an `mp3` request — and the server renames the file to match its
 * bytes. The card has to follow the file that actually landed, or the layout would point at a
 * name that never existed and the real one would appear at the default spot.
 */
const projectRelative = (projectFolder: string, absolutePath: string): string => {
  const root = projectFolder.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = absolutePath.replace(/\\/g, '/')
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : absolutePath
}

export interface AssetLayout {
  x: number
  y: number
  w: number
  h: number
  z: number
}

interface UseAssetDraftsOptions {
  projectFolder: string
  /** Every asset, so a reference (or a frame) can be resolved by path. */
  libraryAssets: LibraryAsset[]
  onLayoutChange: (assetPath: string, layout: AssetLayout | null) => void | Promise<void>
  onRefresh: () => void | Promise<void>
}

export function useAssetDrafts({
  projectFolder,
  libraryAssets,
  onLayoutChange,
  onRefresh,
}: UseAssetDraftsOptions) {
  const { t } = useTranslation()
  // The same workspace default the session composer follows; absent outside the app shell.
  const workspaceDefaultLlmConnection = useOptionalAppShellContext()?.workspaceDefaultLlmConnection
  const draftCache = React.useMemo(() => draftCacheKey(projectFolder), [projectFolder])
  const [drafts, setDrafts] = React.useState<Draft[]>(() => readDraftCache(draftCache))
  const draftsRef = React.useRef(drafts)
  draftsRef.current = drafts
  const [selectedDraftId, setSelectedDraftId] = React.useState<string | null>(null)
  const [channels, setChannels] = React.useState<MediaChannel[]>([])
  const [llmConnections, setLlmConnections] = React.useState<LlmConnection[]>([])

  // A draft survives a reload and a view switch, and leaves with the window. The cache is written
  // a beat after typing stops, and flushed on the way out.
  React.useEffect(() => {
    const timer = setTimeout(() => writeDraftCache(draftCache, drafts), 300)
    return () => clearTimeout(timer)
  }, [draftCache, drafts])

  React.useEffect(() => {
    const flush = () => writeDraftCache(draftCache, draftsRef.current)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [draftCache])

  // The channels are what the composer picks a model from; one read is enough for the session.
  React.useEffect(() => {
    void window.electronAPI
      .mediaChannels()
      .then((reply) => setChannels(reply.channels ?? []))
      .catch(() => setChannels([]))
    void window.electronAPI
      .listLlmConnectionsWithStatus()
      .then((connections) => setLlmConnections(connections ?? []))
      .catch(() => setLlmConnections([]))
  }, [])

  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? null

  const updateDraft = React.useCallback((id: string, patch: Partial<Draft>) => {
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)))
  }, [])

  /**
   * A new draft: `center` is where its middle should land in board coordinates. Asked from the
   * board, that is the middle of what is on screen; asked from the grid, there is no view, so it
   * starts near the origin and the board will show it when the person looks.
   */
  const createDraft = React.useCallback(
    (kind: DraftKind, center?: { x: number; y: number }) => {
      const size = DRAFT_SIZE[kind]
      const offset = drafts.length * 18
      const at = center ?? { x: size.w / 2 + 24, y: size.h / 2 + 24 }
      const id = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      setDrafts((current) => [
        ...current,
        {
          id,
          kind,
          x: Math.round(at.x - size.w / 2 + offset),
          y: Math.round(at.y - size.h / 2 + offset),
          w: size.w,
          h: size.h,
          z: 2000 + offset,
          prompt: '',
          channelId: null,
          modelId: null,
          params: {},
          references: [],
          firstFrame: null,
          lastFrame: null,
          textSource: null,
          pendingTextFrom: null,
          generating: false,
        },
      ])
      setSelectedDraftId(id)
      return id
    },
    [drafts.length],
  )

  const removeDraft = React.useCallback((id: string) => {
    setDrafts((current) =>
      current
        .filter((draft) => draft.id !== id)
        // A card waiting on this node is no longer waiting on anything.
        .map((draft) =>
          draft.pendingTextFrom === id ? { ...draft, pendingTextFrom: null } : draft,
        ),
    )
    setSelectedDraftId((current) => (current === id ? null : current))
  }, [])

  /**
   * Put removed cards back exactly as they were.
   *
   * A draft is the one board object with no file behind it, so Delete would otherwise be the only
   * action that destroys content outright. The board keeps the removed cards for one undo step.
   */
  const restoreDrafts = React.useCallback((entries: Draft[]) => {
    if (!entries.length) return
    setDrafts((current) => {
      const alive = new Set(current.map((draft) => draft.id))
      const restored = entries.filter((draft) => !alive.has(draft.id))
      return restored.length ? [...current, ...restored] : current
    })
  }, [])

  const setDraftParam = React.useCallback(
    (id: string, key: string, value: string | number | undefined) => {
      setDrafts((current) =>
        current.map((draft) => {
          if (draft.id !== id) return draft
          const params = { ...draft.params }
          if (value === undefined) delete params[key]
          else params[key] = value
          return { ...draft, params }
        }),
      )
    },
    [],
  )

  const setTextSource = React.useCallback((id: string, path: string | null) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === id ? { ...draft, textSource: path, pendingTextFrom: null } : draft,
      ),
    )
  }, [])

  const toggleReference = React.useCallback((id: string, path: string) => {
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.id !== id) return draft
        if (draft.references.includes(path)) {
          return { ...draft, references: draft.references.filter((entry) => entry !== path) }
        }
        return {
          ...draft,
          references: [...draft.references, path],
          firstFrame: draft.firstFrame === path ? null : draft.firstFrame,
          lastFrame: draft.lastFrame === path ? null : draft.lastFrame,
        }
      }),
    )
  }, [])

  const moveReference = React.useCallback((id: string, from: number, to: number) => {
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.id !== id) return draft
        if (from < 0 || to < 0 || from >= draft.references.length || to >= draft.references.length) {
          return draft
        }
        const references = [...draft.references]
        const [moved] = references.splice(from, 1)
        if (moved === undefined) return draft
        references.splice(to, 0, moved)
        return { ...draft, references }
      }),
    )
  }, [])

  const setFrame = React.useCallback((id: string, role: 'first' | 'last', path: string | null) => {
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.id !== id) return draft
        let firstFrame = role === 'first' ? path : draft.firstFrame
        let lastFrame = role === 'last' ? path : draft.lastFrame
        if (path && path === (role === 'first' ? lastFrame : firstFrame)) {
          if (role === 'first') lastFrame = null
          else firstFrame = null
        }
        return {
          ...draft,
          firstFrame,
          lastFrame,
          references: path ? draft.references.filter((entry) => entry !== path) : draft.references,
        }
      }),
    )
  }, [])

  const swapFrames = React.useCallback((id: string) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === id ? { ...draft, firstFrame: draft.lastFrame, lastFrame: draft.firstFrame } : draft,
      ),
    )
  }, [])

  // A new draft gets the first account that can make its kind (and has a key).
  React.useEffect(() => {
    if (!selectedDraft) return
    const usable = channels
      .map((channel) => ({ channel, capability: capabilityFor(channel, selectedDraft.kind) }))
      .filter((entry): entry is { channel: MediaChannel; capability: MediaCapability } => !!entry.capability)
    if (!usable.length) return
    if (usable.some((entry) => entry.channel.id === selectedDraft.channelId)) return
    const first = usable.find((entry) => entry.channel.enabled !== false && entry.channel.hasKey !== false) ?? usable[0]
    updateDraft(selectedDraft.id, {
      channelId: first.channel.id,
      modelId: first.capability.defaultModel ?? first.capability.models[0] ?? null,
    })
  }, [channels, selectedDraft, updateDraft])

  // A text draft asks the workspace's language model: the card's pick, else the same default
  // chain the session composer follows.
  React.useEffect(() => {
    if (!selectedDraft || selectedDraft.kind !== 'text' || !llmConnections.length) return
    if (llmConnections.some((connection) => connection.slug === selectedDraft.channelId)) return
    const first = pickTextConnection(
      llmConnections,
      selectedDraft.channelId,
      workspaceDefaultLlmConnection,
    )
    if (!first) return
    const kinds = new Set(
      selectedDraft.references.map(
        (path) => libraryAssets.find((asset) => asset.path === path)?.kind,
      ),
    )
    updateDraft(selectedDraft.id, {
      channelId: first.slug,
      modelId:
        kinds.has('audio') || kinds.has('video')
          ? (getOmniModel(first) ?? null)
          : kinds.has('image')
            ? (imageModelsFor(first)[0] ?? null)
            : (first.fastModel ?? first.defaultModel ?? modelIdsOf(first)[0] ?? null),
    })
  }, [libraryAssets, llmConnections, selectedDraft, updateDraft, workspaceDefaultLlmConnection])

  /**
   * A text draft: the prompt goes to the workspace's model, the answer becomes a markdown asset.
   *
   * The composer never edits the answer; the card renders it with Tiptap after a reload.
   */
  const generateTextDraft = React.useCallback(
    async (draft: Draft) => {
      if (draft.generating) return
      const prompt = draft.prompt.trim()
      if (!prompt) {
        toast.error(t('canvas.promptRequired'))
        return
      }
      const connection = pickTextConnection(
        llmConnections,
        draft.channelId,
        workspaceDefaultLlmConnection,
      )
      if (!connection) {
        toast.error(t('canvas.noChannel'))
        return
      }

      // Every ready reference travels together: pictures to the vision chain, a recording or clip to
      // the omni model. One still generating is left out rather than sent as a missing file.
      const references = draft.references
        .map((path) => libraryAssets.find((asset) => asset.path === path && asset.status === 'ready'))
        .filter((asset): asset is LibraryAsset => !!asset)
      const hasAudioVideo = references.some(
        (asset) => asset.kind === 'audio' || asset.kind === 'video',
      )
      const hasImageRefs = references.some((asset) => asset.kind === 'image')
      // The same list the composer offers: every model this connection declares can see, with the
      // vision role first. An omni pick on a connection whose wire cannot carry audio is no pick.
      const imageModels = hasImageRefs ? imageModelsFor(connection) : []
      const omniModel = getOmniModel(connection)
      if (hasAudioVideo && !omniModel) {
        // No implicit route: sound and video are answered by the omni role or not at all.
        toast.error(t('canvas.omniRequired'))
        return
      }
      if (!hasAudioVideo && hasImageRefs && imageModels.length === 0) {
        toast.error(t('canvas.visionRequired'))
        return
      }
      const model = hasAudioVideo
        ? omniModel
        : hasImageRefs
          ? draft.modelId && imageModels.includes(draft.modelId)
            ? draft.modelId
            : imageModels[0]
          : (draft.modelId ??
            connection.fastModel ??
            connection.defaultModel ??
            modelIdsOf(connection)[0])
      if (!model) {
        toast.error(t('canvas.noChannel'))
        return
      }

      const slug =
        prompt
          .slice(0, 32)
          .replace(/[\\/:*?"<>|\s]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'text'
      const outRel = `assets/${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.md`

      updateDraft(draft.id, { generating: true })
      writeDraftCache(
        draftCache,
        draftsRef.current.filter((entry) => entry.id !== draft.id),
      )
      try {
        await onLayoutChange(outRel, { x: draft.x, y: draft.y, w: draft.w, h: draft.h, z: draft.z })
        const reply = await window.electronAPI.llmComplete({
          prompt,
          ...(references.length
            ? { paths: references.map((asset) => absolute(projectFolder, asset.path)) }
            : {}),
          connectionSlug: connection.slug,
          ...(model ? { model } : {}),
        })
        if (!reply.ok || !reply.text) {
          toast.error(reply.message ?? t('canvas.generateFailed'))
          updateDraft(draft.id, { generating: false })
          await onLayoutChange(outRel, null)
          return
        }
        const file = absolute(projectFolder, outRel)
        await window.electronAPI.writeFile(file, `${reply.text.trim()}\n`)
        try {
          await window.electronAPI.writeFile(
            `${file}.gen.json`,
            `${JSON.stringify(
              {
                file: outRel,
                prompt,
                references: references.map((asset) => asset.path),
                channel: connection.name,
                model: reply.model ?? model ?? null,
                ...(reply.via ? { via: reply.via } : {}),
                at: Date.now(),
              },
              null,
              2,
            )}\n`,
          )
        } catch {
          // The text is the answer; a note that cannot be written is lost provenance, not a
          // failed run.
        }
        // A card may be waiting for this node at its text port.
        setDrafts((current) =>
          current.map((entry) =>
            entry.pendingTextFrom === draft.id
              ? { ...entry, textSource: outRel, pendingTextFrom: null }
              : entry,
          ),
        )
        removeDraft(draft.id)
        await onRefresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        updateDraft(draft.id, { generating: false })
        await onLayoutChange(outRel, null)
      }
    },
    [draftCache, libraryAssets, llmConnections, onLayoutChange, onRefresh, projectFolder, removeDraft, t, updateDraft, workspaceDefaultLlmConnection],
  )

  /**
   * Turn a draft into a real asset.
   *
   * The filename is allocated before the request, so the card has a path and a place from the
   * first moment; the file itself arrives later and the registry reports its state.
   */
  const generateDraft = React.useCallback(
    async (draft: Draft) => {
      if (draft.kind === 'text') {
        await generateTextDraft(draft)
        return
      }
      if (draft.generating) return
      const prompt = draft.prompt.trim()
      if (!prompt) {
        toast.error(t('canvas.promptRequired'))
        return
      }
      const channel =
        channels.find((candidate) => candidate.id === draft.channelId) ??
        channels.find((candidate) => capabilityFor(candidate, draft.kind))
      const capability = channel ? capabilityFor(channel, draft.kind) : null
      if (!channel || !capability) {
        toast.error(t('canvas.noChannel'))
        return
      }
      const model = draft.modelId ?? capability.defaultModel ?? capability.models[0]
      if (!model) {
        toast.error(t('canvas.noChannel'))
        return
      }

      const frameAsset = (path: string | null) =>
        path
          ? libraryAssets.find(
              (asset) => asset.path === path && asset.status === 'ready' && asset.kind === 'image',
            )
          : undefined
      const firstFrame = frameAsset(draft.firstFrame)?.path
      const lastFrame = frameAsset(draft.lastFrame)?.path
      const framePaths = new Set([firstFrame, lastFrame].filter((path): path is string => !!path))
      const references = draft.references
        .filter((path) => !framePaths.has(path))
        .map((path) => libraryAssets.find((asset) => asset.path === path))
        .filter(
          (asset): asset is LibraryAsset =>
            !!asset &&
            asset.status === 'ready' &&
            (asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio'),
        )
      const ext = draft.kind === 'video' ? 'mp4' : draft.kind === 'audio' ? 'mp3' : 'png'
      const slug =
        prompt
          .slice(0, 32)
          .replace(/[\\/:*?"<>|\s]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'asset'
      const outRel = `assets/${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`

      const mode = modelMode(capability, model)
      const specs = paramsForMode(paramsForModel(capability.paramSpecs, model), mode)
      const effectiveParams = withParamDefaults(specs, pruneParams(draft.params, specs))
      // The text port: music reads it as the lyrics; image and video read it as context prepended
      // to the prompt. A subtitle is not prose and no provider takes one as text, so it is not
      // offered here; the file is read before the card is claimed, so a broken link refuses here.
      const textAsset = draft.textSource
        ? libraryAssets.find(
            (asset) =>
              asset.path === draft.textSource &&
              asset.status === 'ready' &&
              asset.kind === 'text' &&
              !isSubtitleFile(asset.path),
          )
        : undefined
      const wantsLyrics = specs.some((spec) => spec.key === 'lyrics')
      let portText = ''
      if (textAsset) {
        try {
          portText = (
            await window.electronAPI.readFile(absolute(projectFolder, textAsset.path))
          ).trim()
        } catch {
          toast.error(t('canvas.readFailed'))
          return
        }
      }
      if (wantsLyrics) {
        if (!portText) {
          toast.error(t('canvas.lyricsRequired'))
          return
        }
        effectiveParams.lyrics = portText
      }
      // Context is a fixed composition, not a merge the provider guesses at: shared text first,
      // then this card's own prompt. Only a picture or clip has that port; a music card's text node
      // is the lyrics, and an audio card without lyrics uses no text at all.
      const isPicture = draft.kind === 'image' || draft.kind === 'video'
      const composedPrompt = isPicture && portText ? `${portText}\n\n${prompt}` : prompt

      updateDraft(draft.id, { generating: true })
      // Once a generation starts, the task/index own this asset; a reload must not bring the draft
      // back beside a pending card.
      writeDraftCache(
        draftCache,
        draftsRef.current.filter((entry) => entry.id !== draft.id),
      )
      try {
        await onLayoutChange(outRel, { x: draft.x, y: draft.y, w: draft.w, h: draft.h, z: draft.z })
        const dataUrls = await Promise.all(
          references.map((asset) => window.electronAPI.readFileDataUrl(absolute(projectFolder, asset.path))),
        )
        const images: string[] = []
        const videos: string[] = []
        const audios: string[] = []
        references.forEach((asset, index) => {
          const url = dataUrls[index]
          if (!url) return
          if (asset.kind === 'image') images.push(url)
          else if (asset.kind === 'video') videos.push(url)
          else if (asset.kind === 'audio') audios.push(url)
        })

        if (mode === 'video-edit') {
          const problem = videoEditProblem({
            videos: videos.length,
            images: images.length,
            audios: audios.length,
            frames: framePaths.size,
          })
          if (problem) {
            toast.error(t(problem === 'needs-one-video' ? 'canvas.videoEditNeedsOne' : 'canvas.videoEditOnlyOne'))
            updateDraft(draft.id, { generating: false })
            await onLayoutChange(outRel, null)
            return
          }
        }

        const reply = await window.electronAPI.mediaGenerate({
          channelId: channel.id,
          model,
          kind: draft.kind === 'audio' ? 'music' : draft.kind,
          prompt: composedPrompt,
          params: effectiveParams,
          ...(images.length ? { images } : {}),
          ...(videos.length ? { videos } : {}),
          ...(audios.length ? { audios } : {}),
          ...(firstFrame ? { firstFrame } : {}),
          ...(lastFrame ? { lastFrame } : {}),
          references: references.map((asset) => asset.path),
          // A text port is provenance, not an input: it must not be uploaded as an image.
          ...(textAsset && (wantsLyrics || (isPicture && portText))
            ? { provenance: [textAsset.path] }
            : {}),
          outPath: absolute(projectFolder, outRel),
          timeoutMs: 180000,
        })

        if (!reply.ok) {
          toast.error(reply.message ?? t('canvas.generateFailed'))
          if (reply.taskId) {
            // The task is the record now — failed or waiting for a person. Keeping the draft too
            // would leave two cards for one file.
            removeDraft(draft.id)
            await onRefresh()
          } else {
            updateDraft(draft.id, { generating: false })
            await onLayoutChange(outRel, null)
          }
          return
        }

        // A sound answer can land under a different extension than the one asked for (mp3 → wav);
        // move the card to the file that exists instead of leaving a layout on a name that does not.
        const landed = reply.path ? projectRelative(projectFolder, reply.path) : outRel
        if (landed !== outRel) {
          await onLayoutChange(outRel, null)
          await onLayoutChange(landed, {
            x: draft.x,
            y: draft.y,
            w: draft.w,
            h: draft.h,
            z: draft.z,
          })
        }
        // The task (or the file) is now the record; the draft has done its job.
        removeDraft(draft.id)
        await onRefresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        updateDraft(draft.id, { generating: false })
        await onLayoutChange(outRel, null)
      }
    },
    [
      channels,
      draftCache,
      generateTextDraft,
      libraryAssets,
      onLayoutChange,
      onRefresh,
      projectFolder,
      removeDraft,
      t,
      updateDraft,
    ],
  )

  /**
   * Fill a card's text port by creating the node it needs.
   *
   * The node is placed beside the card and selected, so the next keystroke is the text. The card
   * remembers which draft it waits for; when that node becomes a file the port links itself.
   */
  const createTextNode = React.useCallback(
    (id: string) => {
      const card = draftsRef.current.find((entry) => entry.id === id)
      const size = DRAFT_SIZE.text
      const center = card
        ? { x: card.x + card.w + 40 + size.w / 2, y: card.y + size.h / 2 }
        : undefined
      const created = createDraft('text', center)
      updateDraft(id, { pendingTextFrom: created })
      return created
    },
    [createDraft, updateDraft],
  )

  return {
    drafts,
    selectedDraftId,
    selectedDraft,
    setSelectedDraftId,
    channels,
    llmConnections,
    createDraft,
    createTextNode,
    updateDraft,
    removeDraft,
    restoreDrafts,
    setDraftParam,
    setTextSource,
    toggleReference,
    moveReference,
    setFrame,
    swapFrames,
    generateDraft,
  }
}

export type AssetDraftsApi = ReturnType<typeof useAssetDrafts>
