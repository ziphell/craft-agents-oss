# Excel: `xlsx_tool`, and the `.xlsx` file

**Read this before your first `xlsx_tool` command.** What the file is, what each command does to it,
and the two failures that cost the most time: a Markdown table that is not data, and a formula that
is a string.

**You never write a `.xlsx`'s bytes.** The engine does, through the same write path the app's editor
uses, so a file this tool writes opens in Excel and in the app, and a file the editor saved can be
changed here.

## Getting data into a workbook

```bash
# a CSV: first row is the header; --header freezes it and adds a filter
xlsx_tool create rows.csv --out sales.xlsx --header

# a JSON 2-D array of rows, or sheets by name; a string starting with "=" is a formula
xlsx_tool create rows.json --out sales.xlsx

# the tables a document already holds — one sheet each, named after the heading above it
xlsx_tool sheets from report.md --out tables.xlsx
```

**A Markdown table is not read.** If the data is in prose, write it as CSV first — that round trip is
cheaper than transcribing cells by hand, and it is the only way the numbers stay numbers.

`sheets from` takes every table the document holds, one sheet per table, named after the heading above
it (or its `<caption>`); a table inside a fenced code block is an example and is skipped. Numbers stay
numbers only when they are unambiguous: `1,200`, `12%` and dates stay text.

An existing `--out` is refused without `--force`.

## Reading it

```bash
xlsx_tool read sales.xlsx                  # sheets, used ranges, frozen panes, filters
xlsx_tool read sales.xlsx --sheet 2 --stats
```

Cells are addressed `A1:B2`. `--stats` answers counts by type, which is how you find the column that
arrived as text. The answer carries the ids and ranges `apply` addresses.

## Changing it

```bash
xlsx_tool apply sales.xlsx --ops ops.json
xlsx_tool apply sales.xlsx --ops risky.json --dry-run
```

Ops are cell, range and sheet work: `set_cell`, `set_range`, `format_range`, `copy_range`,
`move_range`, `sort_range`, `convert_to_values`, conditional formats, data validation, column widths,
`insert_rows`, `add_sheet` / `rename-sheet` / `delete_sheet`, charts. `guide sheets` prints the list,
grouped: content / format / layout / data.

Only what you change is rewritten; the rest of the workbook keeps its bytes. `--dry-run` validates
without writing.

### One block of cells, inside the open editor

```bash
xlsx_tool write-range sales.xlsx --range B2:C3 --values rows.json --expect-empty
xlsx_tool write-range sales.xlsx --range B2:C3 --values rows.json --expect current.json
```

When the person has the workbook **open**, the write lands in their editor: one undoable step, the
rest of the sheet untouched, and nothing on disk until they save. The fingerprint is required —
`--expect-empty` for a block that is blank, `--expect <rows.json>` with what it holds now (which
`read` gives you), because a block that changed since you read it must not be overwritten.

## Templates and checks

```bash
xlsx_tool merge template.xlsx --data values.json --out filled.xlsx
xlsx_tool check sales.xlsx        # formula errors, broken names
```

`merge` fills `{{key}}` placeholders and reports what it used, what nothing used, and what it could
not resolve. `check` is the one that finds `#REF!` and a name pointing at a deleted range, and it
changes nothing.

**`shot` — a picture, not a page.**

```bash
xlsx_tool shot sales.xlsx                        # the grid as it opens
xlsx_tool shot sales.xlsx --sheet 明细 --range B40   # scrolled to that cell first
xlsx_tool shot sales.xlsx --out shots/           # keep the PNG instead of only seeing it
```

A workbook has no pages until somebody prints it, so there is no `render` here — a print job's
pagination tells a model nothing it can act on. `shot` is what a sheet actually looks like: the
grid, with its column widths, conditional colours and filter buttons. It is a **window onto the
sheet**, not the whole of it — a 5,000-row table shows the first two dozen rows from wherever you
scrolled to — so `read` and `sheets` remain the answer for values.

## What fails, and what to do about it

- **The workbook sidecar is missing** (`xlsx engine (xlsx-sidecar) not found`): reading formulas and
  writing cells need that binary; a workbook still opens and saves in the app without it. A hub image
  builds it (`scripts/build-office-native.ts`).
- **A `.docx` or `.pptx` handed to this tool** is refused by name: `docx_tool` / `pptx_tool` is the
  door, and their ops are different ops.
- **Converting** a `.xlsx` to `csv`, `pdf` or anything else is `convert_tool`'s job.
