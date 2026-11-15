/**
 * Make the Pi subprocess bundle able to see images on machines that did not
 * build it.
 *
 * Before an attachment reaches the model, the Pi SDK decodes and resizes it
 * (2000×2000 / 4.5 MB base64) with `@silvia-odwyer/photon-node` — a WASM module
 * it loads from a path derived from `__dirname`:
 *
 *     var __dirname = "C:\\Users\\<builder>\\…\\node_modules\\@silvia-odwyer\\photon-node";
 *     var path10 = __require("path").join(__dirname, "photon_rs_bg.wasm");
 *     var bytes = __require("fs").readFileSync(path10);
 *
 * `bun build --format=esm` inlines `__dirname` for every CJS dependency into a
 * literal of the machine that ran the build, so the artifact was only ever
 * correct *there*. Everywhere else the read fails, the SDK's own fallback scan
 * (next to the executable, `<exec>/photon/`, cwd) finds nothing either — and
 * because the wasm was never packaged, `loadPhoton()` returns null for **every**
 * image, of any size or format, and each attachment is replaced by
 * "[Image omitted: could not be resized below the inline image size limit.]".
 * The model never receives a picture; nothing about the image or the model
 * config can change that.
 *
 * Both halves of the fix live here so no consumer can ship one without the
 * other:
 *   1. the inlined literal becomes the directory the bundle runs from, and
 *   2. `photon_rs_bg.wasm` is placed next to the bundle (which is what that
 *      directory resolves to).
 *
 * The same pass also takes image resizing off the Pi SDK's worker path
 * (`resizeImage` → `resizeImageInWorker`). Neither worker entrypoint exists in
 * this bundle, so every image read spawned a worker that could not load, and on
 * Windows Bun 1.3.9 leaks the dying thread and then segfaults — the subprocess
 * dies mid-turn ("Pi subprocess exited unexpectedly (code 3)"). Resizing
 * in-process is what the SDK falls back to anyway, so the dead attempts only
 * cost a crash.
 *
 * Callers: `scripts/electron-build-main.ts` (the installer's copy of the
 * bundle), `scripts/electron-dev.ts` (dev) and `packages/pi-agent-server`'s own
 * `build` script (headless server, CI, `bundle-smoke.test.ts`). Run it directly
 * to repair an artifact already on disk:
 *
 *     bun scripts/build/photon-wasm.ts <path/to/index.js | its directory>
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const PHOTON_WASM_FILENAME = 'photon_rs_bg.wasm';

const PHOTON_PACKAGE = '@silvia-odwyer/photon-node';
const ROOT_DIR = join(import.meta.dir, '..', '..');

/**
 * The inlined declaration, e.g.
 * `var __dirname = "C:\\Users\\Ryan\\code\\…\\node_modules\\@silvia-odwyer\\photon-node";`
 *
 * The backslashes inside it are escaped for the JS string literal, so the match
 * stays on one line and stops at the closing quote. Requiring the package name
 * keeps it away from the two other `__dirname` literals the bundler inlines
 * (`node_modules/electron`, `node_modules/electron-log/src/main`) — those are
 * inert in this subprocess and are deliberately left alone.
 */
