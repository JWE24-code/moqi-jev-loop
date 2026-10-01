# Sonar issue resolution plan — moqi-jev-loop

All **12 unresolved SonarCloud findings** for project
`JWE24-code_moqi-jev-loop`. Like its core sibling, this repository has no
`sonar-issues` workflow, so none of them were mirrored to GitHub issues.

## Triage

| Rule | Sev / type | Location(s) | Verdict |
|---|---|---|---|
| `jssecurity:S8707` | MAJOR VULN | `scripts/install-profile.mjs` ×5 | **Real** — guard blocks `/` and `\` but not `..` |
| `javascript:S4036` | MINOR VULN | `scripts/harness-root.mjs:35`, `scripts/install-profile.mjs:127` | Real hardening — bare `sh` from PATH |
| `typescript:S7503` | MINOR SMELL | `tests/panel-smoke.ts:46,53` | Fake half of `JevLoopService` needlessly `async` |
| `typescript:S6582` | MINOR SMELL | `tests/panel-smoke.ts:103,104,115` | Optional chaining is clearer |

The `scripts/` findings are the same shared code fixed in `dsh-jev-loop`; the
`tests/panel-smoke.ts` ones are specific to this panel adapter.

## Fixes

- **S8707 (path traversal).** `profileName` (argv) becomes a directory under
  `~/.dsh/profiles`, and the old guard only rejected `/` and `\`. A `..` name
  therefore escaped one level. It now gets both a flat, dotless allowlist
  (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`) and — the sanitizer Sonar's taint analysis
  accepts — a `resolve(profilesRoot, name)` followed by a
  `startsWith(profilesRoot + sep)` containment check.
- **S4036 (PATH).** The two `execFileSync('sh', …)` calls now use `/bin/sh`, so
  the interpreter is not located through the caller's PATH.
- **S7503.** The fake `setApiKey`/`clearApiKey` drop `async` and return
  `Promise.resolve(...)`, typed against the `JevLoopService` contract.
- **S6582.** `result !== undefined && result.kind === 'secret'` becomes
  `result?.kind === 'secret'` in the three assertions.

No `src/` change, so `lib/` is untouched.
