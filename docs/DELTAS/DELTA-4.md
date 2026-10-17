# Delta-4 - hardening: failure injection, provider fault characterisation, and per-property arm-guess blinding - a vertical slice

```yaml
status:     draft - revision 2, adversarial review findings applied; ready for director ratification
selected:   docs/DECISIONS.md 0027, board items M4.1, M4.2, M4.3
from-state: Delta-3's to-state (0027): all 22 components of docs/ARCHITECTURE-TARGET.md section 5 built, mission-kit and zorg packs running on the core
to-state:   docs/ARCHITECTURE-TARGET.md (0006, 0026), section 4 tensions for A8 and A9 and section 9 rows 3, 4 and 6 discharged
rows:       docs/BACKLOG.md B4, B5, B7
```

---

## 0. From-state -> to-state

**From.**\
All twenty-two components of `docs/ARCHITECTURE-TARGET.md` section 5 are built (`0017`, `0024`, `0027`), but three open items in section 9 (`Owed and open` rows 3, 4 and 6; backlog rows `B4`, `B5`, `B7`) remain:
1. **`B4` (`M4.1`, `A9`):** the validity classifier (`packages/core/src/validity-classifier.ts`) is tested on synthetic event arrays (`validity-classifier.test.ts`), not by end-to-end fault injection through the real adapter and bwrap sandbox pipeline (`conductRun` -> `runEpisode` -> `opencodeAdapter`/`codexAdapter` -> `runSandboxed` -> `parseOpencode`/`parseCodex` -> `classify`).
2. **`B7` (`M4.2`, `A7`):** content filters, provider errors, rate limits, and timeouts are not characterised per member/family and arm across runs or in `Result` (`RESULT.json` / `RESULT.md`); clustering of infrastructure and filter faults by provider/family was inferred from one provider rather than measured across the corpus of recorded live runs.
3. **`B5` (`M4.3`, `A8`):** `Result.guesses` reports judges' condition-guess rate only pooled across the whole run, never per scenario or per property, so a single trap or scenario whose outcomes give away the guided condition (as `adherence-x` did 53/54 in `2026-10-11-092325-adherence` and 54/54 in `adherence-03`) is hidden inside the run-wide average instead of being flagged as `notBlind`.

**To.**\
End-to-end failure injection exercises every cause and sub-cause of the validity classifier through the real sandboxed adapters and `conductRun` (`B4` closed); provider faults (content filters, rate limits / HTTP 429, HTTP 5xx, other provider errors, model/tool timeouts, context overflows, empty replies, crashes, isolation) are summarised per member, family and arm in `Result.faults` and characterised across all 21 recorded live run directories in `docs/probes/2026-10-17-provider-faults.json` (`B7` closed); and `Result.guesses` reports `byScenario` and `byProperty` guess rates against each bucket's base rate, flagging any scenario/property with at least 6 guesses whose accuracy is at least `0.75` and strictly exceeds `baseRate + 0.25` as `notBlind` (`B5` closed; `docs/ARCHITECTURE-TARGET.md` section 1, section 4 `A8`/`A9`, and section 9 rows 3, 4 and 6 updated).

---

## 1. The fence

This delta builds:

