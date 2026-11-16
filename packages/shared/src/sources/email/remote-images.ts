/**
 * Remote images in mail HTML, written beside the message.
 *
 * `export_html` is rendered by a browser that may be sandboxed (the hub's
 * render-host blocks unlisted hosts), so leaving `https://…` in the document
 * means signatures and newsletter art can silently disappear. Downloading them
 * once, into the same per-message folder as the `cid:` parts, makes screenshots
 * deterministic and keeps the HTML portable.
 *
 * Mail is attacker-controlled, so this is also an SSRF surface: only http(s),
 * only standard ports, no credentials, no localhost/private/link-local targets,
 * every redirect re-checked, and bounded by count, size and time. A failed
 * image keeps its original URL — it simply may not render offline.
 */

import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

const MAX_IMAGES = 30;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const TOTAL_BUDGET_MS = 25_000;
const MAX_REDIRECTS = 3;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
};

const IMG_SRC = /<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
const SRCSET = /\bsrcset\s*=\s*(["'])([^"']+)\1/gi;
const CSS_URL = /url\(\s*(["']?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;

export interface LocalizeRemoteImagesOptions {
  /** Folder for the downloaded files. */
  dir: string;
  /** Maps a written path to the URL used in the HTML (relative for export). */
  toUrl: (path: string) => string;
}

export async function localizeRemoteImages(
  html: string,
  options: LocalizeRemoteImagesOptions
): Promise<string> {
  const urls = collectRemoteUrls(html);
  if (urls.length === 0) return html;

  await mkdir(options.dir, { recursive: true });

  const replacements = new Map<string, string>();
  const startedAt = Date.now();
  let totalBytes = 0;

  for (const [index, url] of urls.entries()) {
    if (index >= MAX_IMAGES || totalBytes >= MAX_TOTAL_BYTES) break;
    // A mail with 30 dead image hosts must not stall the export for minutes.
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;

    const fetched = await fetchImage(decodeUrlEntities(url));
    if (!fetched) continue;

    totalBytes += fetched.buffer.length;
    const path = join(options.dir, `remote-${index + 1}.${fetched.extension}`);

    try {
      // Re-exporting the same message finds the file already there.
      await writeFile(path, fetched.buffer, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    replacements.set(url, options.toUrl(path));
    const decoded = decodeUrlEntities(url);
    if (decoded !== url) replacements.set(decoded, options.toUrl(path));
  }

  let result = html;
  for (const [url, replacement] of replacements) {
    result = result.split(url).join(replacement);
  }
  return result;
}

function collectRemoteUrls(html: string): string[] {
  const urls = new Set<string>();

  for (const match of html.matchAll(IMG_SRC)) {
    if (match[2]) urls.add(match[2]);
  }
  for (const match of html.matchAll(SRCSET)) {
    for (const candidate of match[2]?.split(',') ?? []) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url && /^https?:\/\//i.test(url)) urls.add(url);
    }
  }
  for (const match of html.matchAll(CSS_URL)) {
    if (match[2]) urls.add(match[2]);
  }

  return [...urls];
}

/** Attribute values escape `&`; fetch the real URL, replace the escaped form. */
function decodeUrlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
}

async function fetchImage(raw: string, redirects = 0): Promise<{ buffer: Buffer; extension: string } | null> {
  if (redirects > MAX_REDIRECTS) return null;

  let url: URL;
  try {
    url = await assertSafeImageUrl(raw);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'image/*', 'user-agent': 'CraftAgent email image localizer' },
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      return location ? fetchImage(new URL(location, url).toString(), redirects + 1) : null;
    }

    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      await response.body?.cancel();
      return null;
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) return null;

    const mime = contentType.split(';')[0]?.trim() ?? '';
    return { buffer, extension: EXTENSIONS[mime] ?? 'img' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function assertSafeImageUrl(raw: string): Promise<URL> {
  const url = new URL(raw);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('unsupported scheme');
  }
  if (url.username || url.password) {
    throw new Error('credentials in URL');
  }

  // Standard web ports only: a mail image has no reason to hit 8080 or 6379.
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== '443' && port !== '80') {
    throw new Error('non-standard port');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('local host');
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('private address');
    return url;
  }

  // A public name may still resolve into the private range (nip.io, DNS
  // rebinding). There is a small window between this lookup and the fetch; the
  // count/size/time bounds keep the blast radius small.
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address.address))) {
    throw new Error('private address');
  }

  return url;
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const ip = address.toLowerCase();
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice('::ffff:'.length));
    return ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip);
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
