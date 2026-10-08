# Designs

Designs are persistent, self-hosted HTML mini apps stored in the workspace and rendered inside the app (sidebar → **Designs**). Use them for dashboards, reports, trackers, and small tools that should outlive the conversation — optionally auto-refreshed on a schedule and shareable as password-protected public links.

## Folder layout (managed — do not edit directly)

```
{workspace}/designs/{slug}/
├── design.json          # config/manifest (watcher trigger — always written LAST)
├── index.html         # the design content (sha256 digest tracked in design.json)
└── data/
    ├── store.sqlite   # internal store (scripts only — never read this)
    └── snapshot.json  # the ONLY data artifact designs/hosts read
```

Always use the session tools (`create_design`, `update_design`, `write_design_data`, `delete_design`) instead of file tools. They keep content digests, grants, the config watcher, and open renders consistent. `list_designs` / `get_design` are read-only and return absolute paths when you do need to Read something (e.g. `data.snapshotPath`).

## What a design is

Every design has a **kind**, declared when it is made and stored in `design.json`. One design
is exactly one kind:

| Kind | What it is | The app… |
|------|------------|----------|
| `prototype` (default) | a page you read: a report, a calculator, a tool | renders it as it is |
| `dashboard` | a page kept **open and fed**: a real-time panel, a KPI wallboard, a decision room's screen | renders it, offers Present (fullscreen wallboard), and expects a `refresh` spec behind it |
| `deck` | slides | letterboxes it to the deck's `aspect`, shows slide navigation, exports one slide per page |
| `motion` | a self-driving timeline | offers **Video** in Export… |

