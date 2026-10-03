# Tweaks

A tweak is a **standing edit to a page nobody here owns**: "on our admin console, show the order id next to the customer name". It is one folder holding the pages it is for and the CSS and/or JavaScript that does it, and it is applied **every time one of those pages loads** — in an ordinary browser, whether or not this app is running anywhere near it. That last part is what sets a tweak apart from an edit that is only made while somebody is looking at the page: the tweak is the standing version of that same edit.

Two carriers deliver a tweak, and they are built from the same files:

- **the app's own browser window** — the tab a person browses in, while this app runs. This is the one you can watch, drive with `browser_tool`, and check.
- **a loadable extension** — built from the same files by **Export as extension…** on a tweak's page, and the only way a tweak reaches the browser somebody actually works in, on their own machine or somebody else's.

The tweak is the fact; the carrier is how it travels. Both read the same `matches` and the same code, which is why the patterns are Chrome's own grammar rather than something richer (`create_tweak` explains that contract).

## Folder layout (the files are the truth)

```
{workspace}/tweaks/{slug}/
├── tweak.json    # which pages it is for, and whether it is on — the only two facts
│                 # that cannot be expressed by a file sitting there
├── tweak.css     # the stylesheet those pages get — optional
├── tweak.js      # the JavaScript that runs on them — optional
└── hits.json     # the app's own record of the @target selectors it has seen
                  # (written by the app's carrier, never by hand)
```

There is no index or manifest: the folder is read as it is, and either of the two code files may be missing. A folder with neither is a tweak that does nothing yet — an author part-way through writing one, which is normal rather than an error.

Edit any of these however you like, including with `Write`/`Edit`. The app watches the record **and the code**: every write re-installs the rules, so the next load of a matching page gets what you just wrote.

## When a page gets it

A tweak is a **rule set**, evaluated once per document:

- It is installed when the rules change (a switch, a write) and when an address moves.
- Each document gets the rules that were installed at its birth, and **keeps them for its whole life**.
- Nothing is ever taken back from a page that already exists — not by switching a tweak off, not by editing it, not by deleting it.

So: **a change shows up on the next load of a matching page.** Reload is the reset, and `browser_tool`'s `reload` is how you look at a change. A document that is already open keeps what it was born with, which also means:

- Switching a tweak on does not put it on the page a person is looking at.
- A single-page app's route change is not a load: a tweak that only covers the deeper route applies when that address is actually loaded, not when a router reaches it.
- A tweak's JavaScript cannot run twice on one page. That is why switching a tweak off and on again changes nothing on a document that already has it.

The rule behind all of that: a tweak can only ever be added, never cleanly removed. Its CSS could be pulled out again, but its JavaScript cannot — what it did to a document is history nobody has a record of. Pulling the stylesheet out from under it would leave the page in a state its author never wrote, so the two files go together and a **load** is what resets a page.

Where *inside* that load the JavaScript runs is the tweak's own business — `@run-at`, under **Writing the code**.

## The switch

**A tweak is created off, and stays off until somebody turns it on.** It injects into pages that person is signed in to, so naming those pages is not the same consent as agreeing to run the code in them — that judgement is theirs, and `update_tweak` with `enabled: true` is you acting on it when they asked for the change to take effect. Say plainly when a tweak is off.

A tweak that is off is not a tweak running quietly: it is not delivered to any document, and the exported extension leaves it out of the build.

## Match patterns

`matches` are **Chrome match patterns**, at least one, and a pattern that cannot be parsed is refused on write rather than silently matching nothing:

```
*://*.example.com/admin/*     that console, and its subdomains, under /admin
https://reports.internal/     exactly that page
*://*/admin/*                 any host, under /admin
```

The parts that bite:

- **The path is anchored.** Only a trailing `*` runs past the end, so `/admin/*` covers `/admin/users` but **not** `/admin` — write both, or end the pattern in `/`.
- **A host is a host, never a port.** `http://localhost:5173/*` is not a pattern; write `http://localhost/*` and use a page on the default port, or drive the page with `browser_tool` instead.
- **`*://` is the two web schemes**, not "anything" — `file:` and `ftp:` are not covered.

## Writing the code

