/**
 * ConnectServerDialog — open a window on a saved server, or add one.
 *
 * The VS Code shape: connecting is an action, not a settings page. Two views, never both — the
 * saved-server list (open / edit / remove, plus "Add server") and the form for one server. Keeping
 * them apart is what makes adding and editing tell themselves apart: the title, the primary button
 * and where Cancel goes all follow the view.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { AlertTriangle, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { windowServerScopeAtom } from '@/atoms/window-mode'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import type { ClientModeTestResult, RemoteConnection, TransportConnectionStatus } from '../../../shared/types'

export interface ConnectServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function statusDotClass(status: TransportConnectionStatus | 'unknown'): string {
  if (status === 'connected') return 'bg-success'
  if (status === 'connecting' || status === 'reconnecting' || status === 'idle') return 'bg-warning animate-pulse'
  return 'bg-muted-foreground/40'
}

function statusLabelKey(status: TransportConnectionStatus | 'unknown'): string {
  if (status === 'connected') return 'settings.client.statusOnline'
  if (status === 'connecting' || status === 'reconnecting' || status === 'idle') return 'settings.client.statusConnecting'
  return 'settings.client.statusOffline'
}

export function ConnectServerDialog({ open, onOpenChange }: ConnectServerDialogProps) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState<RemoteConnection[]>([])
  const windowConnectionId = useAtomValue(windowServerScopeAtom)
  const windowTransport = useTransportConnectionState()
  const [serverUrl, setServerUrl] = useState('')
  const [token, setToken] = useState('')
  const [hostName, setHostName] = useState('')
  /** Whether this machine lets the server use it. Kept separate from "connect" on purpose: a
   *  window on that server never needs this machine's capabilities, and turning the switch off
   *  keeps the connection (and the folders below) so it can be turned back on later. */
  const [deviceUseEnabled, setDeviceUseEnabled] = useState(true)
  /** Separate grants: the browser is on unless turned off; the desktop is off unless turned on. */
  const [browserEnabled, setBrowserEnabled] = useState(true)
  const [computerEnabled, setComputerEnabled] = useState(false)
  // Folders this server may reach beyond this app's own workspaces. Entered here, on this machine.
  const [allowedRoots, setAllowedRoots] = useState<string[]>([])
  // This machine's workspaces, offered as one-click shortcuts into `allowedRoots` — a convenience,
  // not an authorization: a workspace is only reachable once it is in the saved list.
  const [localWorkspaces, setLocalWorkspaces] = useState<Array<{ name: string; rootPath: string }>>([])
  const [isTesting, setIsTesting] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [busyConnectionId, setBusyConnectionId] = useState<string>()
  const [testResult, setTestResult] = useState<ClientModeTestResult | null>(null)
  const [error, setError] = useState<string>()
  // `formOpen` is the second view; `editingId` picks its mode. Both undefined/false = the list.
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [statuses, setStatuses] = useState<Record<string, TransportConnectionStatus | 'unknown'>>({})
  /** What each saved server's credential may do, as the hub reported it on the link's handshake. */
  const [scopes, setScopes] = useState<Record<string, 'client' | 'device' | 'both' | null>>({})

  const load = useCallback(() => {
    void window.electronAPI.getClientMode()
      .then((info) => {
        setConnections(info.connections)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setTestResult(null)
    setServerUrl('')
    setToken('')
    setHostName('')
    setDeviceUseEnabled(true)
    setBrowserEnabled(true)
    setComputerEnabled(false)
    setAllowedRoots([])
    setEditingId(undefined)
    setFormOpen(false)
    load()
    void window.electronAPI.getLocalWorkspaces()
      .then((list) => setLocalWorkspaces(list.map((workspace) => ({ name: workspace.name, rootPath: workspace.rootPath }))))
      .catch(() => setLocalWorkspaces([]))
  }, [open, load])

  // Saved and reachable are different things; the dots say which is which. Polled only while the
  // dialog is open — the app-level links change state on their own time, and this is a list glance.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const loadStatuses = () => {
      void window.electronAPI.getRemoteConnectionStatuses()
        .then((list) => {
          if (cancelled) return
          setStatuses(Object.fromEntries(list.map((entry) => [entry.id, entry.status])))
          setScopes(Object.fromEntries(list.map((entry) => [entry.id, entry.scope ?? null])))
        })
        .catch(() => {})
    }
    loadStatuses()
    const timer = setInterval(loadStatuses, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open])

  /** The saved server being edited, when the form is not adding a new one. */
  const editingConnection = editingId ? connections.find(connection => connection.id === editingId) : undefined

  /**
   * Same rules the hub applies, checked here so the person gets the reason.
   * `requiresToken` is false while editing a server that already has one: an empty field there
   * means "keep the saved token", not "no token".
   */
  const validate = useCallback((requiresToken: boolean): string | null => {
    const url = serverUrl.trim()
    if (!url) return t('settings.client.urlRequired')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return t('settings.client.invalidUrl')
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return t('settings.client.invalidUrl')
    }
    if (requiresToken && !token.trim()) return t('settings.client.tokenRequired')
    return null
  }, [serverUrl, token, t])

  /**
   * `ws://` to another machine is a legitimate setup (LAN, VPN, tunnel), so it is allowed —
   * but the token would cross the network in cleartext, which the person should know before
   * pressing Connect.
   */
  const isInsecureUrl = (() => {
    try {
      const parsed = new URL(serverUrl.trim())
      return parsed.protocol === 'ws:' && !LOCALHOSTS.has(parsed.hostname)
    } catch {
      return false
    }
  })()

  /**
   * A URL that belongs to another saved server cannot be saved again: two entries for one endpoint
   * are meaningless, and the main process refuses it. Show which entry owns the address before the
   * person presses the button instead of surfacing the refusal after.
   */
  const sameUrlConnection = connections.find(
    (connection) => connection.id !== editingId && connection.url.trim() === serverUrl.trim(),
  )

  const duplicateUrlError = sameUrlConnection
    ? t('settings.client.urlAlreadySaved', { name: sameUrlConnection.name })
    : null

  const handleTest = async () => {
    const validationError = validate(!editingConnection?.token)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(undefined)
    setTestResult(null)
    setIsTesting(true)
    try {
      // Editing with the token field left blank tests the token that is already saved.
      const effectiveToken = token.trim() || editingConnection?.token || ''
      setTestResult(await window.electronAPI.testClientModeConnection(serverUrl.trim(), effectiveToken))
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setIsTesting(false)
    }
  }

  /** Add a folder on **this** machine. The server never chooses one — it has no local meaning. */
  const addAllowedRoot = async () => {
    setError(undefined)
    try {
      const path = await window.electronAPI.openLocalFolderDialog()
      if (!path) return
      setAllowedRoots((current) => current.includes(path) ? current : [...current, path])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAddAndConnect = async () => {
    const validationError = validate(true) ?? duplicateUrlError
    if (validationError) {
      setError(validationError)
      return
    }
    setError(undefined)
    setIsConnecting(true)
    try {
      const saved = await window.electronAPI.saveRemoteConnection({
        id: '',
        name: hostName.trim(),
        url: serverUrl.trim(),
        token: token.trim(),
        allowedRoots,
        deviceUseEnabled,
        browserEnabled,
        computerEnabled,
      })
      await window.electronAPI.connectToRemoteConnection(saved.id, saved.lastWorkspaceId)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsConnecting(false)
    }
  }

  /** The form, on a saved server. The id is what makes the primary button "Save". */
  const startEdit = (connection: RemoteConnection) => {
    setEditingId(connection.id)
    setServerUrl(connection.url)
    setHostName(connection.name)
    setDeviceUseEnabled(connection.deviceUseEnabled !== false)
    setBrowserEnabled(connection.browserEnabled !== false)
    setComputerEnabled(connection.computerEnabled === true)
    setAllowedRoots(connection.allowedRoots ?? [])
    // Never echo the saved token into the form; blank means "keep it".
    setToken('')
    setError(undefined)
    setTestResult(null)
    setFormOpen(true)
  }

  /** The form, empty — a server this app does not know yet. */
  const startAdd = () => {
    setEditingId(undefined)
    setServerUrl('')
    setHostName('')
    setToken('')
    setDeviceUseEnabled(true)
    setBrowserEnabled(true)
    setComputerEnabled(false)
    setAllowedRoots([])
    setError(undefined)
    setTestResult(null)
    setFormOpen(true)
  }

  /** Back to the list, form state dropped. */
  const closeForm = () => {
    setEditingId(undefined)
    setServerUrl('')
    setHostName('')
    setToken('')
    setDeviceUseEnabled(true)
    setBrowserEnabled(true)
    setComputerEnabled(false)
    setAllowedRoots([])
    setError(undefined)
    setTestResult(null)
    setFormOpen(false)
  }

  /**
   * Save an edited server. The id is passed through, so the main process keeps the server's
   * `lastWorkspaceId` — editing a URL or rotating a token must not lose "where I was".
   */
  const handleSaveEdit = async () => {
    if (!editingId) return
    const validationError = validate(!editingConnection?.token) ?? duplicateUrlError
    if (validationError) {
      setError(validationError)
      return
    }
    setError(undefined)
    setIsConnecting(true)
    try {
      await window.electronAPI.saveRemoteConnection({
        id: editingId,
        name: hostName.trim(),
        url: serverUrl.trim(),
        token: token.trim() || editingConnection?.token || '',
        allowedRoots,
        deviceUseEnabled,
        browserEnabled,
        computerEnabled,
      })
      closeForm()
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsConnecting(false)
    }
  }

  const handleOpen = async (connection: RemoteConnection) => {
    setError(undefined)
    setBusyConnectionId(connection.id)
    try {
      await window.electronAPI.connectToRemoteConnection(connection.id, connection.lastWorkspaceId)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyConnectionId(undefined)
    }
  }

  const handleRemove = async (connection: RemoteConnection) => {
    setError(undefined)
    setBusyConnectionId(connection.id)
    try {
      await window.electronAPI.removeRemoteConnection(connection.id)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyConnectionId(undefined)
    }
  }

  /**
   * Two questions, two sources. "Can this window work?" is answered by its own socket — the same
   * state the top-bar badge and the reconnect banner read. "Can this machine reach that server?"
   * is answered by the app-level link, which also covers servers no window is on. Answering the
   * first with the link would let this dot contradict the badge right beside it.
   */
  const liveStatus = (connectionId: string): TransportConnectionStatus | 'unknown' => {
    if (connectionId === windowConnectionId) return windowTransport?.status ?? 'unknown'
    return statuses[connectionId] ?? 'unknown'
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {formOpen
              ? editingId ? t('settings.client.editServer') : t('settings.client.addServer')
              : t('settings.client.title')}
          </DialogTitle>
        </DialogHeader>

        {formOpen ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Input
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                placeholder={t('settings.client.namePlaceholder')}
                aria-label={t('settings.client.name')}
                autoFocus={!!editingId}
              />
              <span className="block text-xs text-muted-foreground">{t('settings.client.nameDesc')}</span>
            </div>

            <div className="space-y-1.5">
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="wss://craft.example.com:9100"
                aria-label={t('settings.client.serverUrl')}
                aria-invalid={!!sameUrlConnection}
                className={sameUrlConnection ? 'border-warning/60' : undefined}
                autoFocus={!editingId}
              />
              <span className="block text-xs text-muted-foreground">{t('settings.client.serverUrlDesc')}</span>
              {sameUrlConnection && (
                <span className="block text-xs text-warning">
                  {t('settings.client.urlAlreadySaved', { name: sameUrlConnection.name })}
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={editingId ? t('settings.client.tokenKeep') : '••••••••••••'}
                aria-label={t('settings.server.token')}
              />
              <span className="block text-xs text-muted-foreground">{t('settings.client.tokenDesc')}</span>
            </div>

            {/* Device use is its own switch: a window on that server never needs this machine's
                capabilities. Turning it off keeps the saved connection and the folders below, so
                it can be turned back on later — the hub shows the device as not authorized. */}
            <label className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span className="min-w-0 text-[13px] font-medium">
                {t('settings.client.deviceUseEnabled')}
              </span>
              <Switch checked={deviceUseEnabled} onCheckedChange={setDeviceUseEnabled} />
            </label>
            <label
              className={`flex select-none items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
                deviceUseEnabled ? 'cursor-pointer' : 'cursor-default opacity-50'
              }`}
            >
              <span className="text-sm">{t('settings.client.browserEnabled')}</span>
              {/* Files and the shell are the prerequisite: no browser without them. */}
              <Switch
                checked={deviceUseEnabled && browserEnabled}
                onCheckedChange={setBrowserEnabled}
                disabled={!deviceUseEnabled}
              />
            </label>
            <label className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm">{t('settings.client.computerEnabled')}</span>
              <Switch checked={computerEnabled} onCheckedChange={setComputerEnabled} />
            </label>

            {/* Where the tools may work. Kept editable while device use is off: the list is saved
                either way and applies again when authorization is turned back on. */}
            <div className="space-y-2 rounded-lg border px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-[13px] font-medium">
                  {t('settings.client.deviceAllowedRoots')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => { void addAllowedRoot() }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('settings.client.deviceAllowedRootsAdd')}
                </Button>
              </div>
              {allowedRoots.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground">{t('settings.client.deviceAllowedRootsEmpty')}</p>
              ) : (
                <ul className="space-y-1">
                  {allowedRoots.map((root) => (
                    <li key={root} className="flex items-center gap-2 rounded-md border px-2 py-1">
                      <span className="min-w-0 flex-1 truncate text-xs" title={root}>{root}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 shrink-0 p-0"
                        title={t('common.remove')}
                        onClick={() => setAllowedRoots((current) => current.filter((entry) => entry !== root))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {localWorkspaces.some((workspace) => !allowedRoots.includes(workspace.rootPath)) && (
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">
                    {t('settings.client.deviceAllowedRootsWorkspaces')}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {localWorkspaces
                      .filter((workspace) => !allowedRoots.includes(workspace.rootPath))
                      .map((workspace) => (
                        <Button
                          key={workspace.rootPath}
                          variant="outline"
                          size="sm"
                          className="h-6 max-w-full px-2 text-[11px]"
                          title={workspace.rootPath}
                          onClick={() => setAllowedRoots((current) => [...current, workspace.rootPath])}
                        >
                          <Plus className="mr-1 h-3 w-3 shrink-0" />
                          <span className="truncate">{workspace.name}</span>
                        </Button>
                      ))}
                  </div>
                </div>
              )}
            </div>

            {isInsecureUrl && (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>{t('settings.client.insecureUrl')}</span>
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <div className="space-y-2">
            {connections.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
                {t('settings.client.noSavedServers')}
              </p>
            ) : (
              <div className="rounded-lg border">
                {connections.map((connection) => {
                  const isBusy = busyConnectionId === connection.id
                  const status = liveStatus(connection.id)
                  // A device-only credential lends this machine to the hub; it may not open a window
                  // there, so don't offer an Open that the hub is going to refuse.
                  const windowDenied = scopes[connection.id] === 'device'
                  return (
                    <div
                      key={connection.id}
                      className="flex items-center gap-2 px-2.5 py-2 border-b last:border-b-0"
                    >
                      <span
                        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(status))}
                        title={t(statusLabelKey(status))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">{connection.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{connection.url}</div>
                        {windowDenied && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {t('settings.client.remoteControlOff')}
                          </div>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0"
                        title={t('common.edit')}
                        onClick={() => startEdit(connection)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0"
                        title={t('common.remove')}
                        disabled={isBusy}
                        onClick={() => { void handleRemove(connection) }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 shrink-0"
                        disabled={isBusy || windowDenied}
                        title={windowDenied ? t('settings.client.remoteControlOff') : undefined}
                        onClick={() => { void handleOpen(connection) }}
                      >
                        {isBusy ? <Spinner className="mr-1" /> : null}
                        {t('common.open')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter className="gap-2">
          {formOpen ? (
            <>
              {/* The test result shares the button row: no extra line, and it stays next to the
                  action that produced it. */}
              {testResult && (
                <span
                  className={cn(
                    'mr-auto min-w-0 self-center truncate text-xs',
                    testResult.ok ? 'text-success' : 'text-destructive',
                  )}
                  title={testResult.ok ? undefined : (testResult.error ?? 'unknown error')}
                >
                  {testResult.ok
                    ? t('settings.client.testOk')
                    : t('settings.client.testFail', { message: testResult.error ?? 'unknown error' })}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={handleTest} disabled={isTesting || isConnecting}>
                {isTesting ? <Spinner className="mr-1.5" /> : null}
                {t('settings.client.testConnection')}
              </Button>
              <Button variant="outline" size="sm" onClick={closeForm} disabled={isConnecting}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={editingId ? handleSaveEdit : handleAddAndConnect}
                disabled={isTesting || isConnecting}
              >
                {isConnecting ? <Spinner className="mr-1.5" /> : null}
                {editingId ? t('common.save') : t('settings.client.connect')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={startAdd}>
              {t('settings.client.addServer')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