const INLINED_DIRNAME = /var __dirname = "[^"\r\n]*@silvia-odwyer[^"\r\n]*photon-node";/;

/** Whether a bundle still carries that literal — a build-machine-only artifact. */
export function hasInlinedPhotonDirname(source: string): boolean {
  return INLINED_DIRNAME.test(source);
}

/**
 * What it becomes: the directory of the running bundle. Both `__require` (bun's
 * CJS shim, already used by this module for `path`/`fs`) and `import.meta.url`
 * (the bundle is ESM, and the SDK itself uses it for its resize worker) are
 * available at that point in the artifact, so this needs nothing imported.
 */
const RUNTIME_DIRNAME =
  'var __dirname = __require("path").dirname(__require("url").fileURLToPath(import.meta.url));';

/** Marker that the runtime form is already in place. */
const RUNTIME_MARKER = 'fileURLToPath(import.meta.url)';

/**
 * Marker left by the resize-worker patch (see below).
 */
const INLINE_RESIZE_MARKER = 'craft-agent: resize in-process';

/**
 * The SDK resizes images in a Worker (`resizeImageInWorker`) and falls back to
 * `resizeImageInProcess` when the worker cannot be created. Neither worker
 * entrypoint exists in this bundle — `./src/utils/image-resize-worker.ts` is a
 * source path, and `./image-resize-worker.js` beside the bundle was never
 * emitted — so **every** image read first spawns a worker that cannot load, and
 * Bun on Windows leaks the thread it was tearing down: after a few images a
 * `panic(main thread): Segmentation fault` takes the whole subprocess with it
 * (`workers_spawned(6) workers_terminated(5)` in Bun's own crash banner), which
 * the app surfaces as "Pi subprocess exited unexpectedly (code 3)".
 *
 * Nothing is gained by those attempts — the resize happens in-process either
 * way — so point `resizeImage` straight at `resizeImageInProcess`. The dead
 * worker code stays in the bundle, unreachable.
 */
const RESIZE_IMAGE_SIGNATURE = /async function resizeImage\((\w+), (\w+), (\w+)\) \{/;

/**
 * Where the wasm lives in the build tree.
 *
 * `@silvia-odwyer/photon-node` is a dependency of the Pi SDK, not of this repo,
 * so it is resolved through the package that pulls it in rather than by path —
 * that keeps working whether bun hoisted it to the root `node_modules` or nested
 * it under the SDK.
 */
export function resolvePhotonWasm(): string | undefined {
  const candidates: string[] = [];

  for (const from of [
    join(ROOT_DIR, 'packages', 'pi-agent-server', 'package.json'),
    join(ROOT_DIR, 'package.json'),
  ]) {
    if (!existsSync(from)) continue;
    try {
      // Resolving the package entry (`photon_rs.js`) lands us in its directory
      // without guessing at hoisting.
      const entry = createRequire(from).resolve(PHOTON_PACKAGE);
      candidates.push(join(dirname(entry), PHOTON_WASM_FILENAME));
    } catch {
      // Not resolvable from here — try the next base.
    }
  }

  candidates.push(join(ROOT_DIR, 'node_modules', PHOTON_PACKAGE, PHOTON_WASM_FILENAME));

  return candidates.find((candidate) => existsSync(candidate));
}

/** Whether the bundle still routes image resizing through a Worker. */
export function hasWorkerResize(source: string): boolean {
  return !source.includes(INLINE_RESIZE_MARKER) && RESIZE_IMAGE_SIGNATURE.test(source);
}

/** Route `resizeImage` straight at the in-process implementation. */
function inlineResizeImage(source: string): { source: string; patched: boolean } {
  if (source.includes(INLINE_RESIZE_MARKER)) return { source, patched: false };

  const match = RESIZE_IMAGE_SIGNATURE.exec(source);
  if (!match) return { source, patched: false };

  const [signature, inputArg, mimeArg, optionsArg] = match;
  const replacement =
    `${signature}\n` +
    `  // ${INLINE_RESIZE_MARKER}: the bundle ships no worker entrypoint, and a\n` +
    `  // Worker that cannot load crashes Bun on Windows (segfault in its worker\n` +
    `  // teardown). The resize happens here either way.\n` +
    `  return resizeImageInProcess(${inputArg}, ${mimeArg}, ${optionsArg});`;

  return { source: source.replace(signature, replacement), patched: true };
}

export interface PhotonWasmResult {
  /** The bundle that was prepared. */
  bundle: string;
  /** The wasm copied next to it. */
  wasm: string;
  /** Whether the inlined build-machine directory had to be rewritten. */
  patched: boolean;
  /** Whether image resizing was moved off the (missing) worker entrypoint. */
  workersInlined: boolean;
}

/**
 * Prepare one built bundle: rewrite the inlined photon directory and put the
 * wasm beside it. Idempotent — running it twice is a no-op after the first
 * pass.
 */
export function preparePhotonWasm(bundlePath: string): PhotonWasmResult {
  if (!existsSync(bundlePath)) {
    throw new Error(`photon-wasm: no bundle at ${bundlePath}`);
  }

  let source = readFileSync(bundlePath, 'utf8');
  const patched = INLINED_DIRNAME.test(source);
  const inlined = inlineResizeImage(source);

  if (!inlined.patched && !source.includes(INLINE_RESIZE_MARKER)) {
    console.warn(
      `⚠️  photon-wasm: no \`resizeImage\` in ${bundlePath} — the Pi SDK changed how it resizes images; verify that reading several images in one session does not crash the subprocess`,
    );
  }
  source = inlined.source;

  if (patched) {
    source = source.replace(INLINED_DIRNAME, RUNTIME_DIRNAME);
  } else if (!source.includes(RUNTIME_MARKER)) {
    // Neither form: a warning, not a failure — an SDK update that loads the wasm
    // some other way would land here, and the wasm is still worth shipping.
    console.warn(
      `⚠️  photon-wasm: no inlined photon __dirname in ${bundlePath} — the Pi SDK changed how it loads the wasm; check that images still work on a machine that did not build this bundle`,
    );
  }

  // One write for both patches, so a bundle that only needs one of them is
  // still saved.
  if (patched || inlined.patched) {
    writeFileSync(bundlePath, source);
  }

  const wasmSource = resolvePhotonWasm();
  if (!wasmSource) {
    throw new Error(
      `photon-wasm: ${PHOTON_WASM_FILENAME} not found — install ${PHOTON_PACKAGE} (a Pi SDK dependency) before building; without it every image attachment is dropped for the model`,
    );
  }

  const wasm = join(dirname(bundlePath), PHOTON_WASM_FILENAME);
  copyFileSync(wasmSource, wasm);

  return { bundle: bundlePath, wasm, patched, workersInlined: inlined.patched };
}

/** Log what happened, in the shape the surrounding build scripts log in. */
export function reportPhotonWasm(result: PhotonWasmResult): void {
  const action = result.patched ? 'patched and staged' : 'already patched, staged';
  console.log(`🖼️  Photon wasm ${action}: ${result.wasm}`);
  if (result.workersInlined) {
    console.log('🖼️  Image resize inlined (no worker entrypoint in the bundle)');
  }
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: bun scripts/build/photon-wasm.ts <bundle.js | directory>');
    process.exit(1);
  }

  const bundle = statSync(target).isDirectory() ? join(target, 'index.js') : target;
  try {
    reportPhotonWasm(preparePhotonWasm(bundle));
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
