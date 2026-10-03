/**
 * The encoder window's half of the wire.
 *
 * Frames in, chunks out, and nothing else. The page is ours, hidden, and loads no remote
 * content, so this bridge is the whole of what it can reach — which is why the page needs no
 * `nodeIntegration` to be told what to draw.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { ENCODER_CHUNK_CHANNEL, ENCODER_FRAME_CHANNEL } from '../shared/recording-encoder-channels'

export interface EncoderFrameMessage {
  /** JPEG, base64 — the same shape the screencast delivered it in. */
  data: string
  /** ms from the start of the recording. */
  offsetMs: number
}

contextBridge.exposeInMainWorld('recordingEncoder', {
  /** Every frame to draw, in the order it was taken. */
  onFrame: (listener: (frame: EncoderFrameMessage) => void): void => {
    ipcRenderer.on(ENCODER_FRAME_CHANNEL, (_event, frame) => listener(frame))
  },
  /** One encoded chunk, in the order the recorder produced it. */
  sendChunk: (chunk: Uint8Array): void => {
    ipcRenderer.send(ENCODER_CHUNK_CHANNEL, chunk)
  },
})
