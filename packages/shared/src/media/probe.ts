/**
 * "Is this account set up right?" — asked without generating anything.
 *
 * Generating a picture to test a key costs money and, for a video, minutes. Listing the account's
 * models answers the same question in one request: 401 means the key is wrong, a list that does not
 * contain the chosen model means the model is wrong, and both together mean it works. Providers
 * that do not implement `GET /models` are reported as such rather than as a failure — reachable but
 * unverifiable is a different fact from wrong.
 */

export interface ChannelProbeRequest {
  baseUrl: string
  apiKey: string
  auth?: { header: string; prefix?: string }
  /** The model the person picked, when there is one to check against the account's list. */
  model?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export type ChannelProbeReason = 'key' | 'model' | 'unsupported' | 'network' | 'server'

export interface ChannelProbeResult {
  /** The key was accepted. A model mismatch still counts: the account works. */
  ok: boolean
  reason?: ChannelProbeReason
  /** The HTTP status, when a response arrived. */
  status?: number
  /** Model ids the account lists. Empty when it lists none or cannot be asked. */
  models: string[]
  /** A short provider sentence, for a person who wants the raw cause. Not translated. */
  detail?: string
}

function authHeaders(request: ChannelProbeRequest): Record<string, string> {
  const header = request.auth?.header ?? 'Authorization'
  const prefix = request.auth?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '')
  return { [header]: `${prefix}${request.apiKey}`, Accept: 'application/json' }
}

function modelsFromJson(json: unknown): string[] {
  if (!json || typeof json !== 'object') return []
  const record = json as Record<string, unknown>
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      ids.push(row)
      continue
    }
    if (!row || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    if (id) ids.push(id.replace(/^models\//, ''))
  }
  return [...new Set(ids)]
}

/** The path a provider lists models at. Gemini puts them under its API version, not the root. */
function modelsPath(auth?: { header: string }): string {
  return auth?.header.toLowerCase() === 'x-goog-api-key' ? '/v1beta/models' : '/models'
}

export async function probeChannelAccount(request: ChannelProbeRequest): Promise<ChannelProbeResult> {
  const base = request.baseUrl.trim().replace(/\/+$/, '')
  if (!base) return { ok: false, reason: 'network', models: [], detail: 'base URL is empty' }

  const url = `${base}${modelsPath(request.auth)}`
  const doFetch = request.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: authHeaders(request),
      signal: AbortSignal.timeout(request.timeoutMs ?? 12000),
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      models: [],
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'key', status: response.status, models: [] }
  }
  if (response.status === 404 || response.status === 405) {
    return { ok: false, reason: 'unsupported', status: response.status, models: [] }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return {
      ok: false,
      reason: 'server',
      status: response.status,
      models: [],
      detail: detail.slice(0, 200),
    }
  }

  const json = await response.json().catch(() => null)
  const models = modelsFromJson(json)
  const wanted = request.model?.trim()
  if (wanted && models.length > 0 && !models.includes(wanted)) {
    return { ok: true, reason: 'model', status: response.status, models }
  }
  return { ok: true, models, status: response.status }
}
