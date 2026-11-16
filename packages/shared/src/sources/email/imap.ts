/**
 * IMAP side of an email source.
 *
 * One ImapFlow client per account, opened lazily and reused. Every mailbox
 * operation takes a mailbox lock: ImapFlow queues concurrent callers instead of
 * interleaving SELECT/SEARCH on the same connection.
 *
 * UIDs are the only message identity we expose. Sequence numbers are
 * connection-scoped and must never leave this file — that mistake is what makes
 * the email-mcp implementation unreliable across calls.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ImapFlow,
  type FetchMessageObject,
  type MessageAddressObject,
  type MessageStructureObject,
  type SearchObject,
} from 'imapflow';
import { parseMime } from './mime.ts';
import type {
  EmailEndpoint,
  EmailFolder,
  EmailMessage,
  EmailSearchQuery,
  EmailSummary,
} from './types.ts';

export interface ImapAuth {
  user: string;
  pass: string;
}

/**
 * How many recent messages the client-side fallback looks at.
 *
 * Chinese keywords cannot be trusted to the server (see `needsLocalSearch`), so
 * the fallback pages through envelopes instead. Envelopes are cheap; bodies are
 * not, which is why `text` matching stops at the headers.
 */
const LOCAL_SCAN_LIMIT = 500;

/** Messages above this size are re-parsed on demand instead of held in memory. */
const PARSED_CACHE_MAX_SOURCE = 10 * 1024 * 1024;

export interface FetchMessageOptions {
  /** Folder for inline images. */
  inlineAssetsDir?: string;
  /** Where the HTML will be written; set to emit relative image URLs. */
  inlineAssetBaseDir?: string;
  /** Download remote `http(s)` images into the assets folder (export only). */
  fetchRemoteImages?: boolean;
}

export class EmailImapClient {
  private readonly client: ImapFlow;
  private readonly defaultMailbox: string;
  /**
   * One-message cache: `read` is usually followed by `download_attachment`, and
   * the IMAP fetch is the expensive half. Only the most recent message is kept.
   */
  private cachedFetch: { key: string; message: FetchMessageObject } | null = null;
  /** Parsed form of the same message, so `read` paging does not re-parse a large MIME. */
  private cachedParsed: { key: string; message: EmailMessage } | null = null;

