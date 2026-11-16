/**
 * MIME parsing for email sources.
 *
 * Mail bodies arrive as HTML far more often than as plain text, so the model
 * gets Markdown. Inline `cid:` images are written next to the message and the
 * references are rewritten to local paths — otherwise the model sees an
 * unusable cid URL.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { simpleParser, type AddressObject } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { htmlToMarkdown } from '../../html/markdown.ts';
import { localizeRemoteImages } from './remote-images.ts';
import type { EmailAttachment } from './types.ts';

export interface ParsedMime {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  messageId?: string;
  text: string;
  markdown: string;
  /** Rewritten HTML body. Kept off the model-facing read output — see `renderEmailHtmlDocument`. */
  html: string;
  attachments: EmailAttachment[];
  /** Parts referenced by `cid:` in the body. Already saved under the message folder. */
  inlineImages: EmailAttachment[];
}

export async function parseMime(
  source: Buffer,
  options: {
    inlineAssetsDir?: string;
    /** Directory the HTML will live in. Set this to emit relative image URLs. */
    inlineAssetBaseDir?: string;
    /** Download `http(s)` images into the assets folder (export path only). */
    fetchRemoteImages?: boolean;
  } = {}
): Promise<ParsedMime> {
  const parsed = await simpleParser(source);

  const attachments: EmailAttachment[] = parsed.attachments.map((attachment, index) => ({
    filename: safeFilename(attachment.filename, index),
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size,
    contentId: attachment.cid?.replace(/^<|>$/g, ''),
    content: attachment.content,
  }));

  // A `cid:` part is body decoration, not a downloadable attachment.
  const inlineImages = attachments.filter((part) => part.contentId);

  const html = await rewriteInlineImages(
    parsed.html || '',
    attachments,
    options.inlineAssetsDir,
    options.inlineAssetBaseDir
  );

  // Export needs pixels that survive a sandboxed renderer; `read` keeps the
  // URLs and avoids downloading anything.
  const localized =
    options.fetchRemoteImages && options.inlineAssetsDir
      ? await localizeRemoteImages(html, {
          dir: options.inlineAssetsDir,
          toUrl: (path) => assetUrl(path, options.inlineAssetBaseDir),
        })
      : html;

  return {
    subject: parsed.subject ?? '',
    from: formatAddress(parsed.from),
    to: formatAddress(parsed.to),
    cc: formatAddress(parsed.cc),
    date: (parsed.date ?? new Date()).toISOString(),
    messageId: parsed.messageId,
    text: parsed.text ?? '',
    markdown: localized ? htmlToMarkdown(localized) : (parsed.text ?? ''),
    html: localized,
    attachments,
    inlineImages,
  };
}

export interface HtmlDocumentInput {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  /** HTML body; absent for plain-text-only messages. */
  html?: string;
  /** Plain-text fallback when the message has no HTML part. */
  text?: string;
}

/**
 * Standalone HTML file for browser rendering / screenshots.
 *
 * Mail HTML is attacker-controlled: scripts, frames and inline event handlers
 * are stripped before it is written next to the session and opened in a browser.
 */
