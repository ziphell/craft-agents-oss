/**
 * Email Source Types
 *
 * One mailbox = one source. Non-secret settings live in
 * `sources/{slug}/config.json`; the password or token lives in the
 * encrypted credential store.
 */

export interface EmailEndpoint {
  host: string;
  port: number;
  /** true = implicit TLS (993/465), false = plain connection upgraded with STARTTLS (587/25). */
  secure: boolean;
}

export interface EmailAccountConfig {
  /** Full address, e.g. "me@example.com". Also the IMAP/SMTP login user. */
  address: string;
  /** Provider preset id. Inferred from the address when omitted. */
  provider?: string;
  /** Per-account overrides for self-hosted or uncommon servers. */
  imap?: Partial<EmailEndpoint>;
  smtp?: Partial<EmailEndpoint>;
  /** Shown in tool output instead of the raw address. */
  displayName?: string;
  /** Mailbox used when a tool call does not name one. Defaults to INBOX. */
  defaultMailbox?: string;
}

export interface EmailFolder {
  path: string;
  name: string;
  delimiter: string;
  /** RFC 6154 role: \Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive, ... */
  specialUse?: string;
}

export interface EmailSummary {
  uid: number;
  mailbox: string;
  subject: string;
  /** Formatted as "Name <address>", or an empty string when absent. */
  from: string;
  to: string;
  date: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Content-ID without the angle brackets, for inline images. */
  contentId?: string;
  content: Buffer;
}

export interface EmailMessage extends EmailSummary {
  cc: string;
  messageId?: string;
  /** Plain-text body, empty when the message only has HTML. */
  text: string;
  /** HTML body converted to Markdown; inline `cid:` images point at local files. */
  markdown: string;
  attachments: EmailAttachment[];
}

export interface EmailSearchQuery {
  mailbox?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Matches any header or body text. */
  text?: string;
  /** Only unread messages. */
  unseen?: boolean;
  /** Messages received on or after this date. */
  since?: Date;
  /** Messages received before this date. */
  before?: Date;
  /** Newest N results. Defaults to 20, capped by the caller. */
  limit?: number;
}

export interface SendEmailInput {
  /**
   * Sender. Defaults to the authenticated user.
   *
   * Must never be left empty: nodemailer then sends `MAIL FROM:<>`, which
   * providers reject as an invalid envelope (QQ answers 502).
   */
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; path: string }>;
  /** Message-ID of the message being replied to, for threading. */
  inReplyTo?: string;
  references?: string[];
}

export interface SendEmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}
