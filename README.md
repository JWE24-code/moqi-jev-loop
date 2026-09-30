# moqi-jev-loop

Jev (TypeSafe System One) judgments at the DeepSeek Harness agent-loop gates,
in two releasable pieces:

| Package | For | Contains |
|---|---|---|
| [`dsh-jev-loop`](packages/dsh-jev-loop) | any DeepSeek Harness composition | the four gates, the TypeSafe client, the `jevLoop` service, key handling, audit — no UI dependency |
| [`moqi-jev-loop`](packages/moqi-jev-loop) | moqi | the `/JevLoop` control panel, rendered through moqi's `tuiHost` seam |

Mount the core alone for a headless or web Harness; add the adapter (or the
whole `moqi-jev-loop` profile below) when moqi is the host. The adapter injects
both `jevLoop` and `tuiHost`, so it never applies where either is absent.

## The gates (core)

| Gate | Event | What Jev judges | Decision |
|---|---|---|---|
| Pre-step | `agent/pre-step` | is the request underspecified? | inject an "ask before guessing" instruction |
| Pre-execute | `tools/pre-execute` | destructive · exfiltration · off-task | `log` / `ask` / `deny` |
| Post-execute | `tools/post-execute` | did a successful call silently miss? | `log` / `block` with corrective feedback |
| Turn-stopping | `agent/turn-stopping` | "is the request actually done?" | `nudge` the turn onward, or pass |

All four are automatic. Jev supplies a calibrated probability; the core owns the
thresholds and decisions, and every failure — no key, timeout, 429, bad JSON —
**fails open**, so a judgment service that is down never blocks the loop.

## The `/JevLoop` panel (moqi adapter)

The adapter registers a `tuiHost` panel, so `/JevLoop` joins moqi's command
palette and nothing about it lives in moqi's core: moqi only knows how to draw
rows and raise a masked prompt. The panel lists the API key and the four gates
with their live state; `enter` toggles a gate, the change applies immediately,
and it persists to `$DSH_HOME/jev-loop.json`.

The **API key** row opens a masked prompt: the draft is never rendered and never
touches the composer, transcript, or shell history. The value is written to the
Harness credential store (`ctx.credentials`, ref `TYPESAFE_API_KEY`) and the
core picks it up on the next judgment — no restart. The row shows whether a key
is live and where it came from (`config`, `credential:file`,
`env:TYPESAFE_APIKEY`), never the value. A **Clear API key** row appears once one
is set.

Key resolution order: explicit `apiKey` config, then the credential store, then
`TYPESAFE_API_KEY` / `TYPESAFE_APIKEY` in the environment. The gates are
registered even with no key, so setting one activates them immediately.

## Cost envelope (core)

- One `POST /v1/systemone` per judgment; pre-execute asks its three hazards in a
  single call.
- State is capped (`maxStateChars`); the transcript gates only send the last
  `turnStoppingMaxMessages` messages.
- Answers are cached by a SHA-256 of the exact request body, so an unchanged
  judgment is free.
- Every judgment is appended to `$DSH_HOME/jev-loop.jsonl` with probabilities,
  cache hit/miss, latency, and token usage.

## Config (core)

Set on the `dsh-jev-loop` row in a bundle patch (see its `cordis.patch.yml`), or
in a profile's own patch layer.

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | — | literal key; prefer `apiKeyEnv` so no secret is in a config file |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | env var read for the key; `TYPESAFE_APIKEY` is also read |
| `model` | `jev-latest` | TypeSafe model alias |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | evaluation endpoint |
| `timeoutMs` | `3000` | per-request timeout |
| `maxRetries` | `2` | retries on 429/529, network errors, timeouts |
| `maxStateChars` | `24000` | hard cap on state sent to Jev |
| `cacheEntries` | `500` | in-memory cache entries |
| `auditPath` | `$DSH_HOME/jev-loop.jsonl` | JSONL audit trail |
| `statePath` | `$DSH_HOME/jev-loop.json` | persisted gate toggles |
| `preStepEnabled` | `false` | judge the request before the first step |
| `preStepThreshold` | `0.7` | clarification probability that injects a question |
| `preExecuteEnabled` | `true` | judge tool calls before dispatch |
| `preExecuteMode` | `log` | `log` observes, `ask` requests approval, `deny` refuses |
| `preExecuteThreshold` | `0.7` | hazard probability that flags a call |
| `preExecuteSkip` | `[]` | tool names to ignore |
| `postExecuteEnabled` | `true` | check a successful tool result |
| `postExecuteMode` | `log` | `log` observes, `block` turns feedback into an error |
| `postExecuteThreshold` | `0.7` | miss probability that blocks a result |
| `turnStoppingEnabled` | `true` | check the turn before it closes |
| `turnStoppingThreshold` | `0.5` | completion probability below which to nudge |
| `turnStoppingMaxSteers` | `2` | nudges per turn, so a wrong judgment cannot loop |
| `turnStoppingMaxMessages` | `14` | transcript messages fed to the completion judgment |

The `*Enabled` values are defaults: a persisted `/JevLoop` toggle overrides them.

## Test it

The throwaway profile composes `dsh-base`, the fixed moqi TUI checkout, the
core, and the adapter:

```bash
npm install            # workspaces: typescript + @types/node
npm run link-harness   # symlink the installed harness's @deepseek-ai packages
npm run build
npm run install-profile -- jev-dev
TYPESAFE_APIKEY=… dsh --profile jev-dev
```

Inside the app `/JevLoop` toggles the gates, and `~/.dsh/jev-loop.jsonl` records
every judgment. `install-profile` links the moqi TUI from a sibling `../moqi`
checkout by default; override with `MOQI_ROOT`.

To exercise the Harness-only build, list just the core bundle in a profile:

```yaml
bundles: ['@deepseek-ai/dsh-base', 'dsh-jev-loop']
```

## Layout

```
packages/dsh-jev-loop/    core: gates, TypeSafe client, jevLoop service, audit
  src/index.ts            config, the four gates, runtime service
  src/jev.ts              retry, cache, state cap
  src/render.ts           derived session messages -> plain text
packages/moqi-jev-loop/   adapter: the /JevLoop panel
scripts/                  harness linking and the throwaway profile installer
```
