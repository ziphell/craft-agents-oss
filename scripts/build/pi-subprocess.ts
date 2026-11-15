/**
 * The Pi subprocess and the companions it needs at runtime — built and staged
 * from one place so no build path can ship a bundle without them.
 *
 * `resolveBackendRuntimePaths` (runtime-resolver.ts) derives everything the
 * spawned `pi-agent-server` is handed from the app root, and no host ever
 * overrides `interceptorBundlePath` — so when the app is packaged there are
 * exactly three files, at exactly these paths:
 *
 *   <appRoot>/resources/pi-agent-server/index.js        — the bundle
 *   <appRoot>/resources/pi-agent-server/photon_rs_bg.wasm — read by that bundle
 *   <appRoot>/dist/interceptor.cjs                      — the `--require` preload
 *
 * They have to travel together, and each failure is silent:
 *
 *   - a bundle without its wasm replaces every image attachment with
 *     "[Image omitted: could not be resized below the inline image size limit.]"
 *     (the wasm half lives in ./photon-wasm.ts);
 *   - without the interceptor the subprocess starts fine but loses tool-metadata
 *     injection and API error capture (`pi-agent.ts` preloads it only if it exists).
 *
 * Callers: `scripts/electron-build-main.ts` (the Electron installer),
 * `scripts/build-server.ts` (the standalone server) and — for the interceptor
 * bundle — `apps/electron/scripts/build-win.ps1`, whose parallel build does not
 * go through electron-build-main. Dev needs neither: it is unpackaged, so the
 * resolver reads the interceptor from the monorepo source directly.
 *
 * Run directly to (re)build just the interceptor bundle, e.g. for a build script:
 *
 *     bun scripts/build/pi-subprocess.ts interceptor apps/electron/dist/interceptor.cjs
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { PHOTON_WASM_FILENAME, preparePhotonWasm } from './photon-wasm';

/** Directory name the packaged runtime resolves the bundle from (`resources/<this>/`). */
export const PI_SERVER_DIRNAME = 'pi-agent-server';

/** The interceptor entry, relative to the repo root. */
export const INTERCEPTOR_SOURCE = join('packages', 'shared', 'src', 'unified-network-interceptor.ts');

/** Where the Electron installer's copy of the interceptor bundle belongs, relative to the repo root. */
export const ELECTRON_INTERCEPTOR_OUTFILE = join('apps', 'electron', 'dist', 'interceptor.cjs');

const ROOT_DIR = join(import.meta.dir, '..', '..');

/**
 * Bundle the network interceptor to a single CJS file.
 *
 * `--bundle` makes it self-contained (only Node builtins stay external), which
 * is what lets it be `--require`d by the subprocess from anywhere with no
 * node_modules beside it.
 */
export function buildInterceptorBundle(opts: { rootDir: string; outfile: string }): void {
  const { rootDir, outfile } = opts;
  const source = join(rootDir, INTERCEPTOR_SOURCE);

  if (!existsSync(source)) {
    throw new Error(`pi-subprocess: interceptor source not found at ${source}`);
  }

  mkdirSync(dirname(outfile), { recursive: true });

  const proc = spawnSync(
    'bun',
    ['run', 'esbuild', source, '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`],
    // A bare `bun` needs the shell on Windows.
    { cwd: rootDir, stdio: 'inherit', shell: process.platform === 'win32' },
  );

  if (proc.status !== 0 || !existsSync(outfile)) {
    throw new Error(`pi-subprocess: interceptor build failed (exit ${proc.status ?? 'null'}) → ${outfile}`);
  }
}

/**
 * Repair one built bundle and move it, with its wasm, into `destDir`.
 *
 * The bundle is patched in place (see ./photon-wasm.ts) and the wasm is placed
 * beside the *source* and the *staged* copy — the bundle reads it relative to
 * itself, so both locations must have it.
 */
export function stagePiSubprocess(opts: { bundle: string; destDir: string }): { wasm: string } {
  const { bundle, destDir } = opts;

  if (!existsSync(bundle)) {
    throw new Error(`pi-subprocess: bundle not found at ${bundle}`);
  }

  const { wasm } = preparePhotonWasm(bundle);

  mkdirSync(destDir, { recursive: true });
  copyFileSync(bundle, join(destDir, 'index.js'));
  copyFileSync(wasm, join(destDir, PHOTON_WASM_FILENAME));

  return { wasm: join(destDir, PHOTON_WASM_FILENAME) };
}

if (import.meta.main) {
  const [, , command, target] = process.argv;

  if (command !== 'interceptor') {
    console.error('usage: bun scripts/build/pi-subprocess.ts interceptor [<outfile>]');
    process.exit(1);
  }

  const outfile = target
    ? (isAbsolute(target) ? target : join(ROOT_DIR, target))
    : join(ROOT_DIR, ELECTRON_INTERCEPTOR_OUTFILE);

  try {
    buildInterceptorBundle({ rootDir: ROOT_DIR, outfile });
    console.log(`🛡️  Interceptor bundle built: ${outfile}`);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
