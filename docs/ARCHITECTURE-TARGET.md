---
instant: target
---

# context-lab - system architecture, target

**Instant: target.**\
context-lab described as the system it is when the ratified decisions about it are built.\
There is no current-instant document: nothing of context-lab is built yet, so its current architecture is empty, and the working mechanism it generalises lives in its first two users, mission-kit and zorg.\
The current document begins with the first built component, derived from source as `AR1` requires.

Written in the present tense of a system that exists.\
It contains no plan, order or estimate; those belong to the board and to deltas.

---

## 1. Status and authority

Authored by the architect, ratified by the director per section.\
Maturity is per section; approval is aggregate-only.

| Section | Maturity |
|---|---|
| 2 Identity, scope, non-goals | provisional |
| 3 Justification chain | provisional |
| 4 Axiom alignment | provisional |
| 5 Anchored core | provisional |
| 6 Entity model and interfaces | provisional |
| 7 Run time | provisional |
| 8 Verification | provisional |
| 9 Risks and the owed-and-open register | provisional |

| Field | Value |
|---|---|
| Programme purpose | [`VISION.md`](../VISION.md) - cited, never restated |
| Rulings | [`docs/DECISIONS.md`](DECISIONS.md); the founding rulings are mission-kit's `0083`-`0089` |
| Origin design | mission-kit `docs/evals/standing/DESIGN.md`, ratified as mission-kit `0086`, whose universal parts this architecture holds |

---

## 2. Identity, scope and non-goals

**Identity.**\
context-lab runs experiments on the context language-model agents are given, and reports what each experiment showed.\
A project supplies what is specific to it - its experiments, its context, how that context reaches an agent, and its own vocabulary - as a **project pack**; context-lab supplies everything else.

**Scope.**

- Experiments whose factors are context: content, manner, amount and moment of delivery, and the corpus revision it comes from.
- Models and agent runtimes as declared factors, varied or held fixed.
- Comprehension, behaviour, precision and cost as measured outcomes.
- Judging by code where a check can decide, by agents of other model families where reading is needed, and by people where the outcome is for a person.

**Non-goals.**

- Ranking models.
- Holding any project's experiments, keys, run records or conclusions.
- Editing any project's working context.
- Deciding for a project: a result and a gate verdict are evidence the project's own authority acts on.
- Experiments on live systems without their owner's recorded consent.

---

## 3. Justification chain

**Domain.**\
Agents act on what is put in front of them, and projects shape that by writing guidance, choosing what loads and when, and summarising history.\
Whether a given shaping helps is usually asserted from one session, by the author of the guidance, with the same model judging - three dependencies on one source.

**Axioms.**\
The organisation's axioms in force for this system, by its traits (section 4): `A1`, `A3`-`A14`.\
`A2` is not in force: nothing reconciles a running state to a declaration.

**North star of this system.**\
Every result is attributable to the declared differences in context alone, or states what else differed.

**Principles.**

1. **Proven, not assumed.** What an agent received, and that nothing else reached it, is shown by probes in every run (`A8`, `A5`).
2. **Code before judges.** Anything a check can decide is decided by code; agents judge only what needs reading (`A11`).
3. **No family judges itself.** An outcome is judged by model families other than the one that produced it (`A8`).
4. **Rules before outcomes.** How an experiment is judged, and what a gate blocks on, is fixed and recorded before its outcomes exist (`A8`, `A14`).
5. **The project owns its content.** Everything project-specific enters through the pack and stays the project's (vision, is-not 6).
6. **Failure is data.** A run that fails is classified by cause and reported, never silently dropped or retried until it passes (`A7`, `A4`).
7. **Whole records.** Every run keeps its configuration, its context, its events, its outcomes and its sealed blinding map, so it can be repeated and audited (`A4`, `A1`).

**Decisions.**\
context-lab `0001` - the vision.\
mission-kit `0083`-`0089` - every axiom carries an adherence trap; three families scored cross-family; explain judged by agents and calibrated by the director; the standing suite design; the component's home, name and register.

