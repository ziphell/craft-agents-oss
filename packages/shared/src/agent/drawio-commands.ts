/**
 * `drawio_tool`'s commands.
 *
 * Three of them: **pages** says what a diagram file holds, **export** turns one into a file that
 * travels (an SVG, a PNG, or a page that is a single file), and **render** puts the drawing in the
 * reply and writes nothing. Reading, keeping, looking — three answers, three commands.
 *
 * A `.drawio` file is written by the agent, with `Write`/`Edit`, the way every other file of its
 * work is written — the format is in `docs/drawio-tools.md`. What is not the agent's to do is
 * *draw*: that is the drawio webapp this app already ships, in a hidden window of its own (see
 * `BrowserPaneFns.exportDrawio`). This file is the command line in front of that, and the naming
 * rule nothing else has to learn.
 *
 * **"render" exists because well-formed is not the same as readable.** A diagram can be valid
 * XML and still be a wall of overlapping boxes; the only way to know is to look at it. That is
 * the same reason `video_tool` hands back frames rather than a description of a recording.
 */

import {
  type BrowserCommandImage,
  type BrowserCommandResult,
  type ToolCommandArgs,
  type ToolCommandContext,
  createCommandRunner,
  numberOption,
  resolveLocalPath,
} from './command-cli.ts';
import { DRAWIO_EXTENSIONS, type DrawioFormat, type DrawioTheme } from './browser-pane.ts';
import type { DrawioPage } from '../drawio/types.ts';

/**
 * What `--format` takes — four things, each named for the file it writes.
 *
 * Two of them are the whole life of a document: `svg` is the picture (with the document inside it
 * too, when `--editable` is added), and `drawio` is the document itself, written out with its pages
 * uncompressed. drawio calls those two `xmlsvg` and `xml`, and those are the names the engine is
 * given — but they are not words this command line uses, because a caller asking for a file is
 * asking for a file: one of those two is not a drawing at all, and neither name says what you get.
 */
const DRAWIO_FORMATS = ['svg', 'png', 'html', 'drawio'] as const;
type ExportFormat = (typeof DRAWIO_FORMATS)[number];

/**
 * The formats whose file carries the document, so it can be opened and edited again: drawio's
 * `xmlsvg` (an svg asked for with `--editable`) and `xml` (the document itself).
 *
 * The others are drawings — a picture of the work, with nothing in them that points back at what they
 * came from, which the reply says out loud rather than leaving someone to find out.
 */
const CARRIES_THE_DOCUMENT = new Set<DrawioFormat>(['xmlsvg', 'xml']);

/**
 * The engine format for what the caller asked for — the one place the two vocabularies meet.
 *
 * `svg --editable` is drawio's `xmlsvg`: the drawing with a copy of its document inside it. `drawio`
 * is its `xml`. Nothing downstream of here needs to know the command line's words, and nothing here
 * needs to know how an export is actually made.
 */
function engineFormat(format: ExportFormat, editable: boolean): DrawioFormat {
  if (format === 'drawio') return 'xml';

  return format === 'svg' && editable ? 'xmlsvg' : format;
}

/** A diagram is drawn at its own size unless a scale is asked for — see `--scale`. */
const DEFAULT_SCALE = 1;

/**
 * The `--to` path with the format's own suffix, when the path names none.
 *
 * A path that names a suffix keeps it — what a caller named is theirs — and a dot anywhere in the
 * last segment counts as naming one. The rule is the same for all four formats rather than a special
 * case for `drawio`: a file that travels with no suffix at all is a file nothing opens by double
 * click, and for a diagram it is worse than that, because the app opens one by its `.drawio` name
 * and by nothing else.
 */
function withFormatSuffix(path: string, extension: string): string {
  const last = path.split(/[\\/]/).pop() ?? '';

  return last.includes('.') ? path : path + extension;
}

/**
 * `drawio_tool --help`.
 *
 * Written the way the tool's own description is: what each command makes, that the drawing is
 * drawio's own rather than something this app reimplements, and the one flag that is required
 * (`export --to`, because an export with no destination is a render).
 */
