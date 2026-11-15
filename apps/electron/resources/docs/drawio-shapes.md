# drawio Shape Libraries

Shape names and style syntax for the shape libraries worth knowing when drawing a diagram.
A name goes in a cell's `style` as `shape=<prefix>.<shape>`; the file format itself is in
`drawio-tools.md` (see "Writing the file").

Six libraries are here, chosen for what this workbench draws: flows, states, page maps,
infographics. The upstream project lists 27 more — cloud architecture (`aws4` alone is 1,031
shapes), network hardware, electrical and hydraulic symbols. None of them helps draw a
product flow, and carrying them would be roughly 4,000 shape names of noise in a file the
agent reads.

Each section below is copied verbatim from next-ai-draw-io's `docs/shape-libraries/`
(Apache-2.0), whose shape names come from drawio itself. Two things worth knowing when
reading it: an entry that only repeats the library's prefix is a generator artifact rather
than a shape, and the "Shapes (n)" counts are upstream's rather than counted here.

---

# flowchart

**Type:** mxgraph shapes
**Prefix:** `mxgraph.flowchart`

## Usage

```xml
<mxCell value="label" style="shape=mxgraph.flowchart.{shape};fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
  <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
</mxCell>
```



## Shapes (35)

- `annotation_1`
- `annotation_2`
- `card`
- `collate`
- `data`
- `database`
- `decision`
- `delay`
- `direct_data`
- `display`
- `document`
- `extract_or_measurement`
- `internal_storage`
- `loop_limit`
- `manual_input`
- `manual_operation`
- `merge_or_storage`
- `multi-document`
- `mxgraph.flowchart`
- `off-page_reference`
- `on-page_reference`
- `or`
- `paper_tape`
- `parallel_mode`
- `predefined_process`
- `preparation`
- `process`
- `sequential_data`
- `sort`
- `start_1`
- `start_2`
- `stored_data`
- `summing_function`
- `terminator`
- `transfer`

---

# basic

**Type:** mxgraph shapes
**Prefix:** `mxgraph.basic`

## Usage

```xml
<mxCell value="label" style="shape=mxgraph.basic.{shape};fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
  <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
</mxCell>
```



## Shapes (31)

- `4_point_star`
- `6_point_star`
- `8_point_star`
- `banner`
- `cloud_callout`
- `cloud_rect`
- `cone`
- `cross`
- `document`
- `flash`
- `half_circle`
- `heart`
- `loud_callout`
- `moon`
- `mxgraph.basic`
- `no_symbol`
- `octagon`
- `orthogonal_triangle`
- `oval_callout`
- `parallelepiped`
- `pentagon`
- `pointed_oval`
- `rectangular_callout`
- `rounded_rectangular_callout`
- `smiley`
- `star`
- `sun`
- `tick`
- `trapezoid`
- `wave`
- `x`

---

# arrows2

**Type:** mxgraph shapes
**Prefix:** `mxgraph.arrows2`

## Usage

```xml
<mxCell value="label" style="shape=mxgraph.arrows2.arrow;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="0" y="0" width="100" height="60" as="geometry" />
</mxCell>
```

## Shapes (18)

- `arrow`
- `bendArrow`
- `bendDoubleArrow`
- `calloutArrow`
- `calloutDouble90Arrow`
- `calloutDoubleArrow`
- `calloutQuadArrow`
- `jumpInArrow`
- `quadArrow`
- `sharpArrow`
- `sharpArrow2`
- `stripedArrow`
- `stylisedArrow`
- `tailedArrow`
- `tailedNotchedArrow`
- `triadArrow`
- `twoWayArrow`
- `uTurnArrow`

---

# bpmn

**Type:** mxgraph shapes
**Prefix:** `mxgraph.bpmn`

## Usage

```xml
<mxCell value="label" style="shape=mxgraph.bpmn.shape;symbol=message;outline=throwing;" vertex="1" parent="1">
  <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
</mxCell>
```

## Parameters

- `outline` - Event type: `start`, `end`, `catching`, `throwing`, `none`
- `symbol` - Icon inside: `message`, `timer`, `error`, `cancel`, `compensation`, `link`, `terminate`, `general`, `multiple`, `rule`

## Shapes (40)

- `ad_hoc`
- `business_rule_task`
- `cancel_end`
- `cancel_intermediate`
- `compensation`
- `compensation_end`
- `compensation_intermediate`
- `error_end`
- `error_intermediate`
- `gateway`
- `gateway_and`
- `gateway_complex`
- `gateway_or`
- `gateway_xor_(data)`
- `gateway_xor_(event)`
- `general_end`
- `general_intermediate`
- `general_start`
- `link_end`
- `link_intermediate`
- `link_start`
- `loop`
- `loop_marker`
- `manual_task`
- `message_end`
- `message_intermediate`
- `message_start`
- `multiple_end`
- `multiple_instances`
- `multiple_intermediate`
- `multiple_start`
- `mxgraph.bpmn`
- `rule_intermediate`
- `rule_start`
- `script_task`
- `service_task`
- `terminate`
- `timer_intermediate`
- `timer_start`
- `user_task`

---

# sitemap

**Type:** mxgraph shapes
**Prefix:** `mxgraph.sitemap`

## Usage

```xml
<mxCell value="label" style="shape=mxgraph.sitemap.{shape};fillColor=#7ea6e0;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
</mxCell>
```



## Shapes (51)

- `about_us`
- `audio`
- `biography`
- `blog`
- `calendar`
- `chart`
- `chat`
- `cloud`
- `contact`
- `contact_us`
- `document`
- `download`
- `error`
- `faq`
- `form`
- `gallery`
- `game`
- `home`
- `info`
- `jobs`
- `log`
- `login`
- `mail`
- `map`
- `mxgraph.sitemap`
- `news`
- `page`
- `payment`
- `photo`
- `portfolio`
- `post`
- `pricing`
- `print`
- `products`
- `profile`
- `references`
- `script`
- `search`
- `security`
- `services`
- `settings`
- `shopping`
- `sitemap`
- `slideshow`
- `sports`
- `success`
- `text`
- `upload`
- `user`
- `video`
- `warning`

---

# infographic

**Type:** mxgraph shapes
**Prefix:** `mxgraph.infographic`

## Usage

```xml
<mxCell value="label" style="html=1;shape=mxgraph.infographic.shadedCube;isoAngle=15;fillColor=#10739E;strokeColor=none;" vertex="1" parent="1">
  <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
</mxCell>
```

## Shapes

- `shadedCube` (needs `isoAngle=15;`)
- `ribbonSimple` (needs `notch1=20;notch2=20;`)
- `ribbonRolled`
- `ribbonDoubleFolded`
- `shadedTriangle`
- `shadedPyramid`
- `cylinder`
- `banner`
- `flag`
