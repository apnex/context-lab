---
instant: target
---

# context-lab - system architecture, target

**Instant: target.** context-lab described as the system it is when the ratified decisions about it are built.\
Its current architecture is empty; the mechanism it generalises runs inside its first two users, mission-kit and zorg.

Written in the present tense of a system that exists.\
It contains no plan, order or estimate; those belong to the board and to deltas.

---

## 1. Status and authority

Authored by the architect, ratified by the director per section; approval is aggregate-only.\
Ratified 2026-10-10 (`docs/DECISIONS.md` `0006`); sections 2, 3, 5, 6 and 9 reopened and updated 2026-10-16 (`0025`, `0026`, `B18`).

| Section | Maturity | Reopens on |
|---|---|---|
| 2 Identity, scope, non-goals | approved | A ruling that changes scope, or a project needing an experiment outside it |
| 3 Justification chain | approved | A ruling added to `docs/DECISIONS.md` |
| 4 Axiom alignment | approved | A change to traits, or a tension discharged or found |
| 5 Anchored core | approved | A duty with no owner, or one owned twice |
| 6 Entities, the pack, interfaces | approved | A project putting something project-specific outside its pack |
| 7 Run time | approved | A state a run reaches that is not listed |
| 8 Verification | approved | A claim about the system with no check |
| 9 Owed and open | approved | Any row closed or added |

| Field | Value |
|---|---|
| Programme purpose | [`VISION.md`](../VISION.md) - cited, never restated |
| Rulings | [`docs/DECISIONS.md`](DECISIONS.md) |
| Provenance | mission-kit `docs/evals/standing/DESIGN.md` and rulings `0083`-`0089`, which are about mission-kit; this system rests on its own rulings, of which `0004` adopts the universal parts of that design |

---

## 2. Identity, scope and non-goals

**Identity.** context-lab runs experiments on the context language-model agents are given, and reports what each experiment showed.\
A project supplies everything specific to it as a **project pack**; the operator supplies the environment - credentials, installed agent runtimes, a working directory, parallelism; context-lab supplies the rest.

**Scope.**

- Experiments whose factors are context - content, manner, amount, moment of delivery, source revision - with models, agent runtimes and their settings as declared factors.
- Comprehension, behaviour, precision and cost as measured outcomes.
- Judging by code where a check can decide, by agents of other model families where reading is needed, by chains of agents where one classifies and another verifies, and by people where the outcome is for a person.
- On-demand multi-model review of a project artifact or prompt across distinct model families, with optional cross-family verification (`0025`, `0026`, `B18`).

**Non-goals.**

- Ranking models.
- Holding any project's experiments, answer keys, run records or conclusions.
- Editing any project's working context.
- Approving or blocking a project's change: a comparison flags; the project decides.
- Experiments on live systems without their owner's recorded consent.

---

## 3. Justification chain

**Domain.**\
Agents act on what is put in front of them, and projects shape it by writing guidance, choosing what loads and when, and summarising history.\
In the one corpus measured, mission-kit, whether a shaping helped was asserted by its author, from one session, with the same model judging, until an evaluation tool replaced that practice - an observation about one project, inferred to be common.

**Axioms.**\
In force by this system's traits (section 4): `A1`, `A3`-`A14`.\
`A2` is not: nothing reconciles a running state to a declaration.

**North star of this system.**\
Every result is attributable to the declared differences between conditions alone, or states what else differed.

**Principles.**

| | Principle | From |
|---|---|---|
| P1 | **Probed, not assumed.** What each agent received, and the absence of named withheld content, is probed in every run | `A8`, `A5` |
| P2 | **Code before judges.** What a check can decide is decided by code | `A11` |
| P3 | **Independent judgement.** No model family judges its own outcomes; a person judges, or checks the judges of, outcomes meant for a person | `A8`, `A13`; vision is-not 7 |
| P4 | **Rules and status before outcomes.** Judging rules, decision rules, and whether an experiment is held out or exploratory are fixed and recorded before its outcomes exist | `A8`, `A14`; vision is-not 5, succeeding 5 |
| P5 | **The project owns its content.** Everything project-specific enters through the pack | vision is-not 6 |
| P6 | **One place per runtime.** Everything that must be known about an agent runtime sits in its adapter | `A3`; vision is-not 8 |
| P7 | **Failure is data.** A failed cell is classified by cause and reported, never dropped or retried until it passes | `A7`, `A4` |
| P8 | **Whole records.** A run keeps everything needed to repeat it, audit it and re-tally it | `A4`, `A1`; vision succeeding 3 |
| P9 | **Evidence, not verdicts.** A comparison flags; the project's authority decides | `A13`; vision non-authority 2 |

