import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { boundUtf8, extractAnswer, promptFor, splitAnswers, stripSelfExplanation, type CellRecord, type ComposedArm, type Experiment, type RunRecord, type Scenario } from "../src/index.js";

test("text after the self-explanation marker is cut", () => {
	assert.equal(stripSelfExplanation("The message.\nCORPUS-SOURCES: S15, M10", "CORPUS-SOURCES:"), "The message.");
	assert.equal(stripSelfExplanation("No marker here.", "CORPUS-SOURCES:"), "No marker here.");
	assert.equal(stripSelfExplanation("  Kept whole.  ", undefined), "Kept whole.");
});

test("an answer file is split under its headings, absent answers are null, and markers cut", () => {
	const text = "### explain.X1\nFirst.\nCORPUS-SOURCES: S15\n### X3\nThird.\n### OBSERVATIONS\nnone\n";
	const m = splitAnswers(text, ["X1", "X2", "X3"], "CORPUS-SOURCES:");
	assert.deepEqual(Object.fromEntries(m), { X1: "First.", X2: null, X3: "Third." });
});

test("splitAnswers accepts heading levels # through ######, trailing titles after the id, reordered headings, and keeps the first non-empty duplicate while ignoring Observations", () => {
	const text = [
		"# Q02 - Second question",
		"Answer two.",
		"## Q01: First question",
		"",
		"#### Q01 - Duplicate with content",
		"Answer one.",
		"###### Q01 - Later duplicate ignored",
		"Should not overwrite.",
		"## Observations",
		"Trailing observations ignored.",
	].join("\n");
	const m = splitAnswers(text, ["Q01", "Q02", "Q03"]);
	assert.deepEqual(Object.fromEntries(m), {
		Q01: "Answer one.",
		Q02: "Answer two.",
		Q03: null,
	});
});

test("a prompt is the instructions, preamble and task, with placeholders filled", () => {
	const exp = { id: "e", declaredStatus: "result", scenarios: [], factors: { arms: [], population: [] }, runsPerCell: 1, phases: [{ id: "p", session: "new" }], instructions: "Read only files under {ON_REQUEST}.", preamble: "The human is busy." } as Experiment;
	const sc = { id: "s", tags: [], fixture: null, task: "Write the message.", properties: [] } as Scenario;
	const arm = { arm: "a", instructions: [], folderFiles: [], onRequest: [{ variant: "v", path: "/corpus" }], canaries: [], negativeCanaries: [], revisions: {} } as ComposedArm;
	assert.equal(promptFor(exp, sc, arm, "/ws"), "Read only files under /corpus.\n\nThe human is busy.\n\nWrite the message.");
	assert.equal(promptFor({ ...exp, instructions: undefined, preamble: undefined } as unknown as Experiment, sc, arm, "/ws"), "Write the message.");
});

test("boundUtf8 preserves in-budget text and truncates oversized text at a valid UTF-8 code-point boundary", () => {
	// 1. In-budget text is unchanged.
	const ok = boundUtf8("hello", 10);
	assert.equal(ok.text, "hello");
	assert.deepEqual(ok.bound, { limitBytes: 10, originalBytes: 5, effectiveBytes: 5, truncated: false, reason: null });

	// 2. Exact boundary is unchanged.
	const exact = boundUtf8("12345", 5);
	assert.equal(exact.text, "12345");
	assert.equal(exact.bound.truncated, false);

	// 3. Multi-byte cut: "a" (1 byte) + "€" (3 bytes: E2 82 AC) + "b" (1 byte) = 5 bytes.
	// Cutting at limit 3 must not split the 3-byte "€" sequence; it must keep only "a" (1 byte).
	const multi = boundUtf8("a\u20acb", 3);
	assert.equal(multi.text, "a");
	assert.equal(Buffer.from(multi.text, "utf8").includes(0xfffd), false);
	assert.deepEqual(multi.bound, {
		limitBytes: 3,
		originalBytes: 5,
		effectiveBytes: 1,
		truncated: true,
		reason: "truncated from 5 to 1 UTF-8 bytes (limit 3)",
	});

	// Cutting at limit 4 keeps "a€" (4 bytes).
	const multi4 = boundUtf8("a\u20acb", 4);
	assert.equal(multi4.text, "a\u20ac");
	assert.equal(multi4.bound.effectiveBytes, 4);
	assert.equal(multi4.bound.truncated, true);
});

