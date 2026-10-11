// Stage 5: blinding, judging and the tally. Criteria E15 (no judge of an outcome's own family) and
// E14's stage-5 part (every code score precedes its outcome's blinding).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, blind, checkPack, conductRun, tallyRun,
	type Adapter, type CellRecord, type Invocation, type LoadedPack, type Outcome, type RunRecord, type Vote,
} from "../src/index.js";
import { commitAll, copyPack, editJson, scratch } from "./helpers.js";
import { judgeReply } from "./run-conductor.test.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

interface Agent { runtime: string; work?: (inv: Invocation) => Outcome; judge?: (prompt: string, n: number) => string }
function agent(a: Agent): Adapter & { judged: string[]; workCalls: Invocation[] } {
	const judged: string[] = [];
	const workCalls: Invocation[] = [];
	return {
		runtime: a.runtime, rulesFiles: ["AGENTS.md"], modes: ["inline", "stdin"], network: "detected", filesystem: "open", refuse: () => null, judged, workCalls,
		async invoke(inv) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && inv.prompt.includes("=== OUTCOME o1")) { judged.push(inv.prompt); return outcome(a.judge ? a.judge(inv.prompt, judged.length) : judgeReply(inv.prompt)); }
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
	const { rd, loaded } = await run();
	const first = fs.readFileSync(path.join(rd, "RESULT.json"), "utf8");
	tallyRun(rd, loaded);
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
