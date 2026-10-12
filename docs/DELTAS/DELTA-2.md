# Delta-2 - multi-phase episodes and the change gate - a vertical slice

```yaml
status:     ratified (docs/DECISIONS.md 0019, amended 0020) - revision 3; stage 3 open
selected:   docs/DECISIONS.md 0018, board items M2.1, M2.2, M2.3
from-state: Delta-1's to-state (0017): one-phase experiments, isolation probed, judged, tallied
to-state:   docs/ARCHITECTURE-TARGET.md (0006), the parts fenced in section 1
rows:       docs/BACKLOG.md B1, B2, B3, B12
```

---

## 0. From-state -> to-state

**From.**\
The core runs an experiment of one phase in a new session, through to a tallied result.\
It cannot continue a session, give an agent a note from an earlier phase, compare two results, or say how large a difference must be before it is more than noise.

**To.**\
The core runs multi-phase episodes - phases starting a new session from a note, or continuing a session where the runtime supports it, with branches from one point - and compares two results under a declared rule, flagging and never deciding, with a threshold derived from runs of a condition against itself.\
It delivers the parts of `0004` Delta-1 deferred to this milestone: trap pairs rotated across positions, the comprehension-behaviour link, restated-guidance flags, the variation an experiment can detect stated before its outcomes, and held-out scenarios reported apart with their exposure recorded.

---

## 1. The fence

This delta builds:

