/**
 * useBrowserToolbarActions
 *
 * Handles the actions a browser panel's own toolbar forwards to the main window.
 *
 * The panel is a separate render process with no workspace or prototype context,
 * so it reports what the user did (`BrowserToolbarAction`) and this hook — which
 * has both `sessionMetaMap` and the prototype list — decides what it means.
 *
 * The binding is resolved through the window's session rather than from the
 * active workspace, because the user may be looking at a panel opened by a
 * different session than the one currently selected in the sidebar.
 */

import { useCallback, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { browserInstancesAtom } from '@/atoms/browser-pane'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import type { PickedElement } from '@craft-agent/shared/protocol'

export interface EditElementRequest {
  element: PickedElement
  instanceId: string
  /** The prototype the panel's window is bound to. */
  slug: string
  /** Session that owns the window — where "change it in the conversation" goes. */
  sessionId: string | null
}

export interface UseBrowserToolbarActionsOptions {
  workspaceId: string | null | undefined
  /** Called when the user picked an element in a bound panel. */
  onEditElement: (request: EditElementRequest) => void
}

export function useBrowserToolbarActions({
  workspaceId,
  onEditElement,
}: UseBrowserToolbarActionsOptions): void {
  const { t } = useTranslation()
  const instances = useAtomValue(browserInstancesAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  /**
   * Which prototype the panel's window belongs to, and which session owns it.
   *
   * `boundSessionId` is the agent-owned binding; `ownerSessionId` covers windows
   * a session opened but has not formally claimed. A window with neither is a
   * plain manual browser and has no prototype.
   */
  const resolveBinding = useCallback((instanceId: string): { slug: string | null; sessionId: string | null } => {
    const instance = instances.find((item) => item.id === instanceId)
    if (!instance) return { slug: null, sessionId: null }
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId
    if (!sessionId) return { slug: null, sessionId: null }
    return { slug: sessionMetaMap.get(sessionId)?.prototypeSlug ?? null, sessionId }
  }, [instances, sessionMetaMap])

  useEffect(() => {
    const off = window.electronAPI.browserPane.onToolbarAction((action) => {
      if (action.kind === 'pick-failed') {
        toast.error(t('browserEdit.pickFailed'), { description: action.message })
        return
      }

      const { slug, sessionId } = resolveBinding(action.instanceId)
      if (!slug) {
        // Not an error worth an alert — the user simply has not bound anything,
        // so say where the binding comes from.
        toast.info(t('browserEdit.noPrototype'))
        return
      }

      if (action.kind === 'apply-requested') {
        if (!workspaceId) return
        void window.electronAPI
          .applyPrototype(workspaceId, action.instanceId, slug)
          .then((result) => {
            toast.success(t('browserEdit.applied', { applied: (result as { applied: number }).applied }))
          })
          .catch((err: unknown) => {
            console.error('[useBrowserToolbarActions] Failed to apply prototype:', err)
            toast.error(t('browserEdit.applyFailed'), {
              description: err instanceof Error ? err.message : String(err),
            })
          })
        return
      }

      // kind === 'picked'. A null element means the user cancelled or it timed out.
      if (!action.element) return
      onEditElement({ element: action.element, instanceId: action.instanceId, slug, sessionId })
    })

    return () => {
      if (typeof off === 'function') off()
    }
  }, [resolveBinding, workspaceId, onEditElement, t])
}
