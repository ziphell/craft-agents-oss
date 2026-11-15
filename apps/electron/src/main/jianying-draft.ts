/**
 * Installing a 剪映 / CapCut draft on this machine.
 *
 * The panel builds the draft JSON (`@craft-agent/shared/reel/jianying`); this module does the part
 * that needs a filesystem: it copies the media into the draft's `Resources/`, rewrites their paths
 * to absolute ones (剪映 resolves media by absolute path), writes the three JSON files and the
 * five scaffold configs 剪映 validates, and registers the draft in `root_meta_info.json` so it
 * appears in the draft list.
 *
 * The scaffold and registration mirror MiniMax's own `export-to-jianying.py`, including its
 * quirks: `draft_info.json` is the file 剪映 reads (`draft_content.json` is a compatibility alias),
 * and a missing scaffold file makes 剪映 report a corrupted draft.
 *
 * Nothing here opens or stops 剪映. A running client keeps its own draft list in memory, so the
 * panel tells the person to restart it.
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ipcMain } from 'electron'

export type JianyingFlavor = 'jianying' | 'capcut'

export interface JianyingInstallRequest {
  draftName: string
  flavor: JianyingFlavor
  content: Record<string, unknown>
  meta: Record<string, unknown>
  /** Absolute source paths, and the file names they take inside `Resources/`. */
  media: Array<{ srcPath: string; destName: string }>
}

export interface JianyingInstallResult {
  ok: boolean
  path?: string
  message?: string
  code?: 'NO_DRAFT_ROOT' | 'COPY_FAILED' | 'WRITE_FAILED'
}

const SCAFFOLD_DIRS = [
  'adjust_mask',
  'matting',
  'qr_upload',
  'smart_crop',
  'subdraft',
  'common_attachment',
]

const appName = (flavor: JianyingFlavor) => (flavor === 'capcut' ? 'CapCut' : 'JianyingPro')

/** Where the desktop editor keeps its drafts, per platform. Empty means "not this OS". */
function draftRoot(flavor: JianyingFlavor): string {
  const app = appName(flavor)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return local ? join(local, app, 'User Data', 'Projects', 'com.lveditor.draft') : ''
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Movies', app, 'User Data', 'Projects', 'com.lveditor.draft')
  }
  return ''
}

const safeName = (name: string) =>
  name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'draft'

async function uniqueDir(root: string, name: string): Promise<string> {
  let dir = join(root, name)
  let index = 2
  while (existsSync(dir)) {
    dir = join(root, `${name}-${index}`)
    index += 1
  }
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write through a temporary file: 剪映 must never read a half-written draft. */
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(value), 'utf8')
  await rename(temporary, path)
}

/** The configs 剪映 refuses to open a draft without. */
async function scaffoldConfigs(dir: string, content: Record<string, unknown>): Promise<void> {
  const canvas = (content.canvas_config ?? {}) as { height?: number }
  const height = Number(canvas.height) || 1080
  const timelineId = String(content.id ?? 'timeline-default')
  const duration = Number(content.duration) || 0
  const now = Math.floor(Date.now() / 1000)

  await atomicJson(join(dir, 'draft_agency_config.json'), {
    is_auto_agency_enabled: false,
    is_auto_agency_popup: false,
    is_single_agency_mode: false,
    marterials: null,
    use_converter: false,
    video_resolution: height >= 2160 ? 2160 : 1080,
  })
  await atomicJson(join(dir, 'draft_biz_config.json'), {
    timeline_settings: { [timelineId]: { adsorb_enabled: true } },
  })
  await writeFile(
    join(dir, 'draft_settings'),
    [
      '[General]',
      'ai_cover_agent_prompt_text=',
      'cloud_last_modify_platform=mac',
      'cover_editor_last_seek_time=0',
      `draft_create_time=${now}`,
      `draft_last_edit_time=${now}`,
      'real_edit_keys=1',
      `real_edit_seconds=${Math.round(duration / 1_000_000)}`,
      '',
    ].join('\n'),
    'utf8',
  )
  await atomicJson(join(dir, 'performance_opt_info.json'), {
    manual_cancle_precombine_segs: null,
    need_auto_precombine_segs: null,
  })
  await atomicJson(join(dir, 'timeline_layout.json'), {
    activeTimeline: timelineId,
    dockItems: [
      { dockIndex: 0, ratio: 1, timelineIds: [timelineId], timelineNames: ['时间线01'] },
    ],
    layoutOrientation: 1,
  })
}

