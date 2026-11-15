/**
 * Whether a node can be used as an input *right now*.
 *
 * A strip can name a node whose file is not there yet: an empty node, a run that failed, or one
 * that is still generating. Dropping it silently would send the provider fewer references than the
 * person sees; so the question is answered before anything is spent.
 */

import type { CanvasNode } from '@craft-agent/shared/canvas/document'

export type ReferenceReadiness = 'ready' | 'missing' | 'pending' | 'failed'

export function referenceReadiness(
  node: Pick<CanvasNode, 'src'>,
  lookup: { task: { status: string } | null; artifact: boolean },
): ReferenceReadiness {
  if (!node.src) return 'missing'
  const status = lookup.task?.status
  if (status === 'queued' || status === 'running') return 'pending'
  if (status === 'failed' || status === 'submission_unknown' || status === 'cancelled') return 'failed'
  // A task that is already terminal-but-successful is removed; `artifact` is the file itself.
  return lookup.artifact ? 'ready' : 'missing'
}
