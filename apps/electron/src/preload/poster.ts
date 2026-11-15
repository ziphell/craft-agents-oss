/**
 * The poster window's whole bridge: read a file, as text or as a data URL.
 *
 * A poster is the app's own `<Markdown>`, which means the blocks that name a file — `html-preview`,
 * `image-preview`, `pdf-preview` — try to load it through `usePlatform().onReadFile`. In the app
 * window those are RPC calls with a workspace behind them; this window has neither, so without this
 * bridge those blocks draw nothing and the poster is a page with holes in it.
 *
 * So the bridge is deliberately **two reads and nothing else**, and both of them say where they may
 * read from: a file **beside the document** (`resolveDocumentPath`), inside that document's own
 * workspace (`poster-bridge.ts`). What is *not* here is everything else a page might want — writing,
 * dialogs, opening a window — which is what keeps a picture of a document from being able to do
 * anything a picture does not need.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('craftPoster', {
  /** A file beside the document, as text — what a file-backed `datatable` / `spreadsheet` reads. */
  readText: (path: string) => ipcRenderer.invoke('poster:read', path, 'text') as Promise<string>,
  /** A picture beside the document, as a `data:` URL — what `![](logo.png)` reads. */
  readDataUrl: (path: string) => ipcRenderer.invoke('poster:read', path, 'data-url') as Promise<string>,
})
