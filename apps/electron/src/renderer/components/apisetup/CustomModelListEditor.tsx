/**
 * CustomModelListEditor — the per-model rows of a custom endpoint connection.
 *
 * This is a **view over the config**: a row carries exactly the parameters a
 * user can hand-write in `config.json` under `llmConnections[].models[]`, and
 * the controls are generated from `CUSTOM_ENDPOINT_MODEL_PARAM_SPECS` — the same
 * table the projection to pi-agent-server reads. Adding a parameter therefore
 * needs no change here.
 *
 * Entries this component does not understand (unknown or future keys) are kept
 * on the entry objects it holds and written back untouched.
 */

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import {
  CUSTOM_ENDPOINT_MODEL_DEFAULTS,
  CUSTOM_ENDPOINT_MODEL_PARAM_SPECS,
  customEndpointEntryHasParams,
  findDuplicateModelIds,
  type ConnectionModelEntry,
  type CustomEndpointModelEntry,
  type CustomEndpointModelParamSpec,
  type CustomEndpointModelParams,
} from '@config/llm-connections'

/** Stands in for "no value" in a Select — Radix rejects an empty-string item value. */
const NO_SELECTION = '__none__'

export interface CustomModelListEditorProps {
  value: ConnectionModelEntry[]
  onChange: (next: ConnectionModelEntry[]) => void
  /** The connection's `defaultModel`. */
  defaultModel?: string
  /** Called with the model the user picks as this connection's default. */
  onDefaultModelChange: (id: string) => void
  /**
   * The fast-model selection to show: the connection's `fastModel`, or the
   * name-based guess for a built-in catalog. `''` = no pick (follow the default).
   */
  fastModel?: string
  /** Called with the picked fast model, or `null` for "follow the default model". */
  onFastModelChange: (id: string | null) => void
  disabled?: boolean
  /** Validation message shown under the list (e.g. "at least one model"). */
  error?: string | null
  idPrefix?: string
}

type ParamKey = keyof CustomEndpointModelParams

function toEntry(entry: ConnectionModelEntry): CustomEndpointModelEntry {
  return typeof entry === 'string' ? { id: entry } : { ...entry }
}

/** Token counts are quoted in KiB ("128k"), except the round millions ("1M"). */
function formatCount(value: number): string {
  return value >= 1_000_000
    ? `${Math.round(value / 1_000_000)}M`
    : `${Math.round(value / 1024)}k`
}

/** One-line summary of what a row actually sets, shown while collapsed. */
function summarise(entry: CustomEndpointModelEntry): string {
  const parts: string[] = []
  if (entry.name) parts.push(entry.name)
  if (entry.contextWindow !== undefined) parts.push(`${formatCount(entry.contextWindow)} context`)
  if (entry.maxTokens !== undefined) parts.push(`${formatCount(entry.maxTokens)} output`)
  if (entry.supportsImages === false) parts.push('no images')
  if (entry.supportsThinking === false) parts.push('no thinking')
  if (entry.headers && Object.keys(entry.headers).length > 0) parts.push('headers')
  if (entry.compat) parts.push('compatibility')
  if (entry.thinkingLevelMap) parts.push('thinking levels')
  if (entry.cost) parts.push('cost')
  return parts.join(' · ')
}

