/**
 * Points the asset resolver at the app's own `resources/`, for every test file that needs an engine.
 *
 * The document engines are fetched artifacts (`scripts/build-office-engine.ts`) that live beside the
 * Electron app. Without this, `getBundledAssetsDir` looks relative to whatever directory the tests
 * happen to be run from, so the same suite passes from the repo root and fails from this package.
 *
 * Import for effect: `import './test-assets.ts'`.
 */

import { join } from 'node:path'
import { setBundledAssetsRoot } from '@craft-agent/shared/utils/paths'

setBundledAssetsRoot(join(import.meta.dir, '..', '..', '..', '..', 'apps', 'electron'))
