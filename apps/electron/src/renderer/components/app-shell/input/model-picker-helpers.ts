import {
  isLocalConnection,
  type ConnectionModelEntry,
  type LlmConnection,
} from '@config/llm-connections'
import { getModelShortName } from '@config/models'

/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

/**
 * Label for one model row in a picker.
 *
 * A custom endpoint's models are named by the user, so an entry without an
 * explicit display name shows the id **verbatim** — a prettified guess ("Qwen3
 * Coder" for `qwen3-coder`) would name a model the endpoint has never heard of.
 * Registry-backed providers keep their catalogue names / humanized ids.
 */
export function modelLabel(
  model: ConnectionModelEntry,
  options: { customEndpoint: boolean },
): string {
  if (typeof model === 'string') {
    return options.customEndpoint ? model : stripPiPrefixForDisplay(getModelShortName(model))
  }
  return model.name ?? (options.customEndpoint ? model.id : stripPiPrefixForDisplay(model.id))
}

export type ConnectionGroup = [groupName: string, connections: LlmConnection[]]

/**
 * Group connections by provider type for hierarchical picker rendering.
 * Each provider section can contain multiple connections (API Key, OAuth, …).
 * Order is significant for UI: Anthropic, Local, Craft Agents Backend.
 * Empty groups are dropped.
 */
export function groupConnectionsByProvider<T extends LlmConnection>(
  connections: readonly T[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {
    'Anthropic': [],
    'Local': [],
    'Craft Agents Backend': [],
  }
  for (const conn of connections) {
    const provider = conn.providerType || 'anthropic'
    if (provider === 'anthropic') {
      groups['Anthropic'].push(conn)
    } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
      groups['Local'].push(conn)
    } else if (provider === 'pi' || provider === 'pi_compat') {
      groups['Craft Agents Backend'].push(conn)
    }
  }
  return Object.entries(groups).filter(([, conns]) => conns.length > 0)
}
