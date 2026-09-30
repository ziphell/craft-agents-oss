/**
 * `prototype_tool`'s commands.
 *
 * A prototype's own workflow: the folder it *is* — its `spec.md` (the index), the specs, and
 * the files beside them. The window's own surface is `browser-commands.ts`; the CLI both doors read
 * their command line with is `command-cli.ts`.
 */

import type { BrowserPaneFns } from './browser-pane.ts';
import { whyPrototypeIsNotSettled } from '../prototypes/status.ts';
import {
  type BrowserCommandResult,
  type ToolCommandArgs,
  type ToolCommandContext,
  createCommandRunner,
} from './command-cli.ts';

/**
 * `prototype_tool --help`.
 *
 * Written the way the tool's own description is: what it acts on (a prototype's **folder**) and what
 * it reads from it (the specs, the links), because that is what a
 * session has to understand before a single one of these commands means anything.
 */
export function getPrototypeToolHelp(): string {
  return [
    'prototype_tool command help',
    '',
    'Usage (one command per call — no batching):',
    '  --help',
    '  list                                           prototypes in this workspace, with their spec',
    '                                                 counts, and which one is bound',
    '  create <name> [--no-bind]                      create a prototype — a folder with a starter spec.md',
    '  status [slug]                                  the report: the specification, the files beside',
    '                                                 them, and what is still owed',
    '',
    'A prototype is a **folder**, and the work lives in it — it is yours to organize,',
    '"{workspace}/prototypes/{slug}/":',
    '  *.spec.md          the specification: one spec per file, the file\'s name its identity,',
    '                     in the folder or a subfolder. Beside it: material in any format (personas,',
    '                     a glossary, a screenshot) and whatever files the work is made of.',
    '  spec.md            the index the specification is read from — the entry document a "create"',
    '                     seeds, not a spec itself.',
    'Nothing here writes those files for you: the specification, the material beside it and the work\'s',
    'own files are written with the Write/Edit tools.',
    'What this report reads is the specification itself — the specs, whatever sits beside them,',
    'and any link that points at nothing.',
    '',
    'Which prototype a command means is read from this session\'s binding. A command with no slug works',
    'with no window open, as long as this conversation is bound; with no binding, name one. Binding is',
    'the person\'s: they set it in the app, or a "create" binds what it made. Every command here is file',
    'work on the prototype folder — none of them needs a browser window this conversation drives. The',
    'tool itself is the desktop app\'s, like "browser_tool" — a run without the app has neither.',
    '',
    'Frame out of a recording is not one of these commands: "video_tool sample <path>" reads a',
    'recording, which has nothing to do with a prototype.',
    '',
    'Full rules and examples: docs/prototypes.md — read it before your first prototype command.',
    '',
    'Examples:',
    '  list',
    '  create Landing page                  (a folder with a starter spec.md; you write everything in it)',
    '  create Rival checkout --no-bind',
    '  status',
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
 * directly (`create <name> --no-bind`).
 */
function resolvePrototypeSlug(fns: BrowserPaneFns, parts: string[], command: string): string {
  const explicit = parts[1];
  if (explicit && !explicit.startsWith('--')) return explicit;

  const bound = fns.getBoundPrototypeSlug?.();
  if (bound) return bound;

  throw new Error(
    `${command} needs a prototype. Pass one — "${command} <slug>" — or bind this conversation to ` +
    `one, which is what makes a slug-less command mean something. "list" shows what exists.`,
  );
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
 * Same CLI, same `fns`, other door: these commands act on a prototype's own folder — its brief and
 * the files beside it — and none of them is a browser primitive.
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
          'Create one with "create <name>" — a folder with a starter spec.md. Write each spec into',
          'its own "<name>.spec.md" file and the work\'s files beside it.',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    const lines = [
      `${prototypes.length} prototype${prototypes.length === 1 ? '' : 's'} in this workspace` +
      `${bound ? ` (this session is bound to "${bound}")` : ' (this session is not bound to one)'}:`,
    ];
    for (const prototype of prototypes) {
      const notes: string[] = [];
      if (prototype.slug === bound) notes.push('BOUND');
      // A prototype with no specs yet is the normal state of a new one, so it is
      // said as a count rather than as a problem.
      notes.push(`${prototype.specs.length} spec${prototype.specs.length === 1 ? '' : 's'}`);
      const fileCount = prototype.files.length + prototype.specificationFiles.length;
      notes.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
      lines.push(`  • ${prototype.slug} — ${notes.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'create') {
    // `--no-bind` exists for one reason: creating a prototype you only mean to
    // study must not steal the session's binding, or every later slug-less command
    // would retarget the prototype being studied instead of the one being built.
    const noBind = parts.includes('--no-bind');

    const unknownFlag = parts.slice(1).find((part) => part.startsWith('--') && part !== '--no-bind');
    if (unknownFlag) {
      throw new Error(
        `create does not take "${unknownFlag}". It only needs a name — the folder is the prototype, ` +
          `and everything in it is written by hand: each spec into its own "<name>.spec.md" file, ` +
          `the work's files beside it.`,
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

    const created = await fns.createPrototype({ name });
    if (!noBind) await fns.bindPrototype(created.slug);

    const lines = [
      noBind
        ? `Created prototype "${created.slug}" (not bound — this session still targets its own prototype).`
        : `Created prototype "${created.slug}" and bound this session to it.`,
      `  dir: ${created.dir}`,
      `  entry: ${created.entryPath}`,
      '',
      'It is a folder with a starter spec.md and nothing else yet. Write each spec into its own',
      'file ("<name>.spec.md", one spec per file — the file\'s name is its identity), then',
      'whatever files the work needs beside it. "status" then reports what the folder holds: the',
      'specs, the files beside them, and any link that points at nothing.',
    ];

    if (!noBind) lines.push('', 'Commands now target it by default.');

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'status') {
    const slug = resolvePrototypeSlug(fns, parts, 'status');

    const status = await fns.prototypeStatus(slug);

    const specCount = status.specs.length
    const specFiles = status.specificationFiles.map((file) => file.name).join(', ')
    const lines = [
      `Prototype "${status.slug}"`,
      `  dir:        ${status.dir}`,
      `  spec:       ${status.specificationFiles.length > 0 ? specFiles : 'not written yet'}`,
    ];

    // The specs. A spec is a file and nothing more: the report does not claim to know
    // what implements it, and the file's name (its identity) travels with the title.
    if (specCount > 0) {
      for (const spec of status.specs) {
        lines.push(`      ${spec.title || '(no title)'} (${spec.file})`);
      }
    }

    lines.push(
      `  files:      ${status.files.length > 0 ? status.files.map((file) => file.name).join(', ') : 'none yet'}`,
    );

    // What could not be read as written — a picture that no longer matches its diagram. Each is a
    // silent failure otherwise.
    if (status.briefIssues.length > 0) {
      lines.push(`  issues:     ${status.briefIssues.length}`);
      for (const issue of status.briefIssues) {
        lines.push(`    • ${issue.text}`);
      }
    }

    // What is still owed, last, because it is the thing to act on — the facts only: a link that
    // points at nothing. One line per reason, each already a sentence; the gate and this output read
    // the same function, so the report cannot look calmer than `whyPrototypeIsNotSettled` says the
    // work is.
    const outstanding = whyPrototypeIsNotSettled(status);
    if (outstanding.length === 0) {
      lines.push('  unresolved: nothing — every link resolves');
    } else {
      lines.push(`  unresolved: ${outstanding.length}`);
      for (const reason of outstanding) {
        lines.push(`    • ${reason.text}`);
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  return null;
}
