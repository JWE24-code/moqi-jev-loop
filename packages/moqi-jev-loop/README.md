# moqi-jev-loop

The `/JevLoop` control panel for [moqi](https://www.npmjs.com/package/moqi-tui),
on top of [`dsh-jev-loop`](https://www.npmjs.com/package/dsh-jev-loop).

It is a thin adapter: moqi brings the `tuiHost` seam, `dsh-jev-loop` brings the
`jevLoop` service, and this package turns that service into rows and actions.
It judges nothing itself and never applies where either service is absent.

## Install

```bash
dsh plugin --profile <profile> add dsh-jev-loop
dsh plugin --profile <profile> add moqi-jev-loop
```

Both bundles are needed — the core mounts the gates, this one mounts the panel.
With moqi running, `/JevLoop` then joins the command palette and lists the API
key and the four gates; `enter` toggles a gate, and the API-key row opens a
masked prompt that stores the key in the Harness credential store.

See the [repository README](https://github.com/JWE24-code/moqi-jev-loop) and
[architecture notes](https://github.com/JWE24-code/moqi-jev-loop/blob/main/docs/ARCHITECTURE.md).
