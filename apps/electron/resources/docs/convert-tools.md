# Turning one format into another: `convert_tool`

**Read this before your first `convert_tool` command.** It is the matrix — which directions exist,
which of them need a renderer, and where the result goes next.

Conversions live in a door of their own because they are the one thing whose **source and target
disagree**. Every other tool acts on a file it is named for; this one is asked "make it into that", and
whichever way you go there is nothing to look up.

```bash
convert_tool convert <file> --to pdf|docx|xlsx|pptx|md|html|csv [--out <file>] [--sheet <n>] [--password <pw>]
```

## The matrix

`genoffice` reports it itself when asked for a direction it does not have — this is the same list:

```
pdf     → docx, pptx, xlsx, md, html
docx    → md, pdf, html
md      → docx, html, pdf
html    → pdf, docx
xlsx    → csv, pdf
csv     → xlsx, pdf
xls     → xlsx, pdf
xlsb    → xlsx
xlsm    → csv, pdf
ods     → xlsx
ots     → xlsx
odt     → docx        ott → docx
odp     → pptx        otp → pptx
pptx    → pdf
```

Anything not on it is refused, and the refusal carries this list — a `docx → csv` is not a thing the
engine does, and the answer says which routes it does have rather than failing obscurely.

## What runs where

| target | needs |
|---|---|
| `md`, `csv` | nothing — the engine reads and writes them in this process |
| `docx`, `xlsx`, `pptx` | nothing, **except** `html → docx`, which lays a page out first |
| `pdf` | a **renderer**: something has to lay the document out and print it |

A renderer is the app on a desktop and a headless Chromium on a hub. When the host has neither, the
command **says so by name** and leaves the file as it was — it does not write a half-converted file,
and it does not silently produce a different thing.

`--to pdf` prints the document: page size and margins come from the document's own settings, so the
result is what the editor's Export as PDF would give. `--sheet <n>` picks a sheet when the source is a
workbook; `--password` opens an encrypted source.

## Where the result goes next

The target format decides which door owns the file afterwards:

- a `.docx` → `docx_tool` (read it, change it, redline it)
- a `.xlsx` → `xlsx_tool`
- a `.pptx` → `pptx_tool`
- a `.pdf` → `pdf_tool` (read its text, split or merge pages)
- `md` / `csv` / `html` → plain files: `Read` them, or `Edit` them

Two habits worth having:

- **`read` what you just converted.** A PDF's text layer, a converted deck's slides, a workbook's
  cells: the conversion is a claim about the file, and reading it is how you find out the claim was
  optimistic.
- **Prefer converting to `md` for reading.** `docx → md` keeps tables as tables and headings as
  headings, which is what a model can actually work with, and it needs no renderer.
