// Stage 4: a run conducted end to end through measured, against a scripted adapter. Criteria: E3's
// run-record clause (the suite's scenario list is recorded), E13's (each variant's revision), E14
// (every code score is taken before the run leaves measuring), the rest of E12 (an unbuilt arm is
// not run; a failed measure hook leaves its properties incomplete; the synthetic pack's transform
// and measure hooks run on their success paths), decision 0012 (attempt counts reach the
// classifier), and B13 (the register is append-only, and a run rests on a record made before it).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, METHOD, STATES, checkPack, conductRun, recordExperiment, recordHistory,
	type Adapter, type CellRecord, type Invocation, type Outcome,
} from "../src/index.js";
import { commitAll, copyPack, editJson, packageRoot, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

type Answer = (inv: Invocation, n: number) => Outcome;

function scripted(runtime: string, answer: Answer = () => outcome("The rootstock is quince and the scion is pear.")): Adapter & { calls: Invocation[] } {
	const calls: Invocation[] = [];
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", refuse: () => null, calls,
		async invoke(inv) {
			calls.push(inv);
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off") return outcome("I do not know.");
			fs.writeFileSync(path.join(inv.workspace, "NOTE.txt"), "grafted\n");
			return answer(inv, calls.filter((c) => c.tools === "on").length);
		},
	};
}

async function setup(edit?: (dir: string) => void): Promise<{ dir: string; work: string; records: string }> {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.runsPerCell = 1; });
	edit?.(dir);
	commitAll(dir);
	return { dir, work: path.join(scratch(), "work"), records: path.join(scratch(), "records") };
}

const cellsOf = (records: string): CellRecord[] => {
	const runDir = path.join(records, fs.readdirSync(records)[0]!);
	return fs.readdirSync(path.join(runDir, "cells")).map((f) => JSON.parse(fs.readFileSync(path.join(runDir, "cells", f), "utf8")) as CellRecord);
};

test("a run moves through every state in order and records what repeating it needs", async () => {
	const { dir, work, records } = await setup();
	const { record } = await conductRun(dir, { suite: "all-orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records, parallel: 2 });
	assert.deepEqual(record.states.map((s) => s.state), [...STATES]);
	for (let i = 1; i < record.states.length; i++) assert.ok(record.states[i]!.at >= record.states[i - 1]!.at);
	assert.deepEqual(record.scenarios, ["graft", "prune"], "the suite's scenario list is not in the run record");
	assert.equal(record.suite, "all-orchard");
	const v = record.variants["almanac-full"];
	assert.ok(v && "revision" in v && /^[0-9a-f]{40}$/.test(v.revision), "the variant's revision is not in the run record");
	assert.ok(record.method.version);
	assert.equal(record.status, "exploration");
	// 2 scenarios x 2 arms x 2 members x 1 run
	assert.equal(record.cells.length, 8);
	assert.ok(record.probes.every((p) => p.pass), JSON.stringify(record.probes.map((p) => p.reasons)));
});

test("code scores are taken from the measure hook, each before the run leaves measuring", async () => {
	const { dir, work, records } = await setup();
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	const measured = record.states.find((s) => s.state === "measured")!.at;
	const graft = cellsOf(records).filter((c) => c.scenario === "graft");
	assert.equal(graft.length, 4);
	for (const c of graft) {
		assert.deepEqual(c.codeScores.map((s) => [s.property, "value" in s ? s.value : s.incomplete]), [["graft-2", 1]]);
		for (const s of c.codeScores) assert.ok(s.measuredAt <= measured);
		assert.match(c.diff ?? "", /NOTE\.txt/);
	}
	for (const c of cellsOf(records).filter((c) => c.scenario === "prune")) assert.deepEqual(c.codeScores, []);
});

test("a measure hook that fails leaves its property incomplete, and nothing else", async () => {
	const { dir, work, records } = await setup((d) => fs.writeFileSync(path.join(d, "hooks", "count.mjs"), "process.exit(4);\n"));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	for (const c of cellsOf(records).filter((c) => c.scenario === "graft")) {
		assert.equal(c.valid, true);
		assert.ok(c.codeScores.every((s) => "incomplete" in s));
	}
});

test("an arm whose variant could not be built is not run", async () => {
	const { dir, work, records } = await setup((d) => fs.writeFileSync(path.join(d, "hooks", "trim.mjs"), "process.exit(3);\n"));
	const oc = scripted("opencode"), cx = scripted("codex");
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: oc, codex: cx }, work, records });
	assert.equal(record.arms["almanac"]?.composed, false);
	assert.ok(record.cells.every((c) => !c.includes(".almanac.")));
	assert.ok([...oc.calls, ...cx.calls].every((i) => i.arm.arm !== "almanac"));
	assert.ok("failed" in record.variants["almanac-full"]!);
});

