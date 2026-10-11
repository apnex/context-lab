# context-lab - board

The live, triaged set of legal next moves, for the director to select from.\
M1 is done: `docs/DELTAS/DELTA-1.md` is complete (`0017`).\
The next move is for the director to select.

---

## The contract with the record

Every item cites a row of [`BACKLOG.md`](BACKLOG.md); every open row is planned by a live item or held; every score shown is the row's, generated.\
Checked by mission-kit's `node tools/check-board.mjs --root <context-lab>`.

---

## Triage scale

Two dimensions, never blended: **impact**, S1 (a wrong result or lost data reaching a project) to S5 (internal only), and **principle**, an axiom and whether a row breaches its mandate or signals against it.\
Order on the higher: a mandate breach ranks with S2 and a signal with S4; ties go to the mandate, then to the higher impact.

---

## Triage ledger

<!-- BEGIN GENERATED: ledger. Run tools/check-board.mjs --write; do not edit by hand. -->
| Row | Impact | Principle | Planned in | Finding |
|---|---|---|---|---|
| `B1` | S3 | A3 mandate | M2.2 | The duty this component exists for is implemented twice, outside it, and diverging. |
| `B11` | S3 | A3 mandate | M3.2 | Neither first user has a project pack. |
| `B2` | S3 | A8 signal | M2.1 | Session continuation under isolation is unprobed on both driven runtimes. |
| `B3` | S4 | A8 signal | M2.1 | Whether each runtime's compaction keeps instruction files is unknown. |
| `B4` | S4 | A9 signal | M4.1 | No failure injection exercises the validity classifier. |
| `B5` | S4 | A8 signal | M4.3 | Blinding to arm was not achieved on one trap. |
| `B7` | S4 | A7 signal | M4.2 | Content filters and rate limits are uncharacterised. |
| `B8` | S4 | A5 signal | held | Local delivery differs from fetching over a network. |
| `B9` | S4 | A14 signal | held | Findings travelling between projects has no mechanism beyond records a project chooses to share. |
| `B10` | S4 | A10 signal | held | No loop files context-lab's own failures as its defects. |
| `B12` | S4 | A8 signal | M2.3 | Repeatability is not tested. |
| `B6` | S5 | A3 signal | held | Only two runtimes have adapters. |
<!-- END GENERATED: ledger -->

---

## M1 - A core that runs one-phase experiments, proven isolated `DONE`

The smallest slice that replaces a copy: a pack, pinned variants, isolated agents on two runtimes and an external one, probes, validity, blinding, cross-family judging and a tally.\
It carries mission-kit's adherence suite and one comprehension suite as single-phase experiments; its tally is checked against two past runs, and its live results are reported beside theirs.

| Item | Move | Cites | Depends on |
|---|---|---|---|
| M1.1 | Core for one-phase experiments, with a run record's time checked against its experiment's record (B13, closed): pack checker, experiment register, variant builder, arm composer, workspace builder, adapters, isolation prober, validity classifier, code measurer, blinder, judge panel, tally, run conductor | `B1` | - |
| M1.2 | mission-kit's pack: its adherence suite and its `explain` comprehension suite as one-phase experiments, run on the core, with the differences from their last results on mission-kit's own tools reported | `B11` | M1.1 |

## M2 - Multi-phase episodes and the change gate `OPEN`

| Item | Move | Cites | Depends on |
|---|---|---|---|
| M2.1 | Probe session continuation and compaction on both runtimes | `B2`, `B3` | M1.1 |
| M2.2 | Phase driver with branches and notes; the note-generator hook | `B1` | M2.1 |
| M2.3 | Threshold deriver and comparator, with an A/A run and a held-out A/A check | `B1`, `B12` | M1.1 |

## M3 - People, chains, and the second user `OPEN`

| Item | Move | Cites | Depends on |
|---|---|---|---|
| M3.1 | Pair chooser and human panel; classify-then-verify judging chains; candidate writer | `B1` | M1.1 |
| M3.2 | zorg's pack, run on the core and compared with its last results; both projects retire their copies | `B11` | M3.1, M2.2 |

## M4 - Hardening `OPEN`

| Item | Move | Cites | Depends on |
|---|---|---|---|
| M4.1 | Failure injection for the validity classifier | `B4` | M1.1 |
| M4.2 | Characterise content filters and rate limits per provider | `B7` | M1.1 |
| M4.3 | Arm-guess blinding test reported per property, and a repeat of a recorded experiment | `B5`, `B12` | M1.1 |

---

## Held

<!-- BEGIN GENERATED: held. Run tools/check-board.mjs --write; do not edit by hand. -->
| Row | Impact | Principle | Finding | Revival trigger |
|---|---|---|---|---|
| `B8` | S4 | A5 signal | Local delivery differs from fetching over a network. | a project's decision turns on networked behaviour |
| `B9` | S4 | A14 signal | Findings travelling between projects has no mechanism beyond records a project chooses to share. | two projects use context-lab |
| `B10` | S4 | A10 signal | No loop files context-lab's own failures as its defects. | the first run on the core |
| `B6` | S5 | A3 signal | Only two runtimes have adapters. | a project needs a third runtime |
<!-- END GENERATED: held -->

---

## Decisions required

None open.\
M1 was selected as the first move (`docs/DECISIONS.md` `0007`).
