// Stage 5: blinding, judging and the tally. Criteria E15 (no judge of an outcome's own family) and
// E14's stage-5 part (every code score precedes its outcome's blinding).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, blind, checkPack, conductRun, tallyRun,
	type Adapter, type CellRecord, type Invocation, type Outcome, type Vote,
} from "../src/index.js";
import { commitAll, copyPack, editJson, isJudgePrompt, judgeReply, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

interface Agent { runtime: string; sandboxed?: boolean; work?: (inv: Invocation) => Outcome; judge?: (prompt: string, n: number) => string; judgeOutcome?: (prompt: string, n: number) => Outcome }
function agent(a: Agent): Adapter & { judged: string[]; workCalls: Invocation[] } {
	const judged: string[] = [];
	const workCalls: Invocation[] = [];
	return {
		runtime: a.runtime, rulesFiles: ["AGENTS.md"], modes: ["inline", "stdin"], network: "detected", filesystem: a.sandboxed ? "sandboxed" : "open", continue: false, compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null, judged, workCalls,
		async invoke(inv) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && isJudgePrompt(inv.prompt)) { judged.push(inv.prompt); return a.judgeOutcome ? a.judgeOutcome(inv.prompt, judged.length) : outcome(a.judge ? a.judge(inv.prompt, judged.length) : judgeReply(inv.prompt)); }
			if (inv.tools === "off") return outcome("I do not know.");
			workCalls.push(inv);
			fs.writeFileSync(path.join(inv.workspace, "NOTE.txt"), "grafted\n");
			return a.work ? a.work(inv) : outcome(`Rootstock quince, POL-42 applied, see ${inv.workspace}/NOTE.txt.`);
		},
	};
}

async function run(edit?: (d: string) => void, oc: Agent = { runtime: "opencode" }, cx: Agent = { runtime: "codex" }) {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.runsPerCell = 1; });
	edit?.(dir);
	commitAll(dir);
	const records = path.join(scratch(), "records");
	const A = agent(oc), B = agent(cx);
	const { dir: rd, record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: A, codex: B }, work: path.join(scratch(), "work"), records });
	const r = await checkPack(dir);
	if (!r.ok) throw new Error("pack");
	return { rd, record, A, B, loaded: r.loaded, dir };
}
const read = <T>(rd: string, f: string): T => JSON.parse(fs.readFileSync(path.join(rd, f), "utf8")) as T;

test("a run goes on through blinded, judged and tallied, and writes its result", async () => {
	const { rd, record } = await run();
	assert.deepEqual(record.states.slice(-3).map((s) => s.state), ["blinded", "judged", "tallied"]);
	assert.equal(record.end, "completed");
	assert.ok(fs.existsSync(path.join(rd, "RESULT.json")) && fs.existsSync(path.join(rd, "RESULT.md")));
	assert.deepEqual(record.judges.sort(), ["p1", "p2"]);
	assert.ok(record.judgeProbes.every((p) => p.pass));
});

test("no outcome is judged by a judge of its own agent's family", async () => {
	const { rd, A, B } = await run();
	const units = read<{ units: { id: string; family: string; member: string }[] }>(rd, "sealed/units.json").units;
	const votes = read<Vote[]>(rd, "judging/votes.json");
	assert.ok(votes.length > 0);
	for (const v of votes) {
		const u = units.find((x) => x.id === v.unit)!;
		assert.notEqual(v.family, u.family, `${v.judge} judged ${u.member}, of its own family`);
	}
	// Each family's judge saw only the other family's outcomes.
	assert.ok(A.judged.length > 0 && B.judged.length > 0);
});

test("outcomes are masked: identifiers replaced and the workspace path removed", async () => {
	const { rd } = await run();
	const units = read<{ units: { text: string }[] }>(rd, "sealed/units.json").units;
	for (const u of units) {
		assert.equal(/POL-\d+/.test(u.text), false, "an identifier reached a judge");
		assert.equal(u.text.includes("/w-"), false, "a workspace path reached a judge");
	}
	assert.ok(units.some((u) => u.text.includes("[ID] applied")));
});

