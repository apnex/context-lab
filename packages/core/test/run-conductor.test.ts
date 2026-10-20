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
	CANARY_QUESTION, METHOD, STATES, checkPack, conductRun, recordExperiment, recordHistory, resumeRun, tallyRun, variantDir, variantManifestFile,
	type Adapter, type CellRecord, type Invocation, type Outcome,
} from "../src/index.js";
import { commitAll, copyPack, editJson, isJudgePrompt, judgeReply, packageRoot, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

type Answer = (inv: Invocation, n: number) => Outcome;



function scripted(runtime: string, answer: Answer = () => outcome("The rootstock is quince and the scion is pear.")): Adapter & { calls: Invocation[] } {
	const calls: Invocation[] = [];
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false, compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null, calls,
		async invoke(inv) {
			calls.push(inv);
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && isJudgePrompt(inv.prompt)) return outcome(judgeReply(inv.prompt));
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

test("no path or prompt given to an agent, probe or judge names the run, the experiment, an arm or a variant (B21)", async () => {
	const { dir, work, records } = await setup((d) => {
		editJson(path.join(d, "pack.json"), (j) => {
			j.arms.push({ id: "shelf", deliver: [{ variant: "almanac-full", file: ".", as: "on-request" }] });
			for (const l of j.isolation.leakProbes ?? []) if (!l.arms.includes("shelf")) l.arms.push("shelf");
			j.suites = j.suites.filter((x: { id: string; experiment: string }) => x.experiment === "orchard" && x.id !== "pruning");
		});
		editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.scenarios = ["scenarios/graft.json"]; j.factors.arms = ["bare", "almanac", "shelf"]; });
		editJson(path.join(d, "scenarios", "graft.json"), (j) => {
			j.answerSource = "final";
			delete j.scoredFile;
			j.task = "Read {ON_REQUEST} if you were given it, then answer Q1.";
			j.properties = [{ id: "Q1", type: "comprehension", decidedBy: "judge", key: "quince", scale: [0, 2], answerHeading: "Q1", question: "Rootstock?" }];
		});
	});
	const answer = () => outcome("### Q1\nThe rootstock is quince.\n");
	const oc = scripted("opencode", answer), cx = scripted("codex", answer);
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: oc, codex: cx }, work, records });
	assert.equal(path.basename(record.work!).startsWith("run-"), true);
	const calls = [...oc.calls, ...cx.calls];
	assert.ok(calls.some((c) => c.arm.onRequest.length > 0), "no call was given an on-request folder");
	assert.ok(calls.some((c) => c.tools === "off" && isJudgePrompt(c.prompt)), "no judge was asked");
	const labels = [record.run, "orchard", "almanac", "bare", "shelf"];
	for (const c of calls) {
		const seen = [c.workspace, c.work, c.prompt, ...c.arm.instructions.map((i) => i.path), ...c.arm.folderFiles.map((f) => f.path), ...c.arm.onRequest.map((o) => o.path)];
		for (const text of seen) for (const label of labels) assert.equal(text.includes(label), false, `${label} reached an agent in: ${text.slice(0, 200)}`);
	}
	// The variant's manifest is beside the folder an agent is given, not in it.
	const shelf = calls.find((c) => c.arm.onRequest.length > 0)!.arm.onRequest[0]!.path;
	assert.equal(fs.existsSync(path.join(shelf, "context-lab-variant.json")), false);
	assert.equal(JSON.parse(fs.readFileSync(variantManifestFile(shelf), "utf8")).variant, "almanac-full");
});

test("the synthetic pack's transform hook runs on its success path", async () => {
	const { dir, work, records } = await setup((d) => fs.appendFileSync(path.join(d, "source", "GUIDE.md"), "\n\n\n"));
	const { record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	const guide = fs.readFileSync(path.join(variantDir(record.work!, "almanac-full"), "GUIDE.md"), "utf8");
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
		{ name: "bash", input: {}, status: "error", paths: [path.join(dir, "scenarios", n === 1 ? "prune.json" : "graft.json")], addresses: n === 1 ? ["https://example.invalid/almanac"] : [] },
	] }));
	a.filesystem = "sandboxed";
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	const [c] = cellsOf(records);
	assert.deepEqual(c!.attempts.map((x) => x.validity.valid ? "valid" : x.validity.cause), ["isolation", "valid"]);
	// Each attempt records the paths it named, and no earlier attempt's.
	assert.deepEqual(c!.attempts[0]!.unreachable, [path.join(dir, "scenarios", "prune.json")]);
	assert.deepEqual(c!.attempts[1]!.unreachable, [path.join(dir, "scenarios", "graft.json")]);
});

