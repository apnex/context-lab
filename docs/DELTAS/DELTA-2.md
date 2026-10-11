# Delta-2 - multi-phase episodes and the change gate - a vertical slice

```yaml
status:     draft - for adversarial review, then the director's ratification
selected:   docs/DECISIONS.md 0018, board items M2.1, M2.2, M2.3
from-state: Delta-1's to-state (0017): one-phase experiments, isolation probed, judged, tallied
to-state:   docs/ARCHITECTURE-TARGET.md (0006), the parts fenced in section 1
rows:       docs/BACKLOG.md B1, B2, B3, B12
```

---

## 0. From-state -> to-state

**From.**\
The core runs an experiment of one phase in a new session, through to a tallied result; it cannot continue a session, give an agent a note from an earlier phase, compare two results, or say how large a difference must be before it is more than noise.

**To.**\
The core runs multi-phase episodes - phases continuing a session or starting a new one from a note, with branches from one point - and compares two results under a declared rule whose threshold was set by A/A runs, flagging and never deciding.\
It also delivers the parts of `0004` Delta-1 deferred to this milestone: trap pairs rotated across positions, the comprehension-behaviour link, restated-guidance flags, the variation an experiment can detect stated before its outcomes, and held-out scenarios reported apart with their exposure recorded.

---

## 1. The fence

This delta builds:

- **Probes** of session continuation and of compaction on both driven runtimes, under isolation, recorded.
- **The phase driver, multi-phase**: phases declared by the scenario, each continuing the previous session or starting a new one; a note carried into a new session, either the agent's own - a file the previous phase wrote - or one made by the note-generator hook (`0005`); branches, several phases started from one point.
- **Trap pairs**: a scenario's traps declared as pairs of versions, each episode meeting each pair once, version and position assigned by a deterministic rule from the run's seed, recorded per cell.
- **Per-phase outcomes** blinded, judged and tallied, each property naming the phase it is judged on.
- **The comprehension-behaviour link**: rates per member, arm and guidance entry of the four cells - applies and acts, applies and does not act, does not apply and acts, neither - from properties of type comprehension and adherence naming the same guidance.
- **Restated-guidance flags**, by code: a note or final message holding a passage of the arm's instruction text.
- **Stated variation**: an experiment declares the smallest difference it means to detect and the default taken when none is detected, both covered by the register's hash; the tally reports the variation achieved beside it.
- **Held-out scenarios**: reported apart in the result and in comparisons; the register records which changes a project declares a held-out scenario's outcomes have informed, and a scenario so exposed is no longer reported as held out.
- **The threshold deriver**: from the results of a condition run against itself, per run size, the pooled drop that occurs on no more than one property in a run's worth, one time in ten.
- **The comparator**: two results under a declared rule - per-property tolerance with a property absent from the head counted as a drop; an A/A threshold with extension to the larger size and a persistence test; or improve-without-worsening across families - giving flags, never a verdict.
- **The note-generator hook**, under the hook contract.
- **A multi-phase scenario in the synthetic pack**, and one in mission-kit's pack: a handoff - work, a note, a new session that continues - testing whether a decision's rationale survives the note.

---

## 2. Build order - certifiable stages

1. **Probes.** Continuation and compaction on both runtimes. Criteria F1, F2.
2. **Episodes.** Multi-phase phase driver, notes and the hook, branches, trap pairs, per-phase outcomes through to the tally. Criteria F3, F4, F5, F6.
3. **Measures.** The link, restated-guidance flags, stated variation, held-out reporting and exposure. Criteria F7, F8, F9, F10.
4. **Comparison.** Threshold deriver and comparator, against fixtures. Criteria F11, F12.
5. **Live.** A multi-phase episode on both runtimes; A/A runs of mission-kit's adherence suite setting thresholds at two sizes; a held-out A/A run checking them. Criteria F13, F14, F15.

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven, by criterion | Deferred, to board item |
|---|---|---|
| `0004` multi-phase episodes, notes generated from the workspace | F3, F4, F13 | - |
| `0004` trap pairs met once per episode, rotated | F5 | - |
| `0004` comprehension-behaviour link; restated-guidance flags; variation stated before outcomes | F7, F8, F9 | - |
| `0004` held-out scenarios | F10 | - |
| `0004` comparison rules calibrated by A/A runs, flagging rather than deciding | F11, F12, F14, F15 | - |
| `0005` note-generator hook | F4 | - |
| `0006` phase driver beyond one phase; threshold deriver; comparator | F3, F11, F12 | pair chooser, human panel, candidate writer (M3.1) |
| `0004` calibration of agent judges against a person; candidate findings | - | M3.1 |

---

## 4. Verification targets

- Behaviour tests for every new or changed component, each refusal mutation-tested.
- Synthetic multi-phase scenarios with a scripted adapter that records what each phase received.
- Comparator fixtures with known answers for each rule shape.
- Live probe records, and live A/A runs.