export function renderEmailHtmlDocument(message: HtmlDocumentInput): string {
  const body = sanitizeEmailHtml(message.html ?? '') || `<pre>${escapeHtml(message.text ?? '')}</pre>`;
  // Headers stay in <meta>, not as visible markup: untrusted CSS can style or
  // cover any element in the same document, so a visible "From:" line could be
  // spoofed in a screenshot. `read` already reports the real headers.
  const meta = [
    ['email-subject', message.subject],
    ['email-from', message.from],
    ['email-to', message.to],
    ['email-cc', message.cc],
    ['email-date', message.date],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `<meta name="${name}" content="${escapeHtml(value!)}">`)
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data: http: https:; media-src file: data: http: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
${meta}
<title>${escapeHtml(message.subject || 'Email')}</title>
<style>
  body { margin: 24px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; color: #222; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; border-collapse: collapse; }
  pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<article>
${body}
</article>
</body>
</html>
`;
}

/**
 * Allowlist sanitizer for mail HTML.
 *
 * Regex was a best-effort filter; this parses the document, so odd casing,
 * unquoted attributes, `formaction`, `xlink:href` and nested frames cannot slip
 * through. Styling is kept (mail layout depends on it), active content is not.
 *
 * `file:` is needed for the localized `cid:` images. Links may not use it; only
 * images may.
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'abbr', 'address', 'article', 'aside', 'b', 'big', 'blockquote', 'br', 'caption', 'center',
    'code', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
    'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'li', 'main', 'mark',
    'nav', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strike', 'strong', 'style', 'sub',
    'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul',
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'id', 'title', 'align', 'valign', 'width', 'height', 'dir', 'lang', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'role'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'title', 'border'],
    font: ['color', 'face', 'size'],
    table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'align', 'summary'],
    td: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'align', 'valign', 'nowrap'],
    th: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'align', 'valign', 'scope', 'nowrap'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'file'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto', 'tel'],
    img: ['http', 'https', 'data', 'file'],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // `style` is an allowed tag whose content must survive; the default drops it.
  nonTextTags: ['script', 'textarea', 'option'],
  // Mail layout depends on <style>. The usual CSS risks are bounded here: the
  // document has no scripts, forms or inputs, and the CSP above allows only
  // inline styles and image/media loads.
  allowVulnerableTags: true,
};

function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Point inline images at local files.
 *
 * `mailparser` usually replaces `cid:` references with `data:` URIs because the
 * related part is right there. Both forms are handled: the base64 stays out of
 * the Markdown either way, otherwise a small signature image costs the model
 * thousands of tokens.
 */
async function rewriteInlineImages(
  html: string,
  attachments: EmailAttachment[],
  inlineAssetsDir: string | undefined,
  inlineAssetBaseDir: string | undefined
): Promise<string> {
  if (!inlineAssetsDir || (!html.includes('cid:') && !html.includes('data:'))) return html;

  await mkdir(inlineAssetsDir, { recursive: true });

  let result = html;
  const inline = attachments.filter((attachment) => attachment.contentId);
  for (const [index, attachment] of inline.entries()) {
    const path = join(inlineAssetsDir, `${index + 1}-${attachment.filename}`);
    const candidates = [
      `cid:${attachment.contentId}`,
      `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`,
    ];

    for (const candidate of candidates) {
      if (!result.includes(candidate)) continue;
      await writeFile(path, attachment.content);
      result = result.split(candidate).join(assetUrl(path, inlineAssetBaseDir));
    }
  }

  return rewriteRemainingDataUris(result, inlineAssetsDir, inlineAssetBaseDir);
}

const DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;

/** Images the sender embedded without a matching attachment. */
async function rewriteRemainingDataUris(
  html: string,
  dir: string,
  baseDir: string | undefined
): Promise<string> {
  const matches = [...html.matchAll(DATA_URI)];
  let result = html;

  for (const [index, match] of matches.entries()) {
    const mime = match[1];
    const base64 = match[2];
    if (!mime || !base64) continue;
    const extension = mime.split('/')[1]?.split('+')[0] || 'bin';
    const path = join(dir, `inline-${index + 1}.${extension}`);
    await writeFile(path, Buffer.from(base64, 'base64'));
    result = result.split(match[0]).join(assetUrl(path, baseDir));
  }

  return result;
}

/**
 * Exported HTML lives under the session folder, so its images can be relative
 * and the folder stays portable. Markdown returned by `read` has no file next
 * to it, and therefore keeps the absolute `file://` form.
 */
function assetUrl(path: string, baseDir: string | undefined): string {
  if (baseDir) {
    // `#`, `?` and `%` in a sender-chosen filename otherwise truncate the URL.
    return relative(baseDir, path)
      .split(/[\\/]+/)
      .map(encodeURIComponent)
      .join('/');
  }
  return pathToFileURL(path).href;
}

/** Parsed headers arrive as one object or an array, depending on the header. */
function formatAddress(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return '';
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => entry.text).filter(Boolean).join(', ');
}

/** Attachment filenames come from the sender — never let them become a path. */
function safeFilename(filename: string | undefined, index: number): string {
  const raw = basename(filename ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  const fallback = raw || `attachment-${index + 1}`;

  const dot = fallback.lastIndexOf('.');
  const stem = dot > 0 ? fallback.slice(0, dot) : fallback;
  const extension = dot > 0 ? fallback.slice(dot, dot + 16) : '';
  // `CON`, `NUL`, `COM1` … are device names on Windows, not files.
  const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${stem}` : stem;

  return `${safeStem.slice(0, 120)}${extension}`;
}

export type { EmailAttachment } from './types.ts';
