import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMime, renderEmailHtmlDocument } from '../mime.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function message(options: {
  html: string;
  inline?: { filename: string; contentId: string };
  attachment?: { filename: string; contentType: string };
}): Buffer {
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      [
        'From: sender@example.com',
        'To: receiver@example.com',
        'Subject: test',
        'Date: Mon, 16 Nov 2026 10:00:00 +0800',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="MIX"',
        '',
        '--MIX',
        'Content-Type: multipart/related; boundary="REL"',
        '',
        '--REL',
        'Content-Type: text/html; charset=utf-8',
        '',
        options.html,
        '--REL',
      ].join('\r\n') + '\r\n'
    )
  );

  if (options.inline) {
    parts.push(
      Buffer.from(
        [
          `Content-Type: image/png; name="${options.inline.filename}"`,
          `Content-ID: <${options.inline.contentId}>`,
          `Content-Disposition: inline; filename="${options.inline.filename}"`,
          'Content-Transfer-Encoding: base64',
          '',
          PNG,
          '--REL--',
        ].join('\r\n') + '\r\n'
      )
    );
  } else {
    parts.push(Buffer.from('--REL--\r\n'));
  }

  if (options.attachment) {
    parts.push(
      Buffer.from(
        [
          '--MIX',
          `Content-Type: ${options.attachment.contentType}; name="${options.attachment.filename}"`,
          `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from('%PDF-1.4 test').toString('base64'),
          '--MIX--',
          '',
        ].join('\r\n')
      )
    );
  } else {
    parts.push(Buffer.from('--MIX--\r\n'));
  }

  return Buffer.concat(parts);
}

describe('parseMime', () => {
  it('splits cid images from attachments and keeps tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'email-mime-'));
    try {
      const messageDir = join(root, 'emails', 'INBOX-1');
      const parsed = await parseMime(
        message({
          html: '<style>.x{color:red}</style><table><tr><th>项目</th><th>金额</th></tr><tr><td>服务费</td><td>100</td></tr></table><img src="cid:logo@example">',
          inline: { filename: 'logo#1.png', contentId: 'logo@example' },
          attachment: { filename: 'invoice.pdf', contentType: 'application/pdf' },
        }),
        { inlineAssetsDir: join(messageDir, 'images'), inlineAssetBaseDir: messageDir }
      );

      const downloadable = parsed.attachments.filter((part) => !part.contentId);
      expect(downloadable.map((part) => part.filename)).toEqual(['invoice.pdf']);
      expect(parsed.inlineImages.map((part) => part.filename)).toEqual(['logo#1.png']);
      expect(parsed.markdown).toContain('| 项目 | 金额 |');
      expect(parsed.html).toContain('images/1-logo%231.png');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('neutralizes Windows device names', async () => {
    const parsed = await parseMime(
      message({
        html: '<p>hi</p>',
        attachment: { filename: 'CON', contentType: 'application/pdf' },
      })
    );
    expect(parsed.attachments.map((part) => part.filename)).toEqual(['_CON']);
  });
});

describe('renderEmailHtmlDocument', () => {
  it('strips active content and keeps layout', () => {
    const doc = renderEmailHtmlDocument({
      subject: 'test',
      from: 'a@example.com',
      to: 'b@example.com',
      cc: '',
      date: '2026-11-16T10:00:00Z',
      html: [
        '<script>alert(1)</script>',
        '<iframe src="https://evil.example"></iframe>',
        '<style>.promo{color:#c00}</style>',
        '<p onclick="steal()" style="font-weight:bold">Hello</p>',
        '<a href="javascript:alert(1)">bad</a>',
        '<img src="images/1-a.png" onerror="steal()">',
      ].join(''),
    });

    expect(doc).not.toContain('<script');
    expect(doc).not.toContain('<iframe');
    expect(doc).not.toContain('onclick');
    expect(doc).not.toContain('onerror');
    expect(doc).not.toContain('javascript:');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain('<style>.promo{color:#c00}</style>');
    expect(doc).toContain('images/1-a.png');
  });

  it('does not put spoofable headers in the document', () => {
    const doc = renderEmailHtmlDocument({
      subject: 'Subject line',
      from: 'sender@example.com',
      to: 'receiver@example.com',
      cc: '',
      date: '2026-11-16T10:00:00Z',
      html: '<p>body</p>',
    });

    expect(doc).not.toContain('<header>');
    expect(doc).toContain('<meta name="email-from" content="sender@example.com">');
    expect(doc).toContain('<title>Subject line</title>');
  });
});