test("a judge whose replies never validate leaves its votes missing, and the property incomplete, after three tries", async () => {
	const { rd, B } = await run(undefined, { runtime: "opencode" }, { runtime: "codex", judge: () => "not json" });
	const votes = read<Vote[]>(rd, "judging/votes.json");
	assert.ok(votes.filter((v) => v.judge === "p2").every((v) => v.value === null));
	assert.equal(B.judged.length % 3, 0, "a judge was not asked three times");
	const result = read<{ cellValues: Record<string, Record<string, unknown>> }>(rd, "RESULT.json");
	assert.equal(result.cellValues["graft.bare.p1.1"]!["graft-1"], "incomplete", "an outcome only p2 could judge was not incomplete");
	assert.equal(result.cellValues["graft.bare.p2.1"]!["graft-1"], 1, "an outcome p1 judged validly was not scored");
});

test("the tally scores judged and code properties, behaviour as 0, and excludes other invalid cells", async () => {
	const { rd } = await run((d) => editJson(path.join(d, "pack.json"), (j) => { j.population[1].family = "f2"; }), { runtime: "opencode", work: (inv) => inv.prompt.includes("prune") ? outcome("", {}) : outcome("Grafted.") });
	const r = read<{ cellValues: Record<string, Record<string, unknown>>; properties: { property: string; byArm: Record<string, { mean: number | null; of: number }> }[]; excluded: unknown[] }>(rd, "RESULT.json");
	assert.deepEqual(r.cellValues["prune.bare.p1.1"], { "prune-1": 0 }, "a cell that ended with no message did not score 0");
	assert.equal(r.cellValues["graft.bare.p1.1"]!["graft-1"], 1);
	assert.equal(r.cellValues["graft.bare.p1.1"]!["graft-2"], 1);
	const g1 = r.properties.find((p) => p.property === "graft-1")!;
	assert.deepEqual(g1.byArm["bare"], { mean: 1, of: 2, incomplete: 0 });
});

test("re-tallying a run from its record gives the same result", async () => {
	const { rd, dir } = await run();
	const first = fs.readFileSync(path.join(rd, "RESULT.json"), "utf8");
	// The pack changing afterwards must not change the result.
	editJson(path.join(dir, "pack.json"), (j) => { j.population[1].family = j.population[0].family; });
	tallyRun(rd);
	assert.equal(fs.readFileSync(path.join(rd, "RESULT.json"), "utf8"), first);
});

test("the blinder refuses an outcome whose code score was not taken before its blinding", async () => {
	const { rd, record, loaded } = await run();
	const cells = record.cells.map((c) => read<CellRecord>(rd, `cells/${c}.json`));
	const graft = cells.find((c) => c.scenario === "graft")!;
	graft.codeScores = graft.codeScores.map((s) => ({ ...s, measuredAt: "9999-01-01T00:00:00.000Z" }));
	const scenarios = new Map([...loaded.experiments.get("orchard")!.scenarios.values()].map((x) => [x.scenario.id, x.scenario]));
	assert.throws(() => blind(loaded, scenarios, cells, new Map(loaded.pack.population.map((m) => [m.id, m.family])), "seed"), /not taken before/);
	const units = read<{ units: { cell: string; blindedAt: string }[] }>(rd, "sealed/units.json").units;
	for (const u of units) for (const s of cells.find((c) => c.cell === u.cell && c !== graft)?.codeScores ?? []) assert.ok(s.measuredAt < u.blindedAt);
});

test("the guess rate counts each judge's guess once per outcome, against the condition's group", async () => {
	const { rd } = await run((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.judging = { guessGroups: { plain: ["bare"], guided: ["almanac"] } }; }));
	const r = read<{ guesses: { right: number; all: number; byGuess: Record<string, number>; baseRate: number } }>(rd, "RESULT.json");
	// judgeReply always guesses the first condition offered, "plain": right for every bare outcome.
	const units = read<{ units: { arm: string }[] }>(rd, "sealed/units.json").units;
	assert.equal(r.guesses.all, units.length);
	assert.equal(r.guesses.right, units.filter((u) => u.arm === "bare").length);
	assert.deepEqual(r.guesses.byGuess, { plain: units.length });
});

