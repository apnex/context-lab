# Delta-3 - people, chains, on-demand review, and the second user - a vertical slice

```yaml
status:     ratified (docs/DECISIONS.md 0026) - revision 2; stage 4 open
selected:   docs/DECISIONS.md 0025, board items M3.1, M3.2
from-state: Delta-2's to-state (0024): multi-phase episodes, diagnostic measures, threshold deriver, comparator, run resumption
to-state:   docs/ARCHITECTURE-TARGET.md (0006, reopened under section 1 for 0025/B18), all 22 components of section 5
rows:       docs/BACKLOG.md B1, B11, B18
```

---

## 0. From-state -> to-state

**From.**\
Eighteen of the target architecture's twenty-one components are built (`0017`, `0024`).\
The core cannot choose outcome pairs for a person, collect a person's picks, run a classify-then-verify judging chain, write candidate findings from a result, or orchestrate several models of different families on an on-demand review task (`B18`).\
zorg's evaluation mechanisms still live in `zorg/evals/tools/` (`B1`, `B11`), and mission-kit's and zorg's agent-driving and human-panel tools (`mission-kit/tools/adherence.mjs`, `mission-kit/tools/eval-human.mjs`, `zorg/evals/tools/run-agents.mjs`, `zorg/evals/tools/classify-findings.mjs`, `zorg/evals/tools/count-findings.mjs`) are not yet retired.

**To.**\
`docs/ARCHITECTURE-TARGET.md` sections 2, 3, 5, 6 and 9 are updated under section 1's reopen triggers to absorb `0025` (`B18`, the **Review panel** as a 22nd component), and all twenty-two components of section 5 are built.\
zorg has a project pack (`zorg/evals/context-lab/`), verified for parity against its recorded `l-02` census run and run live on the core; mission-kit's human preference runs and zorg's composition-census evaluations run on context-lab, and the five duplicated agent-driving, chain-judging, and human-panel scripts in mission-kit and zorg are deleted (`B1`, `B11`, `B18` closed).

---

## 1. The fence

This delta builds:

