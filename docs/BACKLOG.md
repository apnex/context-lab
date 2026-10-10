# context-lab - backlog

The durable record of what context-lab has found about itself and not yet done.\
The board ([`BOARD.md`](BOARD.md)) is the plan; its ledger and held list are generated from the rows here, by mission-kit's `tools/check-board.mjs --root`.

---

## Adding a row

A row is required whenever a finding about context-lab is made and not acted on in the same change.\
Every row carries an id never reused; the finding, stated so it can be scored; its scores - `impact` S1-S5, from loss of data or a wrong result reaching a project (S1) to internal-only (S5), and `principle`, an axiom and whether the row breaches its mandate or only signals against it; cited evidence; and a state with a revival trigger unless closed.

---

## Open

| id | impact | principle | finding | evidence | state |
|---|---|---|---|---|---|
| **B1** | S3 | A3 mandate | **The duty this component exists for is implemented twice, outside it, and diverging.** Nothing of the target architecture is built; mission-kit's `tools/adherence.mjs`, `tools/eval.mjs` and `tools/eval-human.mjs` and zorg's `evals/tools/run-agents.mjs` and `classify-findings.mjs` each hold part of it, and zorg's launcher states it copies mission-kit's isolation. | `[V, docs/ARCHITECTURE-TARGET.md header; zorg evals/tools/run-agents.mjs line 9; mission-kit docs/BACKLOG.md B77]` | open - TRIGGER: planned |
| **B2** | S3 | A8 signal | **Session continuation under isolation is unprobed on both driven runtimes.** Multi-phase episodes continue a session; Codex runs ephemeral, and opencode's session store is not isolated by its config directory alone. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 1]` | open - TRIGGER: planned |
| **B3** | S4 | A8 signal | **Whether each runtime's compaction keeps instruction files is unknown.** Experiments that simulate compaction with a fresh session assume it. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 2]` | open - TRIGGER: planned |
| **B4** | S4 | A9 signal | **No failure injection exercises the validity classifier.** Its causes - infrastructure, behaviour, isolation - are asserted, not tested. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 3]` | open - TRIGGER: planned |
| **B5** | S4 | A8 signal | **Blinding to arm was not achieved on one trap.** In mission-kit's run `adherence-03`, judges guessed guided or not 54 of 54 on one trap. | `[V, mission-kit docs/audits/adherence-2026-10-09.md Limits]` | open - TRIGGER: planned |
| **B6** | S5 | A3 signal | **Only two runtimes have adapters.** Generality across runtimes is claimed, not measured. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 5]` | open - TRIGGER: a project needs a third runtime |
| **B7** | S4 | A7 signal | **Content filters and rate limits are uncharacterised.** One provider's filter blocked runs on a word in a path; clustering of such failures by family is inferred from that one provider. | `[V, zorg evals/tools/run-agents.mjs comments; docs/ARCHITECTURE-TARGET.md section 9 row 6]` | open - TRIGGER: planned |
| **B8** | S4 | A5 signal | **Local delivery differs from fetching over a network.** An arm reading files does not reproduce a networked session, so fetch counts and fetch storms change meaning. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 7]` | open - TRIGGER: a project's decision turns on networked behaviour |
| **B9** | S4 | A14 signal | **Findings travelling between projects has no mechanism beyond records a project chooses to share.** The vision's fourth success measure has no support. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 8]` | open - TRIGGER: two projects use context-lab |
| **B10** | S4 | A10 signal | **No loop files context-lab's own failures as its defects.** Invalid-cell causes and audit findings are not turned into rows here. | `[V, docs/ARCHITECTURE-TARGET.md section 9 row 9]` | open - TRIGGER: the first run on the core |
| **B11** | S3 | A3 mandate | **Neither first user has a project pack.** mission-kit's suites and zorg's evaluations are written for their own tools, so neither can run on the core when it exists. | `[V, mission-kit docs/evals/; zorg evals/]` | open - TRIGGER: planned |
| **B12** | S4 | A8 signal | **Repeatability is not tested.** No recorded experiment has been repeated and compared under its declared rule. | `[V, docs/ARCHITECTURE-TARGET.md section 8]` | open - TRIGGER: planned |
