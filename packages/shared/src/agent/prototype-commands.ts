/**
 * `prototype_tool`'s commands.
 *
 * A prototype's own workflow: its files (pages, patches, the brief, the contract, the
 * deliverables) and the flow they describe, shown in the same shared window the browser's own
 * commands drive. The window's surface is `browser-commands.ts`; the CLI both doors read their
 * command line with is `command-cli.ts`, which knows neither door.
 */

import type { BrowserPaneFns } from './browser-pane.ts';
import type { PrototypePagesChange } from '../prototypes/pages.ts';
import { whyPrototypeIsNotSettled } from '../prototypes/status.ts';
import {
  type BrowserCommandImage,
  type BrowserCommandResult,
  type ToolCommandArgs,
  type ToolCommandContext,
  createCommandRunner,
  durationOption,
  getPageMetrics,
  numberOption,
  resolveLocalPath,
} from './command-cli.ts';

/**
 * `prototype_tool --help`.
 *
 * Written the way the tool's own description is: what it acts on (a prototype's **files**) and
 * what it drives (the shared **window**), because those are the two things a session has to
 * understand before a single one of these commands means anything.
 */
export function getPrototypeToolHelp(): string {
  return [
    'prototype_tool command help',
    '',
    'Usage (one command per call — no batching):',
    '  --help',
    '  list                                           prototypes in this workspace, their pages, and which is bound',
    '  create <name> [--no-bind]                      create a prototype (a container: it starts with no pages)',
    '  pages [slug] [--add <name>[=<url>]] [--rename <old>=<new>] [--remove <name>] [--change <name>=<url>]',
    '                                                 the flow\'s pages, in order. <name>=<url> adds a live page;',
    '                                                 <name> alone places an existing document; --remove deletes a',
    '                                                 document of ours with its page; --change re-points one live page',
    '                                                 at another environment',
    '  entry <name|none>                              which page the address root opens (none = the page index)',
    '  open [slug] [--page <name>]                    open it in a tab of its own: the page you are on,',
    '                                                 else the entry page, else the generated index',
    '  apply [slug] [--file <path>]                   replay its patches and register them (they survive a reload);',
    '                                                 --file replays one file: the patch just written',
    '  clear [slug]                                   take prototype patches back out of the page',
    '  sample-video <path> [--slug <slug>]            frames out of a recording you made elsewhere',
    '                                                 (--every <dur>, --changes for only what moved, --max <n>)',
    '  verify [slug]                                  answer the checks "PRD.md" declares (selector / endpoint)',
    '  contract-compose [slug] [--service <svc>]      fragments → services/<svc>/openapi.yaml',
    '  contract-export [slug] [--service <svc>]       the contract, packaged for the backend',
    '  mock-apply [slug] [--service <svc>]            answer the contract\'s x-mock responses on the tab you are on',
    '                                                 (fetch + XHR) — it replaces the program that was there',
    '  mock-clear                                     take that program back off the tab: every route, every service',
    '  status [slug]                                  the report: pages, patches, services, deliverables, what is owed',
    '  export [slug] [--strict]                       write the deliverable — dist/extension + the change spec;',
    '                                                 --strict refuses while anything is still owed',
    '',
    'A prototype is a **folder** plus a **flow of pages**. The folder is where the work lives, and it is',
    'yours to organize — "{workspace}/prototypes/{slug}/":',
    '  PRD.md             the brief: one "## R-001 …" entry per requirement, and the only file requirements',
    '                     are read from. Beside it: material in any format (personas, a glossary, a screenshot),',
    '                     and your pages — "<name>.html" is a page, and "_layout.html" is the shell they share.',
    '  patches/           the change layer: "<writer>-{nnn}-{name}.{css,js}" (the writer segment is your',
    '                     identity) for every page, "patches/<page>/…" for one. A name the scanner cannot',
    '                     parse is silently never replayed.',
    '  config.json        the page table: their order, and which one the address root opens.',
    '  services/{svc}/    the contract: "paths/*.yaml" fragments, "fixtures/", "state.json", "openapi.yaml".',
    '  research/          what you learned, one finding per file. Not packaged.',
    '  reviews/           the argument against the work, one dispute per file. Not packaged.',
    '  dist/              the deliverables.',
    'Pages and patches are written with the Write/Edit tools — no command here writes them for you.',
    '',
    'The flow is looked at in the workspace\'s **window**, the one the person and every conversation share:',
    '"open" adds a tab of its own (which is what lets two prototypes be worked on at once), "apply" and "clear"',
    'replay into the tab you are on, and "record" and the mock commands act on it too. Those take "--tab <id>"',
    '("tabs" in browser_tool lists them) to name another; without one they act on your own tab.',
    'No other command needs a tab: "list", "create", "pages", "entry", "contract-*", "status", "export" and',
    '"sample-video" work on files alone, and "verify" reads the page when one is open (its page',
    'checks are reported as skipped when none is). Everything else about the window, and every page primitive,',
    'is browser_tool\'s.',
    '',
    'Which prototype a command means is read from the page this session is on, when it is on one — your own',
    'tab first, then the one in front — and only then from this session\'s binding. So a command with no slug',
    'still works with no window open, as long as this conversation is bound; with neither, name one — or pass',
    '"--slug <slug>" where the command takes no positional (that is "sample-video", whose positional is the',
    'path). Binding is the person\'s: they set it in the app, or a "create" binds what it made.',
    'A page\'s name is its identity: "--page <name>" on the commands, "/<name>" on the address,',
    '"patches/<name>/" for its own changes. "entry <name|none>" decides what the address root opens, and',
    '"/_index" always lists the pages.',
    '',
    'Full rules and examples: docs/prototypes.md — read it before your first prototype command.',
    '',
    'Examples:',
    '  list',
    '  create Landing page                  (a container for pages; write cart.html and that is the first)',
    '  create Rival checkout --no-bind',
    '  pages --add payment=https://app.example.com/pay   (a live page, in flow order)',
    '  pages --add cart                     (place an existing cart.html in the flow)',
    '  entry cart                           (the address root opens cart from now on)',
    '  pages --change pay=https://staging.example.com/pay   (one live page, another environment)',
    '  open checkout-flow --page orders     (one page of a multi-page prototype)',
    '  apply                                (targets the bound prototype)',
    '  apply --file prototypes/cart/patches/ui-002-total.js   (just that patch)',
    '  sample-video ~/Desktop/demo.mp4 --changes   (frames out of a recording, into the bound prototype)',
    '  sample-video ~/Desktop/demo.mp4 --slug rival-checkout   (or into one you name)',
    '  contract-compose --service checkout-api',
    '  status',
    '  export',
  ].join('\n');
}