**Decisions.**\
`0001` the vision; `0002` all four existing mechanisms are absorbed; `0003` packs may carry scripts at fixed hooks; `0004` the universal parts of mission-kit's standing-suite design are adopted, and `0005` a note-generator hook is added to `0003`'s three; `0008` suites are an entity; `0009`-`0024` Delta-1 and Delta-2; `0025` and `0026` Delta-3 and on-demand multi-model review (`B18`).

**Model.**\
Single-duty components (section 5), each serving a principle, driven by a project pack through fixed hooks, producing a run record the project keeps.

---

## 4. Axiom alignment

**Traits.**\
Stateful - it writes run records, thresholds and calibration history, and reads them back.\
Multi-agent - one actor's output is another's input: an agent's outcome to its judges, a classifier's to its verifier, an outcome to a person.\
Autonomous - a run proceeds and classifies its own failures with no person watching.\
LLM-in-the-loop - judges' conclusions decide scores.\
Not declarative.

| Axiom | Stands | Tension |
|---|---|---|
| `A1` | Run state and every cell's validity are in the run record | Open: thresholds and calibration history span runs, and live in the project's record, so their state is as visible as the project keeps it |
| `A3` | Single-duty components; runtimes behind adapters (P6); project code behind hooks | Open: a hook is project code inside the core's run |
| `A4` | Whole records (P8); results carry limits | - |
| `A5` | Probes show what each agent received (P1) | Deliberate: judges see masked outcomes, not what the agent saw |
| `A6` | Actors hand over through declared records - outcomes, notes, votes | Open: repetition for independence - two judges, a verifier re-reading a classifier - is friction bought for `A8` |
| `A7` | Failures classified by cause (P7) | Open: re-running infrastructure and isolation failures once selects which attempts count; bounded by once-only and reported per arm |
| `A8` | Sealing order: variants probed before cells run, outcomes blinded before judging, rules fixed before outcomes | Open: blinding to arm was not achieved on one trap in one run, mission-kit's `adherence-03`; tested per property |
| `A9` | - | Open: no failure injection exercises the validity classifier |
| `A10` | - | Open: no loop files context-lab's own invalid-cell causes and audit findings as its defects |
| `A11` | Code before judges (P2) | Irreducible: judging prose is cognitive work |
| `A12` | Judge prompts carry instructions, task, key, starting state and outcomes, nothing else | - |
| `A13` | People judge outcomes meant for them (P3); comparisons are evidence (P9) | - |
| `A14` | Durable records; candidate findings | Open: findings travelling between projects has no mechanism beyond records a project chooses to share |

---

## 5. The anchored core

Each component has one duty and serves at least one principle.

