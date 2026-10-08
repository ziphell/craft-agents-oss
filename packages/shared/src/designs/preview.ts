/**
 * Where a design is rendered from, now that the host serves it instead of injecting it.
 *
 * A design used to reach its frame as a `srcDoc` string, which is what forced the
 * whole thing into one inlined document: no base URL means no relative stylesheet,
 * no module script, no image beside it. Served from the app's own scheme the folder
 * is a folder again — the document, its assets, its own origin — and the fragment in
 * the address is a real fragment (measured: on a `craft-local` address an anchor
 * navigates and the fragment survives a reload, both of which a `srcDoc` document
 * refuses).
 *
 * The label is derived the same way as for every other directory the app serves
 * (`localHostLabel`: the readable slug plus a hash of the directory, so two designs
 * with the same slug in two workspaces get two origins), and the reverse lookup is
 * by construction rather than by parsing the label back — the hash cannot be
 * un-hashed, and pretending otherwise is how two designs would end up sharing an
 * address.
 *
 * Pure and browser-safe (the renderer imports the address form).
 */

import { localHostLabel, localHostOrigin } from '../local-origin.ts';

/** The host label a design folder is served at. */
export function designPreviewLabel(designSlug: string, designDir: string): string {
  return localHostLabel(designSlug, designDir);
}

/** The address of a design's document — what a frame loads instead of a `srcDoc`. */
export function designPreviewUrl(designSlug: string, designDir: string): string {
  return `${localHostOrigin(designPreviewLabel(designSlug, designDir))}/index.html`;
}

/**
 * The directory a label names, among the designs that exist — `null` when it names
 * none of them. Compiled from the candidates rather than parsed, because the label
 * carries a hash whose whole job is not to be reversible.
 */
export function designDirForLabel(
  label: string,
  candidates: readonly { slug: string; dir: string }[],
): string | null {
  for (const candidate of candidates) {
    if (designPreviewLabel(candidate.slug, candidate.dir) === label) return candidate.dir;
  }
  return null;
}
