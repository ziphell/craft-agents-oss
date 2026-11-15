# PDF: reading it, and assembling pages

`office_tool pdf …` never needs a renderer — pdfium and pdf-lib do the work in this process.
The commands themselves are the `pdf_tool` brief; this is the detail behind them.

## Reading it

```bash
office_tool pdf report.pdf --range 1-5          # the text layer, page by page
office_tool pdf help                            # every page-and-mark command
```

The text layer, page by page (1-based), with the page size and the document's title/author. Reads
pages 1–20 by default and says how to get the rest; `--full` reads every page uncapped. A scanned
page comes back with empty text — that is a scan; `pdf ocr` reads one page locally, and a vision
model is for what the page means.

## Scanned pages — one page at a time

```bash
office_tool pdf ocr scan.pdf --page 3                      # the words on page 3
office_tool pdf ocr scan.pdf --page 3 --json               # + line boxes and confidence
office_tool pdf ocr scan.pdf --page 3 --out page-3.md      # write .txt / .md / .json
office_tool pdf ocr report.pdf --page 3 --force            # read the pixels even though it has text
```

`pdf ocr` draws the one page you name with pdfium and reads it with the bundled PP-OCR model — no
upload and no account. The app's editor reads scanned pages on its own when a document opens (up to
40 per pass, cancellable); this command is the **explicit** one-page door: exactly the page named,
for an agent that wants the words or a file without opening an editor. `--max-side` (default 1600)
trades memory and time for small print; `--json` answers the same fields `img-tool text` does
(`width`, `height`, `text`, and per-line `text` / `confidence` / `box`). Install the models once with
`bun run fetch:ocr-models` and rebuild the tools (`bun run build:cli-tools`); without them the
command says so instead of failing at the engine.

**Before drawing anything, it asks the page.** pdfium reports the page's own text-layer character
count and the share of the page covered by its single largest image. A page with 100 characters or
more and no page-sized picture is answered with that text (`"engine": "text-layer"`, `"skipped"` says
why), so OCR is not paid for twice and a good text layer is not replaced by a worse one. A scan still
goes through the recogniser: no text at all, **or** one picture across 70% of the page — the second is
the scanned sheet whose letterhead is the only real text, which used to be mistaken for a text page.
`--force` reads the pixels regardless; `textLayerChars` and `imageCoverage` ride every answer.

## Pages and marks — one file in, one file out, `--out` required:

```bash
office_tool pdf info report.pdf                                     # pages, sizes, metadata, form fields
office_tool pdf split report.pdf --pages "1-3,7" --out part.pdf      # keep those pages
office_tool pdf reorder report.pdf --order "3,1,2" --out fixed.pdf   # same pages, that order
office_tool pdf merge cover.pdf body.pdf --out report.pdf            # one file, that order
office_tool pdf rotate scan.pdf --angle 90 --out upright.pdf
office_tool pdf crop scan.pdf --rect "0.05,0.05,0.95,0.95" --out trimmed.pdf
office_tool pdf watermark draft.pdf --text "CONFIDENTIAL" --opacity 0.12 --out draft-marked.pdf
office_tool pdf header-footer report.pdf --text "内部资料 {page}" --out numbered.pdf
office_tool pdf from-image shot1.png shot2.jpg --out shots.pdf       # one page per image
office_tool pdf fill-form form.pdf --data values.json --out filled.pdf
```

- Pages count from **1**, everywhere; `--rect` is fractions of the page (0–1).
- `--out` never overwrites an existing file unless `--force` is given.
- Text drawn on a page — a watermark, a header — uses a standard PDF font, which is **Latin-1**:
  Chinese comes back as `?` with `textHonoured: false`. A **form field** with such a value is not
  filled at all and is listed under `failed` with the reason; the rest of the fields still are.
  The app's editor embeds your fonts, which is the way to get Chinese into either.
- No encryption writing and no redaction here: pdf-lib does not write an encrypted file, and a
  redaction that is not verified is worse than none. Open those in the app.

