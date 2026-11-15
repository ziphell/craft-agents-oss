import * as React from 'react'

/**
 * Whether an element is near the viewport.
 *
 * Exists for the blocks a message can carry that are **expensive per instance**: an `office-preview`
 * is a whole editor application in a frame (8–20 MB of script, an editor, a document), and a `pdf-preview`
 * parses its file. A conversation renders every turn it has, with no windowing, so without this a
 * history with a dozen such blocks boots a dozen editors at once at scroll position zero.
 *
 * `rootMargin` is what makes it feel free: mount a little before the block is actually on screen, so
 * scrolling into it finds it ready rather than starting the load exactly when the person looks.
 *
 * `triggerOnce: false` (the default) means the answer can go back to `false` — the caller unmounts
 * what it mounted. That is only safe for a block that **cannot hold unsaved work**, which is why the
 * conversation's office frames are read-only: nothing is lost when one goes away.
 *
 * No `IntersectionObserver` (an old webview, a test environment) reads as visible: a block that
 * cannot be observed should still draw, rather than silently never mounting.
 */
export function useInView<T extends Element>(
  options: { rootMargin?: string; triggerOnce?: boolean } = {},
): [React.RefObject<T>, boolean] {
  // useRef<T>(null) → RefObject<T> (readonly current: T | null), which the DOM `ref` prop accepts.
  const ref = React.useRef<T>(null)
  const [inView, setInView] = React.useState(false)
  const triggerOnce = options.triggerOnce ?? false
  const rootMargin = options.rootMargin ?? '800px 0px'

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true)
            if (triggerOnce) observer.disconnect()
          } else if (!triggerOnce) {
            setInView(false)
          }
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin, triggerOnce])

  return [ref, inView]
}
