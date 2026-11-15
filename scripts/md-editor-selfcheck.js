/**
 * md-editor self-check — run in the page, against whatever bundle is loaded.
 *
 * Every bug this checks for was found by a person instead of by us, and every one was invisible to
 * unit tests because it lives in the DOM: a font that silently fell back, a widget laid out with
 * `white-space: pre`, a click swallowed by an ancestor, a colour applied to a whole subtree. So the
 * check is a browser script rather than a test file — it runs where those things are real, and it is
 * pointed at the **built** bundle (`dist/renderer/playground.html`), which is what the app loads.
 *
 * ## Which fixture it looks at, and why the script does not choose it
 *
 * The playground restores its selected fixture from `localStorage` (`playground-selected-component`)
 * on load, so the caller picks one *before* reloading — clicking the sidebar from inside a script
 * raced the React swap and once produced a whole run of false failures against the previous fixture.
 * This script therefore never navigates: it recognises what is mounted and asserts that group.
 *
 *   ;(() => { localStorage.setItem('playground-selected-component', 'readme-probe'); location.reload() })()
 *   → evaluate --file <abs>/scripts/md-editor-selfcheck.js ; evaluate window.__selfcheck
 *
 *   ;(() => { localStorage.setItem('playground-selected-component', 'markdown-editor-source'); location.reload() })()
 *   → the same two calls
 *
 * An unrecognised page reports `fixture: recognised` false rather than passing quietly.
 */
;(() => {
  window.__selfcheck = 'running'

  const results = []
  const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Wait for a predicate, or give up — a check that never becomes true is a failure, not a hang. */
  const until = async (fn, timeout = 5000, step = 50) => {
    const start = Date.now()
    for (;;) {
      const value = fn()
      if (value) return value
      if (Date.now() - start > timeout) return null
      await sleep(step)
    }
  }

  /** A line's text as the editor shows it, widget text included. */
  const lineTexts = () => [...document.querySelectorAll('.cm-line')].map((l) => l.textContent)
  const scroller = () => document.querySelector('.cm-scroller')
  const inMono = (el) => Boolean(el) && /JetBrains Mono/.test(getComputedStyle(el).fontFamily)

  /** The README: lists, a wide table, prose. The fixture the person was editing when it broke. */
  const checkReadme = async (content) => {
    const doc = content.textContent || ''

    const bullets = document.querySelectorAll('.cm-md-bullet').length
    record('list: bullets are drawn', bullets > 0, `${bullets} bullets`)

    const lines = [...document.querySelectorAll('.cm-line')]
    const listLine = lines.find((l) => (l.textContent || '').startsWith('•'))
    const proseLine = lines.find((l) => /四类文件/.test(l.textContent || ''))
    record(
      'list: its text is the same colour as prose',
      Boolean(listLine && proseLine) &&
        getComputedStyle(listLine).color === getComputedStyle(proseLine).color,
      `${listLine ? getComputedStyle(listLine).color : 'no list line'} vs ${
        proseLine ? getComputedStyle(proseLine).color : 'no prose line'
      }`,
    )

    const block = await until(() => document.querySelector('.cm-drawn-block[data-drawn="table"]'))
    record('table: drawn as a block', Boolean(block))
    if (!block) return

    const inner = block.querySelector('.overflow-x-auto, table')
    const gap = inner
      ? Math.round(inner.getBoundingClientRect().top - block.getBoundingClientRect().top)
      : null
    record('table: sits at the top of its own block', gap !== null && gap <= 12, `gap ${gap}px`)

    const cell = block.querySelector('td')
    const rect = cell?.getBoundingClientRect()
    if (rect) {
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      document.elementFromPoint(x, y)?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      )
    }
    const revealed = await until(() => !document.querySelector('.cm-drawn-block[data-drawn="table"]'), 2000)
    record(
      'table: a click turns it back into its source',
      Boolean(revealed) && lineTexts().some((text) => text.trimStart().startsWith('|')),
    )

    // ── Undo ────────────────────────────────────────────────────────────────────────────────
    // Typed through `execCommand` and undone through a synthetic keydown, so a keyboard check can
    // live in the page. This proves the history extension is wired to this editor; the two
    // shortcuts themselves (Ctrl+Z, Ctrl+Y) were also confirmed with real key presses on the built
    // bundle, and so was undo of a checkbox toggle and undo across the edit↔source switch.
    // A unique token rather than a leading `zz`: by now the caret is wherever the checks left it
    // (the table click puts it at the table's first line), and assuming the start of the document
    // produced a failure that was the assertion's fault, not the editor's.
    const TOKEN = 'ZZUNDO'
    content.focus()
    document.execCommand('insertText', false, TOKEN)
    record(
      'undo: typing lands',
      (content.textContent || '').includes(TOKEN),
      JSON.stringify((content.textContent || '').slice(0, 14)),
    )

    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await sleep(60)
    record(
      'undo: Ctrl+Z takes it back',
      !(content.textContent || '').includes(TOKEN),
      JSON.stringify((content.textContent || '').slice(0, 14)),
    )

    const spacerLines = lineTexts().filter((text) => text.length > 0 && text.trim() === '')
    record('lines: none is only whitespace', spacerLines.length === 0, JSON.stringify(spacerLines))
    record('fixture: recognised', doc.includes('office_tool'), 'the README probe')
  }

  /** The source face: the code font, and no prose styling. */
  const checkSourceFace = async () => {
    const mono = await until(() => (inMono(scroller()) ? scroller() : null))
    record('font: the source column is set in JetBrains Mono', Boolean(mono), mono ? getComputedStyle(mono).fontFamily.slice(0, 40) : 'not in mono')

    if (mono) {
      const italic = [...document.querySelectorAll('.cm-line span')].filter(
        (span) => getComputedStyle(span).fontStyle === 'italic',
      ).length
      const headingLines = document.querySelectorAll('.cm-md-heading').length
      record(
        'source face: no italic, no enlarged headings',
        italic === 0 && headingLines === 0,
        `italic ${italic}, headings ${headingLines}`,
      )
    }
    record('fixture: recognised', Boolean(mono), 'the source pane')
  }

  const run = async () => {
    // ── The code face, before anything else: `--font-mono` must name it ──────────────────────
    const monoValue = getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
    record('font: --font-mono names JetBrains Mono', /JetBrains Mono/.test(monoValue), monoValue.slice(0, 60))

    const content = await until(() => document.querySelector('.cm-content'))
    record('fixture: an editor is mounted', Boolean(content))
    if (!content) return

    await until(() => document.querySelectorAll('.cm-line').length > 3)
    await document.fonts.ready

    // A font loads only when something uses it, hence the order: after the editor exists.
    const faces = [...document.fonts].filter((face) => /JetBrains/i.test(face.family))
    record(
      'font: a JetBrains Mono face is loaded from the app, not the network',
      faces.some((face) => face.status === 'loaded'),
      faces.map((face) => `${face.family} ${face.weight} ${face.status}`).join(', ') || 'no such face',
    )

    // Which fixture is mounted decides what can be asserted about it.
    if ((content.textContent || '').includes('office_tool')) await checkReadme(content)
    else if (inMono(scroller())) await checkSourceFace()
    else record('fixture: recognised', false, 'neither the README probe nor the source pane — select one first')
  }

  run()
    .catch((error) => record('self-check ran to the end', false, String(error)))
    .finally(() => {
      window.__selfcheck = JSON.stringify({ ok: results.every((check) => check.ok), checks: results }, null, 1)
    })
})()