test("judges see no canary, no run folder, and no self-explanation written into a file", async () => {
	const { rd } = await run(undefined, { runtime: "opencode", work: (inv) => {
		fs.writeFileSync(path.join(inv.workspace, "EXPLAIN.md"), "Grafted. WHY: the almanac said so\n- GUIDE.md section 3\n");
		return outcome(`The heron counts eleven stones. See ${inv.arm.instructions[0]?.path ?? "nothing"}.`);
	} });
	const units = read<{ units: { text: string; member: string }[] }>(rd, "sealed/units.json").units.filter((u) => u.member === "p1");
	for (const u of units) {
		assert.equal(u.text.includes("The heron counts eleven stones."), false, "a canary reached a judge");
		const m = /\/variants\/|context-lab-work|cl-test-/.exec(u.text);
		assert.equal(m, null, `a run folder reached a judge: ${m ? u.text.slice(Math.max(0, m.index - 80), m.index + 40) : ""}`);
		assert.equal(u.text.includes("the almanac said so") || u.text.includes("GUIDE.md section 3"), false, "self-explanation in a file reached a judge");
	}
});

test("a reply missing one outcome keeps the others, and asks again only for the missing one", async () => {
	// The judge leaves out the first outcome of every prompt holding more than one.
	const { rd, B } = await run(undefined, { runtime: "opencode" }, { runtime: "codex", judge: (prompt) => {
		const r = JSON.parse(judgeReply(prompt)) as { outcomes: unknown[] };
		return JSON.stringify({ outcomes: r.outcomes.length > 1 ? r.outcomes.slice(1) : r.outcomes });
	} });
	const votes = read<Vote[]>(rd, "judging/votes.json").filter((v) => v.judge === "p2");
	assert.ok(votes.length > 0 && votes.every((v) => v.value !== null), "a valid outcome was discarded with the missing one");
	const multi = B.judged.filter((p) => (p.match(/=== OUTCOME o/g) ?? []).length > 1).length;
	const single = B.judged.filter((p) => (p.match(/=== OUTCOME o/g) ?? []).length === 1).length;
	assert.ok(multi > 0 && single >= multi, "a missing outcome was not asked again on its own");
});

test("one judge failing is recorded and does not stop the others", async () => {
	const { rd, record } = await run(undefined, { runtime: "opencode" }, { runtime: "codex", judgeOutcome: () => { throw new Error("judge broke"); } });
	assert.equal(record.end, "completed");
	const votes = read<Vote[]>(rd, "judging/votes.json");
	assert.ok(votes.filter((v) => v.judge === "p2").every((v) => v.value === null && /judge broke/.test(v.reason)));
	assert.ok(votes.filter((v) => v.judge === "p1").every((v) => v.value !== null));
});

test("a judge reply reached with a tool is discarded", async () => {
	const { rd } = await run(undefined, { runtime: "opencode" }, { runtime: "codex", judgeOutcome: (p) => outcome(judgeReply(p), { tools: [{ name: "read", input: {}, status: "completed", paths: ["/x"], addresses: [] }] }) });
	assert.ok(read<Vote[]>(rd, "judging/votes.json").filter((v) => v.judge === "p2").every((v) => v.value === null));
});

test("judge eligibility gates vote acceptance on exit, stop, filter and error, and retains per-attempt prompt, local mapping and outcome in judging/<job>.json", async () => {
	let call = 0;
	const { rd } = await run(
		(d) => {
			editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.scenarios = ["scenarios/graft.json"]; j.factors.arms = ["bare"]; });
			editJson(path.join(d, "pack.json"), (j) => { j.suites = j.suites.filter((x: { id: string }) => x.id !== "pruning"); });
		},
		{ runtime: "opencode" },
		{
			runtime: "codex",
			judgeOutcome: (p) => {
				call++;
				// Attempt 1: well-formed JSON reply, but non-zero exit -> ineligible, must be rejected!
				if (call === 1) return outcome(judgeReply(p), { exit: 2 });
				// Attempt 2: well-formed JSON reply, but filtered -> ineligible, must be rejected!
				if (call === 2) return outcome(judgeReply(p), { filtered: true });
				// Attempt 3: eligible reply -> accepted!
				return outcome(judgeReply(p));
			},
		},
	);
	const votes = read<Vote[]>(rd, "judging/votes.json").filter((v) => v.judge === "p2");
	assert.equal(votes.length, 1);
	assert.equal(votes[0]!.value, 1);
	assert.equal(votes[0]!.attempt, 3);
	const jobFile = fs.readdirSync(path.join(rd, "judging")).find((f) => f.includes(".p2.") && f.endsWith(".json"))!;
	const job = read<{ prompt: string; replies: { attempt: number; prompt: string; local: Record<string, string>; eligible: boolean; ineligibleReason: string | null; outcome: Outcome }[] }>(rd, `judging/${jobFile}`);
	assert.equal(job.replies.length, 3);
	assert.equal(job.replies[0]!.eligible, false);
	assert.match(job.replies[0]!.ineligibleReason ?? "", /exit 2/);
	assert.equal(job.replies[1]!.eligible, false);
	assert.match(job.replies[1]!.ineligibleReason ?? "", /filter/);
	assert.equal(job.replies[2]!.eligible, true);
	assert.equal(job.replies[2]!.ineligibleReason, null);
	assert.ok(Object.keys(job.replies[0]!.local).includes("o1"));
	assert.equal(job.replies[0]!.outcome.exit, 2);
});

