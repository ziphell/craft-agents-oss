/**
 * Where the preview's frames come from — the hidden `<video>` pool OpenReel calls its video engine.
 *
 * The visible player is a canvas (see `stage.tsx`); nothing else in the panel shows a `<video>`.
 * Each source file gets one muted element parked off-screen, and the pool seeks it to the moment
 * the canvas is about to draw. During playback the element is allowed to run with its own clock
 * (`playbackRate` = the clip's speed) and is only corrected when it drifts, so motion stays smooth
 * instead of being a seek per frame.
 */

import { clipSpeed, clipSourceTime } from '@craft-agent/shared/reel/document'
import type { Picture, RenderClip } from '@craft-agent/shared/reel/canvas-compositor'
import { isStill } from '@craft-agent/shared/reel/render-clips'

export { isStill }

/** How far a paused frame may be from the wanted moment before it is seeked. */
const SCRUB_DRIFT = 0.04
/** During playback the element's own clock carries the motion; only a real drift is corrected. */
const PLAY_DRIFT = 0.25

export class FrameSourcePool {
  private readonly videos = new Map<string, HTMLVideoElement>()
  private readonly images = new Map<string, HTMLImageElement>()
  private readonly used = new Set<string>()
  private playing = false

  constructor(
    private readonly host: HTMLElement,
    /** Called when a source decoded its first frame, so a paused canvas can paint it. */
    private readonly onReady: () => void = () => undefined,
  ) {}

  setPlaying(playing: boolean): void {
    this.playing = playing
    if (playing) return
    for (const video of this.videos.values()) {
      if (!video.paused) video.pause()
    }
  }

  /**
   * The source's own width/height, once its metadata is loaded. A picture-in-picture box uses it
   * to resize without letterboxing: the frame keeps the material's shape.
   */
  aspectOf(url: string): number | null {
    const video = this.videos.get(url)
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      return video.videoWidth / video.videoHeight
    }
    const image = this.images.get(url)
    if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
      return image.naturalWidth / image.naturalHeight
    }
    return null
  }

  /**
   * The frame of one clip at a local moment. `null` means the source has not decoded its first
   * frame yet — the canvas stays black until it has, rather than showing the wrong picture.
   */
  picture(clip: RenderClip, local: number, url: string): Picture | null {
    this.used.add(url)
    if (isStill(url)) return this.still(url)

    const video = this.video(url)
    if (!video.videoWidth || !video.videoHeight) return null
    const speed = clipSpeed(clip)
    video.playbackRate = speed
    // Varispeed, exactly like the exporter: the pitch follows the speed (the element is muted,
    // this only keeps future changes honest).
    video.preservesPitch = false

    const wanted = Math.max(0, clipSourceTime(clip, local))
    if (this.playing) {
      if (Math.abs(video.currentTime - wanted) > PLAY_DRIFT) video.currentTime = wanted
      if (video.paused) void video.play().catch(() => undefined)
    } else {
      if (!video.paused) video.pause()
      if (Math.abs(video.currentTime - wanted) > SCRUB_DRIFT) video.currentTime = wanted
    }

    return {
      width: video.videoWidth,
      height: video.videoHeight,
      draw: (ctx, x, y, width, height) => ctx.drawImage(video, x, y, width, height),
    }
  }

  /** The frame of a media overlay: its own source time, and always at 1×. */
  overlayPicture(
    overlay: { src?: string; in?: number },
    local: number,
    url: string,
  ): Picture | null {
    this.used.add(url)
    if (isStill(url)) return this.still(url)

    const video = this.video(url)
    if (!video.videoWidth || !video.videoHeight) return null
    const wanted = Math.max(0, (overlay.in ?? 0) + local)
    if (this.playing) {
      if (Math.abs(video.currentTime - wanted) > PLAY_DRIFT) video.currentTime = wanted
      if (video.paused) void video.play().catch(() => undefined)
    } else {
      if (!video.paused) video.pause()
      if (Math.abs(video.currentTime - wanted) > SCRUB_DRIFT) video.currentTime = wanted
    }
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      draw: (ctx, x, y, width, height) => ctx.drawImage(video, x, y, width, height),
    }
  }

  /** After a draw: anything that was not asked for this frame stops making noise or decoding. */
  finish(): void {
    for (const [url, video] of this.videos) {
      if (!this.used.has(url) && !video.paused) video.pause()
    }
    this.used.clear()
  }

  dispose(): void {
    for (const video of this.videos.values()) {
      video.pause()
      video.remove()
    }
    for (const image of this.images.values()) image.remove()
    this.videos.clear()
    this.images.clear()
    this.used.clear()
  }

  private still(url: string): Picture | null {
    const image = this.image(url)
    if (!image.complete || image.naturalWidth === 0) return null
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (ctx, x, y, width, height) => ctx.drawImage(image, x, y, width, height),
    }
  }

  private video(url: string): HTMLVideoElement {
    const known = this.videos.get(url)
    if (known) return known
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.style.cssText =
      'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
    video.addEventListener('loadeddata', () => this.onReady())
    video.addEventListener('seeked', () => this.onReady())
    this.host.appendChild(video)
    this.videos.set(url, video)
    return video
  }

  private image(url: string): HTMLImageElement {
    const known = this.images.get(url)
    if (known) return known
    const image = document.createElement('img')
    image.src = url
    image.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0'
    image.addEventListener('load', () => this.onReady())
    this.host.appendChild(image)
    this.images.set(url, image)
    return image
  }
}
