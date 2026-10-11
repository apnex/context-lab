// Stage 4: a run conducted end to end through measured, against a scripted adapter. Criteria: E3's
// run-record clause (the suite's scenario list is recorded), E13's (each variant's revision), E14
// (every code score is taken before the run leaves measuring), the rest of E12 (an unbuilt arm is
// not run; a failed measure hook leaves its properties incomplete; the synthetic pack's transform
// and measure hooks run on their success paths), decision 0012 (attempt counts reach the
// classifier), and B13 (the register is append-only, and a run rests on a record made before it).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

/** A judge's reply: every outcome, every listed property scored 1, guessing the first condition offered. */
export function judgeReply(prompt: string, value = 1): string {
	const guess = /one of: ([^,.\n]+)/.exec(prompt)?.[1] ?? "";
	const outcomes = [...prompt.matchAll(/^=== OUTCOME (o\d+) - properties ([^=]+) ===$/gm)].map((m) => ({
		id: m[1], scores: Object.fromEntries(m[2]!.split(",").map((x) => [x.trim(), { v: value, reason: "r" }])), guess,
	}));
	return JSON.stringify({ outcomes });
}

function scripted(runtime: string, answer: Answer = () => outcome("The rootstock is quince and the scion is pear.")): Adapter & { calls: Invocation[] } {
	const calls: Invocation[] = [];
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", refuse: () => null, calls,
		async invoke(inv) {
			calls.push(inv);
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && inv.prompt.includes("=== OUTCOME o1")) return outcome(judgeReply(inv.prompt));
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
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
	assert.ok(v && "revision" in v && v.revision === head, "the variant's revision is not the source's in the run record");
	assert.equal(record.end, "completed");
	assert.equal(record.timeLimitSeconds, 1200);
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
	const executed = record.states.find((s) => s.state === "executed")!.at;
	const graft = cellsOf(records).filter((c) => c.scenario === "graft");
	assert.equal(graft.length, 4);
	for (const c of graft) {
		assert.deepEqual(c.codeScores.map((s) => [s.property, "value" in s ? s.value : s.incomplete]), [["graft-2", 1]]);
		for (const s of c.codeScores) {
			assert.ok(!Number.isNaN(Date.parse(s.measuredAt)) && s.measuredAt.length === 24, `${s.measuredAt} is not a time`);
			assert.ok(s.measuredAt >= executed && s.measuredAt <= measured, "a code score was not taken while measuring");
		}
		assert.match(c.diff ?? "", /NOTE\.txt/);
	}
	for (const c of cellsOf(records).filter((c) => c.scenario === "prune")) assert.deepEqual(c.codeScores, []);
});