test("agreement counts only outcomes with two or more votes, and a total needs every property's mean", async () => {
	const { rd } = await run(undefined, { runtime: "opencode", judge: () => "not json" }, { runtime: "codex", judge: () => "not json" });
	const r = read<{ properties: { property: string; agreement: { of: number } }[]; totals: Record<string, number | null> }>(rd, "RESULT.json");
	assert.ok(r.properties.every((p) => p.agreement.of === 0), "a single vote counted as agreement");
	assert.equal(r.totals["bare"], null);
});

test("with one condition to guess between, judges are not asked to guess", async () => {
	const { A } = await run((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.arms = ["bare"]; }));
	assert.ok(A.judged.length > 0 && A.judged.every((p) => !p.includes("guess")));
});

test("answers under headings are judged in the comprehension form, and an empty answer is absent", async () => {
	const edit = (d: string): void => {
		editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.scenarios = ["scenarios/graft.json"]; j.factors.arms = ["bare"]; });
		editJson(path.join(d, "pack.json"), (j) => { j.suites = j.suites.filter((x: { id: string }) => x.id !== "pruning"); });
		editJson(path.join(d, "scenarios", "graft.json"), (j) => {
			j.task = "Questions:\n\n### orchard.G1\nWhat rootstock?\n\n### orchard.G2\nWhat scion?\n\nWrite to {WORKSPACE}/answers.md";
			j.scoredFile = "answers.md";
			j.properties = [
				{ id: "g1", type: "comprehension", decidedBy: "judge", key: "Quince.", scale: [0, 2], rubric: "2 if quince", answerHeading: "orchard.G1" },
				{ id: "g2", type: "comprehension", decidedBy: "judge", key: "Pear.", scale: [0, 2], rubric: "2 if pear", answerHeading: "orchard.G2", question: "What scion?" },
			];
		});
	};
	const { rd, A } = await run(edit, { runtime: "opencode", work: (inv) => { fs.writeFileSync(path.join(inv.workspace, "answers.md"), "### orchard.G1\nQuince.\n### orchard.G2\nWHY: nothing\n"); return outcome("DONE"); } }, { runtime: "codex", work: (inv) => { fs.writeFileSync(path.join(inv.workspace, "answers.md"), "### orchard.G1\nQuince.\n### orchard.G2\nPear.\n"); return outcome("DONE"); } });
	const prompt = A.judged.find((p) => p.includes("--- answer a1 ---"))!;
	assert.ok(prompt.startsWith("You are scoring answers to a comprehension test against an answer key."));
	assert.match(prompt, /PROBE orchard\.G1\n\nQuestion:\nWhat rootstock\?\n\nKey:\nQuince\.\n\nRubric:\n2 if quince/);
	assert.match(prompt, /PROBE orchard\.G2\n\nQuestion:\nWhat scion\?\n\nKey:/, "the last question carried the reader's instructions");
	assert.equal(prompt.includes("give your guess") || prompt.includes('"guess"'), false);
	const r = read<{ absent: { cell: string; property: string }[]; cellValues: Record<string, Record<string, unknown>> }>(rd, "RESULT.json");
	assert.deepEqual(r.absent, [{ cell: "graft.bare.p1.1", property: "g2" }]);
	assert.equal(r.cellValues["graft.bare.p1.1"]!["g2"], 0);
	assert.equal(r.cellValues["graft.bare.p2.1"]!["g2"], 1);
});