export function getDrawioToolHelp(): string {
  return [
    'drawio_tool command help',
    '',
    'Usage (one command per call — no batching):',
    '  --help',
    '  pages <diagram-file>',
    '  export <diagram-file> --to <path> [--format svg|png|html|drawio] [--editable] [--page <name>] [--scale <n>] [--theme auto|light|dark]',
    '  render <diagram-file> [--page <name>] [--scale <n>] [--theme auto|light|dark]',
    '',
    'A diagram that has to outlive the reply is a `.drawio` file: the form a person can open in',
    'draw.io, edit, and hand to someone else. You write that file with `Write`/`Edit` — the format',
    'is in `docs/drawio-tools.md`, and it is what this tool draws from.',
    '',
    'Nothing here draws with this app\'s own code: the drawing is the drawio webapp the app already',
    'ships, in a hidden window of its own — no window of yours is involved, and no diagram ever',
    'reaches the network.',
    '',
    'pages lists a file\'s pages and nothing else — read it before naming one with `--page`, because',
    'a page is addressed by the name the document gives it and there is no way to guess it.',
    '',
    'export draws a `.drawio` file into a file. `--to` is required: an export with nowhere to go',
    'is "render", which writes nothing. A path that names no suffix of its own gets the format\'s.',
    '  --format <f>     svg (the default), png, html, or drawio',
    '  --editable       with svg: the file carries the drawing\'s own document as well, so it opens',
    '                   in draw.io as the real diagram and can be changed and handed back',
    '  --page <name>    one page of a multi-page file, by the name the document gives it',
    '  --scale <n>      pixels per unit; 2 is a crisp PNG for a slide',
    '  --theme <t>      auto (the default), light, or dark — what the drawing is made for. An svg',
    '                   states it in the file (auto has it carry both and follow whoever shows it;',
    '                   light or dark pins it), a png is drawn that way. Only svg and png take it',
    '',
    'svg is the picture and nothing else — what you show someone. Add --editable and the picture',
    'carries the document it was drawn from: that is what you give to whoever might have to change',
    'the drawing, and draw.io opens it as the real diagram (its pages, its shapes, not a picture of',
    'one) to edit and hand back. It is the bigger file, because the document rides along with the',
    'drawing — and of a multi-page file the picture is the page drawn while the document inside is',
    'the whole file, unless `--page` cut the file down to one page first.',
    '',
    'drawio is not a drawing: it is the document itself, written out with every page uncompressed. It',
    'is what you want when a file someone else saved cannot be read or edited as text — `pages` says',
    'when that is the case. It is also the one format whose suffix matters to this app: a diagram is',
    'opened by its `.drawio` name, so the same document under a `.xml` name is only XML to it.',
    '',
    'A file can hold several pages (`<diagram>` elements), which is how one file carries a diagram',
    'per step, or a version per page. With no `--page`, a command draws the first page. Names rather',
    'than numbers, because a number would point at a different page the moment one is inserted; a',
    'name no page has — or one that two pages share — is refused, never drawn as something else.',
    '',
    'render draws the diagram as a picture and puts the picture in the reply, writing nothing.',
    'Reach for it to check what you drew: XML that is well-formed is not a diagram that reads',
    'well, and the only way to see a wall of overlapping boxes is to look.',
    '',
    'A relative path counts from the workspace root.',
    '',
    'Full rules and examples: docs/drawio-tools.md — read it before your first drawio command.',
    '',
    'Examples:',
    '  export flows/checkout.drawio --to out/checkout.svg',
    '  export flows/checkout.drawio --to out/checkout.png --format png --scale 2',
    '  export flows/checkout.drawio --to out/checkout.editable.svg --editable',
    '  export flows/checkout.drawio --to out/v2.svg --page "v2 split payment"',
    '  export compressed.drawio --to plain.drawio --format drawio',
    '  render flows/checkout.drawio',
  ].join('\n');
}

/**
 * One diagram command, once the command line has been read.
 *
 * The other doors have plausible-sounding commands of their own, so a refusal names them —
 * "unknown" alone leaves the agent with nowhere to go.
 */
const runOneCommand = createCommandRunner({
  help: getDrawioToolHelp,
  run: runDrawioCommand,
  unknownCommand: (cmd) =>
    `Unknown drawio_tool command "${cmd}". One command per call — "--help" lists them. ` +
    `Driving a window is browser_tool's; frames out of a recording are video_tool's.`,
});

/**
 * Run a `drawio_tool` command.
 *
 * **One command per call, no batches.** A conversion is one document and a rendering is one
 * picture; a batch has nothing to combine into.
 */
export async function executeDrawioToolCommand(args: ToolCommandArgs): Promise<BrowserCommandResult> {
  const empty = Array.isArray(args.command) ? args.command.length === 0 : !args.command.trim();
  if (empty) {
    throw new Error('Missing command. Use "--help" to see the drawio_tool commands.');
  }

  return runOneCommand(args);
}

/** The value after a flag, or the error that says what it needed to be. */
function flagValue(parts: string[], flag: string, example: string): string {
  const named = parts[parts.indexOf(flag) + 1];
  if (!named || named.startsWith('--')) {
    throw new Error(`${flag} needs a value. Example: ${example}`);
  }
  return named;
}

/** `--scale`, or undefined so drawio's own scale stands. */
function scaleOption(parts: string[]): number | undefined {
  if (!parts.includes('--scale')) return undefined;
  flagValue(parts, '--scale', 'export flow.drawio --to flow.png --format png --scale 2');
  return numberOption(parts, '--scale', DEFAULT_SCALE, 0.1, 16);
}