- **End-to-end failure injection harness (`M4.1`, `B4`, `packages/core/test/failure-injection.test.ts`).**
  - Drives `conductRun` through real `opencodeAdapter` and `codexAdapter` instances running inside `runSandboxed` (`bwrap`) with a fault-injecting binary stub.
  - **Stub dispatch:** when invoked with `tools === "off"` (during `probeArm` canary/leak probes and `judgeAll` prompts), the stub emits a clean tools-off completion (quoting the canary from its instructions on `CANARY_QUESTION`, replying `"NONE"` on leak probes, and returning valid JSON judge votes on `=== OUTCOME` prompts) so probing and judging succeed. When invoked on a cell (`tools === "on"`), the stub emits real opencode/Codex JSONL event streams, exit codes, and signals for the 9 injected fault modes:
    1. `isolation-address` (both runtimes): tool call reaching a forbidden URL -> attempt 1 classified `isolation`, re-run once (attempt 2), cell excluded as `isolation` when attempt 2 also breaches (and valid when attempt 2 is clean);
    2. `isolation-path-open` (both runtimes, wrapped with `{ ...adapter, filesystem: "open" }` so `conductRun` treats the filesystem as open while still executing through `runSandboxed` / `bwrap` and `parseOpencode` / `parseCodex`): tool call touching a forbidden path -> attempt 1 classified `isolation`, re-run once;
    3. `isolation-path-sandboxed` (both runtimes, default `filesystem: "sandboxed"`, `0015`): tool call naming a forbidden path -> recorded in `unreachable`, cell remains `valid: true` on attempt 1, not re-run;
    4. `infra-filter` (both runtimes): content filter event (`ContentFilterError` / `content-filter` stop reason on opencode; filter message on Codex) -> attempt 1 classified `infrastructure`, re-run once, valid when attempt 2 succeeds;
    5. `infra-provider-503` (both runtimes): provider 503 / rate-limit 429 error -> attempt 1 classified `infrastructure`, re-run once, excluded as `infrastructure` when attempt 2 also fails;
    6. `infra-crash` (both runtimes): non-zero exit code (`exit 2`) without a final message -> attempt 1 classified `infrastructure`, re-run once;
    7. `timeout-open-step-0012` (opencode, where an open `step_start` produces `inFlight: "unknown"`, plus Codex `timeout-model` on open `turn.started` and `timeout-tool` on open `item.started`): on opencode, attempt 1 with `inFlight: "unknown"` is classified `infrastructure` and re-run, and a second open-step timeout on attempt 2 is classified `behaviour` (`0012`), not re-run, scored `0`; on Codex, `timeout-model` is classified `infrastructure` (re-run once) and `timeout-tool` is classified `behaviour` (not re-run, scored `0`);
    8. `behaviour-overflow` (both runtimes): context window overflow error -> attempt 1 classified `behaviour`, **not** re-run (`attempts.length === 1`), scored at bottom of scale (`0`);
    9. `behaviour-empty` (both runtimes): exit 0 with empty final message -> attempt 1 classified `behaviour`, **not** re-run (`attempts.length === 1`), scored at bottom of scale (`0`).
- **Provider fault and rate-limit characterisation (`M4.2`, `B7`, `packages/core/src/measures.ts`, `tally.ts`, `run-conductor.ts`, and `docs/probes/2026-10-17-provider-faults.json`).**
  - Adds `FAULT_KINDS = ["isolation", "filter", "rate-limit", "provider-5xx", "provider-other", "timeout-model", "timeout-tool", "overflow", "empty", "crash"] as const` and `faultProfile(cells, members, arms, memberFamilies)` in `packages/core/src/measures.ts`, called by `tally()` to populate `Result.faults: FaultRow[]` (with `tallyRun` always passing `memberFamilies` from `record.snapshot.population`, and `family` defaulting to `memberFamilies?.get(member) ?? member` when `tally()` is called directly in unit tests):
    - iterates over all `t.cells` (including held-out scenarios), emitting one row `{ member, family, arm, attempts, retriedCells, excludedCells, byKind: Record<FaultKind, number> }` for each `(member, arm)` in `t.members x t.arms` that has at least one cell in `t.cells` (in `t.members`, `t.arms` declaration order, with all 10 `byKind` keys initialised to `0`);
    - `attempts` is the total number of attempts (`sum(c.attempts.length)`) in that `(member, arm)`, `retriedCells` is the count of cells with `c.attempts.length > 1`, and `excludedCells` is the count of cells where `!c.valid` and the last attempt's cause is not `"behaviour"`;
    - for each attempt `a` where `!a.validity.valid`, inspects the first invalid phase outcome `const o = a.phases?.find((p) => p.validity !== null && !p.validity.valid)?.outcome ?? a.outcome` and classifies it in this exact order:
      1. `a.validity.cause === "isolation"` -> `"isolation"`;
      2. `o.filtered || o.error?.cause === "filter"` -> `"filter"`;
      3. `o.error?.cause === "provider"` -> `"rate-limit"` if `/429|rate.?limit|quota|too many requests/i.test(o.error.message)`, else `"provider-5xx"` if `/\b50[0234]\b|service unavailable|bad gateway|overloaded/i.test(o.error.message)`, else `"provider-other"`;
      4. `o.error?.cause === "overflow"` -> `"overflow"`;
      5. `o.stop.reason === "timeout"` -> `"timeout-model"` if `a.validity.cause === "infrastructure"` (model wait or first open-step timeout), else `"timeout-tool"` (`a.validity.cause === "behaviour"`, tool wait or re-run open-step timeout);
      6. `a.validity.cause === "behaviour" && o.final.trim() === ""` -> `"empty"`;
      7. otherwise (non-zero exit, runtime error, core `a.failure`, or broken workspace repository) -> `"crash"`.
    - renders a `## Provider and agent faults` section in `RESULT.md`.
  - Characterises all 21 recorded live run directories containing a `run.json` across `mission-kit/docs/evals/runs/context-lab/` (20 run directories; `2026-10-16-review-g8` has `REVIEW.json` and no `run.json`) and `zorg/evals/runs/context-lab/` (1 run directory) in `docs/probes/2026-10-17-provider-faults.json` with keys `{ generatedAt, runs, totals: { runs, completedRuns, stoppedRuns, cells, attempts, retriedCells, excludedCells, byKind }, byFamily, byMember, byRuntime, probeFailures }`.
