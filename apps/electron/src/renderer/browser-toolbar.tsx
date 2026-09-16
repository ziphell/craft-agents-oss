/**
 * Browser Toolbar — React entry point
 *
 * Renders the shared BrowserControls component inside a chromeless
 * BrowserWindow. Communicates with the main process via a dedicated
 * preload script (browser-toolbar preload).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { useTranslation, initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { setupI18n } from '@craft-agent/shared/i18n'
import { EyeOff, MousePointerClick, X, XCircle, Zap } from 'lucide-react'
import { BrowserControls } from '@craft-agent/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import './index.css'

// This is a standalone entry (browser-toolbar.html) — i18n must be initialized
// here or BrowserControls and the menu below render raw translation keys.
setupI18n([LanguageDetector, initReactI18next])

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ToolbarState {
  /**
   * What the URL bar shows. For a window that is working on a prototype this is
   * the prototype's **own** address, never the third-party page an overlay is
   * rendering — the window belongs to the prototype, and the bar says so.
   */
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  themeColor?: string | null
  /**
   * The prototype the URL above names, or `null` for a window that is not one
   * (no conversation, a conversation without a prototype, or a window the user
   * steered away by typing an address).
   *
   * `undefined` = no state has arrived yet, which is treated as "unknown" rather
   * than "none" so the buttons do not flash disabled while the first push is in
   * flight.
   */
  prototypeSlug?: string | null
  /**
   * Whether this window belongs to a conversation (plan §12.7).
   *
   * `undefined` = no state has arrived yet, treated the same way the slug is:
   * unknown rather than "none", so the pick button does not flash disabled while
   * the first push is in flight.
   */
  hasSession?: boolean
}

