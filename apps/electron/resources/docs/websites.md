# Websites

A website is a **directory** in the workspace, served at an address of its own and opened as an ordinary page — a tab of the browser window. The **Websites** section lists them; opening one (from the conversation that made it, or from the library) brings the tab up, and so does the agent pointing `browser_tool` at the address. One directory is one address: `index.html` is what the address opens, and every other file in the directory is served beside it — so a website can have its own stylesheet, its own scripts, a `data.json`, another document it links to. Its address is stable, so it can keep `localStorage`, fetch its own files and its own data (`/data/snapshot.json`) as ordinary same-origin requests, and use real routes. Use it for dashboards, reports, trackers, and small tools that should outlive the conversation — optionally auto-refreshed on a schedule.

A website is the right artifact when **nobody has to implement it**: it is meant to be used as it stands, here. If instead the thing is a change to a real product — something somebody else has to build — that is a **prototype**: a folder holding the specification (`PRD.md`, numbered requirements, research, reviews), and the specification is what leaves the workbench rather than a running site.

## Folder layout (the files are the truth)

```
{workspace}/websites/{slug}/
├── index.html         # what the address opens — yours to write, edit or replace
├── ...                # anything else here is served too: /assets/app.css, /about.html
├── website.json       # config + values derived from the files (digest, refresh
│                      # outcome); never a second copy of the content, and written
│                      # LAST by a refresh run
├── thumbnail.jpg      # the cached poster (the app's, not the site's)
└── data/
    ├── store.sqlite   # internal store (scripts only — never read this)
    └── snapshot.json  # the published data — what the site itself fetches at
                       # /data/snapshot.json, and the only artifact any host reads
```

`website.json`, `thumbnail.jpg` and `store.sqlite` are the app's own bookkeeping about the website: they are **not** served on its address, and they do not travel in a copy. The one file in `data/` that is the site's own is `snapshot.json`, and it is served — that is how the site's scripts get their data.

Edit any of these files however you like — including with `Write`/`Edit`. Nothing here is off limits to file tools; the session tools (`create_website`, `update_website`, `write_website_data`, `delete_website`, `list_websites`, `get_website`) exist because they keep the *derived* state in step for you (digest, poster, watcher). Editing the files directly is the same website, one beat later: the host notices, recomputes the digest, and refreshes the poster.

## Data model

Each website has a small data store with two shapes:

- **kv** — `key → any JSON value` (objects/arrays fine). For current values: settings, latest totals, status objects.
- **series** — named timeseries of `{ t: epoch ms, v: number }` points. For anything charted over time. `(series, t)` writes are idempotent upserts, so re-running a write is safe.

`write_website_data` applies one transactional patch and regenerates `data/snapshot.json`:

```
write_website_data({
  slug: "build-health",
  set: { summary: { total: 42, failing: 3 }, updatedBy: "agent" },
  delete: ["obsolete_key"],
  appendSeries: { "ci.duration_ms": [{ v: 84213 }, { t: 1756165200000, v: 79544 }] },
  pruneSeries: { "ci.duration_ms": 1748000000000 }
})
```

The snapshot the website receives looks like:

```json
{
  "version": 1,
  "generatedAt": 1756191234567,
  "kv": { "summary": { "total": 42, "failing": 3 } },
  "series": { "ci.duration_ms": [ { "t": 1756165200000, "v": 79544 } ] }
}
```

