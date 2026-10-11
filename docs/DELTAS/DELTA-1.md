# Delta-1 - a core that runs one-phase experiments, proven isolated - a vertical slice

```yaml
status:     complete - every exit criterion evaluated green by an agent that built none of the code (0017); stage amendments confirmed (0010, 0011, 0013)
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

Built in TypeScript, following the convention of the organisation's TypeScript components and zorg's layout in particular - npm workspaces under `packages/`, built with `tsc -b` under strict settings, tested with `node --test`, Node 24 or later - with development dependencies only (`typescript`, `@types/node`) and no runtime dependencies beyond the operating system's namespace and bubblewrap tools (`0009`).

---

## 2. Build order - certifiable stages

Each stage lands with its own tests, and its criteria are green, before the next depends on it.

1. **Pack and record.** The workspace; pack schema; both packs written statically; pack checker; hook runner; experiment register; selector and suites. Criteria E1, E2, E3 except its run-record clause, E12 for its bounds and the declaration-check failure result, E16.
2. **Context.** Variant builder, arm composer, workspace builder. Criteria E13 except its run-record clause, and E12's variant-transform failure result as far as the arm not being built.
3. **Runtimes.** The three adapters and their conformance suite, accepted by the verifier before the adapters are built; isolation prober; validity classifier. Criteria E5, E6.
4. **One-phase runs.** Phase driver, run conductor - passing each cell's attempt count to the classifier (`0012`) - answer parser, code measurer. Criteria E7, E14's timing of code scores, the run-record clauses of E3 and E13, and the rest of E12: an unbuilt arm not run, the outcome-measure failure result, and the synthetic pack's transform and measure hooks run on their success paths.
5. **Judging.** Blinder, judge panel, tally. Criteria E15, and E14's comparison with the blinding time.
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
| E3 | 1, 4 | Resolving a saved suite by name twice against an unchanged pack yields identical scenario-id lists, recorded in the run record; for each change in a fixture set - the suite's selection, a scenario's tags, a scenario added, a scenario removed - the list changes exactly as the selection rule predicts; the generated entry-to-scenario view lists every scenario under every entry its tags name. |
| E4 | 7 | In the E10 and E11 runs, the isolation record shows, for every arm and every judge setup on every driven runtime: every canary planted in that arm quoted; no negative canary declared for it quoted; no leak probe matching its leak pattern; at least one probe answered rather than filtered; and a fixture test shows an arm failing any one of these runs no cell and is reported. |
| E5 | 3 | For each driven adapter, recorded or synthetic event traces are classified: one reaching an address on the pack's forbidden list, by fetch tool, shell command or file read, as invalid for isolation, naming the address; one ending in a provider error or content filter as infrastructure; one ending in a timeout spent working, or a context overflow, as behaviour; and each trace with the cause removed as valid. |
| E6 | 3 | Each adapter passes every case of the conformance suite, which covers the common event form, the final message, cost, tool paths and fetches, the content-filter flag, the rules-file names it declares, each delivery mode it declares, a timeout, and refusing a setting its runtime cannot apply. |
| E7 | 4 | The core's full test suite passes against the synthetic pack with mission-kit's pack absent from disk, and no file under the core's source directories, tests and fixtures excluded, contains any literal from a list frozen at stage 1 from mission-kit's pack: its scenario, trap and probe ids, canaries, fixture file names and forbidden paths. |
| E8 | 6 | A reader that converts formats and does no arithmetic turns mission-kit's eval run `delta-01` - `sealed/manifest.json`, `sealed/blind.json`, `scores/*.txt` - into core votes, and the core's tally reproduces every `mean[probe][label]` and `total[label]` in its `RESULT.json`, rounded as `Number.prototype.toFixed(2)` rounds. |
| E9 | 6 | A reader that converts formats and does no arithmetic turns mission-kit's adherence run `adherence-03` - `sealed/manifest.json`, `scores/*.json`, the suite's key ids, `run.json` - into core votes, and the core's tally reproduces with strict equality, for every trap and property, `byArm` and `byArmFam` `mean`, `of` and `incomplete`, `agreement`, and per trap `guess.right`, `guess.all` and `guess.guided`. |
| E10 | 7 | A live run of mission-kit's adherence suite, started by suite name, five traps by three arms by three families by three runs, reaches tallied; every isolation probe for arms and judges passed before any cell ran; all 135 cells are valid or invalid with a cause; each cell invalid for infrastructure or isolation was re-run at most once, both attempts recorded and counted per arm; every valid outcome holds two votes from families other than its own; and the run record re-tallies to its result. |
| E11 | 7 | A live run of mission-kit's `explain` suite on both driven runtimes, readers from three families and judges from the other two, reaches tallied; every reader-probe pair holds two validated votes or a recorded absence scored 0; and no judge prompt contains text that followed the self-explanation marker. |
| E12 | 1, 2, 4 | For each of the three hooks, in contract tests and in the synthetic pack, a hook that attempts the network, reads outside its inputs, writes outside its folder or exceeds its time limit is stopped and gives its failure result - the pack failed; the arm not built and not run; the properties incomplete - and each hook's success path is used in the E7 tests. |
| E13 | 2, 4 | A built variant contains no occurrence of any address the pack declares for its source, and the run record names the source revision the variant was built from. |
| E14 | 4, 5 | In the run record, every code score carries a time earlier than the blinding of its outcome. |
| E15 | 5 | The judge panel refuses to assign a judge of an outcome's own family, and its test fails when that refusal is removed. |
| E16 | every | `tsc -b` exits 0 with `strict` enabled and no file excluded from type checking, and `node --test` runs every test against the built output. |

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

## Record

**Stage 1.**\
Built: the workspace; the pack schema; the pack checker, with twenty-one listed checks; the hook runner; the experiment register; the selector and suites; a command line; the synthetic pack; mission-kit's pack at `docs/evals/context-lab/` in mission-kit's repository.\
Found while building, and done within the fence:

- The pack schema gained fields mission-kit's pack needed to carry its suites as they are: inline fixtures; a scenario's starting state, scoring note, scored file and notes; a property's rubric and notes; an experiment's instructions, preamble and judge instructions; and the arms each leak probe's content is withheld from, with a check that they exist.
- The experiment register lives in the pack's own `register/` folder, not with run records, because it is the evidence an experiment was fixed before its outcomes and the project keeps it with the experiment.
- E12's failure results are staged: the declaration-check failure is enacted at stage 1; the variant-transform and outcome-measure failures are enacted by the components that call them, at stages 2 and 4, and E12 is evaluated in full at stage 4.
- Wording held in mission-kit's tool code - the reader prompt and default scorer text of `eval.mjs`, the response schema and chunking of `adherence.mjs` - is transcribed into the pack at stages 4 and 5, when the phase driver and judge panel define where it goes.
- E7's literal list was frozen from mission-kit's pack as the criterion lists it; an experiment id, `adherence`, was left out because it is also one of the core's own property types.
- mission-kit's pack was accepted by the checker at mission-kit revision `4883a4a`, and unchanged at `50980da`.

**Stage 1 verification.**\
An agent that built none of the code evaluated stage 1, mutation-testing every check: E1, E2 and E16 green; E3 and E12 red.\
E3's clause "recorded in the run record" cannot be met before a run record exists, and E12's tests for the network and the time limit passed even with those bounds removed - the network test failed on name lookup, not the closed namespace, and the time-limit test checked a flag, not that the hook stopped.

**Amendments after verification, by the executor, confirmed by the director (`0010`).**

- The stage column of E3 and E12 now states the stages that complete them, as stage 1's own text already did for E12; the stage list says which part of each is evaluated where.
- The network test connects to an address on the internet and to a listener on the host; the time-limit test asserts the hook stopped within two seconds of its limit and that a process it started did not outlive it, with a test timeout so each such test fails rather than waits; a run whose hooks are never stopped still leaves their processes running, so the whole run needs an outer limit. Each was mutation-tested: removing the network namespace, or the kill, fails it.
- The content hash now also covers each source declaration, every hook's declaration including its time limit, the declaration-check hook file, the experiment's suites, and fixture files behind symbolic links.
- Every part of a multi-part check has its own fixture; a declaration-check hook's defect is asserted as written; a pack may declare one declaration-check hook only, a new check; the entry view lists a scenario once; the sandbox binds the Node binary, not its installation directory.
- The test that only asserted a failure result was stated was removed: the results are enacted at stages 2 and 4.

**Re-verification.**\
The same agent re-checked: E1, E2, E3 for stage 1 and E12 for stage 1 green, each new test mutation-tested; five minor findings followed - a masked missing-field fixture, the whole-run hang, an untested entry-view fix, the staging detail above, and broken links in fixtures - and are fixed, the last by a new part of the fixture check.

**Limits found, not fixed.**\
A hook that catches its own denied attempts still returns success: the sandbox prevents what a hook may not do, and does not detect that it tried.\
Re-recording an experiment after seeing outcomes restores its declared status; stage 4 compares a record's time with its outcomes' (`B13`).

**Stage 2.**\
Built: the variant builder, exporting through git at a pinned revision, applying excludes, includes and the transform hook, rewriting declared addresses longest first, planting canaries, and writing a manifest with the revision; the arm composer; the workspace builder.\
Run against mission-kit's pack at `5e48932`, whose corpus outside `docs/` is the same as at `13c4879`: seven addresses rewritten, none left, `docs/` excluded, and the always-on arm composed to eighteen instruction files.\
Found while building, and done within the fence:

- Each guided arm receives its variants' canary file as one more instruction, so the isolation prober can show the instructions arrived; it is a stated addition to the context, the same in every guided arm.
- mission-kit's pack declares every published form of its address - the repository, its `blob/main` and `tree/main` paths, and raw files under `/main` - because rewriting the bare address alone would leave raw links pointing at a wrong path.
- E13's second clause, that the run record names the revision, can only be shown once a run record exists; the variant's manifest records the revision now, and the run record carries it at stage 4 - a restaging like `0010`'s, confirmed (`0011`).

**Stage 2 verification.**\
The same verifier found E13 and E12, for stage 2, green, and two major defects in the components: an `exclude` naming a path outside the source deleted a folder beside the output, and links escaped - a link in a source, in a transform hook's output, or in a fixture carried a read past every bound, in one case to the pack's own answer key.\
Fixed: every path a pack names inside a source, variant, fixture or itself must be relative and stay inside, a new check; a link is followed only if it stays inside the folder it was found in, and is otherwise refused, in variants, hook output and fixtures; containment is compared on path separators, not string prefixes; workspace bases are judged on their real paths; variant folders are read-only as well as their files; staging folders have unique names; the workspace's commit runs none of the operator's git hooks or templates; include and exclude semantics are documented; the untested refusals and the longest-first rewriting each have a test.

**Stage 2 re-verification, and an incident.**\
The verifier re-ran its probes: every stage 2 defect fixed and E13 and E12 still green.\
One of its mutation runs changed the permissions of the operator's home folder: a test linked a source folder to the real home folder, the mutant kept the link, and `makeReadOnly` changed what the link pointed to; the verifier restored the owner's write access, and the original group and other bits are not known.\
The cause was in the build, not the verifier: a test that pointed a link at a real folder, and two exported functions that followed links.\
Fixed: tests point links only at scratch folders; `makeReadOnly` and `makeWritable` never follow a link; a source or fixture folder linking back to its parent is refused instead of copied without end, and the pack check reports it instead of failing; a failed export leaves no staging folder; an exclude of the whole source is a defect; scratch folders are removed when tests finish; and the protections the verifier found untested each have a test.

**Stage 3, before any adapter.**\
The adapter conformance cases (`packages/core/test/conformance/CASES.md`) were accepted by the verifier at revision 4, after three reviews, before any adapter was written, as stage 3 requires.\
The reviews changed the design within the fence: driven runtimes run inside a bubblewrap filesystem sandbox, the network shared for the provider, so a path an arm does not give an agent does not exist for it - probed on both runtimes on this machine.\
Without it, a Codex agent could read the whole disk, which its own sandbox allows, and a Codex judge could not have its tools taken away.\
They also corrected Codex's output-token arithmetic, mapped Codex web search as a fetch, found that `--ignore-user-config` would have made Codex ignore the configuration holding an arm's instructions, and added the fields the validity classifier needs.

**Stage 3.**\
Built: the opencode, Codex and external adapters, running driven runtimes in the filesystem sandbox; the common outcome form and its two parsers; the isolation prober; the validity classifier.\
Expected outcomes for the conformance streams come from a separate derivation in Python, written from the cases rather than the code; the two first disagreed on words inside a `sed` expression, and the cases now state the word rule both follow.\
Live checks of every configuration claim pass on opencode 1.18.35 and codex-cli 0.162.1 (`packages/core/test/live/config-claims.live.ts`).\
The first live web check passed while Codex opened a page through its apps connector, which the check did not name: Codex's hosted tools that leave the sandbox are now switched off, and the check judges whether the page's content reached the agent, not which tool was used.\
That gap was present in mission-kit's adherence runs: GPT agents there had web search, and two control agents used it - for Codex's own documentation, not for mission-kit; recorded in mission-kit's audit.\
The isolation prober is tested with a scripted adapter here; its live runs are criterion E4, at stage 7.

**Stage 3 verification.**\
The verifier found E6 green and E5 red: opencode runs tools inside a step and reports them only when they end, so an opencode agent stopped while working leaves a step open and read as waiting on the model - infrastructure - making E5's behaviour timeout unreachable for opencode.\
It also found three major defects, all fixed and re-checked: twelve copies of the operator's Codex login left by the live checks, now deleted, with the adapter removing its copy after each invocation and the live checks removing their records; a Codex probe passable by reading the canary file rather than receiving it, now refused, since a probe answer counts only without tool calls and a tool call fails the probe; and forbidden addresses missed in common forms, now matched in every written form the verifier listed.\
Re-verification: E6 green, E5 green as written; all eleven live checks pass with the wider Codex features table.\
An opencode timeout with a step open is now `unknown`: infrastructure on a first attempt, behaviour on a re-run - a classification policy E5 does not settle, ruled by the director (`0012`).\
Known limits, stated in the classifier: addresses assembled at run time, percent-encoded, or reached through another program or mirror are not found; a mere mention of a forbidden address counts as reaching it.

**Stage 4.**\
Built: the phase driver, one phase in a new session; the run conductor, through validated, recorded, built, probed, executed and measured, each state's time kept, writing a run record with the pack, the register entry it rests on, the method's version, every variant's revision, the scenarios resolved, every probe answer and every attempt of every cell; the answer parser; the code measurer with the outcome-measure hook; a `run` command.\
The experiment register is now append-only - recording again adds an entry and never replaces one - and a run refuses a record made after it began (`B13`).\
The run conductor passes each cell's attempt count to the classifier (`0012`). mission-kit's `explain` experiment now carries the reader framing transcribed from `tools/eval.mjs`, adapted where each probe became its own cell; the difference is recorded in the experiment.\
An integration smoke run of the synthetic pack on the real runtimes - claude-opus-5-5 through opencode, gpt-6-astra through Codex, two scenarios, two arms, one run - reached measured with every probe passing and every cell valid, and no credential anywhere in its record or working folder.\
It also showed each opencode invocation copying a 150 MB cache: the copy is now removed when the runtime ends.\
E14 asks that every code score precede the blinding of its outcome; stage 4 times every score and keeps it before the run leaves measuring, and the blinder that completes the check is stage 5's - so E14 is evaluated at stages 4 and 5, a restaging confirmed by the director (`0013`).

**Stage 4 verification.**\
A fresh verifier - the earlier one's session ended on a provider content filter - found E7, E14's stage-4 part, the run-record clauses of E3 and E13, the rest of E12 and `0012` green, and B13's run refusal untested.\
It found two major defects, both fixed: an agent could put a link at a scored file and have the core copy any file it named into the run record; and the run record was written only at the end, so one failing cell lost the whole run.\
Fixed besides: the record is written at every state and as each cell ends, a cell the core cannot complete is recorded and the run goes on, and variants are made writable even after a failure; each attempt keeps its own diff; `0012` counts open-step timeouts, not attempts, so an isolation re-run does not make a first such timeout behaviour; the refusal of a later record happens before any cell runs, and is tested; overriding runs per cell makes a run exploration; the time limit and each runtime's version are recorded; every run record, the whole working folder and every source are forbidden, except a cell's own workspace and its arm's on-request folders; the diff includes files any exclude rule would hide; the measure hook gets the final message uncut; tests now pin values, not shapes.\
Each new protection was shown load-bearing by removing it, except the operator-excludes rule, which `--force` makes redundant and is removed.\
Disclosed: the stage-4 commit changed E14's stage column and section 2 before the director confirmed the restaging.\
Ruled by the director: the restaging of E14 (`0013`); and mission-kit's `explain` suite as one cell per reader with its wording verbatim (`0014`) - properties now name the heading their answer sits under in the scored file, the run conductor splits the file per property, and the prompt the core builds for that suite was compared with `eval.mjs`'s and is identical but for the two paths.

**Stage 5.**\
Built: the blinder, which splits each valid cell into judged units - its judged properties together, or one property's split answer alone - masks identifiers and the workspace path, seals the mapping with each unit's blinding time, and refuses a unit whose code scores were not taken strictly before it (E14); the judge panel, which assigns every judge of another family and never one of the unit's own (E15), sends each judge its units in an order of its own with tools off, validates every reply and asks up to three times; the tally, which reads only the run record, scores a behaviour-invalid cell 0 and excludes and lists other invalid cells, scores an absent answer 0, and reports rates per arm and member, vote agreement and the judges' guess rate against its base rate; and the states blinded, judged and tallied, with judges' isolation probed beside the arms'.\
Experiments may now declare their judges and the conditions judges guess between.\
A smoke run of the synthetic pack on the real runtimes reached a tallied result.\
It found two defects, both fixed: rewritten links in a variant pointed agents at the variant's own files, which counted as isolation, so a cell may now touch its own arm's variants; and a sandboxed agent naming a path outside its sandbox was counted as a breach although the path did not exist for it - for a sandboxed runtime such a path is now recorded, not invalidating, while forbidden addresses still are, the network being shared.\
It also found opencode installing about 160 MB of packages into each invocation's folder, now removed when the runtime ends.\
The E7 literal list holds short property ids; one, `x6`, matched a hexadecimal constant in the blinder, now written in decimal - a false match of the list, not a mention of mission-kit.

**Stage 5 verification.**\
The stage 4 verifier found E15 and E14's stage-5 part green, most stage 4 findings fixed, and four major defects in judging, all fixed: a scored file reachable through a linked folder, now read only when its real path is a regular file in the workspace; re-tallying that depended on the pack as it is now, now from a snapshot the run record keeps; judges shown the variant's path, the canary and self-explanation written into a file, now masked; and a guess rate that would read 0 of 0 for mission-kit's adherence suite, whose judges guess guided or unguided, now declared in its pack.\
Fixed besides: one judge failing no longer stops the run; the seed alone fixes the blinding; a reply missing one outcome keeps the rest and asks again for the missing one; agreement needs two votes; a total needs every property's mean; the base rate is taken over the guesses made; an empty answer is absent; a judge reply reached with a tool is discarded; judges have their own time limit; judges are not asked to guess between one condition; and an arm may touch only the files it was given, not the rest of its variant.\
Answer units are judged in the comprehension form carried from `eval.mjs`'s scorer prompt, its lines verbatim but for one: its scorer wrote a file and replied DONE, and a judge here has no tools, so it replies with the lines (`0016`); and a sandboxed runtime naming a forbidden path outside its sandbox is recorded and does not invalidate the cell (`0015`).

**Stage 6.**\
Built: two legacy-record readers (`packages/core/test/parity/legacy-readers.ts`), converting mission-kit's eval run `delta-01` and adherence run `adherence-03` into the core's tally input by format conversion only, each counting exactly the records its old tool counted; and a parity script comparing the core's tally with each run's published `RESULT.json`.\
Result: 643 values compared, none differing - every `mean` and `total` of `delta-01` rounded as `toFixed(2)` rounds, and for every trap and property of `adherence-03` the `byArm` and `byArmFam` mean, count and incomplete count, agreement, and the guesses right, all and guided.\
The first parity run found a defect in the core's tally: it keyed guesses by joining a unit id and a judge with a dot, which a unit id holding dots broke; now keyed as a pair, with a test.\
What parity cannot show: neither run has an incomplete vote, so the tally's incomplete rule is held by its unit tests alone - a change to that rule left all 643 values equal.\
The parity script runs by hand, since the run records are local to this machine and never published.

**Stage 6 verification.**\
E8 and E9 green: all 643 values compared, the script failing under every tally change it should catch; the readers do format conversion only and count what the old tools counted on every record a published run can hold.\
Found and fixed: the last `explain` question shown to judges carried the reader's answer-file and reply-DONE lines, because the question was read from the task - properties may now carry the question, and mission-kit's pack carries each verbatim; self-explanation over several lines of a file still reached judges, now cut to the end of that file's changes; the comprehension judge prompt had dropped `eval.mjs`'s sentence forbidding other files, now restored; the agreement and unreachable-path rules gained tests that fail without them.\
Known differences from the old tools, on runs these two do not contain: the core counts an outcome complete with all its assigned votes, however few, where `adherence.mjs` required two; and it totals unrounded means, giving no total when a mean is missing, where `eval.mjs` summed rounded means and counted a missing one as 0.\
Parity holds neither the incomplete rule nor the absent rule, since neither run contains such a case; their unit tests do.

**Stage 7.**\
The first live run of mission-kit's adherence suite was stopped by the executor during execution, after 18 cells: the pack's S15 leak pattern matched the word `sub-set`, which one on-trigger agent used in restating the question; the pattern now matches S15's sentence, as `adherence.mjs` required, and the stopped run is recorded as failed (`2026-10-11-090959-adherence`); its own record says it stopped at probing, which is wrong - probing had finished.

Run `2026-10-11-092325-adherence` (E10): started by suite name, mission-kit at `8e469b3`, opencode 1.18.35, codex-cli 0.162.1; every probe of the nine arm-member pairs and three judge setups passed before any cell ran; all 135 cells valid, none re-run; 864 votes, every outcome two votes from the other families, none missing; the run record re-tallies to its result.\
Run `2026-10-11-102022-explain` (E11): on-trigger, readers of three families, judges of the other two; all probes passed; every reader-probe pair holds two validated votes, none absent; no judge prompt holds text after the self-explanation marker; the record re-tallies to its result.\
Both runs are exploration: neither experiment was recorded before it ran.

**Beside `adherence-03`, reported and not judged** (`0007`, M1.2).\
Published `adherence-03` mean / core run mean, per arm:

| Property | control | on-trigger | always-on |
|---|---|---|---|
| x1 | 0.44 / 0.33 | 1.00 / 1.00 | 1.00 / 1.00 |
| x2 | 0.11 / 0.11 | 0.94 / 0.94 | 0.83 / 0.83 |
| x3 | 0.00 / 0.00 | 0.39 / 0.22 | 0.44 / 0.44 |
| x4 | 0.89 / 0.89 | 1.00 / 1.00 | 1.00 / 1.00 |
| x5 | 0.67 / 0.72 | 1.00 / 1.00 | 0.89 / 1.00 |
| x6 | 0.00 / 0.00 | 0.72 / 0.61 | 0.67 / 0.67 |
| x7 | 0.89 / 1.00 | 0.94 / 0.94 | 0.94 / 1.00 |
| a11-1 | 0.00 / 0.00 | 0.56 / 0.67 | 0.67 / 0.67 |
| a11-2 | 0.00 / 0.11 | 0.50 / 0.61 | 0.61 / 0.56 |
| a2-1 | 0.33 / 0.56 | 0.78 / 0.67 | 0.89 / 0.78 |
| a2-2 | 0.44 / 0.67 | 0.89 / 0.61 | 0.89 / 0.78 |
| a13-1 | 0.11 / 0.00 | 0.86 / 0.78 | 1.00 / 1.00 |
| a13-2 | 0.89 / 1.00 | 0.93 / 1.00 | 0.94 / 1.00 |
| a4-1 | 0.56 / 0.56 | 0.56 / 0.44 | 0.44 / 0.44 |
| a4-2 | 0.50 / 0.50 | 0.56 / 0.44 | 0.39 / 0.44 |
| a4-3 | 0.56 / 0.56 | 0.56 / 0.44 | 0.44 / 0.44 |

Known differences between the two runs: local delivery instead of fetches from `main`, with network denied to GPT agents and detected for the others; the filesystem sandbox; GPT agents' web search and hosted connectors off; mission-kit's corpus a day later; masking and judge prompts rebuilt in the core; and run-to-run variation, not yet stated for this suite.\
**Beside mission-kit's last `explain` run, reported and not judged.**\
Published `2026-10-03-explain-baseline-rescored`, label `head` / core run, mean of 0 to 2: X1 2.00 / 0.94; X2 1.33 / 0.11; X3 2.00 / 0.28; X4 1.67 / 0.94.\
The gap is large and its cause is not established.\
Known differences: that run's keys were later corrected after independent review and by a director ruling on two properties; its corpus held no explain guidance yet; its three readers were one family and its one scorer the same family, where here readers are three families and every answer has two judges of the others; and nine days of corpus change lie between them.\
The `A4` trap still carries the relative date that made it measure nothing in `adherence-03` (mission-kit `B75`), because the pack carries suites as they are.

**Closing evaluation.**\
The verifier evaluated E1 to E16 against the code and the live records: all green.\
Its notes, applied here: the E10 revision is `8e469b3`, not `fc06e1d`; the first run stopped during execution, not at probing; the `explain` comparison section 6 promised is added above.\
Also noted, not defects: sixteen cells named folders above their workspace while looking for `AGENTS.md`, listed in the result as `0015` requires; and the `[ID]` mask appeared in 2 of 45 on-trigger units and no other, a small tell beside a guess rate of 75% against a base rate of 67%.

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

**Amended after the review, before ratification.**\
The language changed from JavaScript to TypeScript by director ruling, and criterion E16 was added; the build line, stage 1 and the criteria table are the only text changed, and the change was not re-reviewed.
