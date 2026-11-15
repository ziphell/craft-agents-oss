export * from './platform.ts'
export * from './null-browser-pane-manager.ts'

/**
 * `platform-headless` is deliberately **not** re-exported here.
 *
 * It is the hub's platform — the one that uses `sharp` for image work — and a barrel export is how
 * it used to reach the desktop: `apps/electron/src/runtime/platform.ts` re-exports
 * `createScopedLogger` from this file, which was enough for esbuild to pull the whole module (and
 * sharp's JS) into `main.cjs`. Sharp is not in the packaged app, so that path is a landmine.
 *
 * The hub imports it directly (`../runtime/platform-headless` in `bootstrap/headless-start.ts`),
 * which is the only place that needs it.
 */