- **Per-scenario and per-property arm-guess blinding test (`M4.3`, `B5`, `packages/core/src/tally.ts`).**
  - Extends `Result.guesses` with `byScenario: Record<string, GuessBucket>` and `byProperty: Record<string, GuessBucket & { scenario: string; property: string }>`, where `GuessBucket` is `{ right: number; all: number; baseRate: number | null; rate: number | null; notBlind: boolean }`:
    - `byScenario` has one entry per non-held-out scenario (`scenario.id`) in declaration order, and `byProperty` has one entry per non-held-out `decidedBy === "judge"` property (`"${scenario.id}/${property.id}"`) in declaration order;
    - for each non-held-out unit `u` and judge `j` with a non-null `guess` in `t.votes` (deduplicated by `(u.id, j)` as `Result.guesses` does), credits the guess (and its truth group `groupOf(u.arm)`) to `byScenario[u.scenario]` and to `byProperty["${u.scenario}/${pid}"]` for each judged property `pid` in `u.properties`;
    - in each bucket, `rate = all > 0 ? right / all : null`, `baseRate = all > 0 ? maxGroupCount / all : null`, and `notBlind = all >= 6 && rate !== null && baseRate !== null && rate >= 0.75 && rate > baseRate + 0.25`;
    - `resultMarkdown(r, limits)` in `tally.ts` renders the per-scenario/property guess table when `r.guesses.all > 0` and automatically appends a limit warning naming every `byProperty` key with `notBlind === true`: `` `Blinding to condition did not hold on ${keys.join(", ")}: lean on code-scored properties there.` ``
    - Updates the synthetic `Result` literal in `packages/core/test/chain-candidates.test.ts` for the new `Result.faults` and `Result.guesses.byScenario` / `byProperty` fields.
    - Verifies on copies of both `mission-kit` adherence runs: `2026-10-11-092325-adherence` (where `adherence-x` is `53/54 = 0.9815` and `adherence-a13` is `51/54 = 0.9444` against `baseRate = 0.6667`, flagging `x1`..`x7`, `a13-1`, `a13-2` as `notBlind: true` and emitting the `RESULT.md` limit warning) and `2026-10-14-112229-adherence` (where `adherence-x` is `111/135 = 0.8222` against `baseRate = 0.6667`, `notBlind: false`).
- **Target architecture and board closure (`H4`).**
  - Updates `docs/ARCHITECTURE-TARGET.md` section 1, section 4 (`A8`, `A9`), and section 9 (marking rows 3, 4 and 6 `**CLOSED**`); closes `B4`, `B5` and `B7` in `docs/BACKLOG.md`; and marks milestone `M4` `DONE` in `docs/BOARD.md`.

---

## 2. Build order - certifiable stages

1. **Failure injection (`M4.1`, `B4`).** End-to-end fault injection suite (`packages/core/test/failure-injection.test.ts`) exercising all 9 fault modes through the sandboxed adapters and `conductRun`. Criterion H1.
2. **Provider fault characterisation, per-property arm-guess blinding, and M4 closure (`M4.2`, `M4.3`, `B5`, `B7`).** `faultProfile` (`Result.faults`), `Result.guesses.byScenario` and `byProperty` (`notBlind` flag and `RESULT.md` limit warning), corpus-wide live run fault characterisation in `docs/probes/2026-10-17-provider-faults.json`, re-tally checks on `2026-10-11-092325-adherence` and `2026-10-14-112229-adherence`, and closing `B4`, `B5`, `B7` and milestone `M4`. Criteria H2, H3, H4.

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven, by criterion | Deferred, to board item |
|---|---|---|
| `0004` invalid cells classified by cause and exercised by failure injection (`A9`, `B4`) | H1 | - |
| `0004` provider filters, rate limits and errors characterised per family and arm (`A7`, `B7`) | H2 | - |
| `0004` arm-guess blinding reported per scenario/property and flagged when not blind (`A8`, `B5`) | H3 | - |
| `0006` section 4 (`A8`, `A9`) and section 9 rows 3, 4 and 6 discharged; milestone `M4` complete | H1, H2, H3, H4 | - |

