/**
 * ServerSettingsPage
 *
 * Configure the Electron app to act as a remote server,
 * accessible from other machines on the network.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, AlertTriangle, RotateCw, Pencil, Trash2, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@craft-agent/ui'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { useRegisterModal } from '@/context/ModalContext'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { isWebUI } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ServerConfig, ServerStatus } from '@craft-agent/shared/config/server-config'
import type { ClientModeInfo, DeviceToolInfo, DeviceTokenInfo } from '../../../shared/types'

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

/**
 * The one shape for a row action on this page — the same quiet pill the rest of Settings uses
 * (see `SettingsEditRow`), so a row never turns into a toolbar.
 */
function RowButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-[6px] bg-background px-2.5 shadow-minimal"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

/** A secondary action that belongs to the value beside it, not to the page. */
function IconAction({
  icon: Icon,
  title,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  )
}

/** `process.platform` in the words a person uses — the row says macOS, not darwin. */
function platformLabel(platform: string | null): string | null {
  if (!platform) return null
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

/**
 * One address with its copy button.
 *
 * It is a line rather than a row so two of them stack inside one settings row: the machine's own
 * address, and the external one underneath it when there is one.
 */
function AddressLine({ url, title, onCopy }: { url: string; title: string; onCopy: () => void }) {
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-sm text-muted-foreground">{url}</span>
      <IconAction icon={Copy} title={title} onClick={onCopy} />
    </span>
  )
}

/** A heading inside a card, in the same voice as the section titles above it. */
function GroupLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)}>
      {children}
    </div>
  )
}

interface ServerFormState {
  enabled: boolean
  port: string
  allowExternal: boolean
  tlsCertPath: string
  tlsKeyPath: string
  webuiPassword: string
  publicWsUrl: string
}

function configToForm(config: ServerConfig): ServerFormState {
  return {
    enabled: config.enabled,
    port: String(config.port),
    allowExternal: config.allowExternal !== false,
    tlsCertPath: config.tlsCertPath ?? '',
    tlsKeyPath: config.tlsKeyPath ?? '',
    webuiPassword: config.webuiPassword ?? '',
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
    webuiPassword: form.webuiPassword.trim() || undefined,
    publicWsUrl: form.publicWsUrl.trim() || undefined,
  }
}

/**
 * A secret in the same shape the server would generate.
 *
 * The Web UI needs a password before the listener starts, and the server only mints it at save
 * time — too late for the user to copy it out. Generating it here lets the value exist as part of
 * the form (visible, copyable, regenerable) from the moment the toggle goes on. The server token
 * is not shown and is minted by the main process, so it never appears in this form.
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

interface AddDeviceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  onLabelChange: (label: string) => void
  remoteCap: boolean
  onRemoteCapChange: (on: boolean) => void
  onCreate: () => void
  creating: boolean
}

/**
 * A slot grants a machine remote control of this server. Device use — this server calling the
 * other machine's tools — is a separate right: it starts on when the machine connects (offering
 * folders is its consent) and is turned off in the device list, not here. So the invitation only
 * asks for remote control.
 */
