import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleReelTool } from '../reel.ts'
import { setReelSnapshot } from '@craft-agent/shared/reel/snapshot'
import { setReelExportHost, type ReelExportJob } from '@craft-agent/shared/reel/export-host'
import { setReelProbe } from '@craft-agent/shared/reel/probe'
import { setReelAudio } from '@craft-agent/shared/reel/audio'
import type { EditDocument } from '@craft-agent/shared/reel/document'
import type { SessionToolContext } from '../../context.ts'

/** The workspace root; the project lives at `<workspace>/projects/p1`. */
let workspace = ''
let project = ''

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'craft-reel-tool-'))
  project = join(workspace, 'projects', 'p1')
  mkdirSync(project, { recursive: true })
  // A conversation is bound to a project by **id**, and the workspace registry is what resolves it;
  // a `config.json` sitting in a folder is not a binding (see `projectFolderOf`).
  writeFileSync(
    join(project, 'config.json'),
    JSON.stringify({ id: 'p1', slug: 'p1', name: '项目', createdAt: 0, updatedAt: 0 }),
  )
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

const ctx = (workingDirectory: string | undefined) =>
  ({
    sessionId: 's1',
    workspacePath: workspace,
    workingDirectory,
    getSessionInfo: () => ({ projectId: 'p1', workingDirectory }),
  }) as unknown as SessionToolContext

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((part) => part.text ?? '').join('\n')

