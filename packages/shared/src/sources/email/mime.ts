/**
 * MIME parsing for email sources.
 *
 * Mail bodies arrive as HTML far more often than as plain text, so the model
 * gets Markdown. Inline `cid:` images are written next to the message and the
 * references are rewritten to local paths — otherwise the model sees an
 * unusable cid URL.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { simpleParser, type AddressObject } from 'mailparser';
import TurndownService from 'turndown';
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
  attachments: EmailAttachment[];
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'head', 'title']);

export async function parseMime(
  source: Buffer,
  options: { inlineAssetsDir?: string } = {}
): Promise<ParsedMime> {
  const parsed = await simpleParser(source);

  const attachments: EmailAttachment[] = parsed.attachments.map((attachment, index) => ({
    filename: safeFilename(attachment.filename, index),
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size,
    contentId: attachment.cid?.replace(/^<|>$/g, ''),
    content: attachment.content,
  }));

  const html = await rewriteInlineImages(parsed.html || '', attachments, options.inlineAssetsDir);

  return {
    subject: parsed.subject ?? '',
    from: formatAddress(parsed.from),
    to: formatAddress(parsed.to),
    cc: formatAddress(parsed.cc),
    date: (parsed.date ?? new Date()).toISOString(),
    messageId: parsed.messageId,
    text: parsed.text ?? '',
    markdown: html ? turndown.turndown(html) : (parsed.text ?? ''),
    attachments,
  };
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
  inlineAssetsDir: string | undefined
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
      result = result.split(candidate).join(pathToFileUrl(path));
    }
  }

  return rewriteRemainingDataUris(result, inlineAssetsDir);
}

const DATA_URI = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;

/** Images the sender embedded without a matching attachment. */
async function rewriteRemainingDataUris(html: string, dir: string): Promise<string> {
  const matches = [...html.matchAll(DATA_URI)];
  let result = html;

  for (const [index, match] of matches.entries()) {
    const mime = match[1];
    const base64 = match[2];
    if (!mime || !base64) continue;
    const extension = mime.split('/')[1]?.split('+')[0] || 'bin';
    const path = join(dir, `inline-${index + 1}.${extension}`);
    await writeFile(path, Buffer.from(base64, 'base64'));
    result = result.split(match[0]).join(pathToFileUrl(path));
  }

  return result;
}

function pathToFileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/')}`;
}

/** Parsed headers arrive as one object or an array, depending on the header. */
function formatAddress(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return '';
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => entry.text).filter(Boolean).join(', ');
}

/** Attachment filenames come from the sender — never let them become a path. */
function safeFilename(filename: string | undefined, index: number): string {
  const base = basename(filename ?? '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return base || `attachment-${index + 1}`;
}

export type { EmailAttachment } from './types.ts';