declare global {
  interface Window {
    browserToolbar: {
      instanceId: string
      navigate: (url: string) => Promise<void>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      setMenuGeometry: (open: boolean, height?: number) => Promise<void>
      hideWindow: () => Promise<void>
      closeWindowEntirely: () => Promise<void>
      /** The label is the caller's: the bar is drawn in the page, which has no i18n. */
      pickElement: (addLabel?: string) => Promise<void>
      cancelPick: () => Promise<void>
      applyPrototype: () => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
    }
  }
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function BrowserToolbarApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ToolbarState>({
    url: 'about:blank',
    title: 'New Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [themeColor, setThemeColor] = useState<string | null>(null)
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  /**
   * Edit mode. While true the page suppresses its own click handlers, so a click
   * selects an element instead of activating it — this is why entering the mode
   * is an explicit button press rather than something that happens implicitly.
   */
  const [picking, setPicking] = useState(false)
  const menuContentRef = useRef<HTMLDivElement | null>(null)

  /**
   * Whether the two prototype actions have anything to act on.
   *
   * Both resolve through the prototype this window is showing, which is what the
   * URL bar already states, so the answer comes straight from that: a window
   * that is not a prototype's never accepts a click it would have to explain
   * away afterwards.
   */
  const hasPrototype = state.prototypeSlug === undefined || state.prototypeSlug !== null
  // Picking an element needs a conversation, not a prototype: a plain web page
  // bound to a session is exactly the case this exists for, and the prototype
  // actions below stay gated on the prototype (plan §12.7).
  const hasSession = state.hasSession === undefined || state.hasSession === true

  const api = window.browserToolbar

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate((s) => {
      setState(s)
      // Sync theme color from full state push (initial load / reconnection)
      if ('themeColor' in s) {
        setThemeColor((s as ToolbarState).themeColor ?? null)
      }
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onThemeColor(setThemeColor)
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setWindowMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return

    if (!windowMenuOpen) {
      void api.setMenuGeometry(false, 0)
      return
    }

    // Prime expansion immediately to avoid a constrained first measurement.
    void api.setMenuGeometry(true, 120)

    const sendGeometry = () => {
      const height = Math.ceil(menuContentRef.current?.getBoundingClientRect().height ?? 0)
      void api.setMenuGeometry(true, height)
    }

    let frame = requestAnimationFrame(sendGeometry)
    const observer = new ResizeObserver(() => {
      sendGeometry()
    })

    if (menuContentRef.current) {
      observer.observe(menuContentRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      void api.setMenuGeometry(false, 0)
    }
  }, [api, windowMenuOpen])

  const handleNavigate = useCallback((url: string) => {
    void api?.navigate(url)
  }, [api])

  const handleGoBack = useCallback(() => {
    void api?.goBack()
  }, [api])

  const handleGoForward = useCallback(() => {
    void api?.goForward()
  }, [api])

  const handleReload = useCallback(() => {
    void api?.reload()
  }, [api])

  const handleStop = useCallback(() => {
    void api?.stop()
  }, [api])

  const handleHideWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.hideWindow()
  }, [api])

  const handleCloseWindowEntirely = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.closeWindowEntirely()
  }, [api])

  const handleTogglePick = useCallback(async () => {
    if (!api) return

    if (picking) {
      setPicking(false)
      await api.cancelPick()
      return
    }

    setPicking(true)
    try {
      // Resolves on pick, Escape, cancel, or timeout — every one of which must
      // leave edit mode, so the reset lives in `finally` rather than in the
      // success path only.
      await api.pickElement(t('browser.addToConversation'))
    } finally {
      setPicking(false)
    }
  }, [api, picking])

  const handleApplyPrototype = useCallback(() => {
    void api?.applyPrototype()
  }, [api])

  return (
    <>
      {/*
        Full-window outside-tap catcher while menu is open.
        Critical for draggable titlebar windows (Windows) where outside-click
        dismissal can be unreliable if events fall into app-region: drag zones.
      */}
      {windowMenuOpen && (
        <div
          className="fixed inset-0 z-[90] titlebar-no-drag bg-black/[0.0039215686]"
          onPointerDown={(event) => {
            event.preventDefault()
            setWindowMenuOpen(false)
          }}
        />
      )}

      <BrowserControls
        url={state.url}
        loading={state.isLoading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onStop={handleStop}
        trailingContent={(
          <div className="ml-2 flex items-center gap-1.5 titlebar-no-drag">
            {/*
              Edit mode indicator. Text, not just a highlighted icon: the user is
              about to click into the page, and a wrong click there would activate
              whatever is under the cursor if this mode were not clearly entered.
            */}
            {picking && (
              <span className="inline-flex select-none items-center whitespace-nowrap rounded-[6px] bg-accent/15 px-2 py-1 text-[11px] text-accent">
                {t('browser.pickHint')}
              </span>
            )}

            <HeaderIconButton
              icon={picking
                ? <X className="h-3.5 w-3.5" />
                : <MousePointerClick className="h-3.5 w-3.5" />}
              aria-label={picking ? t('browser.cancelPick') : t('browser.pickElement')}
              className={picking ? 'bg-accent/15 text-accent' : undefined}
              style={!picking && themeColor ? { color: 'var(--tb-fg)' } : undefined}
              // Still clickable while picking: cancelling must not be taken away
              // by a binding change that happens mid-pick.
              //
              // Gated on a *conversation*, not a prototype: what a picked element
              // is for is decided by the conversation it is handed to, and a plain
              // web page with a session bound is exactly the case this exists for.
              // The prototype actions below stay gated on the prototype (§12.7).
              disabled={!hasSession && !picking}
              onClick={() => { void handleTogglePick() }}
            />

            <HeaderIconButton
              icon={<Zap className="h-3.5 w-3.5" />}
              aria-label={t('browser.applyPrototype')}
              style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
              disabled={!hasPrototype}
              onClick={handleApplyPrototype}
            />

            <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="h-3.5 w-3.5" />}
                  aria-label={t('browser.windowOptions')}
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-44"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible"
              >
                <StyledDropdownMenuItem onSelect={handleHideWindow}>
                  <EyeOff className="h-3.5 w-3.5" />
                  {t('browser.hideWindow')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem variant="destructive" onSelect={handleCloseWindowEntirely}>
                  <XCircle className="h-3.5 w-3.5" />
                  {t('browser.closeWindowEntirely')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        themeColor={themeColor}
        urlBarClassName="max-w-[600px]"
        className="titlebar-drag-region bg-background"
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserToolbarApp />
  </React.StrictMode>,
)