describe('reel_tool outside a project', () => {
  let room = ''

  beforeEach(() => {
    room = mkdtempSync(join(tmpdir(), 'craft-reel-room-'))
  })

  afterEach(() => rmSync(room, { recursive: true, force: true }))

  test('refuses to create a cut: cuts belong to a project', async () => {
    const result = await handleReelTool(
      { sessionId: 's2', workspacePath: room, workingDirectory: room } as unknown as SessionToolContext,
      { command: 'create --name 预告' },
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('需要一个项目')
    expect(existsSync(join(room, 'sessions', 's2', 'reels', '预告.reel'))).toBe(false)
  })
})

describe('reel_tool help', () => {
  test('the short reference points at `help all`, which carries every op shape', async () => {
    const short = textOf(await handleReelTool(ctx(project), { command: 'help' }))
    expect(short).toContain('help all')
    expect(short).toContain('settings.frameRate')
    expect(short).not.toContain('"op": "add_track"')

    const full = textOf(await handleReelTool(ctx(project), { command: 'help all' }))
    expect(full).toContain('"op": "add_track"')
    expect(full).toContain('"op": "set_transition"')
  })

  test('an unknown command names itself and shows the short reference', async () => {
    const result = textOf(await handleReelTool(ctx(project), { command: 'nonsense' }))
    expect(result).toContain('Unknown command "nonsense"')
    expect(result).toContain('help all')
  })
})

describe('reel_tool create', () => {
  test('creates a cut at reels/<name>.reel with the settings the caller chose', async () => {
    const result = await handleReelTool(ctx(project), { command: 'create --name 预告 --fps 24' })
    expect(result.isError).toBeFalsy()

    const path = join(project, 'reels', '预告.reel')
    expect(existsSync(path)).toBe(true)
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      revision: number
      name: string
      settings: { width: number; height: number; frameRate: number }
      tracks: Array<{ id: string; kind: string; clips: unknown[] }>
    }
    expect(doc.revision).toBe(0)
    expect(doc.name).toBe('预告')
    expect(doc.settings).toEqual({ width: 1920, height: 1080, frameRate: 24 })
    expect(doc.tracks).toEqual([{ id: 'video-1', kind: 'video', clips: [] }])
  })

  test('takes an explicit file and size, for a vertical cut', async () => {
    const result = await handleReelTool(ctx(project), {
      command: 'create --file drafts/竖屏.reel --width 1080 --height 1920 --name 竖屏',
    })
    expect(result.isError).toBeFalsy()

    const doc = JSON.parse(readFileSync(join(project, 'drafts/竖屏.reel'), 'utf8'))
    expect(doc.name).toBe('竖屏')
    expect(doc.settings).toEqual({ width: 1080, height: 1920, frameRate: 30 })
  })

  test('refuses to overwrite a cut that is already there', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const again = await handleReelTool(ctx(project), { command: 'create --name 预告' })
    expect(again.isError).toBe(true)
    expect(textOf(again)).toContain('already exists')
  })

  test('a created cut is the one state applies to, and a clip lands in it', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]',
      ],
    })
    expect(applied.isError).toBeFalsy()

    const state = await handleReelTool(ctx(project), { command: 'state --json' })
    const doc = JSON.parse(textOf(state))
    expect(doc.revision).toBe(1)
    expect(doc.tracks[0].clips).toHaveLength(1)
    expect(doc.tracks[0].clips[0].src).toBe('assets/a.mp4')

    const list = await handleReelTool(ctx(project), { command: 'list' })
    expect(textOf(list)).toContain('rev 1')
  })

  test('adds a sound track and places a clip on it by id', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_track","kind":"audio"},{"op":"add_clip","src":"assets/music.mp3","duration":5,"trackId":"audio-1"}]',
      ],
    })
    expect(applied.isError).toBeFalsy()

    const state = await handleReelTool(ctx(project), { command: 'state --json' })
    const doc = JSON.parse(textOf(state))
    const audio = doc.tracks.find((track: { id: string }) => track.id === 'audio-1')
    expect(audio.kind).toBe('audio')
    expect(audio.clips[0].src).toBe('assets/music.mp3')
    // The picture track is untouched by a sound clip.
    expect(doc.tracks[0].clips).toEqual([])
  })

  test('refuses a clip aimed at a track that does not exist', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":2,"trackId":"nope"}]'],
    })
    expect(applied.isError).toBe(true)
    expect(textOf(applied)).toContain('no track nope')
  })

  test('adds a subtitle, edits it, then removes it — the agent edits the same overlays the panel shows', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"kind":"text","text":"第一句","start":0,"duration":2,"preset":"subtitle"}}]',
      ],
    })
    expect(added.isError).toBeFalsy()

    const state = await handleReelTool(ctx(project), { command: 'state --json' })
    const doc = JSON.parse(textOf(state))
    expect(doc.overlays).toHaveLength(1)
    expect(doc.overlays[0].text).toBe('第一句')
    expect(doc.overlays[0].preset).toBe('subtitle')
    const overlayId = doc.overlays[0].id

    const changed = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"update_overlay","id":"${overlayId}","change":{"text":"改过的","start":1}}]`,
      ],
    })
    expect(changed.isError).toBeFalsy()
    const after = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(after.overlays[0].text).toBe('改过的')
    expect(after.overlays[0].start).toBe(1)

    const removed = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"remove_overlay","id":"${overlayId}"}]`],
    })
    expect(removed.isError).toBeFalsy()
    const empty = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(empty.overlays).toEqual([])
  })

  test('adds a picture-in-picture overlay with its own box', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"kind":"media","src":"assets/face.mp4","start":1,"duration":3,"box":{"x":0.7,"y":0.1,"w":0.2,"h":0.2}}}]',
      ],
    })
    expect(added.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays[0]).toMatchObject({
      kind: 'media',
      src: 'assets/face.mp4',
      start: 1,
      duration: 3,
      box: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 },
    })
  })

  test('an .srt from speech recognition lands on the subtitle track, and comes back out as SRT', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    writeFileSync(
      join(project, 'voice.srt'),
      '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,000 --> 00:00:05,500\n第二句\n',
    )

    const added = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_subtitles","path":"voice.srt"}]'],
    })
    expect(added.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays).toHaveLength(2)
    expect(doc.overlays[0]).toMatchObject({
      kind: 'text',
      preset: 'subtitle',
      text: '第一句',
      start: 1,
      duration: 2,
    })
    expect(doc.overlays[1]).toMatchObject({ text: '第二句', start: 4, duration: 1.5 })

    const printed = await handleReelTool(ctx(project), { command: 'subtitles' })
    expect(printed.isError).toBeFalsy()
    expect(textOf(printed)).toContain('1\n00:00:01,000 --> 00:00:03,000\n第一句')

    const written = await handleReelTool(ctx(project), { command: 'subtitles --out subs/预告.srt' })
    expect(written.isError).toBeFalsy()
    const srt = readFileSync(join(project, 'subs', '预告.srt'), 'utf8')
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:05,500\n第二句')

    // SRT is the one envelope; WebVTT is refused rather than written under a name that lies.
    const vtt = await handleReelTool(ctx(project), { command: 'subtitles --format vtt' })
    expect(vtt.isError).toBe(true)
    expect(textOf(vtt)).toContain('SRT')

    const named = await handleReelTool(ctx(project), { command: 'subtitles --out subs/预告.vtt' })
    expect(named.isError).toBe(true)
    expect(textOf(named)).toContain('.srt')
  })

  test('cues from a JSON transcript take a preset, a style and a paint order', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_subtitles","cues":[{"start":0,"end":2,"text":"你好"}],"style":{"fontSize":54},"z":10}]',
      ],
    })
    expect(added.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays[0]).toMatchObject({
      kind: 'text',
      preset: 'subtitle',
      text: '你好',
      style: { fontSize: 54 },
      z: 10,
    })
  })

  test('a file with no cues is refused, and nothing is written', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const refused = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_subtitles","srt":"这不是字幕"}]'],
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('found no cues')

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.revision).toBe(0)
    expect(doc.overlays).toEqual([])
  })

  test('every clip has its own sound, and a video can give it to an audio clip', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4,"volume":0.8}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id
    expect(doc.tracks[0].clips[0].volume).toBe(0.8)

    const muted = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio","id":"${clipId}","muted":true}]`],
    })
    expect(muted.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].muted).toBe(true)

    const detached = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"detach_audio","id":"${clipId}"}]`],
    })
    expect(detached.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const audio = doc.tracks.find((track: { kind: string }) => track.kind === 'audio')
    expect(audio.clips).toHaveLength(1)
    expect(audio.clips[0]).toMatchObject({ src: 'assets/a.mp4', start: 0, in: 0, duration: 4, volume: 0.8 })

    // Detaching again would double the sound, so it is refused.
    const again = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"detach_audio","id":"${clipId}"}]`],
    })
    expect(again.isError).toBe(true)
    expect(textOf(again)).toContain('already')
  })

  test('a picture-in-picture can be given sound; a text overlay cannot', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"kind":"media","src":"assets/face.mp4","start":0,"duration":3}}]',
      ],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const overlayId = doc.overlays[0].id

    const sound = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio","id":"${overlayId}","volume":0.5,"muted":false}]`],
    })
    expect(sound.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays[0]).toMatchObject({ volume: 0.5, muted: false })

    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"kind":"text","text":"你好","start":0,"duration":2}}]',
      ],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const textId = doc.overlays[1].id
    const refused = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio","id":"${textId}","muted":true}]`],
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('has no sound')
  })

  test('fades and track mute/solo are the same controls the panel shows', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const faded = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_fade","id":"${clipId}","fadeIn":0.5,"fadeOut":0.8}]`],
    })
    expect(faded.isError).toBeFalsy()

    const quiet = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"set_track_audio","trackId":"video-1","muted":true}]'],
    })
    expect(quiet.isError).toBeFalsy()

    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].fade).toEqual({ fadeIn: 0.5, fadeOut: 0.8 })
    expect(doc.tracks[0].muted).toBe(true)

    const state = textOf(await handleReelTool(ctx(project), { command: 'state' }))
    expect(state).toContain('· muted')
    expect(state).toContain('fade 0.50/0.80s')

    const negative = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_fade","id":"${clipId}","fadeIn":-1}]`],
    })
    expect(negative.isError).toBe(true)
    expect(textOf(negative)).toContain('>= 0')
  })

  test('volume keyframes — how ducking is stored — are writable by the agent', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/bgm.mp3","duration":5}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const keyed = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_automation","id":"${clipId}","points":[{"time":0,"value":1},{"time":2,"value":0.4}]}]`,
      ],
    })
    expect(keyed.isError).toBeFalsy()

    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].automation).toEqual([
      { time: 0, value: 1 },
      { time: 2, value: 0.4 },
    ])
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('2 keyframes')

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"clear_ducking","id":"${clipId}"}]`],
    })
    expect(cleared.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].automation).toBeUndefined()
  })

  test('transform and clip operations are writable by the agent', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const transformed = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_transform","id":"${clipId}","x":0.1,"scale":1.2,"opacity":0.8}]`,
      ],
    })
    expect(transformed.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].transform).toEqual({ x: 0.1, y: 0, scale: 1.2, rotation: 0, radius: 0 })
    expect(doc.tracks[0].clips[0].opacity).toBe(0.8)

    const duplicated = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"duplicate_clip","id":"${clipId}"}]`],
    })
    expect(duplicated.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips).toHaveLength(2)

    // The first clip goes; the copy that sat after it moves to the start.
    const rippled = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"ripple_delete","id":"${clipId}"}]`],
    })
    expect(rippled.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips).toHaveLength(1)
    expect(doc.tracks[0].clips[0].start).toBe(0)
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('transform')
  })

  test('a transition needs an adjacent predecessor, and is written on the incoming clip', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/b.mp4","duration":3}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const secondId = doc.tracks[0].clips[1].id
    expect(doc.tracks[0].clips[1].start).toBe(4)

    const set = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_transition","id":"${secondId}","kind":"crossfade","duration":1}]`,
      ],
    })
    expect(set.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[1].transition).toEqual({ kind: 'crossfade', duration: 1 })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· transition')

    // Centred on the cut, so it may not outrun the shorter neighbour (3s here); the reply says so.
    const clamped = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_transition","id":"${secondId}","kind":"crossfade","duration":10}]`,
      ],
    })
    expect(clamped.isError).toBeFalsy()
    expect(textOf(clamped)).toContain('Note:')
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[1].transition).toEqual({ kind: 'crossfade', duration: 3 })

    // A clip at 20s has nothing right before it.
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/c.mp4","duration":2,"start":20}]'],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const loneId = doc.tracks[0].clips[2].id
    const refused = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_transition","id":"${loneId}","kind":"dip-black","duration":0.5}]`,
      ],
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('adjacent')
  })

  test('tracks can be named, hidden, locked and reordered — and a lock refuses clip edits', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const named = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"set_track","trackId":"video-1","name":"主画面","hidden":true}]',
      ],
    })
    expect(named.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].name).toBe('主画面')
    expect(doc.tracks[0].hidden).toBe(true)
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· hidden')

    // A second track, then the newer one is raised above the first.
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_track","kind":"video"}]'],
    })
    const moved = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"move_track","trackId":"video-2","index":0}]'],
    })
    expect(moved.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks.map((track: { id: string }) => track.id)).toEqual(['video-2', 'video-1'])

    // Locking video-1 refuses a clip edit on it, and unlocking restores the write.
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"set_track","trackId":"video-1","locked":true}]'],
    })
    const blocked = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_audio","id":"${clipId}","volume":0.5}]`,
      ],
    })
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('locked')

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"set_track","trackId":"video-1","locked":false}]'],
    })
    const allowed = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio","id":"${clipId}","volume":0.5}]`],
    })
    expect(allowed.isError).toBeFalsy()
  })

  test('a track can be removed with its clips, but the cut keeps a video track', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_track","kind":"video"}]'],
    })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/b.mp4","duration":2,"trackId":"video-2"}]',
      ],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks).toHaveLength(2)

    const removed = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"remove_track","trackId":"video-2"}]'],
    })
    expect(removed.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks.map((track: { id: string }) => track.id)).toEqual(['video-1'])
    expect(doc.tracks[0].clips).toHaveLength(1)

    // The picture must have somewhere to live: the last video track is refused.
    const last = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"remove_track","trackId":"video-1"}]'],
    })
    expect(last.isError).toBe(true)
    expect(textOf(last)).toContain('only video track')
  })

  test('cut_at cuts every track at a beat grid in one write', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })

    const cut = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"cut_at","times":[1,2,3,3.02]}]'],
    })
    expect(cut.isError).toBeFalsy()
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips.map((clip: { start: number }) => clip.start)).toEqual([0, 1, 2, 3])

    // A grid that lands on no clip is refused instead of writing nothing.
    const empty = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"cut_at","times":[99]}]'],
    })
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toContain('no clip')
  })

  test('a colour grade is writable, shown in state, and can be cleared', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const graded = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_effect","id":"${clipId}","preset":"mono"}]`],
    })
    expect(graded.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].effect).toEqual({ preset: 'mono' })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· effect')

    // A value on top of the preset pins that number; the preset still names the look.
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_effect","id":"${clipId}","brightness":1.2}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].effect.brightness).toBeCloseTo(1.2)
    expect(doc.tracks[0].clips[0].effect.preset).toBe('mono')

    // An unknown preset is refused rather than silently ignored.
    const unknown = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_effect","id":"${clipId}","preset":"wobble"}]`],
    })
    expect(unknown.isError).toBe(true)

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_effect","id":"${clipId}","clear":true}]`],
    })
    expect(cleared.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].effect).toBeUndefined()
  })

  test('fcpxml prints or writes the timeline for another editor', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })

    const printed = await handleReelTool(ctx(project), { command: 'fcpxml' })
    expect(printed.isError).toBeFalsy()
    expect(textOf(printed)).toContain('<fcpxml version="1.9">')
    // Sources are absolute, because the file is read outside the project.
    expect(textOf(printed)).toContain('file:///')

    const written = await handleReelTool(ctx(project), { command: 'fcpxml --out exports/cut.fcpxml' })
    expect(written.isError).toBeFalsy()
    expect(existsSync(join(project, 'exports', 'cut.fcpxml'))).toBe(true)
  })

  test('a clip tone merges, shows in state, and clears', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const toned = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_audio_effect","id":"${clipId}","highpass":120,"compress":true}]`,
      ],
    })
    expect(toned.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].audioEffect).toEqual({ highpass: 120, compress: true })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· tone')

    // A second write merges instead of replacing the first.
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio_effect","id":"${clipId}","bass":-3.5}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].audioEffect).toEqual({
      highpass: 120,
      compress: true,
      bass: -3.5,
    })

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio_effect","id":"${clipId}","clear":true}]`],
    })
    expect(cleared.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].audioEffect).toBeUndefined()
  })

  test('speed is writable, keeps the source window and ripples by default', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/a.mp4","duration":4},{"op":"add_clip","src":"assets/b.mp4","duration":2}]',
      ],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const fast = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${clipId}","speed":2}]`],
    })
    expect(fast.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    // The source window is kept, so the timeline piece halves.
    expect(doc.tracks[0].clips[0].speed).toBe(2)
    expect(doc.tracks[0].clips[0].duration).toBe(2)
    // The rest of the track follows, so the packed cut stays packed.
    expect(doc.tracks[0].clips[1].start).toBe(2)
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· 2x')

    const alone = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${clipId}","speed":4,"ripple":false}]`],
    })
    expect(alone.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].duration).toBe(1)
    expect(doc.tracks[0].clips[1].start).toBe(2)

    const invalid = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${clipId}","speed":0}]`],
    })
    expect(invalid.isError).toBe(true)
  })

  test('speed is refused on a still and on a held frame', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/poster.png","duration":2},{"op":"add_clip","src":"assets/a.mp4","duration":4}]',
      ],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const stillId = doc.tracks[0].clips[0].id as string
    const clipId = doc.tracks[0].clips[1].id as string

    const still = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${stillId}","speed":2}]`],
    })
    expect(still.isError).toBe(true)
    expect(textOf(still)).toContain('still')

    const frozen = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"freeze_frame","id":"${clipId}","at":3,"duration":1}]`],
    })
    expect(frozen.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const hold = doc.tracks[0].clips.find((clip: { freeze?: boolean }) => clip.freeze)
    const held = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${hold.id}","speed":2}]`],
    })
    expect(held.isError).toBe(true)
    expect(textOf(held)).toContain('held frame')
  })
})