test("extractAnswer reports each extraction finding, overlapping where they overlap, and takes the answer splitAnswers takes (B23)", () => {
	const at = { source: "final" as const, phase: "work", attempt: 1 };
	const ex = (text: string, id = "Q1", before = text, requested = ["Q1", "Q2"]) => extractAnswer(text, before, id, requested, "MARK:", at);
	// No heading.
	const none = ex("Just prose, no headings.");
	assert.deepEqual([none.answer, none.extraction.findings, none.extraction.matched, none.extraction.selected], [null, ["no-heading"], 0, null]);
	// A matched section that is empty; the self-explanation marker empties it too, and endedAt names the heading that followed it (B26).
	const empty = ex("### Q1\nMARK: S15\n### Q2\nb\n");
	assert.deepEqual([empty.answer, empty.extraction.findings, empty.extraction.emptyMatched, empty.extraction.endedAt], ["", ["empty-section"], 1, { heading: "Q2", requested: true, bytes: 0 }]);
	const emptyAtEnd = ex("### Q1\nMARK: S15\n");
	assert.deepEqual([emptyAtEnd.answer, emptyAtEnd.extraction.findings, emptyAtEnd.extraction.endedAt], ["", ["empty-section"], null]);
	// An empty question heading followed directly by an unrequested subheading reports endedAt and ended-at-unrequested-heading alongside empty-section (B26).
	const immedSub = ex("# Q1\n## Decision\nUse the router.\n### Support\nLine two.\n# Q2\nb\n");
	assert.deepEqual([immedSub.answer, immedSub.extraction.endedAt, immedSub.extraction.findings], ["", { heading: "Decision", requested: false, bytes: 24 }, ["empty-section", "ended-at-unrequested-heading"]]);
	// Headings inside fenced code blocks (backticks or tildes) do not end an answer (B26, B27).
	const fenced = ex("### Q1\nBefore.\n```sh\n# shell comment\n### Q2\necho hi\n```\n~~~md\n# Q2\n~~~\nAfter.\n### Q2\nReal two.\n");
	assert.equal(fenced.answer, "Before.\n```sh\n# shell comment\n### Q2\necho hi\n```\n~~~md\n# Q2\n~~~\nAfter.");
	assert.deepEqual([fenced.extraction.endedAt, fenced.extraction.findings], [{ heading: "Q2", requested: true, bytes: 0 }, []]);
	// Duplicate headings: the first non-empty is taken, and its place recorded.
	const dup = ex("### Q1\n\n### Q1\nsecond\n### Q1\nthird\n");
	assert.deepEqual([dup.answer, dup.extraction.findings, dup.extraction.matched, dup.extraction.selected], ["second", ["duplicate-heading"], 3, 2]);
	// A cut inside the answer, at a multi-byte character: three bytes removed (the two of e-acute and one of b).
	const full = "### Q1\na\u00e9b";
	const cut = boundUtf8(full, Buffer.byteLength("### Q1\na", "utf8") + 1);
	assert.equal(cut.text, "### Q1\na");
	const shortened = ex(cut.text, "Q1", full);
	assert.deepEqual([shortened.answer, shortened.extraction.bounded, shortened.extraction.cutBytes, shortened.extraction.findings], ["a", true, 3, ["cut-by-bound"]]);
	// The heading itself beyond the cut: no heading in the text read, and the cut is not hidden by it.
	const beyond = ex("intro\n", "Q1", "intro\n### Q1\nans\n");
	assert.deepEqual([beyond.answer, beyond.extraction.findings, beyond.extraction.matchedBeforeBound], [null, ["no-heading", "heading-beyond-bound", "cut-by-bound"], 1]);
	// An answer ending at a heading that names no requested answer, with text under it; and one ending at the next requested heading.
	const lost = ex("### Q1\nans\n## Evidence\nmore\n#### Detail\nx\n### Q2\nb\n");
	assert.deepEqual([lost.answer, lost.extraction.endedAt, lost.extraction.findings], ["ans", { heading: "Evidence", requested: false, bytes: 5 }, ["ended-at-unrequested-heading"]]);
	const clean = ex("### Q1\nans\n### Q2\nb\n");
	assert.deepEqual([clean.extraction.endedAt, clean.extraction.findings, clean.extraction.answerBytes], [{ heading: "Q2", requested: true, bytes: 0 }, [], 3]);
	assert.deepEqual([clean.extraction.heading, clean.extraction.source, clean.extraction.phase, clean.extraction.attempt, clean.extraction.bounded], ["Q1", "final", "work", 1, false]);
	// The same answer as splitAnswers, on every text above.
	for (const [text, id] of [["Just prose.", "Q1"], ["### Q1\nMARK: S15\n### Q2\nb\n", "Q1"], ["### Q1\n\n### Q1\nsecond\n", "Q1"], ["### Q1\nans\n## Evidence\nmore\n", "Q1"], ["# suite.Q2 - Title\nb", "Q2"], ["# Q1\n## Decision\nUse the router.\n# Q2\nb\n", "Q1"], ["### Q1\nBefore.\n```sh\n# shell comment\n### Q2\n```\nAfter.\n### Q2\nReal two.\n", "Q1"]] as const) {
		assert.equal(extractAnswer(text, text, id, ["Q1", "Q2"], "MARK:", at).answer, splitAnswers(text, [id], "MARK:").get(id), text);
	}
});