export function CustomModelListEditor({
  value,
  onChange,
  defaultModel,
  onDefaultModelChange,
  fastModel,
  onFastModelChange,
  disabled,
  error,
  idPrefix = 'custom-model',
}: CustomModelListEditorProps) {
  // Open the rows that actually carry parameters, so what is configured is
  // visible at a glance; a single bare row opens too (there is nothing else).
  const [expanded, setExpanded] = useState<number[]>(() => {
    const withParams = value
      .map((entry, index) => customEndpointEntryHasParams(toEntry(entry)) ? index : -1)
      .filter(index => index >= 0)
    if (withParams.length > 0) return withParams
    return value.length === 1 ? [0] : []
  })

  const entries = value.map(toEntry)
  const duplicateIds = findDuplicateModelIds(value)
  const knownIds = entries.map(entry => entry.id.trim()).filter(Boolean)

  // What the default dropdown shows: the stored pick, or the first named entry
  // when the connection has none — or points at a model that is no longer listed.
  const storedDefault = defaultModel?.trim()
  const pickedDefaultId =
    storedDefault && knownIds.includes(storedDefault) ? storedDefault : (knownIds[0] ?? '')

  // The stored fast model is kept as an option even when it is not listed, so
  // saving from the UI cannot silently drop a hand-written one.
  const storedFast = fastModel?.trim()
  const fastOptions = [...new Set(knownIds)]
  if (storedFast && !fastOptions.includes(storedFast)) fastOptions.push(storedFast)

  const readValue = (index: number): CustomEndpointModelEntry => toEntry(value[index]!)

  const writeEntry = (index: number, next: CustomEndpointModelEntry) => {
    const nextValue = value.slice()
    nextValue[index] = next
    onChange(nextValue)
  }

  const setParam = (index: number, key: ParamKey, raw: unknown) => {
    const next = { ...readValue(index) } as unknown as Record<string, unknown>
    if (raw === undefined || raw === '') delete next[key]
    else next[key] = raw
    writeEntry(index, next as unknown as CustomEndpointModelEntry)
  }

  const setId = (index: number, id: string) => {
    const previousId = readValue(index).id.trim()
    writeEntry(index, { ...readValue(index), id })
    // Both picks are stored by id, so a rename has to carry them along or the
    // choice would quietly fall back to the first row / Auto.
    const nextId = id.trim()
    if (!nextId || previousId === nextId) return
    if (previousId === pickedDefaultId) onDefaultModelChange(nextId)
    if (previousId === storedFast) onFastModelChange(nextId)
  }

  const addRow = () => {
    // Start from the values a bare model would be given anyway, written out so
    // they are visible and adjustable instead of implicit.
    onChange([...value, {
      id: '',
      contextWindow: CUSTOM_ENDPOINT_MODEL_DEFAULTS.contextWindow,
      maxTokens: CUSTOM_ENDPOINT_MODEL_DEFAULTS.maxTokens,
    }])
    setExpanded(prev => [...prev, value.length])
  }

  const removeRow = (index: number) => {
    const removedId = readValue(index).id.trim()
    const next = value.filter((_, i) => i !== index)
    onChange(next)
    setExpanded([])
    if (!removedId) return
    if (removedId === pickedDefaultId) {
      onDefaultModelChange(next.map(toEntry).map(entry => entry.id.trim()).find(Boolean) ?? '')
    }
    if (removedId === storedFast) onFastModelChange(null)
  }

  const moveRow = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= value.length) return
    const nextValue = value.slice()
    const [moved] = nextValue.splice(index, 1)
    nextValue.splice(target, 0, moved!)
    onChange(nextValue)
    setExpanded([])
  }

  const toggleExpanded = (index: number) => {
    setExpanded(prev => prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index])
  }

  const fieldClass = cn(
    'rounded-md shadow-minimal transition-colors',
    'bg-foreground-2 focus-within:bg-background',
  )

  const namedCount = entries.filter(entry => entry.id.trim()).length

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-muted-foreground font-normal">Models</Label>
        <span className="text-xs text-foreground/30">
          {namedCount === 1 ? '1 model' : `${namedCount} models`}
        </span>
      </div>

      <div className="space-y-1.5">
        {entries.map((entry, index) => {
          const isOpen = expanded.includes(index)
          const summary = summarise(entry)
          const isDuplicate = duplicateIds.includes(entry.id.trim())
          return (
            <div key={index} className="rounded-md bg-foreground-2 shadow-minimal">
              <div className="flex items-center gap-2 p-1.5">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleExpanded(index)}
                  className="text-foreground/40 hover:text-foreground/70 disabled:opacity-50"
                  aria-label={isOpen ? 'Hide parameters' : 'Show parameters'}
                >
                  {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>

                {/* Labelled because this is the model's identity, not another
                    parameter: the parameter area below starts with "Display
                    name", which is easy to mistake for it. */}
                <span className="text-[11px] text-foreground/45 shrink-0">
                  id<span className="text-destructive">*</span>
                </span>
                <div className={cn(fieldClass, 'flex-1')}>
                  <Input
                    id={`${idPrefix}-${index}-id`}
                    value={entry.id}
                    disabled={disabled}
                    placeholder="model id, e.g. qwen3-coder"
                    onChange={e => setId(index, e.target.value)}
                    className={cn(
                      'border-0 bg-transparent shadow-none',
                      isDuplicate && 'text-destructive',
                    )}
                  />
                </div>

                {isDuplicate && (
                  <span className="text-[10px] uppercase tracking-wide text-destructive px-1">duplicate</span>
                )}
                {/* An entry with a display name but no id is dropped on save (a
                    model cannot be registered without an id), so say so instead
                    of letting it disappear. */}
                {!entry.id.trim() && !!entry.name?.trim() && (
                  <span className="text-[10px] uppercase tracking-wide text-destructive px-1">needs an id</span>
                )}

                {!summary && !isOpen && (
                  <span className="text-xs text-foreground/30 pr-1">no parameters</span>
                )}

                <div className="flex items-center">
                  <button
                    type="button"
                    disabled={disabled || index === 0}
                    onClick={() => moveRow(index, -1)}
                    className="text-foreground/40 hover:text-foreground/70 disabled:opacity-30 px-1"
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={disabled || index === entries.length - 1}
                    onClick={() => moveRow(index, 1)}
                    className="text-foreground/40 hover:text-foreground/70 disabled:opacity-30 px-1"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeRow(index)}
                    className="text-foreground/40 hover:text-foreground/80 disabled:opacity-30 px-1"
                    aria-label="Remove model"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-foreground/5 p-2 space-y-2">
                  {summary && (
                    <p className="text-xs text-foreground/30">{summary}</p>
                  )}
                  {CUSTOM_ENDPOINT_MODEL_PARAM_SPECS.map(spec => (
                    <ParamControl
                      key={spec.key}
                      spec={spec}
                      entry={entry}
                      disabled={disabled}
                      inputId={`${idPrefix}-${index}-${spec.key}`}
                      onCommit={raw => setParam(index, spec.key, raw)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-end">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={addRow}>
          <Plus className="size-3.5" /> Add model
        </Button>
      </div>

      <ModelPicker
        id={`${idPrefix}-default`}
        label="Default model"
        value={pickedDefaultId}
        options={[...new Set(knownIds)]}
        placeholder="Add a model first"
        hint="New sessions start on this model."
        disabled={disabled}
        onChange={onDefaultModelChange}
      />

      <ModelPicker
        id={`${idPrefix}-fast`}
        label="Fast model"
        value={storedFast ?? ''}
        options={fastOptions}
        emptyOption="Follow the default model"
        optionNote={option => (knownIds.includes(option) ? undefined : 'not in the list')}
        hint="Used for titles and summaries — the default model unless you pick another."
        disabled={disabled}
        onChange={next => onFastModelChange(next || null)}
      />

      {duplicateIds.length > 0 && (
        <p className="text-xs text-destructive">
          Each model id can appear once — {duplicateIds.join(', ')} {duplicateIds.length === 1 ? 'is' : 'are'} listed twice.
        </p>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

// ============================================================
// Connection-level model pickers
// ============================================================

/**
 * One connection-level model choice (default / fast), rendered as a dropdown so
 * it can be changed without touching the row order — the row list is about the
 * catalog, not about which entry plays which role.
 */
function ModelPicker({
  id,
  label,
  value,
  options,
  emptyOption,
  placeholder,
  optionNote,
  hint,
  disabled,
  onChange,
}: {
  id: string
  label: string
  /** Current value; `''` means "not set". */
  value: string
  options: string[]
  /** When set, an extra option that stands for "not set" (e.g. "Follow the default model"). */
  emptyOption?: string
  /** Shown when nothing is selected and there is no `emptyOption`. */
  placeholder?: string
  /** Extra note appended to an option, e.g. a stored value that is no longer listed. */
  optionNote?: (option: string) => string | undefined
  hint: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const hasChoice = options.length > 0 || !!emptyOption

  return (
    <div className="flex items-start gap-3">
      <div className="w-32 shrink-0 pt-1.5">
        <Label htmlFor={id} className="text-xs text-foreground/60">{label}</Label>
      </div>
      <div className="flex-1 space-y-1">
        <Select
          // Without an `emptyOption` an empty value is left empty on purpose:
          // that is what makes Radix render the placeholder.
          value={emptyOption ? (value || NO_SELECTION) : value}
          disabled={disabled || !hasChoice}
          onValueChange={next => onChange(next === NO_SELECTION ? '' : next)}
        >
          <SelectTrigger id={id} className="h-8 text-xs">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          {/* This editor lives inside the fullscreen API-setup overlay
              (z-fullscreen), so the portaled list must outrank it — at the
              default z-dropdown it opens behind the overlay and looks dead. */}
          <SelectContent className="z-floating-menu">
            {emptyOption && <SelectItem value={NO_SELECTION}>{emptyOption}</SelectItem>}
            {options.map(option => {
              const note = optionNote?.(option)
              return (
                <SelectItem key={option} value={option}>
                  {note ? `${option} (${note})` : option}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-foreground/25">{hint}</p>
      </div>
    </div>
  )
}

// ============================================================
// Per-parameter controls — driven by the spec table
// ============================================================

/**
 * Connection-level request headers (`customEndpoint.headers`): sent with every
 * request to the endpoint, so they belong to the connection rather than to a
 * single model. Same key/value control as the per-model `headers` parameter.
 */
export function ConnectionHeadersEditor({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, string> | undefined
  onChange: (next: Record<string, string> | undefined) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground font-normal">Request headers</Label>
      <KeyValueControl
        value={value}
        disabled={disabled}
        onCommit={raw => onChange(raw as Record<string, string> | undefined)}
      />
      <p className="text-xs text-foreground/30">Sent with every request to this endpoint.</p>
    </div>
  )
}

function ParamControl({
  spec,
  entry,
  disabled,
  inputId,
  onCommit,
}: {
  spec: CustomEndpointModelParamSpec
  entry: CustomEndpointModelEntry
  disabled?: boolean
  inputId: string
  onCommit: (raw: unknown) => void
}) {
  const value = (entry as unknown as Record<string, unknown>)[spec.key]

  return (
    <div className="flex items-start gap-3">
      <div className="w-32 shrink-0 pt-1.5">
        <label htmlFor={inputId} className="text-xs text-foreground/60">{spec.label}</label>
      </div>
      <div className="flex-1 space-y-1">
        {spec.control === 'switch' ? (
          <Switch
            id={inputId}
            disabled={disabled}
            checked={value !== false}
            onCheckedChange={checked => onCommit(checked ? undefined : false)}
          />
        ) : spec.control === 'number' ? (
          <NumberControl
            id={inputId}
            value={value}
            disabled={disabled}
            placeholder={spec.hint}
            presets={spec.presets}
            onCommit={onCommit}
          />
        ) : spec.control === 'key-value' ? (
          <KeyValueControl
            value={value as Record<string, string> | undefined}
            disabled={disabled}
            onCommit={onCommit}
          />
        ) : spec.control === 'json' ? (
          <JsonControl
            id={inputId}
            value={value}
            disabled={disabled}
            placeholder={spec.hint}
            onCommit={onCommit}
          />
        ) : (
          <div className={cn('rounded-md shadow-minimal bg-foreground-2 focus-within:bg-background')}>
            <Input
              id={inputId}
              type="text"
              value={typeof value === 'string' ? value : ''}
              disabled={disabled}
              placeholder={spec.hint}
              onChange={e => onCommit(e.target.value)}
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        )}
        {/* With presets the chips already say what the field means, so the unit
            hint does not need to be repeated under the input. */}
        {spec.control !== 'switch' && !spec.presets?.length && spec.hint && !String(value ?? '').length && (
          <p className="text-[11px] text-foreground/25">{spec.hint}</p>
        )}
      </div>
    </div>
  )
}

function NumberControl({
  id,
  value,
  disabled,
  placeholder,
  presets,
  onCommit,
}: {
  id: string
  value: unknown
  disabled?: boolean
  placeholder?: string
  presets?: Array<{ label: string; value: number }>
  onCommit: (raw: unknown) => void
}) {
  // Keep the raw text so partial input ("262" on the way to "262144") is not
  // rewritten under the cursor; only complete numbers are committed.
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))

  const applyPreset = (next: number) => {
    setDraft(String(next))
    onCommit(next)
  }

  return (
    <div className="space-y-1">
      <div className={cn('rounded-md shadow-minimal bg-foreground-2 focus-within:bg-background')}>
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={e => {
            const text = e.target.value
            setDraft(text)
            const trimmed = text.trim()
            if (trimmed === '') onCommit(undefined)
            else if (/^\d+$/.test(trimmed)) onCommit(Number(trimmed))
          }}
          className="border-0 bg-transparent shadow-none"
        />
      </div>
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map(preset => {
            const active = Number(draft) === preset.value
            return (
              <button
                key={preset.value}
                type="button"
                disabled={disabled}
                onClick={() => applyPreset(preset.value)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50',
                  active
                    ? 'bg-foreground/10 text-foreground/80'
                    : 'text-foreground/40 hover:bg-foreground/5 hover:text-foreground/70',
                )}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function JsonControl({
  id,
  value,
  disabled,
  placeholder,
  onCommit,
}: {
  id: string
  value: unknown
  disabled?: boolean
  placeholder?: string
  onCommit: (raw: unknown) => void
}) {
  // Same reasoning as NumberControl: hold the text, commit only valid JSON.
  const [draft, setDraft] = useState(value === undefined ? '' : JSON.stringify(value))
  const [invalid, setInvalid] = useState(false)

  return (
    <div className="space-y-1">
      <div className={cn(
        'rounded-md shadow-minimal bg-foreground-2 focus-within:bg-background',
        invalid && 'ring-1 ring-destructive/40',
      )}>
        <Input
          id={id}
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={e => {
            const text = e.target.value
            setDraft(text)
            const trimmed = text.trim()
            if (trimmed === '') {
              setInvalid(false)
              onCommit(undefined)
              return
            }
            try {
              const parsed = JSON.parse(trimmed)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                setInvalid(false)
                onCommit(parsed)
                return
              }
              setInvalid(true)
            } catch {
              setInvalid(true)
            }
          }}
          className="border-0 bg-transparent shadow-none font-mono text-xs"
        />
      </div>
      {invalid && <p className="text-[11px] text-destructive">Not valid JSON — not saved</p>}
    </div>
  )
}

function KeyValueControl({
  value,
  disabled,
  onCommit,
}: {
  value: Record<string, string> | undefined
  disabled?: boolean
  onCommit: (raw: unknown) => void
}) {
  const rows: Array<[string, string]> = Object.entries(value ?? {})
  rows.push(['', '']) // trailing blank row for adding

  const commit = (next: Array<[string, string]>) => {
    const record = Object.fromEntries(next.filter(([k]) => k.trim() !== '').map(([k, v]) => [k.trim(), v]))
    onCommit(Object.keys(record).length > 0 ? record : undefined)
  }

  return (
    <div className="space-y-1">
      {rows.map(([key, entryValue], index) => (
        <div key={index} className="flex items-center gap-1.5">
          <div className={cn('rounded-md shadow-minimal bg-foreground-2 focus-within:bg-background flex-1')}>
            <Input
              value={key}
              disabled={disabled}
              placeholder="Header"
              onChange={e => {
                const next = rows.map(r => [...r] as [string, string])
                next[index] = [e.target.value, entryValue]
                commit(next)
              }}
              className="border-0 bg-transparent shadow-none font-mono text-xs"
            />
          </div>
          <div className={cn('rounded-md shadow-minimal bg-foreground-2 focus-within:bg-background flex-1')}>
            <Input
              value={entryValue}
              disabled={disabled || key.trim() === ''}
              placeholder="Value"
              onChange={e => {
                const next = rows.map(r => [...r] as [string, string])
                next[index] = [key, e.target.value]
                commit(next)
              }}
              className="border-0 bg-transparent shadow-none font-mono text-xs"
            />
          </div>
        </div>
      ))}
      <p className="text-[11px] text-foreground/25">Clear the header name to remove it.</p>
    </div>
  )
}
