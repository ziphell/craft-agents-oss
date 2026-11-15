/**
 * SMTP side of an email source.
 *
 * A fresh transport per send: mail volume here is a handful of messages per
 * session, so a pool would add lifecycle management without any benefit.
 */

import nodemailer from 'nodemailer';
import type { EmailEndpoint, SendEmailInput, SendEmailResult } from './types.ts';

export interface SmtpAuth {
  user: string;
  pass: string;
}

export function createSmtpTransport(endpoint: EmailEndpoint, auth: SmtpAuth) {
  return nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth,
    // Certificate checks stay on: the password and the message both cross this socket.
    tls: { rejectUnauthorized: true },
    // Port 587 is the submission port and always offers STARTTLS, so refuse to
    // fall back to plaintext there. Port 25 relays are left to the server.
    requireTLS: !endpoint.secure && endpoint.port === 587,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export async function verifySmtp(endpoint: EmailEndpoint, auth: SmtpAuth): Promise<void> {
  const transport = createSmtpTransport(endpoint, auth);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendEmail(
  endpoint: EmailEndpoint,
  auth: SmtpAuth,
  input: SendEmailInput
): Promise<SendEmailResult> {
  const transport = createSmtpTransport(endpoint, auth);
  try {
    const info = await transport.sendMail({
      from: input.from ?? auth.user,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        path: attachment.path,
      })),
      inReplyTo: input.inReplyTo,
      references: input.references,
    });

    return {
      messageId: info.messageId,
      accepted: toStringArray(info.accepted),
      rejected: toStringArray(info.rejected),
    };
  } finally {
    transport.close();
  }
}

function toStringArray(value: Array<string | { address: string }> | undefined): string[] {
  return (value ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.address));
}
