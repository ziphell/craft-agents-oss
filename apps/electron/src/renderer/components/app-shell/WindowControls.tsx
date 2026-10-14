import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isWebUI, isWindows, titleBarCaptionInset } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * The window's minimize / maximize-restore / close, drawn by the app.
 *
 * On Windows these used to be the OS's, painted over a `titleBarOverlay` strip: their colours,
 * hover shapes and hit areas belonged to Windows rather than to the bar they sit on. Drawing them
 * here puts them on the app's own surface — the same theme, the same hover, the same weight as
 * everything else in the bar. The trade is Snap Layouts, which the OS's hover-the-maximize-button
 * flyout needs and a button we draw cannot ask for (see `window-manager.ts`).
 *
 * Windows, main window only. macOS draws its traffic lights on the left, Linux keeps its native
 * frame, the Web UI has no window, and a design window keeps the standard title bar — so it wears
 * the OS's buttons, not these. The room reserved is `titleBarCaptionInset`, the same measure the OS
 * overlay needed, so everything that stepped around those buttons still steps around these.
 */
export function WindowControls() {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // Only Windows draws these, so nothing to track anywhere else — and the two methods may be
    // absent in a host that has no desktop window (the playground's mock).
    if (!isWindows || isWebUI) return
    const api = window.electronAPI
    if (!api?.getWindowMaximizedState || !api.onWindowMaximizedChange) return
    // Asked once for the state a push may have happened before this mounted, then kept by the
    // push (the two events that change it are the only ones that do — see `window-manager.ts`).
    let live = true
    void api.getWindowMaximizedState().then((value) => { if (live) setMaximized(value) })
    const off = api.onWindowMaximizedChange((value) => setMaximized(value))
    return () => { live = false; off() }
  }, [])

  if (!isWindows || isWebUI) return null

  const api = window.electronAPI
  const button = 'titlebar-no-drag grid h-full place-items-center text-foreground/70 transition-colors'

  return (
    <div
      className="titlebar-no-drag fixed right-0 top-0 flex items-stretch"
      style={{ height: 'var(--topbar-height)', width: titleBarCaptionInset, zIndex: 400 }}
    >
      <button
        type="button"
        aria-label={t('menu.minimize')}
        title={t('menu.minimize')}
        className={cn(button, 'w-[46px] hover:bg-foreground/[0.06] hover:text-foreground')}
        onClick={() => void api.menuMinimize()}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>

      <button
        type="button"
        aria-label={maximized ? t('menu.restore') : t('menu.maximize')}
        title={maximized ? t('menu.restore') : t('menu.maximize')}
        className={cn(button, 'w-[46px] hover:bg-foreground/[0.06] hover:text-foreground')}
        onClick={() => void api.menuMaximize()}
      >
        {maximized
          ? <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
          : <Square className="h-3 w-3" strokeWidth={1.5} />}
      </button>

      <button
        type="button"
        aria-label={t('common.close')}
        title={t('common.close')}
        className={cn(button, 'w-[46px] hover:bg-[#e81123] hover:text-white')}
        onClick={() => void api.closeWindow()}
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>
  )
}
