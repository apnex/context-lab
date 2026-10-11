# context-lab

Learn whether what a project tells its agents changes what they do.

A shared evaluation component for any project whose agents work from guidance: it runs isolated agents across harnesses and models, under controlled context, and judges what they did.\
Projects supply their own scenarios, keys and guidance; this repository holds the universal part.

**Status: its first slice is built ([Delta-1](docs/DELTAS/DELTA-1.md), complete): one-phase experiments, isolation probed, judged across model families, to a tallied result.**\
Its purpose is in [`VISION.md`](VISION.md), its shape in [`docs/ARCHITECTURE-TARGET.md`](docs/ARCHITECTURE-TARGET.md), its next moves on [`docs/BOARD.md`](docs/BOARD.md), and its rulings in [`docs/DECISIONS.md`](docs/DECISIONS.md).\
The first two projects to use it are [mission-kit](https://github.com/apnex/mission-kit) and zorg.

## Build and test

Node 24 or later, on Linux with `bwrap` (bubblewrap) installed - project hooks run in its sandbox.

```sh
npm install
npm test
```

## Check a pack

```sh
node packages/core/dist/src/cli.js check <pack-directory>
```

## Run a suite

```sh
node packages/core/dist/src/cli.js run <pack-directory> <suite> --parallel 6
```

The run record is written where the pack's `records.path` says; variants and workspaces are made under `~/context-lab-work`.