- **Target architecture absorption of `0025` (`B18`).** Reopens `docs/ARCHITECTURE-TARGET.md` sections 2, 3, 5, 6 and 9 under their stated triggers in section 1:
  - section 2 (`Scope`) adds on-demand multi-model review of a project artifact or prompt across model families;
  - section 3 (`Decisions`) adds `0017`-`0025`;
  - section 5 (`Anchored core`) adds the 22nd component, **Review panel** (*Duty:* orchestrates an on-demand review prompt across members of distinct model families and cross-verifies their findings; *Consumes:* a pack's population, adapters, a prompt and read-only files; *Exposes:* per-family findings and cross-family verification verdicts; *Serves:* P1, P3, P6, P8);
  - section 6 (`Entities`) adds `Review packet`;
  - section 9 (`Owed and open`) marks rows 1 and 2 closed by Delta-2.
- **Pair chooser (`packages/core/src/pair-chooser.ts`).** Two declared rules:
  1. **Preference pairs:** given two arms (`with` and `without`) of a run, or a static item list `{ id, move, scenario, with, without }[]`, pairs each item and sets `shownA: "with" | "without"` using the deterministic bit flip `flipFor(seed, id)` (`parseInt(sha256("${seed}:${id}").slice(0, 2), 16) % 2 === 1 ? "with" : "without"`).
  2. **Calibration pairs (`0004`, mission-kit `0085`):** from one run's judged outcomes, enumerates all candidate pairs `(u1, u2)` with `u1.id < u2.id` within the same `scenario`, `arm`, `phase` and `property` whose judge-mean scores `m1` and `m2` are both numbers and `m1 !== m2`. Each pair's property has `scale: [low, high]` and midpoint `mid = (low + high) / 2`. Pairs are partitioned into `high` (`Math.max(m1, m2) >= mid`) and `low` (`Math.max(m1, m2) < mid`), sorted by `id` (`"${scenario}/${arm}/${property}:${u1.id}:${u2.id}"`), each partition shuffled with `shuffle(partition, "${seed}:calibration")`, and concatenated as `[...high, ...low].slice(0, count)` (default `count = 8`; outcome units may appear in more than one pair when needed to reach `count`). For each chosen pair, `shownA` is `u2.id` if `flipFor(seed, pair.id)` is true and `u1.id` otherwise, and `higher` records whether `"a"` or `"b"` holds the higher judge mean.
- **Human panel (`packages/core/src/human-panel.ts`), the `picked` state, and CLI `context-lab pick`.**
  - Presents each pair `(A, B)` over an input/output stream (terminal or pipe) without showing arm names, member ids, or judge scores; accepts `a`, `b`, or `=` (re-prompting on other lines; `Ctrl-D` / EOF stops early and keeps all answers so far); for a non-tie pick (`a` or `b`), prompts for an optional fault tag (`1` `"point buried"`, `2` `"too long"`, `3` `"unclear label"`, `4` `"other"`, or empty string for `null`).
  - Writes `picks.json` (`{ mode: "preference" | "calibration", seed, created, complete, answers: [{ id, move, scenario, property, shownA, pick, chose, choseHigher, tag }] }`). A legacy reader (`readLegacyHumanRun`) converts `eval-human.mjs`'s `result.json` (`item` -> `id`, `scenario` -> `item`) into this form without arithmetic.
  - **Lifecycle in `run-conductor.ts`:** `STATES` stays the 9-state array for automated runs (`validated` through `tallied`), and gains two optional post-judging states recorded in `record.states` when invoked: `"picked"` (entered by `pickRun(recordsDir, ...)` / `context-lab pick <pack> <run-dir>`, which runs the human panel on a judged run, writes `picks.json` in `recordsDir`, appends `{ state: "picked", at }`, and calls `tallyRun(recordsDir)`) and `"candidates-written"` (entered when `writeCandidates` runs). Existing runs that do not invoke `pickRun` or `writeCandidates` keep their exact 9-state list.
  - **Tally integration (`tally.ts`):** when `picks.json` exists in `recordsDir`, `tallyRun(recordsDir)` reads it and populates `result.humanPicks`:
    - for `preference` mode: `byMove[move] = { with, without, same, tags }` (where `tags` counts fault tags named when `chose === "with"`, matching `eval-human.mjs`) and `totals = { with, without, same }`;
    - for `calibration` mode: `agreement = { agree: choseHigherCount, of: nonTieCount, rate: nonTieCount ? choseHigherCount / nonTieCount : null }`, and when `rate !== null && rate < 0.75`, adds a warning to `RESULT.md`'s `Limits` section (`0004`).
- **Classify-then-verify judging chains (`packages/core/src/judging-chain.ts`).**
  - An experiment may declare `judging.chain: { findings: ChainFinding[], threshold?: { minScenarios: number; minHeldOut: number; minFamilies: number } }` (defaults `3`, `1`, `2`, from zorg `D1`), where `ChainFinding` is `{ id: string; kind: "named" | "computed" | "named or computed"; statement: string; countsWhen: string }`.
  - **Family assignment:** requires at least 3 distinct model families among the experiment's judges (refusing before any classifier runs if fewer than 3 families exist). In sorted family order `F_0, ..., F_{k-1}` ($k \ge 3$), outcomes of an agent in family `F_i` are classified by a judge of family `F_{(i + 1) mod k}` (`F_c != F_i`) and verified by a judge of family `F_{(i + 2) mod k}` (`F_v != F_i` and `F_v != F_c`), or by an explicit per-family map when declared.
  - **Stage 1 (classify) and code quote check:** the classifier receives only the masked outcomes and the `named` / `named or computed` finding definitions, with tools off, and returns `{ findings: Record<findingId, string>, new?: string[] }`. Before dispatching to stage 2 in a live run, a code check (`quoteInOutcome(quote, outcomeText)`) verifies that `words(quote)` has length between 1 and 25 and every word in `words(quote)` is in `new Set(words(outcomeText))`; quotes failing this check are recorded in `codeRejected` and not sent to stage 2.
  - **Stage 2 (verify):** each surviving `{ unit, findingId, quote }` is sent to the verifier of family `F_v` with tools off, which returns `{ supports: boolean, reason: string }`. All stage-1 and stage-2 records are written to `recordsDir/judging/chain.json`.
  - **Counting (`countChain`):** separated from the stage-1 dispatcher so it operates identically on live `chain.json` records and on legacy records where stage-2 verdicts already exist (`l-02`). For each finding `id`:
    - a `named` or `named or computed` quote counts if its stage-2 verdict has `supports === true` (if no verdict exists, it goes to `unverified`; if `supports === false`, to `rejected`);
    - a `computed` or `named or computed` finding also counts for a cell when that cell's `codeScores` has an entry with `property === id` and `value > 0` (`source: "computed"`);
    - `summarise(ev)` deduplicates readers by cell/reader id (`readers = new Set(ev.map(e => e.pid)).size`), scenarios/briefs (`scenarios = [...new Set(ev.map(e => e.scenario))]`), held-out scenarios (`heldOut = scenarios.filter(...)`), and families (`families = [...new Set(ev.map(e => e.family))]`, so multiple readers of one family count once). Both overall counts and `namedOnly` counts (filtering `source === "named"`) are reported per finding, with `meets = scenarios.length >= minScenarios && heldOut.length >= minHeldOut && families.length >= minFamilies`. Stored in `result.chain` by `tallyRun`.
- **Candidate writer (`packages/core/src/candidate-writer.ts`).**
  - Evaluates a run's `Result` and `LoadedPack` against four rules (customisable via `pack.findingRules`):
    1. `all-guided-fail`: an `adherence` property where every guided arm (an arm with `deliver.length > 0` in `pack.arms`) has `of > 0` and normalised pass rate `(mean - low) / (high - low) === 0`;
    2. `wrong-firing`: a `precision` property where any guided arm has `of > 0` and normalised fail rate `1 - (mean - low) / (high - low) > 0.25`;
    3. `knows-not-acts`: a `guidance` id in `result.link` whose `pairs`-weighted `metNot` rate across guided arms (`sum(row.metNot * row.pairs) / sum(row.pairs)` over rows for that `guidance` in guided arms) is strictly greater than `0.5`;
    4. `chain-threshold`: a finding in `result.chain.rows` with `meets === true`.
  - Writes `CANDIDATES.json` and `CANDIDATES.md` in `recordsDir` (and when called via `writeRunCandidates(packDir, recordsDir)` / `context-lab candidates <pack> <run-dir>`, appends `{ state: "candidates-written", at }` to `run.json`), never modifying any file outside `recordsDir`.
- **On-demand multi-model review runner (`B18`, `packages/core/src/review-panel.ts`, CLI `context-lab review`).**
  - Command: `context-lab review <pack> --prompt <file> [--files <path,...>] --out <dir> [--members <id,...>] [--verify] [--parallel <N>]`.
  - Selects population members from the pack (by default the first member of each distinct `family` in `pack.population`, or `--members`; refuses if fewer than 2 families are selected).
  - Runs each reviewer member in an isolated sandbox: any `--files` are copied into a read-only workspace (`0o555`/`0o444`, network denied, writes outside the invocation scratch denied), and the prompt instructs the reviewer to include a JSON findings block (`[{"id": "<slug>", "severity": "blocking" | "should-fix" | "minor", "title": "...", "evidence": "...", "fix": "..."}]`) alongside its prose.
  - When `--verify` is passed, for each distinct family `F_v` among the selected reviewers, one verifier member of family `F_v` checks all findings proposed by other families (`F_v != F_r`), receiving the same prompt/files and the list of findings from other families and returning for each finding `{"item": "<member>:<id>", "supports": boolean, "reason": "..."}`.
  - **Deterministic family agreement:** for each finding, `supportingFamilies` is the set of distinct model families across the proposer (`F_r`) and every verifier that returned `supports: true` (so two members of the same family count as 1 family). Writes `REVIEW.json` and `REVIEW.md` in `--out` with every model's full raw reply, extracted findings, verification verdicts, `supportingFamilies`, and `familyCount`.
- **zorg's project pack (`zorg/evals/context-lab/`) and retirement of duplicated runners (`M3.2`).**
  - Pack in `zorg/evals/context-lab/` declaring zorg's sources, its `census-corpus` variant-transform hook (assembling the component visions/contracts and stripping `capability-overlaps.md` lines as `build-census-corpus.mjs` does), its `composition-check` outcome-measure hook (extracting Y1/Y4, running `tools/check-capabilities.mjs`, and returning `codeScores` for `L1` and `L8`), its 13 composition-census scenarios (2 held out: `agent-memory`, `feature-flags`), and its 26 findings (`L1`-`L26`).
  - Legacy parity reader (`readZorgLegacyRun`) reading `zorg-eval-runs/runs/l-02` (`sealed/manifest.json`, `classify/classify-*.jsonl`, `verify/verify-*.items.json` and `verify-*.jsonl`, `AGGREGATE.json`, and `census-findings.json`) and feeding `countChain` to reproduce `l-02/FINDINGS-COUNT.json` across all 26 findings with zero mismatches.
  - **Retirement disposition (explicit and binary):**
    - Deleted in `mission-kit`: `tools/adherence.mjs`, `tools/eval-human.mjs`, and `tools/eval-human.test.sh`, with their sections removed from `tools/README.md` (and noted in `docs/ARCHITECTURE.md` via `generate-architecture.mjs`). `mission-kit/tools/eval.mjs` and `tools/eval.test.sh` are **kept** until mission-kit's ~20 historical per-entry comprehension suites (`docs/evals/<entry>/suite.json`) are migrated or archived under mission-kit's own board (`B80`); `B1` in `context-lab/docs/BACKLOG.md` records that `eval.mjs`'s mechanism is absorbed in `context-lab` (proven in Delta-1 E8/E11) while the script file in `mission-kit` stays only for those legacy suite folders.
    - Deleted in `zorg`: `evals/tools/run-agents.mjs`, `evals/tools/classify-findings.mjs`, and `evals/tools/count-findings.mjs` (replaced by `zorg/evals/context-lab/`). `zorg/evals/tools/extract-compositions.mjs`, `aggregate-census.mjs`, `replay-compare.mjs`, `build-census-corpus.mjs`, and `build-corpora.mjs` are **kept** in `zorg`: `extract-compositions.mjs` and `build-census-corpus.mjs` are called by the pack's hooks, and `replay-compare.mjs` is zorg's component-set dry-replay tool.

---

## 2. Build order - certifiable stages

Each stage lands with its own tests, and its criteria are green, before the next depends on it.

1. **People (`M3.1a`).** Pair chooser (preference and calibration pairs), human panel (`picked` state, `context-lab pick`, early stop, fault tags, judge-person agreement in tally), and parity against mission-kit's recorded `delta2-check` human run. Criteria G1, G2, G3.
2. **Chains and candidates (`M3.1b`).** Classify-then-verify judging chains (3-family assignment, stage-1 code quote check, stage-2 verification, `countChain` with `namedOnly` and combined counts) and the candidate writer (`CANDIDATES.json` and `CANDIDATES.md`, `candidates-written` state). Criteria G4, G5, G6.
3. **Target architecture update and on-demand multi-model review (`B18`).** Absorb `0025`/`B18` into `docs/ARCHITECTURE-TARGET.md`; build `review-panel.ts` and `context-lab review`, with cross-family verification and a live 3-family review run. Criteria G7, G8.
4. **Second user and retirement (`M3.2`).** zorg's pack in `zorg/evals/context-lab/`, parity against zorg's `l-02` run across all 26 findings, a live run of a zorg scenario on the core, deletion of the five duplicated runners in mission-kit and zorg, and all repository gates green. Criteria G9, G10, G11, G12.

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven, by criterion | Deferred, to board item |
|---|---|---|
| `0002` human preference judging | G1, G2, G3 | - |
| `0002` classify-then-verify judging chains | G4, G5, G9, G10 | - |
| `0004` calibration pairs over-sampled where judges scored high; 0.75 agreement check | G1, G2 | - |
| `0004` candidate findings written from results | G6 | - |
| `0006`, `0025` all 22 components of `ARCHITECTURE-TARGET.md` section 5 built | G1-G8 | - |
| `0025` / `B18` on-demand multi-model review orchestration | G7, G8 | - |
| `0001` / `B1`, `B11` second user (zorg) on the core and duplicated runners retired | G9, G10, G11, G12 | - |
| Failure injection (`B4`), filter characterisation (`B7`), per-property arm-guess test (`B5`) | - | M4.1, M4.2, M4.3 |

---

## 4. Verification targets

- Behaviour tests for pair chooser, human panel, classify-then-verify chains, candidate writer, and review panel, with every refusal and threshold boundary mutation-tested.
- Parity tests against mission-kit's recorded human run (`delta2-check-2026-10-03-66f8fb`) and zorg's recorded census run (`l-02`, 78 readers, 26 findings `L1`-`L26`).
- Live multi-model review run (`context-lab review --verify`) across at least three model families.
- Live run of one scenario of zorg's pack on the core across at least three model families.

---

## 5. Binary exit criteria

Evaluated by an agent that built none of the code the criterion exercises, holding verifier authority.

| # | Stage | Criterion |
|---|---|---|
| G1 | 1 | Given a fixture run with known judge scores across two scenarios and two arms, `chooseCalibrationPairs` returns only pairs `(u1, u2)` from the same scenario, arm, phase and property whose judge means differ, orders every pair with `max(m1, m2) >= midpoint` ahead of every pair with `max(m1, m2) < midpoint`, sets `shownA` by `flipFor(seed, pair.id)`, and repeats identically for the same seed; `choosePreferencePairs` sets `shownA` equal to `flipFor(seed, item.id)` for every item. |
| G2 | 1 | Given scripted stdin lines (`a`, `b`, `=`, invalid inputs retried, fault tags `1`-`4` and empty, and early EOF), `runHumanPanel` / `pickRun` writes `picks.json` with `complete: false` on early EOF and `true` on full completion, appends state `"picked"` to `run.json`, never writes arm names or judge scores to stdout, and `tallyRun` re-tallies `picks.json` into `Result.humanPicks`: reporting per-move counts and fault tags (on `chose === "with"`) for preference pairs, and exact `choseHigher / nonTiePicks` agreement for calibration pairs with a `RESULT.md` limit warning when `rate < 0.75`. |
| G3 | 1 | Converting mission-kit's recorded human preference run (`delta2-check-2026-10-03-66f8fb/result.json`) via `readLegacyHumanRun` and tallying it reproduces `{ with: 1, without: 0, same: 0 }` for each of its 6 moves and `{ with: 6, without: 0, same: 0 }` in `totals`. |
| G4 | 2 | In `runJudgingChain` over a population of at least 3 families, no classifier is assigned an outcome of its own family (`F_c != F_i`), and no verifier is assigned an item whose reader family or classifier family equals the verifier's (`F_v != F_i` and `F_v != F_c`); a judge pool with fewer than 3 families is refused before any call; in stage 1, a classified quote whose `words(quote)` is empty, exceeds 25 words, or contains a word absent from `new Set(words(outcome))` is recorded in `codeRejected` and not sent to stage 2. |
| G5 | 2 | On a fixture with `named`, `computed`, and `named or computed` findings across held-out and non-held-out scenarios and three families, `countChain` counts only verifier-supported (`supports: true`) named evidence and `value > 0` code-score computed evidence, deduplicates multiple hits from one reader or one family in a scenario, reports both overall and `namedOnly` summaries, and sets `meets = true` if and only if `scenarios.length >= minScenarios && heldOut.length >= minHeldOut && families.length >= minFamilies`. |
| G6 | 2 | Given a fixture `Result` (with `link` and `chain`) and `LoadedPack`, `writeCandidates` emits a candidate for each of the four rules (`all-guided-fail`, `wrong-firing` on scale-normalised fail rate `> 0.25`, `knows-not-acts` on `pairs`-weighted guided `metNot > 0.5`, and `chain-threshold` on `meets === true`) when and only when the condition holds, writes `CANDIDATES.json` and `CANDIDATES.md` in `recordsDir`, appends `"candidates-written"` to `run.json` when called via `writeRunCandidates`, and modifies no file outside `recordsDir`. |
| G7 | 3 | `docs/ARCHITECTURE-TARGET.md` sections 2, 3, 5, 6 and 9 are updated for `0025`/`B18`; `context-lab review` refuses fewer than 2 families, runs each reviewer in a sandbox with `--files` mounted read-only and network/writes denied, parses structured JSON findings, runs cross-family verification (`F_v != F_r`) when `--verify` is passed, computes `supportingFamilies` as the distinct families of the proposer plus supporting verifiers (counting same-family members once), and writes `REVIEW.json` and `REVIEW.md`. |
| G8 | 3 | A live `context-lab review --verify` run across at least three model families on a real repository file completes with every model's raw reply, extracted findings, cross-family verification verdicts, and `supportingFamilies` recorded in `REVIEW.json`. |
| G9 | 4 | `zorg/evals/context-lab/` passes `context-lab check`, and feeding zorg's recorded run `l-02` (`/home/apnex/taceng/zorg-eval-runs/runs/l-02`, 78 readers, 13 briefs, 26 findings `L1`-`L26`) through `readZorgLegacyRun` and `countChain` reproduces `l-02/FINDINGS-COUNT.json`'s `readers`, `briefs` (`scenarios`), `heldOut`, `families`, `namedOnly`, `rejected`, `unverified`, and `meets` for all 26 findings (`L1`-`L26`) with zero mismatches. |
| G10 | 4 | A live run of one scenario of `zorg/evals/context-lab/` on the core across at least three model families completes through `executed`, `measured` (running `check-capabilities.mjs` via the outcome-measure hook), `blinded`, `judged` (classify-then-verify chain), and `tallied`, with every probe passing and every cell valid or invalid with a cause. |
| G11 | 4 | `mission-kit/tools/adherence.mjs`, `mission-kit/tools/eval-human.mjs`, `mission-kit/tools/eval-human.test.sh`, `zorg/evals/tools/run-agents.mjs`, `zorg/evals/tools/classify-findings.mjs`, and `zorg/evals/tools/count-findings.mjs` are deleted (`!fs.existsSync`), `mission-kit/tools/README.md` and `docs/ARCHITECTURE.md` are updated, and `mission-kit/tools/check-all.sh --no-network` and `zorg`'s `npm test && ./tools/check-docs.sh` exit 0. |
| G12 | 4 | In `context-lab`, `npm test` (`tsc -b` with `strict` enabled and `node --test`) and `node /home/apnex/taceng/mission-kit/tools/check-board.mjs --root /home/apnex/taceng/context-lab` exit 0, with `B1`, `B11` and `B18` closed in `docs/BACKLOG.md`. |

---

## 6. Named costs and non-claims

- **Code quote check is surface-level, and applies between stage 1 and stage 2.** Checking that `words(quote)` is 1-25 words and a subset of `words(outcome)` catches fabricated words and over-long quotes before spending verifier calls; it does not check whether the quote supports the finding in context, which is the stage-2 verifier's job. When counting already-verified legacy records (`l-02`), recorded stage-2 verifier verdicts stand (`G9`).
- **On-demand review agreement is measured through `--verify`.** Without `--verify`, each model's extracted findings are listed under its own family (`familyCount: 1`); cross-family agreement (`familyCount >= 2`) is claimed only when a verifier of another family returns `supports: true` on that finding (`G7`, `G8`).
- **Live zorg run is one scenario.** `l-02` already ran 78 readers across all 13 briefs; G9 proves exact parity on all 78 readers and 26 findings, and G10 proves the live pipeline end-to-end on one brief rather than re-spending 78 readers.
- **`mission-kit/tools/eval.mjs` and `zorg`'s composition-helper scripts stay for their local callers.** `eval.mjs` is kept in `mission-kit` until its ~20 historical per-entry comprehension suites (`docs/evals/<entry>/suite.json`) are migrated or retired under `mission-kit` `B80`; `zorg/evals/tools/extract-compositions.mjs`, `build-census-corpus.mjs`, `aggregate-census.mjs`, `replay-compare.mjs`, and `build-corpora.mjs` stay in `zorg` as the domain scripts its pack hooks and dry-replay workflow call.

---

## 7. The anti-scope fence

This delta does not build or change:

- a web or GUI interface for the human panel or review runner - both are CLI / stream-based;
- automatic editing of a project's `BACKLOG.md` or `BOARD.md` by the candidate writer (`P9`, non-goal 3);
- migration of mission-kit's ~20 historical one-off comprehension suites (`B80`) or zorg's `seams*`/`compose*` pilot suites;
- milestone M4's hardening items (`B4` failure injection, `B7` filter characterisation, `B5` per-property arm-guess test);
- any change to the pack schema version (`context-lab.pack/1` stays backward-compatible via optional fields).

---

## Record

**Stage 1 (`M3.1a`).**\
Built `packages/core/src/pair-chooser.ts` (`flipFor`, `choosePreferencePairs`, `chooseCalibrationPairs`), `packages/core/src/human-panel.ts` (`runHumanPanel`, `readLegacyHumanRun`, `tallyHumanPicks`), `pickRun` (`context-lab pick`) in `run-conductor.ts`, and `humanPicks` integration in `tally.ts` (including the `< 0.75` calibration agreement limit warning).\
Verification evaluated G1, G2 and G3 PASS; all three minor findings from verification (tests for `M3`, `M11`, `M15`, EOF on the tag prompt, and empty-string `final` check in `pickRun`) are fixed and mutation-tested (15 of 15 mutants killed).\
314 tests; stage 1 is complete.

**Stage 2 (`M3.1b`).**\
Built `packages/core/src/judging-chain.ts` (`assignChainJudges`, `quoteInOutcome`, `runJudgingChain`, `countChain`), `packages/core/src/candidate-writer.ts` (`evaluateCandidates`, `writeCandidates`, `writeRunCandidates`), `judging.chain` and `pack.findingRules` validation in `pack-schema.ts` and `pack-checker.ts`, `chain` integration in `run-conductor.ts` and `tally.ts`, and `context-lab candidates` in `cli.ts`.\
Verification evaluated G4, G5 and G6 PASS; all three minor findings from verification (adding `L10` in `chain-candidates.test.ts` to kill mutant `M13` on `minHeldOut`, using `assignChainJudges` for stage-2 verifier selection, and keying verdicts with `unit` when present) are fixed and mutation-tested (22 of 22 mutants killed).\
317 tests; stage 2 is complete.

**Stage 3 (`B18`).**\
Reopened and updated `docs/ARCHITECTURE-TARGET.md` sections 2, 3, 5, 6 and 9 under section 1's triggers (`0025`, `0026`, `B18`, **Review panel** as the 22nd component); built `packages/core/src/review-panel.ts` (`selectReviewMembers`, `parseReviewFindings`, `runReview`, `reviewMarkdown`) and `context-lab review` in `cli.ts`.\
Dogfooded live across all four model families (`c` Claude Opus 5.5, `a` Gemini 4 Argon, `x` Grok 4.20, `o` GPT) with `--verify` on `review-panel.ts` and `DELTA-3.md` (`mission-kit/docs/evals/runs/context-lab/2026-10-16-review-g8`, 13 findings across all 4 families), and applied the improvements the 4-family review surfaced (collision-free duplicate-id suffixing, deterministic sorting of concurrent verifier verdicts, fenced-block priority over bracket fallback, and aligning Section 1's wording with all-other-family verification).\
318 tests; 4 stage-3 mutants applied and killed.\
Verification evaluated G7 and G8 PASS; both minor findings from verification (removing default `~/context-lab-work/review-*` scratch directories in `finally` and listing `review` flags in `cli.ts`'s `usage` string) are fixed.\
Stage 3 is complete.

**Stage 4 (`M3.2`).**\
Built `zorg`'s project pack in `zorg/evals/context-lab/` (`pack.json`, `experiments/census.json`, 13 brief scenarios including held-out `agent-memory` and `feature-flags`, `hooks/census-corpus.mjs`, and `hooks/composition-check.mjs`), extended `variant-builder.ts` and `code-measurer.ts` so pack-declared source paths are bound read-only inside hook sandboxes, and built `readZorgLegacyRun` in `packages/core/src/judging-chain.ts`.\
Parity check (`G9`, in `packages/core/test/chain-candidates.test.ts`): `readZorgLegacyRun` + `countChain` on `/home/apnex/taceng/zorg-eval-runs/runs/l-02` compared 289 values (`readers`, `briefs`, `heldOut`, `families`, `namedOnly`, `meets`, `rejected`, `unverified`, `unclassified`, `news.length`) across all 26 findings (`L1`-`L26`) against `l-02/FINDINGS-COUNT.json` with 0 mismatches.\
Live run (`G10`, `zorg/evals/runs/context-lab/2026-10-17-021542-census`): ran suite `census-zorg` across all 5 members (4 model families: `c`, `a`, `f`, `x`, `o`), completing through `validated`, `recorded`, `built`, `probed` (5/5 agent probes, 4/4 judge probes passed), `executed` (5/5 valid cells), `measured` (`composition-check` hook running `tools/check-capabilities.mjs`), `blinded`, `judged` (classify-then-verify chain across 4 families, 13 finding rows), and `tallied`.\
Retired (`G11`, `G12`): deleted `mission-kit/tools/adherence.mjs`, `mission-kit/tools/eval-human.mjs`, `mission-kit/tools/eval-human.test.sh`, `zorg/evals/tools/run-agents.mjs`, `zorg/evals/tools/classify-findings.mjs`, and `zorg/evals/tools/count-findings.mjs`; updated `mission-kit/tools/README.md`, `mission-kit/docs/ARCHITECTURE.md`, and `zorg/evals/composition-census.md`; closed `B77` in `mission-kit/docs/BACKLOG.md` and `B1`, `B11`, `B18` in `context-lab/docs/BACKLOG.md`.\
319 tests.

---

## Adversarial review

**Reviewer.**\
A fresh agent (`ses_eb90bbd3efferMzXAiRxYi6bDl`) that did not draft this delta, with read access to `context-lab`, `mission-kit`, `zorg`, and `zorg-eval-runs`, and no edits.

**Verdict on revision 1.**\
Ratify after fixes (5 blocking, 3 should-fix, 1 minor). All 9 findings are resolved in revision 2; re-checked by the same reviewer with verdict **ratify as is**:

| # | Severity | Finding | Disposition in revision 2 |
|---|---|---|---|
| F1 | blocking | `l-02` has 1 supported quote (`r-1b694e` on `L3`, `"manual"` vs `"manuals"`) that fails `words()` and 8 quotes over 25 words; G4's pre-verification code filter would break G9's zero-mismatch parity on `l-02/FINDINGS-COUNT.json`, and the `words()` predicate was unstated | Separated stage-1 pre-verification filtering (`quoteInOutcome`: 1-25 words, every word in `new Set(words(outcome))`, recorded in `codeRejected`) from `countChain`, which counts stage-2 verdicts (`supports === true`) and reproduces `l-02/FINDINGS-COUNT.json` with 0 mismatches (Section 1, Section 6, G4, G5, G9) |
| F2 | blocking | `B18` (`review-panel.ts` / `context-lab review`) was outside `docs/ARCHITECTURE-TARGET.md` sections 2, 5, 6 and 7 | Added explicit reopening and update of `docs/ARCHITECTURE-TARGET.md` sections 2, 3, 5, 6 and 9 under section 1's triggers to absorb `0025`/`B18` as the 22nd component, **Review panel** (Frontmatter, Section 0, Section 1, Stage 3, G7) |
| F3 | blocking | Section 0 and `B1` named `mission-kit/tools/eval.mjs`, while G11 omitted it; "replaced by thin forwarders or removed" was non-binary; disposition of `zorg/evals/tools/*` and `mission-kit` `B80` was unstated | Made G11 binary (`!fs.existsSync` on the 6 deleted files, `tools/README.md` and `docs/ARCHITECTURE.md` updated, both repos' gates exit 0) and stated the exact disposition of `eval.mjs` (`B80`) and `zorg`'s helper scripts in Section 1, Section 6 and Section 7 |
| F4 | blocking | Integration of `picked`, `judging-chain`, and `candidates-written` with `STATES` in `run-conductor.ts` and `tallyRun` re-tallying was unspecified | Specified that `STATES` keeps the 9 automated states, `pickRun` (`context-lab pick`) and `writeRunCandidates` (`context-lab candidates`) append `"picked"` and `"candidates-written"` when invoked, and `tallyRun` re-tallies `picks.json` into `Result.humanPicks` and `judging/chain.json` into `Result.chain` (Section 1, G2, G5, G6) |
| F5 | blocking | In `delta2-check-2026-10-03-66f8fb/result.json`, each of the 6 items has a distinct `move` (`1 with` per move, `6 with` total across moves), uses `"item"` instead of `"id"`, and counts fault tags on `chose === "with"` | Added `readLegacyHumanRun` mapping `item` -> `id`, specified fault-tag counting on `chose === "with"`, and updated G3 to check `{ with: 1, without: 0, same: 0 }` on each of the 6 moves and `{ with: 6, without: 0, same: 0 }` in `totals` (Section 1, G2, G3) |
| F6 | should-fix | Calibration pair ordering/shuffling under `<seed>:calibration` and candidate-writer rules (`all-guided-fail`, `wrong-firing` scale normalisation, `knows-not-acts` over `LinkRow`s) allowed two implementations to disagree | Specified the exact calibration pair enumeration, midpoint partition, `<seed>:calibration` shuffle, and `flipFor` order, and the exact normalised/weighted formulas for all four candidate rules (Section 1, G1, G6) |
| F7 | should-fix | Mapping `codeScores` to `computed` / `named or computed` findings (`L1`, `L8`), reader deduplication, and `namedOnly` / `briefs` vs `scenarios` naming needed explicit specification | Specified `codeScores` (`property === id && value > 0`) -> `{ source: "computed" }`, reader/scenario/family deduplication, `namedOnly` output, and `briefs`/`scenarios` mapping in `countChain` and `readZorgLegacyRun` (Section 1, G5, G9) |
| F8 | should-fix | `context-lab review` left finding extraction and cross-family agreement counting underspecified | Specified the JSON finding block schema, cross-family verifier assignment (`F_v != F_r`), and `supportingFamilies` as proposer family union supporting verifier families, counting same-family members once (Section 1, Section 6, G7, G8) |
| F9 | minor | Missing exit criterion for `context-lab`'s own `npm test` (`tsc -b` + `node --test`) and `check-board.mjs --root` gate | Added criterion G12 (Section 5) |
