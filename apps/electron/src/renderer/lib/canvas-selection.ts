/**
 * What a selection says to the agent.
 *
 * The sentence the person typed is the instruction; the lines above it are the part a chat box
 * cannot express cheaply — which nodes, by file and by id, so the agent does not have to guess
 * what "this one" meant.
 */

import type { CanvasNode } from '@craft-agent/shared/canvas/document'

export function selectionMessage(
  nodes: Array<Pick<CanvasNode, 'id' | 'type' | 'src'>>,
  header: string,
  text: string,
): string {
  const lines = nodes.map((node, index) => {
    const name = node.src ? node.src.split(/[\\/]/).pop() : node.type
    return `${index + 1}. ${name} · ${node.type} · ${node.src ?? '—'} · ${node.id}`
  })
  return [header, ...lines, '', text].join('\n')
}
