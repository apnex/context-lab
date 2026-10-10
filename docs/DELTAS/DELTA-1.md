# Delta-1 - a core that runs one-phase experiments, proven isolated - a vertical slice

```yaml
status:     draft - for adversarial review, then the director's ratification
selected:   docs/DECISIONS.md 0007, board item M1 (M1.1, M1.2)
from-state: no current architecture - nothing of context-lab is built
to-state:   docs/ARCHITECTURE-TARGET.md (0006), the components in section 1 below
rows:       docs/BACKLOG.md B1, B11
```

---

## 0. From-state -> to-state

**From.** context-lab's current architecture is empty.\
Its duty is performed outside it, by mission-kit's `tools/adherence.mjs`, `tools/eval.mjs` and `tools/eval-human.mjs`, and by zorg's `evals/tools/run-agents.mjs` and `classify-findings.mjs`.

**To.**\
The target architecture's components needed to run an experiment of one phase end to end - from a project pack to a tallied result - with isolation proven in every run, and mission-kit's adherence and comprehension suites running on them from mission-kit's pack.\
Every other component of the target stays unbuilt.

---

## 1. The fence

This delta builds, from the target architecture (section 5):

- **Pack checker**, with the declaration-check hook.
- **Experiment register**: content hash, exploration status, held-out exposure.
- **Selector**, with suites saved and resolved by name (`0008`).
- **Variant builder**, with the variant-transform hook: local export, every address of the source rewritten, canaries planted.
- **Arm composer.**
- **Workspace builder.**
- **Runtime adapters**: opencode, Codex, and the external adapter.
- **Isolation prober**: canaries, a negative canary, leak probes, filtered probes as inconclusive.
- **Validity classifier**, by cause.
- **Code measurer**, with the outcome-measure hook.
- **Answer parser.**
- **Blinder.**
- **Judge panel**, cross-family, with validated votes and arm guesses.
- **Tally.**
- **Run conductor**, for runs of one phase.

And, in mission-kit's repository, **mission-kit's pack**: its adherence suite and its comprehension suites as one-phase experiments.

Built in Node, as both sources are, with no runtime dependencies - an author's choice, not a ruling.

---

## 2. Build order - certifiable stages

Each stage lands with its own tests before the next depends on it.

1. **Pack and record.** Pack schema, pack checker and its hook, experiment register, selector and suites.
2. **Context.** Variant builder and its hook, arm composer, workspace builder.
3. **Runtimes.** The three adapters and their conformance suite; isolation prober; validity classifier.
4. **One-phase runs.** Run conductor, answer parser, code measurer and its hook.
5. **Judging.** Blinder, judge panel, tally.
6. **Parity.** The tally reproduces two past results from their recorded votes (criteria E8, E9).
7. **mission-kit's pack, live.** The adherence suite runs on the core (E10), and one comprehension suite runs to a result (E11).

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven by this delta | Deferred |
|---|---|---|
| `0002` four mechanisms | comprehension and adherence runs | human preference; classify-then-verify chains |
| `0003` hooks | declaration check, variant transform, outcome measure | - |
| `0004` universal parts | pinned local delivery with rewritten addresses and canaries; isolation probed per arm and runtime; cross-family judging and code before judges; arm guesses collected per property; invalid cells by cause; held-out and exploration status; tags, reverse view | A/A-calibrated comparison; multi-phase episodes and notes; trap-pair rotation; the comprehension-behaviour link; calibration against a person; candidate findings |
| `0005` note-generator hook | - | all |
| `0006` the architecture | the fifteen components in the fence | phase driver beyond one phase, pair chooser, human panel, threshold deriver, comparator, candidate writer |
| `0008` suites | all | - |

---

## 4. Verification targets

- Behaviour tests for every component in the fence, each refusal mutation-tested: removed from the code to show its test fails.
- One conformance suite every adapter passes, for the common form.
- A synthetic second pack whose vocabulary shares nothing with mission-kit's.
- Hook-contract tests: no network, reads and writes bounded, a time limit, and each hook's failure result.
- Isolation probes in every live run.
- Re-tally from a run record.

---

## 5. Binary exit criteria

Evaluated by an agent that did not build the stage.

| # | Criterion |
|---|---|
| E1 | The pack checker rejects every pack in a fixture set of invalid packs, one defect each, and accepts mission-kit's pack; each rejection's test fails when that check is removed. |
| E2 | A run of an experiment whose content hash differs from its recorded hash is recorded as exploration. |
| E3 | A suite saved by name resolves to the same scenario set when re-run, and to a different set only after its selection is changed. |
| E4 | In a live run, every guided arm on every runtime quotes its planted canary, and none quotes a negative canary planted only in another arm. |
| E5 | A cell whose agent fetches any network address of the source repository is recorded invalid for isolation. |
| E6 | The opencode, Codex and external adapters each pass the conformance suite. |
| E7 | The core's tests pass against mission-kit's pack and the synthetic second pack, and the core's source contains none of the identifier patterns of either pack. |
| E8 | Given the answers and scores of mission-kit's eval run `delta-01`, the core's tally reproduces its `RESULT.json` probe means exactly. |
| E9 | Given the votes and sealed mapping of mission-kit's adherence run `adherence-03`, the core's tally reproduces its `RESULT.json` pass rates exactly. |
| E10 | A live run of mission-kit's adherence suite on the core - five traps, three arms, three families, three runs - finishes with every arm's isolation probes passing and no cell invalid for isolation. |
| E11 | A live run of one mission-kit comprehension suite on the core reaches a result in which every probe has every reader's answer scored. |

---

## 6. Named costs and non-claims

- **Duplication rises before it falls.** Until zorg's pack runs and both projects retire their copies (board M3.2), three implementations of the duty exist, not two.
- **Parity is not correctness.** E8 and E9 show the core scores as mission-kit's tools did; they say nothing about whether those tools scored rightly.
- **E10 shows the core runs, not that it agrees.** A live run's results differ from `adherence-03` by run-to-run variation, which is not yet stated for that suite; no agreement criterion is set, and the comparison is reported, not judged.
- **Two runtimes and one machine.** Generality across runtimes and operators is not shown.
- **No multi-phase episode, no change gate, no person in the loop** - so none of the standing suite's decisions that rely on them can be taken from this delta's results.

---

## 7. The anti-scope fence

This delta does not build or change:

- the phase driver beyond one phase, the note-generator hook, the comparator, the threshold deriver, the pair chooser, the human panel, judging chains, or the candidate writer;
- zorg's pack, or anything in zorg's repository;
- retirement of mission-kit's or zorg's existing tools;
- the keys or wording of any mission-kit suite - the pack carries them as they are;
- adapters for any third runtime, or networked delivery;
- anything that ranks models.

---

## Adversarial review

Pending: an agent that did not draft this delta reviews it before ratification; its findings and the disposition of each are recorded here.
