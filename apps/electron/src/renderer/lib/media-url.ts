/**
 * The URL a project media file is played from.
 *
 * A media element needs an address it can **seek** — refresh, scrub, sample a frame — and neither a
 * data URL nor base64 gives it one. So the file is served instead: the desktop app answers on
 * `craft-local://media/`, the hub on `/api/media`, both with `Range`. The preview also fetches the
 * same URL to decode a clip's sound (`preview/audio-graph.ts`), so the response is CORS-clean.
 *
 * The path is absolute (a project folder plus `assets/x.mp4`); the server checks it against the
 * workspaces root, so this helper only has to say which door to knock on.
 */

const isDesktop = typeof window !== 'undefined' && window.location.protocol === 'file:'

export function mediaUrl(path: string): string {
  const query = `path=${encodeURIComponent(path)}`
  return isDesktop ? `craft-local://media/?${query}` : `/api/media?${query}`
}