test("a measure hook that fails leaves its property incomplete, and nothing else", async () => {
	const { dir, work, records } = await setup((d) => fs.writeFileSync(path.join(d, "hooks", "count.mjs"), "process.exit(4);\n"));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	for (const c of cellsOf(records).filter((c) => c.scenario === "graft")) {
		assert.equal(c.valid, true);
		assert.equal(c.codeScores.length, 1, "a property was dropped rather than left incomplete");
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

test("a suite that selects some scenarios records exactly those", async () => {
	const { dir, work, records } = await setup();
	const { record } = await conductRun(dir, { suite: "pruning", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	assert.deepEqual(record.scenarios, ["prune"]);
	assert.ok(record.cells.every((c) => c.startsWith("prune.")));
});

test("the synthetic pack's transform hook runs on its success path", async () => {
	const { dir, work, records } = await setup((d) => fs.appendFileSync(path.join(d, "source", "GUIDE.md"), "\n\n\n"));
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	const guide = fs.readFileSync(path.join(work, record.run, "variants", "almanac-full", "GUIDE.md"), "utf8");
	assert.ok(guide.endsWith(".\n") && !guide.endsWith("\n\n"), "the transform did not trim the guide");
});

test("a run refuses a record made after it began, before any cell runs", async () => {
	const { dir, work, records } = await setup();
	const r = await checkPack(dir);
	if (!r.ok) throw new Error("pack");
	recordExperiment(r.loaded, "orchard", new Date(Date.now() + 3600000));
	const oc = scripted("opencode");
	await assert.rejects(conductRun(dir, { experiment: "orchard", adapters: { opencode: oc, codex: scripted("codex") }, work, records }), /not earlier than the run/);
	assert.equal(oc.calls.length, 0);
});

test("overriding the runs per cell makes a recorded experiment's run exploration", async () => {
	const { dir, work, records } = await setup();
	const r = await checkPack(dir);
	if (!r.ok) throw new Error("pack");
	recordExperiment(r.loaded, "orchard", new Date(Date.now() - 2000));
	const { record } = await conductRun(dir, { experiment: "orchard", runsPerCell: 2, adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	assert.equal(record.status, "exploration");
	assert.match(record.statusReason, /overridden/);
});

const narrow = (d: string): void => {
	editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["bare"]; j.scenarios = ["scenarios/graft.json"]; });
	editJson(path.join(d, "pack.json"), (j) => { j.suites = j.suites.filter((x: { id: string }) => x.id !== "pruning"); });
};

test("a scored file that is a link to elsewhere is not read", async () => {
	const secret = path.join(scratch(), "secret.txt");
	fs.writeFileSync(secret, "not for the record\n");
	const { dir, work, records } = await setup((d) => { narrow(d); editJson(path.join(d, "scenarios", "graft.json"), (j) => { j.scoredFile = "NOTE.txt"; }); });
	const linker = scripted("opencode", (inv) => { fs.rmSync(path.join(inv.workspace, "NOTE.txt")); fs.symlinkSync(secret, path.join(inv.workspace, "NOTE.txt")); return outcome("done"); });
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: linker }, work, records });
	const [c] = cellsOf(records);
	assert.equal(c!.scoredFile?.content, null);
	assert.equal(JSON.stringify(c).includes("not for the record"), false);
});

test("a cell the core cannot complete is recorded, and the run goes on and is saved", async () => {
	const { dir, work, records } = await setup((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["bare"]; }));
	const flaky = scripted("opencode", (inv) => { if (inv.prompt.includes("Graft")) throw new Error("adapter broke"); return outcome("fine"); });
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: flaky }, work, records });
	assert.equal(record.end, "completed");
	const graft = cellsOf(records).find((c) => c.scenario === "graft")!;
	assert.deepEqual(graft.attempts.map((a) => a.validity.valid ? "valid" : a.validity.cause), ["infrastructure", "infrastructure"]);
	assert.match(graft.attempts[0]!.failure ?? "", /adapter broke/);
	assert.equal(cellsOf(records).find((c) => c.scenario === "prune")!.valid, true);
});

test("each attempt keeps its own diff", async () => {
	const { dir, work, records } = await setup(narrow);
	const twice = scripted("opencode", (inv, n) => {
		fs.writeFileSync(path.join(inv.workspace, `attempt-${n}.txt`), "x\n");
		return n === 1 ? outcome("x", { tools: [{ name: "read", input: {}, status: "completed", paths: [path.join(dir, "scenarios", "graft.json")], addresses: [] }] }) : outcome("fine");
	});
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: twice }, work, records });
	const [c] = cellsOf(records);
	assert.equal(c!.attempts.length, 2);
	assert.match(c!.attempts[0]!.diff ?? "", /attempt-1\.txt/);
	assert.match(c!.attempts[1]!.diff ?? "", /attempt-2\.txt/);
	assert.doesNotMatch(c!.attempts[1]!.diff ?? "", /attempt-1\.txt/);
});

test("an isolation breach then an open-step timeout is a first such timeout: infrastructure (0012)", async () => {
	const { dir, work, records } = await setup(narrow);
	const a = scripted("opencode", (_inv, n) => n === 1
		? outcome("x", { tools: [{ name: "read", input: {}, status: "completed", paths: [path.join(dir, "pack.json")], addresses: [] }] })
		: outcome("", { exit: null, signal: "SIGKILL", stop: { reason: "timeout", inFlight: "unknown" } }));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	const [c] = cellsOf(records);
	assert.deepEqual(c!.attempts.map((x) => x.validity.valid ? "valid" : x.validity.cause), ["isolation", "infrastructure"]);
});

test("touching another run's records or another workspace is isolation; the cell's own workspace is not", async () => {
	const { dir, work, records } = await setup(narrow);
	const other = path.join(work, "earlier-run", "workspaces", "w-xyz", "NOTES.txt");
	const prior = path.join(records, "earlier-run", "run.json");
	const seq = [prior, other];
	const a = scripted("opencode", (inv, n) => outcome("x", { tools: [
		{ name: "read", input: {}, status: "completed", paths: [path.join(inv.workspace, "NOTES.txt")], addresses: [] },
		...(n <= 2 ? [{ name: "read", input: {}, status: "completed" as const, paths: [seq[n - 1]!], addresses: [] }] : []),
	] }));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	const [c] = cellsOf(records);
	assert.deepEqual(c!.attempts.map((x) => x.validity.valid ? "valid" : x.validity.cause), ["isolation", "isolation"]);
	const own = scripted("opencode", (inv) => outcome("x", { tools: [{ name: "read", input: {}, status: "completed", paths: [path.join(inv.workspace, "NOTES.txt")], addresses: [] }] }));
	const s2 = await setup(narrow);
	await conductRun(s2.dir, { experiment: "orchard", adapters: { opencode: own }, work: s2.work, records: s2.records });
	assert.equal(cellsOf(s2.records)[0]!.valid, true);
});

