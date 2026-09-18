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
import { Circle, Code, EyeOff, Globe, Lock, MessageSquare, MousePointerClick, Pencil, Plus, Square, X, XCircle } from 'lucide-react'
import { BrowserControls, Spinner } from '@craft-agent/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { cn } from '@/lib/utils'
import { getHostname } from '@/components/browser/utils'
import { groupTabsByWork, shouldShowGroupHeaders, type TabGroup } from '@/components/browser/tab-groups'
import type { BrowserTabSummary, TabBelongsTo } from '../shared/types'
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
   * Whether the window's element picker is on (plan §12.7).
   *
   * The window's mode, reported rather than guessed: it can also end from inside
   * the page (Escape), which this renderer never sees otherwise. `undefined` = no
   * state yet, which reads as "off" — the picker is not something to flash on.
   */
  picking?: boolean
  /**
   * Whether the window's element **editor** is on.
   *
   * Reported rather than remembered, for the picker's reason (it also ends from
   * inside the page, and arming one mode takes the other off) — and one thing more:
   * what the person does in it is written into a patch, so this button's state is
   * the only place the window says "changes you make here are being saved".
   */
  editing?: boolean
  /**
   * Whether the tab on screen has its developer tools up.
   *
   * The tab's tools, not the window's: they follow what is on screen, so they are put
   * away when the user switches tabs. `undefined` = no state yet, which reads as "off"
   * for the same reason as `picking` — nothing to flash on.
   */
  devTools?: boolean
  /**
   * The window's tabs, in the order they were opened (plan §22).
   *
   * `undefined` for a window that has not pushed state yet — the rail draws no
   * tabs until it is told which ones exist, because an empty list would be chrome
   * with no content.
   */
  tabs?: BrowserTabSummary[]
  /**
   * What to call each conversation whose tabs are in `tabs`, by opener id.
   *
   * The rail groups tabs by who opened them (plan §22, 第八轮), and a session id is
   * not a name. A missing entry is a conversation with no name yet — the rail says
   * something generic rather than printing an id.
   */
  sessionLabels?: Record<string, string>
  /**
   * The recording the person started from this window, if one is running.
   *
   * `null` (or no state yet) is the ordinary case. The window reports it rather than the
   * button remembering it, because a recording also ends from the host side — the
   * recorded tab is closed, or its window is — and a button still claiming to record a
   * file that is already finished would be worse than no button.
   */
  recording?: {
    /** Where the file is being written. */
    file: string
    /** Epoch ms, so the elapsed time is counted from the recording rather than from a click. */
    startedAt: number
    bytes: number
  } | null
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
      /** Turn the window's element editor on, or take it off. */
      startEditing: (labels?: { undo: string; save: string; discard: string }) => Promise<void>
      cancelEdit: () => Promise<void>
      /** Switch to one of this window's tabs, close one, add one, or unlock one. */
      tabAction: (
        action: 'activate' | 'close' | 'new' | 'release',
        tabId?: string,
        /**
         * For `new` alone: the work the tab is being opened **for**, when a section's
         * header asked for it rather than the rail's own `+` — see `createTab`'s
         * `openedByPerson` on the host side (plan §22).
         */
        work?: TabBelongsTo | null,
      ) => Promise<void>
      /** Open the current tab's developer tools, or close them if they are up. */
      toggleDevTools: () => Promise<void>
      /** Arm a recording of the tab on screen; the display media request follows it. */
      startRecording: (extension?: string) => Promise<ToolbarState['recording']>
      /** Finish the recording and close the file. Answers with `null` when nothing came through. */
      stopRecording: () => Promise<{ file: string; bytes: number; seconds: number } | null>
      /** One encoded chunk, in the order produced. */
      sendRecordingChunk: (chunk: ArrayBuffer) => void
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Which surface this is                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether this document is the tab rail rather than the address bar.
 *
 * The window's chrome is an L — a row and a column — and one `BrowserView` is one
 * rectangle, so the host loads this same bundle twice and says which surface each
 * copy is. The document is identical; only the shape of the surface differs.
 */
const IS_RAIL = new URLSearchParams(window.location.search).get('view') === 'rail'

