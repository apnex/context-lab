# Delta-2 - multi-phase episodes and the change gate - a vertical slice

```yaml
status:     draft revision 2 - adversarial review applied; for the director's ratification
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
- **Episode rules.** The re-run unit is the whole episode: an episode is attempted again as one cell is, its attempts counted per episode, and `0012` counts open-step timeouts across all its phases. A phase invalid for behaviour ends its episode, and properties of later phases score the bottom of their scale; a phase invalid for any other cause makes the episode invalid for that cause.
- **Trap pairs and their rotation.** A scenario's traps may be declared as pairs of versions with the positions they may take. The rule, deterministic and independent of the run: for a cell's run index `r` (counting from 0), pair index `k`, member index `j` in the experiment's population, `P` positions and `V` versions, position = `positions[(r + k) mod P]` and version = `versions[(j + r) mod V]`. The assignment is recorded per cell.
- **Per-phase outcomes**, blinded, judged and tallied: each property may name the phase it is judged on, by default the last; and may declare `judgedWith`, the note or the starting state, shown to judges beside that phase's outcome. Nothing else of other phases reaches a judge.
- **The comprehension-behaviour link.** Per member, arm and guidance id: pair each episode's score on a comprehension property and on an adherence property both naming that id, each counted as met when at or above the midpoint of its scale; the four rates are the fractions of pairs that are met-and-met, met-and-not, not-and-met, and neither. A property naming several ids counts toward each.
- **Restated-guidance flags**, by code and diagnostic only: words are maximal runs of letters, digits and apostrophes after lowercasing, markdown dropped; a note or final message sharing twelve or more consecutive words with a file delivered to the arm as `instruction` or `folder-file` is flagged with both paths.
- **Stated variation.** An experiment declared `result` must state `variation: { difference, scope }` - the smallest difference in pass rate it means to detect, per property or pooled - and `default`, the decision taken when none is detected; `recordExperiment` refuses such an experiment without them, and both are covered by the register's hash. The result reports, per scope, the difference detectable at 80% power and 5% two-sided, `(1.96 + 0.84) * sqrt(2 p (1 - p) / n)`, with `p` the pooled rate and `n` the outcomes per arm, beside the stated difference.
- **Held-out scenarios**, reported only in their own section of a result and of a comparison and in no total. A project declares, by a command, that a named change was informed by a held-out scenario's outcomes; the register records it, append-only; later results and comparisons list that scenario as exposed to that change.
- **The threshold deriver.** Its input is one A/A pair: two runs of one recorded experiment, identical in everything, at nine runs per cell. Each property's drop is standardised: `d = (rateA - rateB) / sqrt(2 p (1 - p) / n)`, `p` pooled, `n` outcomes per arm, and `d = 0` where `p` is 0 or 1. For a run size `k` of 3 or 9, it draws 1000 splits, seeded from the experiment's hash, of each cell's eighteen runs into two sets of `k`, and for each split takes the largest `d` over `m` properties - `m` declared by the comparison rule, by default every property the experiment holds. The threshold for size `k` is the ninetieth percentile of that largest `d`, recorded with `m`, the split count, the run ids, and a 90% interval on the false-alarm rate it achieves. It refuses an input with fewer than eighteen runs in any cell.
- **The comparator.** Two results under a declared rule: per-property tolerance, a property absent from the head or with no mean counted as a drop; the A/A rule - flag a property whose standardised drop exceeds the size-3 threshold, then, given results of base and head at nine runs supplied by the caller, report as persisting a flagged property whose drop at nine exceeds the size-9 threshold; or improve-without-worsening across families. It refuses two results that differ in anything but the variant revisions under comparison - scenarios, arms, population, runs per cell, trap assignment. Its output holds exactly `rule`, `inputs`, `flags`, `heldOut`, `exposed`, `limits`.
- **The note-generator hook**, under the hook contract.
- **Synthetic scenarios** for every new shape, in the synthetic pack.

**mission-kit's pack, by mission-kit's `0087`**, each change landing in stage 2 with the checker change it needs:

- a **handoff experiment**: work, then a new session from a note, testing whether a recorded decision's rationale survives the note - its fixture new, not the `A4` trap's; its key committed and audited by a fresh agent before the run, by mission-kit's procedure; recorded before F13;
- an **A/A experiment**: the adherence suite's scenarios, on-trigger only, three families, nine runs per cell, declared `result`, recorded before F14;
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
| F3 | 2 | Phases P1 (new), P2 (new, given P1's note file) and, on an adapter declaring `continue: true`, P3 (continuing P2) run on the scripted adapter: P2's prompt holds the note byte for byte and carries no session id; P3's call carries P2's session id. The pack checker rejects, each with a fixture naming the defect: a first phase that continues; a note or continuation from a later or absent phase; a continuing phase for a member whose adapter declares `continue: false`. A phase invalid for behaviour ends its episode: later phases get no call, and their properties score the bottom of their scale. |
| F4 | 2 | At a branch point both branches start from workspaces whose tree hash equals the ending tree of the phase before; one branch's prompt holds the agent's note, or `(no note was written)` when there is none, and the other the hook's note. A note hook that fails, or attempts the network, reads outside its inputs, writes outside its folder or overruns its limit, is stopped to Delta-1's E12 standard; its branch's properties are incomplete, and the other branch is judged and tallied. |
| F5 | 2 | For a scenario with two trap pairs, three positions and two versions, at three runs per cell and three members: every cell meets each pair exactly once; the position and version of every cell equal those the rule in section 1 gives, in a table the verifier derives from that rule; the assignment is recorded per cell, and a second run of the same experiment records the same assignments. |
| F6 | 2 | Each property is judged on the phase it names, by default the last; a marker planted in every other phase's outcome reaches no judge prompt, except a note or starting state a property names in `judgedWith`; a run record of a three-phase scenario re-tallies to its result. |
| F7 | 3 | For a fixture of comprehension and adherence scores naming shared guidance ids, one property naming two ids, the link's four rates per member, arm and id equal those the verifier computes from section 1's rule. |
| F8 | 3 | A note or final message sharing twelve consecutive words, as section 1 defines words, with a file delivered as `instruction` or `folder-file` is flagged with both paths; one sharing eleven, or sharing words only with an on-request file, is not; flags reach no score. |
| F9 | 3 | `recordExperiment` refuses an experiment declared `result` with no stated variation or default, and accepts one declared `exploration` without them; for a fixture with known counts, the result reports the detectable difference per scope equal, to two decimals, to section 1's formula as the verifier computes it, beside the stated difference. |
| F10 | 3, 4 | Held-out scenarios' properties appear only in the held-out section of a result and, at stage 4, of a comparison, and in no total; the exposure command appends a register entry naming the scenario and the change and never rewrites one; a later result and comparison list the scenario as exposed to that change. |
| F11 | 4 | Given a fixture A/A pair with known per-cell outcomes, the threshold deriver returns, for sizes 3 and 9, thresholds equal to those an independent implementation of section 1's estimator returns with the same seed, recorded with `m`, the split count, the run ids and the interval; given a cell with fewer than eighteen runs, it refuses. |
| F12 | 4 | On fixtures, each rule flags exactly the properties its definition in section 1 flags, including a property absent from the head or with no mean, and a flagged property persisting or not at size 9; the comparator refuses two results differing in scenarios, arms, population, runs per cell or trap assignment; its output's keys are exactly those section 1 lists. |
| F13 | 5 | A run of mission-kit's handoff experiment, recorded before it runs, its key audited before recording: members of three families, arm on-trigger, one run per cell; every probe passes; every phase of every episode is recorded with its validity; each member's resumed branches are each valid and judged by two judges of other families, or invalid with a cause; the record re-tallies to its result. |
| F14 | 5 | Two runs of mission-kit's A/A experiment, recorded before the first, each cell valid or invalid with a cause and at least 90% of cells valid, give the threshold deriver its input; the thresholds for sizes 3 and 9 are recorded in mission-kit's `register/` with the run ids, before F15's runs start. |
| F15 | 5 | A further pair of runs of the same recorded A/A experiment, started after F14's thresholds were recorded, is compared under the A/A rule - runs 1 to 3 of each cell against the size-3 threshold, then flagged properties over all nine against the size-9 threshold - and the count of persisting flags is recorded; if it is above zero, the result states that the gate cannot tell a change from noise at this size, the falsifier of mission-kit's standing-suite design, section 12. |

---

## 6. Named costs and non-claims

- **Live cost.** F14 and F15 are four runs of 135 cells - 540 agent cells, on-trigger only - and their judging: about two and a half hours of execution and half an hour of judging, extrapolated from Delta-1's live adherence run, whose 45 on-trigger cells used 3,912 seconds of agent time. Token cost is reported with each result.
- **Calibration is exercised, not established.** One A/A pair resampled into splits estimates the threshold under the assumption that runs within a cell are exchangeable; between-run drift - a provider changing between the two runs - is only partly represented. F15 is one observation: if the true false-alarm rate were 0.3, a fresh pair would still pass seven times in ten. A pass is weak evidence of calibration; a fail is weak evidence against it.
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

**Author's choices**, not settled by any ruling: the re-run unit is the whole episode; a missing own note becomes `(no note was written)`; exposure is recorded per change, as the architecture's register states; a gate compares two runs, each with its own variants, as the architecture's comparator compares two results, and A/A mirrors that shape.

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