/**
 * `--page`, the name the document gives the page.
 *
 * Only a value: which page a name is, the document answers, and this side never opens the file —
 * `exportDrawio` is handed the name and resolves it against the document it reads.
 */
function pageOption(parts: string[]): string | undefined {
  if (!parts.includes('--page')) return undefined;
  return flagValue(parts, '--page', 'export flow.drawio --to flow.svg --page "v2 split payment"');
}

/** What `--theme` takes — the three answers drawio's own export has for a drawing's scheme. */
const DRAWIO_THEMES = ['auto', 'light', 'dark'] as const;

/**
 * `--theme` — what the drawing is made for, and the one axis there is.
 *
 * One value, honoured two ways, which is why this is not "belongs to svg" the way `--editable` is:
 * an **SVG** *states* it in the file (drawio writes `color-scheme` onto its root, so `auto` leaves
 * the drawing following whoever shows it and `light`/`dark` pin it), while a **PNG** is simply
 * *drawn* that way — a picture has no reader to follow, so `auto` and `light` are the same picture.
 *
 * `html` and `drawio` are refused rather than ignored: neither is a drawing this export can state a
 * scheme for, and a caller who believes otherwise is a caller about to be surprised by it — the same
 * rule `--editable` follows.
 */
function themeOption(parts: string[], format: ExportFormat): DrawioTheme {
  if (!parts.includes('--theme')) return 'auto';

  const named = flagValue(parts, '--theme', 'export flow.drawio --to flow.svg --theme light');
  if (!(DRAWIO_THEMES as readonly string[]).includes(named)) {
    throw new Error(`--theme takes one of ${DRAWIO_THEMES.join(', ')} — not "${named}".`);
  }
  if (format === 'svg' || format === 'png') return named as DrawioTheme;

  throw new Error(
    `--theme is for svg and png: an svg states the scheme and a png is drawn by it — a ${format} is neither.`,
  );
}

/** `--format`, checked against the list rather than passed through: the engine's answer to an
 *  unknown format is a blank image, which is the one failure worth catching early. */
function formatOption(parts: string[]): ExportFormat {
  if (!parts.includes('--format')) return 'svg';
  const named = flagValue(parts, '--format', 'export flow.drawio --to flow.svg --format svg');
  if (!(DRAWIO_FORMATS as readonly string[]).includes(named)) {
    throw new Error(`--format takes one of ${DRAWIO_FORMATS.join(', ')} — not "${named}".`);
  }
  return named as ExportFormat;
}

/**
 * `--editable`, which belongs to `svg` and to nothing else.
 *
 * Refused rather than ignored where it means nothing: a caller asking for an editable PNG believing
 * it will carry the document is a caller about to hand over a file that does not — which is the same
 * mistake as drawing a page nobody asked for, and the same reason it is refused here.
 */
function editableOption(parts: string[], format: ExportFormat): boolean {
  if (!parts.includes('--editable')) return false;

  if (format === 'svg') return true;

  throw new Error(
    format === 'drawio'
      ? '--editable is for svg. drawio *is* the document — there is no picture for it to ride in.'
      : `--editable is for svg: a ${format} has no document to carry. What carries one is an SVG, ` +
          'which is why that is what you hand to whoever may have to change the diagram.',
  );
}

/** A diagram's pages as `pages` answers them: in order, and how to draw one. */
function describeDrawioPages(named: string, pages: DrawioPage[]): string {
  if (pages.length === 0) {
    return (
      `No pages in ${named}: it is not a drawio document. A .drawio file is an <mxfile> of <diagram> ` +
      'pages, and an SVG has pages only when it was exported with a copy of its document inside.'
    );
  }

  // Say it here rather than leave it to be discovered: a compressed page body is not XML anyone can
  // edit, and this listing is the one place that knows before somebody tries — see `--format drawio`.
  const compressed = pages.filter((page) => page.compressed).length
  const note =
    compressed === 0
      ? []
      : [
          '',
          `${compressed === pages.length ? 'Every page' : `${compressed} of its ${pages.length} pages`} ` +
            'is compressed, so the shapes in it are not readable as text. ' +
            '"export <file> --to <plain-file>.drawio --format drawio" writes the document out plain.',
        ]

  if (pages.length === 1) {
    const only = pages[0]!;
    return [
      `${named} has one page${only.name ? ` — "${only.name}"` : ''}, so there is nothing to choose: ` +
        'drawing the file draws it, and "--page" has no other page to name.',
      ...note,
    ].join('\n');
  }

  // The names are the whole point — they are what `--page` takes, and they cannot be guessed — so the
  // reply is arranged for reading them off, with the one a command draws by default marked.
  return [
    `${named} has ${pages.length} pages. "*" marks the page a command draws when no --page is given:`,
    '"--page <name>" draws another, named the way the document names it — in quotes when the name has',
    'spaces in it. A page the document never named cannot be asked for by name.',
    '',
    ...pages.map(
      (page, index) =>
        `  ${index === 0 ? '*' : ' '} ${page.name || '(no name)'}${page.compressed ? ' (compressed)' : ''}`,
    ),
    ...note,
  ].join('\n');
}