- **Probes** of session continuation and of compaction on both driven runtimes, under the filesystem sandbox, recorded; and the adapter conformance cases extended for continuation, accepted by the verifier before any adapter changes, as Delta-1's stage 3 required.
- **Session continuation in the adapters** where the probe shows it works, keeping each invocation's session state in its own folder; an adapter declares `continue: true` or `false`.
- **The phase driver, multi-phase.** A scenario may declare its own phases, overriding the experiment's; the experiment's single phase stays the default, so existing packs remain valid. A phase starts a new session, or continues the previous phase's session where the member's adapter declares `continue: true`. A new session may be given a note: the agent's own - a file the previous phase wrote, or, if it wrote none, the text `(no note was written)` - or one made by the note-generator hook (`0005`). A branch point starts several phases from one state.
- **Episode rules.** The re-run unit is the whole episode: an episode is attempted again as one cell is, its attempts counted per episode, and `0012` counts open-step timeouts across all its phases. A phase invalid for behaviour ends the phases that follow from it, and their properties score the bottom of their scale, while phases on other branches run and are judged (amended by `0020`; it read "ends its episode, and properties of later phases score the bottom of their scale"); a phase invalid for any other cause makes the episode invalid for that cause.
- **Trap pairs and their rotation.** A scenario's traps may be declared as pairs of versions with the positions they may take. The rule, deterministic and independent of the run: for a cell's run index `r` (counting from 0), pair index `k`, member index `j` in the experiment's population, `P` positions and `V` versions, position = `positions[(r + k) mod P]` and version = `versions[(j + r) mod V]`. The assignment is recorded per cell.
- **Per-phase outcomes**, blinded, judged and tallied: each property may name the phase it is judged on, by default the last; and may declare `judgedWith`, the note or the starting state, shown to judges beside that phase's outcome. Nothing else of other phases reaches a judge.
- **The comprehension-behaviour link.** Per member, arm and guidance id: pair each episode's score on a comprehension property and on an adherence property both naming that id, each counted as met when at or above the midpoint of its scale; the four rates are the fractions of pairs that are met-and-met, met-and-not, not-and-met, and neither. A property naming several ids counts toward each.
- **Restated-guidance flags**, by code and diagnostic only: words are maximal runs of letters, digits and apostrophes after lowercasing, markdown dropped; a note or final message sharing twelve or more consecutive words with a file delivered to the arm as `instruction` or `folder-file` is flagged with both paths.
- **Stated variation.** An experiment declared `result` must state `variation: { difference, scope }` - the smallest difference in pass rate it means to detect, per property or pooled - and `default`, the decision taken when none is detected; `recordExperiment` refuses such an experiment without them, and both are covered by the register's hash. The result reports, per scope, the difference detectable at 80% power and 5% two-sided, `(1.96 + 0.84) * sqrt(2 p (1 - p) / n)`, with `p` the pooled rate and `n` the outcomes per arm, beside the stated difference.
- **Held-out scenarios**, reported only in their own section of a result and of a comparison and in no total. A project declares, by a command, that a named change was informed by a held-out scenario's outcomes; the register records it, append-only; later results and comparisons list that scenario as exposed to that change.
- **Gates as one run with two arms.** A change gate runs base and head as two arms of one run, as mission-kit's ratified standing-suite design states (its sections 8 and 10), so both meet the same provider at the same time; a variant may therefore declare its own `revision`, overriding the run's. An A/A run is one run with two arms delivering the same variant at the same revision (`0019`).
- **Words used below.** A *cell* is a scenario, an arm and a member; a *cell run* is one of its runs. A property's rate in an arm is its mean over that arm's outcomes, cell runs invalid for behaviour scored at the bottom of the scale and others excluded, as the tally already does.
- **The threshold deriver.** Its input is one A/A run: two identical arms, A and B, at nine runs per cell. For each scenario and member it pools the present cell runs of both arms - eighteen when none is excluded. A property's drop between two sets is standardised: `d = (rateA - rateB) / sqrt(2 p (1 - p) / n)`, `p` the property's rate over both sets together, `n` the outcomes per set, and `d = 0` where `p` is 0 or 1. For a size `k` of 3 or 9, with the generator the blinder uses seeded by the experiment's hash and `k`, it draws 1000 splits: for each, in sorted order of scenario and member, it shuffles that pool and takes the first `k'` runs as set A and the next `k'` as set B, where `k' = min(k, floor(n_pool / 2))`; every property uses the same split. Per split it takes the largest `d` over `m` properties - `m` declared by the comparison rule, by default every property the experiment holds. The threshold for size `k` is the nine-hundredth of the 1000 sorted largest values, and a drop flags only when strictly greater. It also reports, from nested splits whose first three runs per side form the size-3 sets, how often the two-stage rule below flags a persisting drop; and, as a drift check, where the actual arm A against arm B largest drop falls among the splits. It records `m`, the split count, the run id and both thresholds, and refuses a pool of fewer than twelve present runs.
- **A tally restricted to cell runs 1 to `k`**, so the first stage of the gate can read a nine-run record as a three-run one.
- **A `--revision` option** on the run command, so every run of one experiment can be pinned to one source revision.
- **The comparator.** Two arms of one result, or two results, under a declared rule: per-property tolerance, a property absent from the head or with no mean counted as a drop; the A/A rule - flag a property whose standardised drop exceeds the size-3 threshold, then, given results of base and head at nine runs supplied by the caller, report as persisting a flagged property whose drop at nine exceeds the size-9 threshold; or improve-without-worsening across families. It refuses inputs that differ in anything but the variant revisions under comparison - scenarios, population, runs per cell, trap assignment - and a threshold set whose `m` differs from the property count compared. Its output holds exactly `rule`, `inputs`, `flags`, `heldOut`, `exposed`, `limits`.
- **The note-generator hook**, under the hook contract.
- **Synthetic scenarios** for every new shape, in the synthetic pack.

**mission-kit's pack, by mission-kit's `0087`**, each change landing in stage 2 with the checker change it needs:

- a **handoff experiment**: work, then a new session from a note, testing whether a recorded decision's rationale survives the note - its fixture new, not the `A4` trap's; its key committed, then audited by an agent that did not write it, the audit written to `docs/evals/context-lab/audits/<experiment>-key.md` with the auditor, each finding and its disposition, and every correction applied before the experiment is recorded; F13 runs only on an audited key;
- an **A/A experiment**: the adherence suite's scenarios, two arms each delivering the on-trigger context, three families, nine runs per cell, declared `result`, recorded before F14;
- a **comparison rule** declaring the A/A rule and `m`;
- a **note-generator hook**, a script in mission-kit's repository;
- the **stated variation and default** for each of its experiments declared `result`, values chosen by the director;
- the register entries and threshold sets the runs write, under `register/`.

Built in TypeScript as Delta-1 was (`0009`).\
Each stage lands with its own tests, and its criteria green, before the next depends on it.

---

## 2. Build order - certifiable stages

1. **Probes and continuation.** Continuation and compaction probes on both runtimes; the conformance cases extended and accepted; continuation in the adapters where the probe shows it works. Criteria F1, F2.
2. **Episodes.** Schema additions; the phase driver with notes, the hook and branches; episode rules; trap pairs; per-phase outcomes through to the tally; mission-kit's pack changes written statically. Criteria F3, F4, F5, F6.
3. **Measures.** The link, restated-guidance flags, stated variation, held-out reporting and exposure in results. Criteria F7, F8, F9, F10's result clause.
4. **Comparison.** Threshold deriver and comparator, against fixtures. Criteria F10's comparison clause, F11, F12.
5. **Live.** The handoff experiment on all three families; one A/A pair setting thresholds; a fresh A/A pair checking them. Criteria F13, F14, F15.

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven, by criterion | Deferred, to board item |
|---|---|---|
| `0004` multi-phase episodes, notes generated from the workspace | F3, F4, F13 | - |
| `0004` trap pairs met once per episode, rotated | F5 | - |
| `0004` comprehension-behaviour link | F7, on fixtures; no live suite yet pairs comprehension and adherence on one entry | live data, when a suite does |
| `0004` restated-guidance flags; variation stated before outcomes | F8, F9 | - |
| `0004` held-out scenarios | F10 | - |
| `0004` comparison rules calibrated by A/A runs, flagging rather than deciding | F11, F12 prove the rules; F14, F15 exercise the calibration live | evidence that the false-alarm rate holds - see section 6 |
| `0005` note-generator hook | F4 | - |
| `0006` phase driver beyond one phase; threshold deriver; comparator | F3, F11, F12 | pair chooser, human panel, candidate writer (M3.1) |
| `0004` calibration of agent judges against a person; candidate findings | - | M3.1 |

---

## 4. Verification targets

- Behaviour tests for every new or changed component, each refusal mutation-tested.
- The adapter conformance suite, extended for continuation and accepted before adapters change.
- Synthetic multi-phase scenarios with a scripted adapter recording what each phase received.
- Fixtures with expected values derived independently of the code, as Delta-1's conformance expectations were.
- Live probe records and live runs.

---

## 5. Binary exit criteria

Evaluated by an agent that built none of the code the criterion exercises, holding verifier authority.

| # | Stage | Criterion |
|---|---|---|
| F1 | 1 | For each driven runtime, a recorded live probe inside the filesystem sandbox: invocation 1 receives a token and ends; invocation 2 resumes invocation 1's session id with the token absent from its prompt, workspace and instructions, and is recorded as recalling it if and only if its reply holds the token; invocation 3, in another cell with its own session state, cannot list or resume invocation 1's session. The adapter declares `continue: true` if and only if both hold, and a conformance case shows an adapter declaring `false` refuses a continuing phase. |
| F2 | 1 | For each driven runtime, a recorded probe names a command that compacts a session on demand, or records that none was found with the searches run; where one exists, a canary planted in an instruction file and not quoted before compaction is asked for afterwards, and the record says whether it was quoted. The result is recorded in the adapter's declared capabilities. |
| F3 | 2 | Phases P1 (new), P2 (new, given P1's note file) and, on an adapter declaring `continue: true`, P3 (continuing P2) run on the scripted adapter: P2's prompt holds the note byte for byte and carries no session id; P3's call carries P2's session id. The pack checker rejects, each with a fixture naming the defect: a first phase that continues; a note or continuation from a later or absent phase; a continuing phase for a member whose adapter declares `continue: false`. A phase invalid for behaviour ends the phases that follow from it: they get no call, and their properties score the bottom of their scale, while phases on other branches run (amended by `0020`; it read "ends its episode: later phases get no call"). |
| F4 | 2 | At a branch point both branches start from workspaces whose tree equals the ending tree of the phase before less exactly each branch's withheld files, plus the files of trap versions placed in that branch (amended by `0020`; it read "whose tree hash equals the ending tree of the phase before"; the trap-file clause added by the author after `0020`, for the director to confirm); one branch's prompt holds the agent's note, or `(no note was written)` when there is none, and the other the hook's note. A note hook that fails, or attempts the network, reads outside its inputs, writes outside its folder or overruns its limit, is stopped to Delta-1's E12 standard; its branch's properties are incomplete, and the other branch is judged and tallied. |
| F5 | 2 | For a scenario with two trap pairs, three positions and two versions, at three runs per cell and three members: every cell meets each pair exactly once; the position and version of every cell equal those the rule in section 1 gives, in a table the verifier derives from that rule; the assignment is recorded per cell, and a second run of the same experiment records the same assignments. |
| F6 | 2 | Each property is judged on the phase it names, by default the last; a marker planted in every other phase's outcome reaches no judge prompt, except a note or starting state a property names in `judgedWith`; a run record of a three-phase scenario re-tallies to its result. |
| F7 | 3 | For a fixture of comprehension and adherence scores naming shared guidance ids, one property naming two ids, the link's four rates per member, arm and id equal those the verifier computes from section 1's rule. |
| F8 | 3 | A note or final message sharing twelve consecutive words, as section 1 defines words, with a file delivered as `instruction` or `folder-file` is flagged with both paths; one sharing eleven, or sharing words only with an on-request file, is not; flags reach no score. |
| F9 | 3 | `recordExperiment` refuses an experiment declared `result` with no stated variation or default, and accepts one declared `exploration` without them; for a fixture with known counts, the result reports the detectable difference per scope equal, to two decimals, to section 1's formula as the verifier computes it, beside the stated difference. |
| F10 | 3, 4 | Held-out scenarios' properties appear only in the held-out section of a result and, at stage 4, of a comparison, and in no total; the exposure command appends a register entry naming the scenario and the change and never rewrites one; a later result and comparison list the scenario as exposed to that change. |
| F11 | 4 | Given a fixture A/A run with known outcomes per cell run, including an excluded run, the threshold deriver returns, for sizes 3 and 9, thresholds, the two-stage rate and the drift rank equal to those an independent implementation of section 1's estimator returns with the same generator and seed; given a pool of eleven present runs, it refuses. |
| F12 | 4 | On fixtures, each rule flags exactly the properties its definition in section 1 flags, including a property absent from the head or with no mean, and a flagged property persisting or not at size 9 read from a tally restricted to runs 1 to 3; the comparator refuses inputs differing in scenarios, population, runs per cell or trap assignment, and a threshold set of another `m`; its output's keys are exactly those section 1 lists. |
| F13 | 5 | A run of mission-kit's handoff experiment, recorded before it runs, its key audited before recording: members of three families, arm on-trigger, one run per cell; every probe passes; every phase of every episode is recorded with its validity; each member's resumed branches are each valid and judged by two judges of other families, or invalid with a cause; the record re-tallies to its result. |
| F14 | 5 | A run of mission-kit's A/A experiment, recorded before it runs and pinned to a stated source revision, with every cell run valid or invalid with a cause and at least 90% valid, gives the threshold deriver its input; the thresholds for sizes 3 and 9, the two-stage rate and the drift rank are recorded in mission-kit's `register/` with the run id, before F15's run starts. |
| F15 | 5 | A further run of the same recorded A/A experiment at the same pinned revision, started after F14's thresholds were recorded, is compared arm against arm under the A/A rule - cell runs 1 to 3 against the size-3 threshold, then flagged properties over all nine against the size-9 threshold - and the count of persisting flags is recorded; if it is above zero, the result states that the gate cannot tell a change from noise at this size, the falsifier of mission-kit's standing-suite design, section 12. |

---

## 6. Named costs and non-claims

- **Live cost.** F14 and F15 are two runs of 270 cell runs each - 540 agent cells, on-trigger context in both arms - and their judging: about two and a half hours of execution and half an hour of judging, extrapolated from Delta-1's live adherence run, whose 45 on-trigger cells used 3,912 seconds of agent time, at the parallelism that run reached, which its record does not store and is inferred as about 5.7. Token cost is reported with each result.
- **Calibration is exercised, not established.** Splits of one A/A run estimate the threshold assuming cell runs within a scenario and member are exchangeable; the drift check shows whether the two arms differed more than the splits do, and drift between runs on different days is not represented. Each threshold is set at one in ten on its own; the two-stage rule's rate is lower, and reported. F15 is one observation: if the true rate were 0.3, a fresh run would still pass seven times in ten - a pass is weak evidence of calibration, a fail weak evidence against it.
- **Thresholds fit the suite they came from.** They depend on its properties and base rates, and do not carry over to another suite, such as the scenarios a real gate run would select.
- **Rotation is not balanced at these sizes.** With two versions and three runs, version is tied to position within a member, and both pairs of a cell take the same version index.
- **Properties are not independent.** The adherence suite's sixteen properties cluster in five scenarios, and three are near-identical; `m` counts properties, not independent ones, so the stated false-alarm rate is per run as computed, not per independent test.
- **Thresholds hold for the models and runtimes measured.** A new model version is a reason to measure them again.
- **Compaction may not be reachable on demand.** F2 records whether it is; this delta builds no compacting phase - a new session from a note is the only simulation of compaction it offers, and every result of such a phase says so.
- **The link is a correlation**, and is proven here on fixtures only.
- **Restated guidance is a surface test.** Twelve consecutive words catches copying, not paraphrase; table rows in a ledger could produce flags that are not restatement, which is why flags are diagnostic.
- **A hook that catches its own denied attempts still returns success**, as Delta-1 recorded; this holds for the note hook too.
- **No person in the loop yet** - calibration of judges against a person is M3.1.

---

## 7. The anti-scope fence

This delta does not build or change:

- a compacting phase; the pair chooser, the human panel, judging chains, or the candidate writer;
- the run conductor extending a flagged cell by itself - the caller supplies results at the larger size;
- zorg's pack, or anything in zorg's repository;
- retirement of mission-kit's or zorg's existing tools;
- any mission-kit suite's existing keys or wording; mission-kit's pack changes are only those section 1 lists;
- the pack schema's version: every schema change here is an optional field, so `context-lab.pack/1` packs stay valid;
- networked delivery, or a third runtime adapter;
- `ARCHITECTURE-TARGET.md` or `DECISIONS.md`, except by a new ruling;
- anything that ranks models.

**Authority in mission-kit.**\
The pack changes are authorised by mission-kit's `0087`, as Delta-1's were; the stated variation and defaults are the director's to choose.

**Author's choices**, not settled by any ruling: the re-run unit is the whole episode; a missing own note becomes `(no note was written)`; exposure is recorded per change, as the architecture's register states.

**Settled at ratification (`0019`):** the gate's shape - one run with base and head as arms, as recommended and drafted, or two runs; the reading of mission-kit's gate rule as the largest standardised drop over `m` properties at the ninetieth percentile, a flag being one property or more, with persistence tested on nested sets; and the stated variation and default of the A/A and handoff experiments - 0.25 pooled, defaulting to no change indicated.

## Record

**Stage 1.**\
Probed live, inside the filesystem sandbox, and recorded in `docs/probes/2026-10-11-sessions.json` by `packages/core/test/live/session-probes.live.ts`, on opencode 1.18.35 and codex-cli 0.162.1.\
Continuation: both runtimes resumed a session from a copied store in the same git workspace, with no tool call, and returned the token; a folder with its own store could not resume or list it.\
A first probe resumed in a fresh workspace, its record overwritten by the re-run: Codex recalled the token and opencode failed; outside the sandbox, opencode's log showed the resumed session running in the directory it began in, so a continuing invocation shares its predecessor's workspace.\
Compaction: both compact on demand - opencode through its server's summarize route, Codex through its app-server's `thread/compact/start`.\
After compaction, opencode quoted an instruction file's canary when the file was delivered again and not otherwise; Codex quoted it without the file delivered again - its session carries its instructions - and once declined to quote "internal instructions" when it was delivered.\
One sample each.\
So mission-kit's backlog row `B3`'s question has an answer for these versions: instruction delivery survives compaction on both runtimes, by different means.\
The adapter conformance cases gained C20 to C25 for continuation, accepted by the verifier after three reviews before any adapter changed; the adapters then gained continuation from a copied store, Codex runs without `--ephemeral` and takes its sandbox mode from configuration, and Delta-1's live configuration checks were re-run under the new configuration and all thirteen pass, recorded in `docs/probes/2026-10-11-config-claims.json` - among them two new checks, that a Codex agent's shell writes only its workspace, and that a continuing Codex invocation's shell writes only its workspace and cannot reach the network, each requiring the forbidden write to have been attempted.\
Verification found F1 and F2 green and every new protection load-bearing but one, opencode's removal of a login from its kept data folder, now tested.

**Stage 2.**\
Scenarios may declare phases - a new session from a copy of an earlier phase's ending state, given an own note file or a note-generator hook's output and with named files withheld, or a continuing session in the same workspace - and trap pairs, placed by the rotation rule into `{SLOT:<position>}` markers in phase tasks; properties may name their phase and `judgedWith`; experiments may state a variation and default; packs may declare comparisons.\
The episode runner is `packages/core/src/episode.ts`; the run conductor runs every cell as an episode, re-running the whole episode on a cause other than behaviour, with open-step timeouts counted across phases and attempts (`0012`).\
A behaviour failure ends the episode: properties of phases that ran validly keep their values, the rest score the bottom of their scale; a failed note hook leaves its branch, and phases following it, incomplete.\
Judging is per phase: a unit holds one phase's outcome, with the note or starting changes only where every property in it names them, and one judge prompt holds units of one phase, with that phase's task.\
mission-kit's pack gained the handoff experiment, the A/A experiment, the `aa-gate` comparison and the `handoff-note` hook (mission-kit `0fa9f7f`, revised in `4aaad8e` and `45a0fc2`).\
The handoff key was audited by an agent that did not write it (`docs/evals/context-lab/audits/handoff-key.md` in mission-kit), with verdict run after fixes, three blocking findings.\
The one that reached the core: a resumed session could read withheld files from the copied repository's history and objects.\
So a new session following another now gets fresh history of one commit, and every state and diff is taken in a ledger repository of the episode's own (`92761ef`), which also means an agent that breaks or deletes its own repository is measured rather than made invalid, a change from Delta-1's rule.\
The author then replaced the scenario's story, which reused the `A4` trap's call notes almost verbatim against this plan's "a new fixture, not the A4 trap's"; the auditor's re-check ran the core's episode code on the revised scenario against a hostile first phase, confirmed the leak closed, and returned record after fixes with nothing blocking; every finding is disposed of in the audit file.\
Left open for the director: with one arm and one run per cell, as F13 fixes the experiment, three outcomes per branch cannot detect the stated 0.25 difference.\
Synthetic fixture: scenario `relay` (four phases, two branches, two trap pairs); 275 tests.
Verification (first pass) found F3, F5 and F6 green and F4 partial, on its tree-hash clause, which predates withholding.\
Its untested behaviours are now tested, each shown load-bearing by a mutant: the generated note in its prompt, the default last phase, trap properties on their trap's phase, each judge prompt's own task, code properties on their own phase, infrastructure re-running the whole episode, `0012` across phases, and trap files.\
Trap files had joined the initial state wherever their trap sat; they now join only the start of the phase holding it.\
A first phase given its own task or withheld files is now a pack defect, and forbidden paths named are kept per attempt.\
Open, for the director: a behaviour failure in one branch ends the episode, so the sibling branch scores the bottom of its scale, as section 1's wording has it, which biases the handoff experiment's own-versus-generated comparison; and F4's tree-hash clause needs restating for withheld files.\
Ruled (`0020`): a behaviour failure ends only the phases that follow from it, and F4 is restated for withheld files; both are tested, the first in each direction - whichever branch fails, the other is judged - and each test fails under the rule as first built.\
278 tests; 280 after `0020`.
A second verification pass found F3, F5 and F6 green, `0020` correct in every case probed, and F4 partial on its text: a branch holding a trap's position also gains that version's files, as the stage-2 fix intends, which "less exactly its withheld files" did not allow.\
F4's text now names them, an author's amendment for the director to confirm, and F3's last sentence takes `0020`'s wording.\
Its other findings are fixed and tested, each test failing under a mutant: behaviour in one branch then infrastructure in the other re-runs the whole episode and records no behaviour ending; forbidden paths named are recorded per attempt; a first phase with its own task or withheld files has a checker fixture.\
285 tests.
A third, narrow pass found F3 and F4 green, F4 pending the director's confirmation of its trap-file clause, and one diagnostic untested - which phase `endedAt` names when two branches fail - now tested.\
Stage 2 is complete.

**Stage 3.**\
The result gained four measures, in `packages/core/src/measures.ts` and the tally, none of them a score.\
The link: per member, arm and guidance id, every pair within one episode of a comprehension and an adherence property naming the id, each with a value, sorted into four rates by the midpoint rule; incomplete values make no pair.\
Restated-guidance flags: every phase's final message and every note a session was given, against every file delivered as an instruction or folder file, by section 1's words - markdown dropped meaning a link or image keeps its text and loses its target, and an autolink or HTML tag is removed; the flag names the note's file or the final message, the delivered file's name and the path it was delivered from, and the first shared run.\
Stated variation: `recordExperiment` refuses a result without `variation` or `default`; the result reports the detectable difference pooled and per property, an outcome being one cell run's value on one property as a fraction of its scale, `p` pooling every outcome of every arm, `n` the fewest outcomes of any arm - definitions section 1 left open, chosen here.\
Held-out scenarios: their properties appear only in the result's held-out section, and count toward no total, link or detectable difference; `context-lab expose <pack> <scenario> <change>` appends one line to the pack's `register/exposure.jsonl`, refusing a scenario not held out; a run snapshots the exposures of its held-out scenarios when it begins, so a later result lists them and a re-tally of an earlier one does not change.\
The stated variation and exposures are read from the run record, so a re-tally does not depend on the pack.\
Open, for the director, when it is next recorded: mission-kit's `explain` experiment is declared result and states no variation or default, so recording it again is now refused.\
Verification, by a fresh verifier after the first one's session failed on a malformed request, found F7, F8 and F9 green and F10's result clause partial: held-out values remained in the result's per-cell values, and held-out guesses in the guess count.\
Both are now kept apart; the HTML-tag step no longer crosses lines or swallows text between a stray `<` and `>`; "markdown dropped" is now a stated list of steps - an info string, reference definitions and footnote markers, link targets, autolinks and common-element tags, entities, backslash escapes, ordered-list numbers and asterisks - each tested, and the comment no longer claims more; a blank default is refused; a per-property scope warns per property; an exposure register whose last line is unterminated is refused, not merged; and the link fixture names an id only as a second id.\
The pooled detectable difference counts the outcomes of one cell run as independent, which they are not, so it understates the difference truly detectable; the result says so.\
293 tests.

---

## Adversarial review

**Reviewer.**\
A fresh agent that did not draft this delta, of the same model family as its author, with read access to every cited file, and no edits.

**Verdict as given.**\
Ratify after fixes.

| Finding | Severity | Disposition |
|---|---|---|
| F5, F7, F9, F11 judged code against rules the delta never stated | blocking | The rotation, link, variation and threshold rules are stated in section 1; the criteria cite them, with expected values derived by the verifier |
| One A/A pair cannot estimate a one-in-ten rate from sixteen non-identical properties | blocking | Standardised drops; thresholds from 1000 seeded splits of each cell's eighteen runs; `m` declared; an interval reported; calibration downgraded to exercised, with non-claims |
| F15 satisfied either way, and citing a falsifier the architecture does not hold | blocking | Reworded to record the count of persisting flags and its consequence; citation corrected to mission-kit's design, section 12 |
| mission-kit pack changes the anti-scope forbade, and no authority paragraph | blocking | Every change listed; authority restored; stated variation values the director's; pack changes written in stage 2 |
| The handoff scenario unkeyed and unaudited | blocking | Key committed and audited before recording, by mission-kit's procedure; a new fixture, not the `A4` trap's |
| F2 gated the compacting phase backwards, and no compacting phase was fenced | blocking | F2 now only probes and records; no compacting phase is built, anti-scoped |
| F13 depended on continuation, with no fallback | blocking | The handoff runs work, then a new session from a note; continuation is offered only where F1 shows it works |
| Trap assignment seeded from the run id | should-fix | The rule is deterministic from indices, the same for every run of an experiment |
| F6 hid the note from judges who must judge it | should-fix | `judgedWith` lets a property show judges the note or starting state |
| A required phase field and stated variation would break existing packs | should-fix | Both optional or required only at recording of a `result` experiment; schema version unchanged |
| F10 needed stage 4 | should-fix | Restaged to stages 3 and 4 |
| Comparator missing mismatch refusals; "no verdict" checked a name | should-fix | Refusals added; output keys stated exactly |
| Conductor extension creeping | should-fix | Anti-scoped; the caller supplies results at the larger size |
| Episode re-run unit and phase-failure rule unstated | should-fix | Stated in section 1, and in F3 |
| B12 not closed unless the A/A experiment is recorded | should-fix | Recorded before F14; F15 repeats it |
| Conformance cases not extended for continuation; stage rule dropped | should-fix | Both restored |
| Delta-1's hook limit not carried; cost estimate unsourced | should-fix | Non-claim added; estimate sourced from Delta-1's run |
| F1, F4, F8 open to two readings | should-fix | Reworded as the reviewer proposed |
| Twelve-word flag stated as catching copying | minor | Stated as a surface test, diagnostic only |

**Re-check of revision 2**, by the same reviewer: every blocking finding resolved or mostly resolved; four fixes required, all applied in revision 3.

| Finding | Severity | Disposition |
|---|---|---|
| F14 allowed excluded runs while the deriver refused any cell short of eighteen | blocking | The deriver pools the runs present, sets of `min(k, floor(n/2))`, refusing below twelve; *cell* and *cell run* defined |
| F11 not binary: generator, draw, percentile and interval unstated | blocking | Generator and draw stated, nearest-rank percentile with strict comparison; the interval replaced by a drift check |
| A tally of runs 1 to 3 that nothing built; source revision drifting between runs | should-fix | Both fenced, and the A/A runs pinned to one revision |
| The handoff key audit named no procedure or artifact | should-fix | Audit file, its contents, and that F13 runs only on an audited key |
| The two-stage rule's rate unestimated | should-fix | Estimated from nested splits and reported |
| The gate as two runs departed from mission-kit's design | should-fix | Redrafted as one run with two arms; confirmed (`0019`) |
| Comparator not checking `m`; thresholds suite-specific; rotation unbalanced; drift claim; parallelism inferred | minor | Refusal added; non-claims added |
