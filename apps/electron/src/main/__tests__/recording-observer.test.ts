/**
 * The page's half of a recording, on a document double.
 *
 * No browser: what is worth pinning is the three rules the observer exists to keep — it reports
 * only what a **person** did (`isTrusted`), it says **which field** was filled and never what was
 * typed, and it can be silenced in a document that is already open. The signal's own shape is
 * pinned here too, because the host's reader and this writer have to agree word for word.
 */

import { describe, expect, it } from 'bun:test'
import {
  RECORDING_SIGNAL_PREFIX,
  buildRecordingObserverOffSource,
  buildRecordingObserverSource,
  parseRecordingSignal,
} from '../recording-observer'

/** The document the observer runs against: what it listens to, and a way to fire at it. */
function pageDouble() {
  const listeners = new Map<string, (event: any) => void>()
  const logged: string[] = []
  let added = 0

  const windowMock: any = {}
  const documentMock: any = {
    addEventListener: (type: string, handler: (event: any) => void) => {
      added += 1
      listeners.set(type, handler)
    },
    removeEventListener: (type: string) => { listeners.delete(type) },
  }

  const run = (source: string): void => {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'console', 'String', 'JSON', source)(
      windowMock,
      documentMock,
      { log: (message: string) => logged.push(message) },
      String,
      JSON,
    )
  }

  return {
    run,
    logged,
    fire: (type: string, event: any) => listeners.get(type)?.(event),
    addedListeners: () => added,
    window: windowMock,
  }
}

/** The shape the observer reads off an element: a tag, some attributes, and `closest`. */
function element(tag: string, attributes: Record<string, string> = {}, text = '', closest?: unknown): any {
  return {
    tagName: tag.toUpperCase(),
    innerText: text,
    value: '',
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: () => closest ?? null,
  }
}

/** What the page said, as the host would read it. */
function reported(page: ReturnType<typeof pageDouble>) {
  return page.logged.map((message) => parseRecordingSignal(message))
}

