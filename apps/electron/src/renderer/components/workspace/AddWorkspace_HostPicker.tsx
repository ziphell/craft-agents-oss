import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Laptop, Server } from "lucide-react"
import { cn } from "@/lib/utils"
import type { RemoteConnection } from "@craft-agent/shared/config/client-config"

interface AddWorkspace_HostPickerProps {
  hosts: RemoteConnection[]
  /** `null` = this computer. */
  value: string | null
  onChange: (connectionId: string | null) => void
  disabled?: boolean
}

/**
 * AddWorkspace_HostPicker — the first of the two levels, "remote host, then workspace".
 *
 * A workspace lives on the machine that owns its files, so the host has to be chosen before the
 * folder is: browsing inside the local disk and browsing inside a server are different file
 * systems, not two views of one. Hidden when there is nowhere else to go (no saved servers).
 *
 * The saved servers come with the picker instead of being loaded here, so the two steps and the
 * screen that creates the workspace all describe the same list.
 */
export function AddWorkspace_HostPicker({
  hosts,
  value,
  onChange,
  disabled = false,
}: AddWorkspace_HostPickerProps) {
  const { t } = useTranslation()
  if (hosts.length === 0) return null

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-foreground mb-2.5">
        {t("workspace.hostLabel")}
      </label>
      <div className="flex flex-wrap gap-1.5">
        <HostChip
          icon={<Laptop className="h-3.5 w-3.5" />}
          label={t("workspace.thisComputer")}
          selected={value === null}
          onSelect={() => onChange(null)}
          disabled={disabled}
        />
        {hosts.map((host) => (
          <HostChip
            key={host.id}
            icon={<Server className="h-3.5 w-3.5" />}
            label={host.name}
            selected={value === host.id}
            onSelect={() => onChange(host.id)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  )
}

function HostChip({
  icon,
  label,
  selected,
  onSelect,
  disabled,
}: {
  icon: ReactNode
  label: string
  selected: boolean
  onSelect: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm",
        "bg-background shadow-minimal transition-all duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "text-foreground ring-1 ring-accent/60"
          : "text-foreground/70 hover:bg-foreground/5",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span className={cn("shrink-0", selected ? "text-accent" : "text-foreground/50")}>{icon}</span>
      <span className="truncate max-w-[180px]">{label}</span>
    </button>
  )
}

/** Saved servers a local window can create a workspace on (empty in a remote window). */
export function useWorkspaceHosts(): RemoteConnection[] {
  const [hosts, setHosts] = useState<RemoteConnection[]>([])

  useEffect(() => {
    if (!window.electronAPI?.getClientMode) return
    let cancelled = false
    void window.electronAPI.getClientMode()
      .then((mode) => {
        // In a remote window the hub *is* the host, so there is nothing to choose between.
        if (cancelled || mode.running) return
        setHosts(mode.connections)
      })
      .catch(() => { /* A missing client mode leaves this computer as the only host. */ })
    return () => { cancelled = true }
  }, [])

  return hosts
}
