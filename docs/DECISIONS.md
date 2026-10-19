# context-lab - decision register

The director's rulings on context-lab, one record per ruling.\
A decision register in the form mission-kit's `AR4` type prescribes: a ruling is changed only by a later row that supersedes or amends it, never by editing the row.

---

## Status

**Authority.**\
The director, for every row; rows are drafted by agents.

**Earlier rulings held elsewhere.**\
The rulings that founded this component were made while working in mission-kit and are recorded in its register: `0087` (the universal part of agent evaluation is a component in its own repository) and `0088` (its name and north star).\
They are not copied here; this register starts at the vision.

---

## Decision records

| id | date | ruling | authority | status | lineage |
|---|---|---|---|---|---|
| 0001 | 2026-10-10 | The vision in `VISION.md` is ratified. | director | ratified | - |
| 0002 | 2026-10-10 | context-lab absorbs every existing evaluation mechanism of its first users: comprehension runs, adherence runs, human preference judging, and classify-then-verify judging chains. | director | ratified | - |
| 0003 | 2026-10-10 | A project pack holds data and, at a few fixed points each with a stated contract, project scripts: measuring outcomes, building context variants, and checking declarations. | director | ratified | - |
| 0004 | 2026-10-10 | context-lab adopts the universal parts of mission-kit's standing-suite design, listed in its record, and none of its mission-kit-specific choices. | director | ratified | - |
| 0005 | 2026-10-10 | A fourth hook point, the note generator, is added to the three of `0003`. | director | ratified | amends 0003 |
| 0006 | 2026-10-10 | The target architecture in `docs/ARCHITECTURE-TARGET.md` is ratified, every section approved. | director | ratified | - |
| 0007 | 2026-10-10 | Milestone M1, a core that runs one-phase experiments with isolation proven, is the first move, opened as context-lab's first delta. | director | ratified | - |
| 0008 | 2026-10-10 | A suite - a named, saved selection of scenarios with the experiment that runs them, held in the pack - is an entity of the architecture, built in the first delta. | director | ratified | - |
| 0009 | 2026-10-10 | Delta-1 is ratified, revision 3, built in TypeScript following zorg's layout: npm workspaces, `tsc -b` under strict settings, `node --test`, Node 24 or later, development dependencies only. | director | ratified | - |
| 0010 | 2026-10-10 | Delta-1's stage amendments are confirmed: E3's run-record clause is evaluated at stage 4, and E12 is completed across stages 1, 2 and 4. | director | ratified | - |
| 0011 | 2026-10-10 | Delta-1's stage 2 amendment is confirmed: E13's run-record clause is evaluated at stage 4. | director | ratified | amends 0010 |
| 0012 | 2026-10-10 | An opencode cell that times out with a step open is classified infrastructure on its first attempt and behaviour on a re-run; the run conductor passes the attempt count to the classifier. | director | ratified | - |
| 0013 | 2026-10-11 | Delta-1's E14 is evaluated at stages 4 and 5: stage 4 times every code score inside measuring; stage 5 compares each with its outcome's blinding. | director | ratified | amends 0010 |
| 0014 | 2026-10-11 | mission-kit's explain suite is carried as one cell per reader, all four questions in one prompt with its wording verbatim, the answer file split per question for judging. | director | ratified | - |
| 0015 | 2026-10-11 | For a runtime in the filesystem sandbox, a forbidden path the agent names is recorded and does not invalidate the cell; a forbidden address still does, the network being shared. | director | ratified | - |
| 0016 | 2026-10-11 | Comprehension answers are judged in eval.mjs's scorer form verbatim but for one change: judges reply with their score lines instead of writing a file and replying DONE. | director | ratified | - |
| 0017 | 2026-10-11 | Delta-1 is complete: every exit criterion was evaluated green by an agent that built none of the code. | executor, evaluated by the verifier | recorded | - |
| 0018 | 2026-10-11 | Milestone M2, multi-phase episodes and the change gate, is the next move, opened as Delta-2. | director | ratified | - |
| 0019 | 2026-10-11 | Delta-2 is ratified, revision 3: a gate runs base and head as two arms of one run; the gate rule is the largest standardised drop over m properties against a threshold exceeded one time in ten under A/A, persistence tested on nested sets; mission-kit's handoff and A/A experiments state a pooled detectable difference of 0.25 in pass rate, with the default that no change is indicated. | director | ratified | - |
| 0020 | 2026-10-12 | In a multi-phase episode, a phase invalid for agent behaviour ends only the phases that follow from it; phases on other branches run and are judged. Delta-2's episode rule and F4 are restated to match, F4 for withheld files. | director | ratified | amends 0019 |
| 0021 | 2026-10-14 | Delta-2's live criteria F13, F14 and F15 are run on a new population: the four models of the new LiteLLM endpoint, through opencode, and GPT, through Codex. The old endpoint is not used again, and the thresholds from the first A/A run stay in the register, superseded. | director | ratified | amends 0019 |
| 0022 | 2026-10-14 | In Delta-2's live runs on the new population, one member of each family judges - Claude Opus 5.5, Gemini 4 Argon, Grok 4.20 and GPT - so every outcome has three judges, none of its agent's family. | director | ratified | amends 0021 |
| 0023 | 2026-10-14 | Delta-2 is amended to include run resumption (`B16`): a run stopped during execution (after probing, before blinding) may be resumed from its completed cells once the experiment hash, variant manifests, model routes and recorded cell files are verified intact. | director | ratified | amends 0019 |
| 0024 | 2026-10-14 | Delta-2 is complete: every exit criterion (F1 to F15) was evaluated green by an agent that built none of the code, F4's trap-file clause is confirmed, M2 is done (`B2`, `B3`, `B12`, `B16` closed), and the five-member `adherence` and `explain` baseline runs in mission-kit are selected next. | director | ratified | amends 0019 |
| 0025 | 2026-10-16 | Milestone M3 (M3.1 and M3.2), together with B18 (on-demand multi-model review orchestration), is selected from the board and opens as Delta-3. | director | ratified | - |
| 0026 | 2026-10-16 | Delta-3 is ratified, revision 2, including the reopening of `docs/ARCHITECTURE-TARGET.md` for `B18` (Review panel as the 22nd component) and the explicit retirement disposition in G11. | director | ratified | amends 0006, 0025 |
| 0027 | 2026-10-17 | Delta-3 is complete: every exit criterion (G1 to G12) was evaluated green by an agent that built none of the code, milestone M3 is done (`B1`, `B11`, `B18` closed), and milestone M4 (Hardening: `M4.1` `B4`, `M4.2` `B7`, `M4.3` `B5`) is selected next as Delta-4. | director | ratified | - |
| 0028 | 2026-10-17 | Delta-4 is ratified, revision 2: end-to-end failure injection across all 9 fault modes (`H1`), provider fault characterisation in `Result.faults` and `docs/probes/2026-10-17-provider-faults.json` (`H2`), per-scenario and per-property arm-guess blinding (`notBlind` when `all >= 6 && rate >= 0.75 && rate > baseRate + 0.25`, `H3`), and closing `B4`, `B5`, `B7` and milestone M4 (`H4`). | director | ratified | - |
| 0029 | 2026-10-17 | Delta-4 is complete: every exit criterion (H1 to H4) was evaluated green by an agent that built none of the code, closing `B4`, `B5` and `B7` and completing milestone M4 (all four planned milestones M1-M4 on context-lab's board are done). | director | ratified | - |
| 0030 | 2026-10-17 | `README.md` (in `S4`/`S9` four-journey layout) and `docs/OPERATIONS.md` document all 13 CLI commands, the complete `context-lab.pack/1` schema, a copy-pasteable minimal pack, and step-by-step operator workflows, verified by dogfooding `context-lab` on itself across all 5 models with `packages/` excluded (`2.80/10 -> 10.00/10`, `P0` `0/5 -> 5/5` passing `checkPack`). | director | ratified | - |
| 0031 | 2026-10-18 | The result reports each arm's mean cost (`costs`) and, per hydration row, the adherence of cells that hydrated the entry and of those that did not; hydration rows count cells and are written only for arms with an on-request folder and no instruction or folder file named for the entry, from arm deliveries now kept in the run record; `candidates` gains `routing-miss` and `hydrated-not-acted`; and a probe retry after a tool call says no entry is mounted. | director | ratified | amends 0004 |
| 0032 | 2026-10-18 | The result reports each judge's dissent (`judgeDissent`); `candidates` gains rule 7, `judge-outlier`; rules 5 and 6 read only guidance a scenario declares it exercises, and rule 6 is written once per scenario, property and arm. | director | ratified | amends 0031 |
| 0033 | 2026-10-18 | Each cost row also gives the median input tokens and the costliest cell. | director | ratified | amends 0031 |
| 0034 | 2026-10-18 | `compare` refuses an A/A threshold set derived on other members, scenarios or judges than the run it judges, and threshold sets record their judges; `check` names every experiment that declares `result` but would run as exploration. | director | ratified | amends 0019 |

---

### 0001

**Ruling.**\
`VISION.md` is ratified as it stood at this commit.

**How it was reached.**\
Each section was settled in a guided dialogue with the director - the north star, what this is and is not, succeeding, and what holding it does not authorise - then audited by an agent that did not write it.\
The audit's findings were applied, and three wording points were ruled by the director: models are declared factors in an experiment, "anyone" means anyone holding an experiment's record, and agents are language-model agents acting with tools.

**Alternatives refuted.**\
Ratifying after further changes, or deferring - offered, not chosen.

**Source.**\
`[V, director ruling 2026-10-10]`

### 0002

**Ruling.** context-lab is the home of all four mechanisms its first users run today.

**Alternatives refuted.**\
Comprehension and adherence only, leaving human preference and classify-then-verify judging in their projects - refuted because the vision requires that judgement not made by a person is checked against theirs, and classify-then-verify is a judging method any project can use.\
Adherence only - refuted because the vision measures comprehension and behaviour each in its own right.

**Source.**\
`[V, director ruling 2026-10-10, after an independent audit of the first architecture draft]`

### 0003

**Ruling.**\
A project pack may carry scripts at fixed hook points with stated contracts.

**Alternatives refuted.**\
Data only, with anything code-like first generalised into the core - refuted because both first users already hold project-specific code of exactly these kinds, and the core would grow with, and wait on, every project's needs.

**Consequence.**\
The core runs project code, so each hook's inputs, outputs and access are bounded by its contract.

**Source.**\
`[V, director ruling 2026-10-10]`

### 0004

**Ruling.** context-lab adopts from mission-kit's standing-suite design (`docs/evals/standing/DESIGN.md`, mission-kit `0086`) its universal parts, including:

- pinned, local delivery of each context variant, every address of the source rewritten to the local copy, canaries proving it was read and a negative canary proving a variant was not, and network fetches of the source treated as isolation failures;
- isolation probed for every arm and runtime before any cell runs, judges included;
- judging by the model families that did not produce an outcome, and by code wherever a check can decide, run on unmasked outcomes before blinding;
- blinding tested per property by judges' guesses at the arm;
- invalid cells classified by cause, with behaviour failures scored and costed rather than re-run;
- comparison rules calibrated by A/A runs, flagging rather than deciding;
- multi-phase episodes with fresh sessions and branches, notes generated from the workspace, as a declarable scenario shape;
- trap pairs met once per episode, rotated across positions;
- the comprehension-behaviour link, restated-guidance flags, and the variation an experiment can detect stated before its outcomes;
- calibration of agent judges against a person, by pairs from one scenario and arm;
- candidate findings written for a project to triage;
- scenarios tagged by what they exercise, with the reverse view generated.

It also adopts two parts the design does not hold, from the vision (is-not 5 and succeeding 5), zorg's held-out flag and mission-kit's calibration flag in `tools/adherence.mjs`: held-out scenarios, and exploration status for an experiment changed after its outcomes were seen.

It adopts none of the design's mission-kit-specific choices - its four arms, its population, its run sizes and cadence, its thresholds, its digest and its misreading register - which a project declares in its pack.

**Status.**\
Ratified with the target architecture (`0006`).

**Source.**\
`[V, mission-kit docs/evals/standing/DESIGN.md; independent audit and re-check of the architecture drafts]`

### 0005

**Ruling.**\
Amends `0003`: a fourth hook, the note generator, lets a project generate the note a phase starts from.

**Why.**\
A phase starting from a note needs one that matches the workspace the earlier phase left, which a fixed note cannot, and how to summarise a project's work is project-specific.

**Status.**\
Ratified with the target architecture (`0006`).

**Source.**\
`[V, re-check of the architecture redraft, which found four hooks against 0003's three]`

### 0006

**Ruling.**\
The target architecture is ratified, every section approved; each reopens on the trigger its status table names.

**How it was reached.**\
Drafted, audited by an agent that did not write it, redrafted in its core, re-checked, and corrected; `0004` and `0005` were ratified with it.

**Alternatives refuted.**\
Ratifying with changes, or reading a section first - offered, not chosen.

**Source.**\
`[V, director ruling 2026-10-10]`

### 0007

**Ruling.**\
M1 is selected from the board as the first move, and opens as the first delta.

**Alternatives refuted.**\
Starting with the session and compaction probes (M2.1) - not chosen; cheaper, but nothing would run end to end and the two copies would keep diverging.\
Reordering the board - offered, not chosen.

**Source.**\
`[V, director selection 2026-10-10; docs/BOARD.md]`

### 0008

**Ruling.**\
Suite is an entity: a named, saved selection of scenarios with the experiment that runs them, held in the pack, re-run by name.

**Alternatives refuted.**\
Projects keeping their own lists of scenario tags - refuted because a suite could not then be re-run by name across projects or over time, against the vision's repeatability.

**Source.**\
`[V, director ruling 2026-10-10, on whether a study of many designed applications could form a suite]`

### 0009

**Ruling.**\
Delta-1 is ratified, built in TypeScript in the layout of the organisation's TypeScript components.

**Alternatives refuted.**\
TypeScript run directly by Node with no build step - refuted because it departs from the components' `tsc -b` convention and limits the syntax allowed.\
Plain JavaScript, as first drafted after mission-kit's own tools - refuted because those are scripts in a knowledge base, not components.

**Source.**\
`[V, director rulings 2026-10-10; zorg package.json and tsconfig.json; agp, entity-api, entity-store tsconfig.json]`

### 0010

**Ruling.**\
The executor's amendments to Delta-1's stage assignments, made after stage 1's verification, are confirmed.

**Alternatives refuted.**\
Keeping E3 and E12 at stage 1 - refuted because each needs a component a later stage builds, so stage 1 could not close without building part of stage 4 first.

**Source.**\
`[V, director confirmation 2026-10-10; docs/DELTAS/DELTA-1.md Record]`

### 0011

**Ruling.**\
E13's clause that the run record names a variant's revision moves to stage 4; stage 2 proves the rest, and the variant's manifest records the revision meanwhile.

**Alternatives refuted.**\
Holding the clause at stage 2 - refuted because it needs the run record stage 4 builds.

**Source.**\
`[V, director confirmation 2026-10-10; docs/DELTAS/DELTA-1.md Record, stage 2]`

### 0012

**Ruling.** opencode reports a tool only when it ends, so a timeout with a step open cannot be told from a stalled provider; it is a provider fault the first time and the agent's behaviour if the re-run also times out.

**Alternatives refuted.**\
Always a provider fault - refuted because an opencode agent stuck in a long command would never be scored for it, flattering opencode agents against Codex ones.\
Always the agent's behaviour - refuted because a stalled provider would count against the agent, penalising slower providers.

**Source.**\
`[V, director ruling 2026-10-10; docs/DELTAS/DELTA-1.md Record, stage 3 verification]`

### 0013

**Ruling.**\
E14's comparison of each code score with its outcome's blinding moves to stage 5, where the blinder is built.

**Alternatives refuted.**\
Holding E14 at stage 4 - refuted because no blinding exists before stage 5.

**Disclosed.**\
The delta's text was changed for this restaging before the director confirmed it.

**Source.**\
`[V, director confirmation 2026-10-11; docs/DELTAS/DELTA-1.md Record, stage 4]`

### 0014

**Ruling.**\
The explain experiment runs one cell per reader, with mission-kit's reader prompt verbatim - all four questions, the answer-file and observations lines included - and its answer file split per question before judging.

**Alternatives refuted.**\
One cell per question, adapting the wording - refuted because Delta-1 carries suite wording as it is, and because it breaks comparability with mission-kit's earlier explain runs.

**Source.**\
`[V, director ruling 2026-10-11; Delta-1 stage 4 verification]`

### 0015

**Ruling.**\
A path outside the sandbox does not exist for a sandboxed agent, so naming it is an attempt that cannot succeed: it is recorded and reported, and the cell stands.

**Alternatives refuted.**\
Voiding the cell on any attempt - refuted because curious agents would spend their re-run and be excluded for something that could not happen.

**Source.**\
`[V, director ruling 2026-10-11; Delta-1 stage 5 smoke run and verification]`

### 0016

**Ruling.**\
The comprehension judge prompt keeps eval.mjs's scorer lines, replacing only the instruction to write a file and reply DONE with an instruction to reply with the lines.

**Alternatives refuted.**\
Letting judges write a file - refuted because it gives judges tools, which the tools-off rule exists to prevent.

**Source.**\
`[V, director ruling 2026-10-11; Delta-1 stage 5 verification]`

### 0017

**Record.**\
Delta-1 reached its to-state: a core that runs one-phase experiments, isolation probed, through to a tallied result, with mission-kit's adherence and `explain` suites running on it.\
Every exit criterion was evaluated green by an agent that built none of the code; the evaluation is in the delta's Record.\
This is a record of completion under the ratification of `0009`, not a new ruling.

**Source.**\
`[V, docs/DELTAS/DELTA-1.md Record, closing evaluation]`

### 0018

**Ruling.**\
M2 is selected from the board, ahead of M3, and opens as Delta-2.

**Alternatives refuted.**\
M3, zorg's pack and human judging - not chosen; the standing suite's question, whether guidance survives a long session or a compaction, needs multi-phase episodes first.

**Source.**\
`[V, director selection 2026-10-11]`

### 0019

**Ruling.**\
Delta-2 is ratified as revision 3, with its three open points settled as recommended: one run with two arms for a gate; the gate rule as drafted; a stated variation of 0.25 pooled for mission-kit's two new experiments, defaulting to no change indicated.

**Alternatives refuted.**\
Two separate runs for a gate - refuted because provider drift between runs would read as a change, and mission-kit's design runs base and head as arms of one run.

**Source.**\
`[V, director ruling 2026-10-11]`

### 0020

**Ruling.**\
A phase invalid for agent behaviour ends the phases that follow from it, directly or through others, and their properties score the bottom of their scale; phases on other branches run and are judged.\
A phase invalid for any other cause still makes the whole episode invalid for that cause, to be attempted again.\
Delta-2's episode rule reads "properties of phases that follow from it" where it read "properties of later phases", and F4 reads that each branch starts from the ending tree of the phase before, less exactly its withheld files.

**Alternatives refuted.**\
Keeping the rule as built, where a behaviour failure ends the whole episode - refuted because it ties independent branches together by their order in the list: a failure in the first-listed branch scored the other at the bottom, while a failure in the second left the first standing, biasing the handoff experiment's comparison of an agent's own note against a generated one.

**Disclosed.**\
The rule as built was the author's reading of "later phases" as later in the list; verification measured its effect.\
The director replied "continue" to a list whose first pick was this option, and it is recorded as that pick.

**Source.**\
`[V, director ruling 2026-10-12; docs/DELTAS/DELTA-2.md Record, stage 2]`

### 0021

**Ruling.**\
Delta-2's live stage runs on a new population: `claude-opus-5-5`, `gemini-4-argon`, `gemini-3.8-flash` and `grok-4.20-non-reasoning` from the LiteLLM endpoint at `100.80.94.9:4000`, through opencode, and GPT through Codex - five members of four families.\
F13 is run again on it; F14 and F15 are run on it; "three families" in Delta-2 reads "every family of the population".\
The thresholds derived from run `2026-10-12-105615-aa` stay in mission-kit's register, superseded, and the old endpoint is not used again.\
How judges are drawn from the new population is not settled by this ruling.

**Alternatives refuted.**\
Finishing Delta-2 on the old endpoint first - refuted because it spends a further run on a population being retired, against the director's intent.\
Closing Delta-2 without F15 - refuted because it leaves the gate's falsifier untested within the delta that built the gate.

**Disclosed.**\
The director replied "continue" to a list whose first pick was this option, adding that Codex stays, and it is recorded as that pick with Codex kept.\
Both F15 runs on the old endpoint were stopped by host shutdowns, after 99 and 71 of 270 cells; for four replies the author reported the second as still running, from a process check that matched the author's own shell.\
F13's run on the old population passed and stays recorded as evidence of the machinery.

**Source.**\
`[V, director ruling 2026-10-14; docs/DELTAS/DELTA-2.md Record, stage 5]`

### 0022

**Ruling.**\
mission-kit's handoff and A/A experiments declare their judges as `c`, `a`, `x` and `o` - one member of each of the population's four families - so each outcome is judged by the three of another family than its agent's.\
Gemini 3.8 Flash is an agent only.\
It is a setting of those experiments, not a rule for any other.

**Alternatives refuted.**\
All five judging - refuted because Claude, Grok and GPT outcomes would each have two judges of one family, which count as one measurement, while Gemini outcomes had three of three families.\
Two judges per outcome - refuted because it needs a rule choosing which two, and gives up a majority on a binary score.

**Disclosed.**\
The director replied "continue" to a list whose first pick was this option, and it is recorded as that pick.\
The director stated that the option of running several models should always be available, orchestrated by context-lab, and that mission-kit takes no standing rule on it; that is backlog row `B18`.

**Source.**\
`[V, director ruling 2026-10-14]`

### 0023

**Ruling.**\
Delta-2 includes run resumption (`B16`, planned under `M2.3`): `resumeRun` and `context-lab resume <pack> <run-dir>` resume a run that stopped during execution (at state `probed`, before `executed`), after checking that the run is not completed, the experiment's register hash and model routes match the run record, the built variants match their recorded manifests, and every recorded cell's file is present and well-formed.\
It executes only the remaining cells, records the resumption timestamp in `resumedAt`, and proceeds through measurement, blinding, judging and tallying.

**Alternatives refuted.**\
Relaunching interrupted 450-cell runs from scratch without resumption - refuted after three consecutive A/A runs were stopped mid-execution by host shutdowns (at 99/270, 71/270 and 120/450 cells).

**Disclosed.**\
The director replied "continue" to a list whose first pick was this option, and it is recorded as that pick.

**Source.**\
`[V, director ruling 2026-10-14]`

### 0024

**Ruling.**\
Delta-2 reached its to-state: multi-phase episodes, notes, branches, trap rotation, diagnostic measures, the threshold deriver, the comparator and run resumption, with F13, F14 and F15 completed on the five-member population (`c`, `a`, `f`, `x`, `o`) and zero persisting flags on F15.\
Every exit criterion (F1 to F15) was evaluated green by an agent that built none of the code; F4's stage-2 trap-file clause is confirmed; milestone M2 is complete (`B2`, `B3`, `B12`, `B16` closed).\
The five-member `adherence` and `explain` baseline runs in mission-kit are selected next, with the one-per-family judge panel (`c`, `a`, `x`, `o`) of `0022` applied to `adherence` and `explain`, and `explain` carrying the 0.25 pooled variation and default of `0019`.

**Alternatives refuted.**\
Opening milestone M3 before running the five-member `adherence` and `explain` baselines - refuted because the control-versus-guided baseline should be taken while the five-member calibration is fresh.

**Source.**\
`[V, director ruling 2026-10-14; docs/DELTAS/DELTA-2.md Record, closing evaluation]`

### 0025

**Ruling.**\
Milestone M3 (`M3.1` and `M3.2`), expanded with `B18` (on-demand multi-model review orchestration), is selected from the board and opens as Delta-3.

**Alternatives refuted.**\
Triaging mission-kit's `B81` and `B82` ahead of M3 - not chosen; the director selected M3 and `B18` first.

**Source.**\
`[V, director selection 2026-10-16]`

### 0026

**Ruling.**\
Delta-3 (`docs/DELTAS/DELTA-3.md`, revision 2) is ratified as written after adversarial review:
- `docs/ARCHITECTURE-TARGET.md` sections 2, 3, 5, 6 and 9 reopen under section 1's triggers to absorb `B18` (**Review panel**, the 22nd component);
- Stage 1 builds the pair chooser and human panel (`G1`-`G3`);
- Stage 2 builds classify-then-verify judging chains and the candidate writer (`G4`-`G6`);
- Stage 3 updates `docs/ARCHITECTURE-TARGET.md` and builds `context-lab review` (`G7`-`G8`);
- Stage 4 builds `zorg/evals/context-lab/`, proves 26-finding parity on `l-02`, runs a live zorg scenario, and deletes the six duplicated files while keeping `mission-kit/tools/eval.mjs` (`B80`) and `zorg`'s domain helper scripts (`G9`-`G12`).

**Alternatives refuted.**\
Expanding stage 4 to migrate mission-kit's ~20 historical one-off comprehension suites before closing M3 - not chosen; those suites remain governed by mission-kit `B80`.

**Disclosed.**\
The director replied "continue" to a list whose first pick was this option, and it is recorded as that pick.

**Source.**\
`[V, director ruling 2026-10-16]`

### 0027

**Ruling.**\
Delta-3 reached its to-state: all twenty-two components of `docs/ARCHITECTURE-TARGET.md` section 5 are built (pair chooser, human panel, classify-then-verify judging chains, candidate writer, and the on-demand multi-model review panel), `zorg/evals/context-lab/` passed 26-finding parity on `l-02` and ran live on the core, and the six duplicated runner files in `mission-kit` and `zorg` are deleted (`B1`, `B11`, `B18` closed; milestone M3 complete).\
Every exit criterion (G1 to G12) was evaluated green by an agent that built none of the code.\
Milestone M4 (Hardening: `M4.1` `B4`, `M4.2` `B7`, `M4.3` `B5`) is selected next and opens as Delta-4.

**Alternatives refuted.**\
Moving to `mission-kit` `B81`/`B82` before closing `context-lab`'s final milestone M4 - not chosen; the director selected Option 1 to complete `context-lab` M4 first.

**Source.**\
`[V, director ruling 2026-10-17; docs/DELTAS/DELTA-3.md Record, closing evaluation]`

### 0028

**Ruling.**\
Delta-4 (`docs/DELTAS/DELTA-4.md`, revision 2) is ratified as written after adversarial review:
- Stage 1 builds the end-to-end failure injection suite through `opencodeAdapter`, `codexAdapter`, `runSandboxed` (`bwrap`), and `conductRun` across all 9 fault modes (`H1`);
- Stage 2 builds `faultProfile` (`Result.faults`) and `docs/probes/2026-10-17-provider-faults.json` across all 21 recorded live run directories (`H2`), `Result.guesses.byScenario` and `byProperty` with `notBlind` (`all >= 6 && rate >= 0.75 && rate > baseRate + 0.25`) and the `RESULT.md` limit warning (`H3`), and closes `B4`, `B5`, `B7` and milestone M4 (`H4`).

**Alternatives refuted.**\
Lowering the `notBlind` margin from `rate > baseRate + 0.25` to `rate > baseRate + 0.15` - not chosen; the director selected Option 1 (`rate > baseRate + 0.25`).

**Source.**\
`[V, director ruling 2026-10-17]`

### 0029

**Ruling.**\
Delta-4 reached its to-state: end-to-end failure injection across all 9 fault modes (`H1`), provider fault characterisation per member, family and arm in `Result.faults` and across all 21 live run directories in `docs/probes/2026-10-17-provider-faults.json` (`H2`), per-scenario and per-property arm-guess blinding in `Result.guesses` (`H3`), and closure of `B4`, `B5`, `B7` and milestone M4 (`H4`).\
Every exit criterion (H1 to H4) was evaluated green by an agent that built none of the code.\
All four milestones (`M1`-`M4`) on context-lab's board are complete; work moves next to `mission-kit`'s fired S1 mandate rows `B81` and `B82`.

**Disclosed.**\
The director replied "continue" to a list whose first pick was this option, and it is recorded as that pick.

**Source.**\
`[V, director ruling 2026-10-17; docs/DELTAS/DELTA-4.md Record, closing evaluation]`

### 0030

**Ruling.**\
`README.md` (restructured to `mission-kit` `S4`/`S9` four-journey layout) and `docs/OPERATIONS.md` provide the consumer operations and pack authoring guide for `context-lab`: all 13 CLI commands, the complete `context-lab.pack/1` schema (`pack.json`, `experiments/*.json`, `scenarios/*.json`, `hooks/*.mjs`), a copy-pasteable minimal pack, and step-by-step operator workflows across `M1`-`M4`.\
Verified by dogfooding `context-lab` on itself (`mission-kit` `0097`, run `2026-10-17-100515-c2`) across all 5 models (`c`, `a`, `f`, `x`, `o`) with `packages/` excluded from the delivered variant: cold-agent pack authoring (`P0`, scored by `checkPack`) rose from `0.00/2` (`0/5` models) on baseline (`2ffda23`) to `2.00/2` (`5/5` models, zero defects) on head (`5cd7366`), and total score rose from `2.80/10` to `10.00/10`.

**Alternatives refuted.**\
Keeping the 33-line Delta-1 `README.md` without a pack schema or operations guide - refuted by the baseline arm of `2026-10-17-100515-c2`, where 0 of 5 models could construct a valid pack without reading `packages/core/src/`.

**Source.**\
`[V, director ruling 2026-10-17; mission-kit docs/DECISIONS.md 0097; mission-kit docs/evals/runs/context-lab/2026-10-17-100515-c2/RESULT.md]`

### 0031

**Ruling.**\
Before mission-kit's second adherence pass across all 14 axioms, four additions land in the core:

- `Result.costs`: per arm, and per arm and member, the mean input, cached-input and output tokens, tool calls and seconds of a counted cell's scored attempt, its phases summed; a counted cell is a valid one or one that ended on agent behaviour, as `0004` costs every scored cell.
- `Result.hydration` rows count hydrating cells rather than members, list their cells, carry the adherence of the cells that hydrated the entry and of those that did not, and are written only for arms with an on-request folder and no instruction or folder file named for the entry, read from `snapshot.deliveries`, which the run record now keeps.
- `candidates` gains rule 5, `routing-miss` (a guided arm's row with at least 2 cells and a hydration rate under `routingMissThreshold`), and rule 6, `hydrated-not-acted` (at least 2 hydrating cells with a value for an adherence property naming the entry, and more than `hydratedNotActedThreshold` of them not meeting it); both read only rows with recorded deliveries.
- An isolation probe retry after a tool call says no guidance entry or on-request folder is mounted, so reading or searching cannot find one, and keeps saying it on every later retry; each probe answer records its `attempts`; the pass criterion is unchanged.

**Limits.**\
Hydration means a tool call named the entry - a path or input holding its id and a hyphen after a separator - not that the entry was read: a search pattern counts, a bulk read such as `cat axioms/*.md` does not, and an entry not named `<id>-...` is never seen.\
An arm is listed as on-request only from its deliveries alone; whether its on-request folder holds the entry is not checked.\
A multi-phase cell counts as hydrated if any phase of its scored attempt named the entry, whichever phase the property is judged on.

**Disclosed.**\
Two defects in the hydration profile of `ce9d513` are corrected here, and both change what an existing field means: `hydrated` and `rate` counted hydrating members against a count of cells, which is the same number only at one run per cell, and every arm was listed, so arms given the entry as an instruction read as 0% hydration.\
A re-tally of a run recorded before this change still lists every arm, with `onRequestOnly` null.\
The retry wording is unmeasured as a remedy: the `o` on-trigger probe failure it targets, seen in runs `2026-10-18-032859-adherence` and `2026-10-18-045019-adherence` with three consecutive tool calls each, did not recur in five standalone probes of that arm and member made before this change, so no run has yet tested the new wording against it.\
Reviewed before landing by an agent that wrote none of it, reading only; its blocking finding (behaviour-ended cells left out of costs) and its test gaps were fixed, and its scoping and matching findings are stated above as limits.

**Source.**\
`[V, director ruling 2026-10-18 (mission-kit second adherence pass, option 1); mission-kit docs/evals/runs/context-lab/2026-10-18-045019-adherence/run.json probes]`

### 0032

**Ruling.**\
Three changes to `0031`, each from the diagnostic of mission-kit's run `2026-10-18-093310-adherence-pass2`, the first run with `0031`'s rules:

- `Result.judgeDissent`: per judge, the values it cast, the splits it was in - a unit's property valued by at least three judges who did not all agree - and how often it alone differed; written to `RESULT.md` as *Judge dissent*.
- `candidates` rule 7, `judge-outlier`: a judge in at least 10 splits that alone differed in more than `judgeOutlierThreshold` of them, 0.5 by default.
- Rules 5 and 6 read only rows for guidance a scenario declares in its `exercises:` tags, where it declares any; rule 6 is written once per scenario, property and arm.

**Evidence.**\
On that run, `0031`'s rules wrote 18 candidates; read against the cells each cites, 7 were true and 11 were not: 9 `routing-miss` rows were for an entry a property names beside the one its scenario exercises, opened rarely because the exercised one was opened, and 2 were the same `hydrated-not-acted` finding written from two entries' rows.\
Re-tallied with these rules, the same record gives 8: the 7 true findings and one `judge-outlier`, for the Grok judge, which alone differed in 72 of the 97 splits it was in, against 8 to 15 for each other judge.

**Source.**\
`[V, director's standing directive 2026-10-18 to fix tooling found wanting by each run's diagnostic; mission-kit docs/evals/runs/context-lab/2026-10-18-093310-adherence-pass2]`

### 0033

**Ruling.**\
`Result.costs` rows carry `inputTokensMedian` and `costliest` (the cell with the most input tokens, and its count), and `RESULT.md` shows both beside the mean.

**Evidence.**\
On mission-kit's run `2026-10-18-111520-adherence-rule-repeat`, one cell of 150 in one arm - a Grok agent in an edit loop of 235 edits until its time limit - used 18,763,865 input tokens, so the arm's mean read 388,832 against 239,269 for the other arm while the medians were 241,979 and 216,801; the mean alone reported a difference of about 150,000 tokens per cell that was one cell.

**Source.**\
`[V, director's standing directive 2026-10-18 to fix tooling found wanting by each run's diagnostic; mission-kit docs/evals/runs/context-lab/2026-10-18-111520-adherence-rule-repeat cells]`

### 0034

**Ruling.**\
Two guards on the register:

- A threshold set records the A/A run's judges, and `compare` under the A/A rule refuses a set whose pools name other members or scenarios than the base run, or whose judges differ from the base run's; a set with no pools, made by hand, or no judges, derived before this ruling, is not checked on what it lacks.
- `check`, when clean, prints a `note:` line for each experiment that declares `result` and would run as exploration now: unrecorded, or changed since recorded.

**Evidence.**\
mission-kit dropped one model from its population and judge panels, which changes the design `aa-gate`'s thresholds were derived on, and `compare` read only the set's experiment and `m`, so a gate run of the new design would have been judged against the old design's noise without notice.\
The same day, the register showed five of mission-kit's eight experiments - `aa`, `c0`, `c2`, `explain`, `handoff`, all declaring `result` - unrecorded since 2026-10-17, by three pack edits that each added an arm to the pack-wide leak probes; `check` passed at each, and no run was labelled exploration only because none of the five ran in between.

**Limits.**\
The over-broad hash itself is unchanged: an edit to `masks` or `isolation` made for one experiment still unrecords every other; `check` now says so instead of staying silent.

**Source.**\
`[V, director ruling 2026-10-18 dropping Grok from mission-kit's experiments; mission-kit docs/evals/context-lab/register, bisected over commits abedf32 to 7d49e70]`
