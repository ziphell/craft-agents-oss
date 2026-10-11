import { useState, useEffect, type RefObject } from 'react'

/**
 * Tracks the border-box inline-size (width) of a DOM element using ResizeObserver.
 *
 * Used by AppShell to derive `isAutoCompact` — when the shell container
 * is narrower than the mobile threshold, sidebar/navigator auto-collapse
 * and panels switch to single-panel mode.
 *
 * Measured on the *border* box rather than the content box on purpose: AppShell
 * derives the shell's own padding from `isAutoCompact`, so a content-box
 * measurement shrinks the moment compact mode turns on, which flips the flag
 * back off — an infinite loop that makes the layout oscillate (violently) right
 * at the breakpoint. The border box is independent of the element's padding.
 *
 * Returns 0 until the element is first measured.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const ro = new ResizeObserver(([entry]) => {
      const borderBox = entry.borderBoxSize?.[0]
      setWidth(borderBox?.inlineSize ?? entry.target.getBoundingClientRect().width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return width
}