  constructor(endpoint: EmailEndpoint, auth: ImapAuth, options: { defaultMailbox?: string } = {}) {
    this.defaultMailbox = options.defaultMailbox ?? 'INBOX';
    this.client = new ImapFlow({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      auth,
      logger: false,
      // imapflow defaults to a 5-minute socket timeout; a stuck server would
      // hold a turn that long. These match the SMTP side's patience.
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 90_000,
      // Never disable certificate checks. A mail password travels on this socket.
      tls: { rejectUnauthorized: true },
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    this.cachedFetch = null;
    this.cachedParsed = null;
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }

  async listFolders(): Promise<EmailFolder[]> {
    const list = await this.client.list();
    return list.map((entry) => ({
      path: entry.path,
      name: entry.name,
      delimiter: entry.delimiter ?? '/',
      specialUse: entry.specialUse,
    }));
  }

  /** Newest first. Reads only headers, so this stays cheap on large mailboxes. */
  async search(query: EmailSearchQuery): Promise<EmailSummary[]> {
    const mailbox = query.mailbox ?? this.defaultMailbox;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 500);
    if (needsLocalSearch(query)) return this.searchLocally(query, mailbox, limit, offset);

    const criteria = buildSearchQuery(query);

    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const uids = (await this.client.search(criteria, { uid: true })) || [];
      if (uids.length === 0) return [];

      const selected = uids.slice(-(limit + offset));
      const summaries: EmailSummary[] = [];

      for await (const message of this.client.fetch(
        selected,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true }
      )) {
        summaries.push(toSummary(message, mailbox));
      }

      return summaries
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(offset, offset + limit);
    } finally {
      lock.release();
    }
  }

  /**
   * Envelope-only search for keywords the server cannot handle.
   *
   * QQ / 163 reject or ignore `SEARCH CHARSET UTF-8`, so CJK terms would either
   * fail the tool outright or silently return nothing. Anything the server can
   * still filter by (dates, seen flag, ASCII terms) is pushed down; the rest is
   * matched here against decoded headers.
   */
  private async searchLocally(
    query: EmailSearchQuery,
    mailbox: string,
    limit: number,
    offset: number
  ): Promise<EmailSummary[]> {
    const criteria = buildSearchQuery(query, { asciiOnly: true });

    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const uids = (await this.client.search(criteria, { uid: true })) || [];
      if (uids.length === 0) return [];

      const summaries: EmailSummary[] = [];
      for await (const message of this.client.fetch(
        uids.slice(-LOCAL_SCAN_LIMIT),
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true }
      )) {
        const summary = toSummary(message, mailbox);
        if (matchesSummary(summary, query)) summaries.push(summary);
      }

      return summaries
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(offset, offset + limit);
    } finally {
      lock.release();
    }
  }

  async fetchMessage(
    uid: number,
    mailbox: string | undefined,
    options: FetchMessageOptions = {}
  ): Promise<EmailMessage> {
    const target = mailbox ?? this.defaultMailbox;
    const key = `${target}\u0000${uid}`;
    const parsedKey = `${key}\u0000${JSON.stringify(options)}`;

    const cached = this.cachedParsed;
    if (cached?.key === parsedKey) return cached.message;

    const lock = await this.client.getMailboxLock(target);
    try {
      let message = this.cachedFetch?.key === key ? this.cachedFetch.message : null;
      if (!message) {
        const fetched = await this.client.fetchOne(
          String(uid),
          { uid: true, envelope: true, flags: true, bodyStructure: true, source: true },
          { uid: true }
        );
        if (!fetched || !fetched.source) {
          throw new Error(`Message UID ${uid} not found in ${target}`);
        }
        message = fetched;
        this.cachedFetch = { key, message };
      }

      const parsed = await parseMime(message.source!, options);
      const result: EmailMessage = {
        ...toSummary(message, target),
        cc: parsed.cc,
        messageId: parsed.messageId,
        text: parsed.text,
        markdown: parsed.markdown,
        html: parsed.html,
        attachments: parsed.attachments,
        inlineImages: parsed.inlineImages,
      };

      // A 20 MB mail would double that in memory for little gain; paging it is
      // still served by the raw fetch cache.
      if ((message.source?.length ?? 0) <= PARSED_CACHE_MAX_SOURCE) {
        this.cachedParsed = { key: parsedKey, message: result };
      }

      return result;
    } finally {
      lock.release();
    }
  }

  /**
   * Writes one attachment to disk.
   *
   * Fetches the full message and picks the part in memory. Correct, but it
   * re-downloads the whole message — switch to `download(uid, partId)` once
   * part ids are mapped from bodyStructure.
   *
   * The destination is created if needed, and an existing file is never
   * replaced: a second "invoice.pdf" becomes "invoice-1.pdf".
   */
  async downloadAttachment(
    uid: number,
    mailbox: string | undefined,
    selector: { index?: number; filename?: string },
    destination: { path?: string; defaultDir: string }
  ): Promise<{ filename: string; path: string }> {
    const message = await this.fetchMessage(uid, mailbox);
    // `cid:` parts are inline body images, already written beside the message;
    // indices and filename lookups refer only to real attachments.
    const downloadable = message.attachments.filter((item) => !item.contentId);
    const attachment =
      selector.filename !== undefined
        ? downloadable.find((item) => item.filename === selector.filename)
        : downloadable[selector.index ?? 0];

    if (!attachment) {
      throw new Error(`No matching attachment on message ${uid}`);
    }

    const outputPath = destination.path ?? join(destination.defaultDir, attachment.filename);
    return { filename: attachment.filename, path: await writeUnique(outputPath, attachment.content) };
  }

  /** Every real attachment on one message, all written from a single fetch. */
  async downloadAllAttachments(
    uid: number,
    mailbox: string | undefined,
    destination: { dir: string }
  ): Promise<Array<{ filename: string; path: string }>> {
    const message = await this.fetchMessage(uid, mailbox);
    const downloadable = message.attachments.filter((item) => !item.contentId);
    const saved: Array<{ filename: string; path: string }> = [];

    for (const attachment of downloadable) {
      saved.push({
        filename: attachment.filename,
        path: await writeUnique(join(destination.dir, attachment.filename), attachment.content),
      });
    }

    return saved;
  }

  /** Appends a raw message to a mailbox — used to land drafts on the server. */
  async append(mailbox: string, source: string | Buffer, flags: string[] = []): Promise<boolean> {
    const result = await this.client.append(mailbox, source, flags);
    return Boolean(result);
  }
}

