/**
 * Email source module.
 *
 * Protocol adapters only — no tool definitions and no source wiring yet.
 * A normal IMAP/SMTP account is created with:
 *
 *   const endpoints = resolveEndpoints(config)
 *   const imap = new EmailImapClient(endpoints.imap, auth)
 *   await imap.connect()
 *
 * Packaging note: imapflow / nodemailer / mailparser are CommonJS and pull in
 * `require('stream')` at runtime. Bundling them into an ESM main-process bundle
 * fails with "Dynamic require of stream is not supported"; bundle as CJS or keep
 * them external. Verified with both accounts on 163 and QQ.
 */

export type {
  EmailAccountConfig,
  EmailAttachment,
  EmailEndpoint,
  EmailFolder,
  EmailMessage,
  EmailSearchQuery,
  EmailSummary,
  SendEmailInput,
  SendEmailResult,
} from './types.ts';

export {
  EMAIL_PROVIDERS,
  detectProvider,
  listProviderPresets,
  resolveEndpoints,
  type EmailProviderPreset,
} from './presets.ts';

export { parseMime, type ParsedMime } from './mime.ts';
export { EmailImapClient, buildSearchQuery, type ImapAuth } from './imap.ts';
export { createSmtpTransport, sendEmail, verifySmtp, type SmtpAuth } from './smtp.ts';
