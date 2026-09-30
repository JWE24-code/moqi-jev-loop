# dsh-jev-loop

Jev (TypeSafe System One) judgments at the DeepSeek Harness agent-loop gates.
A native Cordis plugin: no model cooperation, no tool call, no shell hook.

## The gates

| Gate | Event | What Jev judges | Decision |
|---|---|---|---|
| Pre-step | `agent/pre-step` | is the request underspecified? | inject a "ask before guessing" instruction |
| Pre-execute | `tools/pre-execute` | destructive · exfiltration · off-task | `log` / `ask` / `deny` |
| Post-execute | `tools/post-execute` | did a successful call silently miss? | `log` / `block` with corrective feedback |
| Turn-stopping | `agent/turn-stopping` | "is the request actually done?" | `nudge` the turn onward, or pass |

All four are automatic. Jev supplies a calibrated probability; this plugin owns
the thresholds and the decisions, and every failure — no key, timeout, 429, bad
JSON — **fails open**, so a judgment service that is down never blocks the loop.

## Controlling it from moqi

## The `/JevLoop` panel

The panel ships with the plugin: on a moqi host the plugin registers it through
`ctx.tuiHost.registerPanel` (an optional injection, so the gates still run
headless), and `/JevLoop` joins the command palette with the plugin. Nothing
about the panel lives in moqi's core — moqi only knows how to draw rows and
raise a masked prompt. The panel lists the API key and the four gates with
their live state; `enter` toggles a gate, the change applies immediately, and it
persists to `$DSH_HOME/jev-loop.json`.

The **API key** row opens a masked prompt: the draft is never rendered and
never touches the composer, transcript, or shell history. The value is written
to the Harness credential store (`ctx.credentials`, ref `TYPESAFE_API_KEY`) and
the plugin picks it up on the next judgment — no restart. The row shows whether
a key is live and where it came from (`config`, `credential:file`,
`env:TYPESAFE_APIKEY`), never the value. A **Clear API key** row appears once one
is set.

Key resolution order: explicit `apiKey` config, then the credential store, then
`TYPESAFE_API_KEY` / `TYPESAFE_APIKEY` in the environment. The gates are
registered even with no key, so setting one activates them immediately.

## Cost envelope

- One `POST /v1/systemone` per judgment; pre-execute asks its three hazards in
  a single call.
- State is capped (`maxStateChars`); the transcript gates only send the last
  `turnStoppingMaxMessages` messages.
- Answers are cached by a SHA-256 of the exact request body, so an unchanged
  judgment is free.
- Every judgment is appended to `$DSH_HOME/jev-loop.jsonl` with probabilities,
  cache hit/miss, latency, and token usage.

## Config

Set on the `dsh-jev-loop` row in a bundle patch (see `cordis.patch.yml`), or in
a profile's own patch layer.

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

The `*Enabled` values are defaults: a persisted `/jevloop` toggle overrides
them.

## Test it

The throwaway profile composes `dsh-base`, the fixed moqi TUI checkout, and
this plugin, so the loop improvement runs behind the real terminal:

```bash
npm install          # typescript + @types/node
npm run link-harness # symlink the installed harness's @deepseek-ai packages
npm run build
npm run install-profile -- jev-dev
TYPESAFE_APIKEY=… dsh --profile jev-dev
```

Inside the app: `/jevloop` toggles the gates, and `~/.dsh/jev-loop.jsonl`
records every judgment. `install-profile` links the moqi TUI from a sibling
`../moqi` checkout by default; override with `MOQI_ROOT`.

## Layout

```
src/index.ts   plugin entry: config, four gates, runtime service, audit
src/jev.ts     TypeSafe System One client: retry, cache, state cap
src/render.ts  derived session messages -> plain text
scripts/       harness linking and the throwaway profile installer
```