describe('reel_tool trim_clip edges', () => {
  afterEach(() => setReelProbe(null))

  const cut = async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    return doc.tracks[0].clips[0].id as string
  }

  test('head/tail are timeline seconds and respect speed', async () => {
    const id = await cut()
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${id}","speed":2}]`],
    })
    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","head":0.5,"tail":0.2}]`],
    })
    expect(applied.isError).toBeFalsy()
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clip = doc.tracks[0].clips[0]
    expect(clip.start).toBeCloseTo(0.5)
    // Half a timeline second of a 2x piece is one source second.
    expect(clip.in).toBeCloseTo(1)
    expect(clip.duration).toBeCloseTo(1.3)
  })

  test('refuses to mix edges with the raw window, or to trim the piece away', async () => {
    const id = await cut()
    const mixed = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","head":1,"in":2}]`],
    })
    expect(mixed.isError).toBe(true)
    expect(textOf(mixed)).toContain('not both')

    const whole = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","head":2,"tail":2}]`],
    })
    expect(whole.isError).toBe(true)
    expect(textOf(whole)).toContain('shorter than')
  })

  test('refuses a window that runs past the source', async () => {
    const id = await cut()
    setReelProbe(async (paths) => paths.map((path) => ({ path, duration: 4 })))

    const over = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","in":2,"duration":3}]`],
    })
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain('past the source')
    expect(textOf(over)).toContain('4.00s')

    const fits = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","in":1,"duration":3}]`],
    })
    expect(fits.isError).toBeFalsy()
  })

  test('counts speed when measuring the window', async () => {
    const id = await cut()
    setReelProbe(async (paths) => paths.map((path) => ({ path, duration: 4 })))
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_speed","id":"${id}","speed":2}]`],
    })

    // 1s in + 2s × 2 = 5s of material, but the file is 4s.
    const over = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","in":1,"duration":2}]`],
    })
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain('× 2x')

    const fits = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"trim_clip","id":"${id}","in":1,"duration":1.5}]`],
    })
    expect(fits.isError).toBeFalsy()
  })
})

describe('reel_tool probe', () => {
  afterEach(() => setReelProbe(null))

  test('reads duration, shape and frame count from the host', async () => {
    setReelProbe(async (paths) =>
      paths.map((path) => ({
        path,
        duration: 12.5,
        width: 1920,
        height: 1080,
        fps: 29.97,
        frameCount: 375,
        codec: 'avc',
        hasAudio: true,
      })),
    )

    const result = await handleReelTool(ctx(project), { command: 'probe --src assets/a.mp4' })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('12.500s')
    expect(textOf(result)).toContain('1920×1080')
    expect(textOf(result)).toContain('29.970fps')
    expect(textOf(result)).toContain('375 frames')
    expect(textOf(result)).toContain('avc')
  })

  test('refuses in words on a host with no probe, and calls images stills', async () => {
    const missing = await handleReelTool(ctx(project), { command: 'probe --src assets/a.mp4' })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('探测器')

    const still = await handleReelTool(ctx(project), { command: 'probe --src assets/poster.png' })
    expect(still.isError).toBeFalsy()
    expect(textOf(still)).toContain('still image')
  })
})

describe('reel_tool subtitle batches', () => {
  const withSubtitles = async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          {
            op: 'add_subtitles',
            cues: [
              { start: 0, end: 2, text: '第一句' },
              { start: 2, end: 4, text: '第二句 AI' },
            ],
          },
          {
            op: 'add_overlay',
            overlay: { kind: 'text', text: '标题', start: 0, duration: 2, preset: 'title' },
          },
        ]),
      ],
    })
  }

  test('shift and replace move dialogue, never the title', async () => {
    await withSubtitles()
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          { op: 'shift_subtitles', by: 0.5 },
          { op: 'replace_subtitle_text', find: 'ai', replace: '人工智能' },
        ]),
      ],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays[0].start).toBe(0.5)
    expect(doc.overlays[1].start).toBe(2.5)
    expect(doc.overlays[1].text).toBe('第二句 人工智能')
    expect(doc.overlays[2].start).toBe(0)
    expect(doc.overlays[2].text).toBe('标题')
  })

  test('clear_subtitles removes the old transcript in range, then entirely — a retake in two ops', async () => {
    await withSubtitles()

    const ranged = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"clear_subtitles","from":2}]'],
    })
    expect(ranged.isError).toBeFalsy()
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays.map((overlay: { text: string }) => overlay.text)).toEqual(['第一句', '标题'])

    const rest = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"clear_subtitles"}]'],
    })
    expect(rest.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays.map((overlay: { text: string }) => overlay.text)).toEqual(['标题'])

    // Nothing left to clear is refused instead of writing an empty batch.
    const empty = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"clear_subtitles"}]'],
    })
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toContain('no subtitle overlays')
  })

  test('dedupe keeps the longer copy and style applies to every subtitle', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          {
            op: 'add_subtitles',
            cues: [
              { start: 1, end: 2, text: '重复' },
              { start: 1.01, end: 1.41, text: '重复' },
            ],
          },
          {
            op: 'add_overlay',
            overlay: { kind: 'text', text: '标题', start: 0, duration: 2, preset: 'title' },
          },
        ]),
      ],
    })

    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          { op: 'dedupe_subtitles', window: 0.05 },
          { op: 'style_subtitles', style: { fontSize: 60, color: '#ffe066' } },
        ]),
      ],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const subtitles = doc.overlays.filter((overlay: { preset?: string }) => overlay.preset === 'subtitle')
    expect(subtitles).toHaveLength(1)
    expect(subtitles[0].duration).toBe(1)
    expect(subtitles[0].style.fontSize).toBe(60)
    const title = doc.overlays.find((overlay: { text?: string }) => overlay.text === '标题')
    expect(title.style).toBeUndefined()
  })

  test('a template supplies the look, and an unknown id is refused', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"template":"impact","text":"第 1 集","start":0,"duration":2}}]',
      ],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays[0].text).toBe('第 1 集')
    expect(doc.overlays[0].style.fontSize).toBe(120)
    expect(doc.overlays[0].animation.preset).toBe('scale')

    const bad = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"template":"nope","start":0,"duration":2}}]',
      ],
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('unknown text template')
  })
})

describe('reel_tool composition size', () => {
  test('set_settings scales typography, and rescale:false changes the canvas alone', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"kind":"text","text":"字","start":0,"duration":2,"style":{"fontSize":46}}}]',
      ],
    })

    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"set_settings","width":1080,"height":1920}]'],
    })
    expect(applied.isError).toBeFalsy()
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.settings).toEqual({ width: 1080, height: 1920, frameRate: 30 })
    // 1920 / 1080 by the height, so the words keep their share of the frame.
    expect(doc.overlays[0].style.fontSize).toBeCloseTo(81.8)

    const alone = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"set_settings","width":1920,"height":1080,"rescale":false}]',
      ],
    })
    expect(alone.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.settings.width).toBe(1920)
    expect(doc.overlays[0].style.fontSize).toBeCloseTo(81.8)
  })
})

describe('frame-accurate batches', () => {
  test('clip times snap to the grid, and a frame-rate change re-grids them', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/a.mp4","duration":1.13,"start":0.17,"in":0.11}]',
      ],
    })

    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].start).toBeCloseTo(5 / 30)
    expect(doc.tracks[0].clips[0].in).toBeCloseTo(0.11)
    expect(doc.tracks[0].clips[0].duration).toBeCloseTo(34 / 30)

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"set_settings","frameRate":24}]'],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].duration).toBeCloseTo(27 / 24)
    expect(doc.tracks[0].clips[0].in).toBeCloseTo(0.11)
  })
})

describe('reel_tool snapshot', () => {
  afterEach(() => setReelSnapshot(null))

  test('refuses in words on a host with no renderer', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const result = await handleReelTool(ctx(project), { command: 'snapshot --at 1' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('渲染器')
  })

  test('asks the host for the frame and answers where it landed', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })

    const asked: { at?: number; outPath?: string; src?: string; maxEdge?: number } = {}
    setReelSnapshot(async (input) => {
      asked.at = input.at
      asked.outPath = input.outPath
      asked.src = input.pathOf('assets/a.mp4')
      asked.maxEdge = input.maxEdge
      return { ok: true, path: input.outPath, width: 960, height: 540 }
    })

    const result = await handleReelTool(ctx(project), { command: 'snapshot --at 1.5 --max-edge 960' })
    expect(result.isError).toBeFalsy()
    expect(asked.at).toBe(1.5)
    expect(asked.maxEdge).toBe(960)
    expect(asked.src?.endsWith('a.mp4')).toBe(true)
    // The frame lands beside the cut by default, named for the moment.
    expect(asked.outPath).toBe(join(project, 'reels', 'frames', '预告-1.500.jpg'))
    expect(textOf(result)).toContain(asked.outPath!)
    expect(textOf(result)).toContain('960×540')
  })

  test('refuses a moment past the end instead of drawing a black frame', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    setReelSnapshot(async (input) => ({ ok: true, path: input.outPath, width: 960, height: 540 }))

    const result = await handleReelTool(ctx(project), { command: 'snapshot --at 9' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('4.00s long')
  })

  test('--clip --edge names the boundary frame and the source second it drew', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const id = doc.tracks[0].clips[0].id as string
    const asked: number[] = []
    setReelSnapshot(async (input) => {
      asked.push(input.at)
      return { ok: true, path: input.outPath, width: 960, height: 540 }
    })

    const first = await handleReelTool(ctx(project), {
      command: ['snapshot', '--clip', id, '--edge', 'first'],
    })
    expect(first.isError).toBeFalsy()
    expect(textOf(first)).toContain('first frame')
    expect(textOf(first)).toContain('source 0.000s')
    expect(asked[0]).toBe(0)

    const last = await handleReelTool(ctx(project), {
      command: ['snapshot', '--clip', id, '--edge', 'last'],
    })
    expect(last.isError).toBeFalsy()
    expect(textOf(last)).toContain('last frame')
    // Sampled just inside the piece, so the decoder's last frame is the one drawn.
    expect(asked[1]).toBeCloseTo(3.999, 3)
    expect(textOf(last)).toContain(join(project, 'reels', 'frames', `预告-${id}-last.jpg`))
  })

  test('--edge needs --clip, and --clip does not mix with --at', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    setReelSnapshot(async (input) => ({ ok: true, path: input.outPath, width: 960, height: 540 }))

    const orphan = await handleReelTool(ctx(project), { command: 'snapshot --edge last' })
    expect(orphan.isError).toBe(true)
    expect(textOf(orphan)).toContain('--edge needs --clip')

    const both = await handleReelTool(ctx(project), { command: 'snapshot --at 1 --clip clip-x' })
    expect(both.isError).toBe(true)
    expect(textOf(both)).toContain('not both')
  })
})

describe('reel_tool export', () => {
  afterEach(() => setReelExportHost(null))

  const cut = async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
  }

  const job = (overrides: Partial<ReelExportJob> = {}): ReelExportJob => ({
    id: 'export-1',
    sessionId: 's1',
    name: '预告',
    outPath: join(project, 'reels', 'exports', '预告-x.mp4'),
    container: 'mp4',
    audioOnly: false,
    status: 'running',
    startedAt: Date.now(),
    ...overrides,
  })

  test('refuses in words on a host with no encoder', async () => {
    await cut()
    const result = await handleReelTool(ctx(project), { command: 'export' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('渲染器')
  })

  test('starts a job and answers at once, without waiting for the file', async () => {
    await cut()
    const asked: { outPath?: string; container?: string; audioOnly?: boolean; src?: string; sessionId?: string } = {}
    setReelExportHost({
      start: (input) => {
        asked.outPath = input.outPath
        asked.container = input.container
        asked.audioOnly = input.audioOnly
        asked.src = input.pathOf('assets/a.mp4')
        asked.sessionId = input.sessionId
        return job({ outPath: input.outPath, container: input.container, name: input.name })
      },
      status: () => null,
      list: () => [],
      cancel: () => false,
    })

    const result = await handleReelTool(ctx(project), { command: 'export' })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Rendering started')
    expect(textOf(result)).toContain('export-1')
    expect(asked.sessionId).toBe('s1')
    expect(asked.container).toBe('mp4')
    expect(asked.audioOnly).toBeUndefined()
    expect(asked.outPath?.startsWith(join(project, 'reels', 'exports'))).toBe(true)
    expect(asked.outPath?.endsWith('.mp4')).toBe(true)
    expect(asked.src?.endsWith('a.mp4')).toBe(true)
  })

  test('the name decides the container when none is stated', async () => {
    await cut()
    const asked: { outPath?: string; container?: string; audioOnly?: boolean } = {}
    setReelExportHost({
      start: (input) => {
        asked.outPath = input.outPath
        asked.container = input.container
        asked.audioOnly = input.audioOnly
        return job({ outPath: input.outPath, container: input.container })
      },
      status: () => null,
      list: () => [],
      cancel: () => false,
    })

    await handleReelTool(ctx(project), { command: 'export --out drafts/clip.webm' })
    expect(asked.container).toBe('webm')
    expect(asked.outPath).toBe(join(project, 'drafts', 'clip.webm'))

    // MP3 is sound only, whatever the flags say.
    await handleReelTool(ctx(project), { command: 'export --out drafts/voice.mp3' })
    expect(asked.container).toBe('mp3')
    expect(asked.audioOnly).toBe(true)

    // Naming the file `.m4a` means the sound-only render, and a WebM container cannot be `.m4a`.
    await handleReelTool(ctx(project), { command: 'export --out drafts/voice.m4a' })
    expect(asked.container).toBe('mp4')
    expect(asked.audioOnly).toBe(true)

    await handleReelTool(ctx(project), { command: 'export --audio-only --container webm' })
    expect(asked.container).toBe('mp4')
    expect(asked.audioOnly).toBe(true)
    expect(asked.outPath?.endsWith('.m4a')).toBe(true)
  })

  test('--status answers for one job, and lists the conversation’s jobs without an id', async () => {
    const finished = job({ status: 'completed', duration: 4 })
    setReelExportHost({
      start: () => job(),
      status: (id) => (id === 'export-1' ? finished : null),
      list: () => [finished],
      cancel: () => false,
    })

    const one = await handleReelTool(ctx(project), { command: 'export --status export-1' })
    expect(one.isError).toBeFalsy()
    expect(textOf(one)).toContain('completed')
    expect(textOf(one)).toContain(finished.outPath)
    expect(textOf(one)).toContain('4.0s of timeline')

    const all = await handleReelTool(ctx(project), { command: 'export --status' })
    expect(textOf(all)).toContain('export-1')

    const missing = await handleReelTool(ctx(project), { command: 'export --status export-9' })
    expect(missing.isError).toBe(true)

    // A job id from another conversation is not this conversation's to read.
    setReelExportHost({
      start: () => job(),
      status: () => job({ sessionId: 's-other' }),
      list: () => [],
      cancel: () => false,
    })
    const foreign = await handleReelTool(ctx(project), { command: 'export --status export-1' })
    expect(foreign.isError).toBe(true)
  })

  test('--status reports a cancelled job as cancelled, not failed', async () => {
    setReelExportHost({
      start: () => job(),
      status: () => job({ status: 'cancelled' }),
      list: () => [],
      cancel: () => false,
    })
    const result = await handleReelTool(ctx(project), { command: 'export --status export-1' })
    expect(textOf(result)).toContain('cancelled')
    expect(textOf(result)).toContain('no file was kept')
  })

  test('--cancel stops a running job, and refuses one that already ended', async () => {
    const cancelled: string[] = []
    setReelExportHost({
      start: () => job(),
      status: (id) => (id === 'export-1' ? job() : job({ id: 'export-2', status: 'completed' })),
      list: () => [],
      cancel: (id) => {
        cancelled.push(id)
        return true
      },
    })

    const stopped = await handleReelTool(ctx(project), { command: 'export --cancel export-1' })
    expect(stopped.isError).toBeFalsy()
    expect(textOf(stopped)).toContain('Cancelling export-1')
    expect(cancelled).toEqual(['export-1'])

    const done = await handleReelTool(ctx(project), { command: 'export --cancel export-2' })
    expect(done.isError).toBe(true)
    expect(textOf(done)).toContain('already completed')
    // A finished job is never handed to the host to stop.
    expect(cancelled).toEqual(['export-1'])
  })

  test('--cancel needs an id', async () => {
    setReelExportHost({
      start: () => job(),
      status: () => null,
      list: () => [],
      cancel: () => false,
    })
    const result = await handleReelTool(ctx(project), { command: 'export --cancel' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('needs a job id')
  })

  test('--status reports how far a running encode has got', async () => {
    setReelExportHost({
      start: () => job(),
      status: () => job({ progress: 0.43 }),
      list: () => [],
      cancel: () => false,
    })
    const result = await handleReelTool(ctx(project), { command: 'export --status export-1' })
    expect(textOf(result)).toContain('43%')
  })

  test('a finished job wakes the conversation through the notifier', async () => {
    await cut()
    let finish: ((settled: ReelExportJob) => void) | undefined
    setReelExportHost({
      start: (input) => {
        finish = input.onFinished
        return job({ outPath: input.outPath })
      },
      status: () => null,
      list: () => [],
      cancel: () => false,
    })

    const notified: string[] = []
    const waking = {
      ...(ctx(project) as unknown as Record<string, unknown>),
      notifyBackgroundResult: (message: string) => notified.push(message),
    } as unknown as SessionToolContext

    await handleReelTool(waking, { command: 'export' })
    expect(finish).toBeDefined()
    finish!(job({ status: 'completed', duration: 4 }))

    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('clip-export-completed')
    expect(notified[0]).toContain(job().outPath)
    expect(notified[0]).toContain('4.0s of timeline')

    // A failure wakes it too, and says the cut is untouched.
    finish!(job({ status: 'failed', message: 'encoder died' }))
    expect(notified[1]).toContain('clip-export-failed')
    expect(notified[1]).toContain('encoder died')
  })
})

describe('reel_tool add_clip without a stated duration', () => {
  afterEach(() => setReelProbe(null))

  test('the host reads it from the container, once for the whole batch', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const asked: string[][] = []
    setReelProbe(async (paths) => {
      asked.push(paths)
      return paths.map((path) => ({ path, duration: 3.5 }))
    })

    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/a.mp4"},{"op":"add_clip","src":"assets/a.mp4","start":4}]',
      ],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips.map((clip: { duration: number }) => clip.duration)).toEqual([3.5, 3.5])
    // One probe, one entry per distinct source.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toHaveLength(1)
    expect(asked[0]![0]!.endsWith('a.mp4')).toBe(true)
  })

  test('says why a source could not be read', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    setReelProbe(async (paths) =>
      paths.map((path) => ({ path, duration: null, message: 'no container header' })),
    )

    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/broken.mov"}]'],
    })
    expect(applied.isError).toBe(true)
    expect(textOf(applied)).toContain('could not read how long')
    expect(textOf(applied)).toContain('no container header')
  })

  test('an omitted duration is the rest of the file after in', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    setReelProbe(async (paths) => paths.map((path) => ({ path, duration: 4 })))

    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","in":1}]'],
    })
    expect(applied.isError).toBeFalsy()
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].in).toBe(1)
    expect(doc.tracks[0].clips[0].duration).toBe(3)
  })

  test('refuses a window past the source, and a non-numeric in or start', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    setReelProbe(async (paths) => paths.map((path) => ({ path, duration: 4 })))

    const over = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":5}]'],
    })
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain('past the source')

    const badIn = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":2,"in":"oops"}]'],
    })
    expect(badIn.isError).toBe(true)
    expect(textOf(badIn)).toContain('in must be')

    const badStart = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":2,"start":"oops"}]'],
    })
    expect(badStart.isError).toBe(true)
    expect(textOf(badStart)).toContain('start must be')
  })
})

describe('reel_tool placement keyframes', () => {
  const withClip = async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    return doc.tracks[0].clips[0].id as string
  }

  test('writes, reports and clears them', async () => {
    const id = await withClip()
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_keyframes","id":"${id}","keyframes":[` +
          '{"time":0,"transform":{"scale":1}},' +
          '{"time":2.5,"transform":{"scale":1.4,"x":0.2},"opacity":0.5}]}]',
      ],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const frames = doc.tracks[0].clips[0].keyframes as Array<{
      time: number
      transform: { scale: number }
      opacity?: number
    }>
    expect(frames.map((frame) => frame.time)).toEqual([0, 2.5])
    expect(frames[1]!.transform.scale).toBe(1.4)
    expect(frames[1]!.opacity).toBe(0.5)
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain(
      'placement keyframes',
    )

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"clear_keyframes","id":"${id}"}]`],
    })
    expect(cleared.isError).toBeFalsy()
    const after = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(after.tracks[0].clips[0].keyframes).toBeUndefined()
  })

  test('stores easing on the arriving keyframe and refuses an unknown curve', async () => {
    const id = await withClip()
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_keyframes","id":"${id}","keyframes":[` +
          '{"time":0,"transform":{"scale":1}},' +
          '{"time":3,"transform":{"scale":1.3},"easing":"ease-in-out"}]}]',
      ],
    })
    expect(applied.isError).toBeFalsy()
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].keyframes[1].easing).toBe('ease-in-out')

    const bad = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_keyframes","id":"${id}","keyframes":[{"time":0,"transform":{"scale":1},"easing":"bounce"}]}]`,
      ],
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('easing')
  })

  test('refuses an empty list and a keyframe with no usable time', async () => {
    const id = await withClip()
    const empty = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_keyframes","id":"${id}","keyframes":[]}]`],
    })
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toContain('at least one keyframe')

    const bad = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_keyframes","id":"${id}","keyframes":[{"time":-1,"transform":{"scale":1}}]}]`,
      ],
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('time')
  })
})

