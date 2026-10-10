# Delta-1 - a core that runs one-phase experiments, proven isolated - a vertical slice

```yaml
status:     draft revision 2 - adversarial review applied; for the director's ratification
selected:   docs/DECISIONS.md 0007, board item M1 (M1.1, M1.2)
from-state: docs/ARCHITECTURE-TARGET.md header - "Its current architecture is empty"
to-state:   docs/ARCHITECTURE-TARGET.md (0006, 0008), the components fenced in section 1
rows:       docs/BACKLOG.md B1, B11
```

---

## 0. From-state -> to-state

**From.** context-lab's current architecture is empty.\
Its duty is performed outside it, by mission-kit's `tools/adherence.mjs`, `tools/eval.mjs` and `tools/eval-human.mjs`, and by zorg's `evals/tools/run-agents.mjs` and `classify-findings.mjs`.

**To.**\
The target architecture's components needed to run an experiment of one phase end to end - from a project pack to a tallied result - with isolation probed in every run, and mission-kit's adherence suite and its `explain` comprehension suite running on them from mission-kit's pack.\
Every other component of the target stays unbuilt.

---

## 1. The fence

This delta builds, from the target architecture (section 5), sixteen components:

- **Pack checker**, with the declaration-check hook.
- **Experiment register**: content hash over the experiment and every scenario, key, fixture, rule and hook file it references; exploration status.
- **Selector**: scenarios by tag, suites saved and resolved by name (`0008`), the generated entry-to-scenario view.
- **Variant builder**, with the variant-transform hook: local export at a pinned revision, every declared address of the source rewritten, canaries planted.
- **Arm composer.**
- **Workspace builder.**
- **Runtime adapters**: opencode, Codex, and the external adapter.
- **Isolation prober**, for agents and judges: canaries, negative canaries, leak probes, filtered probes as inconclusive.
- **Phase driver, one phase only** - no sessions continued, no notes, no branches.
- **Validity classifier**, all three causes.
- **Code measurer**, with the outcome-measure hook.
- **Answer parser**, with the self-explanation marker.
- **Blinder.**
- **Judge panel**: cross-family, votes validated, one arm guess per outcome.
- **Tally**: pass rates, agreement, arm-guess rates; not held-out reporting, the comprehension-behaviour link, judge-person agreement or the variation achieved.
- **Run conductor**, through the states validated, recorded, built, probed, executed, measured, blinded, judged, tallied; not picked or compared.

Also:

- **The hook runner**, owned by the pack checker's stage, running every hook in a Linux user and network namespace with bubblewrap bounding its reads and writes - probed on this machine: a process under `unshare -rn` could not reach the network.
- **Legacy-record readers** that convert mission-kit's past run records into core votes, by format conversion only, with no arithmetic.
- **mission-kit's pack**, in mission-kit's repository: the adherence suite and the `explain` suite as one-phase experiments, with every piece of wording that today lives in tool code - reader prompt, scorer text, response schema, chunking, identifier mask, isolation questions - transcribed verbatim.
- **A synthetic second pack**, sharing no vocabulary with mission-kit's, for the core's tests.

**Network policy.**\
Agents run with network access denied where the runtime can deny it, and every attempt to reach a forbidden address is detected from the event trace wherever it cannot.\
No task in either mission-kit suite needs the network.

Built in Node, as both sources are, with no runtime dependencies beyond the operating system's namespace and bubblewrap tools - an author's choice, not a ruling.

---

## 2. Build order - certifiable stages

Each stage lands with its own tests, and its criteria are green, before the next depends on it.

