/**
 * Apply our GenOffice patches to a checkout, idempotently.
 *
 * The editors are vendored **source**, not a dependency: `fetch-genoffice-source.ts` puts a pinned
 * checkout in `vendor/genoffice` (gitignored), and `scripts/patches/` holds the edits this app
 * needs — the host entry the docs bundle is built from, and the control commands (`readMode`,
 * `edit`, `replaceText`) that let a host change a document without guessing. `readMode` is on the
 * Word *and* the workbook editor: a preview needs a document that cannot be typed into, and "the
 * host refuses to save" is not that (the words are lost on the first save). One patch, not one per
 * command — they all rewrite the same control files, and two patches over the same lines read as a
 * conflict the moment a checkout has both.
 *
 * Those edits used to live only in a developer's checkout. A fresh clone therefore built an editor
 * that could be looked at but not edited in place, and nothing said so until an agent's edit was
 * refused. So they are applied by the build, not remembered by a person:
 *
 * - a patch that applies cleanly is applied;
 * - one already in place is left alone (re-running is harmless);
 * - anything else is a mismatch between the patch and the pinned revision, reported by name.
 *
 * **Why not plain `git apply`:** `vendor/genoffice` lives *inside this repository* (`vendor/` is
 * gitignored), so git resolves `craft-agents-oss` as the repository and compares the patch against
 * that index — where `apps/docs/src/renderer/App.tsx` does not exist. Every hunk then reports
 * "Skipped patch", `--stat` says "0 files changed", and the exit code is 0: a silent no-op. Two ways
 * out, tried in order — GNU `patch` (works on files, knows nothing about repositories), then
 * `git apply` with a throwaway `GIT_DIR` so it does not resolve the enclosing repository at all.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PATCH_DIR = join(ROOT, 'scripts', 'patches')

export type PatchState = 'applied' | 'already' | 'pending' | 'conflict'

export interface PatchOutcome {
  name: string
  state: PatchState
  detail?: string
}

/** The patches, in application order (the sort is the order they must go in). */
export function patchFiles(): string[] {
  try {
    return readdirSync(PATCH_DIR).filter((name) => name.endsWith('.patch')).sort()
  } catch {
    return []
  }
}

type Mode = 'apply' | 'check' | 'reverse'

function gnuPatch(): boolean {
  try {
    execFileSync('patch', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HAS_GNU_PATCH = gnuPatch()

/** A git directory outside this repository, so `git apply` cannot resolve the enclosing one. */
let scratchGitDir: string | null = null
function isolatedGitDir(): string {
  if (scratchGitDir) return scratchGitDir
  const dir = mkdtempSync(join(tmpdir(), 'craft-genoffice-patch-'))
  execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' })
  scratchGitDir = join(dir, '.git')
  return scratchGitDir
}

function messageOf(error: unknown): string {
  const e = error as { stderr?: Buffer | string; message?: string }
  const text = e.stderr ? String(e.stderr) : (e.message ?? '')
  return text.split('\n').find((line) => line.trim())?.trim() ?? 'failed'
}

function runTool(checkout: string, patch: string, mode: Mode): { ok: boolean; message: string } {
  try {
    if (HAS_GNU_PATCH) {
      const args = ['-p1', '--batch', '-i', patch, '-d', checkout]
      if (mode === 'check') args.push('--dry-run', '--forward')
      else if (mode === 'reverse') args.push('--dry-run', '--reverse')
      else args.push('--forward')
      execFileSync('patch', args, { stdio: 'pipe' })
      return { ok: true, message: '' }
    }
    const gitArgs = ['apply', ...(mode === 'check' ? ['--check'] : mode === 'reverse' ? ['--check', '-R'] : []), patch]
    execFileSync('git', gitArgs, {
      cwd: checkout,
      stdio: 'pipe',
      env: { ...process.env, GIT_DIR: isolatedGitDir(), GIT_WORK_TREE: checkout },
    })
    return { ok: true, message: '' }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

/**
 * Reconcile one checkout with `scripts/patches/`.
 *
 * `apply: false` answers what *would* happen (used on a checkout the person owns — a sibling
 * `../genoffice` is theirs to keep clean); `apply: true` is for the vendored tree this build created.
 */
export function reconcilePatches(checkout: string, options: { apply: boolean }): PatchOutcome[] {
  if (!existsSync(checkout)) {
    return patchFiles().map((name) => ({ name, state: 'conflict' as const, detail: `no checkout at ${checkout}` }))
  }
  return patchFiles().map((name) => {
    const patch = join(PATCH_DIR, name)
    if (runTool(checkout, patch, 'check').ok) {
      if (!options.apply) return { name, state: 'pending' as const }
      const result = runTool(checkout, patch, 'apply')
      if (!result.ok) return { name, state: 'conflict' as const, detail: result.message }
      // A tool that answers 0 without touching the file is the failure this guards against.
      return runTool(checkout, patch, 'reverse').ok
        ? { name, state: 'applied' as const }
        : { name, state: 'conflict' as const, detail: 'reported success but the files are unchanged' }
    }
    if (runTool(checkout, patch, 'reverse').ok) return { name, state: 'already' as const }
    return {
      name,
      state: 'conflict' as const,
      detail: 'the pinned revision does not match this patch — update the patch, do not force it',
    }
  })
}

/** One line per patch; conflicts are worth an operator's attention, the rest are not. */
export function reportPatches(outcomes: readonly PatchOutcome[], checkout: string): void {
  if (outcomes.length === 0) return
  console.log(`GenOffice patches (${checkout})${HAS_GNU_PATCH ? '' : ' [git apply, isolated]'}:`)
  for (const outcome of outcomes) {
    switch (outcome.state) {
      case 'applied':
        console.log(`  ✓ ${outcome.name} — applied`)
        break
      case 'already':
        console.log(`  · ${outcome.name} — already applied`)
        break
      case 'pending':
        console.log(
          `  ⚠ ${outcome.name} — not applied (this checkout is yours; apply it with` +
            ` \`git -C <dir> apply ${join('scripts', 'patches', outcome.name)}\`)`,
        )
        break
      case 'conflict':
        console.error(`  ✗ ${outcome.name} — ${outcome.detail ?? 'conflict'}`)
        break
    }
  }
}

/** True when any patch is neither applied nor already present. */
export function hasUnresolved(outcomes: readonly PatchOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.state === 'pending' || outcome.state === 'conflict')
}
