import assert from "node:assert/strict";
import { test } from "node:test";
import { boundUtf8, promptFor, splitAnswers, stripSelfExplanation, type ComposedArm, type Experiment, type Scenario } from "../src/index.js";

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