describe('reel_tool crop and picture-in-picture frame', () => {
  test('a crop is written, reported and cleared', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const initial = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const id = initial.tracks[0].clips[0].id

    const cropped = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_crop","id":"${id}","x":0.1,"y":0,"w":0.8,"h":1}]`],
    })
    expect(cropped.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].crop).toEqual({ x: 0.1, y: 0, w: 0.8, h: 1 })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· crop')

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_crop","id":"${id}","clear":true}]`],
    })
    expect(cleared.isError).toBeFalsy()
    const after = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(after.tracks[0].clips[0].crop).toBeUndefined()
  })

  test('a picture-in-picture frame is written, reported and cleared', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_overlay","overlay":{"kind":"media","src":"assets/pip.mp4","start":0,"duration":2}}]',
      ],
    })
    expect(added.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const overlayId = doc.overlays[0].id

    const framed = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_overlay_frame","id":"${overlayId}","width":8,"color":"#ffcc00","radius":0.2}]`,
      ],
    })
    expect(framed.isError).toBeFalsy()

    const after = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(after.overlays[0].frame).toEqual({ width: 8, color: '#ffcc00', radius: 0.2 })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('frame 8px')

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_overlay_frame","id":"${overlayId}","clear":true}]`],
    })
    expect(cleared.isError).toBeFalsy()
    const final = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(final.overlays[0].frame).toBeUndefined()
  })

  test('a frame on a text overlay is ignored', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_overlay","overlay":{"kind":"text","text":"你好","start":0,"duration":1}}]'],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const result = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_overlay_frame","id":"${doc.overlays[0].id}","width":6}]`],
    })
    // Accepted, but a text overlay has no picture to frame — nothing is stored.
    expect(result.isError).toBeFalsy()
    const after = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(after.overlays[0].frame).toBeUndefined()
  })
})

describe('reel_tool freeze frame', () => {
  const cut = async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    return doc.tracks[0].clips[0].id as string
  }

  test('splits the clip, inserts a silent still and ripples the track', async () => {
    const id = await cut()
    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"freeze_frame","id":"${id}","at":2,"duration":1.5}]`],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clips = doc.tracks[0].clips as Array<{
      start: number
      duration: number
      in: number
      freeze?: boolean
      muted?: boolean
    }>
    expect(clips.map((clip) => clip.start)).toEqual([0, 2, 3.5])
    expect(clips.map((clip) => clip.duration)).toEqual([2, 1.5, 2])
    expect(clips[1]!.freeze).toBe(true)
    expect(clips[1]!.muted).toBe(true)
    expect(clips[1]!.in).toBe(2)
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('· freeze')
  })

  test('ripples the whole cut by default, captions and sound included', async () => {
    const id = await cut()
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          { op: 'add_track', kind: 'audio' },
          { op: 'add_clip', src: 'assets/music.mp3', duration: 8, start: 0, trackId: 'audio-1' },
          {
            op: 'add_overlay',
            overlay: { kind: 'text', text: '字幕', start: 3, duration: 1, preset: 'subtitle' },
          },
        ]),
      ],
    })

    const applied = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"freeze_frame","id":"${id}","at":2,"duration":1}]`],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect((doc.tracks[0].clips as Array<{ start: number }>).map((clip) => clip.start)).toEqual([0, 2, 3])
    // A bed that began before the hold stays continuous.
    expect(doc.tracks[1].clips[0].start).toBe(0)
    // A caption after the hold moves with the picture it belongs to.
    expect(doc.overlays[0].start).toBe(4)
  })

  test('ripple: track moves only the frozen lane, and an unknown mode is refused', async () => {
    const id = await cut()
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          {
            op: 'add_overlay',
            overlay: { kind: 'text', text: '字幕', start: 3, duration: 1, preset: 'subtitle' },
          },
        ]),
      ],
    })
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"freeze_frame","id":"${id}","at":2,"duration":1,"ripple":"track"}]`,
      ],
    })
    expect(applied.isError).toBeFalsy()
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.overlays[0].start).toBe(3)

    const bad = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"freeze_frame","id":"${id}","at":1,"duration":1,"ripple":"cut"}]`,
      ],
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toContain('ripple')
  })

  test('refuses a moment on an edge and a duration that is not positive', async () => {
    const id = await cut()
    const edge = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"freeze_frame","id":"${id}","at":0,"duration":1}]`],
    })
    expect(edge.isError).toBe(true)
    expect(textOf(edge)).toContain('edges')

    const zero = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"freeze_frame","id":"${id}","at":2,"duration":0}]`],
    })
    expect(zero.isError).toBe(true)
    expect(textOf(zero)).toContain('duration')
  })
})

/** A click track: a quiet floor with a sharp attack every half second at 120 BPM. */
const clickRms = (seconds = 10, bpm = 120, step = 0.01) => {
  const count = Math.round(seconds / step)
  const rms = new Float32Array(count).fill(0.02)
  for (let time = 0.5; time < seconds; time += 60 / bpm) {
    const index = Math.round(time / step)
    rms[index] = 1
    if (index + 1 < count) rms[index + 1] = 0.35
    if (index + 2 < count) rms[index + 2] = 0.15
  }
  return rms
}

describe('reel_tool beats — the pulse of a source', () => {
  afterEach(() => setReelAudio(null))

  test('answers tempo, a grid and downbeats; --clip moves them onto the timeline', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_clip","src":"assets/music.mp3","duration":4,"start":2}]',
      ],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    setReelAudio(async () => ({
      ok: true,
      levels: { duration: 10, bucketSeconds: 0.01, rms: clickRms() },
    }))

    const plain = textOf(await handleReelTool(ctx(project), { command: 'beats --src assets/music.mp3' }))
    expect(plain).toContain('120 BPM')
    expect(plain).toContain('beats (source s):')
    expect(plain).toContain('source seconds')

    const mapped = JSON.parse(
      textOf(
        await handleReelTool(ctx(project), {
          command: `beats --src assets/music.mp3 --clip ${clipId} --json`,
        }),
      ),
    )
    expect(mapped.timebase).toBe('timeline')
    expect(mapped.bpm).toBe(120)
    expect(mapped.beats[0].time).toBeGreaterThanOrEqual(2)
    expect(mapped.beats[mapped.beats.length - 1].time).toBeLessThanOrEqual(6)
    expect(mapped.downbeats.length).toBeGreaterThan(0)
  })

  test('refuses in words on a host with no decoder', async () => {
    setReelAudio(null)
    const refused = await handleReelTool(ctx(project), { command: 'beats --src assets/music.mp3' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('音频解码器')
  })
})

describe('reel_tool auto_edit — 卡点 arrangement in one op', () => {
  test('fills a video track from a beat grid, taking the sources in turn', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const beats = [0.5, 1, 1.5, 2].map((time, index) => ({ time, strength: 1, index }))
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          {
            op: 'auto_edit',
            trackId: 'video-1',
            mode: 'beats',
            sources: [
              { src: 'assets/a.mp4', duration: 5 },
              { src: 'assets/b.mp4', duration: 5 },
            ],
            beats,
            minClipDuration: 0.3,
            maxClipDuration: 10,
          },
        ]),
      ],
    })
    expect(applied.isError).toBeFalsy()
    expect(textOf(applied)).toContain('auto_edit placed 4 clip(s)')

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips.map((clip: { start: number }) => clip.start)).toEqual([0, 0.5, 1, 1.5])
    expect(doc.tracks[0].clips.map((clip: { src: string }) => clip.src)).toEqual([
      'assets/a.mp4',
      'assets/b.mp4',
      'assets/a.mp4',
      'assets/b.mp4',
    ])
  })

  test('downbeats mode uses one cut per bar and replaces the track', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/old.mp4","duration":9}]'],
    })
    const applied = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        JSON.stringify([
          {
            op: 'auto_edit',
            trackId: 'video-1',
            mode: 'downbeats',
            sources: [{ src: 'assets/a.mp4', duration: 8 }],
            downbeats: [0, 2, 4, 6],
          },
        ]),
      ],
    })
    expect(applied.isError).toBeFalsy()

    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips.map((clip: { start: number }) => clip.start)).toEqual([0, 2, 4])
    expect(
      doc.tracks[0].clips.every((clip: { src: string }) => clip.src === 'assets/a.mp4'),
    ).toBe(true)
  })

  test('needs beat data and a source with a duration', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    const noBeats = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"auto_edit","trackId":"video-1","sources":[{"src":"assets/a.mp4","duration":5}]}]',
      ],
    })
    expect(noBeats.isError).toBe(true)
    expect(textOf(noBeats)).toContain('beats')

    const noSource = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"auto_edit","trackId":"video-1","beats":[0,1,2]}]',
      ],
    })
    expect(noSource.isError).toBe(true)
    expect(textOf(noSource)).toContain('sources')
  })
})

describe('reel_tool markers and a range export', () => {
  afterEach(() => setReelExportHost(null))

  test('a marker is added, listed by state, and removed by id', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })

    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        '[{"op":"add_marker","time":3,"name":"第二章"},{"op":"add_marker","time":1}]',
      ],
    })
    expect(added.isError).toBeFalsy()
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.markers.map((marker: { time: number }) => marker.time)).toEqual([1, 3])
    expect(doc.markers[1].name).toBe('第二章')
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('(marker)')

    const removed = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"remove_marker","markerId":"${doc.markers[0].id}"}]`],
    })
    expect(removed.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.markers).toHaveLength(1)

    const unknown = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"remove_marker","markerId":"marker-nope"}]'],
    })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toContain('no marker')
  })

  test('export --from/--to hands the renderer a slice that starts at 0', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let seen: EditDocument | undefined
    setReelExportHost({
      start: (input) => {
        seen = input.document
        return {
          id: 'export-range',
          sessionId: input.sessionId,
          name: input.name,
          outPath: input.outPath,
          container: input.container,
          audioOnly: input.audioOnly ?? false,
          status: 'running',
          startedAt: Date.now(),
        }
      },
      status: () => null,
      list: () => [],
      cancel: () => false,
    })

    const result = await handleReelTool(ctx(project), { command: 'export --from 1 --to 3' })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('1.00s–3.00s')
    const clip = seen!.tracks[0]!.clips[0]!
    expect(clip.start).toBe(0)
    expect(clip.in).toBe(1)
    expect(clip.duration).toBe(2)

    const backwards = await handleReelTool(ctx(project), { command: 'export --from 3 --to 1' })
    expect(backwards.isError).toBe(true)
    expect(textOf(backwards)).toContain('--from')
  })
})

