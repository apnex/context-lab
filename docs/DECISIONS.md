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