test("a scored file reached through a linked folder is not read", async () => {
	const host = scratch();
	fs.writeFileSync(path.join(host, "NOTE.txt"), "not for the record\n");
	const { dir, work, records } = await setup((d) => { narrow(d); editJson(path.join(d, "scenarios", "graft.json"), (j) => { j.scoredFile = "out/NOTE.txt"; }); });
	const linker = scripted("opencode", (inv) => { fs.symlinkSync(host, path.join(inv.workspace, "out")); return outcome("done"); });
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: linker }, work, records });
	assert.equal(JSON.stringify(cellsOf(records)[0]).includes("not for the record"), false);
});

test("a file of the arm's variant it was not given is still forbidden", async () => {
	const { dir, work, records } = await setup((d) => { editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1"]; j.factors.arms = ["almanac"]; j.scenarios = ["scenarios/prune.json"]; }); fs.writeFileSync(path.join(d, "source", "SECRET.md"), "s\n"); });
	const a = scripted("opencode", (inv) => outcome("x", { tools: [{ name: "read", input: {}, status: "completed", paths: [path.join(path.dirname(inv.arm.instructions[0]!.path), "SECRET.md")], addresses: [] }] }));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: a }, work, records });
	assert.equal(cellsOf(records)[0]!.attempts[0]!.validity.valid ? "valid" : (cellsOf(records)[0]!.attempts[0]!.validity as { cause: string }).cause, "isolation");
});

