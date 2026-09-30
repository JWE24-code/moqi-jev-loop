/**
 * Link the installed `dsh` runtime's `@deepseek-ai` packages into this
 * checkout's node_modules, so `tsc` typechecks against the exact Harness build
 * the plugin will run under and Node resolves them at runtime.
 *
 * Run with: node scripts/link-harness.mjs
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findDshRoot, linkHarnessPackages } from './harness-root.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const dshRoot = findDshRoot()

if (dshRoot === undefined) {
  console.error('link-harness: no `dsh` on PATH. Install @deepseek-ai/dsh, or set DSH_INSTALL_ROOT.')
  process.exit(1)
}
if (!existsSync(resolve(dshRoot, 'node_modules', '@deepseek-ai'))) {
  console.error(`link-harness: ${dshRoot} has no @deepseek-ai packages; is this a complete install?`)
  process.exit(1)
}

const { linked, failed } = linkHarnessPackages(repoRoot, dshRoot)
console.log(`link-harness: linked ${String(linked.length)} packages from ${dshRoot}`)
if (failed.length > 0) {
  console.error(`link-harness: could not link ${failed.join(', ')}`)
  process.exit(1)
}
