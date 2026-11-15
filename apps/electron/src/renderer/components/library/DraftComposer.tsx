/**
 * The composer for one draft: what to make, from what, and with which account.
 *
 * It is the same form in both views. On the board it floats over the canvas beside the card it is
 * writing; in the library's grid it sits in the detail column, because a grid has no canvas to
 * float over. The fields, the defaults and the run are therefore one implementation — only the
 * frame around them differs.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowLeftRight, ArrowUp, FileText, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import type { LibraryAsset } from '@craft-agent/shared/library'
import { paramLabelOf, paramValue, paramsForModel } from '@craft-agent/shared/media/params'
import { modelMode, paramsForMode } from '@craft-agent/shared/media/modes'
import { isSubtitleFile } from '@craft-agent/shared/media/file-kind'
import { getOmniModel } from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import {
  capabilityFor,
  imageModelsFor,
  modelIdsOf,
  pickTextConnection,
  DRAFT_ICON,
  type Draft,
  type LlmConnection,
  type MediaCapability,
  type MediaChannel,
} from './asset-drafts'

const CUSTOM_OPTION = '__custom__'

const absolutePath = (folder: string, relative: string): string =>
  `${folder.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`

/**
 * A select that still lets a vendor-side value through.
 *
 * A voice list is a starting point, not a closed set: an account may have cloned voices the
 * vendor never published. A datalist would hide the known ones behind typing, so this keeps them
 * in the dropdown and adds one entry that swaps in a text field for anything else.
 */
function SelectParam({
  value,
  options,
  allowCustom,
  onChange,
}: {
  value: string | number | undefined
  options: Array<string | number>
  allowCustom?: boolean
  onChange: (value: string | number | undefined) => void
}) {
  const { t } = useTranslation()
  const current = value === undefined ? '' : String(value)
  const known = current === '' || options.some((option) => String(option) === current)
  const [custom, setCustom] = React.useState(!known)
  const typed = allowCustom && (custom || !known)

  return (
    <>
      <select
        value={typed ? CUSTOM_OPTION : current}
        onChange={(event) => {
          const raw = event.target.value
          if (raw === CUSTOM_OPTION) {
            setCustom(true)
            return
          }
          setCustom(false)
          const option = options.find((candidate) => String(candidate) === raw)
          onChange(option ?? raw)
        }}
        className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
      >
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
        {allowCustom ? <option value={CUSTOM_OPTION}>{t('library.customValue')}</option> : null}
      </select>
      {typed ? (
        <input
          type="text"
          value={current}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
          className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
        />
      ) : null}
    </>
  )
}

export interface DraftComposerProps {
  draft: Draft
  channels: MediaChannel[]
  llmConnections: LlmConnection[]
  libraryAssets: LibraryAsset[]
  /** Needed to read a lyrics node's words for the port's preview. */
  projectFolder: string
  onUpdate: (id: string, patch: Partial<Draft>) => void
  onSetParam: (id: string, key: string, value: string | number | undefined) => void
  onToggleReference: (id: string, path: string) => void
  onMoveReference: (id: string, from: number, to: number) => void
  onSetFrame: (id: string, role: 'first' | 'last', path: string | null) => void
  onSwapFrames: (id: string) => void
  /** Sets the one text node a port reads; `null` clears it. */
  onSetTextSource: (id: string, path: string | null) => void
  /** Creates the text node an empty port is waiting for. */
  onCreateTextNode?: (id: string) => void
  onGenerate: (draft: Draft) => void
  onRemove: (id: string) => void
  /** Omitting it drops the close button — a pane is closed by choosing something else. */
  onClose?: () => void
  /** `float` is the board's overlay; `pane` is the library's detail column. */
  variant?: 'float' | 'pane'
  /** The card's current screen rectangle, so the floating composer stays beside it. */
  anchor?: { x: number; y: number; w: number; h: number } | null
}