The **`deck` / `motion` settings are the parameters of that kind**, not a second way of saying
what the design is: passing them settles the kind (passing `deck` settings *is* saying "this is
a deck"), and a kind that contradicts settings being written is refused with the reason. A deck
does not also export video — make it a `motion` composition if that is what it is. The kind is
what the designs list filters by and what the badges show.

## Scripts and data

Every design runs its own scripts in an opaque sandbox (never `allow-same-origin`, no
external requests), and the document's own markup decides what it does.

The host **pushes a fresh snapshot into the open frame whenever the data changes** (a
scheduled refresh script, or `write_design_data`). The document decides what to do with it:
render it and the page follows its data, ignore it and the page stays the snapshot it was
opened as. Nothing has to be declared for either.

## Dashboards

A **dashboard** is the kind for a page nobody reads once: it is kept open — on a KPI screen, in a
decision room — and fed. Declaring it buys two things beyond the badge it shows: **Present**
(full-screen, chromeless — a wallboard), and the expectation that a schedule runs behind it
(`refresh`), so the frame it replaces itself in stays current.

The artifact's **own controls are what pull the data**; there is no host-side parameter panel to
learn. A control changes what should be shown, and the page asks for it through a granted action
(see "Granted actions" below) — GET actions need no user gesture, so a filter or a range picker
can fetch by itself the moment it changes:

```js
// The parameters ride in the path, and the grant's pattern has to allow them:
//   approved: { kind: 'api', sourceSlug: 'metrics', method: 'GET', pathPattern: '^/kpi(\\?.*)?$' }
post({ type: 'action', requestId: crypto.randomUUID(), nonce, grantId: rangeGrant.id,
       invocation: { kind: 'api', method: 'GET', path: '/kpi?range=' + encodeURIComponent(range) } })
// …and render the body when the action-result arrives.
```

Two things this kind deliberately does **not** promise yet. The page cannot remember its controls
across a reload — the frame is an opaque origin, so there is no `localStorage` and no URL to carry
them — so a dashboard should open on defaults and refetch, and parameters set by a person live for
as long as the page does. And a dashboard has no export of its own beyond PDF/HTML/ZIP: it is a
surface, not a deliverable.

## Frames and a canvas

A prototype is usually **several screens in one document** — a flow you can walk through and a canvas
you can look at. The design owns all of it: the host cannot read your DOM (the frame is an opaque
origin), so everything it shows about your canvas, you tell it. There is one recommended shape.

**Nothing here is configured.** A multi-frame canvas is a *convention the document follows*, exactly
as a deck's `<section class="slide">` is one: `design.json` carries no shape for a prototype, the host
renders whatever the document does, and a prototype that has a shape worth stating states it in its own
markup and code — its frames — never in config. The one thing the host says about a canvas is the
poster hint (see "The cover is a full view"), and a design may ignore it.

### The shape

- **Frames on a canvas, each at its own size.** Screens are laid out at fixed pixel sizes in a *world*
  coordinate space, and a **camera** (zoom + offset) decides what the viewport shows. A screen is never
  resized to fit a pane: that is what keeps text crisp and the design honest. (Measured: scaling a
  nested *iframe* with `transform` is a soft bitmap; scaling DOM re-rasterises. Scale the **world**,
  never a nested document. `will-change` does not rescue the soft case.)
- **The fragment is the camera's address.** `#signup` points the camera at that frame — the frame's own
  element — so a frame is a real link, a reload keeps its place, and a deep link works. A name that
  matches no frame is not an error: the canvas shows the first frame.
- **In-document links are driven in script** — `preventDefault()` + `location.hash = …`. A `srcDoc`
  frame refuses an anchor's own navigation (rule 3 above), and the same code stays correct at the
  design's own address, where anchors do navigate by themselves.
- **100% is the resting state.** Zoom is a camera move somebody asks for; a canvas that silently fits
  itself to the pane is indistinguishable from a dashboard.
- **The canvas has no keyboard model.** A deck owns the keyboard because a deck *is* a presentation; a
  canvas is not, and walking its screens with Tab was not worth its weight. The rail and the zoom buttons
  are real buttons — that *is* the keyboard path to the camera — so the document listens for no keys of
  its own, and there is no focus ring to explain and no tab order to get lost in.
  The wheel pans — except over content in a frame that scrolls itself, which keeps its wheel until it
  reaches its end. Shift+wheel is the horizontal wheel, and ⌘/Ctrl-wheel or a pinch zooms.
- **One screen is one element.** A frame is a `<section class="artboard" id="signup" data-name="Sign up">`
  in `#world` — the same convention a deck's `<section class="slide">` is, and the markup *is* the list:
  the element's `id` is what a fragment names, `data-name` is the label, and `--w`/`--h` is its own
  pixel size. Nothing is declared twice, and a frame that is added, renamed or removed is exactly one
  edit in one place.
- **The canvas clips; it never scrolls.** A fragment names a real element now, so the browser would
  otherwise scroll the canvas to "show" the frame you asked for — fighting the camera that is already
  showing it. `overflow: clip` (not `hidden`, which script can still scroll) is what keeps the two
  from disagreeing. A frame is a camera position, not a scroll target.
- **The host draws no canvas chrome.** It renders the frame and that is all — the rail, the zoom and
  what is on screen belong to the document, exactly as a deck owns its own navigation. The one thing
  the host does ask for is a still, for the cover (see "The cover is a full view").
- **One artboard is one page for export.** `.artboard` is the unit the exporter walks, exactly as
  a deck's `.slide` is: one PNG per frame **at the frame's own size** (the exporter parks it at the
  origin at 1:1, so nothing is scaled and no camera is involved), one PPTX page per frame, and — with
  the print rule in the starter, which releases `html, body` from the camera's viewport, since a root
  that clips cannot break across pages — one PDF page per frame. Nothing to configure for it either.
- **A frame's name is part of what a camera move frames.** The label sits above the frame, so a focus
  that ignores it puts the label off the top of the view.
- **Until a person moves the camera, it follows the viewport.** A container that is still settling —
  or a host rendering you at another size — must never end up with a camera aimed at a viewport that
  no longer exists. The first real gesture (or a camera move the host asks for) hands it over.

### Starter: a multi-frame canvas

Complete and measured: the world + camera (100% default, Fit, pointer-anchored ⌘/Ctrl-wheel zoom
and pinch, drag-to-pan and arrow keys), the frame rail, the fragment router, and the poster view.
Copy it, then add one `<section class="artboard">` per screen — nothing else has to change.

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Flow</title>
<style>
  * { box-sizing: border-box }
  html, body { margin: 0; height: 100%; overflow: clip; background: #e7eaf0; color: #111;
    font: 13px/1.45 system-ui, sans-serif }
  body { display: flex }
  aside { width: 200px; flex: none; background: #fff; border-right: 1px solid #dcdfe6;
    display: flex; flex-direction: column }
  aside h2 { margin: 0; padding: 12px 14px 8px; font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; color: #6b7280 }
  #rail { padding: 0 8px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
    min-height: 0 }
  #rail button { all: unset; padding: 7px 9px; border-radius: 8px; cursor: pointer }
  #rail button[aria-current="true"] { background: rgba(79,70,229,.10) }
  #rail small { display: block; color: #6b7280; font-variant-numeric: tabular-nums }
  main { position: relative; flex: 1; overflow: clip; touch-action: none; cursor: grab }
  main.dragging { cursor: grabbing }
  #world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform }
  .artboard { position: absolute; left: 0; top: 0 }
  .label { position: absolute; left: 0; top: -22px; font-size: 11.5px; color: #6b7280; white-space: nowrap }
  .artboard[aria-current="true"] .label { color: #4f46e5; font-weight: 600 }
  .frame { width: var(--w); height: var(--h); background: #fff; border: 1px solid #dcdfe6;
    border-radius: 12px; overflow: hidden; box-shadow: 0 10px 26px rgba(16,24,40,.10);
    user-select: none }
  /* Panning is a gesture, not a selection — but a real field must stay selectable. */
  .frame input, .frame textarea, .frame select, .frame [contenteditable] { user-select: text }
  .artboard[aria-current="true"] .frame { outline: 2px solid #4f46e5 }
  .screen { height: 100%; padding: 24px 20px; display: flex; flex-direction: column; gap: 12px }
  .btn { border: 0; border-radius: 9px; background: #4f46e5; color: #fff; padding: 11px 14px;
    font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; text-align: center }
  #zoom { position: absolute; right: 14px; bottom: 14px; display: flex; align-items: center; gap: 2px;
    background: rgba(255,255,255,.95); border: 1px solid #dcdfe6; border-radius: 9px; padding: 4px 5px;
    color: #6b7280; font-variant-numeric: tabular-nums }
  #zoom button { all: unset; min-width: 26px; height: 24px; text-align: center; border-radius: 6px;
    color: #111; cursor: pointer }
  /* Two stills, and they are not the same picture.
     `poster` — the cover: the whole canvas, your chrome hidden, frames drawn the way you draw them.
     `export` — a page on its way out: the frame IS the page, so nothing is drawn around it. */
  body.poster > aside, body.poster #zoom, body.poster #hint { display: none }
  body.export .label { display: none }
  body.export .artboard[aria-current="true"] .frame { outline: none }
  body.export .frame { border: 0; border-radius: 0; box-shadow: none }
  /* PDF: one page per frame, and nothing of the canvas in between. The root boxes have to let go
     first: `height: 100%; overflow: clip` is the camera's viewport, and a root that clips cannot
     be broken across pages — leave it and every frame lands on one clipped page (measured). */
  @media print {
    html, body { height: auto; overflow: visible }
    body > aside, #zoom, #hint, .label { display: none }
    .artboard[aria-current="true"] .frame { outline: none }
    .frame { border: 0; border-radius: 0; box-shadow: none }
    #world { position: static; transform: none !important }
    .artboard { position: static; transform: none !important; margin: 0; break-after: page; page-break-after: always }
  }
</style>
</head>
<body>
<aside>
  <h2>Frames</h2>
  <nav id="rail" aria-label="Frames"></nav>
</aside>

<main aria-label="Prototype canvas">
  <div id="world">
    <section class="artboard" id="one" data-name="One" style="--w:390px; --h:844px">
      <div class="screen">
        <h1 style="font-size:22px;margin:0">One</h1>
        <a class="btn" href="#two">Continue</a>
        <div style="flex:1"></div>
        <div style="font-size:11.5px;color:#6b7280">Replace this with the real first screen.</div>
      </div>
    </section>

    <section class="artboard" id="two" data-name="Two" style="--w:390px; --h:844px">
      <div class="screen">
        <a href="#one" style="color:#4f46e5;text-decoration:none">← Back</a>
        <h1 style="font-size:22px;margin:0">Two</h1>
        <div style="flex:1"></div>
        <div style="font-size:11.5px;color:#6b7280">Fit, bottom right, shows the whole canvas.</div>
      </div>
    </section>
  </div>
  <div id="zoom" role="group" aria-label="Zoom">
    <button type="button" data-zoom="out" title="Zoom out">−</button><span id="zoomLabel">100%</span>
    <button type="button" data-zoom="in" title="Zoom in">+</button>
    <button type="button" data-zoom="fit" style="min-width:38px">Fit</button>
  </div>
  <div id="hint" style="position:absolute;left:14px;bottom:16px;color:#6b7280;font-size:11.5px">
    Click a frame to open it at 100% · Fit shows all · drag to pan · ⌘/Ctrl-wheel or a pinch to zoom
  </div>

</main>

<script>
  // Frames on a canvas with a camera — not a set of show/hide modes. Each screen keeps its own
  // pixel size (nothing is resized to fit the view), the camera decides what you see, and the
  // fragment is where it points. Add a <section class="artboard"> per screen and you have a flow.
  var GAP = 64, PAD = 40, LABEL_H = 26, MARGIN = 28, MIN_ZOOM = 0.1, MAX_ZOOM = 4

  var canvas = document.querySelector('main')   // the canvas is the <main>; it has no id to name
  var world = document.getElementById('world')
  var rail = document.getElementById('rail')
  var zoomLabel = document.getElementById('zoomLabel')
  var camera = { z: 1, x: 0, y: 0 }
  var current = null
  var placed = []
  // Until a person moves the camera it follows the viewport, so a container that is still
  // settling — or a host rendering a still — never ends up with a camera aimed at a viewport
  // that no longer exists.
  var cameraOwned = false
  function ownCamera() { cameraOwned = true }

  /** The markup is the list: every <section class="artboard"> in #world is one frame. The id is
   *  what the fragment names, data-name is the label, --w/--h is the screen's own pixel size.
   *  Nothing here is a second copy of anything in the markup. */
  function build() {
    placed = []
    rail.innerHTML = ''
    ;[].forEach.call(world.querySelectorAll('.artboard'), function (el, n) {
      var id = el.id
      var w = parseInt(getComputedStyle(el).getPropertyValue('--w'), 10)
      var h = parseInt(getComputedStyle(el).getPropertyValue('--h'), 10)
      if (!id || !w || !h) return console.warn('artboard #' + (id || n) + ' needs an id and --w/--h — skipped')
      if (!el.dataset.built) {
        // The screen becomes the frame's content; the label stays outside it, or the frame's
        // overflow would clip the name off. A rebuild never wraps twice.
        el.dataset.built = '1'
        var frame = document.createElement('div')
        frame.className = 'frame'
        while (el.firstChild) frame.appendChild(el.firstChild)
        el.appendChild(frame)
        el.appendChild(document.createElement('span')).className = 'label'
      }
      var name = el.dataset.name || id
      el.querySelector('.label').textContent = name + ' · ' + w + '×' + h
      var last = placed[placed.length - 1]
      placed.push({ f: { id: id, name: name, w: w, h: h }, el: el, y: PAD, x: last ? last.x + last.f.w + GAP : PAD })

      var btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.frame = id
      btn.innerHTML = '<b>' + name + '</b><small>' + w + '×' + h + '</small>'
      btn.addEventListener('click', function () { ownCamera(); location.hash = '#' + id })
      rail.appendChild(btn)
    })
    layout()
    apply()
  }

  var sized = function () { return canvas.clientWidth >= 80 && canvas.clientHeight >= 80 }

  /** Place every artboard at its world position — the pass the camera then looks at. */
  function layout() {
    placed.forEach(function (p) { p.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)' })
  }

  function apply() {
    world.style.transform = 'translate(' + camera.x + 'px,' + camera.y + 'px) scale(' + camera.z + ')'
    zoomLabel.textContent = Math.round(camera.z * 100) + '%'
    ;[].forEach.call(rail.children, function (b) {
      b.setAttribute('aria-current', String(b.dataset.frame === current))
    })
    placed.forEach(function (p) { p.el.setAttribute('aria-current', String(p.f.id === current)) })
  }

  /** Centre a world rectangle if it fits; otherwise align its top-left, with a margin. */
  function lookAt(x, y, w, h, zoom) {
    if (!sized()) return
    camera.z = zoom
    var vw = canvas.clientWidth, vh = canvas.clientHeight, sw = w * zoom, sh = h * zoom
    camera.x = sw <= vw - 2 * MARGIN ? (vw - sw) / 2 - x * zoom : MARGIN - x * zoom
    camera.y = sh <= vh - 2 * MARGIN ? (vh - sh) / 2 - y * zoom : MARGIN - y * zoom
    apply()
  }

  /** A frame's rect INCLUDING its name: the label sits above the frame, so it is part of the shot —
   *  and a name wider than its frame is part of the width, or a shot cuts the end off it. */
  function widthOf(p) { return Math.max(p.f.w, p.el.querySelector('.label').offsetWidth) }
  function rectOf(p) { return { x: p.x, y: p.y - LABEL_H, w: widthOf(p), h: p.f.h + LABEL_H } }

  /** Select a frame and look at it. A name that matches no frame shows the first one. */
  function focusFrame(id, zoom) {
    var p = placed.filter(function (q) { return q.f.id === id })[0] || placed[0]
    if (!p) return
    current = p.f.id
    var r = rectOf(p)
    lookAt(r.x, r.y, r.w, r.h, zoom === undefined ? 1 : zoom)   // 100% by default: a real 100%
  }

  function fitAll() {
    if (!sized() || !placed.length) return
    var x0 = Math.min.apply(null, placed.map(function (p) { return p.x }))
    var y0 = Math.min.apply(null, placed.map(function (p) { return p.y - LABEL_H }))
    var x1 = Math.max.apply(null, placed.map(function (p) { return p.x + widthOf(p) }))
    var y1 = Math.max.apply(null, placed.map(function (p) { return p.y + p.f.h }))
    var w = x1 - x0, h = y1 - y0
    var fit = Math.min(
      (canvas.clientWidth - 2 * MARGIN) / w,
      (canvas.clientHeight - 2 * MARGIN) / h,
      1,                                    // never magnify past 100%: that would only lie
    )
    lookAt(x0, y0, w, h, Math.max(MIN_ZOOM, fit))
  }

  /** Zoom about a view point: whatever is under it stays under it. */
  function zoomAbout(next, vx, vy) {
    var z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    var wx = (vx - camera.x) / camera.z, wy = (vy - camera.y) / camera.z
    camera.z = z
    camera.x = vx - wx * z
    camera.y = vy - wy * z
    apply()
  }

  function fromHash() {
    var id = location.hash.replace('#', '')
    if (!id) return fitAll()      // no fragment yet: the overview
    focusFrame(id)
  }

  // Writing a #fragment at boot is not a gesture. Without this guard the camera hands itself over
  // the moment the document loads — measured: still aimed at the viewport it loaded in, which put
  // the first frame 251px past where a 700px container centres it — and nothing later could fix it.
  var bootHash = false
  addEventListener('hashchange', function () {
    if (bootHash) { bootHash = false; fromHash(); return }
    ownCamera(); fromHash()
  })

  ;[].forEach.call(document.querySelectorAll('#zoom button'), function (b) {
    b.addEventListener('click', function () {
      ownCamera()
      if (b.dataset.zoom === 'fit') return fitAll()
      zoomAbout(camera.z + (b.dataset.zoom === 'in' ? 0.25 : -0.25), canvas.clientWidth / 2, canvas.clientHeight / 2)
    })
  })

  // Content inside a frame that scrolls itself keeps the wheel until it reaches its end, so a
  // screen may hold a real list. ⌘/Ctrl always zooms, whatever is under the pointer.
  /** The wheel's axis for this event: Shift turns a mouse's vertical wheel into a horizontal one. */
  function wheelAxis(e) {
    var sideways = e.shiftKey && !e.deltaX
    return { x: sideways ? e.deltaY : e.deltaX, y: sideways ? 0 : e.deltaY }
  }

  function scrollsItself(e, d) {
    var vertical = Math.abs(d.y) >= Math.abs(d.x)
    for (var el = e.target; el && el !== canvas; el = el.parentElement) {
      var s = getComputedStyle(el)
      if (vertical) {
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight &&
          (d.y > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0)) return true
      } else if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth &&
        (d.x > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return true
    }
    return false
  }

  canvas.addEventListener('wheel', function (e) {
    var d = wheelAxis(e)
    if (!e.ctrlKey && !e.metaKey && scrollsItself(e, d)) return
    e.preventDefault()
    ownCamera()
    if (e.ctrlKey || e.metaKey) return zoomAbout(camera.z * Math.exp(-e.deltaY / 320), e.offsetX, e.offsetY)
    camera.x -= d.x
    camera.y -= d.y
    apply()
  }, { passive: false })

  // One pointer pans, two pinch — the same handlers, so a trackpad and a touchscreen both work.
  var pointers = new Map(), pinch = null, dragging = false, sx = 0, sy = 0
  function endDrag(e) {
    if (e) pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (pointers.size) return
    dragging = false
    canvas.classList.remove('dragging')
  }
  function two() { return Array.from(pointers.values()) }
  function midpoint() {
    var xy = two(), r = canvas.getBoundingClientRect()
    return { x: (xy[0].x + xy[1].x) / 2 - r.left, y: (xy[0].y + xy[1].y) / 2 - r.top }
  }
  function spread() { var xy = two(); return Math.hypot(xy[0].x - xy[1].x, xy[0].y - xy[1].y) }
  canvas.addEventListener('pointerdown', function (e) {
    // A control in a frame is not the canvas: pressing it must not start a pan.
    if (e.target.closest('#zoom, a, button, input, textarea, select, [contenteditable]')) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ownCamera()
    // (No focus() here: a click already focuses the canvas, and a script focus during a
    // pointer gesture is what makes Chromium paint the keyboard ring on a plain click.)
    if (pointers.size === 2) {
      pinch = { spread: spread(), zoom: camera.z }
      dragging = false
      return void canvas.classList.remove('dragging')
    }
    if (pointers.size > 2) return
    dragging = true; sx = e.clientX; sy = e.clientY
    canvas.classList.add('dragging')
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && pointers.size >= 2) {
      var m = midpoint()
      return zoomAbout(pinch.zoom * spread() / pinch.spread, m.x, m.y)
    }
    if (!dragging) return
    camera.x += e.clientX - sx; camera.y += e.clientY - sy
    sx = e.clientX; sy = e.clientY
    apply()
  })
  canvas.addEventListener('pointerup', function (e) {
    endDrag(e)
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  })
  // An interrupted pointer (a system gesture, the window losing focus) is not an ending: without
  // this the canvas keeps panning after the gesture is gone.
  canvas.addEventListener('pointercancel', endDrag)

  // Follow the canvas box, not the window. A container can change size with no window resize at
  // all (a design's own chrome appearing or hiding), a resize event can arrive before the new
  // layout, and a container with no size yet has nothing to frame — the observer runs after
  // layout, so what it reads is the size that is.
  new ResizeObserver(function () { if (!cameraOwned) fromHash() }).observe(canvas)

  // A `srcDoc` frame refuses an anchor's own navigation, so in-document links are driven here.
  // The same code is right at the design's own address, where anchors navigate by themselves.
  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href^="#"]') : null
    if (!link) return
    e.preventDefault()
    ownCamera()
    location.hash = link.getAttribute('href')
  })

  // Tell the host what this render is for. The host is deliberately thin: it draws no rail and
  // no zoom of its own, because the canvas and its navigation belong to this document. What it
  // does say is which still it wants — a cover (the whole canvas) or an export (one page).
  addEventListener('message', function (e) {
    var m = e.data
    if (!m || m.protocol !== 'craft-designs/v1' || m.type !== 'init') return
    var payload = m.payload || {}
    document.body.classList.toggle('poster', Boolean(payload.poster))
    document.body.classList.toggle('export', Boolean(payload.export))
    if (payload.poster) { cameraOwned = true; fitAll() } else if (!cameraOwned) fromHash()
  })

  build()
  if (!location.hash && placed.length) { bootHash = true; location.hash = '#' + placed[0].f.id }
  fromHash()
</script>
</body>
</html>
```

### The cover is a full view

`init` carries **`poster: true`** when the host is rendering a *still* (the design's cover in the
grid). Show the overview then — every frame visible, nothing clipped — and hide your own chrome for
the shot. A cover that is a crop of whichever screen the camera happened to be on is a bad cover, and
one the host cannot fix for you: it cannot see your canvas.

```js
if (m.type === 'init') {
  const poster = Boolean(m.payload && m.payload.poster);
  document.body.classList.toggle('poster', poster);
  if (poster) fitAll(); else fromHash();
}
```
```css
body.poster > aside, body.poster #zoom, body.poster #hint { display: none }
```

It is a hint, not a mode: a design that ignores it simply gets a still of whatever it was showing.
The cover **keeps the canvas as you draw it** — frames are cards, with their names — because a cover
is a picture *of the canvas*.

### An export is a page, not the canvas

Exporting (the **Export…** menu) sends **`poster: true` *and* `export: true`**. The first still hides
your chrome; the second says the picture is a **page**, so a frame's own drawing goes with it — corner
radius, border, shadow, selection ring, name — and what lands in the PDF or the PNG is the screen
itself, edge to edge. Measured on a design authored from this starter: answering only `poster` exported
the rounded corners (the canvas showing through them), the 1px border and the current-frame ring.

```css
body.export .label { display: none }
body.export .artboard[aria-current="true"] .frame { outline: none }
body.export .frame { border: 0; border-radius: 0; box-shadow: none }
```

A **deck** needs none of this — a slide has no card drawn around it, and `poster` already hides its
page dots. The same three rules also belong under `@media print`: printing the document yourself is
the same wish as an export, and no host sends the flag then.

### Before you say it works

This is where authors go wrong — silently, in ways no error surfaces. So open the design at its own
address (`get_design` returns `previewUrl`) and **measure**:

```text
browser_tool: tab-new <previewUrl>          # or navigate to it in the workspace browser
browser_tool: viewport-resize 1000 625      # the size the host renders a still at
browser_tool: evaluate …                    # frame rects, labels, zoomLabel, location.hash
```

1. **Every frame's rect *and* its name are inside the viewport** on focus — the label is above the
   frame, so it is the first thing to fall off the top.
2. **The zoom readout reads 100%** on a frame, and `Fit` really fits (labels included).
3. **`location.hash` matches the frame the camera is on** (so a reload and a deep link land there).
4. **The document's own controls move the camera** — the rail, ⌘/Ctrl-wheel, drag, `Fit` — and
   `location.hash` follows the frame you pick.
5. **`poster: true` shows the overview** with your chrome hidden — and `export: true` drops the
   frame's own drawing (corners, border, shadow, ring, name), so the page is the screen.
6. **A touch works too** — a pinch zooms; a frame holding a real list scrolls under the wheel; and the
   rail scrolls once you have more frames than fit in it.

**To look at one page** — the thing a person does by clicking a frame, without the UI. The fragment
points the camera, so a shot of the frame's own element is a shot of that page:

```text
browser_tool: tab-new <previewUrl>#home   # the fragment names the frame: 100%, that screen
browser_tool: screenshot-region --selector "#home" --padding 0   # the frame *is* the element
```

A shot is all or nothing: if the frame is wider than the pane, the region shot **fails** and tells you
the size to give the tab — `viewport-resize <w> <h>`, then shoot again. That resize does reflow the
page (a design's camera re-frames with it — which is what keeps 100% crisp), and it is an explicit act
rather than something a screenshot does behind your back. `--force` takes the incomplete image anyway,
and then the result says what was cut.

Traps that fail silently, all measured: **forgetting to position the artboards at all** (they pile up
at the world origin and the camera frames "intended" positions — this survived a visual check and was
caught only by measuring); an anchor with no matching `id`; a `:target` rule whose target does not
exist; `transform` not shrinking the layout box (so the scrollable area and the centring are wrong —
pad the world by its scaled size instead); a zero-sized viewport making a naive fit compute 0.


### Opening a design as a page

A design has an **address** — `get_design` returns it as `previewUrl` (`craft-local://<slug>-<hash>/
index.html`) — and that address works in the workspace browser window, so `browser_tool` can
`navigate` to it, `snapshot`, `evaluate`, screenshot it or click through it.

**Write a design so it renders the same in both places.** The address serves `data/snapshot.json`, so
the design can simply fetch it:

```js
fetch('data/snapshot.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(render)
if (window.parent !== window) {          // a host is present: it also pushes replacements
  addEventListener('message', (e) => {
    if (e.data?.protocol === 'craft-designs/v1' && (e.data.type === 'init' || e.data.type === 'data'))
      render(e.data.payload.snapshot)
  })
  parent.postMessage({ protocol: 'craft-designs/v1', type: 'ready' }, '*')
}
```

That is the whole isomorphism: **one data shape, two ways in** — a fetch for wherever the page is
opened (a tab with no host included), and the host's push for the live case. The fetch is ignored
when it throws, which is what a published copy does (`connect-src 'none'`) — there the pushed
snapshot is what renders, and with no data opted in the page shows its own empty state.

Two things to know about that origin. A plain tab has **no host bridge**, so nothing pushes to it
and it renders the snapshot as of the moment it loaded (reload, or poll, to refresh). And inside
`data/` **only `snapshot.json` is served** — the store (`store.sqlite`, its `-wal`/`-shm`) is the
script-private working file and is not on that origin at all. Writing data stays asymmetric on
purpose: a design cannot write its own store, it asks the host (a `script` grant, approved by you,
run with the credentials the page never sees).

## Data model

Each design has a small data store with two shapes:

- **kv** — `key → any JSON value` (objects/arrays fine). For current values: settings, latest totals, status objects.
- **series** — named timeseries of `{ t: epoch ms, v: number }` points. For anything charted over time. `(series, t)` writes are idempotent upserts, so re-running a write is safe.

`write_design_data` applies one transactional patch and regenerates `data/snapshot.json`:

```
write_design_data({
  slug: "build-health",
  set: { summary: { total: 42, failing: 3 }, updatedBy: "agent" },
  delete: ["obsolete_key"],
  appendSeries: { "ci.duration_ms": [{ v: 84213 }, { t: 1756165200000, v: 79544 }] },
  pruneSeries: { "ci.duration_ms": 1748000000000 }
})
```

The snapshot the design receives looks like:

```json
{
  "version": 1,
  "generatedAt": 1756191234567,
  "kv": { "summary": { "total": 42, "failing": 3 } },
  "series": { "ci.duration_ms": [ { "t": 1756165200000, "v": 79544 } ] }
}
```

Series are ascending by `t`, capped at the newest 1000 points per series. The store itself is bounded too: at most **1000 kv keys** and **100 distinct series** per design — a write that would exceed either limit fails whole (rolled back) with a clear error. Design keys/series as stable names you update, not as ever-growing sets (put lists inside one kv value; don't mint `item-<id>` keys or per-day series names).

## Authoring design HTML

Rules that make designs work everywhere (local sandbox AND published copies):

1. **One full standalone HTML document.** Inline ALL CSS and JS. No external requests of any kind — published copies are served with `connect-src 'none'` (all network egress blocked), so CDN scripts, fonts, or fetch() calls would break them. Render charts with inline SVG/canvas you draw yourself.
2. **Data arrives via the bridge, not fetch.** The host injects the data snapshot through `postMessage`, and pushes a replacement whenever the data changes.
3. **Anchors do not navigate — set the fragment from script.** A design frame's document is a
   `srcDoc` (`about:srcdoc`), which is **not a navigable target**: a click on `<a href="#x">` does
   nothing at all (measured, with a real click and with `a.click()` alike). `location.hash = '#x'`
   **does** work in the same frame, so keep the `href` for semantics and drive it yourself:
   ```js
   document.addEventListener('click', (e) => {
     const link = e.target.closest('a[href^="#"]')
     if (!link) return
     e.preventDefault()
     location.hash = link.getAttribute('href')
   })
   ```
4. **The iframe is opaque-origin** (`sandbox` without `allow-same-origin`): no cookies, no localStorage, no parent DOM access. Keep state in JS variables.

### Bridge snippet (copy-paste)

```html
<script>
  let nonce = null;

  function render(snapshot) {
    // snapshot = { version, generatedAt, kv, series } or null (no data yet)
    // ... update the DOM ...
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.protocol !== 'craft-designs/v1') return;
    if (msg.type === 'init') {           // { design: {slug}, nonce, snapshot, grants }
      nonce = msg.payload.nonce;
      handleGrants(msg.payload.grants);  // [{ id, action, expiresAt }] — usable grants
      render(msg.payload.snapshot);
    } else if (msg.type === 'data') {    // the data changed — render it if the page follows the data
      render(msg.payload.snapshot);
    } else if (msg.type === 'action-result') {
      handleActionResult(msg.payload.result);  // { requestId, ok, status?, body?, error?, durationMs }
    } else if (msg.type === 'grants') {  // reply to 'grant-request' + pushed on grant changes
      handleGrants(msg.payload.grants);
    }
  });

  // Ask the host for init (also delivered automatically after load)
  window.parent.postMessage({ protocol: 'craft-designs/v1', type: 'ready' }, '*');
