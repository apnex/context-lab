// The isolation prober passes an arm only if its canary is quoted, no foreign canary is quoted, no
// leak probe matches, and something was answered. A scripted adapter stands in for a runtime; live
// probes are criterion E4, at stage 7.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CANARY_QUESTION, checkPack, probeArm, type Adapter, type ComposedArm, type Invocation, type LoadedPack, type Outcome } from "../src/index.js";
import { copyPack, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

function scripted(answer: (inv: Invocation) => Outcome): Adapter & { prompts: string[] } {
	const prompts: string[] = [];
	return { runtime: "scripted", rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", refuse: () => null, prompts,
		async invoke(inv) { prompts.push(inv.prompt); return answer(inv); } };
}

async function setup(): Promise<{ loaded: LoadedPack; guided: ComposedArm; bare: ComposedArm }> {
	const r = await checkPack(copyPack());
	if (!r.ok) throw new Error("pack");
	const base = { folderFiles: [], onRequest: [], revisions: {} };
	return { loaded: r.loaded,
		guided: { ...base, arm: "almanac", instructions: [], canaries: ["The heron counts eleven stones."], negativeCanaries: ["The owl keeps the gate key."] },
		bare: { ...base, arm: "bare", instructions: [], canaries: [], negativeCanaries: ["The heron counts eleven stones."] } };
}
const member = { id: "p1", family: "f1", runtime: "scripted", model: "m" };
const opts = () => ({ base: path.join(scratch(), "probe") });

test("a guided arm that quotes its canary, and nothing foreign, passes", async () => {
	const { loaded, guided } = await setup();
	const a = scripted((inv) => outcome(inv.prompt === CANARY_QUESTION ? "The heron counts eleven stones." : "NONE"));
	const r = await probeArm(loaded, guided, member, a, opts());
	assert.equal(r.pass, true, r.reasons.join("; "));
	assert.deepEqual(a.prompts, [CANARY_QUESTION], "a probe withheld from no guided arm was asked of it");
});

test("a guided arm that does not quote its canary fails", async () => {
	const { loaded, guided } = await setup();
	const r = await probeArm(loaded, guided, member, scripted(() => outcome("NONE")), opts());
	assert.equal(r.pass, false);
	assert.match(r.reasons.join(), /did not arrive/);
});

test("an arm that quotes another variant's canary fails", async () => {
	const { loaded, guided } = await setup();
	const r = await probeArm(loaded, guided, member, scripted(() => outcome("The heron counts eleven stones.\nThe owl keeps the gate key.")), opts());
	assert.equal(r.pass, false);
	assert.match(r.reasons.join(), /another variant's canary/);
});

test("a bare arm whose withheld content leaks fails", async () => {
	const { loaded, bare } = await setup();
	const r = await probeArm(loaded, bare, member, scripted((inv) => outcome(inv.prompt.includes("heron count") ? "It counts eleven." : "NONE")), opts());
	assert.equal(r.pass, false);
	assert.match(r.reasons.join(), /leak probe heron/);
});

test("a bare arm with nothing withheld leaking passes", async () => {
	const { loaded, bare } = await setup();
	const r = await probeArm(loaded, bare, member, scripted(() => outcome("I do not know.")), opts());
	assert.equal(r.pass, true, r.reasons.join("; "));
});

test("an arm whose every question was filtered fails, showing nothing", async () => {
	const { loaded, bare } = await setup();
	const r = await probeArm(loaded, bare, member, scripted(() => outcome("", { filtered: true, error: { cause: "filter", name: "ContentFilterError", message: "blocked" } })), opts());
	assert.equal(r.pass, false);
	assert.match(r.reasons.join(), /shows nothing/);
});

test("a guided arm whose canary question was filtered fails", async () => {
	const { loaded, guided } = await setup();
	const r = await probeArm(loaded, guided, member, scripted(() => outcome("", { filtered: true })), opts());
	assert.equal(r.pass, false);
	assert.match(r.reasons.join(), /delivery is unshown/);
});