/** Add the draft to the editor's draft list. Without this it is on disk but invisible. */
async function registerToRootMeta(root: string, dir: string, content: Record<string, unknown>) {
  const path = join(root, 'root_meta_info.json')
  let rootMeta: { all_draft_store?: unknown[]; draft_ids?: number; root_path?: string }
  try {
    rootMeta = JSON.parse(await readFile(path, 'utf8')) as typeof rootMeta
  } catch {
    rootMeta = { all_draft_store: [], draft_ids: 0, root_path: root }
  }
  if (!Array.isArray(rootMeta.all_draft_store)) rootMeta.all_draft_store = []

  let size = 0
  const resources = join(dir, 'Resources')
  if (existsSync(resources)) {
    for (const name of await readdir(resources)) {
      try {
        size += (await stat(join(resources, name))).size
      } catch {
        // A file that vanished mid-scan is simply not counted.
      }
    }
  }

  const now = Date.now() * 1000
  const entry = {
    cloud_draft_cover: false,
    cloud_draft_sync: false,
    draft_cloud_last_action_download: false,
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: '',
    draft_fold_path: dir,
    draft_id: String(content.id ?? '').toUpperCase(),
    draft_is_ai_shorts: false,
    draft_is_cloud_temp_draft: false,
    draft_is_invisible: false,
    draft_is_web_article_video: false,
    draft_json_file: join(dir, 'draft_info.json'),
    draft_name: basename(dir),
    draft_new_version: '',
    draft_root_path: root,
    draft_timeline_materials_size: size,
    draft_type: '',
    draft_web_article_video_enter_from: '',
    streaming_edit_draft_ready: true,
    tm_draft_cloud_completed: '',
    tm_draft_cloud_entry_id: -1,
    tm_draft_cloud_modified: 0,
    tm_draft_cloud_parent_entry_id: -1,
    tm_draft_cloud_space_id: -1,
    tm_draft_cloud_user_id: -1,
    tm_draft_create: now,
    tm_draft_modified: now,
    tm_draft_removed: 0,
    tm_duration: Number(content.duration) || 0,
  }

  const store = rootMeta.all_draft_store as Array<Record<string, unknown>>
  const index = store.findIndex((item) => item.draft_fold_path === dir)
  if (index >= 0) {
    entry.tm_draft_create = Number(store[index]!.tm_draft_create) || now
    entry.draft_id = String(store[index]!.draft_id ?? entry.draft_id)
    store[index] = entry
  } else {
    store.push(entry)
  }
  rootMeta.draft_ids = store.length + 1
  if (!rootMeta.root_path) rootMeta.root_path = root
  await atomicJson(path, rootMeta)
}

/** Copy the media, rewrite the paths, write the draft, register it. */
export async function installJianyingDraft(
  request: JianyingInstallRequest,
): Promise<JianyingInstallResult> {
  const root = draftRoot(request.flavor)
  if (!root || !existsSync(root)) {
    return {
      ok: false,
      code: 'NO_DRAFT_ROOT',
      message: '找不到剪映草稿目录，请先打开一次剪映后再导出',
    }
  }

  const dir = await uniqueDir(root, safeName(request.draftName))
  const resources = join(dir, 'Resources')
  await mkdir(resources, { recursive: true })
  for (const sub of SCAFFOLD_DIRS) await mkdir(join(dir, sub), { recursive: true })

  const copied = new Map<string, string>()
  try {
    for (const item of request.media) {
      const dest = join(resources, item.destName)
      await copyFile(item.srcPath, dest)
      copied.set(item.destName, dest)
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    return {
      ok: false,
      code: 'COPY_FAILED',
      message: `拷贝素材失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    const content = structuredClone(request.content)
    const meta = structuredClone(request.meta)
    const materials = (content.materials ?? {}) as Record<string, Array<Record<string, unknown>>>
    for (const group of ['videos', 'audios']) {
      for (const item of materials[group] ?? []) {
        const name = item.path
        if (typeof name === 'string' && copied.has(name)) item.path = copied.get(name)!
      }
    }

    meta.draft_fold_path = dir
    meta.draft_root_path = root
    const groups = (meta.draft_materials ?? []) as Array<{ value?: Array<Record<string, unknown>> }>
    for (const group of groups) {
      for (const entry of group.value ?? []) {
        const name = String(entry.file_Path ?? '')
        const absolute = copied.get(name) ?? copied.get(basename(name))
        if (!absolute) continue
        entry.file_Path = absolute
        if (typeof entry.extra_info === 'string') entry.extra_info = absolute
      }
    }
    let materialsSize = 0
    for (const path of copied.values()) {
      materialsSize += (await stat(path).catch(() => ({ size: 0 }))).size
    }
    meta.draft_timeline_materials_size_ = materialsSize

    await atomicJson(join(dir, 'draft_info.json'), content)
    await atomicJson(join(dir, 'draft_content.json'), content)
    await atomicJson(join(dir, 'draft_meta_info.json'), meta)
    await scaffoldConfigs(dir, content)
    await registerToRootMeta(root, dir, content)

    return { ok: true, path: dir }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: `写入草稿失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** The IPC door the renderer knocks on. */
export function registerJianyingIpc(): void {
  ipcMain.handle(
    'edit-jianying:install',
    async (_event, request: JianyingInstallRequest) => installJianyingDraft(request),
  )
}