/**
 * Resolve which prototype a command targets.
 *
 * An explicit slug always wins, so a bound session can still reach a different
 * prototype for a one-off. Only when no argument is given do we fall back to the
 * session's binding — that fallback is the point of binding, and when there is
 * neither, the error names both ways out.
 *
 * A leading `--` is treated as "no slug" so that flags can follow the command
 * directly (`contract-compose --service checkout-api`).
 */
function resolvePrototypeSlug(fns: BrowserPaneFns, parts: string[], command: string): string {
  const explicit = parts[1];
  if (explicit && !explicit.startsWith('--')) return explicit;

  const bound = fns.getBoundPrototypeSlug?.();
  if (bound) return bound;

  throw new Error(
    `${command} needs a prototype. Pass one — "${command} <slug>" — or open it in this window first ` +
    `("open <slug>"), which is what makes the page say whose it is. "list" shows what exists.`,
  );
}

/**
 * How many frames one reply carries.
 *
 * A recording sampled on a timeline produces dozens of near-identical pictures, and what reads the
 * reply is a model. All of them are written; this is the sample that goes into the conversation.
 */
const FRAME_PREVIEW_COUNT = 6;

/**
 * The frames a reply carries out of a capture.
 *
 * Evenly spread and always including the first and the last, so what the recording opened on and
 * what it ended at are both there — a capture is read for its shape, not step by step.
 */
function previewFrames(images: Array<{ path: string; bytes: Uint8Array }>): BrowserCommandImage[] {
  const picked =
    images.length <= FRAME_PREVIEW_COUNT
      ? images
      : Array.from({ length: FRAME_PREVIEW_COUNT }, (_unused, i) => {
          const at = Math.round((i * (images.length - 1)) / (FRAME_PREVIEW_COUNT - 1));
          return images[at]!;
        });

  return picked.map((image) => ({
    data: Buffer.from(image.bytes).toString('base64'),
    mimeType: 'image/jpeg' as const,
    sizeBytes: image.bytes.length,
    path: image.path,
  }));
}

/**
 * One prototype command, once the command line has been read.
 *
 * The three things this door says about itself: its help, its command table, and what an unknown
 * command means — a prototype command we do not have, or one of `browser_tool`'s, which is why the
 * message names that tool (a bare `snapshot` reads perfectly plausible here).
 */
const runOneCommand = createCommandRunner({
  help: getPrototypeToolHelp,
  run: runPrototypeCommand,
  unknownCommand: (cmd) =>
    `Unknown prototype_tool command "${cmd}". One command per call — "--help" lists them. ` +
    `Driving the window itself (navigate, snapshot, click, evaluate, tabs, …) is browser_tool's.`,
});

/**
 * Run a `prototype_tool` command.
 *
 * Same CLI, same `fns`, other door: these commands act on a prototype's own files and on the flow
 * in the shared window, and none of them is a browser primitive.
 *
 * **One command per call, no batches.** A batch exists so that one *action* made of several steps
 * — filling a form, then clicking submit — is one call. A prototype command is already such a
 * step, and the person following the work reads it better one at a time than as a list of four
 * things that have already happened.
 */
export async function executePrototypeToolCommand(args: ToolCommandArgs): Promise<BrowserCommandResult> {
  const empty = Array.isArray(args.command) ? args.command.length === 0 : !args.command.trim();
  if (empty) {
    throw new Error('Missing command. Use "--help" to see the prototype_tool commands.');
  }

  return runOneCommand(args);
}

