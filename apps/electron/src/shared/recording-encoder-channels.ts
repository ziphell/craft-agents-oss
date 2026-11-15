/**
 * The two channels between the main process and an encoder window.
 *
 * Their own module because both ends are bundled separately — the preload by
 * `scripts/electron-build-preload.ts`, the main process by `electron-build-main.ts` — and a
 * literal written twice is how a channel silently stops matching. Nothing else lives here, so
 * the preload can pull it in without dragging the main process's module graph with it.
 */
export const ENCODER_FRAME_CHANNEL = 'recording-encoder:frame'
export const ENCODER_CHUNK_CHANNEL = 'recording-encoder:chunk'