1. **Pack and record.** Pack schema; both packs written statically; pack checker; hook runner; experiment register; selector and suites. Criteria E1, E2, E3, E12.
2. **Context.** Variant builder, arm composer, workspace builder. Criterion E13.
3. **Runtimes.** The three adapters and their conformance suite, accepted by the verifier before the adapters are built; isolation prober; validity classifier. Criteria E5, E6.
4. **One-phase runs.** Phase driver, run conductor, answer parser, code measurer. Criteria E7, E14.
5. **Judging.** Blinder, judge panel, tally. Criterion E15.
6. **Parity.** Legacy-record readers; the tally against two past runs. Criteria E8, E9.
7. **mission-kit's pack, live.** Criteria E4, E10, E11.

---

## 3. Coverage map - decisions proven vs deferred

| Decision | Proven, by criterion | Deferred, to board item |
|---|---|---|
| `0002` four mechanisms | comprehension runs (E11); adherence runs (E10) | human preference; classify-then-verify chains (M3.1) |
| `0003` hooks | declaration check, variant transform, outcome measure, under their contract (E12) | - |
| `0004` pinned local delivery, addresses rewritten, canaries | E4, E13 | - |
| `0004` isolation probed per arm and runtime, judges included | E4 | - |
| `0004` code before judges; cross-family judging | E14, E15 | - |
| `0004` invalid cells by cause | E5 | - |
| `0004` exploration status | E2 | - |
| `0004` tags and generated reverse view | E3 | - |
| `0004` held-out exposure | - | M2.3 |
| `0004` arm guesses reported per property | - | M4.3 |
| `0004` A/A-calibrated comparison | - | M2.3 |
| `0004` multi-phase episodes, notes; trap-pair rotation | - | M2.2 |
| `0004` comprehension-behaviour link; restated-guidance flags; variation stated before outcomes | - | M2.2, M2.3 |
| `0004` calibration against a person; candidate findings | - | M3.1 |
| `0005` note-generator hook | - | M2.2 |
| `0006` the architecture | the sixteen fenced components, each exercised by the criteria of its stage | pair chooser, human panel, threshold deriver, comparator, candidate writer; phase driver beyond one phase |
| `0008` suites | E3 | - |

---

## 4. Verification targets

- Behaviour tests for every fenced component, each refusal mutation-tested: removed from the code to show its test fails.
- One adapter conformance suite, its cases accepted by the verifier before stage 3 builds against it.
- The synthetic second pack.
- Hook-contract tests under the hook runner.
- Isolation probes in every live run.
- Re-tally from a run record.

---

## 5. Binary exit criteria

Evaluated by an agent that built none of the code the criterion exercises, holding verifier authority.