**Model.**\
A neutral core of single-duty components (section 5) driven by a project pack, producing a run record the project keeps.

---

## 4. Axiom alignment

**Traits.**\
Stateful - it writes run records and reads them back to blind, tally and gate.\
Multi-agent - one agent's outcome is another's input: a handoff note to the agent that resumes, every outcome to its judges.\
Autonomous - a run proceeds and classifies its own failures with no person watching.\
LLM-in-the-loop - judges' conclusions decide scores.\
Not declarative.

| Axiom | Stands | Tension, open or discharged |
|---|---|---|
| `A1` state transparency | Run status and every cell's validity are readable from the run record | - |
| `A3` sovereign composition | Single-duty components; runtimes enter by adapter | Open: the episode driver depends on session continuation that differs by runtime |
| `A4` zero-loss knowledge | Whole records; results carry limits | - |
| `A5` perceptual parity | Probes prove what each agent received | Open: judges see masked outcomes, deliberately not what the agent saw |
| `A6` frictionless collaboration | Agents under test do not collaborate; judges are independent by design | Discharged: collaboration is not a goal of this system |
| `A7` resilient operations | Failures classified by cause; re-run once for infrastructure only | - |
| `A8` gated integrity | Isolation probes, canaries and the calibrated change gate | Open: blinding to arm is not achievable when guided output reads differently; reported per property |
| `A9` chaos-validated | - | Open: no failure injection exercises the validity classifier |
| `A10` autopoietic evolution | Candidate findings are written out for triage | - |
| `A11` cognitive minimalism | Code before judges | Open: judging itself is cognitive work, bounded but not removable |
| `A12` precision context | Judge prompts hold only key, task and outcomes | - |
| `A13` director intent | People judge outcomes meant for them; gate verdicts are evidence, not decisions | - |
| `A14` compounding learning | Every run is a durable record; findings can travel between projects | - |

---

## 5. The anchored core

Each component has one duty.

| Component | Duty | Consumes | Exposes |
|---|---|---|---|
| **Pack checker** | Validates a project pack against the pack schema | A project pack | Validation verdict with every defect |
| **Corpus exporter** | Materialises a context source at a pinned revision, with project-masked paths removed | A source and revision from the pack | A local, read-only context copy |
| **Arm builder** | Assembles one arm's context for one runtime | Context copies, the arm declaration | An arm configuration |
| **Isolation prober** | Proves an arm holds exactly its declared context | An arm configuration, the pack's canaries | Probe verdict per arm and runtime |
| **Workspace builder** | Creates a fixture workspace with no rules file above it and an opaque name | A fixture | A workspace and its initial commit |
| **Runtime adapter** | Runs one agent invocation on one runtime | Arm configuration, workspace, prompt, optional session | Events, final message, exit, cost, in the common form |
| **Episode driver** | Sequences an episode's phases and branches | A scenario, an arm, a model | Phase outcomes |
| **Run controller** | Executes a run's cells to completion | An experiment, factors, run count | The run record |
| **Validity classifier** | Classifies each cell valid or invalid by cause | A cell's events and paths | Validity and cause |
| **Code measurer** | Computes every outcome property a check can decide | Outcomes, the pack's term lists and patterns | Code scores, cost, routing traces |
| **Blinder** | Builds judge prompts with masked outcomes and seals the map | Valid outcomes, keys, the pack's identifier patterns | Judge prompts, a sealed map |
| **Judging** | Obtains votes for each prompt from judges of other families | Judge prompts | Votes |
| **Human calibrator** | Obtains a person's picks on outcome pairs | Pairs chosen from judged outcomes | Picks and agreement |
| **Tally** | Combines votes and code scores into results per factor | Votes, code scores, the sealed map | The result |
| **Gate** | Applies a calibrated threshold rule to a base-and-head result | Results, A/A thresholds | Verdict with flagged properties |

