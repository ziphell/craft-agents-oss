import { describe, it, expect } from 'bun:test'
import { officeWorkbookCall } from '../workbook'

/**
 * The sheets editor's opening handshake.
 *
 * It never pulls a document: it asks `hasQueuedWorkbook()` and only calls `selectWorkbook()` — the
 * open — when that answers true (see `apps/sheets/src/renderer/main.tsx` and `handleInspectWorkbook`
 * in `App.tsx`). This door had no case for the question, so the answer was `undefined` and a frame
 * showed the blank in-memory "Sheet1" while the poster of the same file drew its data. Measured with
 * `apps/electron/spike/sheets-open-probe.ts`.
 */
describe('hasQueuedWorkbook', () => {
  it('says yes when the frame was opened on a document', async () => {
    expect(await officeWorkbookCall('hasQueuedWorkbook', ['C:\\work\\book.xlsx'])).toBe(true)
  })

  it('says no when there is no document to queue', async () => {
    // A draft has no path; "true" here would send the editor to `selectWorkbook` with nothing.
    expect(await officeWorkbookCall('hasQueuedWorkbook', [''])).toBe(false)
  })
})
