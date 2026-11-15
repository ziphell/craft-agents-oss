import { app, session } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { renderDrawio } from '../src/main/drawio-render'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})

const DIAGRAM = join(
  'C:/Users/Ryan/.craft-agent/workspaces/my-workspace/sessions/260927-pure-bear/diagrams/demo.drawio',
)
const OUT = join('C:/Users/Ryan/AppData/Local/Temp/drawio-engine.png')

app
  .whenReady()
  .then(async () => {
    registerLocalOriginHandler(session.defaultSession)
    const started = Date.now()
    const out = await renderDrawio({ xml: readFileSync(DIAGRAM, 'utf8'), format: 'png' })
    writeFileSync(OUT, out.bytes)
    const head = Buffer.from(out.bytes.subarray(0, 33))
    console.log(
      `png ${statSync(OUT).size} B · ${head.readUInt32BE(16)}x${head.readUInt32BE(20)} · ` +
        `colorType ${head[25]} (6 = RGBA) · ${Date.now() - started} ms`,
    )
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
