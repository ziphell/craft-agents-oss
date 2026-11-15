import { app, session } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { writeOfficePagePng } from '../src/main/office-page-capture'
import { writeOfficePages } from '../src/main/office-export'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})

const DOCX = 'C:/Users/Ryan/.craft-agent/workspaces/my-workspace/sessions/261102-rapid-diamond/data/bench/long.docx'
const OUT = join('C:/Users/Ryan/AppData/Local/Temp', 'render-pages')

app
  .whenReady()
  .then(async () => {
    registerLocalOriginHandler(session.defaultSession)
    // The printed route — what `render` uses now for a document: PDF, then pdfium per page.
    let started = Date.now()
    const printed = await writeOfficePages(
      { app: 'docs', path: DOCX, bytes: new Uint8Array(readFileSync(DOCX)) },
      join(OUT, 'printed'),
    )
    console.log(`printed ${printed.length} · ${Date.now() - started} ms`)
    for (const file of printed) {
      const head = require('node:fs').readFileSync(file).subarray(16, 24)
      console.log(`  ${file} · ${statSync(file).size} B · ${head.readUInt32BE(0)}x${head.readUInt32BE(4)}`)
    }

    started = Date.now()
    const files = await writeOfficePagePng('docs', DOCX, OUT, 0)
    console.log(`captured ${files.length} · ${Date.now() - started} ms`)
    for (const file of files) {
      const head = require('node:fs').readFileSync(file).subarray(16, 24)
      console.log(`  ${file} · ${statSync(file).size} B · ${head.readUInt32BE(0)}x${head.readUInt32BE(4)}`)
    }
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