| # | Stage | Criterion |
|---|---|---|
| E1 | 1 | For each check listed in the pack schema, and for one defect returned by a declaration-check hook, a fixture pack with exactly that defect is rejected with the defect named; mission-kit's pack at a recorded revision, and the synthetic pack, are accepted; removing any one check makes its fixture's test fail. |
| E2 | 1 | A run is recorded as exploration, whatever status it declares, when its experiment is unrecorded or its content hash differs from the recorded hash; a test changes the declaration, a scenario, a key, a fixture file, a rule and a hook file in turn, and the status flips each time. |
| E3 | 1 | Resolving a saved suite by name twice against an unchanged pack yields identical scenario-id lists, recorded in the run record; for each change in a fixture set - the suite's selection, a scenario's tags, a scenario added, a scenario removed - the list changes exactly as the selection rule predicts; the generated entry-to-scenario view lists every scenario under every entry its tags name. |
| E4 | 7 | In the E10 and E11 runs, the isolation record shows, for every arm and every judge setup on every driven runtime: every canary planted in that arm quoted; no negative canary declared for it quoted; no leak probe matching its leak pattern; at least one probe answered rather than filtered; and a fixture test shows an arm failing any one of these runs no cell and is reported. |
| E5 | 3 | For each driven adapter, recorded or synthetic event traces are classified: one reaching an address on the pack's forbidden list, by fetch tool, shell command or file read, as invalid for isolation, naming the address; one ending in a provider error or content filter as infrastructure; one ending in a timeout spent working, or a context overflow, as behaviour; and each trace with the cause removed as valid. |
| E6 | 3 | Each adapter passes every case of the conformance suite, which covers the common event form, the final message, cost, tool paths and fetches, the content-filter flag, the rules-file names it declares, each delivery mode it declares, a timeout, and refusing a setting its runtime cannot apply. |
| E7 | 4 | The core's full test suite passes against the synthetic pack with mission-kit's pack absent from disk, and no file under the core's source directories, tests and fixtures excluded, contains any literal from a list frozen at stage 1 from mission-kit's pack: its scenario, trap and probe ids, canaries, fixture file names and forbidden paths. |
| E8 | 6 | A reader that converts formats and does no arithmetic turns mission-kit's eval run `delta-01` - `sealed/manifest.json`, `sealed/blind.json`, `scores/*.txt` - into core votes, and the core's tally reproduces every `mean[probe][label]` and `total[label]` in its `RESULT.json`, rounded as `Number.prototype.toFixed(2)` rounds. |
| E9 | 6 | A reader that converts formats and does no arithmetic turns mission-kit's adherence run `adherence-03` - `sealed/manifest.json`, `scores/*.json`, the suite's key ids, `run.json` - into core votes, and the core's tally reproduces with strict equality, for every trap and property, `byArm` and `byArmFam` `mean`, `of` and `incomplete`, `agreement`, and per trap `guess.right`, `guess.all` and `guess.guided`. |
| E10 | 7 | A live run of mission-kit's adherence suite, started by suite name, five traps by three arms by three families by three runs, reaches tallied; every isolation probe for arms and judges passed before any cell ran; all 135 cells are valid or invalid with a cause; each cell invalid for infrastructure or isolation was re-run at most once, both attempts recorded and counted per arm; every valid outcome holds two votes from families other than its own; and the run record re-tallies to its result. |
| E11 | 7 | A live run of mission-kit's `explain` suite on both driven runtimes, readers from three families and judges from the other two, reaches tallied; every reader-probe pair holds two validated votes or a recorded absence scored 0; and no judge prompt contains text that followed the self-explanation marker. |
| E12 | 1 | For each of the three hooks, in contract tests and in the synthetic pack, a hook that attempts the network, reads outside its inputs, writes outside its folder or exceeds its time limit is stopped and gives its failure result - the pack failed; the arm not built and not run; the properties incomplete - and each hook's success path is used in the E7 tests. |
| E13 | 2 | A built variant contains no occurrence of any address the pack declares for its source, and the run record names the source revision the variant was built from. |
| E14 | 4 | In the run record, every code score carries a time earlier than the blinding of its outcome. |
| E15 | 5 | The judge panel refuses to assign a judge of an outcome's own family, and its test fails when that refusal is removed. |

---

## 6. Named costs and non-claims

- **Duplication rises before it falls.** Until zorg's pack runs and both projects retire their copies (board M3.2), three implementations of the duty exist, not two.
- **Parity is about tallying.** E8 and E9 show the core tallies the same results from the same recorded votes; they do not test its blinder or judge panel, and say nothing about whether the old tools scored rightly.
- **E10 and E11 show the core runs, not that it agrees.** A live run differs from `adherence-03` by run-to-run variation, not yet stated for that suite, and by known differences: local delivery instead of fetches from `main`, network denied, masking and prompt assembly rebuilt from transcribed wording, and judges assigned by the core. E11 is not comparable with mission-kit's earlier `explain` runs, which used one judge of the readers' own family. Board item M1.2 promised a comparison with the old tools; for both suites it is reported in this delta's record with those differences listed, and not judged.
- **E10's result is exploration.** The adherence experiment is registered in the core after `adherence-03`'s outcomes were seen, and its keys were revised after calibration; it cannot be a result under the vision's honest-reporting measure.
- **Linux only.** The hook runner depends on user and network namespaces and bubblewrap.
- **Two runtimes, one machine.** Generality across runtimes and operators is not shown.
- **No multi-phase episode, no change gate, no person in the loop.**