</script>
```

### Opening external links

Sandboxed designs cannot navigate. Ask the host (only http/https URLs, requires a user gesture):

```js
window.parent.postMessage({ protocol: 'craft-designs/v1', type: 'open-url', nonce, url: 'https://example.com' }, '*');
```

## Decks

A design is a **deck** when its `kind` is `deck` (`design.json`):

```json
"deck": { "aspect": "16:9", "theme": "swiss" }
```

`aspect` is one of `16:9` (default), `4:3`, `16:10`, `9:16`; `theme` is free-form
provenance. Pass it to `create_design` / `update_design` (`null` turns a deck
back into a plain document). **The slide count is not stored** — see below.

### Slide markup

```html
<section class="slide">…</section>
<section class="slide">…</section>
<section class="slide">…</section>
```

One `<section class="slide">` per slide, in order. The **deck owns navigation**:
the host never drives it, so wire keyboard (←/→, PageUp/PageDown, Space),
wheel, touch and page dots yourself and toggle a `.slide.active` class (or any
mechanism you like — the host does not read your DOM; the frame is an opaque
origin).

Make the deck focus itself on load and on first pointer interaction, or keys
will not reach it. Size slides against the frame's viewport (`100%`/`dvh`),
not a fixed pixel width — the host letterboxes the frame to `aspect`.

### Reporting the count and position

The host shows a `current / total` counter, which it can only learn from you.
Post this on load and after every slide change:

```js
const post = (payload) => parent.postMessage(
  { protocol: 'craft-designs/v1', ...payload }, '*')