/** `0:07` — a recording's length, in the form a person reads a stopwatch in. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * What to record into, best first.
 *
 * **mp4 first**, and for two reasons that were measured rather than assumed (see
 * `apps/electron/spike/recorder-formats.cjs`): it is the container everything else opens —
 * QuickTime, Windows, a browser tab — and it is the one whose duration a `<video>` knows
 * the moment it loads, which is what `sample-video` computes its sampling step from. A
 * webm (or mkv) recorded live reports `duration: Infinity` until something reads the file
 * out, so it is the fallback for a build that cannot record mp4 rather than the default.
 * Both play back and sample here; the sampler resolves a webm's duration itself.
 */
const RECORDING_FORMATS = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
]

/** The first format this build will record, or `null` when it will record none of them. */
function pickRecordingFormat(): { mimeType: string; extension: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const format of RECORDING_FORMATS) {
    try {
      if (MediaRecorder.isTypeSupported(format.mimeType)) return format
    } catch {
      // `isTypeSupported` can throw on a string it cannot parse; a format that cannot be
      // asked about is not a format to record into.
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  Tab rail                                                          */
/* ------------------------------------------------------------------ */

/**
 * One tab's own mark, in the rail's leading column.
 *
 * A column of truncated 11px titles is slow to read by text alone, and the site's own
 * icon is the thing the eye can use instead — the window's chip in the top bar draws the
 * same image from the same field, so a tab looks like itself in both places.
 *
 * Three states, in the order they can be trusted: a tab that is loading says so (the
 * spinner is the only mark on the row about work in progress), a tab with an icon shows
 * it, and everything else gets a globe — including an icon that failed to load, which is
 * what a site with none amounts to anyway. `failed` is cleared when the address changes,
 * because the next page's icon is a different request and one 404 is not a verdict on the
 * site.
 */
function TabIcon({ src, loading }: { src: string | null; loading: boolean }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (loading) return <Spinner className="text-[10px] leading-none" />
  if (!src || failed) return <Globe className="h-3.5 w-3.5" />

  return (
    <img
      src={src}
      alt=""
      className="h-3.5 w-3.5 rounded-[3px] object-cover"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * The window's tabs, down the window's left edge (plan §22).
 *
 * Tabs are a list that grows with use, and a window has height to spare rather
 * than width: as a row across the top the list had to share its room with the
 * address bar, so a second tab pushed the bar aside and every chip after it
 * scrolled out of sight — which is what made it unusable. A column gives every
 * tab the same width, and the bar keeps the geometry it always had.
 *
 * It reads as chrome, so it drags the window like the bar does — except the tabs
 * themselves and the `+`, which are things to click. Its colours are the app's,
 * not the page's: chrome is not part of the page (the page's own colour still tints
 * the window's chip in the top bar, which is about *which* window, not this surface).
 */
function TabRail({
  tabs,
  sessionLabels,
  onSelect,
  onClose,
  onNew,
  onNewFor,
  onRelease,
}: {
  tabs: BrowserTabSummary[]
  sessionLabels: Record<string, string>
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
  /**
   * One more tab **for this work** — the `+` on a section's header, rather than the rail's
   * own `+` above it. The tab is the work's and joins its section (plan §22).
   */
  onNewFor: (work: TabBelongsTo) => void
  onRelease: (tabId: string) => void
}) {
  const { t } = useTranslation()
  const tone = {
    /** An inactive row's text: readable, never competing with the tab on screen. */
    text: 'text-foreground/65',
    /**
     * A section's name. A step quieter than the tabs under it — it is a label for them,
     * not one of them — but not so quiet that a section reads as a divider.
     */
    group: 'text-foreground/55',
    /** The rail's own label and a tab's second line: there when looked for. */
    faint: 'text-foreground/45',
    /** The tab on screen: solid text over a tint the row keeps while it is current. */
    active: 'bg-foreground/[0.08] text-foreground',
    hover: 'hover:bg-foreground/[0.04]',
    /** Held down anywhere on the row — the pill answers the click before the tab changes. */
    pressed: 'active:bg-foreground/[0.1]',
  }

  /**
   * The tabs, sectioned by whose work they are — a person's, one of the conversations this
   * window is shared with, or a task of the Tasks DAG (plan §22, 第八轮).
   *
   * The rule lives in `groupTabsByWork` because the badge's tab list in the top bar
   * draws the same list and the two must not disagree about it. Headers only appear
   * when there is more than one group: with a single group they would be a row saying
   * "all of these are yours" over all of them.
   */
  const groups = groupTabsByWork(tabs)
  const showHeaders = shouldShowGroupHeaders(groups)

  /**
   * What to write on a group's header: a name, never an id.
   *
   * A task is named by its own slug — that is the name the board, the task's folder and every
   * one of its sessions use — so nothing has to be pushed alongside the tabs for it, the way a
   * conversation's name has to be (`sessionLabels`: the rail is a separate document).
   */
  const groupLabel = (group: TabGroup): string => {
    const work = group.work
    if (!work) return t('browser.openedByYou')
    if (work.kind === 'task') return work.taskSlug
    return sessionLabels[work.sessionId] ?? t('browser.openedByConversation')
  }

  /**
   * The `+` on a section's header: one more tab **for that work**.
   *
   * What the person does with it is set a page up in advance — open the site, get to the
   * screen, sign in — so the conversation it belongs to can carry on from there, which is
   * why the tab is made the work's rather than the person's. It comes with the header, so it
   * is there whether the window holds one section or several; the person's own section has no
   * header and no button, because one more of your own tabs is what the rail's `+` above is.
   *
   * Named for the two shapes work comes in, because "put a tab in this group" is not
   * something a person would say to themselves: what they are doing is opening a page for a
   * conversation, or for a task.
   */
  const groupAddButton = (work: TabBelongsTo) => {
    const label = work.kind === 'task' ? t('browser.newTabForTask') : t('browser.newTabForConversation')
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        // `-mr-1`: out of the header's own padding, so the icon sits in the column the
        // rows' close buttons are in rather than on a margin of its own.
        className="titlebar-no-drag -mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => onNewFor(work)}
      >
        <Plus className="h-3 w-3" />
      </button>
    )
  }

  return (
    // `h-screen`, not `h-full`: the rail's document has no height of its own to
    // inherit (`#root` is auto-height so the bar's own 48px row needs nothing from
    // it), and the rail is the view's whole height.
    <div className="flex h-screen flex-col bg-background">
      {/*
        The rail's own header row: what the column is, and the way to add to it. `+`
        lives here rather than beside the tabs because it must stay reachable however
        long the list gets. Same height as the address bar next to it, so the two read
        as one band across the window's top — and the same left edge the tabs and their
        section headers start at, so the column has one margin instead of three.
      */}
      <div className="titlebar-drag-region flex h-[48px] shrink-0 items-center justify-between pl-3.5 pr-2">
        <span className={cn('select-none text-[11px] font-medium', tone.faint)}>{t('browser.tabs')}</span>
        <button
          type="button"
          aria-label={t('browser.newTab')}
          title={t('browser.newTab')}
          className={cn(
            'titlebar-no-drag grid h-6 w-6 shrink-0 place-items-center rounded-[6px] transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            tone.text,
            'hover:bg-foreground/[0.06] hover:text-foreground',
          )}
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="titlebar-drag-region scrollbar-hide flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-1.5">
        {groups.map((group) => (
          <div key={group.key} className="relative flex flex-col gap-0.5">
            {/*
              The section's own guide: a hairline down the gutter, with its tabs indented
              past it. A name in a slightly different grey is not enough to read as a
              section on its own — it says "these belong together" only to somebody who
              already knew. The step in and the line are the two cues that do not have to
              be read. Drawn before the header so the header's opaque band, which sticks,
              paints over whatever the line would otherwise show behind it.
            */}
            {showHeaders && (
              <span
                aria-hidden
                className="pointer-events-none absolute left-1 top-8 bottom-1 w-px rounded-full bg-foreground/10"
              />
            )}

            {showHeaders && (
              /*
                Sticky, so a section goes on saying whose tabs these are while its own
                tabs are scrolled through: with two conversations working in one window,
                a name that scrolls out of sight leaves a list of anonymous rows. The
                negative margin is what lets the band cover the scrollport's own gutter —
                without it, rows would slide past it in the 6px beside it.

                One height for every section (`min-h-8`), button or no button: a band that
                grew only where it holds one would read as two kinds of section.
              */
              <div
                className={cn(
                  'sticky top-0 z-10 -mx-1.5 flex min-h-8 items-center gap-1 bg-background px-3.5 py-1 text-[10px] font-medium',
                  tone.group,
                )}
              >
                {/* A message, not a robot: a section is a conversation's work, and the
                    person reading the rail is looking at conversations. */}
                {group.work !== null && <MessageSquare className="h-3 w-3 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{groupLabel(group)}</span>
                {group.work !== null && groupAddButton(group.work)}
              </div>
            )}

            {group.tabs.map((tab) => {
              const label = tab.title.trim() || getHostname(tab.url) || t('browser.untitledTab')
              // Which prototype, and which of its pages — the two facts the address bar
              // names for the tab on screen, here for every tab, since a column of
              // titles cannot tell one prototype's page from another's.
              const where = tab.prototype
                ? `${tab.prototype.slug}${tab.prototypePage ? ` / ${tab.prototypePage}` : ''}`
                : null
              // Everything the row is too narrow to say: the title it truncates, the
              // prototype and page its second line shortens, and the address behind both.
              // The rail is 200px wide and a popup of ours would be clipped by its own
              // view, so this is the browser's own tooltip rather than the app's.
              const tooltip = [label, where, tab.url].filter(Boolean).join('\n')

              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group flex items-center gap-0.5 rounded-[6px] transition-colors',
                    // Stepped in past the section's guide, so a row reads as belonging to
                    // the name above it and not to the column. Not when there are no
                    // headers: the only section there is cannot be nested under anything.
                    showHeaders && 'ml-3',
                    // Focus lights the row the way hover does. `*:focus-visible` turns the
                    // outline off app-wide, so a row that ignored focus would leave the
                    // keyboard with nothing to go by. Hover is for the inactive rows only:
                    // on the current tab it comes out *dimmer* than the tab already is,
                    // which reads as the tab losing its place.
                    'focus-within:bg-foreground/[0.08]',
                    tab.active ? tone.active : cn(tone.text, tone.hover),
                    tone.pressed,
                  )}
                >
                  <button
                    type="button"
                    className="titlebar-no-drag flex min-w-0 flex-1 items-start gap-1.5 rounded-[6px] px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    title={tooltip}
                    onClick={() => onSelect(tab.id)}
                  >
                    {/*
                      Dimmed as a whole rather than letting the text do it twice: the
                      globe inherits a colour while an image cannot, so the slot states
                      its own and lets one opacity rule both. That is what keeps a page
                      with an icon and a page without them equally quiet until one of
                      them is the tab on screen.
                    */}
                    <span
                      className={cn(
                        'mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center text-foreground',
                        tab.active ? 'opacity-100' : 'opacity-70',
                      )}
                    >
                      <TabIcon src={tab.favicon} loading={tab.isLoading} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[11px]">{label}</span>
                      {where && <span className="truncate text-[10px] text-foreground/45">{where}</span>}
                    </span>
                  </button>

                  {/*
                    What is happening to the tab, in the same place on every row instead of
                    after the title: read down the rail's right edge and the answer is one
                    column, and a row's own marks never move the title they sit beside.
                    Two strengths, one mark. The lock is a **button** — a click there does
                    nothing, so taking the tab back has to be possible from outside it, since
                    the agent's overlay is what holds the tab and letting go of the overlay is
                    the unlock (plan §22, 第九轮修正). It is an escape hatch rather than a
                    setting: the agent's next action may take the tab again. The plain dot is
                    the weaker fact, a tab somebody has driven but is not holding.
                  */}
                  {tab.lockedBy === null && tab.driverSessionId !== null && (
                    <span
                      aria-label={t('browser.tabInUse')}
                      title={t('browser.tabInUse')}
                      className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    />
                  )}

                  {tab.lockedBy !== null && (
                    <button
                      type="button"
                      aria-label={t('browser.releaseLock')}
                      title={t('browser.releaseLock')}
                      className="titlebar-no-drag grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => onRelease(tab.id)}
                    >
                      <Lock className="h-3 w-3" />
                    </button>
                  )}

                  {/*
                    Always in the layout, so a title truncates once and never reflows when
                    the pointer arrives: what hovering reveals is the button, not the room
                    for it. The current tab's stays out — it is the one row not asking to be
                    found — and the keyboard brings it back on focus, since a control that
                    cannot be seen is not a control anybody can use.
                  */}
                  <button
                    type="button"
                    aria-label={t('browser.closeTab')}
                    title={t('browser.closeTab')}
                    className={cn(
                      'titlebar-no-drag mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-foreground',
                      'transition-[opacity,background-color] hover:bg-foreground/10 hover:opacity-100',
                      'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      tab.active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                    )}
                    onClick={() => onClose(tab.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>
        ))}
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
   * Edit mode, as the window reports it.
   *
   * Not this renderer's own state: the mode outlives a single pick and can also
   * end in the page (Escape), so the toolbar that drew it has to be told what it
   * is rather than remember what it asked for (plan §12.7).
   */
  const picking = state.picking === true
  /**
   * Edit mode, as the window reports it.
   *
   * The mode where a change made here is *saved*: boxing elements and pressing B,
   * or double-clicking a line and retyping it, writes a patch of the prototype this
   * page belongs to. Which is also why the bar says so while it is on — a page that
   * looks one way until a reload and another way after it is worse than one that was
   * never touched.
   */
  const editing = state.editing === true
  /**
   * Whether the current tab's developer tools are up, as the window reports it.
   *
   * Not this renderer's state for the same reason as `picking`: the tools can be closed
   * from their own window, and switching tabs puts them away.
   */
  const devTools = state.devTools === true

  const api = window.browserToolbar

  /**
   * The recording, as the window reports it (plan §20.3, revised).
   *
   * The person's own recording of the tab in front of them: they press the button, drive
   * the page, press it again. It is here rather than in the agent's tool set because
   * "now" is the one thing nobody can say from inside the thing being recorded.
   */
  const recording = state.recording ?? null
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [savedFile, setSavedFile] = useState<string | null>(null)
  const [recordFailed, setRecordFailed] = useState(false)

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

  /**
   * How long the recording has been running, counted from when it started.
   *
   * From the host's `startedAt` rather than from a click here: the button is the person's,
   * and a renderer that reloaded mid-recording would otherwise start counting again.
   */
  const recordingStartedAt = recording?.startedAt ?? null
  useEffect(() => {
    if (recordingStartedAt === null) {
      setElapsedMs(0)
      return
    }
    const tick = () => setElapsedMs(Date.now() - recordingStartedAt)
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [recordingStartedAt])

  /** Where it went, said for a moment and then out of the way. */
  useEffect(() => {
    if (!savedFile) return
    const timer = setTimeout(() => setSavedFile(null), 8000)
    return () => clearTimeout(timer)
  }, [savedFile])

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

  /**
   * Turn the window's editor on or off.
   *
   * Neither call is awaited for its outcome, for the picker's reason: the mode is
   * the window's and arrives back as state. The bar's words go with the call — it is
   * drawn inside the page, which has no i18n, and this is the side that does.
   */
  const handleToggleEdit = useCallback(() => {
    if (!api) return
    if (editing) {
      void api.cancelEdit()
      return
    }
    void api.startEditing({
      undo: t('browserEdit.editorUndo'),
      save: t('browserEdit.editorSave'),
      discard: t('browserEdit.editorDiscard'),
    })
  }, [api, editing, t])

  const handleToggleDevTools = useCallback(() => {
    void api?.toggleDevTools()
  }, [api])

  /**
   * Start or stop the person's recording of this tab.
   *
   * Starting is three steps in a fixed order: **arm** the recording (the host opens the
   * file and takes the tab — the display-media request is answered with exactly that tab),
   * **ask** for the picture, then record what comes back. There is no picker to click
   * through: the request this makes is the one the host is waiting for.
   */
  const handleToggleRecord = useCallback(async () => {
    if (!api) return

    if (recording) {
      // Stopped through the recorder rather than straight at the host: the final chunk is
      // produced by `stop`, and the file must not be closed before it has been sent. (The
      // recorder can also be gone — the host ends a recording whose tab is closed — and
      // then there is nothing left but to tell the host, which answers `null`.)
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      else void api.stopRecording()
      return
    }

    setRecordFailed(false)
    setSavedFile(null)

    // The format first, because the host opens the file — and names it — before any of the
    // picture exists: an mp4 that ended up as `…webm` would be a file nothing opens.
    const format = pickRecordingFormat()
    if (!format) {
      setRecordFailed(true)
      return
    }

    try {
      await api.startRecording(format.extension)
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const media = new MediaRecorder(stream, { mimeType: format.mimeType })
      media.ondataavailable = (event) => {
        if (event.data.size === 0) return
        void event.data.arrayBuffer().then((chunk) => api.sendRecordingChunk(chunk))
      }
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        setRecorder(null)
        void api.stopRecording().then((finished) => {
          // `null` is "nothing reached the file", which the host has already removed.
          if (finished) setSavedFile(finished.file)
        })
      }
      // A chunk a second: the file is playable up to the last one, so a crash or a killed
      // window costs a second rather than the whole recording.
      media.start(1000)
      setRecorder(media)
    } catch {
      // No picture — the request was refused, or there is no tab to record. Nothing was
      // captured, so the armed file goes away rather than sitting in the session empty.
      setRecordFailed(true)
      setRecorder(null)
      void api.stopRecording()
    }
  }, [api, recording, recorder])

  const handleSelectTab = useCallback((tabId: string) => {
    void api?.tabAction('activate', tabId)
  }, [api])

  const handleCloseTab = useCallback((tabId: string) => {
    void api?.tabAction('close', tabId)
  }, [api])

  const handleNewTab = useCallback(() => {
    void api?.tabAction('new')
  }, [api])

  /**
   * Open a tab for one piece of work — the `+` on a section's header.
   *
   * The work goes with the request rather than being applied here: which conversation a
   * tab belongs to is the window's fact, and the tab comes back belonging to it through
   * the state push (see the host's `createTab`, which is where the tab is made).
   */
  const handleNewTabForWork = useCallback((work: TabBelongsTo) => {
    void api?.tabAction('new', undefined, work)
  }, [api])

  /**
   * Take a locked tab back.
   *
   * The agent's overlay is what holds the tab, so this drops the overlay for whoever is
   * working there (plan §22, 第九轮修正) — the escape hatch for "I am stuck behind
   * somebody's running turn". Not awaited for its outcome: whether it released anything
   * comes back as state, and this renderer drawing its own idea of that is the thing the
   * state push exists to prevent.
   */
  const handleReleaseLock = useCallback((tabId: string) => {
    void api?.tabAction('release', tabId)
  }, [api])

  /**
   * The rail draws the tabs; the bar draws the address.
   *
   * Both surfaces exist in every window and both are told everything, so the two
   * cannot drift apart — but each draws only what it is. Placed after the hooks so
   * the two surfaces run the same hook list in the same order.
   */
  if (IS_RAIL) {
    return (
      <TabRail
        tabs={state.tabs ?? []}
        sessionLabels={state.sessionLabels ?? {}}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
        onNewFor={handleNewTabForWork}
        onRelease={handleReleaseLock}
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
              // Always available: picking is not about a prototype — what a
              // selection gets turned *into* is decided after it is picked, and a
              // pick with no conversation to go to opens one (plan §12.7).
              onClick={handleTogglePick}
            />

            {/*
              The editor: the mode where the person's own change is written down.
              Always available whatever the page is — which prototype (and which page)
              an edit belongs to is the window's own fact, and a page that belongs to
              none says so when the edit is made rather than never offering the mode.
            */}
            {editing && (
              <span className="inline-flex select-none items-center whitespace-nowrap rounded-[6px] bg-accent/15 px-2 py-1 text-[11px] text-accent">
                {t('browser.editHint')}
              </span>
            )}

            <HeaderIconButton
              icon={editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              aria-label={t('browser.editMode')}
              className={editing ? 'bg-accent/15 text-accent' : undefined}
              onClick={handleToggleEdit}
            />

            {/*
              The current tab's developer tools. Available whatever the tab is: they
              are about the page, not about a prototype.
            */}
            <HeaderIconButton
              icon={<Code className="h-3.5 w-3.5" />}
              aria-label={t('browser.devTools')}
              className={devTools ? 'bg-foreground/10 text-foreground' : undefined}
              onClick={handleToggleDevTools}
            />

            {/*
              The record button: the person's own recording of the tab they are on, which
              is the one thing a recording needs that no agent can supply — "now". The
              file goes to their downloads folder (see the host's `record` handler) and
              nothing is sent to any conversation about it.
            */}
            <HeaderIconButton
              icon={recording
                ? <Square className="h-3 w-3 fill-current" />
                : <Circle className="h-3.5 w-3.5" />}
              aria-label={recording ? t('browser.stopRecording') : t('browser.startRecording')}
              className={recording ? 'bg-destructive/15 text-destructive' : undefined}
              onClick={() => void handleToggleRecord()}
            />

            {recording && (
              <span className="inline-flex select-none items-center whitespace-nowrap rounded-[6px] bg-destructive/15 px-2 py-1 text-[11px] tabular-nums text-destructive">
                {formatElapsed(elapsedMs)}
              </span>
            )}

            {savedFile && (
              <span
                className="inline-flex max-w-[220px] select-none items-center truncate whitespace-nowrap rounded-[6px] bg-foreground/5 px-2 py-1 text-[11px] text-muted-foreground"
                title={savedFile}
              >
                {t('browser.recordingSaved')} · {savedFile.split(/[/\\]/).pop()}
              </span>
            )}

            {recordFailed && (
              <span className="inline-flex select-none items-center whitespace-nowrap rounded-[6px] bg-destructive/15 px-2 py-1 text-[11px] text-destructive">
                {t('browser.recordFailed')}
              </span>
            )}

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