---

## 7. The anti-scope fence

This delta does not build or change:

- the phase driver beyond one phase, the note-generator hook, the comparator, the threshold deriver, the pair chooser, the human panel, judging chains, held-out reporting, or the candidate writer;
- zorg's pack, or anything in zorg's repository;
- mission-kit's `tools/adherence.mjs`, `tools/eval.mjs` or `tools/eval-human.mjs`, or their retirement;
- any past run record, which is read only;
- the keys or wording of any mission-kit suite, in its files or in tool code - the pack carries them as they are;
- the wording of any prompt on a re-run, including after a content filter;
- adapters for any third runtime, or networked delivery;
- `ARCHITECTURE-TARGET.md` or `DECISIONS.md`, except by a new ruling;
- anything that ranks models.

**Authority in mission-kit.**\
Adding a pack to mission-kit's repository is authorised by mission-kit's `0087` - mission-kit's standing suite keeps its scenarios, keys and results there and uses this component - and is a new directory of instance content, not a change to its corpus.\
The pack records no consent, because every experiment in it runs on material built for it: fixtures, and exported copies of mission-kit's own corpus, under mission-kit's own authority.

---

## Adversarial review

**Reviewer.**\
A fresh agent that did not draft this delta, of the same model family as its author, with read access to every cited file and run, and no edits.

**Verdict as given.**\
Ratify after fixes.

| Finding | Severity | Disposition |
|---|---|---|
| E3, E4, E7, E8, E9, E10, E11 open to two readings | blocking | Reworded as the reviewer proposed; E7 merged its two halves into one criterion; E10 bounds re-runs instead of requiring zero isolation failures, since agents may attempt fetches on their own |
| Hooks and address rewriting claimed proven with no criterion | blocking | E12 and E13 added |
| Arm guesses per property claimed proven; the response collects one per outcome | blocking | Moved to deferred, M4.3; the judge panel collects one guess per outcome |
| Invalid cells by cause proven for isolation only | blocking | E5 widened to all three causes on recorded or synthetic traces |
| Held-out exposure claimed with no criterion | blocking | Deferred to M2.3; the register keeps the hash and exploration status only |
| Packs needed at stage 1 but built at stage 7 | blocking | Both packs written statically in stage 1; only live runs in stage 7 |
| Phase driver both excluded and implied | should-fix | Fenced as one phase only |
| Coverage map cited no criteria; some `0004` parts in neither column | should-fix | Every row now cites a criterion or a board item |
| Legacy-record conversion unfenced | should-fix | Fenced as format-only readers in stage 6 |
| Wording held in tool code not carried by the pack | should-fix | Fenced as transcribed verbatim; anti-scope forbids changing it |
| Network policy undecided | should-fix | Denied where the runtime can, detected everywhere |
| Hook-runner owner and sandbox mechanism unstated | should-fix | Owned in stage 1; namespaces and bubblewrap, probed for the network |
| Code before judges and cross-family judging unproven | should-fix | E14 and E15 added |
| Tally and run conductor unqualified | should-fix | Qualified in the fence |
| E10 differences stated as run-to-run variation only; E11 not comparable; status of E10 | should-fix | Non-claims rewritten, the M1.2 comparison reported not judged, E10 marked exploration |
| Anti-scope gaps: legacy tools, past records, wording on re-run, architecture edits | should-fix | Added |
| Consent and authority in mission-kit | should-fix | Stated under the anti-scope fence |
| Evaluator wording for criteria spanning stages | minor | Reworded |
| From-state described rather than cited | minor | Cited in the header |
| "Built in Node" bearing weight | minor | Kept as an author's choice; it constrains only the hook runner, which names its mechanism |
| A tool to make E8's fixed rounding exact | minor | Applied in E8 |
