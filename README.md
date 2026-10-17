# context-lab

Run repeatable, isolated experiments on the context language-model agents are given, and measure how that context changes what they understand and do.

Status: production.\
Supported on Linux (`x86_64` / `aarch64`) with Node.js (`>=24`), Git, and `bwrap` (bubblewrap); drives `opencode` and `codex` runtimes plus `external` file-pointer harnesses.

Each project supplies a declarative **project pack** (`pack.json`, `experiments/*.json`, `scenarios/*.json`, and optional sandboxed `hooks/*.mjs`); this repository holds the universal evaluation core.\
For the step-by-step consumer reference - every CLI command, the complete pack schema, and a minimal copy-pasteable pack - read [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

---

## Prerequisites

- Linux with unprivileged user and network namespaces enabled and `bwrap` (bubblewrap) on `PATH`.
- Node.js (`>=24`) and `git` on `PATH`.
- For driven runs: `opencode` (`~/.config/opencode/opencode.json`) and/or `codex` (`~/.codex/auth.json` and `~/.codex/models_cache.json`) installed and authenticated on the operator's host.

---

## Install

Clone and build the core once in your workspace; consuming projects invoke its CLI directly against their own pack directory.

```sh
npm install
npm run build
```

See [`docs/OPERATIONS.md#1-install-and-verify`](docs/OPERATIONS.md#1-install-and-verify) for build and CLI setup details.

---

## Use

All project-specific configuration enters through a pack directory (`<pack>/pack.json`), validated before any model call is made.\
The four operator workflows - preregistered suite runs (`check`, `record`, `status`, `run`), two-stage A/A noise-gated comparisons and interrupted-run recovery (`thresholds`, `compare`, `resume`), post-run human calibration/preference panels and candidate finding extraction (`pick`, `candidates`), and on-demand multi-family adversarial reviews (`review --verify`) - are documented with complete JSON schemas and copy-pasteable commands in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

```sh
node packages/core/dist/src/cli.js check <pack>
node packages/core/dist/src/cli.js record <pack> <experiment>
node packages/core/dist/src/cli.js status <pack> <experiment>
node packages/core/dist/src/cli.js run <pack> <suite> --parallel 5
```

---

## Test / verify

Run the core's unit, conformance, and end-to-end sandbox failure-injection suites before adopting a revision or after modifying the core:
```sh
npm test
```

See [`docs/OPERATIONS.md#1-install-and-verify`](docs/OPERATIONS.md#1-install-and-verify) and [`packages/core/test/conformance/CASES.md`](packages/core/test/conformance/CASES.md) for what the test suite proves.

---

## Remove

Remove the working folder (`~/context-lab-work` by default, or the `--work` directory passed to `run`) and the repository clone; project packs and their committed `register/` files live inside each consuming project and are unaffected.

```sh
rm -rf ~/context-lab-work
```

See [`docs/OPERATIONS.md#8-remove-and-clean-up`](docs/OPERATIONS.md#8-remove-and-clean-up) for cleaning up working directories and read-only variants.

---

## Project documents

- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) - consumer operations guide: CLI reference, complete `context-lab.pack/1` schema (`pack.json`, `experiments/*.json`, `scenarios/*.json`, `hooks/*.mjs`), and end-to-end workflows.
- [`VISION.md`](VISION.md) - enduring purpose, non-goals, and design principles (`P1`-`P9`).
- [`docs/ARCHITECTURE-TARGET.md`](docs/ARCHITECTURE-TARGET.md) - the 22-component anchored core, run lifecycle state machine, and pack contract.
- [`docs/BOARD.md`](docs/BOARD.md) and [`docs/BACKLOG.md`](docs/BACKLOG.md) - completed milestones (`M1`-`M4`) and held backlog rows.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) - ratified architectural and operational rulings.