const slides = document.querySelectorAll('.slide')
const report = () => post({
  type: 'deck',
  slides: slides.length,
  current: [...slides].findIndex(s => s.classList.contains('active')),
})
report() // and call it whenever the active slide changes
```

The counter is display state: it is bounded (≤ 1000 slides, and `current` must
be inside range) but carries no capability, so it needs no nonce. Omitting it
just leaves the counter at `– / –`.

### Starter deck

A complete, self-contained deck: Swiss-ish grid, keyboard/wheel/touch/dot
navigation, the count/position report, and one-slide-per-page printing. Copy it,
replace the content of the `<section>`s, and pass `deck: { aspect: '16:9' }` to
`create_design`. A slide has an address — `#3` is slide 3 — so a reload keeps your place and a
link to a slide is a link.

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Quarterly review</title>
<style>
  :root { --ink: #111; --muted: #777; --accent: #d33; --bg: #fafaf8; }
  * { box-sizing: border-box; }
  @page { size: 1280px 720px; margin: 0 }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink);
    font: 16px/1.5 -apple-system, system-ui, "Helvetica Neue", sans-serif; }
  #deck { height: 100% }
  .slide { display: none; height: 100%; padding: 8% 10%;
    grid-template-columns: repeat(12, 1fr); grid-auto-rows: min-content; gap: 12px 24px; }
  .slide.active { display: grid }
  h1 { grid-column: 1 / 10; font-size: 56px; line-height: 1.05; margin: 0; letter-spacing: -0.02em; }
  h2 { grid-column: 1 / 13; font-size: 13px; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--muted); margin: 0; font-weight: 600; }
  p, ul { grid-column: 1 / 9; margin: 0; font-size: 20px; }
  ul { padding-left: 20px } li + li { margin-top: 6px }
  .rule { grid-column: 1 / 13; height: 2px; background: var(--ink) }
  .stat { grid-column: 1 / 5; font-size: 72px; font-weight: 700; letter-spacing: -0.03em }
  .stat span { display: block; font-size: 13px; font-weight: 500; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted) }
  .accent { color: var(--accent) }
  #dots { position: fixed; right: 3%; bottom: 3%; display: flex; gap: 8px }
  #dots button { width: 8px; height: 8px; padding: 0; border: 0; border-radius: 50%;
    background: #0003; cursor: pointer }
  #dots button[aria-current="true"] { background: var(--ink) }
  /* A still has no page indicator: an export (and the cover in the grid) sets `body.poster`, so
     the picture is the slide, not the slide plus its controls. */
  body.poster #dots { display: none }
  @media print {
    .slide { page-break-after: always; break-after: page }
    .slide, .slide.active { display: grid }   /* every slide prints, not just the active one */
    #dots { display: none }
  }