| Component | Duty | Consumes | Exposes | Serves |
|---|---|---|---|---|
| **Pack checker** | Validates a project pack | A pack; its declaration-check hook | Every defect, or a pass | P5 |
| **Experiment register** | Fixes an experiment before it runs | An experiment from the pack; the changes a project declares its held-out outcomes informed | Its content hash; its status, result or exploration; for each held-out scenario, which changes its outcomes have informed | P4 |
| **Selector** | Chooses scenarios by their declared tags | Tags requested; the pack's scenarios | A scenario set, a named suite resolved to its scenarios, and the generated entry-to-scenario view | North star, P5 |
| **Variant builder** | Builds one context variant | A source and revision; the variant declaration; the pack's transform hook | A local, read-only copy, its addresses rewritten to itself, its canaries planted | P1, P5 |
| **Arm composer** | Composes one arm, runtime-neutral | Variants; the arm declaration | An arm: what reaches the agent, and by which delivery - instruction, folder file, on request | P6 |
| **Workspace builder** | Creates an isolated workspace | A fixture; the pack's forbidden paths; the rules-file names each adapter declares | A workspace with an opaque name, no rules file above it, its initial commit | P1 |
| **Runtime adapter** | Runs one agent invocation on its runtime | An arm, a workspace, a prompt, a delivery mode, a session, settings | Events, final message, cost, tool paths and fetches, filter flags, in the common form | P6 |
| **Isolation prober** | Probes what an arm received | An arm on an adapter; the pack's canaries and leak probes | Per arm and runtime: a pass only if every canary was quoted, no probe showed a leak, and at least one probe was answered rather than filtered | P1 |
| **Phase driver** | Executes a scenario's declared phases | A scenario, an arm, a population member; the pack's note-generator hook | Phase outcomes, notes, branch outcomes | North star |
| **Answer parser** | Splits a reader's answer into answers per probe | An answer; the self-explanation marker | Answers per probe, the self-explanation removed | P2 |
| **Validity classifier** | Classifies a cell by cause | A cell's normalised events and paths; forbidden paths and addresses | Valid, or invalid: infrastructure, behaviour or isolation | P7 |
| **Code measurer** | Scores what a check can decide | Unmasked outcomes; term and exclusion lists; measure hooks | Code scores; routing traces, diagnostic and never scored; restated-guidance flags | P2 |
| **Blinder** | Blinds outcomes for judging | Valid outcomes; identifier patterns; fixture paths | Masked outcomes under opaque ids, with their sealed mapping | P3 |
| **Judge panel** | Obtains validated votes on blinded outcomes | Masked outcomes; the declared judging - judges, families, chains, order, response schema | Votes, each validated, with arm guesses; unparseable replies retried, then incomplete | P3 |
| **Pair chooser** | Chooses outcome pairs for a person | Outcomes, votes, the declared rule - preference pairs, or calibration pairs from one scenario and arm that judges scored apart, over-sampled where judges scored high | Pairs | P3 |
| **Human panel** | Obtains a person's picks on paired outcomes | Pairs | Picks, fault tags | P3 |
| **Tally** | Computes results per factor | Votes, code scores, picks, the sealed mapping, the experiment's stated variation | Pass rates, held-out scenarios reported apart, agreement, arm-guess rates, the comprehension-behaviour link, judge-person agreement, the variation achieved against the variation stated | P8 |
| **Threshold deriver** | Derives decision thresholds from A/A results | Results of a condition compared with itself | A threshold set per size, with its false-alarm rate | P4 |
| **Comparator** | Compares two results under a declared rule | Two results; the rule - per-property tolerance, a property absent from the head counting as a drop; A/A threshold with extension; or improve-without-worsening across families | Flags, held-out scenarios reported apart, never a verdict | P9 |
| **Candidate writer** | Writes candidate findings from results | Results; the pack's finding rules | Candidates with evidence, for the project to triage | P9 |
| **Run conductor** | Conducts a run through its lifecycle | An experiment and its factors, or a suite by name | The run record: configuration, method version, revisions, consent, events, outcomes, votes, mapping, results | P8 |
| **Review panel** | Orchestrates an on-demand review prompt across members of distinct model families and cross-verifies their findings (`0025`, `0026`, `B18`) | A pack's population, adapters, a prompt and read-only files | Per-family findings, cross-family verification verdicts, and supporting family counts | P1, P3, P6, P8 |

**Adapters.**\
Each agent runtime has one, and one **external** adapter hands prompts out and takes answers back, for any harness context-lab does not drive.\
An adapter owns its runtime's configuration format, where it places instructions, which rules files it loads, its session continuation, its delivery modes - inline, file pointer, standard input, attachment - its event shape, and its content-filter signal.

**Kinds of experiment are declarations, not machinery.**\
A comprehension run is one phase in which a reader answers probes, parsed by the answer parser and judged on a declared scale; an adherence run is a multi-phase episode; human preference is the human panel as primary judge; classify-then-verify is a declared judging chain whose second stage counts only what it verifies.

---

## 6. Entities, the pack, interfaces

| Entity | Holds |
|---|---|
| Pack | Everything project-specific, listed below |
| Suite | A name, a selection of scenarios by tag, and the experiment that runs them - `0008` |
| Experiment | Scenarios, factors and levels, runs per cell, rules, the variation it can detect and the default taken when nothing is detected - all stated before outcomes - status, hash |
| Scenario | Tags, fixture, phases, trap pairs, probes, held-out flag |
| Property | Key, type - adherence, precision, comprehension - guidance named, decided by code or judge, scale |
| Population member | Model, family, tier, runtime, settings such as reasoning effort |
| Variant | Source, revision, transform, canaries, address rewrites |
| Arm | Variants and their delivery |
| Cell | Scenario, arm, population member, run, trap version and position |
| Outcome | Final message, diff, events, cost, wording used, validity and cause |
| Note | A phase's handoff - the agent's own, or generated by a declared generator |
| Vote | Judge, score, reason, arm guess |
| Pick | Person, pair, choice, fault tags |
| Threshold set | Rule, size, threshold, false-alarm rate, the A/A runs it came from |
| Result | Rates per property and factor level, agreement, limits, which validity rules it met |
| Candidate finding | Rule triggered, evidence |
| Review packet | Prompt, read-only files, reviewer replies, extracted findings, cross-family verification verdicts, supporting families (`0026`, `B18`) |
| Consent | Owner, material, scope, when given - required for any experiment touching material not built for it |
| Run record | All of the above for one run |

