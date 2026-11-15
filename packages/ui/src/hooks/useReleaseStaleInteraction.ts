import * as React from 'react'

/**
 * Let go of what this window was holding when it goes away — and again when it comes back.
 *
 * Three things outlive a window losing focus, and all three put a tooltip on screen that nobody
 * asked for:
 *
 * - **A hover.** Chromium never delivers the `pointerleave` that moving the pointer off would
 *   have caused, so whatever the pointer was on keeps its `:hover` style — and a tooltip opened
 *   by hovering it stays open — with nothing to clear either.
 * - **A focused trigger.** A tooltip opened by focusing its trigger (Radix does that) has nothing
 *   to close it, and the focus is put back when the window returns, which opens it again as if
 *   the pointer had found it.
 * - **A move the window brings back with it.** When a window is activated, Chromium delivers a
 *   synthetic move at the pointer's last place so hover states are recomputed — and a tooltip
 *   trigger under it reads that as a hover and opens.
 *
 * Measured as the top bar's "open browser" tip appearing on every restore from the taskbar, with
 * nobody having gone near the button. So: on the way out, synthesize the leave and close the
 * focused trigger; on the way in, synthesize the leave once the activation has been processed.
 */
export function useReleaseStaleInteraction(): void {
  React.useEffect(() => {
    const releaseHovered = () => {
      const hovered = document.querySelectorAll(':hover')
      const target = hovered[hovered.length - 1]
      if (!(target instanceof HTMLElement)) return
      // React derives `onPointerLeave` from `pointerout` — which is the one Radix's tooltip
      // trigger closes on; `mouseout` is what lets the `:hover` style go with it.
      target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }))
      target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    }

    const onBlur = () => {
      releaseHovered()
      // The close a focus-opened tooltip listens for, and what stops the focus coming back with
      // the window and opening it again.
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest('[data-tooltip-trigger]')) active.blur()
    }

    const onFocus = () => {
      // After the activation, so a synthetic move it delivered has already been read.
      requestAnimationFrame(releaseHovered)
    }

    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
}