test("resumeRun completes a run stopped during execution, skips recorded cells, and refuses completed, post-probed, or altered runs", async () => {
	const { dir, work, records } = await setup();
	const loaded0 = await checkPack(dir);
	if (!loaded0.ok) throw new Error("pack invalid");
	recordExperiment(loaded0.loaded, "orchard");
	const full = await conductRun(dir, { suite: "all-orchard", adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "oc" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work, records, parallel: 1 });
	assert.equal(full.record.cells.length, 8);

	// 1. Refuse already completed run.
	await assert.rejects(() => resumeRun(dir, full.dir, { adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work }), /already completed/);

	// Build a stopped-mid-execution copy with only 3 of the 8 cells present, and an in-flight ledger left behind.
	const partialRoot = path.join(scratch(), "partial-records");
	const partialDir = path.join(partialRoot, full.record.run);
	fs.cpSync(full.dir, partialDir, { recursive: true });
	fs.rmSync(path.join(partialDir, "sealed"), { recursive: true, force: true });
	fs.rmSync(path.join(partialDir, "judging"), { recursive: true, force: true });
	fs.rmSync(path.join(partialDir, "RESULT.json"), { force: true });
	fs.rmSync(path.join(partialDir, "RESULT.md"), { force: true });
	const kept = full.record.cells.slice(0, 3);
	for (const c of full.record.cells.slice(3)) fs.rmSync(path.join(partialDir, "cells", `${c}.json`));
	// Leave a stale in-flight ledger for both attempts of the 4th cell (with a lock file from an interrupted git write) to verify Ledger re-initialises cleanly.
	for (const att of [1, 2]) {
		const inflightLedger = path.join(full.record.work!, "ledgers", `${full.record.cells[3]}.${att}`);
		fs.mkdirSync(inflightLedger, { recursive: true });
		fs.writeFileSync(path.join(inflightLedger, "config.lock"), "stale\n");
	}

	// 2. Refuse if state is past executed with missing cells, or before probed.
	const savedStates = JSON.parse(fs.readFileSync(path.join(partialDir, "run.json"), "utf8")).states;
	editJson(path.join(partialDir, "run.json"), (j) => {
		j.end = "failed";
		j.endReason = "stopped by host shutdown";
		j.cells = kept;
		j.states = savedStates.slice(0, 5); // includes "executed", but 5 of 8 cells are missing
	});
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "oc" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work }), /is past executed, but 5 expected cell\(s\) are missing/);
	editJson(path.join(partialDir, "run.json"), (j) => { j.states = savedStates.slice(0, 2); }); // only recorded
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work }), /only a run stopped after probed/);

	// Set state to probed (index 0..3).
	editJson(path.join(partialDir, "run.json"), (j) => { j.states = savedStates.slice(0, 4); });

	// 3. Refuse if routes changed.
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "changed" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work }), /routes to the models have changed/);

	// 4. Refuse if a recorded cell file is missing or malformed.
	const savedCell = fs.readFileSync(path.join(partialDir, "cells", `${kept[0]}.json`));
	fs.rmSync(path.join(partialDir, "cells", `${kept[0]}.json`));
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "oc" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work }), /missing its file/);
	fs.writeFileSync(path.join(partialDir, "cells", `${kept[0]}.json`), JSON.stringify({ cell: kept[0], attempts: [] }));
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "oc" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work }), /is malformed/);
	fs.writeFileSync(path.join(partialDir, "cells", `${kept[0]}.json`), savedCell);

	// 4b. Refuse if the built variant manifest on disk does not match run.json.
	const mfPath = variantManifestFile(variantDir(full.record.work!, "almanac-full"));
	fs.chmodSync(mfPath, 0o644);
	const savedMf = fs.readFileSync(mfPath);
	editJson(mfPath, (j) => { j.revision = "tampered"; });
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "oc" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work }), /does not match run\.json/);
	fs.writeFileSync(mfPath, savedMf);

	// 5. Refuse if experiment hash changed since the run was recorded.
	const expFile = path.join(dir, "experiments", "orchard.json");
	const savedExp = fs.readFileSync(expFile);
	editJson(expFile, (j) => { j.notes = "tampered"; });
	await assert.rejects(() => resumeRun(dir, partialDir, { adapters: { opencode: { ...scripted("opencode"), route: () => ({ r: "oc" }) }, codex: { ...scripted("codex"), route: () => ({ r: "cx" }) } }, work }), /has changed since run/);
	fs.writeFileSync(expFile, savedExp);

	// 6. Resume runs only the 5 remaining cells, measures all 8, blinds, judges and tallies.
	const oc = { ...scripted("opencode"), route: () => ({ r: "oc" }) };
	const cx = { ...scripted("codex"), route: () => ({ r: "cx" }) };
	const resumed = await resumeRun(dir, partialDir, { adapters: { opencode: oc, codex: cx }, work, parallel: 2 });
	assert.equal(resumed.record.end, "completed");
	assert.equal(resumed.record.endReason, undefined);
	assert.equal(resumed.record.resumedAt?.length, 1);
	assert.deepEqual(resumed.record.states.map((s) => s.state), [...STATES]);
	assert.equal(resumed.record.cells.length, 8);
	const workCalls = oc.calls.filter((c) => c.tools === "on").length + cx.calls.filter((c) => c.tools === "on").length;
	assert.equal(workCalls, 5, "only the 5 remaining cells should be executed");
	const resJson = JSON.parse(fs.readFileSync(path.join(partialDir, "RESULT.json"), "utf8"));
	const fullJson = JSON.parse(fs.readFileSync(path.join(full.dir, "RESULT.json"), "utf8"));
	assert.deepEqual(resJson.cellValues, fullJson.cellValues);
	assert.deepEqual(resJson.totals, fullJson.totals);
});