---

## 4. Verification targets

- End-to-end failure-injection test suite (`packages/core/test/failure-injection.test.ts`) running through `conductRun` and `runSandboxed` (`bwrap`).
- Unit and integration tests for `faultProfile` (`Result.faults`) and `Result.guesses.byScenario` / `byProperty` (`notBlind`), with every threshold and classification branch mutation-tested.
- Recorded corpus fault profile (`docs/probes/2026-10-17-provider-faults.json`) derived from all 21 live run directories on disk.

---

## 5. Binary exit criteria

Evaluated by an agent that built none of the code the criterion exercises, holding verifier authority.

| # | Stage | Criterion |
|---|---|---|
| H1 | 1 | `packages/core/test/failure-injection.test.ts` drives `conductRun` through `opencodeAdapter` and `codexAdapter` under `runSandboxed` (`bwrap`) across all 9 fault modes (`isolation-address`, `isolation-path-open` via an open-filesystem wrapper, `isolation-path-sandboxed`, `infra-filter`, `infra-provider-503`, `infra-crash`, `timeout-open-step-0012` / Codex `timeout-model` & `timeout-tool`, `behaviour-overflow`, `behaviour-empty`): each `isolation` and `infrastructure` mode is re-run once (`attempts.length === 2` when attempt 1 fails) and excluded if attempt 2 also fails, `isolation-path-sandboxed` stays valid on attempt 1 with the path in `unreachable`, and each `behaviour` mode is not re-run (`attempts.length === 1`) and scores `0` on its properties. |
| H2 | 2 | `faultProfile` in `measures.ts` (and `Result.faults` in `tally.ts`) classifies every failed attempt across `t.cells` ( inspecting the first invalid phase outcome when `a.phases` is present) into its fault kind (`isolation`, `filter`, `rate-limit`, `provider-5xx`, `provider-other`, `timeout-model`, `timeout-tool`, `overflow`, `empty`, `crash`) per `(member, family, arm)`, including retried first attempts that succeeded on attempt 2; `docs/probes/2026-10-17-provider-faults.json` records the fault profile across all 21 recorded live run directories with `run.json` in `mission-kit/docs/evals/runs/context-lab/` and `zorg/evals/runs/context-lab/` (14 completed runs with 1,625 cells and 7 stopped runs with 239 cells; 38 failed cell attempts total). |
| H3 | 2 | `Result.guesses` includes `byScenario` and `byProperty`, deduplicating `(unit, judge)` pairs, excluding held-out scenarios, computing `rate` and `baseRate` per bucket, setting `notBlind: true` if and only if `all >= 6 && rate >= 0.75 && rate > baseRate + 0.25`, and adding the `RESULT.md` limit warning naming every `notBlind` property; re-tallying copies of `2026-10-11-092325-adherence` (where `adherence-x` at `53/54` and `adherence-a13` at `51/54` flag `notBlind: true` and emit the warning) and `2026-10-14-112229-adherence` (where `adherence-x` at `111/135` against `baseRate = 0.6667` is `notBlind: false`) reproduces those exact values. |
| H4 | 2 | In `context-lab`, `npm test` (`tsc -b` with `strict` enabled and `node --test`) and `node /home/apnex/taceng/mission-kit/tools/check-board.mjs --root /home/apnex/taceng/context-lab` exit 0, with `B4`, `B5`, and `B7` closed in `docs/BACKLOG.md`, section 1, section 4 (`A8`, `A9`), and section 9 rows 3, 4 and 6 updated in `docs/ARCHITECTURE-TARGET.md`, and milestone `M4` marked `DONE` in `docs/BOARD.md`. |

---

## 6. Named costs and non-claims