/**
 * A diagram command, run.
 *
 * Returns `null` for a command this door does not own, so the runner can say which door does.
 */
export async function runDrawioCommand(ctx: ToolCommandContext): Promise<BrowserCommandResult | null> {
  const { fns, parts, cmd, workspaceRootPath } = ctx;

  // Before the drawing commands: they read flags, and this one takes none.
  if (cmd === 'pages') {
    const named = parts[1];
    if (!named || named.startsWith('--')) {
      throw new Error('Which diagram? "pages <diagram-file>" — the .drawio file to list the pages of.');
    }
    if (parts.length > 2) {
      throw new Error(
        `pages takes a diagram file and nothing else — not "${parts.slice(2).join(' ')}". Which page ` +
        'to draw is "--page", on "export" and "render".',
      );
    }

    const pages = await fns.listDrawioPages({ path: resolveLocalPath(named, workspaceRootPath) });
    return { output: describeDrawioPages(named, pages), appendReleaseHint: false };
  }

  if (cmd === 'export' || cmd === 'render') {
    const named = parts[1];
    if (!named || named.startsWith('--')) {
      throw new Error(
        cmd === 'export'
          ? 'Which diagram? "export <diagram-file> --to <path>" — the .drawio file to draw.'
          : 'Which diagram? "render <diagram-file>" — the .drawio file to draw into the reply.',
      );
    }

    const path = resolveLocalPath(named, workspaceRootPath);
    const scale = scaleOption(parts);
    const page = pageOption(parts);
    // Naming the page back is how a caller knows the one it asked for is the one drawn — the name is
    // resolved against the document, so it is the document's answer, not an echo of the command.
    const ofPage = page !== undefined ? `, page "${page}"` : '';

    if (cmd === 'render') {
      // A render is a PNG, which is a drawing `--theme` is honoured for — read as one rather than as
      // the absent file a render has nothing to write it into.
      const theme = themeOption(parts, 'png');
      // A picture in the reply and nothing on disk: the point is that a model can look at what it
      // drew, and a path it cannot see is not that. Nothing in the sentence names the scheme: the
      // picture is right there, and a PNG cannot carry one to be said.
      const rendered = await fns.exportDrawio({
        path,
        format: 'png',
        ...(page !== undefined ? { page } : {}),
        ...(scale !== undefined ? { scale } : {}),
        theme,
      });
      const image: BrowserCommandImage = {
        data: Buffer.from(rendered.bytes).toString('base64'),
        mimeType: 'image/png',
        sizeBytes: rendered.bytes.length,
      };
      return {
        output: `Rendered ${named}${ofPage} at ${scale ?? DEFAULT_SCALE}× — the picture is above, and nothing was written.`,
        appendReleaseHint: false,
        image,
      };
    }

    if (!parts.includes('--to')) {
      throw new Error(
        '--to is required: an export has to say where it goes. Use "render" to look at it instead.',
      );
    }

    const format = formatOption(parts);
    const editable = editableOption(parts, format);
    const theme = themeOption(parts, format);
    const engine = engineFormat(format, editable);
    const extension = DRAWIO_EXTENSIONS[engine];
    const out = withFormatSuffix(
      resolveLocalPath(flagValue(parts, '--to', `export flow.drawio --to flow${extension}`), workspaceRootPath),
      extension,
    );
    const rendered = await fns.exportDrawio({
      path,
      format: engine,
      out,
      ...(page !== undefined ? { page } : {}),
      ...(scale !== undefined ? { scale } : {}),
      theme,
    });

    // What the file *is* travels with the answer: whether it carries its document, and whether it
    // follows whoever shows it or was pinned to one scheme. Only a *svg* says what it is drawn for —
    // a png is drawn that way and says nothing, so the reply does not either.
    const qualifiers = [
      ...(editable ? ['editable'] : []),
      ...(theme !== 'auto' && format === 'svg' ? [`fixed ${theme}`] : []),
    ];

    return {
      output: [
        `Wrote ${rendered.path ?? out} from ${named}${ofPage} — ${format}` +
          `${qualifiers.length > 0 ? ` (${qualifiers.join(', ')})` : ''}, ${rendered.bytes.length} bytes.`,
        ...(CARRIES_THE_DOCUMENT.has(engine)
          ? []
          : ['Nothing in the file points back at the app, or at the document it came from.']),
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

  return null;
}
