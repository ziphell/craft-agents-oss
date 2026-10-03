/**
 * The origin drawio is served at, resolved once per mount.
 *
 * Three surfaces need this — the block's viewer, the block's editor, and the full-size overlay's
 * editor — and it is one call for all of them. What is worth keeping in one
 * place is not the effect: it is the two ways this fails, and neither is exotic. The bundle
 * is fetched rather than committed, so a checkout may simply not have it, and a host that
 * cannot serve the app's own origin (a standalone server) has nowhere to put a frame at all. Both
 * come back as a sentence rather than as null, because a blank frame says less than either.
 */

import * as React from 'react'
import { usePlatform } from '../../context/PlatformContext'

export interface DrawioOrigin {
  /** Null until it is known, and null for good if it cannot be had. */
  origin: string | null
  /** What to show instead of a frame, when there is nothing to point one at. */
  problem: string | null
}

export function useDrawioOrigin(): DrawioOrigin {
  const { onGetDrawioOrigin } = usePlatform()
  const [state, setState] = React.useState<DrawioOrigin>({ origin: null, problem: null })

  React.useEffect(() => {
    if (!onGetDrawioOrigin) {
      setState({
        origin: null,
        problem: 'This host cannot serve the diagram editor, so there is nowhere to draw it.',
      })
      return
    }

    let cancelled = false
    onGetDrawioOrigin()
      .then((origin) => {
        if (!cancelled) setState({ origin, problem: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ origin: null, problem: error instanceof Error ? error.message : String(error) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [onGetDrawioOrigin])

  return state
}
