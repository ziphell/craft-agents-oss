/**
 * A web page → the snapshot a `web` source keeps.
 *
 * Extraction is Defuddle's — the same library the Obsidian Web Clipper uses — over the HTML the
 * workspace's browser window already rendered, so a logged-in, JavaScript-built page is read the
 * way the person sees it. An HTTP fetch would get the empty shell instead, which is the whole
 * reason this reads through the window rather than fetching the url itself.
 *
 * The note keeps the Clipper's default shape: YAML frontmatter (where it came from, who wrote it,
 * when it was taken) and the markdown body. Deliberately one fixed shape and no template engine —
 * a second way of describing the same thing is a second thing to keep in date.
 *
 * Known gap: content inside shadow roots is not part of `outerHTML`, so web-component-heavy pages
 * come back thin. The Clipper flattens shadow DOM before extracting; this does not (yet).
 */

import { Defuddle } from 'defuddle/node';
import { stringify as stringifyYaml } from 'yaml';
import { createHash } from 'node:crypto';

/** Page facts worth keeping, as much as the page was willing to state them. */
export interface WebSnapshotMeta {
  author?: string;
  published?: string;
  description?: string;
  site?: string;
  language?: string;
  wordCount?: number;
}

export interface WebSnapshot {
  url: string;
  title: string;
  /** The article, as markdown. */
  markdown: string;
  meta: WebSnapshotMeta;
  /** When it was taken, ms since epoch. */
  capturedAt: number;
}

/** What every snapshot carries, so a folder of them is findable. */
const SNAPSHOT_TAGS = 'clippings';

/**
 * Extract a page into a snapshot.
 *
 * `separateMarkdown` is Defuddle's Node path: it produces the article as markdown through the real
 * `turndown` build, whereas `defuddle/full`'s `createMarkdownContent` is the browser bundle and
 * wants a global `document` this side does not have.
 *
 * Async extractors are turned off on purpose: they fetch third-party APIs (YouTube transcripts,
 * Reddit threads) over the network, which would quietly bypass the logged-in window this exists to
 * read through — and hang a plain article when there is nothing to fetch. What the window rendered
 * is the source of truth here.
 */
export async function buildWebSnapshot(input: {
  html: string;
  url: string;
  capturedAt?: number;
}): Promise<WebSnapshot> {
  const result = await Defuddle(input.html, input.url, { useAsync: false, separateMarkdown: true });

  return {
    url: input.url,
    title: (result.title ?? '').trim(),
    markdown: (result.contentMarkdown ?? '').trim(),
    capturedAt: input.capturedAt ?? Date.now(),
    meta: {
      author: trimOrUndefined(result.author),
      published: trimOrUndefined(result.published),
      description: trimOrUndefined(result.description),
      site: trimOrUndefined(result.site),
      language: trimOrUndefined(result.language),
      wordCount: result.wordCount > 0 ? result.wordCount : undefined,
    },
  };
}

/**
 * The snapshot as the file's own content: frontmatter, then the body.
 *
 * Empty facts are left out rather than written as blanks — a missing line says the page did not
 * state it, which is the same thing and quieter.
 */
export function renderWebSnapshotNote(snapshot: WebSnapshot): string {
  const created = new Date(snapshot.capturedAt).toISOString().slice(0, 10);

  const fields: Record<string, unknown> = {
    title: snapshot.title || undefined,
    source: snapshot.url,
    author: snapshot.meta.author,
    published: snapshot.meta.published,
    created,
    description: snapshot.meta.description,
    site: snapshot.meta.site,
    language: snapshot.meta.language,
    wordCount: snapshot.meta.wordCount,
    tags: SNAPSHOT_TAGS,
  };

  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== ''),
  );

  // lineWidth 0: a long url or description is one line in frontmatter, not a folded scalar.
  const front = stringifyYaml(defined, { lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n\n${snapshot.markdown}\n`;
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ============================================================================
// Images
// ============================================================================

/**
 * Markdown's inline image, in the order turndown writes it: `![alt](src "title")`.
 *
 * The three groups are kept apart rather than a bare `(src)`, so a URL can be swapped without
 * rebuilding the line from a search-and-replace — an alt text that happens to contain the same url
 * would otherwise be the thing replaced.
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

/** The http(s) images a note references, in order, each once. */
export function findMarkdownImages(markdown: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const src = match[2];
    if (!src || !/^https?:\/\//i.test(src) || seen.has(src)) continue;
    seen.add(src);
    urls.push(src);
  }
  return urls;
}

/** The same note with those urls pointed at the copies that were kept, by url. */
export function rewriteMarkdownImages(markdown: string, replacements: Map<string, string>): string {
  return markdown.replace(
    MARKDOWN_IMAGE_RE,
    (match, alt: string, src: string, title: string | undefined) => {
      const local = replacements.get(src);
      return local ? `![${alt}](${local}${title ?? ''})` : match;
    },
  );
}

/** Content types an image can arrive as, by the extension a person would expect. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/vnd.microsoft.icon': 'ico',
  'image/x-icon': 'ico',
};

/**
 * A file name for one image: readable, safe, and **stable**.
 *
 * The stem comes from the url so the folder can be read by a person; the content hash is what makes
 * a second capture of an unchanged image land on the same name rather than accumulating copies, and
 * what keeps two different `photo.jpg`s from different hosts apart.
 */
export function snapshotImageFileName(url: string, bytes: Uint8Array, mimeType: string): string {
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  return `${urlStem(url)}-${hash}.${imageExtension(url, mimeType)}`;
}

function imageExtension(url: string, mimeType: string): string {
  const bare = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const byMime = IMAGE_EXTENSIONS[bare];
  if (byMime) return byMime;

  const fromUrl = urlPath(url)?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return fromUrl?.toLowerCase() ?? 'img';
}

function urlStem(url: string): string {
  const last = urlPath(url)?.split('/').pop() ?? '';
  const withoutExtension = decodeURIComponentSafe(last).replace(/\.[a-z0-9]{2,5}$/i, '');
  // Only characters a file name can carry everywhere, so nothing downstream has to encode a path.
  const cleaned = withoutExtension.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'image').slice(0, 48);
}

function urlPath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
