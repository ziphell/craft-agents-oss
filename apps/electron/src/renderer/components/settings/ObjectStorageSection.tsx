/**
 * Where the reference files live when a provider will only read `http(s)`.
 *
 * The shape follows the two projects this was modelled on: pick a vendor, fill the one field that
 * vendor needs (a region, or an R2 account id), add the bucket and keys, then save and test. The
 * test uploads a probe, reads it back through the same URL a provider would receive, and removes it
 * — a successful PUT alone does not prove the bucket is readable.
 *
 * The secret is never read back: `hasSecret` says whether one is stored, and an empty field keeps it.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Save, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'
import { SettingsToggle } from './SettingsToggle'
import { SettingsInput, SettingsSecretInput } from './SettingsInput'
import {
  DEFAULT_OBJECT_STORAGE,
  identifierOf,
  normalizeObjectStorage,
  vendorEndpoint,
  vendorIdentifierField,
  vendorPathStyle,
  vendorRegionPlaceholder,
  type ObjectStorageConfig,
  type ObjectStorageFailure,
  type ObjectStorageVendor,
} from '@craft-agent/shared/media/object-storage-config'

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring'

const VENDORS: Array<{ id: ObjectStorageVendor; labelKey: string }> = [
  { id: 'volcengine', labelKey: 'settings.objectStorage.vendorVolcengine' },
  { id: 'aliyun', labelKey: 'settings.objectStorage.vendorAliyun' },
  { id: 'tencent', labelKey: 'settings.objectStorage.vendorTencent' },
  { id: 'qiniu', labelKey: 'settings.objectStorage.vendorQiniu' },
  { id: 'cloudflare', labelKey: 'settings.objectStorage.vendorCloudflare' },
  { id: 'aws', labelKey: 'settings.objectStorage.vendorAws' },
  { id: 'custom', labelKey: 'settings.objectStorage.vendorCustom' },
]

export function ObjectStorageSection() {
  const { t } = useTranslation()
  const [config, setConfig] = React.useState<ObjectStorageConfig>(DEFAULT_OBJECT_STORAGE)
  const [identifier, setIdentifier] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const [hasSecret, setHasSecret] = React.useState(false)
  const [clearSecret, setClearSecret] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<'save' | 'test' | null>(null)
  const [problem, setProblem] = React.useState<string | undefined>()
  const [feedback, setFeedback] = React.useState<{ ok: boolean; text: string } | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const reply = await window.electronAPI.mediaObjectStorage()
      const next = normalizeObjectStorage(reply.config)
      setConfig(next)
      setIdentifier(identifierOf(next))
      setHasSecret(reply.hasSecret)
      setSecret('')
      setClearSecret(false)
      setProblem(reply.problem)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const patch = (next: Partial<ObjectStorageConfig>) =>
    setConfig((current) => ({ ...current, ...next }))

  /** The form as the server should see it: a vendor preset fills in the endpoint and region. */
  const draft = (): ObjectStorageConfig | null => {
    // Turning it off must always be savable: an empty form has nothing to derive an endpoint from,
    // and refusing here would leave the switch on with no way to turn it back off.
    if (!config.enabled) return normalizeObjectStorage(config)
    if (config.vendor === 'custom') {
      return normalizeObjectStorage({
        ...config,
        endpoint: config.endpoint.trim(),
        region: config.region.trim(),
      })
    }
    const endpoint = vendorEndpoint(config.vendor, identifier)
    if (!endpoint) {
      toast.error(t('settings.objectStorage.invalidIdentifier'))
      return null
    }
    return normalizeObjectStorage({
      ...config,
      endpoint,
      region: config.vendor === 'cloudflare' ? 'auto' : identifier.trim().toLowerCase(),
      pathStyle: vendorPathStyle(config.vendor),
    })
  }

  const describeFailure = (result: {
    reason?: ObjectStorageFailure
    status?: number
    detail?: string
  }): string => {
    const base = (() => {
      switch (result.reason) {
        case 'secret':
          return t('settings.objectStorage.errorSecret')
        case 'config':
          return t('settings.objectStorage.errorConfig')
        case 'network':
          return t('settings.objectStorage.errorNetwork')
        case 'auth':
          return t('settings.objectStorage.errorAuth')
        case 'bucket':
          return t('settings.objectStorage.errorBucket')
        case 'read':
          return t('settings.objectStorage.errorRead')
        default:
          return result.status
            ? t('settings.objectStorage.testFailedStatus', { status: result.status })
            : t('settings.objectStorage.testFailed')
      }
    })()
    return result.detail ? `${base} ${result.detail}` : base
  }

  const run = async (test: boolean) => {
    if (busy) return
    const next = draft()
    if (!next) return
    setFeedback(null)
    setBusy(test ? 'test' : 'save')
    try {
      const typed = secret.trim()
      const saved = await window.electronAPI.mediaObjectStorageSave({
        config: next,
        ...(typed ? { secretAccessKey: typed } : {}),
        ...(clearSecret ? { clearSecret: true } : {}),
      })
      if (!saved.ok) {
        setFeedback({
          ok: false,
          text: saved.message ?? t('settings.objectStorage.saveFailed'),
        })
        return
      }
      if (!test) {
        toast.success(t('settings.objectStorage.saved'))
        await load()
        return
      }
      const result = await window.electronAPI.mediaObjectStorageTest({
        config: next,
        ...(typed ? { secretAccessKey: typed } : {}),
      })
      setFeedback(
        result.ok
          ? { ok: true, text: t('settings.objectStorage.testOk') }
          : { ok: false, text: describeFailure(result) },
      )
      await load()
    } catch (error) {
      setFeedback({
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const isCustom = config.vendor === 'custom'
  const needsAccountId = vendorIdentifierField(config.vendor) === 'accountId'
  const derivedEndpoint = isCustom ? '' : vendorEndpoint(config.vendor, identifier)

  return (
    <SettingsSection
      title={t('settings.objectStorage.title')}
      description={t('settings.objectStorage.description')}
      action={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void run(false)}
            disabled={loading || Boolean(busy)}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {busy === 'save' ? t('settings.objectStorage.saving') : t('settings.objectStorage.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run(true)}
            disabled={loading || Boolean(busy)}
          >
            <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
            {busy === 'test' ? t('settings.objectStorage.testing') : t('settings.objectStorage.saveAndTest')}
          </Button>
        </div>
      }
    >
      <SettingsCard>
        {problem ? (
          <div className="px-4 py-3 text-sm text-amber-600 dark:text-amber-400">{problem}</div>
        ) : null}

        <SettingsToggle
          label={t('settings.objectStorage.enabled')}
          description={t('settings.objectStorage.enabledHint')}
          checked={config.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
          disabled={loading || Boolean(busy)}
        />

        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1">
            <Label className="text-xs">{t('settings.objectStorage.vendor')}</Label>
            <select
              className={selectClass}
              value={config.vendor}
              disabled={loading || Boolean(busy)}
              onChange={(event) => {
                const vendor = event.target.value as ObjectStorageVendor
                // The identifier belongs to the previous vendor: a region that exists over there is
                // not a TOS region. Start from the new vendor's own default so the endpoint it
                // derives is immediately the right one.
                patch({ vendor, endpoint: '', region: '' })
                setIdentifier(
                  vendorIdentifierField(vendor) === 'accountId' || vendor === 'custom'
                    ? ''
                    : vendorRegionPlaceholder(vendor),
                )
                setFeedback(null)
              }}
            >
              {VENDORS.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {t(vendor.labelKey)}
                </option>
              ))}
            </select>
          </div>

          {isCustom ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingsInput
                label={t('settings.objectStorage.endpoint')}
                description={t('settings.objectStorage.endpointHint')}
                value={config.endpoint}
                onChange={(endpoint) => patch({ endpoint })}
                placeholder="https://s3.example.com"
                type="url"
                disabled={loading || Boolean(busy)}
              />
              <SettingsInput
                label={t('settings.objectStorage.region')}
                description={t('settings.objectStorage.regionHint')}
                value={config.region}
                onChange={(region) => patch({ region })}
                placeholder="us-east-1"
                disabled={loading || Boolean(busy)}
              />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingsInput
                label={
                  needsAccountId
                    ? t('settings.objectStorage.accountId')
                    : t('settings.objectStorage.region')
                }
                description={
                  needsAccountId
                    ? t('settings.objectStorage.accountIdHint')
                    : t('settings.objectStorage.regionHint')
                }
                value={identifier}
                onChange={setIdentifier}
                placeholder={
                  needsAccountId ? '0123456789abcdef' : vendorRegionPlaceholder(config.vendor)
                }
                disabled={loading || Boolean(busy)}
              />
              <SettingsInput
                label={t('settings.objectStorage.bucket')}
                value={config.bucket}
                onChange={(bucket) => patch({ bucket })}
                placeholder="my-bucket"
                disabled={loading || Boolean(busy)}
              />
            </div>
          )}

          {isCustom ? (
            <SettingsInput
              label={t('settings.objectStorage.bucket')}
              value={config.bucket}
              onChange={(bucket) => patch({ bucket })}
              placeholder="my-bucket"
              disabled={loading || Boolean(busy)}
            />
          ) : null}

          {derivedEndpoint ? (
            <p className="text-[11px] text-muted-foreground">
              {t('settings.objectStorage.derivedEndpoint', { endpoint: derivedEndpoint })}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsInput
              label={t('settings.objectStorage.accessKeyId')}
              value={config.accessKeyId}
              onChange={(accessKeyId) => patch({ accessKeyId })}
              placeholder="AKIA..."
              disabled={loading || Boolean(busy)}
            />
            <div>
              <SettingsSecretInput
                label={t('settings.objectStorage.secretAccessKey')}
                value={secret}
                onChange={(value) => {
                  setSecret(value)
                  setClearSecret(false)
                }}
                placeholder={
                  hasSecret
                    ? t('settings.objectStorage.secretStored')
                    : t('settings.objectStorage.secretPlaceholder')
                }
                disabled={loading || Boolean(busy)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {hasSecret ? t('settings.objectStorage.secretStoredHint') : t('settings.objectStorage.secretHint')}
                {hasSecret ? (
                  <button
                    type="button"
                    className="ml-1 underline underline-offset-2 hover:text-foreground"
                    onClick={() => {
                      setSecret('')
                      setHasSecret(false)
                      setClearSecret(true)
                    }}
                  >
                    {t('settings.objectStorage.clearSecret')}
                  </button>
                ) : null}
              </p>
            </div>
          </div>

          <details className="rounded-md border border-border/60 px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('settings.objectStorage.advanced')}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <SettingsInput
                label={t('settings.objectStorage.keyPrefix')}
                description={t('settings.objectStorage.keyPrefixHint')}
                value={config.keyPrefix}
                onChange={(keyPrefix) => patch({ keyPrefix })}
                placeholder="craft-agent/references"
                disabled={loading || Boolean(busy)}
              />
              <SettingsInput
                label={t('settings.objectStorage.publicBaseUrl')}
                description={t('settings.objectStorage.publicBaseUrlHint')}
                value={config.publicBaseUrl}
                onChange={(publicBaseUrl) => patch({ publicBaseUrl })}
                placeholder="https://media.example.com"
                type="url"
                disabled={loading || Boolean(busy)}
              />
              {isCustom ? (
                <label className="flex items-start gap-2 text-xs sm:col-span-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                    checked={config.pathStyle}
                    disabled={loading || Boolean(busy)}
                    onChange={(event) => patch({ pathStyle: event.target.checked })}
                  />
                  <span>
                    <span className="font-medium">{t('settings.objectStorage.pathStyle')}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t('settings.objectStorage.pathStyleHint')}
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          </details>

          {feedback ? (
            <p
              className={
                feedback.ok
                  ? 'text-xs text-emerald-600 dark:text-emerald-400'
                  : 'text-xs text-destructive'
              }
            >
              {feedback.text}
            </p>
          ) : null}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
