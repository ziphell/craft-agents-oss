/**
 * AppSettingsPage
 *
 * Global app-level settings that apply across all workspaces.
 *
 * Settings:
 * - Notifications
 * - Links (where a clicked link opens)
 * - Network (proxy)
 * - About (version, updates)
 *
 * Note: AI settings (connections, model, thinking) have been moved to AiSettingsPage.
 * Note: Appearance settings (theme, font) have been moved to AppearanceSettingsPage.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { NetworkProxyMode, NetworkProxySettings } from '../../../shared/types'
import type { UserPreferences } from '@craft-agent/shared/config'
import { readOpenInAppBrowserFrom, writeOpenInAppBrowser } from '@/lib/open-in-app-browser'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsToggle,
  SettingsInput,
} from '@/components/settings'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'app',
}

// ============================================
// Proxy form helpers
// ============================================

interface ProxyFormState {
  mode: NetworkProxyMode
  httpProxy: string
  httpsProxy: string
  noProxy: string
  bypassLoopback: boolean
}

const DEFAULT_PROXY_MODE: NetworkProxyMode = 'direct'

const EMPTY_PROXY_FORM: ProxyFormState = {
  mode: DEFAULT_PROXY_MODE,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
  bypassLoopback: true,
}

function toProxyFormState(settings?: NetworkProxySettings): ProxyFormState {
  if (!settings) return EMPTY_PROXY_FORM
  return {
    mode: settings.mode,
    httpProxy: settings.httpProxy ?? '',
    httpsProxy: settings.httpsProxy ?? '',
    noProxy: settings.noProxy ?? '',
    bypassLoopback: settings.bypassLoopback !== false,
  }
}

function toNetworkProxySettings(form: ProxyFormState): NetworkProxySettings {
  return {
    mode: form.mode,
    httpProxy: form.httpProxy.trim() || undefined,
    httpsProxy: form.httpsProxy.trim() || undefined,
    noProxy: form.noProxy.trim() || undefined,
    bypassLoopback: form.bypassLoopback,
  }
}

function validateProxyUrl(url: string): string | undefined {
  if (!url.trim()) return undefined
  try {
    const parsed = new URL(url.trim())
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
      return 'proxyErrorProtocol'
    }
    return undefined
  } catch {
    return 'proxyErrorFormat'
  }
}

/**
 * The "bring my tabs back" switch, in the same shape as the browser switch beside it: the
 * answer lives in the preferences file, and the settings page reads a copy it already has.
 */
function readRestoreBrowserTabsFrom(content: string): boolean {
  try {
    return (JSON.parse(content) as UserPreferences).restoreBrowserTabs === true
  } catch {
    return false
  }
}

/** Write it back, keeping whatever else the file holds. */
async function writeRestoreBrowserTabs(enabled: boolean): Promise<void> {
  const { content } = await window.electronAPI.readPreferences()

  let prefs: UserPreferences
  try {
    prefs = JSON.parse(content) as UserPreferences
  } catch {
    prefs = {}
  }

  const result = await window.electronAPI.writePreferences(
    JSON.stringify({ ...prefs, restoreBrowserTabs: enabled, updatedAt: Date.now() }, null, 2),
  )
  if (!result.success) {
    throw new Error(result.error ?? 'Could not write preferences')
  }
}

// ============================================
// Main Component
// ============================================

