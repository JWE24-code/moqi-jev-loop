# moqi-jev-loop

The `/JevLoop` control panel for [moqi](https://www.npmjs.com/package/moqi-tui),
on top of [`dsh-jev-loop`](https://www.npmjs.com/package/dsh-jev-loop).

It is a thin adapter: moqi brings the `tuiHost` seam, `dsh-jev-loop` brings the
`jevLoop` service, and this package turns that service into rows and actions.
It judges nothing itself and never applies where either service is absent.

Published to npm as
[`moqi-jev-loop`](https://www.npmjs.com/package/moqi-jev-loop). This repository
carries the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic — the
whole of the [dshfind](https://dshfind.com) listing mechanism: the marketplace
indexes public repositories by that topic and syncs daily, so there is no
listing step per release.

## Install

```bash
dsh plugin --profile <profile> add dsh-jev-loop
dsh plugin --profile <profile> add moqi-jev-loop
```

Both bundles are needed — the core mounts the gates, this one mounts the panel.
With moqi running, `/JevLoop` then joins the command palette.

## The panel

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

## Test it

The throwaway profile composes `dsh-base`, the fixed moqi TUI checkout, the
core, and this adapter:

```bash
npm install            # typescript + @types/node + dsh-jev-loop
npm run link-harness   # symlink the installed harness's @deepseek-ai packages
npm run build
npm run install-profile -- jev-dev
TYPESAFE_APIKEY=… dsh --profile jev-dev
```

`install-profile` links the moqi TUI from a sibling `../moqi` checkout by
default (`MOQI_ROOT` overrides it) and the core from a sibling `../dsh-jev-loop`
checkout when one is built (`JEV_LOOP_CORE_ROOT` overrides it), falling back to
the published `dsh-jev-loop` on npm when it is not.

Inside the app `/JevLoop` toggles the gates, and `~/.dsh/jev-loop.jsonl` records
every judgment.

## Layout

```
src/panel.ts   rows and actions over the core's service
src/index.ts   the tuiHost seam
tests/         panel.ts driven with a fake service
scripts/       harness linking and the throwaway profile installer
```

## Docs

The module boundary and the generated whiteboard are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