describe('reel_tool masks', () => {
  test('set_mask writes one shape per clip, updates it in place, and clears it', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_mask","id":"${clipId}","shape":"ellipse","x":0.3,"y":0.2,"width":0.4,"height":0.6,"feather":20,"inverted":true}]`,
      ],
    })
    expect(added.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.masks).toHaveLength(1)
    expect(doc.masks[0]).toMatchObject({
      clipId,
      shape: 'ellipse',
      x: 0.3,
      y: 0.2,
      width: 0.4,
      height: 0.6,
      feather: 20,
      inverted: true,
    })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('(mask/ellipse)')

    const maskId = doc.masks[0].id
    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_mask","id":"${clipId}","shape":"rectangle","feather":4}]`,
      ],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.masks).toHaveLength(1)
    expect(doc.masks[0].id).toBe(maskId)
    expect(doc.masks[0].shape).toBe('rectangle')

    const cleared = await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"clear_mask","id":"${clipId}"}]`],
    })
    expect(cleared.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.masks).toBeUndefined()
  })

  test('an unknown shape is refused whole', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    const doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const result = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_mask","id":"${doc.tracks[0].clips[0].id}","shape":"heart"}]`,
      ],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('rectangle, ellipse or polygon')
  })

  test('mask keyframes animate the box, and an empty list keeps it still', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const animated = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_mask","id":"${clipId}","shape":"ellipse","keyframes":[` +
          `{"time":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3},` +
          `{"time":2,"x":0.4,"y":0.2,"width":0.3,"height":0.3,"opacity":0.6,"easing":"ease-in-out"}]}]`,
      ],
    })
    expect(animated.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.masks[0].keyframes).toHaveLength(2)
    expect(doc.masks[0].keyframes[1]).toMatchObject({ time: 2, x: 0.4, opacity: 0.6, easing: 'ease-in-out' })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('2 keyframes')

    const held = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_mask","id":"${clipId}","shape":"ellipse","keyframes":[]}]`,
      ],
    })
    expect(held.isError).toBeFalsy()
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.masks[0].keyframes).toBeUndefined()

    const badEasing = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_mask","id":"${clipId}","shape":"ellipse","keyframes":[` +
          `{"time":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3,"easing":"bounce"}]}]`,
      ],
    })
    expect(badEasing.isError).toBe(true)
    expect(textOf(badEasing)).toContain('linear, ease-in, ease-out or ease-in-out')
  })
})