export async function runPrototypeCommand(ctx: ToolCommandContext): Promise<BrowserCommandResult | null> {
  const { fns, parts, cmd } = ctx;

  if (cmd === 'list') {
    const prototypes = await fns.listPrototypes();
    const bound = fns.getBoundPrototypeSlug?.() ?? null;

    if (prototypes.length === 0) {
      return {
        output: [
          'No prototypes in this workspace yet.',
          'Create one with "create <name>" — it is a container for pages: a page is either',
          'a document of ours (write cart.html) or a live page of someone else\'s (pages --add pay=<url>).',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    // Which prototypes the flow has, and what pages each one is made of — the
    // second is the prototype's own shape, and a page's kind decides how it is
    // changed, so it is listed here rather than left for a second command.
    const lines = [
      `${prototypes.length} prototype${prototypes.length === 1 ? '' : 's'} in this workspace` +
      `${bound ? ` (this session is bound to "${bound}")` : ' (this session is not bound to one)'}:`,
    ];
    for (const prototype of prototypes) {
      const notes: string[] = [];
      if (prototype.slug === bound) notes.push('BOUND');
      // Having no pages is the normal state of a new prototype, so it is said the
      // same way the panel says it — as the thing that decides whether anything
      // can be opened at all.
      if (!prototype.pageAvailable) notes.push('no pages yet');
      notes.push(`${prototype.pages.length} page${prototype.pages.length === 1 ? '' : 's'}`);
      notes.push(`${prototype.patches.total} patch${prototype.patches.total === 1 ? '' : 'es'}`);
      if (prototype.entryPage) notes.push(`entry: ${prototype.entryPage}`);
      lines.push(`  • ${prototype.slug} — ${notes.join(', ')}`);
      // The pages are the prototype's own shape, and a page's kind decides how it
      // is changed — so they are listed here rather than left for a second command.
      for (const page of prototype.pages) {
        const where = page.kind === 'overlay' ? (page.url ?? 'no address') : (page.file ?? 'document missing');
        lines.push(`      ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${where}`);
      }
      if (prototype.pageIssues.length > 0) {
        for (const issue of prototype.pageIssues) lines.push(`      ! ${issue.text}`);
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'create') {
    // `--no-bind` exists for one reason: creating a prototype you only mean to
    // study must not steal the session's binding, or every later slug-less command
    // would retarget the page being studied instead of the page being built.
    const noBind = parts.includes('--no-bind');

    // Creation takes a name and nothing else (plan §19.8). A leftover flag from
    // when it also asked for a kind or an address would otherwise be swallowed by
    // the name — and an address silently folded into a slug is not a mistake
    // anyone would find later.
    const unknownFlag = parts.slice(1).find((part) => part.startsWith('--') && part !== '--no-bind');
    if (unknownFlag) {
      throw new Error(
        `create does not take "${unknownFlag}". It only needs a name — pages come afterwards: ` +
          `write <name>.html for a page of ours, or "pages --add <name>=<url>" for one that belongs ` +
          `to a real site.`,
      );
    }

    const name = parts
      .slice(1)
      .filter((part) => part !== '--no-bind')
      .join(' ')
      .trim();

    if (!name) {
      throw new Error('create needs a name. Example: create Checkout flow');
    }

    // Nothing about the pages is decided here: a page's kind is a fact about that
    // page, and creation is the container (plan §19.8). The address used to be
    // required at this point, which made the container carry a page's fact.
    const created = await fns.createPrototype({ name });
    if (!noBind) await fns.bindPrototype(created.slug);

    const lines = [
      noBind
        ? `Created prototype "${created.slug}" (not bound — this session still targets its own prototype).`
        : `Created prototype "${created.slug}" and bound this session to it.`,
      `  dir: ${created.dir}`,
      '',
      'It has no pages yet — a starting state, not a mistake. A page is one of two things:',
      '  • a document of ours: write cart.html with the file tools, and it is a page.',
      '  • a page that belongs to a real site: pages --add pay=https://app.example.com/pay',
      '     (study it with the browser tool before writing selectors — the live DOM is the only thing',
      '      that says what they will match).',
      '',
      'Then "entry cart" if the address root should open one of them (without an entry it lists',
      'them), and "open" to look at the result.',
    ];

    if (!noBind) lines.push('', 'Commands now target it by default.');

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  // Which page the address root opens (plan §19.3). Its own command rather than a
  // flag on pages: it is the one change to the table that is about the
  // prototype's front door rather than about the flow.
  //
  // Its only positional argument is a page name, so it does not go through
  // `resolvePrototypeSlug`: what the page says, or the binding, names the prototype.
  if (cmd === 'entry') {
    const value = parts.slice(1).find((part) => !part.startsWith('--'));
    if (!value) {
      throw new Error('entry needs a page name, or "none". Example: entry cart');
    }

    const slug = fns.getBoundPrototypeSlug?.() ?? null;
    if (!slug) {
      throw new Error(
        `entry changes the page the address root opens, on the prototype this is working on, and none is ` +
          `in view — open it first ("open <slug>") or ask the person to bind this conversation. "list" shows what exists.`,
      );
    }

    const result = await fns.setPrototypePages(slug, {
      op: 'entry',
      name: value.toLowerCase() === 'none' ? null : value,
    });

    const lines = [`Prototype "${slug}": ${result.note}.`];
    lines.push(
      ...(result.pages.length === 0
        ? ['  no pages declared yet']
        : result.pages.map(
            (page) =>
              `  ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${page.url ?? 'a document of ours'}`,
          )),
      '',
      'The generated page index stays reachable at /_index, so configuring an entry never takes the list away.',
      'Re-export to put this in the delivered extension (the toolbar icon opens the entry page).',
    );

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  // The page table: the flow's *other* real addresses. One list, because the same
  // data feeds "status", "open --page", the page name in
  // "snapshot", and the extension's match patterns — a second place to edit it
  // would be a second thing to drift.
  if (cmd === 'pages') {
    const slug = resolvePrototypeSlug(fns, parts, 'pages');

    // One change at a time: "add this page and rename that one" is two decisions,
    // and reporting them as one line would hide which one failed.
    const flags = ['--add', '--remove', '--rename', '--change'].filter((flag) => parts.includes(flag));
    if (flags.length > 1) {
      throw new Error(`pages takes one change at a time (got ${flags.join(' and ')}).`);
    }
    const flag = flags[0];
    const value = flag ? parts[parts.indexOf(flag) + 1] : undefined;
    if (flag && (!value || value.startsWith('--'))) {
      throw new Error(
        flag === '--remove'
          ? 'pages --remove needs a page name. Example: pages --remove payment'
          : flag === '--rename'
            ? 'pages --rename needs old=new. Example: pages --rename cart=basket'
            : flag === '--change'
              ? 'pages --change needs <name>=<url>. Example: pages --change payment=https://staging.example.com/pay'
              : 'pages --add needs a page name, and a url for a live page. Examples: ' +
                'pages --add payment=https://app.example.com/pay · pages --add orders',
      );
    }

    // Re-pointing one live page at another environment is an edit to the same table, so it is a
    // flag here and not a command of its own. The rules stay where they were (`target.ts`): a
    // scratch page is refused — its document *is* the page, so an address for it means nothing —
    // the address has to be one a browser can open, and the two things that go stale silently
    // are said out loud, because a patch that matches nothing looks exactly like a patch that
    // did nothing.
    if (flag === '--change') {
      const separator = value!.indexOf('=');
      const name = separator > 0 ? value!.slice(0, separator).trim() : '';
      const url = separator > 0 ? value!.slice(separator + 1).trim() : '';
      if (!name || !url) {
        throw new Error(
          'pages --change needs <name>=<url>. Example: pages --change payment=https://staging.example.com/pay',
        );
      }

      const before = await fns.prototypeStatus(slug);
      const page = before.pages.find((candidate) => candidate.name === name);
      if (!page) {
        throw new Error(
          `Prototype "${slug}" has no page "${name}". Pages: ${before.pages.map((candidate) => candidate.name).join(', ') || 'none'}`,
        );
      }

      const updated = await fns.setPrototypePageUrl(slug, url, name);
      const after = (updated.pages ?? []).find((candidate) => candidate.name === name)?.url;

      const lines = [
        `Prototype "${slug}": page "${name}" ${page.url ? 'pointed somewhere else' : 'given an address'}`,
      ];
      if (page.url) lines.push(`  from: ${page.url}`);
      lines.push(`  to:   ${after ?? url}`, '');
      lines.push(
        'What follows from this:',
        '  • "open" goes to the new address, and the next "export" names it in dev-spec.md and',
        '    scopes the extension to it.',
        '  • Windows already showing the old page keep it until they navigate again — re-open to move them.',
        '  • The patches were written against the old page. Another environment (or the same one after a deploy) may',
        '    not have the same DOM, and a patch that matches nothing looks exactly like a patch that did nothing —',
        '    re-check them on the new address.',
        '  • The page\'s kind is still fixed: this changes where the page is, not what it is.',
      );

      return { output: lines.join('\n'), appendReleaseHint: true };
    }

    let change: PrototypePagesChange | null = null;
    if (flag === '--remove') {
      change = { op: 'remove', name: value! };
    } else if (flag === '--rename') {
      const separator = value!.indexOf('=');
      if (separator <= 0) {
        throw new Error('pages --rename needs old=new. Example: pages --rename cart=basket');
      }
      change = { op: 'rename', from: value!.slice(0, separator), to: value!.slice(separator + 1) };
    } else if (flag === '--add') {
      // `name=url` adds a page that belongs to a real site; a bare `name` places
      // one of our documents in the flow order, which is the only thing the table
      // can do about a page that is a file (plan §19.8).
      const separator = value!.indexOf('=');
      change = separator <= 0
        ? { op: 'add', name: value! }
        : { op: 'add', name: value!.slice(0, separator), url: value!.slice(separator + 1) };
    }

    if (change) {
      const result = await fns.setPrototypePages(slug, change);
      const lines = [`Prototype "${slug}": ${result.note}.`];
      lines.push(
        ...(result.pages.length === 0
          ? ['  the table is empty — a document in the prototype directory is still a page']
          : result.pages.map(
              (page) =>
                `  ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${page.url ?? 'a document of ours'}`,
            )),
        '',
        // The deliverable is a snapshot (§17.4): a page added now is not in the
        // extension someone already loaded, and nothing else would say so.
        'Re-export to put this in the delivered extension: the package is a snapshot of the prototype, so it does',
        'not see this change until it is built again.',
      );
      return { output: lines.join('\n'), appendReleaseHint: true };
    }

    const status = await fns.prototypeStatus(slug);
    if (status.pages.length === 0) {
      return {
        output:
          `Prototype "${slug}": no pages yet. Write one (a top-level <name>.html in ${status.dir}), or add a live ` +
          `page with "pages --add <name>=<url>".`,
        appendReleaseHint: true,
      };
    }

    const lines = [`Prototype "${slug}": ${status.pages.length} page(s), in flow order`];
    for (const page of status.pages) {
      const where = page.kind === 'overlay' ? (page.url ?? 'no address') : (page.file ?? 'document missing');
      lines.push(`  ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${where}`);
    }
    lines.push('');
    lines.push(
      status.entryPage
        ? `The address root opens "${status.entryPage}" — change that with "entry <name|none>".`
        : 'The address root shows the generated page index — "entry <name>" picks a page instead.',
    );
    lines.push('Change the flow:');
    lines.push('  pages --add <name>=<url>    add a page that belongs to a real site (we patch it in place)');
    lines.push('  pages --add <name>          place an existing <name>.html in the flow order');
    lines.push('  pages --rename <old>=<new>  ·  --remove <name>  (removing a page of ours deletes its document)');
    lines.push('  pages --change <name>=<url>    point one live page at the same page in another environment');
    if (status.pageIssues.length > 0) {
      lines.push('', 'Issues (fix or acknowledge these — they are screens or patches nothing will reach):');
      for (const issue of status.pageIssues) lines.push(`  • ${issue.text}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'apply') {
    const slug = resolvePrototypeSlug(fns, parts, 'apply');

    // One file, when the command names one: the patch that was just written, put on the page
    // without replaying (or un-registering) everything else the page carries.
    const fileAt = parts.indexOf('--file');
    let file: string | undefined;
    if (fileAt !== -1) {
      const named = parts[fileAt + 1]?.trim();
      if (!named || named.startsWith('--')) {
        throw new Error(
          '--file needs a path. Example: apply --file prototypes/cart/patches/ui-002-total.js',
        );
      }
      file = resolveLocalPath(named, ctx.workspaceRootPath);
    }

    const result = await fns.applyPrototype(slug, file ? { file } : undefined);
    const count = (n: number) => `${n} patch${n === 1 ? '' : 'es'}`;
    const lines: string[] = [];

    // Which page's patches these are is not decoration: a page-scoped patch
    // (`patches/<page>/…`) only ever lands on that page, so "the patch did nothing"
    // and "the patch belongs to another page" have to be distinguishable here.
    if (result.applied > 0 && result.file) {
      lines.push(
        `Prototype "${result.slug}": applied patches/${result.file.name}` +
          (result.file.page
            ? ` — the page "${result.file.page}" brings it`
            : ' — a shared patch, so every page brings it'),
      );
      lines.push('It is also registered for future documents, so it survives a page reload.');
      // Naming one file does not change which page the DOM belongs to: a patch of another
      // page is injected into a document that does not have its elements, and every target
      // below would report "matched nothing" as though the selectors were wrong.
      if (result.file.page && result.page && result.file.page !== result.page) {
        lines.push(
          `Note: this command acted on the page "${result.page}", which does not bring that patch — ` +
          `anything below that matched nothing may just be the wrong page being open.`,
        );
      }
    } else if (result.applied > 0) {
      lines.push(
        `Prototype "${result.slug}": applied ${count(result.applied)}` +
          `${result.page ? ` for page "${result.page}"` : ' (the shared patches only — no page of this flow is on screen)'}`,
      );
      lines.push(...result.files.map((file) => `  • ${file}`));
      lines.push('Patches are also registered for future documents, so they survive a page reload.');
    } else if (result.skipped.length > 0) {
      // The rendered page is the normal case for this: it arrives with every
      // patch inlined, so there is genuinely nothing to do.
      lines.push(
        result.file
          ? `Prototype "${result.slug}": nothing to inject — the page already carries patches/${result.file.name}.`
          : `Prototype "${result.slug}": nothing to inject — this page already carries all ${count(result.skipped.length)}.`,
      );
    } else {
      // Not reachable with `--file` (a file that is not a patch is refused, with the reason,
      // before anything is injected), so this is the whole-set case only.
      lines.push(`Prototype "${result.slug}": nothing to inject — no patch files found (expected patches/{writer}-{nnn}-{name}.{css|js}).`);
    }

    if (result.applied > 0 && result.skipped.length > 0) {
      lines.push(`Left alone, already inlined here: ${result.skipped.join(', ')}.`);
    }
    if (result.skipped.length > 0) {
      lines.push('Inlined means the host rendered it from disk — a patch whose contents changed since then still counts as inlined, so run "reload" to pick the change up.');
    }

    // What the patches made of the page (plan §21.1). This is the difference
    // between "the change did nothing" and "the selector is wrong", and between
    // both of those and "the page moved since the patch was written".
    if (result.unmatched && result.unmatched.length > 0) {
      lines.push(
        `Declared targets that matched nothing (and have never matched): ${result.unmatched.join(', ')} — ` +
          `the selectors are wrong, or the page is not the one they were written against.`,
      );
    }
    for (const drift of result.drifted ?? []) {
      const when = drift.lastMatchedAt ? `last matched ${drift.lastMatchedAt}` : 'recorded by an earlier apply';
      const suggestions =
        drift.suggestions.length > 0
          ? ` On the page now: ${drift.suggestions.join(', ')}.`
          : '';
      lines.push(
        `Target "${drift.target}" matched nothing but is on record (${when}) — the page moved rather than the patch ` +
          `being wrong.${suggestions}`,
      );
    }
    if (result.untargeted && result.untargeted.length > 0) {
      lines.push(
        `No "@target" declared, so nothing could check these: ${result.untargeted.join(', ')}. ` +
          `Add a header line '@target <css selector>' and the next apply will say whether it still matches.`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  // Frames out of a recording somebody else made — the same kind of evidence as a screenshot, and
  // written the same way under research/frames/, but a different act: this reads a file that already
  // exists, and the position inside it (`0:12.4`) is the coordinate a reader of a video can use.
  if (cmd === 'sample-video') {
    const path = parts[1];
    if (!path || path.startsWith('--')) {
      throw new Error(
        'Which recording? "sample-video <path>" — the video to sample frames out of.',
      );
    }

    // The frames belong to a prototype's research/, so there has to be one: this command's only
    // positional is the path, which is why it takes the prototype as a flag when the session is
    // not bound to the one you mean.
    const slugAt = parts.indexOf('--slug');
    const named = slugAt >= 0 ? parts[slugAt + 1] : undefined;
    if (slugAt >= 0 && (!named || named.startsWith('--'))) {
      throw new Error(
        'sample-video --slug needs a slug. Example: sample-video demo.mp4 --slug checkout-flow',
      );
    }

    const slug = named ?? fns.getBoundPrototypeSlug?.();
    if (!slug) {
      throw new Error(
        'No prototype to keep the frames in. Pass one ("sample-video <path> --slug <slug>") or open it ' +
          'first ("open <slug>"). "list" shows what exists.',
      );
    }

    const result = await fns.importPrototypeVideo({
      slug,
      path,
      mode: parts.includes('--changes') ? 'changes' : 'timeline',
      everyMs: durationOption(parts, '--every', 2000),
      maxFrames: numberOption(parts, '--max', 40, 1, 400),
    });

    const lines = [
      `Sampled ${result.frames} frame${result.frames === 1 ? '' : 's'} out of ${result.video} ` +
        `(${Math.round(result.durationMs / 1000)}s long) into research/frames/${result.session}/`,
      ...result.files.map((file) => `  • ${file}`),
    ];
    if (result.truncated) {
      lines.push('The sampling hit its frame ceiling, so this is a sample of the recording.');
    }
    lines.push('Cite these from a finding (evidence: frames/<session>/frame-0001.jpg).');

    // The same frames the recording wrote, handed to whoever is reading the conversation: the
    // files are the record, and a wall of paths is not something anyone can look at.
    const shown = previewFrames(result.images);
    if (shown.length < result.images.length) {
      lines.push(
        '',
        `Showing ${shown.length} of the ${result.images.length} frames; all of them are in ` +
          `research/frames/${result.session}/.`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true, images: shown };
  }

  if (cmd === 'verify') {
    const slug = resolvePrototypeSlug(fns, parts, 'verify');
    const result = await fns.verifyPrototype(slug);

    const lines = [
      `Acceptance — round ${result.round}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`,
      result.page
        ? `Page checks ran against ${result.page}.`
        : 'No page was open, so page checks were skipped.',
      '',
      ...result.results.map(
        (entry) => `${entry.status.toUpperCase().padEnd(4)} ${entry.requirementId} ${entry.target} — ${entry.detail}`,
      ),
      '',
    ];

    // What moved against the round before. A count cannot be acted on — five red is an emergency if
    // it was zero last time and a shrug if it was five — so the movement is the answer, and the
    // round is what makes it sayable.
    const movement = [
      ...result.diff.newRed.map((key) => `NEWLY RED   ${key}`),
      ...result.diff.stillRed.map((key) => `STILL RED   ${key}`),
      ...result.diff.notRun.map((key) => `NOT LOOKED  ${key} — it was red and this run could not check it`),
      ...result.diff.fixed.map((key) => `FIXED       ${key}`),
      ...result.diff.gone.map((key) => `UNDECLARED  ${key} — PRD.md no longer carries it`),
    ];
    if (result.previous) {
      lines.push(
        movement.length > 0
          ? `Since round ${result.previous.round}:`
          : `Nothing moved since round ${result.previous.round} — the same result.`,
      );
      lines.push(...movement.map((line) => `  ${line}`));
    } else {
      lines.push('First round — there is nothing to compare it against yet.');
    }
    lines.push('');

    // Each failure is an objection nobody has written down. Handing over the line to write is the
    // whole difference between a verdict that lives in the transcript and one the next reader finds.
    if (result.failed > 0) {
      lines.push('To argue with one of these, write a review under reviews/ (one dispute per file):');
      for (const entry of result.results.filter((check) => check.status === 'fail')) {
        lines.push(
          entry.kind === 'endpoint'
            ? `  about: endpoint ${entry.target} · status: open`
            : `  about: requirement ${entry.requirementId}${result.pageName ? ` (or: about: page ${result.pageName})` : ''} · status: open`,
        );
      }
      lines.push('A dispute about a patch needs "on:" too — the fingerprint status prints for it.');
      lines.push('');
    }

    lines.push(`Written to ${result.reportPath} (round recorded in acceptance/state.json)`);

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'clear') {
    const slug = resolvePrototypeSlug(fns, parts, 'clear');

    const result = await fns.clearPrototype(slug);
    const lines = [
      `Prototype "${result.slug}": removed ${result.removed.length} patch${result.removed.length === 1 ? '' : 'es'}`,
    ];
    if (result.removed.length > 0) {
      lines.push(...result.removed.map((key) => `  • ${key}`));
    }
    lines.push('Reload the page to drop their effects from the current document.');

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'export') {
    const slug = resolvePrototypeSlug(fns, parts, 'export');

    // The gate (plan §3.7). Without `--strict` the export still happens — the deliverable is a
    // snapshot of the current state, and being able to look at an unfinished prototype is the whole
    // point of building one — but what is outstanding is said out loud rather than left for the
    // recipient to discover. With `--strict`, an unsettled prototype is not exported at all: that is
    // the mode an unattended run uses, where nobody is reading the "by the way" lines.
    const strict = parts.includes('--strict');
    const status = await fns.prototypeStatus(slug);
    const outstanding = whyPrototypeIsNotSettled(status);
    if (strict && outstanding.length > 0) {
      throw new Error(
        [
          `Prototype "${slug}" is not settled, so nothing was exported (--strict). Still outstanding:`,
          ...outstanding.map((reason) => `  • ${reason.text}`),
          '',
          'Export without --strict to hand over the current state anyway: what is outstanding is written into the deliverable either way.',
        ].join('\n'),
      );
    }

    const result = await fns.exportPrototype(slug);
    const livePages = status.pages.filter((page) => page.kind === 'overlay').length;
    const ourPages = status.pages.length - livePages;

    const lines = [
      `Prototype "${result.slug}": exported ${result.pageCount} page(s) and ${result.applied} patch` +
        `${result.applied === 1 ? '' : 'es'} (build ${result.version})`,
      `  Extension: ${result.extensionDir}`,
      `  Spec: ${result.specPath}`,
      // The index of the rest: what each reader opens, in what order. It goes to the
      // recipient, not to us — the lines below are what *we* say about the same files.
      `  Handoff: ${result.handoffPath}`,
      // Only when there is one: a flow made only of live pages has no static half,
      // and printing an empty path would read as a broken export.
      ...(result.staticDir ? [`  Static: ${result.staticDir}`] : []),
      // And the live pages' half without an extension, for a browser that will not
      // load one.
      ...(result.bookmarkletPath ? [`  Bookmarklet: ${result.bookmarkletPath}`] : []),
      '',
    ];
    // The folder is one deliverable either way, but what it *does* differs by the
    // pages it covers, and so does what to tell the agent to verify: a live page
    // gets patched in a real browser, a page of ours is shipped inside the package.
    lines.push('The extension folder is the main deliverable: a loadable Chrome extension. Hand it over as it is; the');
    lines.push('README in it says where it applies, which responses are faked, and which build it is.');
    if (livePages > 0) {
      lines.push(
        `Loading it (chrome://extensions → Developer mode → Load unpacked) puts its patches on the ${livePages} live`,
        'page(s) it covers — nothing to click, and they survive a reload. After a re-export the recipient presses',
        'Reload on the extension.',
      );
    }
    // Gated on the file, not on there being live pages: a flow whose live pages have
    // nothing to apply has no bookmarklet, and describing one would send the reader
    // looking for a file that is not there.
    if (result.bookmarkletPath) {
      lines.push(
        '`bookmarklet.html` carries those same changes as links to drag onto the bookmarks bar — one per live page. It',
        'is the fallback and says so: a page can refuse a bookmark through its own policy, and it takes a click per',
        'page, per reload.',
      );
    }
    if (ourPages > 0) {
      lines.push(
        `The ${ourPages} page(s) of ours ship inside the package: the recipient opens Options (or the toolbar icon),`,
        'which shows the page index. To check that side here first:',
      );
    }
    if (result.pageUrl) lines.push(`  browser_tool navigate ${result.pageUrl}`);
    // The other half of the same pages, for a reader who should load nothing at
    // all: the extension is the carrier for what cannot travel in a file, and this
    // is what the pages of ours look like without one.
    if (result.staticPath) {
      lines.push(
        '`static/` beside it carries those same pages as single files — no host, no extension and nothing to load:',
        `double-click ${result.staticPath}, or send the file on. Live pages are not in there; they exist only at`,
        'their own addresses, through the extension.',
      );
    }
    if (result.warnings.length > 0) {
      lines.push(
        '',
        'The document had to be adapted for the extension (behaviour is unchanged):',
        ...result.warnings.map((warning) => `  - ${warning}`),
      );
    }
    if (result.staticWarnings.length > 0) {
      lines.push(
        '',
        'The static page(s) could not carry everything the document asks for:',
        ...result.staticWarnings.map((warning) => `  - ${warning}`),
      );
    }

    // Exported anyway, and said so: a package that quietly carries an unanswered objection is how a
    // "finished" prototype stops meaning anything. `dist/dev-spec.md` carries the same list to the
    // person who receives it.
    if (outstanding.length > 0) {
      lines.push(
        '',
        `Exported, but this prototype is not settled — ${outstanding.length} thing(s) still outstanding (in the spec too):`,
        ...outstanding.map((reason) => `  • ${reason.text}`),
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'contract-compose') {
    const slug = resolvePrototypeSlug(fns, parts, 'contract-compose');
    const serviceIdx = parts.indexOf('--service');
    const service = serviceIdx >= 0 ? parts[serviceIdx + 1] : undefined;

    const result = await fns.composeContract({ slug, service });
    const lines = [
      `Prototype "${slug}" service "${result.service}": composed ${result.endpoints} endpoint${result.endpoints === 1 ? '' : 's'}`,
      'Wrote services/<service>/openapi.yaml from the paths/ fragments.',
    ];
    if (result.conflicts.length > 0) {
      lines.push(`Duplicate path${result.conflicts.length === 1 ? '' : 's'} (last fragment in file-name order won): ${result.conflicts.join(', ')}`);
    }
    if (result.missingFixtures.length > 0) {
      lines.push(`x-mock fixtures referenced but missing: ${result.missingFixtures.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'contract-export') {
    const slug = resolvePrototypeSlug(fns, parts, 'contract-export');
    const serviceIdx = parts.indexOf('--service');
    const service = serviceIdx >= 0 ? parts[serviceIdx + 1] : undefined;

    const result = await fns.exportContract({ slug, service });
    const lines = [
      `Prototype "${slug}" service "${result.service}": exported contract with ${result.endpoints} endpoint${result.endpoints === 1 ? '' : 's'}`,
      `  openapi.yaml: ${result.openapiPath}`,
      `  contract.md:  ${result.docPath}`,
      `  fixtures:     ${result.fixtures} → ${result.fixturesDir}`,
    ];
    if (result.missingFixtures.length > 0) {
      lines.push(`Missing fixtures: ${result.missingFixtures.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'mock-apply') {
    const slug = resolvePrototypeSlug(fns, parts, 'mock-apply');
    const serviceIdx = parts.indexOf('--service');
    const service = serviceIdx >= 0 ? parts[serviceIdx + 1] : undefined;

    const result = await fns.applyMock({ slug, service });
    const lines = [
      `Prototype "${slug}" service "${result.service}": serving ${result.routes} mock route${result.routes === 1 ? '' : 's'} at the network layer`,
      'Covers fetch and XHR alike — the app does not need to point anywhere else.',
    ];
    // The stateful half, said in the terms the author wrote the contract in: the
    // routes that remember, and the store they remember in. Applying again resets
    // it, which is the one thing about state a reader has to know.
    if (result.stateful > 0) {
      lines.push(
        `${result.stateful} of them remember state (a path declaring \`x-mock-collection\`): what one request does, the next one sees.`,
        'The store starts from state.json on every apply, so re-running this command starts the flow over.',
      );
    }
    if (result.stateProblem) {
      lines.push(`State unusable: ${result.stateProblem}`);
    }
    if (result.stateIssues.length > 0) {
      lines.push(
        `Operations this mock cannot express, and did not build a route for (${result.stateIssues.length}):`,
        ...result.stateIssues.map((issue) => `  • ${issue}`),
      );
    }
    if (result.unmocked.length > 0) {
      lines.push(`Unmocked endpoints (${result.unmocked.length}): ${result.unmocked.join(', ')}`);
    }
    if (result.missingFixtures.length > 0) {
      lines.push(`Skipped — x-mock fixtures not found: ${result.missingFixtures.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'mock-clear') {
    await fns.clearMock();
    return {
      output: 'Mock cleared — requests fall through to the real network again.',
      appendReleaseHint: true,
    };
  }

  if (cmd === 'status') {
    const slug = resolvePrototypeSlug(fns, parts, 'status');

    const status = await fns.prototypeStatus(slug);

    const writerSummary = Object.entries(status.patches.byWriter)
      .map(([writer, count]) => `${writer}: ${count}`)
      .join(', ');

    const lines = [
      `Prototype "${status.slug}"`,
      `  dir:        ${status.dir}`,
      `  openable:   ${status.pageAvailable ? 'yes' : 'no pages yet — nothing to open'}`,
    ];

    // The prototype is a flow, so its screens are listed the way its patches are:
    // as the facts an agent needs before it decides what to change. A page of ours
    // is a document in the directory, a live page is a URL on the real site — and
    // the kind decides how each one is changed.
    if (status.pages.length === 0) {
      lines.push('  pages:      none yet');
    } else {
      status.pages.forEach((page, index) => {
        const entryMark = page.entry ? ' [entry]' : '';
        const where = page.kind === 'overlay'
          ? `— ${page.url ?? 'no address'}`
          : `— ${page.file ?? 'document missing'}`;
        lines.push(`  ${index === 0 ? 'pages:' : '      '}      ${page.name} (${page.kind})${entryMark} ${where}`);
      });
      lines.push(
        `  root:       ${status.entryPage ? `opens "${status.entryPage}"` : 'shows the generated page index'}`,
      );
    }

    if (status.pageIssues.length > 0) {
      // Anything dropped rather than guessed at, a document that is gone, a patch
      // directory nothing reaches: in every case the flow is missing a screen (or a
      // change is reaching nowhere), and this is the only place that says which.
      lines.push(`  page issues: ${status.pageIssues.length}`);
      for (const issue of status.pageIssues) {
        lines.push(`    • ${issue.text}`);
      }
    }

    lines.push(
      `  patches:    ${status.patches.total}${writerSummary ? ` (${writerSummary})` : ''}` +
        `${status.patches.total > 0 ? ` — ${status.patches.scoped} page-scoped, ${status.patches.total - status.patches.scoped} shared` : ''}`,
    );

    if (status.services.length === 0) {
      lines.push('  services:   none');
    } else {
      for (const service of status.services) {
        lines.push(
          `  service ${service.slug}: ${service.endpoints} endpoints, ${service.mockedEndpoints} mocked, ` +
            `${service.fragments} fragments, ${service.fixtures} fixtures` +
            // Said only when it is true: a service of fixed answers is the ordinary case, and
            // "0 keep state" would read like a count of something missing (plan §5.3).
            (service.statefulEndpoints > 0 ? `, ${service.statefulEndpoints} keep state` : ''),
        );
        if (service.missingFixtures.length > 0) {
          lines.push(`    missing fixtures: ${service.missingFixtures.join(', ')}`);
        }
      }
    }

    lines.push(`  dist:       ${status.distFiles.length > 0 ? status.distFiles.join(', ') : 'empty'}`);

    if (status.ownership.violations.length === 0) {
      lines.push(`  ownership:  OK (${status.ownership.inspected} files)`);
    } else {
      lines.push(`  ownership:  ${status.ownership.violations.length} violation(s)`);
      for (const violation of status.ownership.violations) {
        lines.push(`    • ${violation.path} — ${violation.reason}`);
      }
    }

    lines.push(
      `  reviews:    ${status.reviews.unresolved.length} standing of ${status.reviews.total} filed`,
    );
    lines.push(
      `  acceptance: ${
        status.acceptance
          ? `round ${status.acceptance.round} — ${status.acceptance.passed} passed, ${status.acceptance.failed} failed, ${status.acceptance.skipped} skipped`
          : 'never run here'
      }`,
    );

    // What is still owed, last, because it is the thing to act on. One line per reason, each
    // already a sentence — the gate and this output read the same function, so a run that would be
    // refused by 'export --strict' cannot look finished here.
    const outstanding = whyPrototypeIsNotSettled(status);
    if (outstanding.length === 0) {
      lines.push('  unresolved: nothing — every requirement is implemented, no dispute stands, no check is red');
    } else {
      lines.push(`  unresolved: ${outstanding.length}`);
      for (const reason of outstanding) {
        lines.push(`    • ${reason.text}`);
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'open') {
    const slug = resolvePrototypeSlug(fns, parts, 'open');

    const pageFlagIndex = parts.indexOf('--page');
    let requestedPage = pageFlagIndex >= 0 ? parts[pageFlagIndex + 1] : undefined;
    if (pageFlagIndex >= 0 && (!requestedPage || requestedPage.startsWith('--'))) {
      throw new Error('open --page needs a page name. Example: open checkout-flow --page orders');
    }

    const entry = await fns.prototypeEntry({ slug });

    // With more than one page, "open the prototype" no longer has a single
    // meaning, so an unqualified open starts from the page the bound window is
    // already on (plan §19.6) and falls back to the entry page — which itself
    // falls back to the generated index. A window that cannot be read is not a
    // reason to refuse the open; it just means there is no current page to prefer.
    if (!requestedPage) {
      try {
        const snapshot = await fns.snapshot();
        const window = snapshot.prototype;
        if (window?.slug === slug && window.page) requestedPage = window.page;
      } catch {
        // No browser window to ask — the entry page is the answer.
      }
    }

    // `--page` names a later screen; the list comes from the prototype's own
    // status, which is also what tells the agent which names exist.
    let url = entry.url;
    let openedPage: { name: string; kind: string } | null = null;
    if (requestedPage) {
      const status = await fns.prototypeStatus(slug);
      const page = status.pages.find((candidate) => candidate.name === requestedPage);
      if (!page) {
        const names = status.pages.map((candidate) => candidate.name).join(', ') || 'none';
        throw new Error(`Prototype "${slug}" has no page "${requestedPage}". Pages: ${names}`);
      }
      if (!page.url) {
        throw new Error(
          `Page "${requestedPage}" of "${slug}" has no address${
            page.kind === 'scratch' ? ' — its document is missing' : ' — nothing is serving this prototype\'s pages'
          }.`,
        );
      }
      url = page.url;
      openedPage = { name: page.name, kind: page.kind };
    }

    // The prototype gets a tab of its own rather than taking over the one on
    // screen (plan §22). "Open" used to mean "navigate this window", which is what
    // made two prototypes impossible to work on at once: the second open silently
    // replaced the first. The tab carries the prototype as its identity, because
    // an overlay's document is a third-party address and nothing in the URL will
    // say which prototype it is for.
    //
    // It opens behind the tab the person is on, like every other tab a command opens
    // (第十二轮): the window is shared, and the patches, the screenshots and the reads that
    // follow all land on this tab because it is the one this session works from — nobody
    // has to be looking at it for the work to happen. "tab-show <id>" is how it is brought
    // up for them, and the rail lists it either way.
    const openedTabId = await fns.createTab({
      activate: false,
      ...(entry.origin ? { prototype: { slug, origin: entry.origin } } : {}),
    });

    const result = await fns.navigate(url);

    // A live page is the site's own, which knows nothing about the prototype until
    // the patches land in it — opening the address and stopping there would show
    // the target page, not the prototype. A page of ours is rendered by the host
    // with its patches already inlined, so it needs nothing here.
    const opensLivePage = openedPage ? openedPage.kind === 'overlay' : entry.injectPatches;
    const applied = opensLivePage ? await fns.applyPrototype(slug) : null;

    // `entry.url` is the address we *asked* for — for a live page, the address
    // recorded on the prototype. Real sites redirect away from it all the time (a
    // sign-in wall is the usual reason), and the tab on screen now is the one the
    // patches just landed on. So read where the window actually is instead of
    // reporting the request as if it were the result: the live URL comes from the
    // document itself, never from the prototype's config.
    const live = await getPageMetrics(fns);

    const target = openedPage
      ? `page "${openedPage.name}" (${openedPage.kind})`
      : entry.page
        ? `entry page "${entry.page}"`
        : 'the page index (no entry page is set)';
    const lines = [
      opensLivePage
        ? `Prototype "${slug}": opened ${target} — the live page it changes — and replayed its patches into it:`
        : `Prototype "${slug}": opened ${target} with every patch applied:`,
      `  ${url}`,
    ];
    if (live?.url && live.url !== url) lines.push(`  landed on: ${live.url}`);
    if (!openedPage && !entry.injectPatches && entry.path) lines.push(`  base: ${entry.path}`);
    lines.push(`  Title: ${result.title || '(untitled)'}`);
    if (applied && applied.applied > 0) {
      lines.push(`Replayed ${applied.applied} patch${applied.applied === 1 ? '' : 'es'}: ${applied.files.join(', ')}`);
    }

    // Which tab of the window this is, and how many it now has: opening is what
    // creates tabs, so a reader that opens twice has two — said here because the
    // window's own tab list is the only place that shows it until the tab strip
    // exists. `--tab` names one; without a name a command acts on the tab you work
    // from, which this tab just became.
    const tabs = await fns.listTabs().catch(() => []);
    if (tabs.length > 0) {
      const others = tabs.length - 1;
      lines.push(
        others === 0
          ? `  Tab: ${openedTabId} (the window's only tab)`
          : `  Tab: ${openedTabId} — ${others} other tab${others === 1 ? '' : 's'} in this window. "tabs" lists them, "--tab <id>" targets one, "tab-show <id>" puts one on screen.`,
      );
    }

    lines.push('Edit and re-apply from here: patches added since this render still land on it.');

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  return null;
}
