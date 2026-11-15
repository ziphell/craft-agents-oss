import { app, session } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { exportDocumentPdf } from '../src/main/office-export'
import { renderPagePng, pdfPageCount } from '@craft-agent/office-host'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})

const DOCX = 'C:/Users/Ryan/.craft-agent/workspaces/my-workspace/sessions/261102-rapid-diamond/data/bench/long.docx'

app
  .whenReady()
  .then(async () => {
    registerLocalOriginHandler(session.defaultSession)
    const started = Date.now()
    const pdf = await exportDocumentPdf(
      { app: 'docs', path: DOCX, bytes: new Uint8Array(readFileSync(DOCX)), timeoutMs: 30_000 },
      { firstPageOnly: true },
    )
    writeFileSync('C:/Users/Ryan/AppData/Local/Temp/long-page.pdf', Buffer.from(pdf))
    console.log(`pdf ${pdf.length} B · ${Date.now() - started} ms`)
    let pages = -1
    try {
      pages = await pdfPageCount({ bytes: pdf })
    } catch (error) {
      console.log('page count failed:', String(error))
    }
    console.log(`pages ${pages}`)

    let t = Date.now()
    const png = await renderPagePng({ bytes: pdf, pageIndex: 0, pxWidth: 1000 })
    console.log(`raster #1 ${Date.now() - t} ms`)
    for (let i = 0; i < 3; i++) {
      t = Date.now()
      await renderPagePng({ bytes: pdf, pageIndex: 0, pxWidth: 1000 })
      console.log(`raster #${i + 2} ${Date.now() - t} ms`)
    }
    writeFileSync('C:/Users/Ryan/AppData/Local/Temp/long-page.png', Buffer.from(png))
    const head = Buffer.from(png.subarray(0, 33))
    console.log(`png ${png.length} B · ${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`)
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