</style>
</head>
<body>
<div id="deck">
  <section class="slide active">
    <h2>Quarterly review</h2>
    <div class="rule"></div>
    <h1>Two systems, one <span class="accent">queue</span>.</h1>
  </section>
  <section class="slide">
    <h2>Where we are</h2>
    <div class="rule"></div>
    <div class="stat">12.4k<span>requests / day</span></div>
    <div class="stat accent">−38%<span>p95 latency</span></div>
    <ul><li>Batch path retired in February</li><li>Every consumer now drains the same queue</li></ul>
  </section>
  <section class="slide">
    <h2>What's next</h2>
    <div class="rule"></div>
    <ul><li>Retire the legacy shim in Q3</li><li>Move the replay tool behind a grant</li></ul>
  </section>
</div>
<nav id="dots" aria-label="Slides"></nav>

<script>
  const slides = [...document.querySelectorAll('.slide')]
  const dots = document.getElementById('dots')
  let index = 0

  const post = (payload) => window.parent.postMessage({ protocol: 'craft-designs/v1', ...payload }, '*')

  function go(next) {
    index = Math.max(0, Math.min(slides.length - 1, next))
    slides.forEach((s, i) => s.classList.toggle('active', i === index))
    ;[...dots.children].forEach((d, i) => d.setAttribute('aria-current', String(i === index)))
    report()
  }

  function report() { post({ type: 'deck', slides: slides.length, current: index }) }

  // Navigation writes the address and the address drives navigation: a reload keeps your place,
  // a link to a slide is a link, and Back/Forward work. Booting does not write it, so merely
  // opening a deck adds no history entry of your own.
  function nav(next) { go(next); location.hash = '#' + (index + 1) }
  addEventListener('hashchange', () => {
    const n = parseInt(location.hash.slice(1), 10)
    if (isFinite(n)) go(n - 1)
  })

  slides.forEach((_, i) => {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.addEventListener('click', () => nav(i))
    dots.appendChild(dot)
  })

  addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); nav(index + 1) }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); nav(index - 1) }
    else if (e.key === 'Home') nav(0)
    else if (e.key === 'End') nav(slides.length - 1)
  })

  let wheelLock = 0
  addEventListener('wheel', (e) => {
    const now = Date.now()
    if (now < wheelLock || Math.abs(e.deltaY) < 12) return
    wheelLock = now + 350
    nav(index + (e.deltaY > 0 ? 1 : -1))
  }, { passive: true })

  let touchStartX = 0
  addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX }, { passive: true })
  addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX
    if (Math.abs(dx) > 40) nav(index + (dx < 0 ? 1 : -1))
  }, { passive: true })

  // Keys only reach us once the frame has focus; take it and keep it.
  addEventListener('pointerdown', () => document.body.focus())
  document.body.tabIndex = -1
  document.body.focus()

  addEventListener('message', (e) => {
    const msg = e.data
    if (!msg || msg.protocol !== 'craft-designs/v1' || msg.type !== 'init') return
    // `poster` = the host is rendering a still (an export, or the design's cover): hide the
    // chrome that belongs to using the page rather than to a picture of it.
    document.body.classList.toggle('poster', Boolean(msg.payload && msg.payload.poster))
    report()
  })
  const start = parseInt(location.hash.slice(1), 10)
  go(isFinite(start) ? start - 1 : 0)   // also reports the count on load