- **The stylesheet goes in before the DOM exists**, ahead of the page's own scripts — that is the point of a tweak: the page should never show the state it is there to change. `tweak.css` on its own is often the whole tweak.
- **The JavaScript runs at the moment the tweak declares**, with `@run-at`:
  - `/* @run-at document_end */` — as soon as the DOM is complete. Where code that reaches for elements belongs, and what you get by saying nothing.
  - `/* @run-at document_start */` — before any DOM exists, for code that has to get in front of the page's own scripts. Anything that *touches* elements finds none.
  - `/* @run-at document_idle */` — whenever the browser gets round to it, after `load`.

  Write it in either file (`tweak.js` wins if both declare one). A value that is not one of the three is ignored, and `get_tweak` reports the moment in effect. It says **nothing** about the stylesheet: CSS always goes in before the DOM exists, whatever this says.
- **The two files are independent.** `tweak.css` is written into a `<style data-tweak="{slug}">` element; `tweak.js` is its own IIFE with its own `try`/`catch`, so one tweak that throws cannot stop the ones after it. A **parse** error is the honest limit: the whole script is one source, so a body that does not parse takes the others down with it.
- **Write for an ordinary browser, in the page's own world.** The code runs in a browser this app is not in, and must not depend on anything here — no imports, no app APIs, no assumption that the app is running. It runs **in the page's own JavaScript context** (the same in the exported extension), so it can reach the page's globals and its own scripts' state; what it cannot reach is any extension API.
- **Mark what you are aiming at** with a `/* @target <selector> */` comment, in either file:

```css
/* @target .order-row */
/* @target [data-testid="customer-name"] */
.order-row .customer::after { content: " · " attr(data-order-id); }
```

That marker is what the app checks for drift: each declared selector is looked for while the tweak runs, and its last match is recorded. Without it, "the page moved and my tweak is now styling nothing" is invisible.

## Drift: what `hits.json` knows

`get_tweak` reports each declared `@target` selector and when it last matched:

- **a time** — it was there the last time the tweak ran;
- **`stale: true`** — it matched before and did not last time: the page moved and the selector needs updating;
- **no time at all** — it has never matched: a different fact, and the one that says the selector was wrong from the start.

The record is written **only by the app's own carrier**, and only for the pages the app actually visited — a content script has no way back to this machine's disk. So an empty or quiet `hits.json` is not "this has never run anywhere": it is "the app's window has not watched it run".

## Reaching a real browser

Inside this app a tweak runs only in the app's own browser window. The browser somebody actually works in gets it through **the tweak page's own action**: open a tweak and press **Export as extension…** — the app asks for a folder and writes a loadable Chrome extension built from the workspace's **enabled** tweaks into `craft-tweaks/` inside it.

Exporting is the person's to do, not a command for you: the one question it asks — where the folder goes — is answered by them, in a folder picker. Say what the action is for, and what to do with what it writes:

- The build is **static**: it ships the tweak's own bytes (`tweaks/{slug}.css`, `tweaks/{slug}.js`), and its `README.md` says which pages it is for and how to remove it. Nothing updates itself — change a tweak here, export again, and the person presses **Reload** on the extension's card.
- Each tweak becomes **two content scripts**: its stylesheet at the earliest moment, its JavaScript at the `@run-at` it declares. That is why a tweak behaves the same in their browser as it does in this app's window.
- It **refuses** to write over an existing `craft-tweaks/`, and refuses to build at all when no enabled tweak has code. Both are reported with the reason.
- What they do with it: load the folder **unpacked** (`chrome://extensions` → Developer mode → Load unpacked), and reload the pages they have open — a page picks a tweak up when it **loads**, which is equally true after a re-export and after pressing Reload on the extension's card. Deleting the extension is how it is turned off, and nothing else on their machine is touched.

## Recipes

- **"Make this page behave differently for me"** → `create_tweak` with the match patterns and the CSS (that is usually the whole tweak), then `update_tweak` with `enabled: true` if they asked for the change to take effect. Mark `@target` selectors so drift is visible later.
- **"That tweak stopped working"** → `get_tweak`: a `stale` target means the page moved and the selector needs updating. Read `tweak.css`/`tweak.js` (the paths are in the response) and edit; the next load of that page picks it up.
- **"I want it in Chrome, on my own machine"** → point them at **Export as extension…** on the tweak's page (exporting is theirs to do — it needs a folder only they can choose), then tell them how to load it unpacked.
- **"Why isn't it doing anything?"** → the page was loaded before the rules changed, or the address never matched. Reload the page, and check the pattern against the address — `/admin/*` does not cover `/admin`.
