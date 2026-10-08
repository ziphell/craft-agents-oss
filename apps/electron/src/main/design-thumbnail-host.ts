/**
 * Pure helpers for design thumbnail capture — NO electron imports, so this is
 * unit-testable under bun. The Electron capture itself lives in
 * design-thumbnailer.ts and consumes these.
 *
 * The capture renders the design exactly as DesignFrame does: the design HTML is the
 * srcDoc of an opaque sandboxed iframe (never `allow-same-origin`), and the
 * trusted host posts the `craft-designs/v1` init message so data-driven designs
 * paint with their snapshot. No action bridge — a poster never executes source
 * actions.
 */

import type { DesignDataSnapshot } from '@craft-agent/shared/designs/types'
import { DESIGN_FRAME_SANDBOX } from '@craft-agent/shared/designs/sandbox'

/** Logical render viewport (16:10) the offscreen window uses. */
export const THUMB_LOGICAL_WIDTH = 1000
export const THUMB_LOGICAL_HEIGHT = 625
/** Stored poster width (height derived 16:10); keeps some retina crispness. */
export const THUMB_OUTPUT_WIDTH = 800
export const THUMB_OUTPUT_HEIGHT = 500
/** JPEG quality for the stored poster. */
export const THUMB_JPEG_QUALITY = 82

/** Escape a string for safe embedding inside a double-quoted HTML attribute (srcdoc). */
export function escapeSrcdocAttribute(html: string): string {
  return html
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Build the trusted host document loaded into the offscreen window. It embeds
 * the design content in a sandboxed iframe and delivers the data snapshot once
 * via the same bridge DesignFrame uses. Returns a full HTML string; the caller
 * loads it with `loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))`.
 */
export function buildThumbnailHostHtml(input: {
  content: string
  slug: string
  snapshot: DesignDataSnapshot | null
  /**
   * The design folder's own address, when the host serves it (see
   * design-preview-host). A design that keeps its assets beside it — a stylesheet,
   * a module script — renders correctly only from there, so a poster taken from the
   * inlined string would come out unstyled for exactly the designs that need this.
   */
  previewUrl?: string
}): string {
  const srcdoc = escapeSrcdocAttribute(input.content)
  // JSON embedded in a script; </script> in data is the only real hazard.
  const snapshotJson = JSON.stringify(input.snapshot).replace(/<\/script>/gi, '<\\/script>')
  const design = JSON.stringify({ slug: input.slug })

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: ${THUMB_LOGICAL_WIDTH}px; height: ${THUMB_LOGICAL_HEIGHT}px; overflow: hidden; background: #ffffff; }
  iframe { border: 0; width: 100%; height: 100%; display: block; background: #ffffff; }
</style>
</head>
<body>
<iframe id="frame" sandbox="${DESIGN_FRAME_SANDBOX}" referrerpolicy="no-referrer" ${input.previewUrl ? `src="${input.previewUrl}"` : `srcdoc="${srcdoc}"`}></iframe>
<script>
  var PAGE = ${design};
  var SNAPSHOT = ${snapshotJson};
  var frame = document.getElementById('frame');
  function deliver() {
    try {
      frame.contentWindow.postMessage(
        // poster: true says what this render is FOR: a still. A design that has more than
        // one screen should show its overview for it (see docs/designs.md — the cover is a
        // full view, never a crop of whatever the camera happened to be pointed at).
        { protocol: 'craft-designs/v1', type: 'init', payload: { design: PAGE, nonce: 'preview', poster: true, snapshot: SNAPSHOT } },
        '*'
      );
    } catch (e) { /* opaque-origin race — the ready handler retries */ }
  }
  frame.addEventListener('load', deliver);
  window.addEventListener('message', function (event) {
    var m = event.data;
    if (m && m.protocol === 'craft-designs/v1' && m.type === 'ready') deliver();
  });
</script>
</body>
</html>`
}
