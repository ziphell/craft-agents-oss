# Editor UI checks — what "done" means for `packages/ui` work

Written after a run of fixes that were each verified and each came back broken. The pattern was not
carelessness about the code; it was **checking the wrong artifact** and **saying "verified" about
things nobody had asserted**. This page is the correction: three checks, and a rule about what may be
called done.

## The two artifacts

| | What it is | Who sees it |
|---|---|---|
| `vite dev` (port 5219 / `playground:dev`) | source modules, HMR, no bundling | us, in the playground |
| `apps/electron/dist/renderer/index.html` | the **built** bundle | the person using the app |

The window loads `file:///…/apps/electron/dist/renderer/index.html` (logged as `Restoring window: url=…`
on every launch). A change is only in front of a person after

```bash
bun run electron:build:renderer     # ~40 s
```

and after they reload (Ctrl+R; registered in `apps/electron/src/main/menu.ts` for dev builds only).

**The built playground page is a check surface again** — `file:///…/dist/renderer/playground.html`,
the same page the app's own window loads. It used to die on load with `Cannot read properties of
undefined (reading 'getRuntimeEnvironment')`, and the cause was not `file://`: `SessionFilesSection`
read `window.electronAPI` **while its module was being evaluated**, and in a bundled build that module
lands in a chunk that runs before the playground's mock. It is a lazy call now, and the page boots.

That matters because it is the only surface where a behavioural check sees the *built* artifact. The
dev server stays useful while iterating (HMR), but a claim about what the person will see has to be
made here.

## The three checks

```bash
# 1. logic and rules — the parts that need no DOM
bun test packages/ui

# 2. the change reached the artifact
bun run electron:build:renderer && bun scripts/md-editor-buildcheck.ts

# 3. behaviour, in a real DOM — against the BUILT page (no dev server needed)
#    browser_tool: navigate file:///<repo>/apps/electron/dist/renderer/playground.html
#    # the playground restores its fixture from localStorage, so the caller picks one
#    browser_tool: evaluate localStorage.setItem('playground-selected-component','readme-probe')
#    browser_tool: reload
#    browser_tool: evaluate --file <abs path>/scripts/md-editor-selfcheck.js
#    browser_tool: evaluate window.__selfcheck          ← 12 checks
#    # and the source face
#    browser_tool: evaluate localStorage.setItem('playground-selected-component','markdown-editor-source')
#    browser_tool: reload ; evaluate --file … ; evaluate window.__selfcheck   ← 6 checks
#
#    `--file` resolves a relative path from the workspace root, so pass an absolute repo path.
```

`scripts/md-editor-buildcheck.ts` looks for one marker per behaviour inside the built bundle
(`cm-md-bullet`, `whiteSpace:"normal"`, the bundled `jetbrains-mono-*.woff2`, …). It cannot say a
behaviour is *right*, only that the code implementing it is in the file the app will load.

`scripts/md-editor-selfcheck.js` asserts in the page: the code face is the bundled JetBrains Mono and
is actually `loaded`; the source column uses it; a list draws bullets and its text is in the reading
colour; a table sits at the top of its own block (a `white-space: pre` leak showed up as a 683 px gap);
a click on a table turns it back into its source; no line is only whitespace; the source face has no
italics and no enlarged headings.

It also covers **undo**: a token is typed with `execCommand` and taken back with a synthetic
`Ctrl+Z` keydown. The shortcuts themselves were confirmed with real key presses on the built bundle,
along with two cases a page script cannot easily stage: undo of a checkbox toggle (a programmatic
change) and undo **after switching to the source face** — the editor is the same instance across that
switch, so its history survives.

One operational note: do **not** keep a static server pointed at `dist/renderer` while rebuilding —
Windows holds the open files and `electron:build:renderer` fails with `EBUSY` on its `rm -rf`.

A second note, learned the hard way: **the script must not click the sidebar to choose a fixture.**
That click races React's swap, and one run asserted against the previous fixture while reporting on
the new one. Selection goes through `localStorage` + a reload, and the script says
`fixture: recognised` false rather than passing quietly when it does not know what it is looking at.

## The rule

- **A UI change is not done until 1–3 have run and passed**, and the person has been told to reload.
- **Never write "verified" about something no check asserted.** If it was read, say "read"; if it was
  clicked once by hand, say that, and say what it did *not* cover.
- When a bug is found by hand, **add it to one of the two scripts before fixing it** — the fix should
  make a red check go green, not make a screenshot look better.

## What these still do not cover

Component-level wiring that needs a mounted React tree rather than a whole page: a widget that fails
to inherit a context (the `PlatformProvider` bug), a prop change that never repaints (the
`livePreview` redraw bug), a window that never passes a file path (the HTML file window). Those were
found by reading code. Closing that gap means a DOM test environment (`happy-dom` is not installed
today) or a longer app-level check list — see the notes in `MEMORY.md`.