test("a run stopped before work folders were opaque resumes from its old layout (B21), and resumed cells keep extraction provenance (B23)", async () => {
	const { dir, work, records } = await setup((d) => editJson(path.join(d, "scenarios", "graft.json"), (j) => {
		j.answerSource = "final";
		delete j.scoredFile;
		j.properties.push({ id: "Q1", type: "comprehension", decidedBy: "judge", key: "quince", scale: [0, 2], answerHeading: "Q1", question: "Rootstock?" });
	}));
	const loaded0 = await checkPack(dir);
	if (!loaded0.ok) throw new Error("pack");
	recordExperiment(loaded0.loaded, "orchard");
	const routed = (rt: string) => ({ ...scripted(rt), route: () => ({ r: rt }) });
	const full = await conductRun(dir, { experiment: "orchard", adapters: { opencode: routed("opencode"), codex: routed("codex") }, work, records, parallel: 1 });
	assert.equal(full.record.cells.length, 8);
	// The record as an older core wrote it: no work folder recorded, three cells done, stopped after probed.
	const partialDir = path.join(scratch(), "old-records", full.record.run);
	fs.cpSync(full.dir, partialDir, { recursive: true });
	for (const f of ["sealed", "judging", "RESULT.json", "RESULT.md"]) fs.rmSync(path.join(partialDir, f), { recursive: true, force: true });
	const kept = full.record.cells.slice(0, 3);
	for (const c of full.record.cells.slice(3)) fs.rmSync(path.join(partialDir, "cells", `${c}.json`));
	editJson(path.join(partialDir, "run.json"), (j) => { j.cells = kept; j.end = "failed"; j.states = j.states.slice(0, 4); delete j.work; });
	// And the work folder as it laid it out: named by the run id, the variant by its id with its manifest inside.
	const legacyWork = path.join(work, full.record.run);
	fs.renameSync(full.record.work!, legacyWork);
	const opaque = variantDir(legacyWork, "almanac-full"), legacyVariant = path.join(legacyWork, "variants", "almanac-full");
	fs.renameSync(opaque, legacyVariant);
	fs.chmodSync(legacyVariant, 0o755);
	fs.renameSync(variantManifestFile(opaque), path.join(legacyVariant, "context-lab-variant.json"));
	const oc = routed("opencode"), cx = routed("codex");
	const resumed = await resumeRun(dir, partialDir, { adapters: { opencode: oc, codex: cx }, work, parallel: 2 });
	assert.equal(resumed.record.end, "completed");
	assert.equal(oc.calls.filter((c) => c.tools === "on").length + cx.calls.filter((c) => c.tools === "on").length, 5);
	// Every graft cell the resume ran records how its answer was extracted: the scripted reply has no heading.
	const resumedGraft = resumed.record.cells.filter((c) => !kept.includes(c) && c.startsWith("graft."));
	assert.ok(resumedGraft.length > 0, "the resume ran no graft cell");
	for (const c of resumedGraft) {
		const cr = JSON.parse(fs.readFileSync(path.join(partialDir, "cells", `${c}.json`), "utf8")) as CellRecord;
		assert.deepEqual(cr.extraction?.["Q1"]?.findings, ["no-heading"], c);
	}
	// The remaining cells ran with the old variant folder.
	assert.ok([...oc.calls, ...cx.calls].filter((c) => c.tools === "on").every((c) => c.arm.instructions.every((i) => i.variant !== "almanac-full" || i.path.startsWith(legacyVariant))));
});

test("an outcome-measure hook receives outcome.snapshot and can read the phase's workspace snapshot directly", async () => {
	const { dir, work, records } = await setup((d) => {
		fs.writeFileSync(
			path.join(d, "hooks", "count.mjs"),
			'import fs from "node:fs"; import path from "node:path";\n' +
			'const inp = JSON.parse(fs.readFileSync(0, "utf8"));\n' +
			'const snap = inp.outcome?.snapshot;\n' +
			'const ok = typeof snap === "string" && fs.existsSync(path.join(snap, "NOTE.txt")) && fs.readFileSync(path.join(snap, "NOTE.txt"), "utf8").trim() === "grafted";\n' +
			'console.log(JSON.stringify({ scores: Object.fromEntries(inp.properties.map((p) => [p, ok ? 1 : 0])) }));\n',
		);
	});
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode"), codex: scripted("codex") }, work, records });
	for (const c of cellsOf(records).filter((c) => c.scenario === "graft")) {
		assert.deepEqual(c.codeScores.map((s) => [s.property, "value" in s ? s.value : s.incomplete]), [["graft-2", 1]]);
	}
});

test("maxAttemptsPerCell: 1 disables automatic cell retries on infrastructure failure, and answerSource: 'final' splits answers from the final message without scoredFile", async () => {
	const { dir, work, records } = await setup((d) => {
		editJson(path.join(d, "pack.json"), (j) => {
			j.suites = [j.suites[0]];
		});
		editJson(path.join(d, "experiments", "orchard.json"), (j) => {
			j.maxAttemptsPerCell = 1;
			j.scenarios = ["scenarios/graft.json"];
			j.factors.arms = ["bare"];
		});
		editJson(path.join(d, "scenarios", "graft.json"), (j) => {
			j.answerSource = "final";
			delete j.scoredFile;
			j.properties = [
				{ id: "Q1", type: "comprehension", decidedBy: "judge", key: "quince", rubric: "2 if quince", scale: [0, 2], answerHeading: "orchard.Q1", question: "What is the rootstock?" },
			];
		});
	});
	// opencode fails with provider error on attempt 1; codex replies with ### orchard.Q1\nquince in final message.
	const oc = scripted("opencode", () => outcome("", { error: { cause: "provider", name: "APIError", message: "503" } }));
	const cx = scripted("codex", () => outcome("### orchard.Q1\nThe rootstock is quince.\n"));
	await conductRun(dir, { experiment: "orchard", adapters: { opencode: oc, codex: cx }, work, records });
	const cells = cellsOf(records);
	const ocCell = cells.find((c) => c.member === "p1")!;
	const cxCell = cells.find((c) => c.member === "p2")!;
	assert.equal(ocCell.attempts.length, 1, "maxAttemptsPerCell: 1 must stop after 1 attempt without retrying");
	assert.equal(ocCell.valid, false);
	assert.equal(cxCell.valid, true);
	assert.equal(cxCell.scoredFile, null);
	assert.equal(cxCell.answers["Q1"], "The rootstock is quince.");
});

