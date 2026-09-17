/**
 * Frame capture as a prototype artifact.
 *
 * The browser pane samples the screen and hands back bytes — it is the only party
 * that can see it. This module is what turns a capture into something a finding
 * can cite: it reads every frame's address back against the prototype's page
 * table and writes the images and their index under `research/frames/<session>/`.
 *
 * The split is the same one `apply-prototype.ts` makes: the pane owns the browser,
 * this layer owns the file layout, and neither has to know the other's rules. It is
 * also why the pane returns bytes rather than paths.
 *
 * @see docs/prototype-workbench-plan.md §20.3
 */

import type { PrototypeFrame, PrototypeFrameCapture } from '@craft-agent/shared/prototypes'
import { listPrototypePages, matchPrototypePage, writeFrameCapture } from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export interface PrototypeFrameCaptureResult {
  /** Absolute path to the session directory. */
  dir: string
  frames: number
  files: string[]
  /** True when the capture hit its ceiling: what was written is a sample. */
  truncated: boolean
}

export interface PrototypeFrameCaptureOptions {
  intervalMs?: number
  threshold?: number
  maxFrames?: number
}

/**
 * Start keeping frames of one tab of a window (plan §20.3).
 *
 * The tab, not the window: a recording is evidence about what was done somewhere, and with
 * the person free to read another tab of the same window (plan §22, 第十二轮) the tab is
 * the only thing the frames can be about.
 */
export async function startPrototypeFrameCapture(
  bpm: IBrowserPaneManager,
  instanceId: string,
  options: PrototypeFrameCaptureOptions,
  /** The tab to record — the conversation's, not the one on screen. */
  tabId?: string,
): Promise<{ startedAt: string; intervalMs: number; threshold: number; maxFrames: number }> {
  return bpm.startFrameCapture(instanceId, options, tabId)
}

/**
 * Stop the capture and write it as the prototype's research evidence.
 *
 * Returns null when nothing was being captured: stopping is idempotent rather
 * than an error, because a caller that is not sure whether a recording is running
 * should be able to stop it either way.
 */
export async function stopPrototypeFrameCapture(
  bpm: IBrowserPaneManager,
  instanceId: string,
  workspaceRootPath: string,
  slug: string,
): Promise<PrototypeFrameCaptureResult | null> {
  const capture = await bpm.stopFrameCapture(instanceId)
  if (!capture) return null

  // Which page a frame was taken on is read off its address by the same rule that
  // serves pages, so a capture that spanned a navigation says which screen each
  // frame shows without anyone having had to write it down.
  const pages = listPrototypePages(workspaceRootPath, slug)
  const frames: PrototypeFrame[] = capture.frames.map((frame) => ({
    index: frame.index,
    at: frame.at,
    url: frame.url,
    page: matchPrototypePage(pages, frame.url),
    reason: frame.reason,
    ...(frame.action ? { action: frame.action } : {}),
  }))

  const described: PrototypeFrameCapture = {
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    intervalMs: capture.intervalMs,
    threshold: capture.threshold,
    viewport: capture.viewport,
    truncated: capture.truncated,
    frames,
  }

  const written = writeFrameCapture(
    workspaceRootPath,
    slug,
    described,
    capture.frames.map((frame) => frame.bytes),
  )

  return { dir: written.dir, frames: frames.length, files: written.files, truncated: capture.truncated }
}