describe('reel_tool mirror, regional blur and audio mastering', () => {
  test('flipX mirrors a clip and can be turned off', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_transform","id":"${clipId}","flipX":true}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].transform.flipX).toBe(true)

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_transform","id":"${clipId}","flipX":false}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].transform).toBeUndefined()
  })

  test('regions survive a grade edit and clearRegions keeps the grade', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    const added = await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_effect","id":"${clipId}","regions":[{"x":0.68,"y":0.04,"w":0.28,"h":0.1,"mode":"blur","strength":18}]}]`,
      ],
    })
    expect(added.isError).toBeFalsy()
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('+1 region(s)')

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_effect","id":"${clipId}","brightness":1.2}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].effect.regions).toHaveLength(1)
    expect(doc.tracks[0].clips[0].effect.brightness).toBeCloseTo(1.2)

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_effect","id":"${clipId}","clearRegions":true}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].effect.regions).toBeUndefined()
    expect(doc.tracks[0].clips[0].effect.brightness).toBeCloseTo(1.2)
  })

  test('normalise and denoise merge into the tone and clear with it', async () => {
    await handleReelTool(ctx(project), { command: 'create --name 预告' })
    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', '[{"op":"add_clip","src":"assets/a.mp4","duration":4}]'],
    })
    let doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    const clipId = doc.tracks[0].clips[0].id

    await handleReelTool(ctx(project), {
      command: [
        'apply',
        '--ops',
        `[{"op":"set_audio_effect","id":"${clipId}","normalize":true,"denoise":true}]`,
      ],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].audioEffect).toEqual({ normalize: true, denoise: true })
    expect(textOf(await handleReelTool(ctx(project), { command: 'state' }))).toContain('+denoise')

    await handleReelTool(ctx(project), {
      command: ['apply', '--ops', `[{"op":"set_audio_effect","id":"${clipId}","clear":true}]`],
    })
    doc = JSON.parse(textOf(await handleReelTool(ctx(project), { command: 'state --json' })))
    expect(doc.tracks[0].clips[0].audioEffect).toBeUndefined()
  })
})
