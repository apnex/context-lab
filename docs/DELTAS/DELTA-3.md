# Delta-3 - people, chains, on-demand review, and the second user - a vertical slice

```yaml
status:     draft - revision 1, for adversarial review
selected:   docs/DECISIONS.md 0025, board items M3.1, M3.2
from-state: Delta-2's to-state (0024): multi-phase episodes, diagnostic measures, threshold deriver, comparator, run resumption
to-state:   docs/ARCHITECTURE-TARGET.md (0006), all 21 components of section 5, plus on-demand multi-model review (B18)
rows:       docs/BACKLOG.md B1, B11, B18
```

---

## 0. From-state -> to-state

**From.**\
Eighteen of the target architecture's twenty-one components are built (`0017`, `0024`).\
The core cannot choose outcome pairs for a person, collect a person's picks, run a classify-then-verify judging chain, write candidate findings from a result, or orchestrate several models of different families on an on-demand review task (`B18`).\
zorg's evaluation mechanisms still live in `zorg/evals/tools/` (`B1`, `B11`), and mission-kit's and zorg's duplicated evaluation tools (`tools/adherence.mjs`, `tools/eval.mjs`, `tools/eval-human.mjs`, `evals/tools/run-agents.mjs`, `evals/tools/classify-findings.mjs`) are not yet retired.

**To.**\
All twenty-one components of the target architecture (`docs/ARCHITECTURE-TARGET.md` section 5) are built, together with an on-demand multi-model review runner (`B18`).\
zorg has a project pack (`zorg/evals/context-lab/`), verified for parity against its recorded `l-02` census run and run live on the core; mission-kit's human preference suites and zorg's evaluations run on context-lab, and the duplicated tools in both projects are retired (`B1`, `B11`, `B18` closed).

---

## 1. The fence

This delta builds the remaining three components of `docs/ARCHITECTURE-TARGET.md` section 5, the `picked` and `candidates written` states of section 7, the on-demand multi-model review runner (`B18`), zorg's pack, and the retirement of the duplicated tools:

- **Pair chooser (`packages/core/src/pair-chooser.ts`).** Two declared rules:
  1. **Preference pairs:** given two arms (`with` and `without`), pairs each scenario's outcomes from the two arms for the same member and run, or from a static item list `{ id, move, scenario, with, without }`, randomising display order (`A` vs `B`) per pair from `<seed>:<pairId>` with the blinder's SHA-256 bit flip (`parseInt(sha256(seed:id).slice(0, 2), 16) % 2 === 1`).
  2. **Calibration pairs (`0004`, mission-kit `0085`):** from one run's judged outcomes, chooses up to `count` (by default 8) pairs `(u1, u2)` within the same scenario and arm whose judge-mean scores on a property differ (`mean(u1) !== mean(u2)`). Pairs where at least one outcome was scored at or above the scale's midpoint (`>= (low + high) / 2`) are ordered ahead of pairs where both scored below the midpoint (over-sampling where judges scored high, as section 5 of the target architecture states), with deterministic selection seeded by `<seed>:calibration`.
- **Human panel (`packages/core/src/human-panel.ts`) and the `picked` state.**
  - Presents each pair `(A, B)` to a person over an input/output stream (terminal or pipe) without revealing which arm or score each side came from, accepts `a`, `b`, or `=` (with `Ctrl-D` / EOF stopping early while keeping all picks made so far), and for a non-tie pick optionally records one fault tag (`1` point buried, `2` too long, `3` unclear label, `4` other).
  - Writes `picks.json` (`{ seed, created, complete, answers: [{ id, move?, scenario, property?, unitA?, unitB?, shownA, pick, chose, tag }] }`).
  - Tally integration: for preference pairs, reports per-move counts (`with`, `without`, `same`) and fault tags; for calibration pairs, computes **judge-person agreement** as the fraction of non-tie picks where the person chose the outcome with the higher judge mean (`choseHigher / nonTiePicks`), and flags in `limits` when agreement is below `0.75` (`0004`).
