/**
 * Where a recording becomes words: on this machine, or through a cloud recogniser.
 *
 * Two sides, one form. Local is a folder of ONNX models read by `asr-tool`; cloud is a fixed wire
 * with the person's own key, which never leaves the credential store. The wires are written down
 * in `asr-config.ts` — recognition is not a media generation account — so picking Doubao asks for
 * one key and nothing else, while the OpenAI-compatible wire also asks where its server lives.
 *
 * The saved file is `~/.craft-agent/asr.json`; what is actually usable locally is measured here
 * (`asr:models`) rather than inferred, so a missing folder is a sentence rather than a silent
 * fallback.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsCard } from './SettingsCard'
import { SettingsRow } from './SettingsRow'
import { SettingsInput, SettingsSecretInput } from './SettingsInput'
import { SettingsMenuSelect } from './SettingsMenuSelect'
import { SettingsSection } from './SettingsSection'
import { SettingsSegmentedControl } from './SettingsSegmentedControl'
import { SettingsSelectRow } from './SettingsSelect'
import {
  ASR_CLOUD_PROVIDERS,
  ASR_LANGUAGES,
  normalizeAsrConfig,
  type AsrCloudProvider,
  type AsrConfig,
} from '@craft-agent/shared/media/asr-config'
import type { ModelDownloadStatus, ModelMirror } from '@craft-agent/shared/media'

/** A size a person can weigh: "239 MB", "1.2 GB". */
const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`

interface DownloadableModel {
  id: string
  title: string
  bytes: number
  installed: boolean
}

export function AsrSection() {
  const { t } = useTranslation()
  const [config, setConfig] = React.useState<AsrConfig>({ version: 1, mode: 'local', local: {}, cloud: {} })
  const [hasKey, setHasKey] = React.useState(false)
  const [savedProvider, setSavedProvider] = React.useState<AsrCloudProvider | undefined>(undefined)
  const [apiKey, setApiKey] = React.useState('')
  const [chosen, setChosen] = React.useState<{ id: string } | null>(null)
  const [root, setRoot] = React.useState('')
  const [vad, setVad] = React.useState(false)
  const [problem, setProblem] = React.useState<string | undefined>()
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [models, setModels] = React.useState<DownloadableModel[]>([])
  const [mirrors, setMirrors] = React.useState<Array<{ id: ModelMirror; label: string }>>([])
  const [mirror, setMirror] = React.useState<ModelMirror>('huggingface')
  const [download, setDownload] = React.useState<ModelDownloadStatus | null>(null)
  const [starting, setStarting] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [saved, found] = await Promise.all([
        window.electronAPI.asrConfig(),
        window.electronAPI.asrModels(),
      ])
      const loaded = normalizeAsrConfig(saved.config)
      // Cloud with nothing saved settles on the one provider, so the form can be saved as it opens.
      if (loaded.mode === 'cloud' && !loaded.cloud.provider) {
        loaded.cloud = { provider: ASR_CLOUD_PROVIDERS[0].id }
      }
      setConfig(loaded)
      setHasKey(saved.hasKey)
      setSavedProvider(loaded.cloud.provider)
      setApiKey('')
      setProblem(saved.problem)
      setChosen(found.chosen)
      setRoot(found.root)
      setVad(found.vad)
      setModels(found.downloads)
      setMirrors(found.mirrors)
      setMirror((current) =>
        found.mirrors.some((item) => item.id === current) ? current : (found.mirrors[0]?.id ?? 'huggingface'),
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const patch = (next: Partial<AsrConfig['local']>) =>
    setConfig((current) => ({ ...current, local: { ...current.local, ...next } }))

  const setMode = (mode: AsrConfig['mode']) => {
    setConfig((current) => {
      // Entering the cloud side with nothing chosen would be a form that cannot be saved; the
      // first provider is the same default the select shows.
      if (mode === 'cloud' && !current.cloud.provider) {
        return { ...current, mode, cloud: { provider: ASR_CLOUD_PROVIDERS[0].id } }
      }
      return { ...current, mode }
    })
  }

  const setProvider = (id: AsrCloudProvider) => {
    setConfig((current) => ({
      ...current,
      cloud: {
        provider: id,
        // The address and model belong to the OpenAI-compatible wire; keep them so switching away
        // and back does not lose them. Doubao ignores both, and every wire takes the language.
        ...(current.cloud.baseUrl ? { baseUrl: current.cloud.baseUrl } : {}),
        ...(current.cloud.model ? { model: current.cloud.model } : {}),
        ...(current.cloud.language ? { language: current.cloud.language } : {}),
      },
    }))
    setApiKey('')
  }

  const provider = ASR_CLOUD_PROVIDERS.find((entry) => entry.id === config.cloud.provider) ?? null
  /** A key belongs to the provider that was saved; another provider in the form has none yet. */
  const keyPresent = hasKey && config.cloud.provider === savedProvider

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const reply = await window.electronAPI.asrConfigSave({
        config,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      if (!reply.ok) {
        toast.error(reply.message ?? t('settings.asr.saveFailed'))
        return
      }
      toast.success(t('settings.asr.saved'))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /** Remove the stored key for the chosen provider — the form's other values are saved as they are. */
  const removeKey = async () => {
    if (saving) return
    setSaving(true)
    try {
      const reply = await window.electronAPI.asrConfigSave({ config, clearKey: true })
      if (!reply.ok) {
        toast.error(reply.message ?? t('settings.asr.saveFailed'))
        return
      }
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const startDownload = async () => {
    if (starting) return
    setStarting(true)
    try {
      const reply = await window.electronAPI.asrDownload({ mirror })
      setDownload(reply.status)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  const cancelDownload = async () => {
    try {
      const reply = await window.electronAPI.asrDownloadCancel()
      setDownload(reply.status)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  // One poll per running download, stopped by the phase changing to anything else. The result is
  // read from the server rather than remembered here, so closing and reopening this page mid-way
  // still shows the truth.
  const phase = download?.phase
  React.useEffect(() => {
    if (phase !== 'downloading' && phase !== 'verifying') return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const reply = await window.electronAPI.asrDownloadStatus()
        if (cancelled) return
        setDownload(reply.status)
        if (reply.status.phase === 'done') {
          toast.success(t('settings.asr.downloaded'))
          void load()
        } else if (reply.status.phase === 'failed') {
          toast.error(reply.status.message ?? t('settings.asr.downloadFailed'))
        }
      } catch {
        // A poll that cannot answer is not the download failing; the next tick asks again.
      }
    }, 700)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [phase, load, t])

  const disabled = loading || saving
  const busy = download?.phase === 'downloading' || download?.phase === 'verifying'
  const offered = models.find((model) => !model.installed)
  /** The catalogue entry behind the installed folder, which is where the model's title comes from. */
  const installedModel = chosen ? models.find((model) => model.id === chosen.id) : undefined

  return (
    <SettingsSection
      title={t('settings.asr.title')}
      description={t('settings.asr.description')}
      action={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={disabled}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.asr.refresh')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void save()} disabled={disabled}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? t('settings.asr.saving') : t('settings.asr.save')}
          </Button>
        </div>
      }
    >
      <SettingsCard>
        {problem ? (
          <div className="px-4 py-3 text-sm text-amber-600 dark:text-amber-400">{problem}</div>
        ) : null}

        <SettingsRow label={t('settings.asr.mode')}>
          <div className={disabled ? 'pointer-events-none opacity-50' : undefined}>
            <SettingsSegmentedControl
              size="sm"
              value={config.mode}
              onValueChange={(mode) => setMode(mode === 'cloud' ? 'cloud' : 'local')}
              options={[
                { value: 'local', label: t('settings.speech.local') },
                { value: 'cloud', label: t('settings.speech.cloud') },
              ]}
            />
          </div>
        </SettingsRow>

        {config.mode === 'local' ? (
          <>
            <SettingsSelectRow
              label={t('settings.asr.language')}
              value={config.local.language || 'auto'}
              onValueChange={(language) => patch({ language: language === 'auto' ? '' : language })}
              options={ASR_LANGUAGES.map((language) => ({ value: language, label: language }))}
              disabled={disabled}
            />

            <SettingsRow
              label={t('settings.speech.model')}
              {...(chosen
                ? { description: installedModel?.title ?? 'SenseVoice' }
                : offered
                  ? { description: offered.title }
                  : {})}
            >
              {chosen ? (
                <span className="text-xs text-muted-foreground">{t('settings.asr.installed')}</span>
              ) : busy ? (
                <Button size="sm" variant="outline" onClick={() => void cancelDownload()}>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.asr.downloadCancel')}
                </Button>
              ) : offered ? (
                <Button size="sm" variant="outline" onClick={() => void startDownload()} disabled={starting}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.asr.download')}
                </Button>
              ) : null}
            </SettingsRow>

            {!chosen ? (
              <p className="-mt-2 px-4 pb-3.5 text-[11px] text-muted-foreground">
                {offered
                  ? t('settings.asr.downloadHint', { size: formatBytes(offered.bytes), root })
                  : t('settings.asr.noModels', { root })}
              </p>
            ) : null}

            {busy ? (
              <div className="space-y-1.5 px-4 pb-3.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${download?.percent ?? 0}%` }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {download?.phase === 'verifying'
                    ? t('settings.asr.downloadVerifying')
                    : t('settings.asr.downloading', { percent: download?.percent ?? 0 })}
                </p>
              </div>
            ) : null}

            {!chosen && !busy && mirrors.length > 0 ? (
              <SettingsRow label={t('settings.asr.downloadSource')}>
                <SettingsMenuSelect
                  value={mirror}
                  onValueChange={(value) => setMirror(value as ModelMirror)}
                  options={mirrors.map((item) => ({ value: item.id, label: item.label }))}
                  disabled={disabled}
                />
              </SettingsRow>
            ) : null}

            {download?.phase === 'failed' && !chosen ? (
              <p className="px-4 pb-3.5 text-[11px] text-amber-600 dark:text-amber-400">
                {download.message ?? t('settings.asr.downloadFailed')}
              </p>
            ) : null}

            {chosen && !vad ? (
              <p className="px-4 pb-3.5 text-[11px] text-muted-foreground">{t('settings.asr.vadOff')}</p>
            ) : null}
          </>
        ) : (
          <>
            <SettingsRow label={t('settings.asr.provider')}>
              <SettingsMenuSelect
                value={config.cloud.provider ?? ''}
                onValueChange={(value) => setProvider(value as AsrCloudProvider)}
                options={ASR_CLOUD_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.name }))}
                placeholder="—"
                disabled={disabled}
              />
            </SettingsRow>

            {provider?.id === 'openai' ? (
              <SettingsInput
                inCard
                label={t('settings.asr.baseUrl')}
                description={t('settings.asr.baseUrlHint')}
                value={config.cloud.baseUrl ?? ''}
                onChange={(baseUrl) =>
                  setConfig((current) => ({
                    ...current,
                    cloud: { ...current.cloud, baseUrl },
                  }))
                }
                placeholder={provider.baseUrl}
                disabled={disabled}
              />
            ) : null}

            {provider?.id === 'openai' ? (
              <SettingsInput
                inCard
                label={t('settings.speech.model')}
                value={config.cloud.model ?? ''}
                onChange={(model) =>
                  setConfig((current) => ({
                    ...current,
                    cloud: { ...current.cloud, model },
                  }))
                }
                placeholder={t('settings.asr.modelFreePlaceholder')}
                disabled={disabled}
              />
            ) : null}

            <SettingsSelectRow
              label={t('settings.asr.language')}
              value={config.cloud.language || 'auto'}
              onValueChange={(language) =>
                setConfig((current) => ({
                  ...current,
                  cloud: { ...current.cloud, language: language === 'auto' ? '' : language },
                }))
              }
              options={ASR_LANGUAGES.map((language) => ({ value: language, label: language }))}
              disabled={disabled}
            />

            <div>
              <SettingsSecretInput
                inCard
                label={t('settings.asr.apiKey')}
                value={apiKey}
                onChange={setApiKey}
                placeholder={keyPresent ? t('settings.asr.apiKeySaved') : t('settings.asr.apiKeyPlaceholder')}
                disabled={disabled}
              />
              {keyPresent ? (
                <button
                  type="button"
                  className="-mt-2 px-4 pb-3 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  disabled={disabled}
                  onClick={() => void removeKey()}
                >
                  {t('settings.asr.apiKeyClear')}
                </button>
              ) : null}
            </div>
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