describe('the recording observer, in a page', () => {
  it('reports what the person pressed, in the terms a step can be written in', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    page.fire('click', { isTrusted: true, target: element('BUTTON', { 'aria-label': '导出' }) })

    expect(reported(page)).toEqual([
      { type: 'click', target: { tag: 'button', role: 'button', name: '导出' } },
    ])
    expect(page.logged[0]!.startsWith(RECORDING_SIGNAL_PREFIX)).toBe(true)
  })

  it('reports the thing that was pressed when the press landed on a child of it', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    const button = element('BUTTON', {}, 'Export')
    page.fire('click', { isTrusted: true, target: element('SPAN', {}, 'Export', button) })

    expect(reported(page)).toEqual([
      { type: 'click', target: { tag: 'button', role: 'button', name: 'Export' } },
    ])
  })

  it('ignores what the page did to itself', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    // A script calling `button.click()`, a timer, a framework's own dispatch — none of them is a
    // step somebody took, and a self-updating page would otherwise fill the recording with them.
    page.fire('click', { isTrusted: false, target: element('BUTTON', { 'aria-label': '导出' }) })

    expect(page.logged).toEqual([])
  })

  it('keeps what was typed, so a step can say what was searched for', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    const field = element('INPUT', { 'aria-label': 'Search', type: 'search' })
    field.value = 'U23 国足'
    page.fire('change', { isTrusted: true, target: field })

    expect(reported(page)).toEqual([
      {
        type: 'fill',
        target: { tag: 'input', role: 'textbox', name: 'Search' },
        value: 'U23 国足',
      },
    ])
  })

  it('never keeps a value from a field that says it is a secret', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    const password = element('INPUT', { 'aria-label': 'Password', type: 'password' })
    password.value = 'hunter2'
    page.fire('change', { isTrusted: true, target: password })

    // Some sites use a plain text field and say what it holds instead of using `type=password`.
    const declared = element('INPUT', { 'aria-label': 'Sign in', type: 'text', autocomplete: 'current-password' })
    declared.value = 'hunter2'
    page.fire('change', { isTrusted: true, target: declared })

    // The name is still worth having; the value is not — the file lands in a folder people hand to
    // each other, and the field itself said what it holds.
    expect(reported(page)).toEqual([
      { type: 'fill', target: { tag: 'input', role: 'textbox', name: 'Password' } },
      { type: 'fill', target: { tag: 'input', role: 'textbox', name: 'Sign in' } },
    ])
    expect(page.logged.join('')).not.toContain('hunter2')
  })

  it('does not read a field\'s name out of what was typed into it', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    // Measured, from a real recording: a textarea's `name` came back as the sentence somebody had
    // written in it, which is what the `value` is for.
    const box = element('TEXTAREA', { name: 'q' })
    box.innerText = '期货居间时代落幕了'
    box.value = '期货居间时代落幕了'
    page.fire('change', { isTrusted: true, target: box })

    expect(reported(page)).toEqual([
      {
        type: 'fill',
        target: { tag: 'textarea', role: 'textbox', name: 'q' },
        value: '期货居间时代落幕了',
      },
    ])
  })

  it('keeps a button\'s caption, where the value really is the name', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    const submit = element('INPUT', { type: 'submit' })
    submit.value = 'Search'
    page.fire('click', { isTrusted: true, target: submit })

    expect(reported(page)).toEqual([
      { type: 'click', target: { tag: 'input', role: 'button', name: 'Search' } },
    ])
  })

  it('takes role from the element itself before the tag', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())

    page.fire('click', { isTrusted: true, target: element('DIV', { role: 'tab', 'aria-label': '图片' }) })

    expect(reported(page)).toEqual([
      { type: 'click', target: { tag: 'div', role: 'tab', name: '图片' } },
    ])
  })

  it('one document, one observer — the init script and the injection may both land in it', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())
    page.run(buildRecordingObserverSource())
    page.run(buildRecordingObserverOffSource())

    // Silenced, then run again: still one set of listeners, and it starts reporting again.
    page.run(buildRecordingObserverSource())
    page.fire('click', { isTrusted: true, target: element('A', {}, 'Next') })

    expect(page.addedListeners()).toBe(4) // click + change, twice — never a third
    expect(reported(page)).toEqual([
      { type: 'click', target: { tag: 'a', role: 'link', name: 'Next' } },
    ])
  })

  it('can be silenced in a document that is already open', () => {
    const page = pageDouble()
    page.run(buildRecordingObserverSource())
    page.fire('click', { isTrusted: true, target: element('BUTTON', {}, 'Export') })
    expect(page.logged).toHaveLength(1)

    page.run(buildRecordingObserverOffSource())
    page.fire('click', { isTrusted: true, target: element('BUTTON', {}, 'Export') })

    // A listener still reporting to nobody is still a listener in somebody's page.
    expect(page.logged).toHaveLength(1)
  })
})

describe('reading a page signal', () => {
  it('is null for anything that is not one of ours', () => {
    expect(parseRecordingSignal('an ordinary console message')).toBeNull()
    expect(parseRecordingSignal(`${RECORDING_SIGNAL_PREFIX}not json`)).toBeNull()
    expect(parseRecordingSignal(`${RECORDING_SIGNAL_PREFIX}null`)).toBeNull()
    expect(parseRecordingSignal(`${RECORDING_SIGNAL_PREFIX}{"type":"navigate","url":"x"}`)).toBeNull()
    expect(parseRecordingSignal(`${RECORDING_SIGNAL_PREFIX}{"type":"click"}`)).toBeNull()
  })

  it('fills in what the page left out rather than throwing it away', () => {
    expect(parseRecordingSignal(`${RECORDING_SIGNAL_PREFIX}{"type":"click","target":{"tag":"button"}}`))
      .toEqual({ type: 'click', target: { tag: 'button', role: 'button', name: '' } })
  })
})