test("the seed alone fixes the blinding, whatever order the cells are given in", async () => {
	const { rd, record, loaded } = await run();
	const cells = record.cells.map((c) => read<CellRecord>(rd, `cells/${c}.json`));
	const scenarios = new Map([...loaded.experiments.get("orchard")!.scenarios.values()].map((x) => [x.scenario.id, x.scenario]));
	const fam = new Map(loaded.pack.population.map((m) => [m.id, m.family]));
	const a = blind(loaded, scenarios, cells, fam, "s").units.map((u) => `${u.id}:${u.cell}:${u.properties}`);
	const b = blind(loaded, scenarios, [...cells].reverse(), fam, "s").units.map((u) => `${u.id}:${u.cell}:${u.properties}`);
	assert.deepEqual(a, b);
});

test("the tally keys guesses by unit and judge, whatever characters a unit id holds", async () => {
	const { tally } = await import("../src/index.js");
	const sc = { id: "s", tags: [], fixture: null, task: "", properties: [{ id: "p", type: "adherence" as const, decidedBy: "judge" as const, key: "", scale: [0, 1] as [number, number] }] };
	const mk = (id: string, arm: string): CellRecord => ({ cell: id, scenario: "s", arm, member: "m", run: 1, valid: true, final: "", scoredFile: null, answers: {}, diff: null, codeScores: [], attempts: [{ attempt: 1, validity: { valid: true }, outcome: { final: "", exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" }, diff: null }] });
	const cells = [mk("s.a.m.1", "a"), mk("s.b.m.1", "b")];
	const units = cells.map((c) => ({ id: c.cell, cell: c.cell, scenario: "s", arm: c.arm, member: "m", family: "f", properties: ["p"], text: "", blindedAt: "" }));
	const votes = units.flatMap((u) => ["j1", "j2"].map((j) => ({ unit: u.id, property: "p", judge: j, family: j, value: 1, reason: "", guess: "a", prompt: "x" })));
	const r = tally({ run: "r", status: "s", arms: ["a", "b"], members: ["m"], scenarios: new Map([["s", sc]]), cells, units, absent: [], votes, assigned: () => ["j1", "j2"], guessGroups: { a: ["a"], b: ["b"] } });
	assert.deepEqual([r.guesses.all, r.guesses.right, r.guesses.baseRate], [4, 2, 0.5]);
});

test("agreement counts two valid votes that agree, and not one", async () => {
	const { tally } = await import("../src/index.js");
	const sc = { id: "s", tags: [], fixture: null, task: "", properties: [{ id: "p", type: "adherence" as const, decidedBy: "judge" as const, key: "", scale: [0, 1] as [number, number] }] };
	const mk = (id: string): CellRecord => ({ cell: id, scenario: "s", arm: "a", member: "m", run: 1, valid: true, final: "", scoredFile: null, answers: {}, diff: null, codeScores: [], attempts: [{ attempt: 1, validity: { valid: true }, outcome: { final: "", exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" }, diff: null }] });
	const cells = [mk("c1"), mk("c2")];
	const units = cells.map((c) => ({ id: `u-${c.cell}`, cell: c.cell, scenario: "s", arm: "a", member: "m", family: "f", properties: ["p"], text: "", blindedAt: "" }));
	const votes = [{ u: "u-c1", j: "j1", v: 1 }, { u: "u-c1", j: "j2", v: 1 }, { u: "u-c2", j: "j1", v: 1 }].map((x) => ({ unit: x.u, property: "p", judge: x.j, family: x.j, value: x.v, reason: "", guess: null, prompt: "x" }));
	const r = tally({ run: "r", status: "s", arms: ["a"], members: ["m"], scenarios: new Map([["s", sc]]), cells, units, absent: [], votes, assigned: (u) => (u.id === "u-c1" ? ["j1", "j2"] : ["j1"]), guessGroups: {} });
	assert.deepEqual(r.properties[0]!.agreement, { agree: 1, of: 1 });
});

test("sandboxed path attempts are reported in the result", async () => {
	const { rd } = await run(undefined, { runtime: "opencode", sandboxed: true, work: (inv) => outcome("Grafted.", { tools: [{ name: "read", input: {}, status: "error", paths: [path.join(path.dirname(inv.workspace), "w-other", "NOTES.txt")], addresses: [] }] }) });
	const r = read<{ unreachable: string[]; excluded: unknown[] }>(rd, "RESULT.json");
	assert.ok(r.unreachable.length > 0 && r.unreachable.every((c) => c.endsWith(".p1.1")));
	assert.deepEqual(r.excluded, []);
	assert.match(fs.readFileSync(path.join(rd, "RESULT.md"), "utf8"), /named forbidden paths/);
});