export function buildSearchQuery(
  query: EmailSearchQuery,
  options: { asciiOnly?: boolean } = {}
): SearchObject {
  const criteria: SearchObject = {};
  const set = (value: string | undefined, assign: (resolved: string) => void) => {
    if (!value) return;
    if (options.asciiOnly && !isAscii(value)) return;
    assign(value);
  };

  set(query.from, (value) => (criteria.from = value));
  set(query.to, (value) => (criteria.to = value));
  set(query.subject, (value) => (criteria.subject = value));
  set(query.text, (value) => (criteria.text = value));
  if (query.unseen) criteria.seen = false;
  if (query.since) criteria.since = query.since;
  if (query.before) criteria.before = query.before;
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

/** True when a keyword must be matched here instead of on the server. */
export function needsLocalSearch(query: EmailSearchQuery): boolean {
  return [query.from, query.to, query.subject, query.text].some(
    (value) => value !== undefined && !isAscii(value)
  );
}

function isAscii(value: string): boolean {
  return /^[\x00-\x7F]*$/.test(value);
}

/**
 * Header match for the fallback path. The server filters dates and flags; this
 * compares the decoded envelope, so encoding differences do not matter.
 *
 * `text` is limited to the headers: scanning bodies would mean downloading
 * every candidate message.
 */
function matchesSummary(summary: EmailSummary, query: EmailSearchQuery): boolean {
  const contains = (haystack: string, needle: string) =>
    normalize(haystack).includes(normalize(needle));

  if (query.from && !contains(summary.from, query.from)) return false;
  if (query.to && !contains(summary.to, query.to)) return false;
  if (query.subject && !contains(summary.subject, query.subject)) return false;
  if (query.text && ![summary.subject, summary.from, summary.to].some((value) => contains(value, query.text!)))
    return false;
  return true;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/** `invoice.pdf` → `invoice-1.pdf`, keeping the extension in place. */
function withCollisionSuffix(path: string, attempt: number): string {
  const dot = path.lastIndexOf('.');
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot > separator + 1) return `${path.slice(0, dot)}-${attempt}${path.slice(dot)}`;
  return `${path}-${attempt}`;
}

/**
 * Write without replacing an existing file: `wx` claims the name atomically, so
 * two downloads cannot both win, and a collision becomes `-1`, `-2`, …
 */
async function writeUnique(outputPath: string, content: Buffer): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });

  let target = outputPath;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await writeFile(target, content, { flag: 'wx' });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      target = withCollisionSuffix(outputPath, attempt + 1);
    }
  }

  throw new Error(`Could not find a free filename for ${outputPath} after 100 attempts`);
}

function toSummary(message: FetchMessageObject, mailbox: string): EmailSummary {
  const flags = message.flags ?? new Set<string>();
  return {
    uid: message.uid,
    mailbox,
    subject: message.envelope?.subject ?? '',
    from: formatAddresses(message.envelope?.from),
    to: formatAddresses(message.envelope?.to),
    date: toIsoString(message.envelope?.date),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    hasAttachments: hasAttachmentPart(message.bodyStructure),
  };
}

function formatAddresses(addresses: MessageAddressObject[] | undefined): string {
  return (addresses ?? [])
    .map((address) => (address.name ? `${address.name} <${address.address ?? ''}>` : address.address ?? ''))
    .filter(Boolean)
    .join(', ');
}

function toIsoString(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function hasAttachmentPart(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes ?? []).some(hasAttachmentPart);
}