export function DraftComposer({
  draft,
  channels,
  llmConnections,
  libraryAssets,
  projectFolder,
  onUpdate,
  onSetParam,
  onToggleReference,
  onMoveReference,
  onSetFrame,
  onSwapFrames,
  onSetTextSource,
  onCreateTextNode,
  onGenerate,
  onRemove,
  onClose,
  variant = 'pane',
  anchor = null,
}: DraftComposerProps) {
  const { t } = useTranslation()
  const workspaceDefaultLlmConnection = useOptionalAppShellContext()?.workspaceDefaultLlmConnection

  const usableChannels = channels
    .map((channel) => ({ channel, capability: capabilityFor(channel, draft.kind) }))
    .filter(
      (entry): entry is { channel: MediaChannel; capability: MediaCapability } => !!entry.capability,
    )
  const selectedCapability =
    usableChannels.find((entry) => entry.channel.id === draft.channelId)?.capability ??
    usableChannels[0]?.capability ??
    null
  const selectedModel =
    draft.modelId ?? selectedCapability?.defaultModel ?? selectedCapability?.models[0] ?? null
  const isAudioDraft = draft.kind === 'audio'
  const modelSpecs = selectedCapability
    ? paramsForMode(
        paramsForModel(selectedCapability.paramSpecs, selectedModel),
        modelMode(selectedCapability, selectedModel),
      )
    : []
  // A port takes one text node: music reads it as lyrics; image and video prepend it as context.
  const portRole: 'lyrics' | 'context' | null =
    isAudioDraft && selectedCapability?.textRole === 'lyrics'
      ? 'lyrics'
      : draft.kind === 'image' || draft.kind === 'video'
        ? 'context'
        : null
  const selectedParamSpecs = modelSpecs.filter(
    (spec) =>
      !(portRole === 'lyrics' && spec.key === 'lyrics') &&
      // A list with one item is not a choice: a 1K-only or 720P-only tier stays in the declaration
      // so the wire still gets its size, but the panel does not spend a row on it.
      !(spec.type === 'select' && spec.options?.length === 1),
  )
  const textAssets = libraryAssets.filter(
    (asset) =>
      asset.status === 'ready' && asset.kind === 'text' && !isSubtitleFile(asset.path),
  )
  const portAsset = portRole ? textAssets.find((asset) => asset.path === draft.textSource) : undefined
  const portPath = portAsset?.path
  const [portText, setPortText] = React.useState('')
  /** Narrowing the reference shelf: a project can hold hundreds of assets. */
  const [referenceQuery, setReferenceQuery] = React.useState('')
  React.useEffect(() => {
    let cancelled = false
    if (!portPath) {
      setPortText('')
      return
    }
    window.electronAPI
      .readFile(absolutePath(projectFolder, portPath))
      .then((raw) => {
        if (!cancelled) setPortText(raw.trim())
      })
      .catch(() => {
        if (!cancelled) setPortText('')
      })
    return () => {
      cancelled = true
    }
  }, [portPath, projectFolder])
  /**
   * The values the next account/model can still use.
   *
   * Switching a model must not leave another model's numbers in the form: a stale `size` would show
   * blank and reach the provider under a name it no longer means. Undeclared keys are dropped, and
   * a closed list drops a value it does not name.
   */
  const paramsFor = (
    capability: MediaCapability | null,
    model: string | null,
  ): Record<string, string | number> => {
    if (!capability) return {}
    const specs = paramsForMode(
      paramsForModel(capability.paramSpecs, model),
      modelMode(capability, model),
    )
    const next: Record<string, string | number> = {}
    for (const spec of specs) {
      const value = draft.params[spec.key]
      if (value === undefined) continue
      if (
        spec.type === 'select' &&
        spec.options?.length &&
        !spec.allowCustom &&
        !spec.options.some((option) => String(option) === String(value))
      ) {
        continue
      }
      next[spec.key] = value
    }
    return next
  }
  const isTextDraft = draft.kind === 'text'
  const referenceAssets = libraryAssets.filter(
    (asset) =>
      asset.status === 'ready' &&
      (asset.kind === 'image' ||
        asset.kind === 'video' ||
        asset.kind === 'audio' ||
        // Text is a reference only for a text card (the LLM reads it). A media card's numbered
        // references are bytes; text — a subtitle included — belongs to the fixed port or nowhere.
        (isTextDraft && asset.kind === 'text')),
  )
  const imageAssets = libraryAssets.filter(
    (asset) => asset.status === 'ready' && asset.kind === 'image',
  )
  const referenceKinds = new Set(
    draft.references
      .map((path) => libraryAssets.find((asset) => asset.path === path)?.kind)
      .filter((kind): kind is LibraryAsset['kind'] => !!kind),
  )
  const hasAudioVideo = referenceKinds.has('audio') || referenceKinds.has('video')
  const availableReferences = referenceAssets.filter((asset) => {
    if (
      draft.references.includes(asset.path) ||
      asset.path === draft.firstFrame ||
      asset.path === draft.lastFrame
    ) {
      return false
    }
    // A text card carries one media file at most — our rule: a video already has its own
    // soundtrack, and one file fits every omni provider. Text is context; only a text card takes it.
    if (isTextDraft) {
      if (asset.kind === 'audio' && (referenceKinds.has('audio') || referenceKinds.has('video'))) {
        return false
      }
      if (asset.kind === 'video' && (referenceKinds.has('video') || referenceKinds.has('audio'))) {
        return false
      }
    } else if (asset.kind === 'text') {
      return false
    }
    return true
  })
  const kindLabel =
    draft.kind === 'image'
      ? t('library.image')
      : draft.kind === 'video'
        ? t('library.video')
        : draft.kind === 'audio'
          ? t('library.audio')
          : t('library.text')

  const referenceNeedle = referenceQuery.trim().toLowerCase()
  const shownReferences = referenceNeedle
    ? availableReferences.filter(
        (asset) =>
          asset.name.toLowerCase().includes(referenceNeedle) ||
          asset.path.toLowerCase().includes(referenceNeedle),
      )
    : availableReferences
  const selectedTextConnection = isTextDraft
    ? pickTextConnection(llmConnections, draft.channelId, workspaceDefaultLlmConnection)
    : null
  // An omni pick on a connection whose wire cannot carry audio is no pick (same rule as the run).
  const omniModel = selectedTextConnection ? (getOmniModel(selectedTextConnection) ?? null) : null
  const hasImageRefs = referenceKinds.has('image')
  // Sound and video are answered by the omni role. Pictures offer every model this connection
  // declares can see (the vision role first, then its default model); the list is the same one the
  // run uses, so nothing can be picked here that would be refused on send.
  const textModels = selectedTextConnection
    ? hasAudioVideo
      ? omniModel
        ? [omniModel]
        : []
      : hasImageRefs
        ? imageModelsFor(selectedTextConnection)
        : modelIdsOf(selectedTextConnection)
    : []

  // Keep the selection inside what this card can actually use as references come and go.
  React.useEffect(() => {
    if (!isTextDraft || !selectedTextConnection || textModels.length === 0) return
    if (draft.modelId && textModels.includes(draft.modelId)) return
    onUpdate(draft.id, { modelId: textModels[0] ?? null })
  }, [draft.id, draft.modelId, isTextDraft, onUpdate, selectedTextConnection, textModels])
  const Icon = DRAFT_ICON[draft.kind]

  const frameClass =
    variant === 'float'
      ? 'absolute bottom-20 left-1/2 z-[60] max-h-[calc(100%-6rem)] w-[min(720px,calc(100%-32px))] -translate-x-1/2 overflow-y-auto rounded-xl border border-border/60 bg-background/95 p-3 shadow-strong backdrop-blur'
      : 'flex flex-col'

  /**
   * Beside the card, not at the bottom of the window.
   *
   * The composer used to sit in a fixed strip under the board, so a card near the top of a zoomed
   * canvas and the form writing it looked like two unrelated things. Given the card's rectangle the
   * form takes the room to its right, or to its left, or below it — whichever exists.
   */
  const frameStyle: React.CSSProperties | undefined =
    variant === 'float' && anchor
      ? (() => {
          const width = Math.min(720, window.innerWidth - 32)
          const right = anchor.x + anchor.w + 12
          const leftOfCard = anchor.x - width - 12
          const fitsRight = right + width <= window.innerWidth - 12
          const fitsLeft = leftOfCard >= 12
          const left = fitsRight
            ? right
            : fitsLeft
              ? leftOfCard
              : Math.max(12, Math.min(anchor.x, window.innerWidth - width - 12))
          const side = fitsRight || fitsLeft
          const top = side
            ? Math.max(12, Math.min(anchor.y, window.innerHeight - 300))
            : Math.max(12, Math.min(anchor.y + anchor.h + 12, window.innerHeight - 300))
          return {
            position: 'fixed',
            left,
            top,
            width,
            bottom: 'auto',
            transform: 'none',
            maxHeight: 'calc(100vh - 24px)',
          }
        })()
      : undefined

  return (
    <div className={frameClass} style={frameStyle} data-no-zoom>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-foreground/60" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{kindLabel}</span>
        <button
          type="button"
          title={t('canvas.delete')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={() => onRemove(draft.id)}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        {onClose ? (
          <button
            type="button"
            title={t('common.close')}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <textarea
        value={draft.prompt}
        onChange={(event) => onUpdate(draft.id, { prompt: event.target.value })}
        placeholder={
          isTextDraft
            ? t('canvas.textComposerPlaceholderText')
            : portRole === 'lyrics'
              ? t('canvas.musicPromptPlaceholder')
              : t('canvas.describeWhat')
        }
        rows={3}
        className="w-full resize-none rounded-md border border-border/60 bg-muted/30 p-2 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-border"
      />

      {portRole ? (
        <div className="mt-2 rounded-md border border-border/60 p-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-foreground/60">
            <span>{t(portRole === 'lyrics' ? 'canvas.lyrics' : 'canvas.context')}</span>
            {portText ? (
              <span className="tabular-nums text-muted-foreground">
                {t('canvas.lyricsWords', { n: portText.length })}
                {portRole === 'context' && draft.prompt.trim()
                  ? ` · ${t('canvas.composeTotal', {
                      n: portText.length + 2 + draft.prompt.trim().length,
                    })}`
                  : ''}
              </span>
            ) : null}
          </div>
          {portRole === 'context' ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('canvas.contextHint')}</p>
          ) : null}
          {portAsset ? (
            <>
              <div className="mt-1 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
                <span className="min-w-0 flex-1 truncate text-[11px]" title={portAsset.name}>
                  {portAsset.name}
                </span>
                <button
                  type="button"
                  title={t('canvas.removeReference')}
                  onClick={() => onSetTextSource(draft.id, null)}
                  className="flex size-5 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              {portText ? (
                <p className="mt-1 max-h-12 overflow-hidden whitespace-pre-line text-[11px] leading-4 text-muted-foreground">
                  {portText}
                </p>
              ) : null}
            </>
          ) : draft.textSource &&
            !libraryAssets.some((asset) => asset.path === draft.textSource) ? (
            // The file this port was given is no longer in the library. Say so instead of falling
            // back to "pick one", which would look as if nothing had ever been chosen.
            <div className="mt-1 flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 shrink-0 text-destructive/70" />
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-destructive"
                title={`${draft.textSource} · ${t('library.referenceMissing')}`}
              >
                {draft.textSource.split(/[\\/]/).pop()}
              </span>
              <button
                type="button"
                title={t('canvas.removeReference')}
                onClick={() => onSetTextSource(draft.id, null)}
                className="flex size-5 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : draft.pendingTextFrom ? (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              {t('canvas.lyricsPending')}
            </p>
          ) : (
            <div className="mt-1 flex items-center gap-1.5">
              <select
                value=""
                onChange={(event) => {
                  const path = event.target.value
                  if (path) onSetTextSource(draft.id, path)
                }}
                className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
              >
                <option value="">{t('canvas.lyricsPick')}</option>
                {textAssets.map((asset) => (
                  <option key={asset.path} value={asset.path}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onCreateTextNode?.(draft.id)}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
              >
                <Plus className="h-3 w-3" />
                {t('canvas.lyricsNew')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isTextDraft ? (
          llmConnections.length > 0 ? (
            <>
              <select
                value={draft.channelId ?? selectedTextConnection?.slug ?? ''}
                onChange={(event) => {
                  const next = llmConnections.find(
                    (connection) => connection.slug === event.target.value,
                  )
                  onUpdate(draft.id, {
                    channelId: next?.slug ?? null,
                    modelId: next
                      ? (hasAudioVideo
                          ? getOmniModel(next)
                          : hasImageRefs
                            ? (imageModelsFor(next)[0] ?? null)
                            : (next.fastModel ?? next.defaultModel ?? modelIdsOf(next)[0])) ?? null
                      : null,
                  })
                }}
                className="h-8 max-w-[180px] rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
              >
                {llmConnections.map((connection) => (
                  <option key={connection.slug} value={connection.slug}>
                    {connection.name}
                  </option>
                ))}
              </select>
              {textModels.length > 0 ? (
                <select
                  value={
                    draft.modelId && textModels.includes(draft.modelId)
                      ? draft.modelId
                      : textModels[0] ?? ''
                  }
                  onChange={(event) => onUpdate(draft.id, { modelId: event.target.value })}
                  className="h-8 max-w-[220px] rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
                >
                  {textModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : null}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t('canvas.noChannel')}</span>
          )
        ) : usableChannels.length > 0 && selectedCapability ? (
          <>
            <select
              value={draft.channelId ?? usableChannels[0]?.channel.id ?? ''}
              onChange={(event) => {
                const next = usableChannels.find((entry) => entry.channel.id === event.target.value)
                const model = next?.capability.defaultModel ?? next?.capability.models[0] ?? null
                onUpdate(draft.id, {
                  channelId: next?.channel.id ?? null,
                  modelId: model,
                  params: paramsFor(next?.capability ?? null, model),
                })
              }}
              className="h-8 max-w-[180px] rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
            >
              {usableChannels.map(({ channel }) => {
                const unavailable = channel.enabled === false || channel.hasKey === false
                return (
                  <option key={channel.id} value={channel.id} disabled={unavailable}>
                    {channel.name}
                    {channel.enabled === false
                      ? ` · ${t('mediaChannels.disabled')}`
                      : channel.hasKey === false
                        ? ` · ${t('mediaChannels.keyMissing')}`
                        : ''}
                  </option>
                )
              })}
            </select>
            <select
              value={
                draft.modelId ??
                selectedCapability.defaultModel ??
                selectedCapability.models[0] ??
                ''
              }
              disabled={selectedCapability.models.length === 0}
              onChange={(event) => {
                const model = event.target.value
                onUpdate(draft.id, {
                  modelId: model,
                  params: paramsFor(selectedCapability, model),
                })
              }}
              className="h-8 max-w-[220px] rounded-md border border-border/60 bg-background px-2 text-xs outline-none disabled:opacity-50"
            >
              {selectedCapability.models.length === 0 ? (
                <option value="">{t('library.noModels')}</option>
              ) : null}
              {selectedCapability.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">{t('canvas.noChannel')}</span>
        )}

        {isTextDraft && hasAudioVideo && !omniModel ? (
          <span className="text-[11px] text-muted-foreground">{t('canvas.omniRequired')}</span>
        ) : null}
        {isTextDraft && !hasAudioVideo && hasImageRefs && textModels.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{t('canvas.visionRequired')}</span>
        ) : null}

        <button
          type="button"
          onClick={() => onGenerate(draft)}
          disabled={
            draft.generating ||
            !draft.prompt.trim() ||
            (portRole === 'lyrics' && !portAsset) ||
            (isTextDraft
              ? !selectedTextConnection || textModels.length === 0
              : !selectedCapability || selectedCapability.models.length === 0)
          }
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {draft.generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {t('canvas.generate')}
        </button>
      </div>

      {selectedParamSpecs.length > 0 ? (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {selectedParamSpecs.map((spec) => {
            const value = paramValue(spec, draft.params)
            const label = paramLabelOf(spec)
            return (
              <label
                key={spec.key}
                className="flex min-w-0 flex-col gap-1 text-[11px] text-foreground/60"
              >
                <span className="truncate" title={label}>
                  {label}
                </span>
                {spec.type === 'select' && !spec.options?.length ? (
                  // A select with nothing to select is a text field: a protocol may name a
                  // parameter whose values are provider-side only.
                  <input
                    type="text"
                    value={value === undefined ? '' : String(value)}
                    onChange={(event) =>
                      onSetParam(
                        draft.id,
                        spec.key,
                        event.target.value === '' ? undefined : event.target.value,
                      )
                    }
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
                  />
                ) : spec.type === 'select' && spec.allowCustom ? (
                  <SelectParam
                    value={value}
                    options={spec.options ?? []}
                    allowCustom
                    onChange={(next) => onSetParam(draft.id, spec.key, next)}
                  />
                ) : spec.type === 'select' ? (
                  <SelectParam
                    value={value}
                    options={spec.options ?? []}
                    onChange={(next) => onSetParam(draft.id, spec.key, next)}
                  />
                ) : spec.type === 'number' ? (
                  <input
                    type="number"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={value === undefined ? '' : String(value)}
                    onChange={(event) => {
                      const raw = event.target.value
                      if (raw === '') {
                        onSetParam(draft.id, spec.key, undefined)
                        return
                      }
                      const next = Number(raw)
                      if (Number.isFinite(next)) {
                        onSetParam(draft.id, spec.key, next)
                      }
                    }}
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
                  />
                ) : (
                  <input
                    type="text"
                    value={value === undefined ? '' : String(value)}
                    onChange={(event) =>
                      onSetParam(
                        draft.id,
                        spec.key,
                        event.target.value === '' ? undefined : event.target.value,
                      )
                    }
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
                  />
                )}
              </label>
            )
          })}
        </div>
      ) : null}

      {draft.kind === 'video' ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-foreground/60">
            <span className="truncate">{t('canvas.firstFrame')}</span>
            <select
              value={draft.firstFrame ?? ''}
              onChange={(event) => onSetFrame(draft.id, 'first', event.target.value || null)}
              className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
            >
              <option value="">—</option>
              {draft.firstFrame &&
              !libraryAssets.some((asset) => asset.path === draft.firstFrame) ? (
                <option value={draft.firstFrame}>
                  {`${draft.firstFrame.split(/[\\/]/).pop()} · ${t('library.referenceMissing')}`}
                </option>
              ) : null}
              {imageAssets
                .filter((asset) => asset.path !== draft.lastFrame)
                .map((asset) => (
                  <option key={asset.path} value={asset.path}>
                    {asset.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-foreground/60">
            <span className="truncate">{t('canvas.lastFrame')}</span>
            <select
              value={draft.lastFrame ?? ''}
              onChange={(event) => onSetFrame(draft.id, 'last', event.target.value || null)}
              className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none"
            >
              <option value="">—</option>
              {draft.lastFrame &&
              !libraryAssets.some((asset) => asset.path === draft.lastFrame) ? (
                <option value={draft.lastFrame}>
                  {`${draft.lastFrame.split(/[\\/]/).pop()} · ${t('library.referenceMissing')}`}
                </option>
              ) : null}
              {imageAssets
                .filter((asset) => asset.path !== draft.firstFrame)
                .map((asset) => (
                  <option key={asset.path} value={asset.path}>
                    {asset.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onSwapFrames(draft.id)}
            disabled={!draft.firstFrame && !draft.lastFrame}
            className="col-span-2 inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border/60 text-[11px] text-foreground/60 transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeftRight className="h-3 w-3" />
            {t('canvas.firstFrame')} ⇄ {t('canvas.lastFrame')}
          </button>
        </div>
      ) : null}

      {!isAudioDraft ? (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-foreground/60">
            <span>{t('canvas.roleReference')}</span>
            <span className="tabular-nums">{draft.references.length}</span>
          </div>
          {draft.references.length > 0 ? (
            <ol className="max-h-24 space-y-0.5 overflow-y-auto">
              {draft.references.map((path, index) => {
                const asset = libraryAssets.find((candidate) => candidate.path === path)
                const name = asset?.name ?? path
                // A file deleted outside the library stays listed, but is named as missing rather
                // than looking like a pick the run will happily send.
                const missing = !asset
                return (
                  <li
                    key={path}
                    className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-foreground/[0.03]"
                  >
                    <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[11px]${missing ? ' text-destructive' : ''}`}
                      title={missing ? `${name} · ${t('library.referenceMissing')}` : name}
                    >
                      {name}
                    </span>
                    <button
                      type="button"
                      disabled={index === 0}
                      title={t('canvas.reorderReference')}
                      onClick={() => onMoveReference(draft.id, index, index - 1)}
                      className="flex size-5 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={index === draft.references.length - 1}
                      title={t('canvas.reorderReference')}
                      onClick={() => onMoveReference(draft.id, index, index + 1)}
                      className="flex size-5 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title={t('canvas.removeReference')}
                      onClick={() => onToggleReference(draft.id, path)}
                      className="flex size-5 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t(isTextDraft ? 'canvas.noTextCardReferences' : 'canvas.noImageReferences')}
            </span>
          )}

          {availableReferences.length > 0 ? (
            <div className="mt-1 space-y-1">
              {availableReferences.length > 4 ? (
                <input
                  type="search"
                  value={referenceQuery}
                  onChange={(event) => setReferenceQuery(event.target.value)}
                  placeholder={t('library.search')}
                  className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-[11px] outline-none placeholder:text-muted-foreground/60"
                />
              ) : null}
              {shownReferences.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">{t('library.noMatch')}</span>
              ) : (
                <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
                  {shownReferences.map((asset) => (
                    <button
                      key={asset.path}
                      type="button"
                      onClick={() => onToggleReference(draft.id, asset.path)}
                      className="inline-flex max-w-[190px] items-center gap-1 rounded-full border border-border/60 px-2 py-1 text-[11px] text-foreground/60 transition-colors hover:bg-foreground/[0.04]"
                      title={asset.name}
                    >
                      <Plus className="h-3 w-3 shrink-0" />
                      <span className="truncate">{asset.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
