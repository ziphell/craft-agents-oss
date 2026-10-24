/**
 * ServerSettingsPage
 *
 * Configure the Electron app to act as a remote server,
 * accessible from other machines on the network.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, AlertTriangle, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { isWebUI } from '@/lib/platform'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ServerConfig, ServerStatus } from '@craft-agent/shared/config/server-config'
import type { ClientModeInfo, DeviceToolInfo } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInputRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'server',
}

interface ServerFormState {
  enabled: boolean
  port: string
  allowExternal: boolean
  tlsCertPath: string
  tlsKeyPath: string
  token: string
  publicWsUrl: string
}

function configToForm(config: ServerConfig): ServerFormState {
  return {
    enabled: config.enabled,
    port: String(config.port),
    allowExternal: config.allowExternal !== false,
    tlsCertPath: config.tlsCertPath ?? '',
    tlsKeyPath: config.tlsKeyPath ?? '',
    token: config.token ?? '',
    publicWsUrl: config.publicWsUrl ?? '',
  }
}

function formToConfig(form: ServerFormState): ServerConfig {
  return {
    enabled: form.enabled,
    port: parseInt(form.port, 10) || 9100,
    allowExternal: form.allowExternal,
    tlsCertPath: form.tlsCertPath.trim() || undefined,
    tlsKeyPath: form.tlsKeyPath.trim() || undefined,
    token: form.token || undefined,
    publicWsUrl: form.publicWsUrl.trim() || undefined,
  }
}

/**
 * A token in the same shape the server would generate.
 *
 * Server Mode needs one before a client can connect, and the server only mints it at save time —
 * too late for the user to copy it out. Generating it here lets the value exist as part of the
 * form (visible, copyable, regenerable) from the moment the toggle goes on.
 */
function generateToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // randomUUID is missing outside secure contexts; getRandomValues is not.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export default function ServerSettingsPage() {
  const { t } = useTranslation()

  const [form, setForm] = useState<ServerFormState>({
    enabled: false,
    port: '9100',
    allowExternal: true,
    tlsCertPath: '',
    tlsKeyPath: '',
    token: '',
    publicWsUrl: '',
  })
  const [savedForm, setSavedForm] = useState<ServerFormState>(form)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [clientMode, setClientMode] = useState<ClientModeInfo | null>(null)
  const [devices, setDevices] = useState<DeviceToolInfo[] | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [error, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [browseTarget, setBrowseTarget] = useState<'cert' | 'key' | null>(null)
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  /** Set when this page asked the hub to restart, so the reconnect refreshes the form once. */
  const restartRequestedRef = useRef(false)
  const connectionStatus = useTransportConnectionState()?.status

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedForm)

  const loadSettings = useCallback(async () => {
    setLoadError(undefined)
    try {
      const [config, serverStatus] = await Promise.all([
        window.electronAPI.getServerConfig(),
        window.electronAPI.getServerStatus(),
      ])
      const formState = configToForm(config)
      setForm(formState)
      setSavedForm(formState)
      setStatus(serverStatus)
    } catch (err) {
      console.error('Failed to load server settings:', err)
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    // These channels follow the window's server, so a remote window edits its hub's listener rather
    // than this machine's. `clientMode` is kept only to decide where a restart can happen: relaunching
    // this process would restart the wrong machine.
    void loadSettings()
    if (
      window.electronAPI.getRuntimeEnvironment() === 'electron'
      && typeof window.electronAPI.getClientMode === 'function'
    ) {
      window.electronAPI.getClientMode().then(setClientMode).catch(() => {})
    }
  }, [loadSettings])

  useEffect(() => {
    // Only a reconnect caused by our own restart reloads the form. Doing it on every reconnect
    // would throw away unsaved edits whenever the transport blips.
    if (connectionStatus === 'connected' && restartRequestedRef.current) {
      restartRequestedRef.current = false
      void loadSettings()
    }
  }, [connectionStatus, loadSettings])

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true)
    try {
      setDevices(await window.electronAPI.getConnectedDevices())
    } catch (err) {
      console.error('Failed to load connected devices:', err)
    } finally {
      setDevicesLoading(false)
    }
  }, [])

  const isRemoteWindow = !!clientMode?.running
  // A webui tab has no local listener either: its server settings are the hub's.
  const isRemoteServer = isWebUI || isRemoteWindow
  const clientModeKnown = isWebUI || clientMode !== null
  // A headless hub does not register the handler: there is no process to relaunch through Electron.
  const canRestartServer = window.electronAPI.isChannelAvailable(RPC_CHANNELS.server.RESTART)
  const devicesVisible = form.enabled
  useEffect(() => {
    if (!devicesVisible) {
      setDevices(null)
      return
    }
    void loadDevices()
    const timer = setInterval(() => { void loadDevices() }, 5000)
    return () => clearInterval(timer)
  }, [devicesVisible, loadDevices])

  /**
   * Writes the form and returns the status the app reports afterwards, or null when the form was
   * rejected. Callers use the result to decide whether a restart has become necessary — the
   * listener's port, exposure and TLS can only change in a fresh process.
   *
   * Turning Server Mode off saves only that fact: the connection fields are not going to be used,
   * so a half-edited port or certificate pair is dropped instead of being written to disk.
   */
  const handleSave = async (): Promise<ServerStatus | null> => {
    setError(undefined)
    // Only the settings that will actually be used are validated: turning Server Mode off must
    // not be blocked by a port or a half-filled certificate pair that nothing will listen on.
    if (form.enabled) {
      const port = parseInt(form.port, 10)
      if (isNaN(port) || port < 1024 || port > 65535) {
        setError(t('settings.server.portValidation'))
        return null
      }
      if (form.tlsCertPath && !form.tlsKeyPath) {
        setError(t('settings.server.privateKeyRequired'))
        return null
      }
      if (form.tlsKeyPath && !form.tlsCertPath) {
        setError(t('settings.server.certificateRequired'))
        return null
      }
    }

    setIsSaving(true)
    try {
      const toSave = form.enabled ? form : { ...savedForm, enabled: false }
      await window.electronAPI.setServerConfig(formToConfig(toSave))
      // Read the config back instead of assuming it: the main process fills in a token the first
      // time Server Mode is enabled, and that value exists nowhere else until we ask for it.
      const stored = configToForm(await window.electronAPI.getServerConfig())
      setForm(stored)
      setSavedForm(stored)
      const newStatus = await window.electronAPI.getServerStatus()
      setStatus(newStatus)
      return newStatus
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(t('settings.server.failedToSave', { message: msg }))
      return null
    } finally {
      setIsSaving(false)
    }
  }

  /**
   * The page's single primary action. Every field here is read once at startup, so a save only
   * takes effect through a restart — the two are one button. A rejected form (bad port, half a
   * certificate pair) stops before the restart and stays on screen.
   */
  const handlePrimary = async () => {
    // Wait for the window mode before deciding where a restart goes; relaunching the wrong process
    // is worse than a button that stays disabled for a tick.
    if (!clientModeKnown) return
    // A remote window cannot apply a listener change by relaunching itself — the listener is on the
    // hub. Saving is all this window can do; the apply bar then says where the restart belongs.
    if (!isDirty) {
      if (!isRemoteServer) void window.electronAPI.relaunchApp()
      return
    }
    const saved = await handleSave()
    if (saved && !isRemoteServer) void window.electronAPI.relaunchApp()
  }

  /** Discards unsaved edits — back to the last saved config, not to factory defaults. */
  const handleUndoChanges = () => {
    setForm(savedForm)
    setError(undefined)
  }

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(t('settings.server.copiedToClipboard', { label }))
  }

  const handleBrowse = async (target: 'cert' | 'key') => {
    // A remote window's certificate lives on the hub, so the local OS picker would hand back a path
    // the server cannot see. Browse the server's own filesystem in that case.
    if (isRemoteServer) {
      setBrowseTarget(target)
      return
    }
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => target === 'cert' ? { ...f, tlsCertPath: paths[0]! } : { ...f, tlsKeyPath: paths[0]! })
    }
  }

  const handleRestartServer = async () => {
    setRestartConfirmOpen(false)
    setIsRestarting(true)
    restartRequestedRef.current = true
    try {
      // The hub answers first and exits a beat later; the window's transport reconnects on its own.
      await window.electronAPI.restartServer()
    } catch (err) {
      restartRequestedRef.current = false
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRestarting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col h-full">
        <PanelHeader title={t('settings.server.title')} />
        <div className="px-5 py-7 max-w-3xl mx-auto">
          <p className="text-xs text-destructive">{loadError}</p>
        </div>
      </div>
    )
  }

  const hasTls = !!(form.tlsCertPath && form.tlsKeyPath)
  const needsRestart = status?.needsRestart ?? false
  // The whole Connection block is the configuration of Server Mode, so it exists only while it is
  // on. Keeping it visible after unchecking left a half-state (port and TLS inputs with no URL),
  // which reads as if the server were still configured for something.
  const showServerDetails = form.enabled

  /**
   * The endpoint this form describes.
   *
   * Until the running listener is exactly this config — edited but unsaved, saved but not
   * restarted, or fallen back to another port — the live `status.url` describes something else
   * (before the first restart it is the loopback-only listener on a random port). The rows say
   * what will take effect instead, built from the form with the same rules the startup uses.
   */
  const draftUrl = `${hasTls ? 'wss' : 'ws'}://${
    form.allowExternal ? (status?.lanHost ?? '127.0.0.1') : '127.0.0.1'
  }:${parseInt(form.port, 10) || 9100}`
  const liveMatchesForm = !!status && savedForm.enabled && !needsRestart && !isDirty && !status.bindError
  const wsUrl = status && liveMatchesForm ? status.url : draftUrl
  const browserUrl = wsUrl.replace(/^ws/, 'http')

  // The token is generated on the first save, so before that there is nothing to show. Once it
  // exists, show the one that will be enforced: the running server's while it matches the form,
  // the saved one otherwise (it is what the restarted server will accept).
  const token = form.token || (status && liveMatchesForm ? status.token : '')

  // Reverse-proxy / port-mapping address, taken from the form because it is part of this config.
  const publicWsUrl = form.publicWsUrl.trim()
  const publicHttpUrl = publicWsUrl.replace(/^ws/, 'http')

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t("settings.server.title")} />
      <ScrollArea className="flex-1">
        <div className="px-5 py-7 max-w-3xl mx-auto space-y-5">

          {/* Enable toggle */}
          <SettingsSection title={t("settings.server.remoteAccess")}>
            <SettingsCard>
              <SettingsToggle
                label={t("settings.server.enableServerMode")}
                description={t("settings.server.allowRemoteConnections")}
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm(f => ({
                  ...f,
                  enabled,
                  // Mint the token up front so it is part of the config being edited (copyable now,
                  // regenerable below) instead of appearing only after the server first saves one.
                  token: enabled && !f.token ? generateToken() : f.token,
                }))}
              />
            </SettingsCard>
          </SettingsSection>

          {/*
           * Apply bar. It belongs to the Server Mode section rather than the bottom of the page:
           * everything below is either editable (port, TLS) or read-only (devices), and an action
           * bar under the devices list reads like it applies to them. It is a sibling of the
           * sections, not a child, so `sticky` is bounded by the page instead of by the toggle card
           * and stays reachable while the fields below are edited.
           *
           * Every field on this page lands in the listener's startup config, so saving alone never
           * applies anything. In a local window that makes saving and restarting one button; in a
           * remote window the listener is on the hub, so this window can only save and the bar says
           * where the restart belongs.
           */}
          {(isDirty || needsRestart || error) && (
            <div className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border border-warning/40 bg-background px-3 py-2.5 shadow-thin">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
              <div className="flex-1 space-y-0.5 text-xs">
                <p className="font-medium text-warning">{t('settings.server.restartRequired')}</p>
                {error && <p className="text-destructive">{error}</p>}
              </div>
              {isDirty && (
                <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={handleUndoChanges} disabled={isSaving}>
                  {t('settings.server.undoChanges')}
                </Button>
              )}
              {isRemoteServer && !isDirty ? (
                needsRestart && (
                  canRestartServer ? (
                    <Button
                      size="sm"
                      className="h-7 shrink-0"
                      onClick={() => setRestartConfirmOpen(true)}
                      disabled={isRestarting}
                    >
                      {isRestarting ? <Spinner className="mr-1.5" /> : null}
                      {t('settings.server.restartNow')}
                    </Button>
                  ) : (
                    <span className="max-w-[320px] text-right text-xs text-muted-foreground">
                      {t('settings.server.thinClientNotice', {
                        url: clientMode?.running?.url ?? (isWebUI ? window.location.origin : ''),
                      })}
                    </span>
                  )
                )
              ) : (
                <Button
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={handlePrimary}
                  disabled={isSaving || !clientModeKnown}
                >
                  {isSaving ? <Spinner className="mr-1.5" /> : null}
                  {isDirty
                    ? (isRemoteServer ? t('common.save') : t('settings.server.saveAndRestart'))
                    : t('settings.server.restartNow')}
                </Button>
              )}
            </div>
          )}

          {/* Connection + TLS — only visible when server mode is relevant */}
          {showServerDetails && (
            <SettingsSection title={t("settings.server.connectionSection")}>
              <SettingsCard>
                <SettingsInputRow
                  label={t("settings.server.port")}
                  value={form.port}
                  onChange={(port) => setForm(f => ({ ...f, port }))}
                  placeholder="9100"
                />

                {/* Endpoint rows. Shown whenever Server Mode is on — this is the address the user
                    hands to another machine — and they follow the form until the running listener
                    matches it. The token is different: it only exists once the server runs with
                    this config, so it stays hidden until then. */}
                {form.enabled && (
                  <>
                    <SettingsRow label={t("settings.server.wsUrl")}>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                          {wsUrl}
                        </code>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(wsUrl, t("settings.server.wsUrl"))}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>

                    <SettingsRow label={t("settings.server.browserUrl")}>
                      <div className="flex items-center gap-1.5">
                        {/* Same host:port, HTTP(S) for the browser (the WS URL is the client endpoint). */}
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                          {browserUrl}
                        </code>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(browserUrl, t("settings.server.browserUrl"))}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>

                    {publicWsUrl && (
                      <>
                        <SettingsRow label={t("settings.server.publicWsUrl")}>
                          <div className="flex items-center gap-1.5">
                            <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                              {publicWsUrl}
                            </code>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(publicWsUrl, t("settings.server.publicWsUrl"))}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </SettingsRow>

                        <SettingsRow label={t("settings.server.publicBrowserUrl")}>
                          <div className="flex items-center gap-1.5">
                            <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                              {publicHttpUrl}
                            </code>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(publicHttpUrl, t("settings.server.publicBrowserUrl"))}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </SettingsRow>
                      </>
                    )}

                    <SettingsRow label={t("settings.server.token")}>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded max-w-[180px] truncate">
                          {token ? (tokenVisible ? token : '••••••••••••••••') : '—'}
                        </code>
                        {token && (
                          <>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setTokenVisible(v => !v)}>
                              {tokenVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(token, 'Token')}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          title={t('settings.server.regenerateToken')}
                          onClick={() => {
                            setForm(f => ({ ...f, token: generateToken() }))
                            setTokenVisible(true)
                          }}
                        >
                          <RotateCw className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>
                  </>
                )}

                <SettingsRow label={t("settings.server.certificate")}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {form.tlsCertPath || 'Not configured'}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 shrink-0" onClick={() => { void handleBrowse('cert') }}>
                      Browse
                    </Button>
                  </div>
                </SettingsRow>

                <SettingsRow label={t("settings.server.privateKey")}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {form.tlsKeyPath || 'Not configured'}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 shrink-0" onClick={() => { void handleBrowse('key') }}>
                      Browse
                    </Button>
                  </div>
                </SettingsRow>

                <SettingsInputRow
                  label={t("settings.server.publicWsUrl")}
                  description={t("settings.server.publicWsUrlDesc")}
                  value={form.publicWsUrl}
                  onChange={(publicWsUrl) => setForm(f => ({ ...f, publicWsUrl }))}
                  placeholder="wss://agents.example.com"
                />
              </SettingsCard>

              {!needsRestart && status?.bindError && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{t("settings.server.bindError")}</span>
                </div>
              )}

              {form.enabled && !hasTls && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    {status?.insecureWarning && !needsRestart && !isDirty
                      ? t("settings.server.insecureWarning")
                      : t("settings.server.noTlsWarning")}
                  </span>
                </div>
              )}
            </SettingsSection>
          )}

          {/* Devices — the machines this hub can drive. This server's own tools need no row. */}
          {devicesVisible && (
            <SettingsSection title={t("settings.server.connectedDevices")}>
              <SettingsCard>
                {devices === null ? (
                  <SettingsRow label={t("settings.server.loadingDevices")} />
                ) : devices.length === 0 ? (
                  <SettingsRow label={t("settings.server.noDevices")} />
                ) : (
                  devices.map((device) => (
                    <SettingsRow
                      key={device.id}
                      label={
                        <span className="flex items-center gap-2">
                          <span className="truncate">{device.name}</span>
                          {device.capabilities.browser && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {t("settings.server.deviceBrowser")}
                            </span>
                          )}
                        </span>
                      }
                      description={
                        [device.platform, device.version ? `v${device.version}` : null]
                          .filter(Boolean)
                          .join(' · ') || undefined
                      }
                    />
                  ))
                )}
              </SettingsCard>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground px-1">
                  {t("settings.server.connectedDevicesDesc")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] px-2 shrink-0"
                  onClick={() => { void loadDevices() }}
                  disabled={devicesLoading}
                >
                  {devicesLoading ? <Spinner className="mr-1" /> : null}
                  {t("common.refresh")}
                </Button>
              </div>
            </SettingsSection>
          )}

        </div>
      </ScrollArea>

      <ServerDirectoryBrowser
        open={browseTarget !== null}
        mode="browse"
        selectionKind="file"
        onSelect={(path) => {
          if (browseTarget === 'cert') setForm(f => ({ ...f, tlsCertPath: path }))
          else if (browseTarget === 'key') setForm(f => ({ ...f, tlsKeyPath: path }))
          setBrowseTarget(null)
        }}
        onCancel={() => setBrowseTarget(null)}
      />

      <Dialog open={restartConfirmOpen} onOpenChange={setRestartConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.server.restartRequired')}</DialogTitle>
            <DialogDescription>
              {t('settings.server.thinClientNotice', {
                url: clientMode?.running?.url ?? (isWebUI ? window.location.origin : ''),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setRestartConfirmOpen(false)} disabled={isRestarting}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => { void handleRestartServer() }} disabled={isRestarting}>
              {isRestarting ? <Spinner className="mr-1.5" /> : null}
              {t('settings.server.restartNow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
