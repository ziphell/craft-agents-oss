/**
 * The sidecar: what the page did while a recording was running.
 *
 * A recording is a picture. The sidecar is the facts beside it — where the page went, and what
 * it asked for — stamped on the recording's **own clock** (`ms` from the moment it started), in
 * a JSON-lines file under the same stem as the film (`20260918-143012.events.jsonl`). A reader
 * holding one path has both, so there is no index to keep and nothing to look up.
 *
 * **Written only by the recorder.** The same reason `hits.json` is written only by the applier:
 * a record of what happened that somebody could have typed says nothing. The recording is what
 * observed, so the recording writes. `TabRecorder` opens this when a recording starts and closes
 * it when one ends; nothing else touches these files.
 *
 * Three kinds of fact end up here. **Navigations** and **requests** are the host's own — the tab
 * reports them and no script is needed (`browser-pane-manager.ts`). **Clicks and fills** are the
 * page's own: they can only come from a script inside it, which is what `recording-observer.ts`
 * puts there while a recording covers the tab.
 *
 * ## What a value is recorded for, and what it is not
 *
 * A `fill` carries what was typed — a step that says "fill the search box" is much less useful
 * than one that says what was searched for. But this file lands beside a film in a folder people
 * hand to each other, so **a field that says it is a secret never carries one**: a password input,
 * and anything whose `autocomplete` names a credential, are recorded by name alone
 * (`recording-observer.ts` decides, from the field's own declaration rather than from a guess at
 * its name).
 *
 * Every write is guarded. This runs on the path of an ordinary navigation, and a full disk or a
 * read-only folder must not turn into a browser that cannot navigate — a recording without a
 * sidecar is still a recording.
 */

import { appendFileSync, writeFileSync } from 'node:fs'

/** What an element is, in the terms a person would use to point at it again. */
export interface ElementRef {
  /** Tag name, lower case — `button`, `a`, `input`. */
  tag: string
  /** Its role: an explicit `role`, or the browser's own default for that tag. */
  role: string
  /** How it announces itself — `aria-label`, placeholder, title, alt, or its text. */
  name: string
}

/** One thing that happened. `ms` is added by the writer, from the recording's own clock. */
export type RecordingEvent =
  | { type: 'navigate'; url: string; inPage?: boolean }
  /** One request the page made, with how it ended: `status` 0 plus `error` means it did not. */
  | { type: 'request'; method: string; url: string; status: number; resourceType: string; error?: string }
  /** Somebody pressed something — the page's own report (`recording-observer.ts`). */
  | { type: 'click'; target: ElementRef }
  /** Somebody filled a field in. `value` is what they typed — except where the field says it is a secret. */
  | { type: 'fill'; target: ElementRef; value?: string }

/** `<…>.mp4` → `<…>.events.jsonl`. Beside the film, same stem. */
export function sidecarPathFor(recordingFile: string): string {
  return recordingFile.replace(/\.[^./\\]+$/, '.events.jsonl')
}

/** Claim the file and write its first line — the one that defines the clock every `ms` is from. */
export function openSidecar(options: { file: string; startedAt: number; tabId: string }): void {
  try {
    const line = JSON.stringify({ type: 'start', startedAt: options.startedAt, tabId: options.tabId })
    writeFileSync(options.file, `${line}\n`, 'utf-8')
  } catch {
    // A recording without a sidecar is still a recording.
  }
}

export function appendSidecarEvent(file: string, offsetMs: number, event: RecordingEvent): void {
  try {
    appendFileSync(file, `${JSON.stringify({ ms: offsetMs, ...event })}\n`, 'utf-8')
  } catch {
    // See the header: the log never gets to break the browser.
  }
}

/** Say when it stopped, so a reader knows the log is whole rather than cut off. */
export function closeSidecar(file: string, offsetMs: number, seconds: number): void {
  try {
    appendFileSync(file, `${JSON.stringify({ ms: offsetMs, type: 'stop', seconds })}\n`, 'utf-8')
  } catch {
    // Nothing left to do about it: the file holds what arrived.
  }
}