- **Provider fault characterisation rests on the runs observed.** `docs/probes/2026-10-17-provider-faults.json` summarises the 21 live run directories recorded on this machine (1,864 cell runs across 5 models and 2 runtimes); provider error rates and rate-limit windows vary with time of day and upstream load.
- **Per-property guess attribution on multi-property units.** When one outcome unit is scored on several properties in one judge prompt (such as `adherence-x`'s 7 properties), the judge gives one condition guess for the outcome unit as a whole, so all properties on that unit share the unit's guess rate (`byScenario` and `byProperty` agree for single-unit scenarios).

---

## 7. The anti-scope fence

This delta does not build or change:

- a third runtime adapter (`B6`, held until a project needs a third runtime);
- networked corpus delivery (`B8`, held until a project's decision turns on networked behaviour);
- automatic cross-project sharing of findings (`B9`), automatic filing of `BACKLOG.md` rows (`B10`, P9), or bundling Node.js into the bwrap sandbox (`B15`);
- any change to the pack schema version (`context-lab.pack/1`).

---

## Record

*(To be populated as stages 1-2 are built and verified.)*

---

## Adversarial review

**Reviewer.**\
A fresh agent (`ses_eb826958bffeFyJffDi4jbpxwg`) that did not draft this delta, with read access to `context-lab`, `mission-kit`, and `zorg`, and no edits.

**Verdict on revision 1.**\
Ratify after fixes (4 blocking, 3 should-fix, 1 minor). All 8 findings are resolved in revision 2; re-checked by the same reviewer with verdict **ratify as is**:

| # | Severity | Finding | Disposition in revision 2 |
|---|---|---|---|
| F1 | blocking | `opencodeAdapter` and `codexAdapter` both hardcode `filesystem: "sandboxed"`, so `isolation-path-open` could never fire without an open-filesystem wrapper, and stub behaviour on tools-off `probeArm`/`judgeAll` calls was unstated | Specified `{ ...adapter, filesystem: "open" }` wrapper for `isolation-path-open`, tools-off stub responses for `probeArm` and `judgeAll`, and opencode `timeout-open-step-0012` vs Codex `timeout-model`/`timeout-tool` (Section 1, H1) |
| F2 | blocking | `faultProfile` rules omitted valid-attempt filtering, checked `o.error` ahead of `isolation`, read `a.outcome` (last phase) instead of the first invalid phase in multi-phase episodes, and blurred `0012` attempt 1 vs attempt 2 timeouts | Specified the exact 7-step ordered classification on `!a.validity.valid` inspecting the first invalid phase outcome, checking `isolation` first, and splitting timeouts by `a.validity.cause` (`infrastructure` -> `timeout-model`, `behaviour` -> `timeout-tool`) (Section 1, H2) |
| F3 | blocking | "All recorded live runs" was ambiguous across 14 completed runs, 7 stopped runs, and `review-g8`, and `tallyRun` only passed `memberFamilies` when `chain !== null` | Specified scanning all 21 run directories with `run.json` (14 completed / 1,625 cells, 7 stopped / 239 cells, 38 failed cell attempts), pinned the JSON schema of `2026-10-17-provider-faults.json`, and required `tallyRun` to always pass `memberFamilies` (Section 1, H2) |
| F4 | blocking | In `2026-10-14-112229-adherence`, `adherence-x` is `111/135 = 0.8222` against `baseRate = 0.6667`, so 0 properties flag `notBlind: true` under `rate > baseRate + 0.25`, whereas `2026-10-11-092325-adherence` has `53/54 = 0.9815` (`notBlind: true`) | Included both `2026-10-11-092325-adherence` (positive `notBlind: true` on `adherence-x` `53/54` and `adherence-a13` `51/54`) and `2026-10-14-112229-adherence` (`111/135`, `notBlind: false`) in Section 1 and H3 with exact measured counts |
| F5 | should-fix | `chain-candidates.test.ts:212` constructs a literal `Result` object that would fail `tsc -b` when `Result.faults` and `Result.guesses.byScenario`/`byProperty` are added | Added updating `chain-candidates.test.ts` to Section 1 |
| F6 | should-fix | `faultProfile` row set, ordering, and definitions of `attempts`, `retriedCells`, and `excludedCells` were underspecified | Pinned `t.cells` scope, `(t.members, t.arms)` ordering, all 10 `FaultKind` keys initialised to `0`, and exact definitions of `attempts`, `retriedCells`, and `excludedCells` (Section 1) |
| F7 | should-fix | `byScenario` and `byProperty` key sets, ordering, and `RESULT.md` limit warning string were underspecified | Pinned key sets, declaration order, and the exact warning line in `resultMarkdown` (Section 1, H3) |
| F8 | minor | H4 omitted updating `ARCHITECTURE-TARGET.md` section 1 and section 4 (`A8`, `A9`) alongside section 9 | Added section 1 and section 4 (`A8`, `A9`) to Section 0, Section 1, Section 3 and H4 |