**The project pack** holds: experiments (scenarios, traps as isomorphic pairs, probes, keys, typed properties), context sources and revisions, delivery declarations per arm, identifier patterns to mask, term and exclusion lists, canary sentences and leak probes, and the project's gate policy.

**Kinds of experiment** are shapes of scenario, not separate machinery: comprehension is a single interview phase; adherence is a full episode; classification of agents' findings is judging applied to outcomes the project supplies.

---

## 6. Entity model and interfaces

| Entity | Holds |
|---|---|
| Experiment | Scenarios, factors and their levels, runs per cell, pre-registered rules |
| Scenario | Surface tags, entries exercised, fixture, phases, trap pairs, probes |
| Property | Key text, type (adherence, precision, comprehension), guidance named, decided by code or judge |
| Arm | A level of the context factor: sources, delivery, revision |
| Cell | One (scenario, arm, model, run) |
| Episode | A cell's phases and branches, with their outcomes |
| Outcome | Final message, diff, events, cost, validity and cause |
| Vote | A judge's score and reason for one property of one outcome |
| Result | Pass rates per property and factor level, agreement, limits |
| Run record | All of the above for one run, plus configuration, revisions and the sealed map |

**Interfaces.**

- **Pack to core:** a directory the pack checker validates; nothing project-specific is read from anywhere else.
- **Core to runtime:** the runtime adapter contract - given an arm configuration, a workspace, a prompt and an optional session, return events, final message, exit status and cost in one common form, regardless of runtime.
- **Core to project:** the run record, written where the project names, and the result; the project decides what is published.
- **Core to person:** calibration pairs presented one at a time, answered with a pick.

---

## 7. Run time

**A run** moves through: prepared, isolation proven, cells complete, blinded, judged, tallied, and - for a change gate - verdict given.\
It stops at isolation if any arm fails its probes, and an arm that cannot be proven never runs.

**A cell** is valid, or invalid for one cause: infrastructure (re-run once), agent behaviour (not re-run; unreached properties score 0; cost counted), or isolation (re-run once).

**An episode** runs P1 work, P2 handoff in the same session, two P3 branches in fresh sessions from the agent's own note and from a neutral note generated from the fixture and the P1 diff, and P4 interview in a fresh session reading only the arm's local context.\
Each trap pair is met once per episode; position and version rotate across runs and models.

**The gate** compares base and head with three runs per cell, flags a property whose pooled drop exceeds the three-run A/A threshold, extends it to nine runs, and reports a drop that still exceeds the nine-run threshold as persisting.

---

## 8. Verification

- **Every run proves its own isolation:** each arm, on each runtime, answers leak probes and quotes its canary before any cell runs.
- **Behaviour tests per component,** each refusal mutation-tested: removed from the code to show the test fails.
- **A/A runs** set the gate's thresholds, and a held-out A/A run checks them.
- **Human calibration** checks agent judges on outcomes meant for a person.
- **Every run record re-tallies** to the same result from its votes and sealed map.

---

## 9. Risks, divergence, and the owed-and-open register

| # | Owed or open | Why it matters |
|---|---|---|
| 1 | Session continuation under isolation is unprobed on both runtimes | The episode driver depends on it |
| 2 | Whether each runtime's compaction keeps instruction files is unknown | P3 assumes it |
| 3 | No failure injection exercises the validity classifier (`A9`) | Its causes are asserted, not tested |
| 4 | Blinding to arm fails where guided output reads differently | Judge scores on such properties lean on code-scored ones |
| 5 | Adapters exist for two runtimes only | Generality across runtimes is a claim, not a measurement |
| 6 | No second model tier is named for two of three families | Tier is confounded with family |
| 7 | Provider content filters and rate limits are uncharacterised | They cause invalid cells that cluster by family |
| 8 | Local delivery differs from network fetching | An on-trigger arm does not reproduce a networked session exactly |