</script>
</body>
</html>
```


### Presenting

The host adds one control: **View Fullscreen**, which takes the letterboxed
frame full-screen (Esc leaves). For a printable one-slide-per-page PDF, add:

```css
@page { size: 1280px 720px; margin: 0 }
@media print { .slide { page-break-after: always; break-after: page } }
```

### Exporting

The **Export…** menu (desktop app only) offers **PDF**, **PPTX**, **HTML** and
**ZIP** for every design, plus **PNG (one image per slide)** for a deck and
**Video** for a `motion` composition.

**The PPTX is editable.** It is built from the rendered DOM by the vendored
`dom-to-pptx` engine, which turns text into real PowerPoint text boxes and
boxes/borders/gradients into native shapes — not a screenshot. A deck becomes
**one PPTX slide per `<section class="slide">`, in DOM order**; a plain design
becomes a single slide holding the page. The deck's `aspect` sets the slide
size. Two consequences are worth knowing before you rely on it:

- The engine **rebuilds the layout from measured geometry** — every element is
  placed absolutely. Text stays editable, but it will not reflow like a
  placeholder-based deck, so editing the wording in PowerPoint can overflow the
  box it was drawn in.
- It serializes to shapes, so effects with no native PowerPoint equivalent are
  approximated or dropped rather than reproduced — background/backdrop blur,
  blend modes, and WebGL/canvas content are the usual casualties of this kind of
  engine. Use **PDF**, or **PNG (one image per slide)**, when exact pixels matter
  more than editability (and always eyeball the result on your own deck).



Interactive designs can trigger calls against the workspace's sources (e.g. a "Send email" button using a connected Google source) — **without ever seeing credentials**. The design posts an action request; the host validates it against a **grant** and executes server-side.

```js
window.parent.postMessage({
  protocol: 'craft-designs/v1',
  type: 'action',
  requestId: crypto.randomUUID(),
  nonce,                                   // from init — required
  grantId: 'grant_1a2b3c4d',               // an approved grant on this design
  invocation: { kind: 'api', method: 'GET', path: '/health' }  // must match the grant
}, '*');
// Result arrives as an 'action-result' message (match by requestId).
```

### Requesting grants from inside the design

A design asks for the grants it needs with a `grant-request` message; the host shows the user
an approval dialog and answers with a `grants` message (the full list of currently usable
grants). Match grants to needs by comparing `action` descriptors — do NOT hardcode grant ids.

```js
let grants = [];                            // [{ id, action, expiresAt }]
function grantFor(action) {                 // find by descriptor, never by id
  return grants.find(g => g.action.kind === action.kind
    && g.action.sourceSlug === action.sourceSlug
    && (action.kind === 'mcp' ? g.action.toolName === action.toolName
        : g.action.method === action.method && g.action.pathPattern === action.pathPattern));
}
function handleGrants(list) { grants = list || []; /* enable/disable buttons */ }

