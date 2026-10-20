# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-10-20

### Changed

- Every `@deepseek-ai/*` peer dependency is now optional
  (`peerDependenciesMeta`), the way `moqi-tui` declares them. The Harness
  provides these packages in-box, and DeepSeek Harness 0.2.1 profiles set
  `autoInstallPeers: false`, so this package no longer causes the
  `Issues with peer dependencies found` warning from `dsh plugin add`. The
  warning still appears until the `dsh-jev-loop` dependency resolves to 0.1.4,
  which makes its own peers optional.

### Added

- CI guard that fails if any `@deepseek-ai/*` package appears under
  `dependencies`, which would put a stale core copy into the profile and
  shadow the in-box one.
- CI `install-smoke` job: installs `@deepseek-ai/dsh` at `latest` and `next`,
  runs `dsh plugin --profile t add` with the packed package in a fresh
  `DSH_HOME`, and checks that `dsh --profile t --dump-config` succeeds and that
  no `@deepseek-ai/*` copy lands in the profile.

## [0.1.3] - 2026-10-18

### Added

- Verified with Moqi 0.4.x and 0.5.x: `npm run typecheck:moqi` compiles a
  check that the panel's structural copy of the `tuiHost` types is mutually
  assignable with `moqi-tui/tui-host`. It runs in CI, the publish dry run and
  `prepublishOnly`, against the locked `moqi-tui` devDependency (0.5.0).
- `AGENTS.md` with the commands, layout, the tuiHost seam and the release
  process; `CLAUDE.md` links to it.
- This changelog.

### Changed

- `dsh-jev-loop` dependency raised to `^0.1.2`.

## [0.1.2] - 2026-10-01

### Fixed

- Cleared the unresolved Sonar findings: the profile installer's path guard,
  absolute interpreter paths, and the panel test cleanups.

[Unreleased]: https://github.com/JWE24-code/moqi-jev-loop/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/JWE24-code/moqi-jev-loop/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/JWE24-code/moqi-jev-loop/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/JWE24-code/moqi-jev-loop/releases/tag/v0.1.2
