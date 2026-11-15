import { chromium } from 'playwright-core'
import http from 'node:http'
import { writeFile, stat } from 'node:fs/promises'

const OUT = process.argv[2]
let page = null
let printed = null
let err = null

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:200mm 280mm;margin:10mm}
      h1{color:#123}</style></head><body><h1>宿主替页面打印 / host prints</h1>
      <p>中文断行检查。</p>
      <script>(async () => {
        const r = await fetch('/__craft/office-call/tok', { method: 'POST', body: '{}' })
        window.__answer = await r.json()
      })()</script></body></html>`)
    return
  }
  if (req.url.startsWith('/__craft/office-call/')) {
    // The whole spike: the page is *waiting on this very response*, and the host prints it anyway.
    void (async () => {
      try {
        const t0 = Date.now()
        const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
        await writeFile(OUT, pdf)
        printed = `${pdf.length} bytes in ${Date.now() - t0} ms`
      } catch (e) {
        err = e instanceof Error ? e.message : String(e)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: !!printed, printed, error: err }))
    })()
    return
  }
  res.writeHead(404).end()
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await chromium.launch({ channel: process.env.CRAFT_BROWSER_CHANNEL || 'chrome', headless: true })
const ctx = await browser.newContext()
page = await ctx.newPage()
await page.emulateMedia({ media: 'print' })
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__answer !== undefined, null, { timeout: 20000 })
console.log('page answer:', JSON.stringify(await page.evaluate(() => window.__answer)))
const s = await stat(OUT).catch(() => null)
console.log('file:', s ? `${s.size} bytes` : 'MISSING')
await browser.close()
server.close()