const NEEDS = [
  { key: 'read',  description: 'Refresh the task list',
    action: { kind: 'mcp', sourceSlug: 'craft-private', toolName: 'craft_read' } },
  { key: 'write', description: 'Add and complete tasks',
    action: { kind: 'mcp', sourceSlug: 'craft-private', toolName: 'craft_write' } },
];
// After init: request anything still missing (max 8 entries per request).
if (NEEDS.some(n => !grantFor(n.action))) {
  window.parent.postMessage({ protocol: 'craft-designs/v1', type: 'grant-request', nonce, requests: NEEDS }, '*');
}
```

Denied descriptors are remembered for the rest of the render — re-requesting them is answered
with the current grant list instead of another dialog, so designs cannot nag. Design for denial:
keep the design useful with buttons disabled and show what approval would unlock.

What you must know about grants:

- Grants are **user-approved capabilities** persisted in the design config: `{ kind: 'api', sourceSlug, method, pathPattern }` (anchored regex), `{ kind: 'mcp', sourceSlug, toolName }`, or `{ kind: 'script', script, runtime?, args? }` (see below). You cannot mint them with a session tool — the design requests them (`grant-request`) and the user approves them in the host dialog.
- Grants are bound to the **exact content digest** at approval time and have a hard expiry (30 days). Editing the design's HTML invalidates all grants by design — the design should simply re-request on next open.
- The user can **remove any approval at any time** (design ⋯ menu → Approved actions, or inline in the Share dialog). Open renders receive an updated `grants` message when that happens, so drive button state from `handleGrants` instead of caching the init-time list.
- If a granted source **loses authentication**, actions fail fast with an error starting with `source-auth-required` (e.g. `source-auth-required: reconnect "gmail" in the app`). The host shows a reconnect banner above the design. Treat it as retryable: show a "reconnect in the app" hint and let the user simply click again after reconnecting — do not permanently disable the button.
- Only **api GET** actions may run without a user gesture. Everything else — api non-GET, **every mcp tool** (opaque: it may write), and **every script** — requires a fresh user gesture inside the design (button click): fire the action directly from the click handler, never from a timer or on load. For data that should be visible on open, render from the snapshot and make live calls button-driven.
- Per-frame caps: 5 requests in flight, 1 mutating at a time, 30/minute. Cancel with `{ type: 'action-cancel', requestId, nonce }`.
- Published (shared) copies never execute actions — viewers get `public-actions-disabled`.

`get_design` lists existing grants with a `stale` flag (digest mismatch or expired).

### Running a host script (script grants)

A `script` grant lets a **local** design run a workspace-relative script on the host machine — the highest-privilege action a design can take. It reuses the same runner as scheduled refreshes: **argv spawn (never a shell)**, path confined to the workspace (symlink-aware), a `CRAFT_*`-only environment (no `PATH`, no credentials), and a 60s default timeout (15min max).

```js
// Descriptor requested via grant-request:
//   { kind: 'script', script: 'designs/<slug>/build.sh', runtime: 'bun'|'node'|'python3'?, args?: string[] }
// The invocation is a BARE TRIGGER — script/runtime/args all come from the grant:
window.parent.postMessage({
  protocol: 'craft-designs/v1', type: 'action',
  requestId: crypto.randomUUID(), nonce,
  grantId: scriptGrant.id,
  invocation: { kind: 'script' }              // nothing else — the design cannot pass args
}, '*');
// action-result body → { exitCode, stdout, stderr }. ok === (exitCode === 0),
// but stdout/stderr are returned even on a non-zero exit.
```

Rules specific to script grants:

- **Args are pinned at approval time.** The design cannot supply or change `script`/`runtime`/`args` at call time — approving a grant approves one exact command, not a family of them. To vary behavior, approve a wrapper script (e.g. `run.sh`) and let it decide.
- **Match by descriptor** the same way as other kinds, but on `script` + `runtime` (defaulting to `bun`) + ordered `args` — there is no `sourceSlug`/`toolName`.
- **Always mutating** — only fire from a real click handler; it will be rejected without fresh user activation.
- **Not shareable.** A design that holds a script grant **cannot be published** at all (publish fails with `DESIGN_SHARE_SCRIPT_GRANT`) — even the inert view-only path is refused, and stale/expired script grants count too. The user can remove the approval (⋯ → Approved actions, or inline in the Share dialog) and then publish; you cannot revoke grants with a tool. Mention this trade-off when adding a script action to a design the user may want to share.
- The script's working directory is the workspace root; `CRAFT_DESIGN_DIR` / `CRAFT_DESIGN_DATA_DIR` / `CRAFT_WORKSPACE_PATH` point it at the design's own data. Running a script does **not** touch the design's scheduled-refresh status.

## Motion

A design is a **motion composition** when its `design.json` carries a `motion`
hint:

```json
"motion": { "fps": 30, "durationMs": 5000, "aspect": "16:9" }
```

Pass it to `create_design` / `update_design` (`null` turns a motion composition
back into a plain document). The HTML is the **source**; the rendered MP4 is the
deliverable.

| Field | Default | Bounds | Meaning |
|-------|---------|--------|---------|
| `fps` | `30` | `1`–`60` | frames captured per second |
| `durationMs` | `5000` | `100`–`600000` | how long the piece runs (10 min max) |
| `aspect` | `16:9` | `16:9` / `4:3` / `16:10` / `9:16` | frame size (same union as a deck) |

The timeline itself is **not** stored here — it lives in your HTML/CSS. `motion`
is only the render hint, so it can never disagree with what the composition does.

### What the composition must do

The renderer loads it in a hidden window and records it **in realtime**, so the
composition has to:

1. **Drive its own timeline on load** — start playing as soon as the document is
   ready. The renderer does not seek, dispatch events, or wait for a click.
2. **Need no user input** — no buttons, no hover, no scroll to reveal content. It
   is recorded off-screen, where nothing can interact with it.
3. **Size against the viewport** (`100%` / `dvh`), not a fixed pixel width — the
   render window is already the `aspect` size, so nothing is letterboxed.
4. **Keep painting for the whole piece.** The capture is a screencast of the
   page's paints; a composition that finishes early, or that sits still with no
   animation, records little or nothing.

Keep the document standalone and inline (CSS + JS, no external requests), exactly
as for any other design — the render window loads the same file.

### Exporting

With `kind: 'motion'` the design's **Export…** menu gains a **Video** entry
(desktop app only — it needs the app's own Electron renderer). It records the
piece once and writes an **MP4** to the file you pick. A build that cannot
negotiate an MP4 encoder refuses the export rather than quietly writing another
container.

### Determinism caveat

Capture is **realtime and wall-clock bound, not frame-exact.** The composition
plays while frames are pulled from Chromium's screencast and handed to the
encoder, and `MediaRecorder` stamps them by the wall clock — so rendering the
same composition twice gives the same *content* and roughly the same length, but
individual frame timings (and an occasional dropped or duplicated frame under
load) are not reproducible down to the millisecond. It is a screen recording of a
timeline, not an offline frame-by-frame render: do not rely on frame-perfect
output.

## Scheduled refresh

Give a design a `refresh` spec (on `create_design` or `update_design`) to update its data deterministically — no agent session is created:

```
refresh: { cron: "*/15 * * * *", script: "scripts/refresh-build-health.ts" }
```

The cron expression is validated on write: it must parse, must actually fire, and must not run more often than **every 5 minutes** (`*/5 * * * *` is the fastest accepted schedule) — an invalid spec makes `create_design`/`update_design` fail with the reason.

The script must live **inside the workspace** and runs under **Bun** with a minimal environment: `CRAFT_WORKSPACE_PATH`, `CRAFT_DESIGN_SLUG`, `CRAFT_DESIGN_DIR`, `CRAFT_DESIGN_DATA_DIR` (plus other `CRAFT_*` vars). Flow: update the store → export the snapshot → exit 0. The executor stamps `design.json` afterwards, which pushes the new snapshot to open renders.

```ts
// scripts/refresh-build-health.ts  (Bun)
import { openDesignDataStore } from '@craft-agent/shared/designs/data-store';