**The pack, exhaustively.**\
Experiments and suites; context sources and revisions; variant declarations; delivery declarations; the population and judge assignment; identifier patterns to mask; self-explanation markers; term and exclusion lists; canaries and leak probes; forbidden paths and addresses; reader and judge instructions, response formats and launcher wordings; decision rules and run sizes; finding rules; calibration policy; consent records; where the run record is kept; and its hooks.\
Nothing project-specific is read from anywhere else.

**Hooks, by decision `0003`.**

| Hook | Called by | Contract |
|---|---|---|
| declaration check | Pack checker | Reads the pack; returns defects |
| variant transform | Variant builder | Reads a source copy; writes a variant into a given folder |
| outcome measure | Code measurer | Reads one unmasked outcome; returns named scores |
| note generator | Phase driver | Reads the fixture and a phase's diff; returns a note - added by `0005` |

A hook receives its inputs as one JSON document, returns one, runs with no network, reads only what it is given, writes only where told, and is stopped at a time limit.\
If it fails: a declaration check fails the pack; a variant transform leaves its arm unbuilt, and the arm does not run; an outcome measure leaves its properties incomplete; a note generator leaves its branch incomplete.

**Interfaces.**\
Pack to core: a directory, validated before anything runs.\
Core to runtime: the adapter contract, one common form whatever the runtime.\
Core to judge: masked outcomes and a response schema, by a delivery mode the judge's adapter supports with tools off.\
Core to person: one pair at a time, answered with a pick.\
Core to project: the run record and the result, written where the pack says; the project decides what is published.

---

## 7. Run time

**A run** moves through:

1. **validated** - the pack passes its checker;
2. **recorded** - the experiment register fixes it; a run of an unrecorded or changed experiment is exploration, whatever it was declared;
3. **built** - every variant and arm composed;
4. **probed** - every arm on every runtime; an arm without a pass never runs, and is reported;
5. **executed** - every cell to an outcome;
6. **measured** - code scores on unmasked outcomes, against term lists frozen for the run;
7. **blinded**, **judged**;
8. **picked** - where the experiment declares a person judges or calibrates;
9. **tallied**;
10. optionally **compared**, and **candidates written**.

A run of a condition against itself ends at tallied, and the threshold deriver turns its results into a threshold set.

**A cell** is valid, or invalid for one cause: infrastructure, including a content filter (re-run once); agent behaviour, judged from the event trace (not re-run; unreached properties score 0; cost counted); or isolation (re-run once).

**An episode** is the scenario's declared phases and branches, each starting in the same session or a fresh one, from the workspace and, if declared, a note; a phase that fails ends its episode.\
Each trap pair is met once per episode, its version and position rotated across runs and population as the experiment declares.

**A comparison** applies its declared rule; an A/A-calibrated rule extends a flagged property by its declared runs and reports a flag that persists at the larger size.

---

## 8. Verification

- **Every run probes its own isolation** before any cell runs: canaries quoted, a negative canary absent where declared, leak probes answered.
- **Judges' isolation** is probed as agents' is.
- **Every component has behaviour tests,** each refusal mutation-tested.
- **Every adapter passes one conformance suite** for the common form.
- **The core reads nothing project-specific:** its tests run against two packs with disjoint vocabularies.
- **Every hook is called under its contract** in tests: no network, bounded reads and writes, a time limit.
- **Every run record re-tallies** to its result from its votes, picks and mapping.
- **Repeatability is itself tested:** a recorded experiment, repeated, is compared under its declared rule.

---

## 9. Owed and open

| # | Owed or open | Why it matters |
|---|---|---|
| 1 | **CLOSED** (`0024`, `B2`): session continuation probed and implemented on both runtimes (`docs/probes/2026-10-11-sessions.json`) | Multi-session phases depend on it |
| 2 | **CLOSED** (`0024`, `B3`): compaction keeps instruction files on both runtimes (`docs/probes/2026-10-11-sessions.json`) | Experiments simulating compaction assume it |
| 3 | No failure injection exercises the validity classifier (`A9`) | Its causes are asserted, not tested |
| 4 | Blinding to arm was not achieved on one trap | Judge scores on such properties lean on code-scored ones |
| 5 | Two runtimes have adapters | Generality across runtimes is a claim |
| 6 | Content filters and rate limits are uncharacterised; filter-caused failures clustering by provider is inferred from one provider | Invalid cells may cluster by family |
| 7 | Local delivery differs from fetching over a network | An arm reading files does not reproduce a networked session exactly |
| 8 | Findings travelling between projects has no mechanism beyond shared records (`A14`) | The vision's fourth success measure has no support |
| 9 | No loop files context-lab's own failures as its defects (`A10`) | It does not correct itself |