export default function AppSettingsPage() {
  const { t } = useTranslation()

  // Notifications state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Power state
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)

  // Tools state
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)

  // Links and pages state
  const [openInAppBrowser, setOpenInAppBrowser] = useState(true)
  const [restoreBrowserTabs, setRestoreBrowserTabs] = useState(false)

  // Proxy state
  const [proxyForm, setProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [savedProxyForm, setSavedProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [isSavingProxy, setIsSavingProxy] = useState(false)

  // Auto-update state (Check Now / Update Ready only shown in Electron, not WebUI)
  const isElectron = window.electronAPI.getRuntimeEnvironment() === 'electron'
  const updateChecker = useUpdateChecker()
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false)

  const handleCheckForUpdates = useCallback(async () => {
    setIsCheckingForUpdates(true)
    try {
      await updateChecker.checkForUpdates()
    } finally {
      setIsCheckingForUpdates(false)
    }
  }, [updateChecker])

  // Load settings on mount
  const loadSettings = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const [notificationsOn, keepAwakeOn, browserToolOn, proxySettings, preferencesFile] = await Promise.all([
        window.electronAPI.getNotificationsEnabled(),
        window.electronAPI.getKeepAwakeWhileRunning(),
        window.electronAPI.getBrowserToolEnabled(),
        window.electronAPI.getNetworkProxySettings(),
        window.electronAPI.readPreferences(),
      ])
      setNotificationsEnabled(notificationsOn)
      setKeepAwakeEnabled(keepAwakeOn)
      setBrowserToolEnabled(browserToolOn)
      setOpenInAppBrowser(readOpenInAppBrowserFrom(preferencesFile.content))
      setRestoreBrowserTabs(readRestoreBrowserTabsFrom(preferencesFile.content))
      const form = toProxyFormState(proxySettings)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [])

  const handleNotificationsEnabledChange = useCallback(async (enabled: boolean) => {
    setNotificationsEnabled(enabled)
    await window.electronAPI.setNotificationsEnabled(enabled)
  }, [])

  const handleKeepAwakeEnabledChange = useCallback(async (enabled: boolean) => {
    setKeepAwakeEnabled(enabled)
    await window.electronAPI.setKeepAwakeWhileRunning(enabled)
  }, [])

  const handleBrowserToolEnabledChange = useCallback(async (enabled: boolean) => {
    setBrowserToolEnabled(enabled)
    await window.electronAPI.setBrowserToolEnabled(enabled)
  }, [])

  const handleOpenInAppBrowserChange = useCallback(async (enabled: boolean) => {
    setOpenInAppBrowser(enabled)
    try {
      await writeOpenInAppBrowser(enabled)
    } catch (error) {
      // Back where it was: this switch says where a page opens, so it must not show a change
      // that never reached the disk.
      setOpenInAppBrowser(!enabled)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.links.title') }), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [t])

  const handleRestoreBrowserTabsChange = useCallback(async (enabled: boolean) => {
    setRestoreBrowserTabs(enabled)
    try {
      await writeRestoreBrowserTabs(enabled)
    } catch (error) {
      // Back where it was: the switch must not show a change that never reached the disk.
      setRestoreBrowserTabs(!enabled)
      toast.error(t('toast.failedToSaveSetting', { setting: t('settings.links.title') }), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [t])

  // Proxy handlers
  const isProxyDirty = useMemo(() => {
    return JSON.stringify(proxyForm) !== JSON.stringify(savedProxyForm)
  }, [proxyForm, savedProxyForm])

  const handleSaveProxy = useCallback(async () => {
    // Validate URLs — only what is in use: the fields are hidden under the
    // system proxy, and a stale one must not block switching away from it.
    if (proxyForm.mode === 'custom') {
      const httpErr = validateProxyUrl(proxyForm.httpProxy)
      const httpsErr = validateProxyUrl(proxyForm.httpsProxy)
      if (httpErr || httpsErr) {
        setProxyError(httpErr || httpsErr)
        return
      }
    }
    setProxyError(undefined)
    setIsSavingProxy(true)
    try {
      const settings = toNetworkProxySettings(proxyForm)
      await window.electronAPI.setNetworkProxySettings(settings)
      // Re-read persisted state to confirm
      const persisted = await window.electronAPI.getNetworkProxySettings()
      const form = toProxyFormState(persisted)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setIsSavingProxy(false)
    }
  }, [proxyForm])

  const handleResetProxy = useCallback(() => {
    setProxyForm(savedProxyForm)
    setProxyError(undefined)
  }, [savedProxyForm])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.app.title")} actions={<HeaderMenu route={routes.view.settings('app')} helpFeature="app-settings" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Notifications */}
              <SettingsSection title={t("settings.notifications.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.notifications.desktopNotifications")}
                    description={t("settings.notifications.desktopNotificationsDesc")}
                    checked={notificationsEnabled}
                    onCheckedChange={handleNotificationsEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Power */}
              <SettingsSection title={t("settings.power.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.power.keepScreenAwake")}
                    description={t("settings.power.keepScreenAwakeDesc")}
                    checked={keepAwakeEnabled}
                    onCheckedChange={handleKeepAwakeEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Tools */}
              <SettingsSection title={t("settings.tools.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.tools.builtInBrowser")}
                    description={t("settings.tools.builtInBrowserDesc")}
                    checked={browserToolEnabled}
                    onCheckedChange={handleBrowserToolEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Links — where a page the person clicks goes, a link or an `.html` file.
                  Electron only: a browser client has no window of ours to open, so there the
                  page is a tab of their own. */}
              {isElectron && (
                <SettingsSection title={t("settings.links.title")}>
                  <SettingsCard>
                    <SettingsToggle
                      label={t("settings.links.openInAppBrowser")}
                      description={t("settings.links.openInAppBrowserDesc")}
                      checked={openInAppBrowser}
                      onCheckedChange={handleOpenInAppBrowserChange}
                    />
                    <SettingsToggle
                      label={t("settings.links.restoreBrowserTabs")}
                      description={t("settings.links.restoreBrowserTabsDesc")}
                      checked={restoreBrowserTabs}
                      onCheckedChange={handleRestoreBrowserTabsChange}
                    />
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Network */}
              <SettingsSection title={t("settings.network.title")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.network.proxyMode")}>
                    <SettingsSegmentedControl
                      value={proxyForm.mode}
                      onValueChange={(mode) => {
                        // An error about a proxy we just stopped using is not
                        // about anything on screen any more.
                        setProxyError(undefined)
                        setProxyForm(prev => ({ ...prev, mode }))
                      }}
                      options={[
                        { value: 'direct', label: t("settings.network.proxyModeDirect") },
                        { value: 'system', label: t("settings.network.proxyModeSystem") },
                        { value: 'custom', label: t("settings.network.proxyModeCustom") },
                      ]}
                    />
                  </SettingsRow>
                  {proxyForm.mode === 'custom' && (
                    <>
                      <SettingsInput
                        label={t("settings.network.httpProxyLabel")}
                        value={proxyForm.httpProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.httpsProxyLabel")}
                        value={proxyForm.httpsProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpsProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.bypassRules")}
                        value={proxyForm.noProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, noProxy: value }))}
                        placeholder={t("settings.network.bypassPlaceholder")}
                        inCard
                      />
                      <SettingsToggle
                        label={t("settings.network.bypassLoopback")}
                        description={t("settings.network.bypassLoopbackDesc")}
                        checked={proxyForm.bypassLoopback}
                        onCheckedChange={(checked) => setProxyForm(prev => ({ ...prev, bypassLoopback: checked }))}
                      />
                    </>
                  )}
                  {(isProxyDirty || proxyError) && (
                    <SettingsCardFooter>
                      {proxyError && (
                        <span className="text-destructive text-sm mr-auto">{proxyError === 'proxyErrorProtocol' ? t("settings.network.proxyErrorProtocol") : proxyError === 'proxyErrorFormat' ? t("settings.network.proxyErrorFormat") : proxyError}</span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {t("common.reset")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSaveProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {isSavingProxy ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.saving")}
                          </>
                        ) : (
                          t("common.save")
                        )}
                      </Button>
                    </SettingsCardFooter>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* About */}
              <SettingsSection title={t("settings.about.title")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.about.version")}>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {updateChecker.updateInfo?.currentVersion ?? t("common.loading")}
                      </span>
                      {isElectron && updateChecker.isDownloading && updateChecker.updateInfo?.latestVersion && (
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <Spinner className="w-3 h-3" />
                          <span>{t("settings.about.downloading", { version: updateChecker.updateInfo.latestVersion, percent: updateChecker.downloadProgress })}</span>
                        </div>
                      )}
                    </div>
                  </SettingsRow>
                  {isElectron && (
                    <SettingsRow label={t("settings.about.checkForUpdates")}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCheckForUpdates}
                        disabled={isCheckingForUpdates}
                      >
                        {isCheckingForUpdates ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.checking")}
                          </>
                        ) : (
                          t("settings.about.checkNow")
                        )}
                      </Button>
                    </SettingsRow>
                  )}
                  {isElectron && updateChecker.isReadyToInstall && updateChecker.updateInfo?.latestVersion && (
                    <SettingsRow label={t("settings.about.updateReady")}>
                      <Button
                        size="sm"
                        onClick={updateChecker.installUpdate}
                      >
                        {t("settings.about.restartToUpdate", { version: updateChecker.updateInfo.latestVersion })}
                      </Button>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
