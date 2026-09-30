/**
 * Create (or refresh) a throwaway Harness profile for the moqi build.
 *
 * The profile composes dsh-base, the moqi TUI checkout, the core
 * `dsh-jev-loop` bundle, and the `moqi-jev-loop` panel adapter — so the gates
 * and the `/JevLoop` panel run behind the real terminal.
 *
 *   node scripts/install-profile.mjs [profileName]   # default: jev-dev
 *
 * `MOQI_ROOT` overrides where the TUI checkout lives (default: sibling ../moqi).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findDshRoot, linkHarnessPackages } from './harness-root.mjs'

const profileName = process.argv[2] ?? 'jev-dev'
if (profileName === '' || profileName.includes('/') || profileName.includes('\\')) {
  console.error(`install-profile: invalid profile name ${JSON.stringify(profileName)}`)
  process.exit(1)
}

const repoRoot = resolve(import.meta.dirname, '..')
const moqiRoot = resolve(process.env['MOQI_ROOT'] ?? join(repoRoot, '..', 'moqi'))
const coreDir = join(repoRoot, 'packages', 'dsh-jev-loop')
const panelDir = join(repoRoot, 'packages', 'moqi-jev-loop')
const coreName = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')).name
const panelName = JSON.parse(readFileSync(join(panelDir, 'package.json'), 'utf8')).name

for (const [label, dir] of [['core', coreDir], ['panel', panelDir]]) {
  if (!existsSync(join(dir, 'lib', 'index.js'))) {
    console.error(`install-profile: ${label} lib/ is missing — run \`npm run build\` first.`)
    process.exit(1)
  }
}
if (!existsSync(join(moqiRoot, 'lib', 'index.js'))) {
  console.error(`install-profile: no built moqi at ${moqiRoot} — run npm run build there first.`)
  process.exit(1)
}

const fromEnvironment = process.env.DSH_HOME
const dshHome =
  fromEnvironment !== undefined && fromEnvironment.trim() !== ''
    ? resolve(fromEnvironment)
    : join(homedir(), '.dsh')

const profileDir = join(dshHome, 'profiles', profileName)
mkdirSync(profileDir, { recursive: true })

const manifest = {
  name: `dsh-profile-${profileName}`,
  private: true,
  dependencies: {
    'moqi-tui': `link:${moqiRoot}`,
    [coreName]: `link:${coreDir}`,
    [panelName]: `link:${panelDir}`,
  },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', 'moqi-tui', coreName, panelName],
      patchReload: 'startup',
    },
  },
}
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
if (!existsSync(workspacePath)) {
  writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  writeFileSync(
    patchPath,
    [
      '# Your own patch layer for this profile. It composes last, so anything',
      '# set here wins over the bundle patches. The empty list is required:',
      '# the loader parses this file as a top-level YAML array.',
      '[]',
      '',
    ].join('\n'),
  )
}

console.log(`install-profile: wrote ${profileDir}`)

const manager = hasCommand('pnpm') ? 'pnpm' : 'npm'
try {
  execFileSync(manager, ['install'], { cwd: profileDir, stdio: 'inherit' })
} catch (error) {
  console.error(`install-profile: ${manager} install failed: ${error.message}`)
  console.error(`install-profile: run it yourself in ${profileDir}`)
  process.exit(1)
}

// The linked checkouts resolve `@deepseek-ai/*` from their own directory. The
// repo root covers both packages (Node walks up); moqi has its own.
const dshRoot = findDshRoot()
if (dshRoot === undefined) {
  console.warn('install-profile: no `dsh` installation found to link harness packages from.')
} else {
  for (const root of [repoRoot, moqiRoot]) {
    const { linked, failed } = linkHarnessPackages(root, dshRoot)
    if (linked.length > 0) {
      console.log(`install-profile: linked ${String(linked.length)} harness packages into ${root}`)
    }
    if (failed.length > 0) {
      console.warn(`install-profile: could not link ${failed.join(', ')} into ${root}`)
    }
  }
}

console.log(`install-profile: done — run it with:  dsh --profile ${profileName}`)

/** Whether a command exists on PATH. */
function hasCommand(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
