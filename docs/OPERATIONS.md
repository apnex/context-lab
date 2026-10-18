# context-lab Operations and Pack Authoring Guide

Consumer reference for onboarding a project onto `context-lab` (`schema: "context-lab.pack/1"`), authoring packs, and operating all 13 CLI commands without reading `context-lab`'s implementation.

---

## 1. Install and verify

Prerequisites: Linux with `bwrap` (bubblewrap) and unprivileged user/network namespaces enabled, `git`, and Node.js (`>=24`).\
For live runs, the operator's host must have authenticated `opencode` (`~/.config/opencode/opencode.json`) and/or `codex` (`~/.codex/auth.json` and `~/.codex/models_cache.json`) installations.

Build and verify the core:
```sh
npm install
npm run build
npm test
```

In the commands below, `context-lab` refers to `node /path/to/context-lab/packages/core/dist/src/cli.js`.

---

## 2. CLI command reference

Every command takes `<pack>` (the path to the directory containing `pack.json`) as its first argument after the subcommand:

| Command | Arguments and flags | What it does and writes |
|---|---|---|
| `check` | `context-lab check <pack>` | Validates `<pack>/pack.json`, all referenced `experiments/*.json`, `scenarios/*.json`, `hooks/*.mjs`, and the `declaration-check` hook if declared. Exits `0` (`clean`) or `1` listing every defect (`DEFECT <check> <where> <message>`). |
| `record` | `context-lab record <pack> <experiment>` | Computes the canonical SHA-256 content hash of `<experiment>` (and its scenarios and hooks) and appends a preregistration entry to `<pack>/register/<experiment>.json`. Refuses an experiment with `declaredStatus: "result"` unless it declares both `variation` and `default`. |
| `status` | `context-lab status <pack> <experiment>` | Prints the status (`result` or `exploration`) and reason a run of `<experiment>` would carry right now (e.g. `result: recorded, unchanged`, or `exploration: changed since recorded`). |
| `suite` | `context-lab suite <pack> <suite>` | Resolves `<suite>`'s tag/id selector (`allTags`, `anyTags`, `scenarios`) and prints the selected scenario IDs as JSON. |
| `entries` | `context-lab entries <pack>` | Builds and prints the reverse index mapping each `exercises:<ID>` tag on scenarios to the scenario IDs that exercise it. |
| `expose` | `context-lab expose <pack> <scenario> <change>` | Appends an exposure record to `<pack>/register/exposures.jsonl` recording that a held-out `<scenario>` informed `<change>`. |
| `run` | `context-lab run <pack> <suite> [--runs N] [--max-attempts 1\|2] [--parallel P] [--work DIR] [--revision REV]` | Drives a suite through the full lifecycle (`validated -> recorded -> built -> probed -> executed -> measured -> blinded -> judged -> tallied`). Writes the run record under `<pack>/<records.path>/<run-id>/` (`run.json`, `cells/*.json`, `sealed/units.json`, `judging/votes.json`, `RESULT.json`, `RESULT.md`) and workspaces/variants under `--work` (`~/context-lab-work` by default). |
| `resume` | `context-lab resume <pack> <run-dir> [--parallel P] [--work DIR]` | Resumes an interrupted run from `<run-dir>`. Before continuing, verifies that: (1) the run stopped after `probed` (during execution or judging) and `end` is not `"completed"`, (2) the experiment's register hash and model `routes` match `run.json`, (3) the built variants on disk match their recorded manifests in `run.json`, and (4) every recorded cell file (`cells/<cell>.json`) is present and well-formed. Executes only the remaining cells (0 if already past `executed`), records `resumedAt`, and finishes measurement, blinding, judging, and tallying. |
| `thresholds` | `context-lab thresholds <pack> <comparison> <aa-run-dir>` | Checks that the two arms of `<comparison>` delivered identical context in `<aa-run-dir>` (`assertIdenticalArms`), derives the two-stage A/A noise thresholds (size-3 and size-9 per-property and pooled thresholds, two-stage false-positive rate, and drift rate), and appends them to `<pack>/register/thresholds/<comparison>.jsonl`. |
| `compare` | `context-lab compare <pack> <comparison> <base-run-dir> [--head DIR] [--runs K] [--nine DIR] [--nine-head DIR] [--out FILE]` | Compares `<comparison>`'s `base` and `head` arms using the rule declared on `<comparison>` (`"aa"`, `"tolerance"`, or `"improve"`). Reads the latest recorded threshold set from `<pack>/register/thresholds/<comparison>.jsonl` when present. If `--head` is omitted, reads both `base` and `head` arms from `<base-run-dir>`. `--runs K` limits the comparison to the first `K` cell runs (`run <= K`) of each arm. When `--nine` (and optional `--nine-head`) is given under `rule: "aa"`, runs stage-2 size-9 confirmation on properties flagged at stage 1. Prints the comparison JSON and writes it to `--out` if given. |
| `pick` | `context-lab pick <pack> <run-dir> [--mode calibration\|preference] [--count N] [--with ARM] [--without ARM]` | Runs the interactive human panel in the terminal on blinded outcome pairs from `<run-dir>`. Defaults to `--mode calibration` and `--count 12` when omitted (`calibration` checks judge-person agreement; `preference` compares `--with` against `--without`). Writes `<run-dir>/picks.json` and re-tallies `<run-dir>/RESULT.json` and `<run-dir>/RESULT.md`. |
| `candidates` | `context-lab candidates <pack> <run-dir>` | Extracts candidate findings from `<run-dir>` (adherence failing in every guided arm, wrong firings, comprehension-without-adherence gaps, classify-then-verify chain findings meeting threshold, guidance entries agents did not open when only reachable on request, adherence missed by agents that did open the entry, and judges that alone differ in most splits) and writes `<run-dir>/CANDIDATES.json` and `<run-dir>/CANDIDATES.md`. |
| `review` | `context-lab review <pack> --prompt <file> [--files <path,...>] --out <dir> [--members <id,...>] [--verify] [--parallel N] [--work <dir>] [--tools on\|off] [--sockets] [--mount-sources] [--ro <path,...>] [--timeout <seconds>]` | Orchestrates an on-demand multi-model review across model families. Selects one member per family from `<pack>`'s population by default (or the comma-separated `--members`), runs `<prompt>` (with optional comma-separated `--files` attached; when `--tools on` is passed, gives each reviewer a writable `{WORKSPACE}`, optionally enables socket creation in Codex's workspace-write sandbox via `--sockets`, mounts `<pack>`'s `sources` read-only via `--mount-sources` with `{SOURCES}` substituted in the prompt and extra read-only paths via `--ro`, and retains `<out>/workspaces/<member>/` and `<out>/events/<member>.jsonl`), extracts structured findings (mapping `"high"\|"critical"` to `"blocking"` and `"medium"\|"major"\|"material"` to `"should-fix"`), and when `--verify` is passed, sends each finding to every other family's reviewer for a boolean `supports: true\|false` verdict (recording `verdicts`, `supportingFamilies`, and `familyCount` on each finding). Writes `REVIEW.json` and `REVIEW.md` into `--out`. |

