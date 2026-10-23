import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { slugify } from "@/lib/slugify"
import { Input } from "../ui/input"
import { Button } from "../ui/button"
import { AddWorkspaceContainer, AddWorkspaceStepHeader, AddWorkspaceSecondaryButton, AddWorkspacePrimaryButton } from "./primitives"
import { AddWorkspace_RadioOption } from "./AddWorkspace_RadioOption"
import { AddWorkspace_HostPicker, useWorkspaceHosts } from "./AddWorkspace_HostPicker"
import { useDirectoryPicker } from "@/hooks/useDirectoryPicker"
import { ServerDirectoryBrowser } from "@/components/ServerDirectoryBrowser"

type LocationOption = 'default' | 'custom'

interface AddWorkspaceStep_CreateNewProps {
  onBack: () => void
  /** `connectionId` names the host the workspace lives on; `null`/omitted means this computer. */
  onCreate: (folderPath: string, name: string, connectionId: string | null) => Promise<void>
  isCreating: boolean
}

/**
 * AddWorkspaceStep_CreateNew - Create a new workspace
 *
 * Fields:
 * - Workspace name (required)
 * - Location: Default (~/.craft-agent/workspaces/) or Custom
 */
export function AddWorkspaceStep_CreateNew({
  onBack,
  onCreate,
  isCreating
}: AddWorkspaceStep_CreateNewProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [locationOption, setLocationOption] = useState<LocationOption>('default')
  const [customPath, setCustomPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)
  // The host level: this computer until a saved server is picked.
  const [hostConnectionId, setHostConnectionId] = useState<string | null>(null)
  const hosts = useWorkspaceHosts()
  // Where a "default location" workspace goes is the **server's** answer, not this window's guess:
  // the server owns the config directory (which `CRAFT_CONFIG_DIR` can move), and for a remote or
  // web client the browser has no home directory to speak of. `checkWorkspaceSlug` is already
  // asked for validation, and it answers with the path — so that answer is what gets created.
  const [defaultPath, setDefaultPath] = useState<string | null>(null)

  const slug = slugify(name)
  const finalPath = locationOption === 'default'
    ? defaultPath
    : customPath && slug
      ? `${customPath}/${slug}`
      : null

  // Validate slug uniqueness when name changes — against the host that will own the workspace,
  // which is the server picked above rather than necessarily this window's.
  useEffect(() => {
    if (!slug) {
      setError(null)
      setDefaultPath(null)
      return
    }

    const validateSlug = async () => {
      setIsValidating(true)
      try {
        const result = hostConnectionId
          ? await window.electronAPI.checkRemoteWorkspaceSlug(hostConnectionId, slug)
          : await window.electronAPI.checkWorkspaceSlug(slug)
        setDefaultPath(result.path)
        if (result.exists) {
          setError(`A workspace named "${slug}" already exists`)
        } else {
          setError(null)
        }
      } catch (err) {
        console.error('Failed to validate workspace slug:', err)
      } finally {
        setIsValidating(false)
      }
    }

    // Debounce validation
    const timeout = setTimeout(validateSlug, 300)
    return () => clearTimeout(timeout)
  }, [slug, hostConnectionId])

  const handleFolderSelected = useCallback((path: string) => {
    setCustomPath(path)
  }, [])

  // A path only means something on the host it was picked on, so switching hosts clears it.
  const handleHostChange = useCallback((connectionId: string | null) => {
    setHostConnectionId(connectionId)
    setCustomPath(null)
  }, [])

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    serverConnectionId,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(handleFolderSelected, { connectionId: hostConnectionId })

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !finalPath || error) return
    await onCreate(finalPath, name.trim(), hostConnectionId)
  }, [name, finalPath, error, hostConnectionId, onCreate])

  const canCreate = name.trim() && finalPath && !error && !isValidating && !isCreating

  return (
    <AddWorkspaceContainer>
      {/* Back button */}
      <button
        onClick={onBack}
        disabled={isCreating}
        className={cn(
          "self-start flex items-center gap-1 text-sm text-muted-foreground",
          "hover:text-foreground transition-colors mb-4",
          isCreating && "opacity-50 cursor-not-allowed"
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        {t("common.back")}
      </button>

      <AddWorkspaceStepHeader
        title={t("workspace.createWorkspace")}
        description={t("workspace.createWorkspaceDesc")}
      />

      <div className="mt-6 w-full space-y-6">
        {/* Workspace name */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground mb-2.5">
            {t("workspace.nameLabel")}
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workspace.myWorkspace")}
              disabled={isCreating}
              autoFocus
              className="border-0 bg-transparent shadow-none"
            />
          </div>
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        {/* Host: the workspace lives on the machine that owns its folder. */}
        {hosts.length > 0 && (
          <AddWorkspace_HostPicker
            hosts={hosts}
            value={hostConnectionId}
            onChange={handleHostChange}
            disabled={isCreating}
          />
        )}

        {/* Location selection */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-foreground mb-2.5">
            {t("workspace.locationLabel")}
          </label>

          {/* Default location option */}
          <AddWorkspace_RadioOption
            name="location"
            checked={locationOption === 'default'}
            onChange={() => setLocationOption('default')}
            disabled={isCreating}
            title={t("workspace.defaultLocation")}
            subtitle={t("workspace.underDefaultFolder")}
          />

          {/* Custom location option */}
          <AddWorkspace_RadioOption
            name="location"
            checked={locationOption === 'custom'}
            onChange={() => setLocationOption('custom')}
            disabled={isCreating}
            title={t("workspace.chooseLocation")}
            subtitle={customPath || t("workspace.pickLocation")}
            action={locationOption === 'custom' ? (
              <AddWorkspaceSecondaryButton
                onClick={(e) => {
                  e.preventDefault()
                  pickDirectory()
                }}
                disabled={isCreating}
              >
                {t("common.browse")}
              </AddWorkspaceSecondaryButton>
            ) : undefined}
          />
        </div>

        {/* Create button */}
        <AddWorkspacePrimaryButton
          onClick={handleCreate}
          disabled={!canCreate}
          loading={isCreating}
          loadingText={t("workspace.creating")}
        >
          {t("common.create")}
        </AddWorkspacePrimaryButton>
      </div>
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        connectionId={serverConnectionId ?? undefined}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
      />
    </AddWorkspaceContainer>
  )
}
