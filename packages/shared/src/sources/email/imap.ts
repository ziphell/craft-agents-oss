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

import { writeFile } from 'node:fs/promises';
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

export class EmailImapClient {
  private readonly client: ImapFlow;
  private readonly defaultMailbox: string;

  constructor(endpoint: EmailEndpoint, auth: ImapAuth, options: { defaultMailbox?: string } = {}) {
    this.defaultMailbox = options.defaultMailbox ?? 'INBOX';
    this.client = new ImapFlow({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      auth,
      logger: false,
      // Never disable certificate checks. A mail password travels on this socket.
      tls: { rejectUnauthorized: true },
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
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
    const criteria = buildSearchQuery(query);

    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const uids = (await this.client.search(criteria, { uid: true })) || [];
      if (uids.length === 0) return [];

      const selected = uids.slice(-limit);
      const summaries: EmailSummary[] = [];

      for await (const message of this.client.fetch(
        selected,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true }
      )) {
        summaries.push(toSummary(message, mailbox));
      }

      return summaries.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    } finally {
      lock.release();
    }
  }

  async fetchMessage(uid: number, mailbox: string | undefined, inlineAssetsDir?: string): Promise<EmailMessage> {
    const target = mailbox ?? this.defaultMailbox;
    const lock = await this.client.getMailboxLock(target);
    try {
      const message = await this.client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, bodyStructure: true, source: true },
        { uid: true }
      );
      if (!message || !message.source) {
        throw new Error(`Message UID ${uid} not found in ${target}`);
      }

      const parsed = await parseMime(message.source, { inlineAssetsDir });
      return {
        ...toSummary(message, target),
        cc: parsed.cc,
        messageId: parsed.messageId,
        text: parsed.text,
        markdown: parsed.markdown,
        attachments: parsed.attachments,
      };
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
   */
  async downloadAttachment(
    uid: number,
    mailbox: string | undefined,
    selector: { index?: number; filename?: string },
    outputPath: string
  ): Promise<string> {
    const message = await this.fetchMessage(uid, mailbox);
    const attachment =
      selector.filename !== undefined
        ? message.attachments.find((item) => item.filename === selector.filename)
        : message.attachments[selector.index ?? 0];

    if (!attachment) {
      throw new Error(`No matching attachment on message ${uid}`);
    }

    await writeFile(outputPath, attachment.content);
    return attachment.filename;
  }

  /** Appends a raw message to a mailbox — used to land drafts on the server. */
  async append(mailbox: string, source: string | Buffer, flags: string[] = []): Promise<boolean> {
    const result = await this.client.append(mailbox, source, flags);
    return Boolean(result);
  }
}

export function buildSearchQuery(query: EmailSearchQuery): SearchObject {
  const criteria: SearchObject = {};
  if (query.from) criteria.from = query.from;
  if (query.to) criteria.to = query.to;
  if (query.subject) criteria.subject = query.subject;
  if (query.text) criteria.text = query.text;
  if (query.unseen) criteria.seen = false;
  if (query.since) criteria.since = query.since;
  if (query.before) criteria.before = query.before;
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
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