test("a file the agent's .gitignore hides still reaches the diff", async () => {
	const { dir, work, records } = await setup(narrow);
	const a = scripted("opencode", (inv) => { fs.writeFileSync(path.join(inv.workspace, ".gitignore"), "hidden.txt\n"); fs.writeFileSync(path.join(inv.workspace, "hidden.txt"), "x\n"); return outcome("fine"); });
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	assert.match(cellsOf(records)[0]!.diff ?? "", /^\+\+\+ b\/hidden\.txt$/m);
});

test("a file the operator's own git excludes would hide still reaches the diff", async () => {
	const { dir, work, records } = await setup(narrow);
	const home = scratch();
	fs.writeFileSync(path.join(home, "excludes"), "run.log\n");
	fs.writeFileSync(path.join(home, ".gitconfig"), `[core]\n\texcludesFile = ${path.join(home, "excludes")}\n`);
	const a = scripted("opencode", (inv) => { fs.writeFileSync(path.join(inv.workspace, "run.log"), "x\n"); return outcome("fine"); });
	const saved = process.env["HOME"];
	process.env["HOME"] = home;
	try {
		await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	} finally {
		process.env["HOME"] = saved;
	}
	assert.match(cellsOf(records)[0]!.diff ?? "", /^\+\+\+ b\/run\.log$/m);
});

test("the measure hook gets the final message uncut", async () => {
	const { dir, work, records } = await setup((d) => { narrow(d); fs.writeFileSync(path.join(d, "hooks", "count.mjs"), 'import fs from "node:fs"; const i = JSON.parse(fs.readFileSync(0, "utf8")); console.log(JSON.stringify({ scores: { "graft-2": i.outcome.final.includes("WHY:") ? 1 : 0 } }));\n'); });
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode", () => outcome("Done.\nWHY: the almanac")) }, work, records });
	const [c] = cellsOf(records);
	assert.deepEqual(c!.codeScores.map((x) => "value" in x ? x.value : null), [1]);
	assert.equal(c!.final, "Done.");
});

test("answers under headings in the scored file are split per property, self-explanation cut", async () => {
	const { dir, work, records } = await setup((d) => {
		narrow(d);
		editJson(path.join(d, "scenarios", "graft.json"), (j) => {
			j.scoredFile = "answers.md";
			j.properties = [
				{ id: "g1", type: "comprehension", decidedBy: "judge", key: "k1", scale: [0, 2], answerHeading: "orchard.G1" },
				{ id: "g2", type: "comprehension", decidedBy: "judge", key: "k2", scale: [0, 2], answerHeading: "orchard.G2" },
			];
		});
	});
	const a = scripted("opencode", (inv) => { fs.writeFileSync(path.join(inv.workspace, "answers.md"), "### orchard.G1\nQuince.\nWHY: almanac\n### OBSERVATIONS\nnone\n"); return outcome("DONE"); });
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	assert.deepEqual(cellsOf(records)[0]!.answers, { g1: "Quince.", g2: null });
});

test("reading the arm's own variant, as a rewritten link leads an agent to, is not isolation", async () => {
	const { dir, work, records } = await setup((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["almanac"]; j.scenarios = ["scenarios/prune.json"]; }));
	const a = scripted("opencode", (inv) => outcome("Prune crossing branches.", { tools: [{ name: "read", input: {}, status: "error", paths: [inv.arm.instructions[0]!.path], addresses: [] }] }));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	assert.equal(cellsOf(records)[0]!.valid, true);
});

test("a sandboxed runtime naming a forbidden path is recorded, not invalid; a forbidden address still is", async () => {
	const { dir, work, records } = await setup(narrow);
	const a = scripted("opencode", (_inv, n) => outcome("done", { tools: [
		{ name: "bash", input: {}, status: "error", paths: [path.join(dir, "scenarios", "graft.json")], addresses: n === 1 ? ["https://example.invalid/almanac"] : [] },
	] }));
	a.filesystem = "sandboxed";
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	const [c] = cellsOf(records);
	assert.deepEqual(c!.attempts.map((x) => x.validity.valid ? "valid" : x.validity.cause), ["isolation", "valid"]);
	assert.deepEqual(c!.attempts[1]!.unreachable, [path.join(dir, "scenarios", "graft.json")]);
});
