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
import { Bot, EyeOff, Globe, MousePointerClick, Plus, X, XCircle, Zap } from 'lucide-react'
import { BrowserControls, Spinner } from '@craft-agent/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { cn } from '@/lib/utils'
import { getHostname } from '@/components/browser/utils'
import type { BrowserTabSummary } from '../shared/types'
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
   * Whether the window's element picker is on (plan §12.7).
   *
   * The window's mode, reported rather than guessed: it can also end from inside
   * the page (Escape), which this renderer never sees otherwise. `undefined` = no
   * state yet, which reads as "off" — the picker is not something to flash on.
   */
  picking?: boolean
  /**
   * The window's pages, in the order they were opened (plan §22).
   *
   * `undefined` for a window that has not pushed state yet — the rail draws no
   * pages until it is told which ones exist, because an empty list would be chrome
   * with no content.
   */
  tabs?: BrowserTabSummary[]
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
      /** Switch to one of this window's pages, close one, or add one. */
      tabAction: (action: 'activate' | 'close' | 'new', tabId?: string) => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Which surface this is                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether this document is the page rail rather than the address bar.
 *
 * The window's chrome is an L — a row and a column — and one `BrowserView` is one
 * rectangle, so the host loads this same bundle twice and says which surface each
 * copy is. The document is identical; only the shape of the surface differs.
 */
const IS_RAIL = new URLSearchParams(window.location.search).get('view') === 'rail'

/* ------------------------------------------------------------------ */
/*  Page rail                                                          */
/* ------------------------------------------------------------------ */

/**
 * The window's pages, down the window's left edge (plan §22).
 *
 * Pages are a list that grows with use, and a window has height to spare rather
 * than width: as a row across the top the list had to share its room with the
 * address bar, so a second page pushed the bar aside and every chip after it
 * scrolled out of sight — which is what made it unusable. A column gives every
 * page the same width, and the bar keeps the geometry it always had.
 *
 * It reads as chrome, so it drags the window like the bar does — except the pages
 * themselves and the `+`, which are things to click. Its colours are the app's,
 * not the page's: chrome is not part of the page (the page's own colour still tints
 * the window's chip in the top bar, which is about *which* window, not this surface).
 */
