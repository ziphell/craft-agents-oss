/**
 * Throwaway probe: the six design tools, driven the way a session drives them.
 *
 * The chain under test is the runtime one, not a unit stub:
 *   SESSION_TOOL_REGISTRY handler
 *     → ctx.designs (attached by attachSessionSelfManagementBindings)
 *       → the registry's session-scoped callbacks
 *         → buildDesignsToolCallbacks (SessionManager's own wiring)
 *           → @craft-agent/shared/designs (real storage + data store)
 *
 * Runs against a temp workspace and removes it afterwards.
 *   bun run apps/electron/spike/design-tools-e2e.ts
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildDesignsToolCallbacks } = await import('../../../packages/server-core/src/designs/tool-callbacks.ts')
const { registerSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } = await import(
  '../../../packages/shared/src/agent/session-scoped-tools.ts'
)
const { createClaudeContext } = await import('../../../packages/shared/src/agent/claude-context.ts')
const { attachSessionSelfManagementBindings } = await import(
  '../../../packages/shared/src/agent/session-self-management-bindings.ts'
)
const { SESSION_TOOL_REGISTRY } = await import('../../../packages/session-tools-core/src/index.ts')

const workspaceRootPath = mkdtempSync(join(tmpdir(), 'design-tools-e2e-'))
const sessionId = 'design-tools-e2e-probe'
const workspaceId = 'ws-probe'
const mutations: string[] = []

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head>
<body><div id="v">—</div><script>
window.addEventListener('message', (e) => {
  const m = e.data
  if (m && m.protocol === 'craft-designs/v1' && m.type === 'init') {
    document.getElementById('v').textContent = String(m.payload.snapshot?.kv?.total ?? '—')
  }
})
window.parent.postMessage({ protocol: 'craft-designs/v1', type: 'ready' }, '*')
</script></body></html>`

registerSessionScopedToolCallbacks(sessionId, {
  designs: buildDesignsToolCallbacks({
    workspaceId,
    workspaceRootPath,
    log: (m) => console.log('  [tool-callbacks]', m),
    onDesignsMutated: async (slug) => {
      mutations.push(slug)
    },
  }),
})

const ctx = createClaudeContext({
  sessionId,
  workspacePath: workspaceRootPath,
  workspaceId,
  onPlanSubmitted: () => {},
  onAuthRequest: () => {},
})
attachSessionSelfManagementBindings(ctx, sessionId)

const results: Array<{ tool: string; ok: boolean; text: string }> = []

async function call(tool: string, args: Record<string, unknown>): Promise<any> {
  const handler = SESSION_TOOL_REGISTRY.get(tool)?.handler
  if (!handler) throw new Error(`no handler for ${tool}`)
  const result = await handler(ctx, args)
  const text = result.content.map((c: any) => c.text ?? '').join('')
  results.push({ tool, ok: !result.isError, text: text.slice(0, 120).replace(/\s+/g, ' ') })
  return result
}

try {
  await call('list_designs', {})
  const created = await call('create_design', {
    name: 'E2E Probe',
    description: 'probe',
    kind: 'live',
    content: HTML,
  })
  const slug = JSON.parse(created.content[0].text).slug as string

  await call('get_design', { slug, includeContent: true })
  await call('update_design', { slug, name: 'E2E Probe Renamed' })
  await call('write_design_data', {
    slug,
    set: { total: 7 },
    appendSeries: { 'probe.ms': [{ v: 12 }, { t: Date.now() - 500, v: 30 }] },
  })

  const configPath = join(workspaceRootPath, 'designs', slug, 'design.json')
  const snapshotPath = join(workspaceRootPath, 'designs', slug, 'data', 'snapshot.json')
  const onDisk = {
    config: existsSync(configPath),
    content: existsSync(join(workspaceRootPath, 'designs', slug, 'index.html')),
    snapshot: existsSync(snapshotPath),
    snapshotKv: existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf-8')).kv : null,
    nameOnDisk: existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')).name : null,
  }

  await call('delete_design', { slug })
  const deleted = !existsSync(configPath)

  console.log(JSON.stringify({ results, onDisk, mutations, deleted, failed: results.filter(r => !r.ok).length }, null, 2))
  if (results.some(r => !r.ok) || !deleted || !onDisk.config || !onDisk.snapshot) process.exitCode = 1
} catch (error) {
  console.error('probe threw:', error)
  process.exitCode = 1
} finally {
  unregisterSessionScopedToolCallbacks(sessionId)
  rmSync(workspaceRootPath, { recursive: true, force: true })
}
