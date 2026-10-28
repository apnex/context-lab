// The isolation prober passes an arm only if its canary is quoted, no foreign canary is quoted, no
// leak probe matches, and something was answered. A scripted adapter stands in for a runtime; live
// probes are criterion E4, at stage 7.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CANARY_QUESTION, checkPack, probeArm, probeRetryPrompt, type Adapter, type ComposedArm, type Invocation, type LoadedPack, type Outcome } from "../src/index.js";
import { copyPack, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

function scripted(answer: (inv: Invocation) => Outcome): Adapter & { prompts: string[] } {
	const prompts: string[] = [];
	return { runtime: "scripted", rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false, compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null, prompts,
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

test("an answer reached by a tool call on all three tries does not count; a tool call or provider failure retried cleanly passes (B19)", async () => {
	const { loaded, guided } = await setup();
	const tool = { name: "command_execution", input: "cat context-lab-canary.md", status: "completed" as const, paths: [], addresses: [] };
	const r = await probeArm(loaded, guided, member, scripted(() => outcome("The heron counts eleven stones.", { tools: [tool] })), opts());
	assert.equal(r.pass, false);
	assert.equal(r.answers[0]!.answered, false);
	assert.match(r.reasons.join(), /tool call during a probe/);

	assert.equal(r.answers[0]!.attempts, 3);

	let tries = 0;
	const a2 = scripted(() => (++tries < 3 ? outcome("used tool", { tools: [tool] }) : outcome("The heron counts eleven stones.")));
	const r2 = await probeArm(loaded, guided, member, a2, opts());
	assert.equal(r2.pass, true);
	assert.equal(tries, 3);
	assert.equal(r2.answers[0]!.attempts, 3);
	// A retry after a tool call says why no read can help, then repeats the question unchanged.
	assert.deepEqual(a2.prompts, [CANARY_QUESTION, probeRetryPrompt(CANARY_QUESTION), probeRetryPrompt(CANARY_QUESTION)]);
	assert.match(a2.prompts[1]!, /^No guidance entry or on-request folder is mounted for this question/);
	assert.ok(a2.prompts[1]!.endsWith(`\n\n${CANARY_QUESTION}`));

	let errTries = 0;
	const r3 = await probeArm(loaded, guided, member, scripted(() => (++errTries === 1 ? outcome("", { error: { cause: "provider", name: "APIError", message: "429 rate limit" } }) : outcome("The heron counts eleven stones."))), opts());
	assert.equal(r3.pass, true);
	assert.equal(errTries, 2);
	assert.equal(r3.answers[0]!.attempts, 2);

	// A provider failure after a tool call does not drop the retry prompt for the attempt after it.
	let mixed = 0;
	const a4 = scripted(() => {
		mixed++;
		if (mixed === 1) return outcome("used tool", { tools: [tool] });
		if (mixed === 2) return outcome("", { error: { cause: "provider", name: "APIError", message: "503 overloaded" } });
		return outcome("The heron counts eleven stones.");
	});
	const r4 = await probeArm(loaded, guided, member, a4, opts());
	assert.equal(r4.pass, true);
	assert.deepEqual(a4.prompts, [CANARY_QUESTION, probeRetryPrompt(CANARY_QUESTION), probeRetryPrompt(CANARY_QUESTION)]);
});

test("leak patterns are matched without regard to case", async () => {
	const { loaded, bare } = await setup();
	const r = await probeArm(loaded, bare, member, scripted(() => outcome("ELEVEN, I believe.")), opts());
	assert.equal(r.pass, false);
});

test("B30: probeArm retains per-attempt history, enforces maxAttempts, maxReplyBytes, stdoutTruncated ineligibility, and sticky violation across retries", async () => {
	const { loaded, bare } = await setup();
	// 1. Sticky leak violation: attempt 1 leaks AND uses a tool (or exceeds maxReplyBytes), attempt 2 returns a clean short reply -> probe still fails with leak!
	const tool = { name: "command_execution", input: "cat file", status: "completed" as const, paths: [], addresses: [] };
	let step = 0;
	const leakyThenClean = scripted((inv) => {
		if (!inv.prompt.includes("heron count")) return outcome("NONE");
		step++;
		if (step === 1) return outcome("It counts eleven stones.", { tools: [tool] });
		return outcome("I do not know.");
	});
	const rSticky = await probeArm(loaded, bare, member, leakyThenClean, { ...opts(), maxAttempts: 2 });
	assert.equal(rSticky.pass, false);
	const heronAns = rSticky.answers.find((a) => a.probe === "heron")!;
	assert.equal(heronAns.finding, "leak");
	assert.equal(heronAns.history?.length, 1, "a detected leak stops retrying immediately and stays sticky");
	assert.equal(heronAns.history![0]!.finding, "leak");
	assert.equal(heronAns.history![0]!.eligible, false);
	assert.equal(heronAns.history![0]!.ineligibleReason, "tool-call");

	// 2. maxReplyBytes rejects an oversized clean reply on attempt 1, then accepts an in-bound reply on attempt 2; history records both.
	let sizeTries = 0;
	const sizeAdapter = scripted((inv) => {
		if (!inv.prompt.includes("heron count")) return outcome("NONE");
		sizeTries++;
		return sizeTries === 1 ? outcome("I do not know. ".repeat(30)) : outcome("I do not know.");
	});
	const rSize = await probeArm(loaded, bare, member, sizeAdapter, { ...opts(), maxAttempts: 2, maxReplyBytes: 50 });
	assert.equal(rSize.pass, true);
	const heronSize = rSize.answers.find((a) => a.probe === "heron")!;
	assert.equal(heronSize.attempts, 2);
	assert.equal(heronSize.history?.length, 2);
	assert.equal(heronSize.history![0]!.ineligibleReason, "reply-bytes-exceeded");
	assert.equal(heronSize.history![1]!.eligible, true);

	// 3. stdoutTruncated attempt is ineligible ("stdout-overflow") and usageComplete: false.
	const rOverflow = await probeArm(loaded, bare, member, scripted(() => outcome("NONE", { stdoutTruncated: true, capturedStdoutBytes: 100, usageComplete: false })), { ...opts(), maxAttempts: 1 });
	assert.equal(rOverflow.pass, false);
	assert.equal(rOverflow.answers[0]!.history![0]!.ineligibleReason, "stdout-overflow");
	assert.equal(rOverflow.answers[0]!.history![0]!.usageComplete, false);
});