const store = openDesignDataStore(process.env.CRAFT_WORKSPACE_PATH!, process.env.CRAFT_DESIGN_SLUG!);
const res = await fetch('https://ci.example.com/api/summary');   // scripts CAN use the network
const summary = await res.json();
store.kvSet('summary', summary);
store.seriesAppend('ci.duration_ms', { v: summary.durationMs });
store.exportSnapshot();
store.close();
```

If `@craft-agent/shared` is not resolvable from the workspace (e.g. packaged installs), write a self-contained script with `bun:sqlite` against `$CRAFT_DESIGN_DATA_DIR/store.sqlite` using this exact schema, and write the snapshot atomically (temp file + rename) to `$CRAFT_DESIGN_DATA_DIR/snapshot.json`:

```sql
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS timeseries (series TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL, PRIMARY KEY (series, t)) WITHOUT ROWID;
```

(kv `value` is JSON-encoded; snapshot shape as shown above. Simpler alternative: skip the script and update the design yourself with `write_design_data`.)

## Sharing

Users publish designs from the design's **Share** button (feature-flagged): password-protectable public URL, opt-in data snapshot, instant revocation. You don't publish designs yourself — but remember: published copies block all network egress and disable source actions, which is why inline-everything authoring matters. `delete_design` unpublishes first (best effort) and reports `publicCopyMayRemain` if that could not be confirmed.

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
  let nonce = null;

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

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.protocol !== 'craft-designs/v1') return;
    if (msg.type === 'init') { nonce = msg.payload.nonce; render(msg.payload.snapshot); }
    else if (msg.type === 'data') { render(msg.payload.snapshot); }
  });
  window.parent.postMessage({ protocol: 'craft-designs/v1', type: 'ready' }, '*');
</script>
</body>
</html>
```

## Recipes

- **"Make me a dashboard of X that updates every N minutes"** → `create_design` (kind `dashboard`, content + `refresh` spec) → write the refresh script into the workspace → seed initial data with `write_design_data` so it isn't empty before the first tick. A page that renders on the `data` message follows the data while it stays open; one that renders only on `init` stays put.
- **"Track this number over time"** → design with a series chart; append points with `write_design_data` whenever you learn a new value (idempotent by timestamp).
- **"Turn this report into something I can share"** → `create_design` (fully inline HTML) → tell the user to use the Share button for a password-protected link.
- **Iterating on a design** → `update_design` with new `content`; warn the user that existing grants go stale on content changes.
