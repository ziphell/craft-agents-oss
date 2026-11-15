/**
 * Provider presets.
 *
 * The table is the one piece worth keeping from email-mcp: it is the only
 * place that encodes which Chinese providers need an authorization code and
 * which port/TLS pair they expect.
 */

import type { EmailAccountConfig, EmailEndpoint } from './types.ts';

export interface EmailProviderPreset {
  id: string;
  label: string;
  /** Domains that map to this preset. Enterprise providers match by domain only when known. */
  domains: string[];
  imap: EmailEndpoint;
  smtp: EmailEndpoint;
  /** The login password does not work — the provider issues a separate authorization code. */
  appPasswordRequired?: boolean;
  /** Password auth is retired; the account needs OAuth (Gmail API / Microsoft Graph). */
  oauthRequired?: boolean;
}

export const EMAIL_PROVIDERS: Record<string, EmailProviderPreset> = {
  qq: {
    id: 'qq',
    label: 'QQ 邮箱',
    domains: ['qq.com'],
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 587, secure: false },
    appPasswordRequired: true,
  },
  '163': {
    id: '163',
    label: '网易邮箱',
    domains: ['163.com', '126.com', 'yeah.net'],
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    appPasswordRequired: true,
  },
  'netease-enterprise': {
    id: 'netease-enterprise',
    label: '网易企业邮箱',
    domains: [],
    imap: { host: 'imaphz.qiye.163.com', port: 993, secure: true },
    smtp: { host: 'smtphz.qiye.163.com', port: 587, secure: false },
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
    appPasswordRequired: true,
    oauthRequired: true,
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    appPasswordRequired: true,
    oauthRequired: true,
  },
  exmail: {
    id: 'exmail',
    label: '腾讯企业邮箱',
    domains: ['exmail.qq.com'],
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
  },
  aliyun: {
    id: 'aliyun',
    label: '阿里云邮箱',
    domains: ['aliyun.com', 'alibaba-inc.com'],
    imap: { host: 'imap.mxhichina.com', port: 993, secure: true },
    smtp: { host: 'smtp.mxhichina.com', port: 465, secure: true },
  },
  sina: {
    id: 'sina',
    label: '新浪邮箱',
    domains: ['sina.com', 'sina.cn'],
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 587, secure: false },
  },
  sohu: {
    id: 'sohu',
    label: '搜狐邮箱',
    domains: ['sohu.com'],
    imap: { host: 'imap.sohu.com', port: 993, secure: true },
    smtp: { host: 'smtp.sohu.com', port: 25, secure: false },
  },
};

/** Returns the preset id for an address, or undefined when the domain is unknown. */
export function detectProvider(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at === -1) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  for (const preset of Object.values(EMAIL_PROVIDERS)) {
    if (preset.domains.includes(domain)) return preset.id;
  }
  return undefined;
}

export function listProviderPresets(): EmailProviderPreset[] {
  return Object.values(EMAIL_PROVIDERS);
}

/**
 * Resolve effective endpoints from the preset plus per-account overrides.
 *
 * Returns null when the account has no preset and did not supply both hosts —
 * better a clear error than a connection attempt against a placeholder host.
 */
export function resolveEndpoints(config: EmailAccountConfig):
  | { imap: EmailEndpoint; smtp: EmailEndpoint }
  | { error: string } {
  const providerId = config.provider ?? detectProvider(config.address);
  const preset = providerId ? EMAIL_PROVIDERS[providerId] : undefined;

  if (!preset && (!config.imap?.host || !config.smtp?.host)) {
    return {
      error: `Unknown email provider for ${config.address}. Set "provider" or fill in both the IMAP and SMTP hosts.`,
    };
  }

  return {
    imap: applyOverride(preset?.imap, config.imap, { tls: 993, starttls: 143 }, { tls: [993], plain: [143] }),
    smtp: applyOverride(preset?.smtp, config.smtp, { tls: 465, starttls: 587 }, { tls: [465], plain: [587, 25] }),
  };
}

function applyOverride(
  base: EmailEndpoint | undefined,
  override: Partial<EmailEndpoint> | undefined,
  defaults: { tls: number; starttls: number },
  ports: { tls: number[]; plain: number[] }
): EmailEndpoint {
  const host = override?.host ?? base?.host ?? '';
  // An explicit TLS choice without a port picks the conventional one, so a user
  // who only ticks "SSL" does not also have to know 465 vs 587.
  const port =
    override?.port ?? base?.port ?? (override?.secure === false ? defaults.starttls : defaults.tls);
  // A stated choice wins. Otherwise the port decides: 993 and 465 are TLS from
  // the first byte, 143 / 587 / 25 connect in the clear and upgrade with
  // STARTTLS. Getting this wrong fails the handshake with a confusing error, so
  // a user who only knows the port is still correct.
  const secure =
    override?.secure ?? (ports.tls.includes(port) ? true : ports.plain.includes(port) ? false : base?.secure ?? true);
  return { host, port, secure };
}