function AddDeviceDialog({
  open,
  onOpenChange,
  label,
  onLabelChange,
  remoteCap,
  onRemoteCapChange,
  onCreate,
  creating,
}: AddDeviceDialogProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  // Register with modal context so X button / Cmd+W closes this dialog first
  useRegisterModal(open, () => onOpenChange(false))

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [open])

  const submit = () => {
    onCreate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('settings.server.addDevice')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            ref={inputRef}
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder={t('settings.server.deviceLabelPlaceholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
          {/* The invitation only sets the starting value; the device list is where it is changed. */}
          <label className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t('settings.server.capabilityRemote')}</span>
            </span>
            <Switch checked={remoteCap} onCheckedChange={onRemoteCapChange} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={creating}>
            {creating ? <Spinner className="mr-1.5" /> : null}
            {t('settings.server.addDevice')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ServerSettingsPage() {
  const { t } = useTranslation()

  const [form, setForm] = useState<ServerFormState>({
    enabled: false,
    port: '9100',
    allowExternal: true,
    tlsCertPath: '',
    tlsKeyPath: '',
    webuiPassword: '',
    publicWsUrl: '',
  })
  const [savedForm, setSavedForm] = useState<ServerFormState>(form)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [clientMode, setClientMode] = useState<ClientModeInfo | null>(null)
  const [devices, setDevices] = useState<DeviceToolInfo[] | null>(null)
  const [deviceTokens, setDeviceTokens] = useState<DeviceTokenInfo[] | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [addDeviceOpen, setAddDeviceOpen] = useState(false)
  const [deviceLabelDraft, setDeviceLabelDraft] = useState('')
  const [addRemoteAccess, setAddRemoteAccess] = useState(true)
  const [isCreatingDevice, setIsCreatingDevice] = useState(false)
  /** The device the person is about to remove (disconnects it and revokes its slot). */
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [webuiPasswordVisible, setWebuiPasswordVisible] = useState(false)
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
      // One list in the UI: slots waiting for a machine, and the devices that have connected.
      const [connected, tokens] = await Promise.all([
        window.electronAPI.getConnectedDevices(),
        window.electronAPI.listDeviceTokens().catch(() => [] as DeviceTokenInfo[]),
      ])
      setDevices(connected)
      setDeviceTokens(tokens)
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
  /** Slots created for a machine that has not connected yet. */
  const pendingTokens = (deviceTokens ?? []).filter((token) => token.deviceId === null)
  /** The slot a connected device holds, so its credential can be revoked from the same row. */
  const slotByDeviceId = new Map<string, DeviceTokenInfo>()
  for (const token of deviceTokens ?? []) {
    if (token.deviceId) slotByDeviceId.set(token.deviceId, token)
  }
  /** What a slot lets its device do, as a short label. */
  const scopeLabel = (scope: 'client' | 'device' | 'both'): string => {
    switch (scope) {
      case 'both': return t('settings.server.scopeBoth')
      case 'client': return t('settings.server.scopeClient')
      default: return t('settings.server.scopeDevice')
    }
  }
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
      // Read the config back instead of assuming it: the main process fills in a Web UI password
      // the first time Server Mode is enabled, and that value exists nowhere else until we ask.
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

  /** Remove a device row no matter its state: live connections drop and its slot stops working. */
  const handleRemoveDevice = async () => {
    if (!removeTarget || isRemoving) return
    setIsRemoving(true)
    try {
      await window.electronAPI.forgetDevice(removeTarget.id)
      setRemoveTarget(null)
      await loadDevices()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRemoving(false)
    }
  }

  // The person's own name for a device — the string the agent accepts when naming it.
  const [aliasTarget, setAliasTarget] = useState<DeviceToolInfo | null>(null)
  const [aliasDraft, setAliasDraft] = useState('')

  /** Create an invitation. Its scope says whether the machine may open windows here. */
  const handleCreateDevice = async () => {
    if (isCreatingDevice) return
    setIsCreatingDevice(true)
    try {
      await window.electronAPI.createDeviceToken(
        deviceLabelDraft.trim() || undefined,
        addRemoteAccess ? 'both' : 'device',
      )
      setAddDeviceOpen(false)
      setDeviceLabelDraft('')
      await loadDevices()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCreatingDevice(false)
    }
  }

  const handleRemoveDeviceToken = async (tokenId: string) => {
    try {
      await window.electronAPI.removeDeviceToken(tokenId)
      await loadDevices()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Remote control is a property of the slot, not of a live connection, so the same switch works
   * while the device is still waiting to connect.
   */
  const handleSetRemoteAccess = async (tokenId: string, on: boolean) => {
    try {
      await window.electronAPI.setDeviceTokenScope(tokenId, on ? 'both' : 'device')
      await loadDevices()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSetDeviceAlias = async () => {
    if (!aliasTarget) return
    try {
      await window.electronAPI.setDeviceAlias(aliasTarget.id, aliasDraft.trim() || null)
      setAliasTarget(null)
      await loadDevices()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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

  // The external address, taken from the form because it is part of this config. It is a second
  // address beside the one above, never a replacement: the rows that describe this machine on the
  // network keep saying what they said before this field was filled in.
  //
  // It is kept exactly as it was typed — `https://host` and `wss://host` are the same endpoint —
  // and turned into the form each line needs only here.
  const publicWsUrl = form.publicWsUrl.trim()
  const publicHttpUrl = publicWsUrl.replace(/^ws/i, 'http')
  const publicSocketUrl = publicWsUrl.replace(/^http/i, 'ws')

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
                  // Mint the Web UI password up front so it is part of the config being edited
                  // instead of appearing only after the server first saves one.
                  webuiPassword: enabled && !f.webuiPassword ? generateToken() : f.webuiPassword,
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

          {/* What to hand out, and to whom — only visible when server mode is on. */}
          {showServerDetails && (
            <SettingsSection title={t("settings.server.connectionSection")}>
              <SettingsCard>
                <SettingsInputRow
                  label={t("settings.server.port")}
                  value={form.port}
                  onChange={(port) => setForm(f => ({ ...f, port }))}
                  placeholder="9100"
                />

                <SettingsRow label={t("settings.server.browserUrl")}>
                  <div className="flex flex-col items-end gap-0.5">
                    <AddressLine
                      url={browserUrl}
                      title={t("common.copy")}
                      onCopy={() => handleCopy(browserUrl, t("settings.server.browserUrl"))}
                    />
                    {publicWsUrl && (
                      <AddressLine
                        url={publicHttpUrl}
                        title={t("settings.server.externalBrowserUrl")}
                        onCopy={() => handleCopy(publicHttpUrl, t("settings.server.externalBrowserUrl"))}
                      />
                    )}
                  </div>
                </SettingsRow>

                <SettingsRow label={t("settings.server.webuiPassword")}>
                  <span className="font-mono text-sm text-muted-foreground">
                    {form.webuiPassword ? (webuiPasswordVisible ? form.webuiPassword : "••••••••••••") : "—"}
                  </span>
                  {form.webuiPassword && (
                    <>
                      <IconAction
                        icon={webuiPasswordVisible ? EyeOff : Eye}
                        title={t("settings.server.webuiPassword")}
                        onClick={() => setWebuiPasswordVisible(v => !v)}
                      />
                      <IconAction
                        icon={Copy}
                        title={t("common.copy")}
                        onClick={() => handleCopy(form.webuiPassword, t("settings.server.webuiPassword"))}
                      />
                    </>
                  )}
                  <IconAction
                    icon={RotateCw}
                    title={t("settings.server.regenerateWebuiPassword")}
                    onClick={() => {
                      setForm(f => ({ ...f, webuiPassword: generateToken() }))
                      setWebuiPasswordVisible(true)
                    }}
                  />
                </SettingsRow>

                <SettingsRow label={t("settings.server.wsUrl")}>
                  <div className="flex flex-col items-end gap-0.5">
                    <AddressLine
                      url={wsUrl}
                      title={t("common.copy")}
                      onCopy={() => handleCopy(wsUrl, t("settings.server.wsUrl"))}
                    />
                    {publicWsUrl && (
                      <AddressLine
                        url={publicSocketUrl}
                        title={t("settings.server.externalWsUrl")}
                        onCopy={() => handleCopy(publicSocketUrl, t("settings.server.externalWsUrl"))}
                      />
                    )}
                  </div>
                </SettingsRow>

                <SettingsRow label={t("settings.server.certificate")}>
                  <span className="max-w-[220px] truncate text-sm text-muted-foreground">
                    {form.tlsCertPath || t("settings.server.notConfigured")}
                  </span>
                  <RowButton onClick={() => { void handleBrowse("cert") }}>
                    {t("common.choose")}
                  </RowButton>
                </SettingsRow>

                <SettingsRow label={t("settings.server.privateKey")}>
                  <span className="max-w-[220px] truncate text-sm text-muted-foreground">
                    {form.tlsKeyPath || t("settings.server.notConfigured")}
                  </span>
                  <RowButton onClick={() => { void handleBrowse("key") }}>
                    {t("common.choose")}
                  </RowButton>
                </SettingsRow>

                {/* The address a reverse proxy, tunnel or port mapping exposes, in whichever form it
                    was given — `https://…` and `wss://…` are both accepted as typed, and it is shown
                    as the second line of the two address rows above. */}
                <SettingsInputRow
                  label={t("settings.server.publicWsUrl")}
                  value={form.publicWsUrl}
                  onChange={(publicWsUrl) => setForm(f => ({ ...f, publicWsUrl }))}
                  placeholder="https://agents.example.com"
                />
              </SettingsCard>

              {!needsRestart && status?.bindError && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t("settings.server.bindError")}</span>
                </div>
              )}

              {form.enabled && !hasTls && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {status?.insecureWarning && !needsRestart && !isDirty
                      ? t("settings.server.insecureWarning")
                      : t("settings.server.noTlsWarning")}
                  </span>
                </div>
              )}
            </SettingsSection>
          )}

          {/* One switch per row: remote control (the device drives this server). Device use needs
              no switch — a paired link is already allowed. */}
          {devicesVisible && (
            <SettingsSection
              title={t("settings.server.connectedDevices")}
              action={
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-[6px] bg-background text-foreground/60 shadow-minimal hover:text-foreground"
                    title={t("common.refresh")}
                    aria-label={t("common.refresh")}
                    onClick={() => { void loadDevices() }}
                    disabled={devicesLoading}
                  >
                    {devicesLoading
                      ? <Spinner className="h-3.5 w-3.5" />
                      : <RotateCw className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 rounded-[6px] bg-background px-3 text-foreground/70 shadow-minimal hover:text-foreground"
                    onClick={() => {
                      setDeviceLabelDraft("")
                      setAddRemoteAccess(true)
                      setAddDeviceOpen(true)
                    }}
                    disabled={devicesLoading}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("settings.server.addDevice")}
                  </Button>
                </div>
              }
            >
              {pendingTokens.length > 0 && (
                <div className="space-y-2">
                  <GroupLabel className="px-1 pt-0 pb-0">{t("settings.server.pendingTokens")}</GroupLabel>
                  {pendingTokens.map((token) => {
                    const secret = token.token
                    return (
                      <div key={token.id} className="rounded-xl bg-background px-4 py-3 shadow-minimal">
                        <div className="flex items-start gap-3">
                          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{token.label}</div>
                            {/* The token and both actions sit on one line, with nothing stranded. */}
                            <div className="mt-1.5 flex items-center gap-1">
                              <code
                                className="min-w-0 flex-1 truncate rounded-md bg-foreground/[0.04] px-2 py-1 font-mono text-[11px] text-muted-foreground"
                                title={secret ?? ""}
                              >
                                {secret ?? "—"}
                              </code>
                              {secret && (
                                <IconAction
                                  icon={Copy}
                                  title={t("settings.server.deviceTokenHint")}
                                  onClick={() => handleCopy(secret, t("settings.server.deviceToken"))}
                                />
                              )}
                              <IconAction
                                icon={Trash2}
                                title={t("common.delete")}
                                onClick={() => { void handleRemoveDeviceToken(token.id) }}
                              />
                            </div>
                          </div>
                        </div>
                        {/* Settable before the device arrives: the slot decides what it may do. */}
                        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
                          <span className="text-sm">{t("settings.server.capabilityRemote")}</span>
                          <Switch
                            checked={token.scope !== "device"}
                            onCheckedChange={(on) => { void handleSetRemoteAccess(token.id, on) }}
                            aria-label={t("settings.server.capabilityRemote")}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="space-y-2">
                <GroupLabel className="px-1 pt-0 pb-0">{t("settings.server.connectedList")}</GroupLabel>

                {devices === null ? (
                  <SettingsCard>
                    <SettingsRow label={t("settings.server.loadingDevices")} />
                  </SettingsCard>
                ) : devices.length === 0 ? (
                  <p className="rounded-xl bg-background px-4 py-6 text-center text-xs text-muted-foreground shadow-minimal">
                    {t("settings.server.noDevices")}
                  </p>
                ) : (
                  devices.map((device) => {
                    const slot = slotByDeviceId.get(device.id)
                    const remoteGranted = !!slot && (slot.scope === "client" || slot.scope === "both")
                    return (
                      <div key={device.id} className="rounded-xl bg-background px-4 py-3 shadow-minimal">
                        <div className="flex items-start gap-3">
                          <span
                            className={cn(
                              "mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full",
                              device.online ? "bg-success" : "bg-muted-foreground/40",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{device.name}</span>
                              {device.alias && (
                                <span className="truncate text-sm text-muted-foreground">
                                  {device.alias}
                                </span>
                              )}
                              {/* The device's own consent; only that machine can change it. */}
                              <span
                                className={cn(
                                  "shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4",
                                  device.deviceAllows
                                    ? "border-success/25 text-success"
                                    : "border-border text-muted-foreground",
                                )}
                              >
                                {device.deviceAllows
                                  ? t("settings.server.deviceAuthorized")
                                  : t("settings.server.deviceNotAuthorized")}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {[
                                platformLabel(device.platform),
                                device.online
                                  ? null
                                  : device.lastSeenAt
                                    ? t("settings.server.deviceLastSeen", {
                                        time: new Date(device.lastSeenAt).toLocaleDateString(),
                                      })
                                    : t("settings.server.deviceOffline"),
                              ].filter(Boolean).join(" · ")}
                            </div>
                          </div>

                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <button
                                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                                aria-label={t("common.more")}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => {
                                  setAliasTarget(device)
                                  setAliasDraft(device.alias ?? "")
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                <span>{t("settings.server.setAlias")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setRemoveTarget({ id: device.id, name: device.alias ?? device.name })}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>{t("settings.server.deleteDevice")}</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>

                        {/* Remote control is the slot's right. Letting the hub use the device needs no
                            switch: a paired link is already allowed. */}
                        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
                          <span className="text-sm">{t("settings.server.capabilityRemote")}</span>
                          {slot ? (
                            <Switch
                              checked={remoteGranted}
                              onCheckedChange={(on) => { void handleSetRemoteAccess(slot.id, on) }}
                              aria-label={t("settings.server.capabilityRemote")}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <RenameDialog
                open={aliasTarget !== null}
                onOpenChange={(open) => { if (!open) setAliasTarget(null) }}
                title={t('settings.server.setAlias')}
                value={aliasDraft}
                onValueChange={setAliasDraft}
                onSubmit={() => { void handleSetDeviceAlias() }}
                placeholder={t('settings.server.aliasPlaceholder')}
                allowEmpty
              />

              <AddDeviceDialog
                open={addDeviceOpen}
                onOpenChange={(open) => { if (!open) setAddDeviceOpen(false) }}
                label={deviceLabelDraft}
                onLabelChange={setDeviceLabelDraft}
                remoteCap={addRemoteAccess}
                onRemoteCapChange={setAddRemoteAccess}
                onCreate={() => { void handleCreateDevice() }}
                creating={isCreatingDevice}
              />

              <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>{t('settings.server.deleteDeviceConfirmTitle', { name: removeTarget?.name ?? '' })}</DialogTitle>
                    <DialogDescription>
                      {t('settings.server.deleteDeviceConfirmDesc')}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="gap-2">
                    <Button variant="outline" size="sm" onClick={() => setRemoveTarget(null)} disabled={isRemoving}>
                      {t('common.cancel')}
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => { void handleRemoveDevice() }} disabled={isRemoving}>
                      {isRemoving ? <Spinner className="mr-1.5" /> : null}
                      {t('settings.server.deleteDevice')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

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