function PageRail({
  tabs,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: BrowserTabSummary[]
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
}) {
  const { t } = useTranslation()
  const tone = {
    text: 'text-foreground/60',
    active: 'bg-foreground/[0.07] text-foreground/85',
    hover: 'hover:bg-foreground/[0.04]',
  }

  return (
    // `h-screen`, not `h-full`: the rail's document has no height of its own to
    // inherit (`#root` is auto-height so the bar's own 48px row needs nothing from
    // it), and the rail is the view's whole height.
    <div className="flex h-screen flex-col bg-background">
      {/*
        The rail's own header row: what the column is, and the way to add to it. `+`
        lives here rather than beside the pages because it must stay reachable however
        long the list gets. Same height as the address bar next to it, so the two read
        as one band across the window's top.
      */}
      <div className="titlebar-drag-region flex h-[48px] shrink-0 items-center justify-between pl-3 pr-2">
        <span className={cn('select-none text-[11px] font-medium', tone.text)}>{t('browser.pages')}</span>
        <button
          type="button"
          aria-label={t('browser.newPage')}
          className={cn(
            'titlebar-no-drag flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] transition-colors',
            tone.text,
            tone.hover,
          )}
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="titlebar-drag-region scrollbar-hide flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5">
        {tabs.map((tab) => {
          const label = tab.title.trim() || getHostname(tab.url) || t('browser.untitledPage')
          // Which prototype, and which of its pages — the two facts the address bar
          // names for the page on screen, here for every page, since a column of
          // titles cannot tell one prototype's page from another's.
          const where = tab.prototype
            ? `${tab.prototype.slug}${tab.prototypePage ? ` / ${tab.prototypePage}` : ''}`
            : null

          return (
            <div
              key={tab.id}
              className={cn(
                'group flex items-center gap-0.5 rounded-[6px] transition-colors',
                tone.text,
                tab.active ? tone.active : tone.hover,
              )}
            >
              <button
                type="button"
                className="titlebar-no-drag flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1.5 text-left"
                title={where ? `${where}\n${tab.url}` : tab.url}
                onClick={() => onSelect(tab.id)}
              >
                <span className="mt-px shrink-0">
                  {tab.isLoading ? (
                    <Spinner className="text-[9px]" />
                  ) : (
                    <Globe className="h-3 w-3 opacity-60" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-[11px]">{label}</span>
                    {/*
                      Who opened it, and who is on it. The user is looking at their
                      own window, so the opener is only worth marking when it was
                      not them — the same fact the agent reads out of `tabs` to know
                      what not to close. The dot is the other half: a page some
                      conversation is working on right now (plan §22).
                    */}
                    {tab.openedBySessionId !== null && <Bot className="h-3 w-3 shrink-0 opacity-50" />}
                    {tab.driverSessionId !== null && (
                      <span
                        aria-label={t('browser.pageInUse')}
                        title={t('browser.pageInUse')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      />
                    )}
                  </span>
                  {where && <span className="truncate text-[10px] opacity-60">{where}</span>}
                </span>
              </button>

              <button
                type="button"
                aria-label={t('browser.closePage')}
                className={cn(
                  'titlebar-no-drag mr-1 shrink-0 rounded-[4px] p-0.5 transition-opacity hover:bg-black/10 hover:opacity-100',
                  tab.active ? 'opacity-60' : 'opacity-0 group-hover:opacity-60',
                )}
                onClick={() => onClose(tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
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
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
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
  /**
   * Edit mode, as the window reports it.
   *
   * Not this renderer's own state: the mode outlives a single pick and can also
   * end in the page (Escape), so the toolbar that drew it has to be told what it
   * is rather than remember what it asked for (plan §12.7).
   */
  const picking = state.picking === true

  const api = window.browserToolbar

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate(setState)
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setWindowMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    // The menu belongs to the address bar, and so does its geometry: the rail never
    // opens one, and it must not report the bar's menu closed behind its back.
    if (!api || IS_RAIL) return

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

  /**
   * Turn the window's picker on or off.
   *
   * Neither call is awaited for its outcome: the mode is the window's, and it
   * arrives back as state. Awaiting would mean this renderer had its own idea of
   * whether picking is on, which is exactly what the state push exists to avoid.
   */
  const handleTogglePick = useCallback(() => {
    if (!api) return
    if (picking) {
      void api.cancelPick()
      return
    }
    void api.pickElement(t('browser.addToConversation'))
  }, [api, picking, t])

  const handleApplyPrototype = useCallback(() => {
    void api?.applyPrototype()
  }, [api])

  const handleSelectPage = useCallback((tabId: string) => {
    void api?.tabAction('activate', tabId)
  }, [api])

  const handleClosePage = useCallback((tabId: string) => {
    void api?.tabAction('close', tabId)
  }, [api])

  const handleNewPage = useCallback(() => {
    void api?.tabAction('new')
  }, [api])

  /**
   * The rail draws the pages; the bar draws the address.
   *
   * Both surfaces exist in every window and both are told everything, so the two
   * cannot drift apart — but each draws only what it is. Placed after the hooks so
   * the two surfaces run the same hook list in the same order.
   */
  if (IS_RAIL) {
    return (
      <PageRail
        tabs={state.tabs ?? []}
        onSelect={handleSelectPage}
        onClose={handleClosePage}
        onNew={handleNewPage}
      />
    )
  }

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
              // Always available: picking is not about a prototype (a prototype
              // decides what a selection can be turned *into*, and only the
              // action below needs one), and a pick with no conversation to go
              // to opens one (plan §12.7).
              onClick={handleTogglePick}
            />

            <HeaderIconButton
              icon={<Zap className="h-3.5 w-3.5" />}
              aria-label={t('browser.applyPrototype')}
              disabled={!hasPrototype}
              onClick={handleApplyPrototype}
            />

            <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="h-3.5 w-3.5" />}
                  aria-label={t('browser.windowOptions')}
                  className="bg-background shadow-minimal hover:bg-foreground/5"
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
