/**
 * Does clicking this card open its composer?
 *
 * A card's purpose on this board is a **run**: a picture, a clip, a voice, or a text read out of
 * one. Clicking such a card shows the panel that made it — the prompt, the channel, the parameters
 * — because that is the information the card is *about*, and the thing the person came to change.
 *
 * A card whose material did not come from a run does not have that panel: an uploaded file, a
 * cropped or rotated picture. Clicking those selects them; double-click opens the file's own
 * surface (the lightbox for a picture). Showing a generation form over a file nobody generated
 * would be inventing a history for it.
 *
 * **Text is always its own case.** A text card's words are typed in the composer, so the composer is
 * where they belong — it is that card's editor, not a form about it. A recording placed by hand is
 * the same shape: its instruction lives in the composer.
 *
 * An **empty** card has no material and no history, and describing what it should become is the only
 * thing it can answer, so it opens its composer too.
 */
import type { CanvasNode } from '@craft-agent/shared/canvas/document'

/**
 * The operations a composer run writes. Everything else a recipe can hold is local arithmetic on a
 * file that already existed — `crop`, `rotate`, `flip`, `resize`, `convert`, `restore` — and those
 * are edits, not generations, so they keep their card closed.
 *
 * An allowlist rather than a denylist: an operation this build has never heard of is not something
 * it should confidently open a generation form for.
 */
const COMPOSER_OPS = new Set([
  'image-gen',
  'video-gen',
  'audio-gen',
  'image2txt',
  'asr',
  'text2text',
])

export function opensComposer(node: CanvasNode): boolean {
  // A text card's content is written in the composer: it *is* the editor.
  if (node.type === 'text') return true
  // Nothing to show yet: the composer is how a media card gets its first file.
  if (!node.src) return true
  if (!node.recipe) return false
  return COMPOSER_OPS.has(node.recipe.op)
}
