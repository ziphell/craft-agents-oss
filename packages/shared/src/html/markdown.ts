/// <reference path="../types/turndown-plugin-gfm.d.ts" />

/**
 * HTML → Markdown, one converter for every in-repo HTML conversion.
 *
 * Email bodies (`sources/email`) and Office attachments (`server-core`) used to
 * configure Turndown separately. They need the same table behaviour, so the
 * configuration lives here instead. `web_fetch` and `browser_tool read` are not
 * callers: they go through Defuddle, which carries its own, more elaborate
 * Turndown rules (nested tables, layout tables, math).
 *
 * GFM contributes strikethrough and task lists. Its `tables` rule is
 * deliberately not used: it keeps any table without a `<th>` heading row as raw
 * HTML, and both email and mammoth emit `<td>`-only tables. The rules below
 * promote the first row instead, and flatten `role="presentation"` scaffolding
 * so a newsletter does not turn into a one-cell grid.
 */

import TurndownService from 'turndown';
import { strikethrough, taskListItems } from 'turndown-plugin-gfm';

/**
 * The converter's instance type, not the default import's name.
 *
 * `@types/turndown` is `export =` a class merged with a namespace. Packages that typecheck this
 * file through `@craft-agent/shared` with `esModuleInterop: true` (the shared base config) get the
 * *namespace* in type position, so `TurndownService` cannot be named as a type there. Reading the
 * class out of the value space works under both configs.
 */
type Converter = InstanceType<typeof TurndownService>;

export function createMarkdownConverter(): Converter {
  const converter = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  converter.remove(['script', 'style', 'head', 'title']);
  converter.use([strikethrough, taskListItems]);
  addTableRules(converter);
  return converter;
}

const sharedConverter = createMarkdownConverter();

/** Convert an HTML fragment. The converter is stateless, so one instance is enough. */
export function htmlToMarkdown(html: string): string {
  return sharedConverter.turndown(html);
}

/**
 * The rules are annotated rather than inferred. Turndown's own `Rule` types are DOM-typed, and
 * this file is typechecked by node-only packages whose `lib` has no DOM (they import it through
 * `@craft-agent/shared`) — inferring would make every parameter an implicit `any` there. The
 * helpers take `unknown` and narrow themselves, which is also what the DOM shim needs at runtime.
 */
function addTableRules(converter: Converter): void {
  converter.addRule('tableCell', {
    filter: (node: unknown) => isDataCell(node),
    replacement: (content: string) => ` ${flattenCell(content)} |`,
  });
  converter.addRule('tableRow', {
    filter: (node: unknown) => asDomNode(node).nodeName === 'TR' && isDataTable(tableOf(node)),
    replacement: (content: string) => `|${content}\n`,
  });
  converter.addRule('table', {
    filter: 'table',
    replacement: (content: string, node: unknown) => {
      if (!isDataTable(asDomNode(node))) return `\n\n${content.trim()}\n\n`;

      const rows = content
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
      if (rows.length === 0) return '';

      const width = Math.max(1, ...rows.map((row) => row.length));
      const pad = (row: string[]) => [...row, ...Array(width - row.length).fill('')];
      const [head, ...body] = rows.map(pad);
      const format = (row: string[]) => `| ${row.join(' | ')} |`;

      return `\n\n${[format(head!), format(Array(width).fill('---')), ...body.map(format)].join('\n')}\n\n`;
    },
  });
}

function flattenCell(content: string): string {
  return content.trim().replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|');
}

/** The DOM shim Turndown uses in Node exposes these, but its types do not. */
interface DomNode {
  nodeName: string;
  closest?: (selector: string) => DomNode | null;
  getAttribute?: (name: string) => string | null;
}

function asDomNode(node: unknown): DomNode {
  return node as DomNode;
}

function tableOf(node: unknown): DomNode | null {
  return asDomNode(node).closest?.('table') ?? null;
}

function isDataCell(node: unknown): boolean {
  const cell = asDomNode(node);
  if (cell.nodeName !== 'TH' && cell.nodeName !== 'TD') return false;
  return isDataTable(tableOf(cell));
}

/** `role="presentation"` is the standard marker for layout scaffolding. */
function isDataTable(node: DomNode | null): boolean {
  if (!node) return false;
  return node.getAttribute?.('role')?.toLowerCase() !== 'presentation';
}