Series are ascending by `t`, capped at the newest 1000 points per series. The store itself is bounded too: at most **1000 kv keys** and **100 distinct series** per website — a write that would exceed either limit fails whole (rolled back) with a clear error. Design keys/series as stable names you update, not as ever-growing sets (put lists inside one kv value; don't mint `item-<id>` keys or per-day series names).

## Authoring website files

Rules that make websites work in the app:

1. **Load your own files with root-absolute paths.** The directory is the site's root, so `href="/assets/app.css"` and `src="/app.js"` mean what they say on the app's address. Several files are fine; `index.html` is only what the address opens.
2. **Prefer self-contained documents.** A CDN script, a web font or a cross-host `fetch()` adds a dependency the website does not carry with it; render charts with inline SVG/canvas you draw yourself, and keep any `fetch` to your own origin.
3. **Read your data with `fetch`.** `GET /data/snapshot.json` on the site's own origin returns the published snapshot — the same shape the store has (`version`, `generatedAt`, `kv`, `series`). It is the one path under `data/` that is served, and it works wherever the site runs: in the browser window or from an exported copy. Before anything has been written the file does not exist and the answer is **404** — treat a non-OK response as "no data yet", not as an error. A page reads it when it loads, so a refresh that writes new data shows up on the next load.
4. **State belongs to the site's own origin.** The page runs at its own address, not the app's, so `localStorage`/`sessionStorage` and cookies are yours to use and survive reloads. It cannot reach the app's own document or storage.
5. **Routes work.** `history.pushState` is fine, and reloading `/orders` falls back to `index.html` (a navigation with no file behind it opens your document). What it is *not* is a second address: a `fetch('/missing.json')` is a 404, so a view worth reopening has to be reachable from a hash on load.
6. **A pick tells you which folder to edit.** When someone selects an element on the page and hands it to a conversation, the reference names the page **and** — because that page is served from this workspace — the folder it comes from (`websites/<slug>/`). Edit there; a reload shows the change. What a pick does *not* say is which line it is in: find it by the selector, the text, or what the element is. A page whose markup is built by its own JavaScript cannot be traced back this way at all — the file holds the template, not that element.

## Scheduled refresh

Give a website a `refresh` spec (on `create_website` or `update_website`) to update its data deterministically — no agent session is created:

```
refresh: { cron: "*/15 * * * *", script: "scripts/refresh-build-health.ts" }
```

The cron expression is validated on write: it must parse, must actually fire, and must not run more often than **every 5 minutes** (`*/5 * * * *` is the fastest accepted schedule) — an invalid spec makes `create_website`/`update_website` fail with the reason.

The script must live **inside the workspace** and runs under **Bun** with a minimal environment: `CRAFT_WORKSPACE_PATH`, `CRAFT_WEBSITE_SLUG`, `CRAFT_WEBSITE_DIR`, `CRAFT_WEBSITE_DATA_DIR` (plus other `CRAFT_*` vars). Flow: update the store → export the snapshot → exit 0. The executor stamps `website.json` afterwards, which the app notices; a page already open in a tab picks the new data up the next time it loads.

```ts
// scripts/refresh-build-health.ts  (Bun)
import { openWebsiteDataStore } from '@craft-agent/shared/websites/data-store';

const store = openWebsiteDataStore(process.env.CRAFT_WORKSPACE_PATH!, process.env.CRAFT_WEBSITE_SLUG!);
const res = await fetch('https://ci.example.com/api/summary');   // scripts CAN use the network
const summary = await res.json();
store.kvSet('summary', summary);
store.seriesAppend('ci.duration_ms', { v: summary.durationMs });
store.exportSnapshot();
store.close();
```

If `@craft-agent/shared` is not resolvable from the workspace (e.g. packaged installs), write a self-contained script with `bun:sqlite` against `$CRAFT_WEBSITE_DATA_DIR/store.sqlite` using this exact schema, and write the snapshot atomically (temp file + rename) to `$CRAFT_WEBSITE_DATA_DIR/snapshot.json`:

```sql
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS timeseries (series TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL, PRIMARY KEY (series, t)) WITHOUT ROWID;
```

(kv `value` is JSON-encoded; snapshot shape as shown above. Simpler alternative: skip the script and update the website yourself with `write_website_data`.)

## Exporting

A website is a directory, so handing one to someone else is a **copy**, not a build: the website's own menu has **Export a copy…**, which asks for a folder and writes `<slug>/` into it — every file of the site **including `data/snapshot.json`**, and nothing the app keeps about it (`website.json`, the poster, `store.sqlite`). The data travels because the site's own scripts read it there: a copy without it would be a site with nothing to show. It is the data as it stood at export time — nothing in the copy updates it.

The copy comes with a short `README.md` saying the one thing that otherwise looks broken: **serve the folder, don't open the file.** The site's paths are root-absolute (`/assets/app.css`), so opening `index.html` from disk resolves them against the hard drive instead of the site. Any static server is enough, and a History-API route needs that server told to fall back to `index.html`.

## Starter template

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Build Health</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
  .metric { font-size: 40px; font-weight: 700; }
  .muted { color: #777; font-size: 12px; }
  svg { width: 100%; height: 160px; }
</style>
</head>
<body>
  <h1>Build Health</h1>
  <div class="metric" id="total">—</div>
  <div class="muted" id="updated">waiting for data…</div>
  <svg id="chart" viewBox="0 0 600 160" preserveAspectRatio="none"></svg>

<script>
  function render(snapshot) {
    if (!snapshot) return;
    const summary = snapshot.kv.summary || {};
    document.getElementById('total').textContent = summary.total ?? '—';
    document.getElementById('updated').textContent = 'updated ' + new Date(snapshot.generatedAt).toLocaleString();

    const points = snapshot.series['ci.duration_ms'] || [];
    const max = Math.max(1, ...points.map(p => p.v));
    const w = 600 / Math.max(1, points.length);
    document.getElementById('chart').innerHTML = points
      .map((p, i) => `<rect x="${i * w}" y="${160 - (p.v / max) * 150}" width="${Math.max(1, w - 2)}" height="${(p.v / max) * 150}" fill="#4f7cff"/>`)
      .join('');
  }

  // The data comes from the site's own origin, as an ordinary same-origin request.
  fetch('/data/snapshot.json')
    .then((res) => (res.ok ? res.json() : null))   // 404 = nothing written yet
    .then(render)
    .catch(() => render(null));
</script>
</body>
</html>
```

## Recipes

- **"Make me a dashboard of X that updates every N minutes"** → `create_website` (content + `refresh` spec) → write the refresh script into the workspace → seed initial data with `write_website_data` so it isn't empty before the first tick.
- **"Track this number over time"** → website with a series chart; append points with `write_website_data` whenever you learn a new value (idempotent by timestamp).
- **Iterating on a website** → **edit the files** with `Write`/`Edit` (that is the normal way — the app syncs the digest and re-renders the poster for you, and it works for every file, not just `index.html`). `update_website` is for the config fields (`name`, `description`, `projectId`, `refresh`); its `content` replaces the whole `index.html` in one go, which is worth it only when the document is being rewritten rather than changed.