test("expectedHeadings ends an answer without firing ended-at-unrequested-heading (B24), and answerTermination 'question-or-expected' keeps internal subheadings across zorg and mission-kit recorded runs (B27)", () => {
	const at = { source: "final" as const, phase: "work", attempt: 1 };
	// 1. B24: a trailing ### OBSERVATIONS section ends Q2 without ended-at-unrequested-heading when expectedHeadings names OBSERVATIONS.
	const withObs = "### Q1\nFirst.\n### Q2\nSecond.\n### OBSERVATIONS\nNone noted.\n";
	const unflagged = extractAnswer(withObs, withObs, "Q2", ["Q1", "Q2"], undefined, at, { expectedHeadings: ["OBSERVATIONS"] });
	assert.equal(unflagged.answer, "Second.");
	assert.deepEqual(unflagged.extraction.endedAt, { heading: "OBSERVATIONS", requested: false, bytes: 11 });
	assert.deepEqual(unflagged.extraction.findings, []);
	const flagged = extractAnswer(withObs, withObs, "Q2", ["Q1", "Q2"], undefined, at);
	assert.deepEqual(flagged.extraction.findings, ["ended-at-unrequested-heading"]);

	// 2. B27 + AGP direct-peer: under answerTermination: "question-or-expected", internal subheadings (even immediately after # Q1) stay inside the answer up to the next question or expected heading.
	const subText = "# Q1\n## Decision\nUse the router.\n### Document support\nQUOTE: \"route by name\"\n# Q2\n#### Detail\nPart B.\n## Observations\nTrailing note.\n";
	const opts = { expectedHeadings: ["Observations"], answerTermination: "question-or-expected" as const };
	const q1 = extractAnswer(subText, subText, "Q1", ["Q1", "Q2"], undefined, at, opts);
	const q2 = extractAnswer(subText, subText, "Q2", ["Q1", "Q2"], undefined, at, opts);
	assert.equal(q1.answer, "## Decision\nUse the router.\n### Document support\nQUOTE: \"route by name\"");
	assert.deepEqual([q1.extraction.endedAt, q1.extraction.findings], [{ heading: "Q2", requested: true, bytes: 0 }, []]);
	assert.equal(q2.answer, "#### Detail\nPart B.");
	assert.deepEqual([q2.extraction.endedAt, q2.extraction.findings], [{ heading: "Observations", requested: false, bytes: 14 }, []]);
	assert.deepEqual(Object.fromEntries(splitAnswers(subText, ["Q1", "Q2"], undefined, opts)), { Q1: q1.answer, Q2: q2.answer });

	// 3. When sibling zorg and mission-kit recorded runs are present on disk, re-extracting every recorded cell with question-or-expected + expectedHeadings ["OBSERVATIONS", "census-zorg.Y1"] reproduces 100% of recorded answers (all 818 answers across 133 cells in 9 runs) with 0 false OBSERVATIONS flags.
	const recordedRuns: [string, string, string[]][] = [
		["/home/apnex/taceng/zorg/evals/runs/context-lab/2026-10-17-021542-census", "WHY:", ["OBSERVATIONS", "census-zorg.Y1"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-11-102022-explain", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-14-110208-explain", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-17-082606-c0", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-17-095808-c2", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-17-100515-c2", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-20-052459-c2", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-20-102650-m2-separation", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
		["/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-26-005243-absorb16", "CORPUS-SOURCES:", ["OBSERVATIONS"]],
	];
	for (const [dir, marker, expectedHeadings] of recordedRuns) {
		if (!fs.existsSync(path.join(dir, "run.json"))) continue;
		const r = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
		const scMap = new Map(r.snapshot.scenarios.map((s) => [s.id, s]));
		for (const cName of r.cells) {
			const c = JSON.parse(fs.readFileSync(path.join(dir, "cells", `${cName}.json`), "utf8")) as CellRecord;
			const sc = scMap.get(c.scenario)!;
			const props = sc.properties.filter((p) => p.answerHeading !== undefined);
			const ids = props.map((p) => p.answerHeading!);
			const text = c.scoredFile?.content ?? c.final ?? "";
			const split = splitAnswers(text, ids, marker, { expectedHeadings, answerTermination: "question-or-expected" });
			for (const p of props) {
				assert.equal(split.get(p.answerHeading!), c.answers[p.id], `${path.basename(dir)} ${cName} ${p.id}`);
				const ex = extractAnswer(text, text, p.answerHeading!, ids, marker, at, { expectedHeadings, answerTermination: "question-or-expected" });
				assert.equal(ex.answer, c.answers[p.id], `${path.basename(dir)} ${cName} ${p.id} extractAnswer`);
				assert.equal(ex.extraction.findings.includes("ended-at-unrequested-heading"), false, `${path.basename(dir)} ${cName} ${p.id} unexpected flag`);
			}
		}
	}
});
