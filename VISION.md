# context-lab - vision

**Status: ratified by the director on 2026-10-10 (`docs/DECISIONS.md` 0001).**

---

## North star

Any project can find out, by experiments anyone can repeat, how the context it gives its agents changes what they understand and do.

**Terms, as this vision uses them.**

- **Context** - everything a project puts in front of an agent: instructions, documents, skills, and the manner, amount and moment of their arrival.
- **What they understand and do** - both comprehension and behaviour; each is measured, and neither stands in for the other.
- **Agent** - a language-model agent acting with tools, whether it codes, researches or operates.
- **Anyone** - anyone holding the experiment's record; the project decides who that is.
- **Project** - a body of work whose agents are given context, and whose owner holds authority over that context and its material.
- **Experiment** - a comparison of agents given different context, or the same context under different conditions, with how it will be judged stated before its outcomes are seen.
- **Repeat** - re-run from the experiment's record and reach a result within the variation the experiment stated in advance.
- **Result** - what one experiment showed, with its limits; a **finding** is a result a project has chosen to state as holding beyond that one experiment.

Readings rejected when the north star was chosen: the effect of instructions alone, which leaves out how and when context arrives; any claim about how agents behave, which reaches past what this is for; and the effect of a single change alone, which leaves out learning which context works and whether it helps at all.

---

## What this is, and what it is not

**It is:**

1. **An instrument for experiments on context.** Context is the subject; everything an experiment does not declare as a factor is held fixed, and whatever could not be shown fixed is reported.
2. **A shared method.** One set of rules for what makes an experiment valid and how its outcomes are judged, so results that meet those rules can be compared across projects.
3. **A durable record.** Every experiment is recorded - its context, its rules set in advance, its results - so that it can be repeated and compared.

**It is not:**

4. **A benchmark of models.** A model can be a factor in an experiment, never its subject.
5. **A target to tune context against.** Results are evidence about context, not goals; a rewrite is judged on experiments it was not written against.
6. **The owner of any project's experiments, material or conclusions.** Each project owns those; this owns only the method.
7. **Judgement by agents alone.** Where an outcome is for a person - a message, a decision put to them - any judgement not made by that person is checked against theirs.
8. **Tied to one agent runtime or model vendor.** Supporting another changes nothing about the method.

---

## Succeeding

Measured on five dimensions, never one score, and the first outranks the rest.

1. **Results inform decisions.** Projects' decisions about context cite experiments run here. It has failed if experiments run and no decision about context cites one.
2. **Adoption.** Projects run their context experiments here rather than building their own means to run them. It has failed if a project builds its own again.
3. **Repeatability.** A recorded experiment, repeated, reaches a result within the variation it stated. It has failed if one cannot be repeated from its record, or repeats outside its stated variation.
4. **Findings travel.** A finding a project chooses to share is tested in another project, confirmed or refuted, and recorded either way. It has failed if no shared finding is ever tested elsewhere.
5. **Honest reporting.** It has failed if a result is reported without its stated limits, or an experiment changed after its outcomes were seen is reported as a result rather than as exploration.

The first outranks the rest because results exist to be decided by: a method used everywhere and perfectly repeatable that informs no decision has given its results no use.\
Cost is reported with every result and is never a measure of success.

---

## Authority

The director holds this vision and ratifies any change to it.\
A ruling that changes direction is recorded as a decision and absorbed here; a changed vision is a new vision, ratified as such, never a second view of this one.

---

## What holding this vision does not authorise

Holding or citing this vision does not authorise:

1. **Treating a result as valid because it ran here.** Validity comes from meeting the method's rules; running here proves nothing by itself.
2. **Deciding for a project.** A result is evidence for the project's own authority; nothing here approves or blocks a project's change.
3. **Running agents against anything but material built for the experiment, without the owner's explicit consent.** A project's live systems, real data and shared repositories are out of reach unless the owner of that material consents, and the consent is part of the experiment's record.
4. **Publishing a project's material or results.** Only the project decides what leaves it.
5. **Changing the context a project's agents actually work from.** The variants an experiment builds are its own material; the project's own context is never edited, even when a result points to a rewrite.
