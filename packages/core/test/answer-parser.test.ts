import assert from "node:assert/strict";
import { test } from "node:test";
import { promptFor, splitAnswers, stripSelfExplanation, type ComposedArm, type Experiment, type Scenario } from "../src/index.js";

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

test("a prompt is the instructions, preamble and task, with placeholders filled", () => {
	const exp = { id: "e", declaredStatus: "result", scenarios: [], factors: { arms: [], population: [] }, runsPerCell: 1, phases: [{ id: "p", session: "new" }], instructions: "Read only files under {ON_REQUEST}.", preamble: "The human is busy." } as Experiment;
	const sc = { id: "s", tags: [], fixture: null, task: "Write the message.", properties: [] } as Scenario;
	const arm = { arm: "a", instructions: [], folderFiles: [], onRequest: [{ variant: "v", path: "/corpus" }], canaries: [], negativeCanaries: [], revisions: {} } as ComposedArm;
	assert.equal(promptFor(exp, sc, arm, "/ws"), "Read only files under /corpus.\n\nThe human is busy.\n\nWrite the message.");
	assert.equal(promptFor({ ...exp, instructions: undefined, preamble: undefined } as unknown as Experiment, sc, arm, "/ws"), "Write the message.");
});
