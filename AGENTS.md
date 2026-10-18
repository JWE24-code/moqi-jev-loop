# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink
to this file. Personal, machine-specific instructions go in `AGENTS.local.md` or
`CLAUDE.local.md` (both gitignored) — never here: this repository is public.

## What this is

`moqi-jev-loop` is a thin Cordis plugin that adds the `/JevLoop` panel to
[moqi](https://www.npmjs.com/package/moqi-tui). It turns the `jevLoop` service
from [`dsh-jev-loop`](https://www.npmjs.com/package/dsh-jev-loop) into panel rows
and actions. It makes no judgments of its own; every decision lives in the core.

## Commands

```bash
npm ci                  # typescript, @types/node, dsh-jev-loop, moqi-tui (dev)
npm test                # tests/panel-smoke.ts — no Harness needed
npm run link-harness    # symlink the installed dsh's @deepseek-ai/* into node_modules
npm run build           # tsc → lib/ (needs link-harness first)
npm run typecheck       # tsc --noEmit over src/ (needs link-harness first)
npm run typecheck:moqi  # tests/moqi-compat.ts against the installed moqi-tui
```

`link-harness` needs `dsh` on `PATH` (or `DSH_INSTALL_ROOT`). `npm test` does
not: the smoke test imports only `panel.ts`, which has no `@deepseek-ai/*`
runtime import.

`npm run install-profile -- <name>` writes a throwaway Harness profile for a
manual run. Use a disposable `DSH_HOME` for it; do not point it at a real one.

## Layout

```
src/panel.ts              rows and actions over the core's service; structural types
src/index.ts              the Cordis plugin: inject jevLoop + tuiHost, registerPanel
tests/panel-smoke.ts      panel.ts driven with a fake jevLoop service
tests/moqi-compat.ts      compile-only: panel.ts types vs moqi-tui/tui-host
scripts/                  harness linking and the throwaway profile installer
cordis.patch.yml          the bundle patch that mounts the plugin
docs/ARCHITECTURE.md      module boundary and whiteboard
```

`lib/` is build output, but it is tracked; rebuild it when `src/` changes.

## The tuiHost seam

The plugin injects `['jevLoop', 'tuiHost']` and does nothing unless both are
present. It calls one host method:

```ts
ctx.tuiHost.registerPanel({ name, title?, description, rows(), activate(id) })
  → (() => void) | undefined   // undefined when the name is already taken
```

`rows()` returns `TuiPanelRow[]` (`id`, `title`, `subtitle`, `active?`), and
`activate(id)` returns nothing or a `TuiPanelSecret` (`kind: 'secret'`,
`message`, `placeholder?`, `submit(value)`) that moqi shows as a masked prompt.
Panel names are matched case-insensitively, so `/JevLoop` answers to `/jevloop`.

`panel.ts` keeps a structural copy of these types instead of importing
`moqi-tui`, so the plugin has no build dependency on moqi. `typecheck:moqi`
proves the copy and moqi's exported `TuiPanel*` / `TuiHost` types are mutually
assignable; CI runs it against the locked `moqi-tui` devDependency. If moqi
changes the seam, update `panel.ts` and that check together.

The core's `jevLoop` service is likewise described structurally
(`JevLoopService` in `panel.ts`).

## Release

Releases are cut from `main`:

1. Bump `version` in `package.json` and `package-lock.json`, and move the
   `CHANGELOG.md` entries under a dated `[X.Y.Z]` heading, in a
   `Release X.Y.Z` commit.
2. Publish a GitHub Release tagged `vX.Y.Z`.
3. `.github/workflows/publish.yml` runs on the release: it checks the tag
   matches `package.json`, skips a version already on npm, and publishes with
   npm trusted publishing (`--provenance`); `prepublishOnly` runs link-harness,
   build, typecheck, typecheck:moqi and the tests first. A manual
   `workflow_dispatch` run defaults to a dry run that packs without publishing.

Never `npm publish` by hand. CI (`.github/workflows/ci.yml`) runs the tests on
Node 22 and 24, and the typecheck jobs against the latest published `dsh`.
