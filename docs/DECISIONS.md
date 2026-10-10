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
| 0004 | 2026-10-10 | context-lab adopts the universal parts of mission-kit's standing-suite design, listed in its record, and none of its mission-kit-specific choices. | director | proposed | - |

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

**Ruling, proposed.** context-lab adopts from mission-kit's standing-suite design (`docs/evals/standing/DESIGN.md`, mission-kit `0086`) these universal parts:

- pinned, local delivery of each context variant, with canaries proving it was read, and network fetches of the source treated as isolation failures;
- isolation probed for every arm and runtime before any cell runs;
- judging by the model families that did not produce an outcome, and by code wherever a check can decide;
- invalid cells classified by cause, with behaviour failures scored and costed rather than re-run;
- comparison rules calibrated by A/A runs, flagging rather than deciding;
- multi-phase episodes with fresh sessions and branches, as a declarable scenario shape;
- trap pairs met once per episode, rotated across positions;
- held-out scenarios and exploration status fixed before outcomes;
- calibration of agent judges against a person, by pairs from one scenario and arm;
- candidate findings written for a project to triage;
- scenarios tagged by what they exercise, with the reverse view generated.

It adopts none of the design's mission-kit-specific choices - its four arms, its population, its run sizes and cadence, its thresholds, its digest and its misreading register - which a project declares in its pack.

**Status.**\
Proposed with the target architecture, for ratification with it.

**Source.**\
`[V, mission-kit docs/evals/standing/DESIGN.md; independent audit of the first architecture draft, finding the decisions layer rested on mission-kit's project rulings]`