- **Classify-then-verify judging chains (`packages/core/src/judging-chain.ts`).**
  - A scenario or experiment may declare `chain` judging with a fixed list of `findings: { id, kind: "named" | "computed" | "named or computed", statement, countsWhen }[]` and a threshold rule `{ minScenarios: number, minHeldOut: number, minFamilies: number }` (by default `3`, `1`, `2`, from zorg `D1`).
  - **Stage 1 (classify):** each valid outcome of a reader in family `F` is assigned to a classifier member from a family `F_c != F`. The classifier receives only the masked outcomes and the finding definitions, with tools off, and returns `{ findings: Record<findingId, quote>, new?: string[] }` where each quote is at most 25 words from the outcome. A quote whose words do not appear in the outcome (checked by code via `words()` from `measures.ts`) is rejected by code before stage 2.
  - **Stage 2 (verify):** each surviving `{ unit, findingId, quote }` from reader family `F` and classifier family `F_c` is assigned to a verifier member from a third family `F_v` (`F_v != F` and `F_v != F_c`). The verifier receives the outcome, the finding definition, and the quote, with tools off, and returns `{ supports: boolean, reason: string }`.
  - **Counting:** only evidence where `supports === true` (plus any code-measured `computed` findings from the cell's `codeScores`) counts. A family counts once per scenario (`brief`) however many of its readers repeat the finding. The tally reports per finding: `readers`, `scenarios`, `heldOut`, `families`, `rejected`, `unverified`, and `meets` (`scenarios.length >= minScenarios && heldOut.length >= minHeldOut && families.length >= minFamilies`).
- **Candidate writer (`packages/core/src/candidate-writer.ts`).**
  - Evaluates a run's `Result` (and optional chain counts) against the pack's declared `findingRules` (or the default standing rules of `0004`):
    1. `all-guided-fail`: an adherence property whose pass rate is `0` in every guided arm;
    2. `wrong-firing`: a precision property whose fail rate (`1 - mean`) exceeds a threshold (by default `0.25`) in any guided arm;
    3. `knows-not-acts`: a guidance entry in the `link` table whose `metNot` rate exceeds `0.5`;
    4. `chain-threshold`: a classify-then-verify finding with `meets === true`.
  - Writes `CANDIDATES.json` and `CANDIDATES.md` in the run directory, each candidate carrying its rule id, the property/entry/finding id, the measured numbers and cells as evidence, and a draft backlog row with a revival trigger - never editing the project's `BACKLOG.md` itself (non-goal 3, P9).
- **On-demand multi-model review runner (`B18`, `packages/core/src/review-panel.ts`, CLI `context-lab review`).**
  - Command: `context-lab review <pack> --prompt <file> [--files <path,...>] [--members <id,...>] [--verify] [--out <dir>]`.
  - Runs an arbitrary review, audit, or verification prompt across the selected population members (by default one member per model family in the pack), each in an isolated read-only sandbox (tools off if all input files are attached/inlined, or read-only workspace copy of `--files` with write/network denied).
  - Parses structured findings from each model's reply, groups findings by family, and when `--verify` is passed, runs a cross-family verification pass where each model's findings are checked by a model of another family.
  - Writes a self-contained packet (`REVIEW.json` and `REVIEW.md` in `--out`) with per-family findings, cross-family agreement count (treating same-family agreement as one measurement), and unresolved single-family findings for the director or author.
- **zorg's project pack (`zorg/evals/context-lab/`) and retirement (`M3.2`).**
  - Pack declaring zorg's sources (`zorg`, `agp`, `mission-kit`, `operation-call`, `entity-store`, `entity-api`, `shape-check`), its `census-corpus` variant transform hook (stripping `capability-overlaps.md` pointers), its `composition-check` outcome-measure hook (wrapping `tools/check-capabilities.mjs`), its 13 composition-census scenarios (2 held out: `agent-memory`, `feature-flags`), and its 26 findings (`L1`-`L26`).
  - Legacy parity reader converting zorg's recorded run `l-02` (`zorg-eval-runs/runs/l-02`) into core inputs and proving exact parity on all 26 finding counts (`FINDINGS-COUNT.json` and `LEDGER.md`).
  - Retirement of duplicated scripts: `mission-kit/tools/adherence.mjs`, `mission-kit/tools/eval-human.mjs`, `zorg/evals/tools/run-agents.mjs`, `zorg/evals/tools/classify-findings.mjs`, and `zorg/evals/tools/count-findings.mjs` (replaced by thin forwarders or removed with docs updated, per each project's gate).

---

## 2. Build order - certifiable stages

Each stage lands with its own tests, and its criteria are green, before the next depends on it.

1. **People (`M3.1a`).** Pair chooser (preference and calibration pairs), human panel (`picked` state, early stop, fault tags, judge-person agreement in tally), and parity against mission-kit's recorded `delta2-check` human run. Criteria G1, G2, G3.
2. **Chains and candidates (`M3.1b`).** Classify-then-verify judging chains (3-family assignment, code quote-presence check, stage-2 verification, per-scenario/held-out/family threshold counting) and the candidate writer (`CANDIDATES.json` and `CANDIDATES.md`). Criteria G4, G5, G6.
3. **On-demand multi-model review (`B18`).** `review-panel.ts` and `context-lab review`, with cross-family verification and dogfooded live across at least three model families. Criteria G7, G8.
4. **Second user and retirement (`M3.2`).** zorg's pack in `zorg/evals/context-lab/`, parity against zorg's `l-02` run across all 26 findings, a live run of a zorg scenario on the core, and retirement of the duplicated runners in mission-kit and zorg. Criteria G9, G10, G11.

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven, by criterion | Deferred, to board item |
|---|---|---|
| `0002` human preference judging | G1, G2, G3 | - |
| `0002` classify-then-verify judging chains | G4, G5, G9 | - |
| `0004` calibration pairs over-sampled where judges scored high; 0.75 agreement check | G1, G2 | - |
| `0004` candidate findings written from results | G6 | - |
| `0006` all 21 components of section 5 built | G1-G6 (completing the final 3 components) | - |
| `0025` / `B18` on-demand multi-model review orchestration | G7, G8 | - |
| `0001` / `B1`, `B11` second user (zorg) on the core and duplicated tools retired | G9, G10, G11 | - |
| Failure injection (`B4`), filter characterisation (`B7`), per-property arm-guess test (`B5`) | - | M4.1, M4.2, M4.3 |

---

## 4. Verification targets

- Behaviour tests for pair chooser, human panel, classify-then-verify chains, candidate writer, and review panel, with every refusal and threshold boundary mutation-tested.
- Parity tests against mission-kit's recorded human run (`delta2-check-2026-10-03-66f8fb`) and zorg's recorded census run (`l-02`, 78 readers, 26 findings).
- Live multi-model review run across at least three model families on the new endpoint + Codex.
- Live run of zorg's pack on the core.

---

## 5. Binary exit criteria

Evaluated by an agent that built none of the code the criterion exercises, holding verifier authority.

| # | Stage | Criterion |
|---|---|---|
| G1 | 1 | Given a fixture run with known judge scores across two scenarios and two arms, the pair chooser in calibration mode returns only pairs from the same scenario and arm whose judge means differ, orders pairs with at least one score at or above the scale's midpoint ahead of pairs where both are below, and repeats identically for the same seed; in preference mode, display order (`shownA`) equals `flipFor(seed, id)` for every item. |
| G2 | 1 | Given scripted stdin lines (`a`, `b`, `=`, invalid inputs retried, fault tags `1`-`4` and empty, and early EOF), the human panel writes `picks.json` with `complete: false` on early EOF and `true` on full completion, never shows arm names or judge scores in stdout, and the tally reports per-move counts for preference pairs and exact `choseHigher / nonTiePicks` agreement for calibration pairs, adding a limit warning when agreement `< 0.75`. |
| G3 | 1 | Reading mission-kit's recorded human preference run (`delta2-check-2026-10-03-66f8fb/result.json`) through the core's human-pick tally reproduces its exact per-move counts (`6` `with`, `0` `without`, `0` `same`). |
| G4 | 2 | In a classify-then-verify chain over a 3-family population, no classifier is assigned an outcome of its own family, and no verifier is assigned an item whose reader family or classifier family equals the verifier's; a population with fewer than 3 families is refused before any classifier runs; a classified quote whose words (by `words()`) do not appear in the outcome is rejected by code before verification. |
| G5 | 2 | On a fixture with named and computed findings across held-out and non-held-out scenarios and three families, only verifier-supported (`supports: true`) named evidence and code-measured computed evidence count; multiple readers of one family in one scenario count as one family; and `meets` is `true` if and only if `scenarios >= 3`, `heldOut >= 1`, and `families >= 2`. |
| G6 | 2 | Given a fixture `Result` (and chain summary), the candidate writer emits a candidate for each of the four rules (`all-guided-fail`, `wrong-firing > 0.25`, `knows-not-acts > 0.5`, `chain-threshold`) when and only when the threshold is met, writes `CANDIDATES.json` and `CANDIDATES.md` in the run folder, and modifies no file outside the run folder. |
| G7 | 3 | `context-lab review` runs a prompt and optional read-only file set across selected members of distinct families in isolated sandboxes (write and network denied), groups findings by family (counting same-family agreement as one family), runs cross-family verification when `--verify` is given, and writes `REVIEW.json` and `REVIEW.md`. |
| G8 | 3 | A live `context-lab review --verify` run across at least three model families on a real artifact completes with every model's raw reply, family attribution, and verification verdict recorded in `REVIEW.json`. |
| G9 | 4 | `zorg/evals/context-lab/` passes `context-lab check`, and feeding zorg's recorded run `l-02` (78 readers, 13 briefs, 26 findings `L1`-`L26`) through the core's classify-then-verify counter reproduces `l-02/FINDINGS-COUNT.json`'s `readers`, `briefs`, `heldOut`, `families`, `rejected`, `unverified`, and `meets` for all 26 findings (`L1`-`L26`) with zero mismatches. |
| G10 | 4 | A live run of one scenario of zorg's pack (`zorg/evals/context-lab/`) on the core across at least three families completes through `executed`, `measured` (running `check-capabilities.mjs` via the outcome-measure hook), `blinded`, `judged` (classify-then-verify chain), and `tallied`, with every probe passing and every cell valid or invalid with a cause. |
| G11 | 4 | The duplicated evaluation runners in mission-kit (`tools/adherence.mjs`, `tools/eval-human.mjs`) and zorg (`evals/tools/run-agents.mjs`, `evals/tools/classify-findings.mjs`, `evals/tools/count-findings.mjs`) are retired, and both repositories' gates pass. |

---

## 6. Named costs and non-claims

- **Code quote check is surface-level.** Checking that a classifier's quote words appear in the outcome catches fabricated quotes, not quotes taken out of context; context is what the stage-2 verifier checks.
- **On-demand review grouping.** Without a pre-declared finding list, grouping free-text findings across models in `context-lab review` relies on either structured headings in the prompt or the cross-family verifier pass; `REVIEW.json` always keeps every model's full raw reply alongside the grouped table (`A4`).
- **Live zorg run is one scenario.** `l-02` already ran 78 readers across all 13 briefs; G9 proves exact parity on all 78 readers and 26 findings, and G10 proves the live pipeline end-to-end on one brief rather than re-spending 78 readers.

---

## 7. The anti-scope fence

This delta does not build or change:

- a web or GUI interface for the human panel or review runner - both are CLI / stream-based;
- automatic editing of a project's `BACKLOG.md` or `BOARD.md` by the candidate writer (`P9`, non-goal 3);
- milestone M4's hardening items (`B4` failure injection, `B7` filter characterisation, `B5` per-property arm-guess test);
- any change to the pack schema version (`context-lab.pack/1` stays backward-compatible via optional fields).

---

## Record

*(To be populated as stages 1-4 are built and verified.)*

---

## Adversarial review

*(Pending review by an agent that did not draft this delta.)*
