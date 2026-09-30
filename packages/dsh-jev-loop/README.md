# dsh-jev-loop

Jev (TypeSafe System One) judgments at the DeepSeek Harness agent-loop gates.
No UI dependency: mount it in any Harness composition, headless or otherwise.

## Install

```bash
dsh plugin --profile <profile> add dsh-jev-loop
```

Then give it a key: set `TYPESAFE_API_KEY` (or `TYPESAFE_APIKEY`) in the
environment, or store one in the Harness credential store under
`TYPESAFE_API_KEY`. The gates fail open — no key, timeout, 429, or bad JSON
never blocks the loop.

## The gates

| Gate | Event | What Jev judges | Decision |
|---|---|---|---|
| Pre-step | `agent/pre-step` | is the request underspecified? | inject an "ask before guessing" instruction |
| Pre-execute | `tools/pre-execute` | destructive · exfiltration · off-task | `log` / `ask` / `deny` |
| Post-execute | `tools/post-execute` | did a successful call silently miss? | `log` / `block` with corrective feedback |
| Turn-stopping | `agent/turn-stopping` | "is the request actually done?" | `nudge` the turn onward, or pass |

Configure them on the `dsh-jev-loop` row in a profile's `cordis.patch.yml`.

## The moqi panel

`moqi-jev-loop` adds the `/JevLoop` control panel on top of this package. The
core never references a host.

See the [repository README](https://github.com/JWE24-code/moqi-jev-loop) and
[architecture notes](https://github.com/JWE24-code/moqi-jev-loop/blob/main/docs/ARCHITECTURE.md)
for the module seams, the config table, and the annotated code maps.
