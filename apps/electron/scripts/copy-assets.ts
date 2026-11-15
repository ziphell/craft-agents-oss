/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, mkdirSync, rmSync } from 'fs';
import { join, relative, sep } from 'path';
import { checkAssets } from './lib/check-assets';

// Start from a clean slate. cpSync merges into the destination and never deletes,
// so without this a dist/resources/ left over from an older build (e.g. the
// bin/scripts/pi-agent-server copies excluded below) would linger and still be
// packaged via `dist/**/*`.
rmSync('dist/resources', { recursive: true, force: true });

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
//
// `bin`, `scripts`, `pi-agent-server` and `cli-tools` are intentionally skipped: the runtime
// reads those from resources/ directly (CRAFT_RESOURCES_BASE / resolveServerPath's primary
// path), never from dist/resources/. They still reach the package via the explicit
// `files: resources/...` entries in electron-builder.yml, so copying them here would only
// duplicate the payload because `dist/**/*` already ships dist/resources. For `cli-tools` that
// duplicate was the whole ~80 MB bundle (onnxruntime-node, sharp, the OCR models) packed twice.
const NOT_IN_DIST_RESOURCES = new Set(['bin', 'scripts', 'pi-agent-server', 'cli-tools']);
// `office-native` holds one workbook sidecar per platform — the Linux ELF for hubs and the `.exe`
// for Windows. A desktop package must carry only the one it runs; the other is 12–13 MB of nothing
// to do (the server's own assembly picks by target, in `build-server.ts`).
const LOCAL_SIDECAR = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
cpSync('resources', 'dist/resources', {
  recursive: true,
  filter: (src) => {
    const parts = relative('resources', src).split(sep);
    if (NOT_IN_DIST_RESOURCES.has(parts[0])) return false;
    if (parts[0] === 'office-native' && parts.length === 2 && parts[1] !== LOCAL_SIDECAR) return false;
    return true;
  },
});

console.log('✓ Copied resources/ → dist/resources/ (excluding bin, scripts, pi-agent-server, cli-tools)');

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join('dist', 'resources', 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}

// Copy the built WebUI — served by the Electron server on the RPC port in server
// mode (see main/index.ts). Optional: without it, server mode has no browser UI.
// Run `bun run webui:build` before packaging to include it.
try {
  cpSync(join('..', '..', 'apps', 'webui', 'dist'), join('dist', 'resources', 'webui'), { recursive: true });
  console.log('✓ Copied apps/webui/dist → dist/resources/webui/');
} catch {
  console.log('⚠ apps/webui/dist not found — run `bun run webui:build` to include the WebUI');
}

// ── what actually landed ──
// The office editors are vendored artifacts (gitignored, built from a GenOffice checkout), so a
// checkout that never ran `scripts/build-office-assets.ts` copies a resources/ without them — and
// the package would be silent about it until someone opens a .docx. Named here, not failed:
// `scripts/validate-assets.ts --strict` is how a release build refuses to ship without them.
const missing = checkAssets(join(import.meta.dir, '..')).filter((check) => !check.ok && !check.required);
if (missing.length > 0) {
  console.log(`\n${missing.length} optional block(s) are not in this build:`);
  for (const check of missing) console.log(`  · ${check.label}${check.hint ? ` — ${check.hint}` : ''}`);
}
