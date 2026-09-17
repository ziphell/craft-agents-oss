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
import type { PickedElement, PickedElementOrigin } from '@craft-agent/shared/protocol'
import type { PrototypeEntry } from '@craft-agent/shared/prototypes'

export interface EditElementRequest {
  element: PickedElement
  instanceId: string
  /** The prototype the panel's window is bound to. */
  slug: string
  /** Session that owns the window — where "change it in the conversation" goes. */
  sessionId: string | null
}

/**
 * An element handed to a conversation rather than to a prototype (plan §12.7).
 *
 * No slug, and that is the point: picking an element to talk about needs a
 * conversation and nothing else, so a plain page someone opened in a bound window
 * works exactly like a prototype's.
 */
export interface AddElementRequest {
  element: PickedElement
  instanceId: string
  /** The page it was picked on — see `PickedElementOrigin`. */
  origin: PickedElementOrigin
  /**
   * Where it goes: the conversation the user is looking at, or `null` when there
   * is none — a window of its own, or nothing selected in the sidebar — in which
   * case the caller opens one rather than dropping the pick.
   */
  sessionId: string | null
}

export interface UseBrowserToolbarActionsOptions {
  workspaceId: string | null | undefined
  /** The conversation the user is looking at, if any — where a pick goes. */
  activeSessionId?: string | null
  /** Called when the user picked an element in a bound panel. */
  onEditElement: (request: EditElementRequest) => void
  /** Called when the user used the bar under the highlight. */
  onAddElementToConversation: (request: AddElementRequest) => void
}

export function useBrowserToolbarActions({
  workspaceId,
  activeSessionId,
  onEditElement,
  onAddElementToConversation,
}: UseBrowserToolbarActionsOptions): void {
  const { t } = useTranslation()
  const instances = useAtomValue(browserInstancesAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  /**
   * Which prototype the panel's window belongs to, and which conversation it is
   * being used by.
   *
   * The prototype comes from the main process (`prototypeSlug`), which is the only
   * side that knows: a window opened for a prototype says so even before any
   * conversation exists, and an overlay's view sits on a third-party address, so
   * neither the URL nor the session is enough on its own.
   *
   * The session is read the way `BrowserTabStrip` reads it, and for the same
   * reason: the window is shared, so the lease answers "who is using it now" while
   * the page's opener answers "whose work is on screen" — the window itself has no
   * owner to fall back on (plan §22).
   */
  const resolveBinding = useCallback((instanceId: string): { slug: string | null; sessionId: string | null } => {
    const instance = instances.find((item) => item.id === instanceId)
    if (!instance) return { slug: null, sessionId: null }
    const sessionId = instance.boundSessionId
      ?? instance.tabs?.find((tab) => tab.active)?.openedBySessionId
      ?? null
    const slug = instance.prototypeSlug ?? (sessionId ? sessionMetaMap.get(sessionId)?.prototypeSlug ?? null : null)
    return { slug, sessionId }
  }, [instances, sessionMetaMap])

  /**
   * Open a prototype — or one of its pages — in one of the panel's windows.
   *
   * Mirrors the panel's own preview: the address comes from `getPrototypeEntry` —
   * a live page's own address for an overlay page, the host's rendering of the
   * document for a page of ours, the page index when no page is the entry — and
   * only a live page needs its patches replayed afterwards. Nothing here is new
   * machinery; it is the same two RPCs the preview button calls.
   *
   * `page` is how the address bar's own answer gets acted on: the bar names a
   * prototype and a page (`/pay`), and this resolves that page rather than letting
   * the view be redirected to it.
   */
  const openPrototype = useCallback(async (instanceId: string, slug: string, page?: string | null) => {
    if (!workspaceId) return
    try {
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, slug, page)) as PrototypeEntry
      await window.electronAPI.browserPane.navigate(instanceId, entry.url)
      if (entry.injectPatches) {
        await window.electronAPI.applyPrototype(workspaceId, instanceId, slug)
      }
    } catch (err) {
      console.error('[useBrowserToolbarActions] Failed to open prototype:', err)
      toast.error(t('browserEdit.openPrototypeFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [workspaceId, t])

  useEffect(() => {
    const off = window.electronAPI.browserPane.onToolbarAction((action) => {
      if (action.kind === 'pick-failed') {
        toast.error(t('browserEdit.pickFailed'), { description: action.message })
        return
      }

      // Typing a prototype's address in the panel asks for the prototype, not
      // for that URL — so it takes the same route the panel's own preview does:
      // resolve where the prototype is shown, then replay its patches into it.
      // (The main process binds the window to the prototype as it recognises the
      // address, so the bar keeps naming the prototype after the view navigates.)
      if (action.kind === 'open-prototype') {
        if (!workspaceId) return
        void openPrototype(action.instanceId, action.slug, action.page)
        return
      }

      // The bar under the highlight needs no prototype — a page nobody owns is
      // the case it exists for — so it is answered before the prototype check
      // rather than gated behind it (plan §12.7).
      if (action.kind === 'add-to-conversation') {
        // Where it goes is the conversation the user is looking at, not whoever
        // happens to be driving the window: the window is shared, so the lease on
        // it says what the agent last did, not where a person's pick belongs. With
        // nothing selected, `null` asks the caller to open a conversation — the
        // pick is never dropped for want of one.
        onAddElementToConversation({
          element: action.element,
          instanceId: action.instanceId,
          origin: action.origin,
          sessionId: activeSessionId ?? null,
        })
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
            const report = result as {
              applied: number
              unmatched?: string[]
              drifted?: Array<{ target: string }>
              untargeted?: string[]
            }
            // What the patches made of the page (plan §21.1). A count alone hides
            // the one thing worth knowing: that a patch matched nothing, which is
            // otherwise indistinguishable from one that changed nothing.
            const notes: string[] = []
            if (report.unmatched && report.unmatched.length > 0) {
              notes.push(t('browserEdit.unmatched', { targets: report.unmatched.join(', ') }))
            }
            if (report.drifted && report.drifted.length > 0) {
              notes.push(t('browserEdit.drifted', { targets: report.drifted.map((d) => d.target).join(', ') }))
            }
            if (report.untargeted && report.untargeted.length > 0) {
              notes.push(t('browserEdit.untargeted', { count: report.untargeted.length }))
            }
            toast.success(t('browserEdit.applied', { applied: report.applied }), {
              description: notes.length > 0 ? notes.join(' · ') : undefined,
            })
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
  }, [resolveBinding, openPrototype, workspaceId, activeSessionId, onEditElement, onAddElementToConversation, t])
}