test("an arm that fails its isolation probe for a member is not run for that member", async () => {
	const { dir, work, records } = await setup();
	const leaky = scripted("codex", () => outcome("fine"));
	const invoke = leaky.invoke.bind(leaky);
	leaky.invoke = async (inv) => (inv.tools === "off" && inv.prompt.includes("heron count") ? outcome("It counts eleven.") : invoke(inv));
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: leaky }, work, records });
	assert.ok(record.probes.some((p) => p.arm === "bare" && p.member === "p2" && !p.pass));
	assert.ok(record.cells.every((c) => !c.endsWith(".bare.p2.1")));
	assert.ok(record.cells.some((c) => c.endsWith(".bare.p1.1")));
});

test("an isolation breach is re-run once with its attempts kept; agent behaviour is not re-run", async () => {
	const { dir, work, records } = await setup((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["bare"]; }));
	const breach = scripted("opencode", (_inv, n) => n === 1
		? outcome("done", { tools: [{ name: "bash", input: "curl https://example.invalid/almanac", status: "completed", paths: [], addresses: ["https://example.invalid/almanac"] }] })
		: outcome("", {}));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: breach }, work, records });
	const cells = cellsOf(records).sort((a, b) => a.scenario.localeCompare(b.scenario));
	const first = cells.find((c) => c.attempts.length === 2)!;
	assert.ok(first, "no cell was re-run");
	assert.deepEqual(first.attempts.map((a) => a.validity.valid ? "valid" : a.validity.cause), ["isolation", "behaviour"]);
	assert.equal(first.valid, false);
	const other = cells.find((c) => c !== first)!;
	assert.deepEqual(other.attempts.map((a) => a.validity.valid ? "valid" : a.validity.cause), ["behaviour"], "agent behaviour was re-run");
});

test("an opencode open-step timeout is infrastructure on its first attempt and behaviour on its re-run (0012)", async () => {
	const { dir, work, records } = await setup((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["bare"]; j.scenarios = ["scenarios/prune.json"]; }));
	const stuck = scripted("opencode", () => outcome("", { exit: null, signal: "SIGKILL", stop: { reason: "timeout", inFlight: "unknown" } }));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: stuck }, work, records });
	const [c] = cellsOf(records);
	assert.deepEqual(c!.attempts.map((a) => a.validity.valid ? "valid" : a.validity.cause), ["infrastructure", "behaviour"]);
});

test("the register is append-only, and a recorded run rests on the record made before it", async () => {
	const { dir, work, records } = await setup();
	const r1 = await checkPack(dir);
	if (!r1.ok) throw new Error("pack");
	recordExperiment(r1.loaded, "orchard", new Date(Date.now() - 2000));
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	assert.equal(record.status, "result");
	assert.ok(record.register !== null && record.register.recordedAt < record.states[0]!.at);
	recordExperiment(r1.loaded, "orchard");
	const history = recordHistory(r1.loaded, "orchard");
	assert.equal(history.length, 2, "recording again replaced the earlier record");
	assert.throws(() => recordExperiment(r1.loaded, "orchard", new Date(Date.now() - 60000)), /not earlier/);
});

test("the self-explanation marker is cut from the final message kept for judging", async () => {
	const { dir, work, records } = await setup((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["bare"]; }));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode", () => outcome("Prune crossing branches.\nWHY: the almanac said so")) }, work, records });
	for (const c of cellsOf(records)) assert.equal(c.final, "Prune crossing branches.");
});

test("the method version the run record carries equals the package manifest's", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
	assert.deepEqual(METHOD, { package: pkg.name, version: pkg.version });
});
