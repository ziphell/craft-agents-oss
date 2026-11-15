/**
 * The export page's half of the wire.
 *
 * One job in, chunks and progress out. The page is ours, hidden, and loads no remote content, so
 * this bridge is the whole of what it can reach.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('editExport', {
  sendChunk: (bytes: Uint8Array, position: number): void => {
    ipcRenderer.send('edit-export:chunk', { data: bytes, position })
  },
  progress: (ratio: number): void => {
    ipcRenderer.send('edit-export:progress', ratio)
  },
  finish: (message: string | null): void => {
    ipcRenderer.send('edit-export:done', message)
  },
  /** Read a source file as bytes. A `file://` page cannot fetch its own neighbours. */
  readFile: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('edit-export:read', path),
})