test("maxResponseBytes truncates oversized responses before answer splitting and measurement and records responseBound; runFlags rejects invalid or valueless --max-attempts; resumeRun preserves maxAttemptsPerCell and refuses dispatched/relocated/missing work under maxAttemptsPerCell: 1", async () => {
	const { runFlags } = await import("../src/index.js");
	assert.throws(() => runFlags(["node", "cli.js", "run", "pack", "suite", "--max-attempts", "3"]), /--max-attempts must be 1 or 2/);
	assert.throws(() => runFlags(["node", "cli.js", "run", "pack", "suite", "--max-attempts", "abc"]), /--max-attempts must be 1 or 2/);
	assert.throws(() => runFlags(["node", "cli.js", "run", "pack", "suite", "--max-attempts"]), /--max-attempts requires a value/);
	assert.throws(() => runFlags(["node", "cli.js", "run", "pack", "suite", "--max-attempts", "--parallel", "2"]), /--max-attempts requires a value/);
	assert.deepEqual(runFlags(["node", "cli.js", "run", "pack", "suite", "--max-attempts", "1"]), { maxAttemptsPerCell: 1 });

	// Test maxResponseBytes pre-extraction AND pre-measurement bound:
	// hook checks that inp.outcome.final is bounded (<= 40 bytes) while inp.outcome.rawFinal has the full untruncated string.
	const { dir, work, records } = await setup((d) => {
		fs.writeFileSync(
			path.join(d, "hooks", "count.mjs"),
			'import fs from "node:fs";\n' +
			'const inp = JSON.parse(fs.readFileSync(0, "utf8"));\n' +
			'const boundedOk = Buffer.byteLength(inp.outcome.final, "utf8") <= 40 && typeof inp.outcome.rawFinal === "string" && inp.outcome.rawFinal.length >= inp.outcome.final.length;\n' +
			'console.log(JSON.stringify({ scores: Object.fromEntries(inp.properties.map((p) => [p, boundedOk ? 1 : 0])) }));\n',
		);
		editJson(path.join(d, "pack.json"), (j) => { j.suites = [j.suites[0]]; });
		editJson(path.join(d, "experiments", "orchard.json"), (j) => {
			j.maxAttemptsPerCell = 1;
			j.maxResponseBytes = 40;
			j.scenarios = ["scenarios/graft.json"];
			j.factors.arms = ["bare"];
		});
		editJson(path.join(d, "scenarios", "graft.json"), (j) => {
			j.answerSource = "final";
			delete j.scoredFile;
			j.properties = [
				{ id: "Q1", type: "comprehension", decidedBy: "judge", key: "quince", rubric: "2 if quince", scale: [0, 2], answerHeading: "orchard.Q1", question: "Rootstock?" },
				{ id: "Q2", type: "comprehension", decidedBy: "judge", key: "pear", rubric: "2 if pear", scale: [0, 2], answerHeading: "orchard.Q2", question: "Scion?" },
				{ id: "M1", type: "adherence", decidedBy: "code", measure: "count-words", key: "bounded", scale: [0, 1] },
			];
		});
	});
	const longReply = "### orchard.Q1\nThe rootstock is quince.\n### orchard.Q2\nThe scion is pear.\n";
	const oc = scripted("opencode", () => outcome(longReply));
	const cx = scripted("codex", () => outcome("### orchard.Q1\nq\n### orchard.Q2\np"));
	const { dir: rd, record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: oc, codex: cx }, work, records });
	assert.equal(record.maxAttemptsPerCell, 1);
	assert.deepEqual(record.dispatchedCells, ["graft.bare.p1.1", "graft.bare.p2.1"]);
	assert.equal(record.snapshot.experiment?.full?.maxAttemptsPerCell, 1);
	assert.equal(record.snapshot.experiment?.full?.maxResponseBytes, 40);
	// The arms' deliveries are kept for the tally's hydration profile, for the experiment's arms only.
	assert.deepEqual(record.snapshot.deliveries, { bare: [] });
	const cells = cellsOf(records);
	const ocCell = cells.find((c) => c.member === "p1")!;
	const cxCell = cells.find((c) => c.member === "p2")!;
	assert.equal(ocCell.responseBound?.truncated, true);
	assert.equal(ocCell.responseBound?.limitBytes, 40);
	assert.equal(ocCell.answers["Q1"], "The rootstock is quince.");
	assert.equal(ocCell.answers["Q2"], null, "Q2 beyond maxResponseBytes must be truncated before splitAnswers");
	assert.deepEqual(ocCell.codeScores.map((s) => [s.property, "value" in s ? s.value : -1]), [["M1", 1]], "measure hook must receive bounded final and rawFinal");
	assert.equal(cxCell.responseBound?.truncated, false);
	assert.equal(cxCell.answers["Q2"], "p");
	// Extraction provenance (B23): Q2's heading lay beyond the cut, which no-heading alone would hide.
	assert.deepEqual(ocCell.extraction?.["Q2"]?.findings, ["no-heading", "heading-beyond-bound", "cut-by-bound"]);
	assert.deepEqual([ocCell.extraction?.["Q2"]?.phase, ocCell.extraction?.["Q2"]?.attempt, ocCell.extraction?.["Q2"]?.source, ocCell.extraction?.["Q2"]?.bounded], ["work", 1, "final", true]);
	assert.deepEqual(ocCell.extraction?.["Q1"]?.findings, []);
	assert.deepEqual(cxCell.extraction?.["Q1"]?.endedAt, { heading: "orchard.Q2", requested: true, bytes: 0 });
	const sealed = JSON.parse(fs.readFileSync(path.join(rd, "sealed", "units.json"), "utf8")) as { absent: { cell: string; property: string; findings?: string[] }[] };
	assert.deepEqual(sealed.absent, [{ cell: "graft.bare.p1.1", property: "Q2", findings: ["no-heading", "heading-beyond-bound", "cut-by-bound"] }]);
	assert.match(fs.readFileSync(path.join(rd, "RESULT.md"), "utf8"), /Absent answers, scored at the bottom of their scale: graft\.bare\.p1\.1 Q2 \(no-heading, heading-beyond-bound, cut-by-bound\)\./);
	// A record made before extraction was kept reads as unknown, not as an inferred reason.
	const legacy = path.join(scratch(), "legacy-run");
	fs.cpSync(rd, legacy, { recursive: true });
	editJson(path.join(legacy, "sealed", "units.json"), (j) => { for (const a of j.absent) delete a.findings; });
	tallyRun(legacy);
	assert.match(fs.readFileSync(path.join(legacy, "RESULT.md"), "utf8"), /graft\.bare\.p1\.1 Q2 \(reason not recorded\)/);

	// Test resumeRun refusing when a cell is in dispatchedCells (or has a ledger in work/ledgers/<cell>.1) but its completion cell file was not written.
	editJson(path.join(rd, "run.json"), (j) => {
		j.end = null;
		j.cells = ["graft.bare.p1.1"];
		j.states = j.states.slice(0, 4); // probed
	});
	fs.rmSync(path.join(rd, "cells", "graft.bare.p2.1.json"));
	await assert.rejects(
		() => resumeRun(dir, rd, { adapters: { opencode: oc, codex: cx }, work }),
		/unrecorded partial attempt on disk/,
	);
	// Also test when dispatchedCells does not list p2, but episode.ts created work/ledgers/graft.bare.p2.1.1!
	editJson(path.join(rd, "run.json"), (j) => {
		j.dispatchedCells = ["graft.bare.p1.1"];
	});
	await assert.rejects(
		() => resumeRun(dir, rd, { adapters: { opencode: oc, codex: cx }, work }),
		/unrecorded partial attempt on disk/,
	);
	// Also test when work is relocated to a different path than record.work!
	await assert.rejects(
		() => resumeRun(dir, rd, { adapters: { opencode: oc, codex: cx }, work: path.join(scratch(), "other-work") }),
		/recorded working folder/,
	);
});

