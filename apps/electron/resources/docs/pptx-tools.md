# Decks: building one a page at a time

`pptx_tool create` makes a short deck in one call (`pptx-tools.md` below covers the staged flow).
The staged flow is for a deck someone will
present — where the folder is the state and every step checks before it writes.

## The staged flow

A long or design-sensitive deck is not one command. The folder is the state, and each step checks
before it writes:

```bash
office_tool deck_start decks/q3 --style style.md --outline outline.json
#   outline checked; the pages to write are listed, in order
office_tool deck_page decks/q3 --index 0 --page page0.json      # one page per call, in outline order
office_tool deck_page decks/q3 --index 1 --page page1.json
#   next: every page has a file — deck_build
office_tool deck_build decks/q3                                  # → decks/q3/deck.pptx
office_tool deck_replace decks/q3 --index 1 --page page1.json    # fix one slide, others untouched
```

- **`style.md`** names the palette as `#RRGGBB`, the fonts and the layout variants; pages are checked
  against the colors it names (`offPalette` lists the ones it does not).
- **`outline.json`** is the plan: `{ topic, core_hook, pages: [{ title, type, layout, brief, image_queries }] }`
  (`guide slides spec`). Its `pages` array decides how many pages the deck has.
- **`pages/NN.json`** is one page: `{ title, type, layout, elements: [...] }` echoing its outline entry
  (the checks compare them, the builder ignores them). Elements are px on a 1280×720 canvas.
- A page that fails its check is **not kept** — fix it and run the same command again. Pages are
  written in outline order; `deck_build` refuses while one is missing.

`deck_replace` is the fix round: it re-checks one page and rebuilds only that slide. After building,
look at it: `render decks/q3/deck.pptx` (needs a renderer — the app, or a hub's headless Chromium)
or `check decks/q3/deck.pptx` for overflow, which needs none.

