import { useAppShellContext } from '@/context/AppShellContext'
import { useDesigns } from '@/hooks/useDesigns'
import { DesignView } from './DesignView'

/**
 * The root of a design's own window (docs/design-plan.md §2.7).
 *
 * It renders the same design surface the app renders, without the two rows that
 * only make sense inside the app: the header (this window's own title bar carries
 * the design's name) and the Present row. There is no AppShell either — no top
 * bar, no sidebars, no panel geometry. It still *hosts* the design: DesignView
 * keeps its sandboxed frame, its render lease, its approved actions and its live
 * data.
 *
 * `useDesigns` is called here because AppShell calls it for every window view;
 * without it the designs atom would stay empty and this window would miss
 * config updates (a rename, a refresh, a pin) until it was reloaded. It is the
 * one piece of AppShell the design surface actually depends on.
 */
export function DesignWindow({ designSlug }: { designSlug: string }) {
  const { activeWorkspaceId } = useAppShellContext()
  useDesigns(activeWorkspaceId)
  return <DesignView designSlug={designSlug} standalone />
}