---

## 3. Project pack layout and schema (`context-lab.pack/1`)

A project pack is a directory inside the consuming repository (for example `evals/context-lab/` or `docs/evals/context-lab/`) with the following layout:
```text
evals/context-lab/
  pack.json                  # top-level pack declaration (schema: "context-lab.pack/1")
  experiments/<id>.json      # experiment declarations
  scenarios/<id>.json        # scenario declarations
  hooks/<id>.mjs             # optional sandboxed hooks
  register/                  # committed preregistration hashes, exposures, and A/A thresholds
```

Every `id` in `pack.json`, `sources`, `variants`, `arms`, `population`, `hooks`, `suites`, `isolation.leakProbes`, `experiments`, and `scenarios` must be a **lowercase slug** matching `/^[a-z0-9][a-z0-9.-]*$/` (`slug-ids`).\
Paths that reference files inside a source, variant, fixture, or the pack itself (`sources[].exclude`, `arms[].deliver[].file`, `hooks[].file`, `scenarios[].fixture`, `scenarios[].scoredFile`, `phases[].note.file`, `phases[].withhold`) must be relative and stay inside that directory (`contained-paths`), whereas `sources[].path`, `isolation.forbidden.paths`, and `records.path` resolve relative to the pack directory and may point to parent or sibling directories (`../..`, `../runs`).

### 3.1 `pack.json` schema

Top-level fields of `pack.json` (no unknown fields are permitted):

- `schema` *(required, string)*: must be `"context-lab.pack/1"`.
- `id` *(required, lowercase slug)*: pack identifier (e.g. `"acme"`).
- `sources` *(required, array)*: repositories or directories from which context variants are exported via `git archive`:
  - `id` *(required, lowercase slug)*
  - `path` *(required, string)*: path to an existing directory inside a git repository, relative to the pack directory (e.g. `"../../docs"` or `"../.."`).
  - `addresses` *(required, string[])*: published URLs rewritten to the local variant path when built (longest prefix first).
  - `exclude` *(optional, string[])*: relative paths inside the source removed from every variant (cannot be `"."`).
