/**
 * A conversation and its project's panel, laid out the way the project asks for.
 *
 * The conversation is always mounted and always the main surface. The panel beside it is either
 * open or closed — there is no panel-only mode. When open it is the project's **side panel**: the
 * same tabs of canvases and files the project page shows, because a person looking at the work and
 * a person talking about it should not be looking at two different things.
 *
 * Two rules the shape follows:
 *
 * - **The conversation stays mounted.** Opening or closing the panel must not stop a stream or
 *   throw away the scroll position, so the panel is mounted beside the chat, never instead of it.
 * - **A conversation with no project has no panel.** There is no project folder to read assets
 *   from, so the layout button is not offered and this component is just the chat.
 */

import { viewportPxToOwnPx } from '@/lib/input-viewport'
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { projectsAtom } from '@/atoms/projects'
import { useCanvasLayout } from '@/atoms/canvas-layout'
import { useSidePanelFocus } from '@/atoms/side-panel'
import { chromeFocusRequestAtom } from '@/atoms/chrome-focus'
import { useActiveWorkspace, useAppShellContext, useSession } from '@/context/AppShellContext'
import ChatPage from '@/pages/ChatPage'
import { cn } from '@/lib/utils'
import { SidePanel } from '@/components/side-panel/SidePanel'

const MIN_RATIO = 0.25
const MAX_RATIO = 0.75

export function SessionCanvasWorkspace({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const workspace = useActiveWorkspace()
  const projects = useAtomValue(projectsAtom)

  const { isFocusedPanel } = useAppShellContext()
  const projectId = session?.projectId ?? null
  const project = projects.find((candidate) => candidate.config.id === projectId) ?? null
  const [mode, setMode] = useCanvasLayout(projectId)
  const [ratio, setRatio] = React.useState(0.5)
  const { focused: focus, toggle: togglePanelFocus } = useSidePanelFocus(projectId)
  const setChromeFocus = useSetAtom(chromeFocusRequestAtom)
  // Expanding the panel is a request for the window, not just for the column: the sidebar and
  // navigator go away with the conversation, and come back when the panel is restored.
  const toggleFocus = React.useCallback(() => {
    const next = !focus
    togglePanelFocus()
    setChromeFocus({ hidden: next, at: Date.now() })
  }, [focus, setChromeFocus, togglePanelFocus])

  // Closing while the panel covers the conversation would leave neither surface on screen, so the
  // panel comes back to the split row before it closes.
  const closePanel = React.useCallback(() => {
    if (focus) toggleFocus()
    setMode('chat')
  }, [focus, setMode, toggleFocus])

  const containerRef = React.useRef<HTMLDivElement>(null)

  /** Drag the divider. The ratio is this panel's, not the project's — it is proportional, and it is
   *  not persisted. */
  const startDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const element = containerRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const move = (pointer: PointerEvent) => {
      // 指针是视口 px，rect 是子树 px：先换算再除
      const next = viewportPxToOwnPx(pointer.clientX - rect.left) / rect.width
      setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }, [])

  // A conversation with no project has no panel, so it is simply the chat.
  if (!projectId || !project) {
    return <ChatPage sessionId={sessionId} />
  }

  // One panel, not one per pane: split-view conversations in the same project share the project's
  // panel state, so rendering it in every pane would put the same library on screen twice. The
  // focused pane owns the panel; an unfocused pane is just the conversation.
  const showPanel = mode === 'split' && !!workspace?.id && isFocusedPanel !== false

  // One tree in both states: the chat keeps its identity when the panel opens, so opening the
  // panel never remounts the conversation (which would drop its scroll position).
  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 w-full">
      <div
        className={cn('h-full min-w-0', !showPanel && 'flex-1')}
        style={showPanel && !focus ? { flex: `0 0 ${ratio * 100}%` } : undefined}
        hidden={showPanel && focus}
      >
        <ChatPage sessionId={sessionId} />
      </div>

      {showPanel && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('chat.layoutResize')}
            onPointerDown={startDrag}
            onDoubleClick={() => setRatio(0.5)}
            className={cn('w-1.5 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-accent/50', focus && 'hidden')}
          />

          {/* No header of its own: the side panel's tab strip is the title bar, and it carries the
              close control — "侧栏" is not something a person needs to be told. */}
          <div
            className={cn(
              'flex h-full min-w-0 flex-col',
              // Focus mode is the same panel, not a second one: it keeps its tabs, its scroll and
              // whatever the cut is playing, and simply stops sharing the row with the chat.
              focus ? 'absolute inset-0 z-30 bg-background' : 'relative flex-1',
            )}
          >
            <div className="min-h-0 flex-1 overflow-hidden">
              <SidePanel
                workspaceId={workspace.id}
                project={project}
                sessionId={sessionId}
                focused={focus}
                onToggleFocus={toggleFocus}
                onClose={closePanel}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
