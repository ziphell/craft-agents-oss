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

// Start from a clean slate. cpSync merges into the destination and never deletes,
// so without this a dist/resources/ left over from an older build (e.g. the
// bin/scripts/pi-agent-server copies excluded below) would linger and still be
// packaged via `dist/**/*`.
rmSync('dist/resources', { recursive: true, force: true });

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
//
// `bin`, `scripts` and `pi-agent-server` are intentionally skipped: the runtime
// reads those from resources/ directly (CRAFT_RESOURCES_BASE / resolveServerPath's
// primary path), never from dist/resources/. They still reach the package via the
// explicit `files: resources/...` entries in electron-builder.yml, so copying them
// here would only duplicate ~89 MB (uv.exe, pi-agent-server) because `dist/**/*`
// already ships dist/resources.
const NOT_IN_DIST_RESOURCES = new Set(['bin', 'scripts', 'pi-agent-server']);
cpSync('resources', 'dist/resources', {
  recursive: true,
  filter: (src) => !NOT_IN_DIST_RESOURCES.has(relative('resources', src).split(sep)[0]),
});

console.log('✓ Copied resources/ → dist/resources/ (excluding bin, scripts, pi-agent-server)');

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