- `variants` *(required, array)*: read-only copies of a source:
  - `id` *(required, lowercase slug)*
  - `source` *(required, string)*: id of a declared entry in `sources`.
  - `canaries` *(required, string[])*: canary strings planted in `context-lab-canary.md` at the variant root to prove delivery.
  - `include` *(optional, string[])*: glob patterns of files to keep.
  - `transform` *(optional, string)*: id of a `"variant-transform"` hook.
  - `revision` *(optional, string)*: git revision to export (overrides the run's `--revision` / `HEAD`; verified by `context-lab check <pack>` against the source repository).
- `arms` *(required, array)*: context conditions compared in experiments:
  - `id` *(required, lowercase slug)*: e.g. `"control"`, `"guided"`.
  - `deliver` *(required, array)*: list of `{ "variant": "<variant-id>", "file": "<relative-path-in-variant>", "as": "instruction" | "folder-file" | "on-request" }`. An empty array `[]` delivers nothing.
- `population` *(required, array)*: agent/judge models:
  - `id` *(required, lowercase slug)*: e.g. `"c"`, `"o"`.
  - `family` *(required, string)*: model family name (e.g. `"claude"`, `"gemini"`, `"grok"`, `"gpt"`). Judges are assigned strictly cross-family (`judge.family !== agent.family`).
  - `runtime` *(required, string)*: `"opencode"`, `"codex"`, or `"external"`.
  - `model` *(required, string)*: model identifier for the runtime.
  - `settings` *(optional, object)*: for `"opencode"`, supports `"outputTokenMax"` (positive integer, e.g. `1048576`) and `"reasoningEffort"`; for `"codex"`, supports `"reasoningEffort"` (e.g. `"high"`).
- `hooks` *(required, array)*: `[]` if none, or objects with:
  - `id` *(required, lowercase slug)*
  - `kind` *(required)*: `"declaration-check"` | `"variant-transform"` | `"outcome-measure"` | `"note-generator"` (`outcome-measure` hooks receive `{ scenario, properties, outcome: { final, rawFinal, diff, scored, rawScored, snapshot } }` on stdin, where `final` and `scored` are the effective bounded strings when `maxResponseBytes` is set, `rawFinal` and `rawScored` hold the untruncated text, and `outcome.snapshot` is mounted read-only inside the `bwrap` sandbox).
  - `file` *(required, relative path)*: script path inside the pack.
  - `timeLimitSeconds` *(required, positive integer)*.
- `masks` *(required, object)*:
  - `identifiers` *(required, string[])*: valid regex strings replaced with `[ID]` before judging (e.g. `["\\bACME-\\d+\\b"]`).
  - `selfExplanationMarker` *(optional, string)*: marker line from which self-explanation is stripped before judging.
- `isolation` *(required, object)*:
  - `leakProbes` *(required, array)*: `{ "id": "<slug>", "question": "<string>", "leak": "<regex>", "arms": ["<arm-id>", ...] }`. Asked before any cell runs; if an arm listed in `arms` matches `leak`, the probe fails and that arm does not run.
  - `forbidden` *(required, object)*: `{ "paths": ["<path>", ...], "addresses": ["<url>", ...] }`. Relative `paths` are resolved against the pack directory. Any tool call touching a forbidden path or address outside the cell's workspace and delivered `on-request` folders invalidates the cell (`cause: "isolation"`).
- `experiments` *(required, string[])*: relative paths to experiment JSON files (e.g. `["experiments/pilot.json"]`).
- `suites` *(required, array)*: `{ "id": "<slug>", "experiment": "<experiment-id>", "select": { "allTags"?: string[], "anyTags"?: string[], "scenarios"?: string[] } }`. Every suite must select at least one scenario.
- `records` *(required, object)*: `{ "path": "<relative-or-absolute-dir>" }` where run directories are written (e.g. `{"path": "../runs"}`).
- `comparisons` *(optional, array)*: `{ "id": "<string>", "experiment": "<experiment-id>", "rule": "aa" | "tolerance" | "improve", "base": "<arm-id>", "head": "<arm-id>", "m"?: <positive-int>, "tolerance"?: <number> }`:
  - `rule: "aa"`: two-stage A/A noise-threshold rule (`m` is the number of properties in the experiment used for family-wise threshold calibration; compares stage-1 size-3 differences against `register/thresholds/<comparison>.jsonl` and confirms flagged properties at size-9 when `--nine` is supplied).
  - `rule: "tolerance"`: flags any property whose `head` mean falls below its `base` mean by more than `tolerance` (`0` by default); there is no pooled check.
  - `rule: "improve"`: flags any property whose `head` mean is below its `base` mean within any model family, or that has no `head` value in a family where `base` has one; there is no pooled check.
  - Every rule compares arms of the one experiment the comparison names, across run directories only when they share that experiment, its scenarios, population, `runsPerCell` and model routes.
- `findingRules` *(optional, object)*: `{ "wrongFiringThreshold"?: <number>, "knowsNotActsThreshold"?: <number>, "routingMissThreshold"?: <number>, "hydratedNotActedThreshold"?: <number>, "judgeOutlierThreshold"?: <number> }`, each `0.25`, `0.5`, `0.5`, `0.5` and `0.5` by default.

### 3.2 `experiments/<id>.json` schema

Fields of an experiment file (no unknown fields are permitted):

- `id` *(required, lowercase slug)*
- `declaredStatus` *(required)*: `"result"` or `"exploration"`. To run as `"result"`, the experiment must also declare `variation` and `default` and be recorded via `context-lab record <pack> <experiment>` before the run starts, with its content hash unchanged and `runsPerCell` not overridden.
- `scenarios` *(required, string[])*: relative paths from the pack root to scenario JSON files (e.g. `["scenarios/s1.json"]`).
- `factors` *(required, object)*: `{ "arms": ["<arm-id>", ...], "population": ["<member-id>", ...] }`.
- `runsPerCell` *(required, positive integer)*: number of independent runs per `(scenario, arm, member)` cell.
- `maxAttemptsPerCell` *(optional, `1` or `2`)*: maximum attempts per cell when an `infrastructure` or `isolation` failure would normally trigger a re-run (`2` by default; set `1` to disable automatic cell retries; recorded in `run.json.maxAttemptsPerCell` and enforced across `resume`).
- `maxResponseBytes` *(optional, positive integer)*: UTF-8 byte ceiling applied to each phase's scored response text (after self-explanation stripping, at a valid UTF-8 code-point boundary, before `answerHeading` splitting and blinding); records `responseBound` (`{ limitBytes, originalBytes, effectiveBytes, truncated, reason }`) on `CellRecord` and `phaseOutcomes[phase]`.
- `phases` *(required, array)*: default phase list `[ { "id": "<slug>", "session": "new" } ]` (in `experiment.phases`, `session` must be `"new"`; multi-phase sequences with `"continue"`, `after`, `note`, or `withhold` are declared on `scenario.phases`).
- `variation` *(optional, required when `declaredStatus` is `"result"`)*: `{ "difference": <number in (0, 1]>, "scope": "pooled" | "property" }`.
- `default` *(optional, required when `declaredStatus` is `"result"`)*: string stating the default decision when no difference of the stated size is detected (e.g. `"no change indicated"`).
- `instructions` *(optional, string)*: system/prompt instructions prepended to the agent task (supports `{ON_REQUEST}` and `{WORKSPACE}` placeholders).
- `preamble` *(optional, string)*: context preamble.
- `judgeInstructions` *(optional, string)*: instructions for cross-family judges.
- `judging` *(optional, object)*:
  - `judges` *(optional, string[])*: population member IDs serving on the judge panel (e.g. `["c", "o"]`).
  - `guessGroups` *(optional, Record<string, string[]>)*: maps guess labels to subsets of `factors.arms`.
  - `outcomesPerPrompt` *(optional, positive integer)*: batch size per judge prompt (default `6`).
  - `chain` *(optional, object)*: classify-then-verify judging chain:
    - `findings` *(required, array)*: `[ { "id": "<string>", "kind": "named" | "computed" | "named or computed", "statement": "<string>", "countsWhen": "<string>" } ]`.
    - `threshold` *(optional, object)*: `{ "minScenarios": <positive-int>, "minHeldOut": <int >= 0>, "minFamilies": <positive-int> }`.
- `notes` *(optional, string)*.

### 3.3 `scenarios/<id>.json` schema

Fields of a scenario file (no unknown fields are permitted):

- `id` *(required, lowercase slug)*
- `tags` *(required, string[])*: tags used by suites (`select.allTags` / `anyTags`) and `exercises:<ID>` reverse views.
- `fixture` *(required)*: `null` (empty workspace), a relative directory path `"fixtures/my-dir"`, or an inline file map `{ "files": { "path/in/ws.txt": "content..." } }`.
- `task` *(required, string)*: task prompt for the first phase (supports `{WORKSPACE}`, `{ON_REQUEST}`, and `{SLOT:<pos>}` placeholders).
- `properties` *(required, array)*: properties scored on the outcome:
  - `id` *(required, string)*
  - `type` *(required)*: `"adherence"` | `"precision"` | `"comprehension"`.
  - `decidedBy` *(required)*: `"judge"` or `"code"`.
  - `key` *(required, string)*: what a passing outcome or answer must satisfy.
  - `scale` *(required, `[number, number]`)*: `[low, high]` with `low < high` (e.g. `[0, 1]` or `[0, 2]`).
  - `measure` *(optional, string)*: required when `decidedBy` is `"code"` (id of an `"outcome-measure"` hook); must be omitted when `decidedBy` is `"judge"`.
  - `rubric` *(optional, string)*: scoring rubric for judges.
  - `answerHeading` *(optional, string)*: heading (`#` through `######`, matching exact heading, `<prefix>.<id>`, or `<id>` followed by title text such as `## Q01 - Title`) split into an individual comprehension answer unit; requires `scoredFile` or `answerSource: "final"` on the scenario. If a heading appears more than once, the first non-empty occurrence is kept; unrequested headings (such as `Observations`) are not extracted, but an answer ends at the next heading of any level, so a subsection heading inside an answer cuts it there.
  - `question` *(optional, string)*: question text shown to comprehension judges.
  - `phase` *(optional, string)*: id of the phase in `phases` whose outcome this property scores (defaults to the last phase).
  - `judgedWith` *(optional, array of `"note"` | `"start"` | `"delivered"`)*: includes the phase's incoming `{NOTE}`, `startDiff`, and/or the arm's delivered reading (`--- ASSIGNED READING ---`) in the blinded judge unit; for a comprehension property the reading comes first and the answer follows under `--- ANSWER ---`.
  - `guidance` *(optional, string[])*: corpus entry IDs tested by this property (used to compute comprehension-behaviour links).
  - `notes` *(optional, string)*.
- `scoredFile` *(optional, relative path)*: file inside `{WORKSPACE}` read as the scored artifact (required if any property declares `answerHeading`, unless `answerSource` is `"final"`).
- `answerSource` *(optional, `"scored-file"` | `"final"`)*: where `answerHeading` sections are split from (`"scored-file"` by default; set `"final"` to split `### <answerHeading>` directly from the phase's `Outcome.final` message without requiring `scoredFile`).
- `maxResponseBytes` *(optional, positive integer)*: scenario-level UTF-8 byte ceiling overriding `experiment.maxResponseBytes`.
- `phases` *(optional, array)*: multi-phase episode definition overriding `experiment.phases`:
  - Phase 0 (the first phase): `{ "id": "<slug>", "session": "new" }` - must have `session: "new"` and **must not** declare `task`, `after`, `note`, or `withhold` (its task is the scenario's top-level `task`).
  - Subsequent phases (`i >= 1`):
    - `id` *(required, string)*: unique phase id.
    - `session` *(required)*: `"new"` (starts a fresh agent session on the prior phase's committed workspace tree) or `"continue"` (resumes the prior phase's agent session).
    - `task` *(required on phases `i >= 1`, string)*: prompt for this phase (may use `{NOTE}` when `note` is declared).
    - `after` *(optional, string)*: id of an earlier phase to branch from (defaults to the immediately preceding phase `phases[i - 1].id`). At most one phase may `"continue"` the session of any given earlier phase.
    - `note` *(optional, allowed only when `session` is `"new"`)*: `{ "file": "<relative-path-in-workspace>" }` or `{ "generator": "<note-generator-hook-id>" }`.
    - `withhold` *(optional, string[], allowed only when `session` is `"new"`)*: workspace-relative paths removed from the working tree (with a fresh git history) before the new session starts so the agent sees `{NOTE}` without the withheld files.
- `trapPairs` *(optional, array)*: rotating trap pairs `{ "id": "<string>", "positions": ["<slot-name>", ...], "versions": [{ "id": "<string>", "text": "<string>", "files"?: Record<string, string> }, ...], "properties": [ ... ] }`.
- `heldOut` *(optional, boolean)*: when `true`, scored in the `heldOut` section of `RESULT.json`/`RESULT.md` and excluded from main totals.
- `start` *(optional, string)*: description of starting state shown to judges.
- `scoring` *(optional, string)*: instructions on what to score shown to judges.
- `notes` *(optional, string)*.

---

## 4. Complete copy-pasteable example pack

Below is a complete, minimal project pack under `evals/context-lab/` that passes `context-lab check evals/context-lab` with zero defects.

### `evals/context-lab/pack.json`

```json
{
  "schema": "context-lab.pack/1",
  "id": "acme",
  "sources": [
    {
      "id": "acme-docs",
      "path": "../../docs",
      "addresses": [
        "https://github.com/acme/docs"
      ]
    }
  ],
  "variants": [
    {
      "id": "docs-v1",
      "source": "acme-docs",
      "canaries": [
        "The lantern on pier nine burns green."
      ]
    }
  ],
  "arms": [
    {
      "id": "control",
      "deliver": []
    },
    {
      "id": "guided",
      "deliver": [
        {
          "variant": "docs-v1",
          "file": "GUIDE.md",
          "as": "instruction"
        }
      ]
    }
  ],
  "population": [
    {
      "id": "c",
      "family": "claude",
      "runtime": "opencode",
      "model": "litellm-nexus/claude-opus-5-5",
      "settings": {
        "outputTokenMax": 1048576
      }
    },
    {
      "id": "o",
      "family": "gpt",
      "runtime": "codex",
      "model": "gpt-6-astra",
      "settings": {
        "reasoningEffort": "high"
      }
    }
  ],
  "hooks": [],
  "masks": {
    "identifiers": [
      "\\bACME-\\d+\\b"
    ]
  },
  "isolation": {
    "leakProbes": [
      {
        "id": "heron",
        "question": "What is the secret phrase in GUIDE.md, or NONE?",
        "leak": "cobalt heron",
        "arms": [
          "control"
        ]
      }
    ],
    "forbidden": {
      "paths": [
        "../../docs"
      ],
      "addresses": [
        "https://github.com/acme/docs"
      ]
    }
  },
  "experiments": [
    "experiments/pilot.json"
  ],
  "suites": [
    {
      "id": "pilot",
      "experiment": "pilot",
      "select": {
        "allTags": [
          "pilot"
        ]
      }
    }
  ],
  "records": {
    "path": "../runs"
  },
  "comparisons": [
    {
      "id": "pilot-gate",
      "experiment": "pilot",
      "rule": "aa",
      "base": "control",
      "head": "guided",
      "m": 1
    }
  ]
}
```

### `evals/context-lab/experiments/pilot.json`

```json
{
  "id": "pilot",
  "declaredStatus": "result",
  "scenarios": [
    "scenarios/s1.json"
  ],
  "factors": {
    "arms": [
      "control",
      "guided"
    ],
    "population": [
      "c",
      "o"
    ]
  },
  "runsPerCell": 1,
  "phases": [
    {
      "id": "work",
      "session": "new"
    }
  ],
  "variation": {
    "difference": 0.25,
    "scope": "pooled"
  },
  "default": "no change indicated",
  "judging": {
    "judges": [
      "c",
      "o"
    ],
    "chain": {
      "findings": [
        {
          "id": "f-guide",
          "kind": "named",
          "statement": "Agent cites the guide",
          "countsWhen": "Only when explicitly named"
        }
      ],
      "threshold": {
        "minScenarios": 1,
        "minHeldOut": 0,
        "minFamilies": 1
      }
    }
  }
}
```

### `evals/context-lab/scenarios/s1.json`

```json
{
  "id": "s1",
  "tags": [
    "pilot"
  ],
  "fixture": null,
  "task": "Phase 1: summarise the guide and write notes/handoff.md.",
  "scoredFile": "answer.md",
  "phases": [
    {
      "id": "work",
      "session": "new"
    },
    {
      "id": "followup",
      "session": "new",
      "after": "work",
      "note": {
        "file": "notes/handoff.md"
      },
      "withhold": [
        "notes/handoff.md"
      ],
      "task": "Phase 2: using {NOTE}, write answer.md."
    }
  ],
  "properties": [
    {
      "id": "p-guide",
      "type": "adherence",
      "decidedBy": "judge",
      "key": "Follows the guide.",
      "scale": [
        0,
        1
      ],
      "phase": "followup",
      "judgedWith": [
        "note"
      ]
    }
  ]
}
```

---

## 5. Journey 1 - Validate, preregister, check status, and run a suite

To produce a run carrying status **`result`** (rather than **`exploration`**):

1. Set `"declaredStatus": "result"`, `"variation": {"difference": ..., "scope": "pooled" | "property"}`, and `"default": "..."` in the experiment file.
2. Validate the pack:
```sh
context-lab check evals/context-lab
```

3. Fix the experiment's content hash in the pack's append-only register (`evals/context-lab/register/<experiment>.json`) before running:
```sh
context-lab record evals/context-lab pilot
```

4. Confirm that a run will carry status `result`:
```sh
context-lab status evals/context-lab pilot
```

5. Execute the suite (do not override `--runs` to a different value than `runsPerCell`, or the run will downgrade to `exploration`):
```sh
context-lab run evals/context-lab pilot --parallel 4
```

`RESULT.md` reports these diagnostics beside the scores, and `RESULT.json` carries each one as a field; none changes a score:

- **Properties** and **Totals**: each property's mean per arm, and how often its judges' votes agreed.
- **Guesses** (`guesses`): how often judges guessed the arm an outcome came from, per scenario and property.
- **On-request guidance hydration** (`hydration`): per scenario, arm and guidance id, how many valid cells hydrated the guidance entry, which members never did, and how often each adherence property naming the entry was met by the cells that hydrated it and by those that did not. A cell hydrated an entry when a tool call in any phase of its scored attempt named a path, or had an input, holding the entry id and a hyphen after a path separator, quote or space (`axioms/A3-sovereign-composition.md`), case ignored: this sees an entry named by a read or by a search pattern, and misses a bulk read such as `cat axioms/*.md`, and an entry file not named `<id>-...` is never seen. Only arms with an on-request folder and no instruction or folder file named for the entry are listed; the folder's contents are not checked. A run recorded before arms' deliveries were kept lists every arm. Held-out scenarios are left out.
- **Cost per arm** (`costs`): the mean input, cached-input and output tokens, tool calls and seconds of a counted cell's scored attempt, its phases summed, per arm in `RESULT.md` and also per arm and member in `RESULT.json`. A counted cell is a valid one or one that ended on agent behaviour, as both are scored. Input tokens include cached input. A token mean is over the cells whose runtime reported that count in every phase. Held-out scenarios are left out.
- **Judge dissent** (`judgeDissent`): per judge, the values it cast, the splits it was in (a unit's property valued by at least three judges who did not all agree), and how often it alone differed. A judge whose rate stands far above the others is the first place to look when agreement is low.
- **Provider and agent faults** (`faults`): attempts, retries, exclusions and fault kinds per member, family and arm.

Each isolation probe answer in `run.json` (`probes[].answers[]`) records `toolCalls` and `attempts`.\
A probe answer counts only if its last attempt made no tool call; a retry after a tool call tells the agent that no file is mounted, so a read cannot help.

---

## 6. Journey 2 - Two-stage A/A noise-gated comparison and run resumption

### 6.1 Derive A/A thresholds and compare base against head

1. Run an A/A experiment whose two arms (`base` and `head` on the comparison entry) deliver identical context, then derive and record its size-3 and size-9 noise thresholds into `<pack>/register/thresholds/<comparison>.jsonl`:
```sh
context-lab thresholds evals/context-lab pilot-gate evals/runs/2026-10-14-004707-aa
```

2. Compare a base run against a head run (when both arms ran in the same run directory, `--head` may be omitted; pass `--nine` and `--nine-head` when confirming stage-1 flags with a size-9 run, and `--out` to write the JSON report):
```sh
context-lab compare evals/context-lab pilot-gate evals/runs/base-run \
  --head evals/runs/head-run \
  --nine evals/runs/nine-base \
  --nine-head evals/runs/nine-head \
  --out evals/runs/COMPARE.json
```

### 6.2 Resume an interrupted run

If a run is stopped during cell execution (for example by a host restart), resume it in place:
```sh
context-lab resume evals/context-lab evals/runs/2026-10-14-004707-aa --parallel 4
```

Before executing any remaining cells, `resume` verifies four preconditions against the run record (`run.json`):

1. **Lifecycle state:** the run reached at least state `probed` (and if it already reached `executed`, `measured`, `blinded`, or `judged`, all expected cell files are present on disk so `resume` re-runs only measurement, blinding, judging, and tallying without re-running any agent cell), and its `end` field is not `"completed"`.
2. **Register and routes:** the experiment's current content hash in `register/<experiment>.json` and every member's adapter `route` match what `run.json` recorded when the run started.
3. **Variant manifests:** every built variant directory under the working folder still matches its recorded `VariantManifest` in `run.json`.
4. **Recorded cells and single-attempt dispatch guard:** every cell listed in `run.json` has a present, well-formed `cells/<cell>.json` file on disk; and under `maxAttemptsPerCell: 1`, `resume` also verifies that `--work` matches `run.json.work` and exists on disk, and that no unfinished cell appears in `run.json.dispatchedCells` or has a ledger/snapshot/workspace/invocation directory on disk.

Once verified, `resume` executes only the unfinished cells, records `resumedAt` in `run.json`, and runs `measured -> blinded -> judged -> tallied` to completion.

---

## 7. Journey 3 - Human panel (`pick`), candidate findings (`candidates`), and multi-family review (`review`)

### 7.1 Interactive human panel (`pick`)

Run `pick` on a completed run directory to present blinded outcome pairs in the terminal:
```sh
# Calibration mode: check agreement between agent judges and a human
context-lab pick evals/context-lab evals/runs/<run-id> --mode calibration --count 12

# Preference mode: blind side-by-side comparison between two arms
context-lab pick evals/context-lab evals/runs/<run-id> --mode preference --count 10 --with guided --without control
```

`pick` writes the human's choices to `<run-dir>/picks.json` and re-tallies `<run-dir>/RESULT.json` and `<run-dir>/RESULT.md` (adding a calibration warning to `RESULT.md` if judge-human agreement falls below 75%).

### 7.2 Candidate backlog findings (`candidates`)

Extract candidate findings from a completed run:
```sh
context-lab candidates evals/context-lab evals/runs/<run-id>
```

Writes `<run-dir>/CANDIDATES.json` and `<run-dir>/CANDIDATES.md`, one candidate per rule that holds, each with a draft backlog row and a revival trigger:

| Rule | Fires when | Threshold (`findingRules`) |
|---|---|---|
| `all-guided-fail` | An adherence property scores 0 in every guided arm. | none |
| `wrong-firing` | A precision property's fail rate in a guided arm exceeds the threshold. | `wrongFiringThreshold`, `0.25` |
| `knows-not-acts` | Across guided arms, the share of comprehension-met, adherence-not-met pairs for a guidance id exceeds the threshold. | `knowsNotActsThreshold`, `0.5` |
| `chain-threshold` | A classify-then-verify finding meets `chain.threshold`. | `chain.threshold` |
| `routing-miss` | A `hydration` row of a guided arm, listed as on-request only, has at least 2 cells and a hydration rate below the threshold. | `routingMissThreshold`, `0.5` |
| `hydrated-not-acted` | In a `hydration` row of a guided arm, listed as on-request only, at least 2 hydrating cells have a value for an adherence property naming the entry, and the share of them not meeting it exceeds the threshold; written once per scenario, property and arm. | `hydratedNotActedThreshold`, `0.5` |
| `judge-outlier` | A judge was in at least 10 splits and alone differed in more than the threshold share of them. | `judgeOutlierThreshold`, `0.5` |

`routing-miss` and `hydrated-not-acted` read the `hydration` rows of `RESULT.json`, and only those whose arm deliveries were recorded, so a run made before deliveries were recorded emits neither.Where a scenario declares `exercises:<id>` tags, they read only rows for those ids: an entry a property names beside the one the scenario exercises need not be opened when that one is.

### 7.3 On-demand multi-family review (`review --verify`)

Put any review prompt and target files to models across distinct families in parallel, with optional cross-family verification:
```sh
context-lab review evals/context-lab \
  --prompt docs/reviews/prompt.md \
  --files docs/design.md,src/index.ts \
  --out docs/reviews/out-dir \
  --verify \
  --parallel 4 \
  [--tools on|off] [--sockets] [--mount-sources] [--ro <path,...>] [--timeout <seconds>]
```

How `review` works and what it writes:

- By default it selects one member per model family from `<pack>`'s population (or the comma-separated `--members <id,...>`) and runs with `--tools off` (`--timeout 900` seconds by default).
- When `--tools on` is passed (for example for independent stage-certification verifiers or multi-repo audits), each reviewer runs with tools enabled in its own writable `{WORKSPACE}`, `--sockets` (valid only with `--tools on`) sets `[sandbox_workspace_write] network_access = true` in Codex's `config.toml` so Codex verifiers can create Unix-domain and loopback sockets during test runs and records `"sockets": true` in `REVIEW.json`, `--mount-sources` mounts the pack's `sources` read-only in `bwrap` (substituting `{SOURCES}` and `{WORKSPACE}` in the prompt instead of inlining whole repositories), `--ro <path,...>` mounts additional read-only host paths (such as `~/.npm`), and each reviewer's workspace and scrubbed event log are retained at `<out>/workspaces/<member>/` and `<out>/events/<member>.jsonl`.
- Each reviewer returns structured findings (`id`, `severity`, `title`, `evidence`, `fix`; severity aliases `"high"|"critical"` map to `"blocking"` and `"medium"|"major"|"material"` map to `"should-fix"`).
- When `--verify` is passed, each extracted finding is sent to every reviewer of **another** model family (`verifier.family !== author.family`), which replies with a boolean `supports: true | false` and a one-sentence `reason`. The core aggregates those into `verdicts`, `supportingFamilies`, and `familyCount` on each finding.
- Writes `REVIEW.json` and `REVIEW.md` into `--out`.

---

## 8. Remove and clean up

Run records live under `<pack>/<records.path>` and working files (exported variants, probe folders, and cell workspaces) live under `~/context-lab-work` (or `--work`).\
Remove working directories with:
```sh
rm -rf ~/context-lab-work
```
