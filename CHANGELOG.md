# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/JWE24-code/moqi-jev-loop/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/JWE24-code/moqi-jev-loop/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/JWE24-code/moqi-jev-loop/releases/tag/v0.1.2