---

## 5. Binary exit criteria

Evaluated by an agent that built none of the code the criterion exercises, holding verifier authority.

| # | Stage | Criterion |
|---|---|---|
| F1 | 1 | For each driven runtime, a recorded live probe shows whether a second invocation continuing the first one's session, under the filesystem sandbox and with a fresh workspace forbidden to it, recalls a token given only in the first; and the adapter offers continuation exactly when the probe shows it works. |
| F2 | 1 | For each driven runtime, a recorded live probe shows whether the runtime can be made to compact a session on demand, and, where it can, whether an instruction file's canary is still quoted after compaction; the phase driver offers a compacting phase exactly where the probe shows both. |
| F3 | 2 | A synthetic three-phase scenario - work, handoff in the same session, resume in a new session from a note - runs on a scripted adapter, and its record shows each phase's prompt, session, note and outcome; a scenario declaring a phase shape the driver does not support is refused by the pack checker. |
| F4 | 2 | A branch point produces two resumed phases from the same state, one given the agent's own note and one the note-generator hook's, each recorded; a note-generator hook that fails leaves its branch incomplete and the other branch scored, and a hook attempting the network, reading outside its inputs or overrunning its limit is stopped. |
| F5 | 2 | For a scenario with two trap pairs and runs per cell equal to the number of positions, every cell meets each pair exactly once; across the runs of one arm and member each version appears in each position as the rotation rule predicts; the assignment is recorded per cell and is the same when the run is repeated with the same seed. |
| F6 | 2 | Each property names the phase it is judged on; judges are shown only that phase's outcome; a run record of a three-phase scenario re-tallies to its result. |
| F7 | 3 | For a fixture of agents' comprehension and adherence results naming the same guidance, the link reports the four rates per member, arm and entry equal to those computed by hand in the test. |
| F8 | 3 | A note or final message holding a passage of at least twelve consecutive words of the arm's instruction text is flagged, naming the file; one with eleven, or with text from no instruction, is not. |
| F9 | 3 | An experiment without a stated variation and default is rejected by the pack checker; changing either after recording makes a run exploration; the result reports the variation achieved, computed from the tally's counts, beside the variation stated. |
| F10 | 3 | Held-out scenarios are reported in their own section of the result and of a comparison; declaring that a change was informed by a held-out scenario's outcomes is recorded in the register, append-only, and a later run reports that scenario as exposed, not held out. |
| F11 | 4 | Given A/A results with known drops, the threshold deriver returns, per size, the threshold its rule defines, recorded with its false-alarm rate and the runs it came from; given fewer runs than its rule needs, it refuses. |
| F12 | 4 | On fixtures, each comparator rule flags exactly the properties its definition flags - a drop beyond tolerance; a property absent from the head; a drop beyond the A/A threshold, extended, and persisting or not at the larger size; a family worsening beyond tolerance - and its output contains no verdict field. |
| F13 | 5 | A live run of mission-kit's handoff scenario on both driven runtimes, one arm, one run per cell, reaches a tallied result with every phase recorded and both branches judged. |
| F14 | 5 | Live A/A runs of mission-kit's adherence suite, on-trigger only, three families, at three and at nine runs per cell, give the threshold deriver its input, and the thresholds are recorded with the run ids. |
| F15 | 5 | A further A/A pair at nine runs per cell, not used to set the thresholds, compared under the A/A rule, flags no persisting drop - or, if it does, the gate is reported as unable to tell a change from noise at that size, as the architecture's falsifier states. |

---

## 6. Named costs and non-claims

- **Live cost.** F14 and F15 are two runs of 45 cells and four of 135: about 630 agent cells and their judging, several hours of machine time, inferred from Delta-1's runs.
- **A/A from one model generation.** Thresholds hold for the models and runtimes they were measured on; a new model version is a reason to measure them again.
- **Compaction may not be reachable.** If neither runtime can be made to compact on demand, the core simulates it only by a new session from a note, and says so; F2 then records that limit and no compacting phase is offered.
- **The link is a correlation.** It reports how knowing and acting co-occur; it does not show either causes the other.
- **Restated guidance is a surface test.** Twelve consecutive words catches copying, not paraphrase.
- **No person in the loop yet** - calibration of judges against a person is M3.1.

---

## 7. The anti-scope fence

This delta does not build or change:

- the pair chooser, the human panel, judging chains, or the candidate writer;
- zorg's pack, or anything in zorg's repository;
- retirement of mission-kit's or zorg's existing tools;
- any mission-kit suite's existing keys or wording, beyond adding the handoff scenario to its pack and the stated variation the pack checker now requires;
- networked delivery, or a third runtime adapter;
- `ARCHITECTURE-TARGET.md` or `DECISIONS.md`, except by a new ruling;
- anything that ranks models.

---

## Adversarial review

Pending: an agent that did not draft this delta reviews it before ratification; its findings and the disposition of each are recorded here.
