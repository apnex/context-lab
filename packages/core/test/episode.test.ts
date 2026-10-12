// Delta-2 stage 2: multi-phase episodes. Criteria F3 (phases, notes, continuation, a phase that
// fails ending its episode), F4 (branches from one state, own and generated notes, a failing note
// hook), F5 (trap rotation) and F6 (each property judged on its phase; nothing else of other phases
// reaching a judge; the record re-tallying).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CANARY_QUESTION, NO_NOTE, conductRun, rotate, tallyRun, type Adapter, type CellRecord, type Invocation, type Outcome } from "../src/index.js";
import { commitAll, copyPack, editJson, isJudgePrompt, judgeReply, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

interface Opts { work?: (inv: Invocation) => Outcome | null; noNote?: boolean }
function agent(runtime: string, o: Opts = {}): Adapter & { calls: Invocation[]; judged: string[] } {
	const calls: Invocation[] = [];
	const judged: string[] = [];
	let n = 0;
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: true,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, judged, calls,
		refuse: (inv) => (inv.continueFrom && path.resolve(inv.continueFrom.workspace) !== path.resolve(inv.workspace) ? "workspace" : null),
		async invoke(inv) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && isJudgePrompt(inv.prompt)) { judged.push(inv.prompt); return outcome(judgeReply(inv.prompt)); }
			if (inv.tools === "off") return outcome("I do not know.");
			calls.push(inv);
			const session = `s-${runtime}-${++n}`;
			const custom = o.work?.(inv);
			if (custom) return { ...custom, session };
			if (inv.prompt.includes("Plant the rows")) {
				fs.writeFileSync(path.join(inv.workspace, "FIELD.txt"), "rows: 2\n");
				if (!o.noNote) fs.writeFileSync(path.join(inv.workspace, "NOTE.md"), "NOTE-MARKER: frost cover after row two.\n");
				return outcome("WORK-FINAL-MARKER", { session });
			}
			if (inv.prompt.includes("Say whether")) return outcome("WRAP-FINAL-MARKER", { session });
			fs.writeFileSync(path.join(inv.workspace, "FIELD.txt"), "rows: 3\ncover: on\n");
			return outcome(inv.prompt.includes("NOTE-MARKER") ? "RESUME-OWN-FINAL" : "RESUME-GEN-FINAL", { session });
		},
	};
}

async function run(edit?: (d: string) => void, oc: Opts = {}, cx: Opts = {}) {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "relay.json"), (j) => { j.factors.population = ["p1", "p2"]; j.runsPerCell = 1; });
	edit?.(dir);
	commitAll(dir);
	const A = agent("opencode", oc), B = agent("codex", cx);
	const records = path.join(scratch(), "records");
	const { dir: rd, record } = await conductRun(dir, { experiment: "relay", adapters: { opencode: A, codex: B }, work: path.join(scratch(), "work"), records });
	return { rd, record, A, B, dir };
}
const read = <T>(rd: string, f: string): T => JSON.parse(fs.readFileSync(path.join(rd, f), "utf8")) as T;
const phasesOf = (c: CellRecord) => c.attempts[c.attempts.length - 1]!.phases!;

test("F3: phases run in order - a new session from a note file, and a continuing session in the same workspace", async () => {
	const { rd, A } = await run();
	const c = read<CellRecord>(rd, "cells/relay.bare.p1.1.json");
	const ph = Object.fromEntries(phasesOf(c).map((p) => [p.phase, p]));
	assert.deepEqual(A.calls.length, 4);
	const [work, own, gen, wrap] = A.calls;
	assert.ok(work!.prompt.includes("Plant the rows") && work!.continueFrom === undefined);
	assert.ok(own!.prompt.includes("NOTE-MARKER: frost cover after row two.\n"), "the note was not in the prompt byte for byte");
	assert.equal(own!.continueFrom, undefined, "a new session carried a session id");
	assert.equal(gen!.continueFrom, undefined);
	assert.equal(wrap!.continueFrom?.session, ph["resume-own"]!.outcome!.session);
	assert.equal(wrap!.workspace, own!.workspace, "the continuing phase ran in another workspace");
	assert.notEqual(own!.workspace, work!.workspace);
	assert.notEqual(gen!.workspace, own!.workspace);
	assert.equal(fs.existsSync(path.join(own!.workspace, "PLAN.txt")), false, "a withheld file was left");
	assert.deepEqual(phasesOf(c).map((p) => [p.phase, p.status]), [["work", "run"], ["resume-own", "run"], ["resume-gen", "run"], ["wrap", "run"]]);
});

test("F3: a phase invalid for behaviour ends its episode - later phases get no call and score the bottom", async () => {
	const { rd, A } = await run(undefined, { work: (inv) => (inv.prompt.includes("Plant the rows") ? outcome("") : null) });
	assert.equal(A.calls.length, 1);
	const c = read<CellRecord>(rd, "cells/relay.bare.p1.1.json");
	assert.equal(c.valid, false);
	assert.equal(c.attempts.length, 1, "agent behaviour was re-run");
	assert.equal(c.attempts[0]!.endedAt, "work");
	const r = read<{ cellValues: Record<string, Record<string, unknown>> }>(rd, "RESULT.json");
	for (const p of ["relay-1", "relay-2", "relay-3", "frost-1", "wasp-1"]) assert.equal(r.cellValues["relay.bare.p1.1"]![p], 0);
});

test("F3: a later phase failing for behaviour keeps the earlier phases' judged values", async () => {
	const { rd } = await run(undefined, { work: (inv) => (inv.prompt.includes("NOTE-MARKER") ? outcome("") : null) });
	const r = read<{ cellValues: Record<string, Record<string, unknown>> }>(rd, "RESULT.json");
	const v = r.cellValues["relay.bare.p1.1"]!;
	assert.equal(v["relay-1"], 1, "a property of the phase before the failure lost its judged value");
	assert.equal(v["relay-2"], 0);
	assert.equal(v["relay-3"], 0);
});

test("F4: branches start from the same state; own and generated notes; a missing own note", async () => {
	const { rd, A } = await run(undefined, { noNote: true });
	const c = read<CellRecord>(rd, "cells/relay.bare.p1.1.json");
	const ph = Object.fromEntries(phasesOf(c).map((p) => [p.phase, p]));
	assert.equal(ph["resume-own"]!.copiedTree, ph["work"]!.endTree);
	assert.equal(ph["resume-gen"]!.copiedTree, ph["work"]!.endTree);
	assert.equal(ph["resume-own"]!.note, NO_NOTE);
	assert.match(ph["resume-gen"]!.note ?? "", /^Files changed in the earlier session: FIELD\.txt\.$/);
	assert.ok(A.calls[1]!.prompt.includes(NO_NOTE));
});

test("F4: a note hook that fails leaves its branch incomplete and the other branch judged", async () => {
	const { rd, A } = await run((d) => fs.writeFileSync(path.join(d, "hooks", "relay-note.mjs"), "process.exit(2);\n"));
	assert.equal(A.calls.length, 3, "the failed branch ran");
	const c = read<CellRecord>(rd, "cells/relay.bare.p1.1.json");
	assert.equal(phasesOf(c).find((p) => p.phase === "resume-gen")!.status, "incomplete");
	assert.equal(c.valid, true);
	const r = read<{ cellValues: Record<string, Record<string, unknown>> }>(rd, "RESULT.json");
	assert.equal(r.cellValues["relay.bare.p1.1"]!["relay-3"], "incomplete");
	assert.equal(r.cellValues["relay.bare.p1.1"]!["relay-2"], 1);
});

test("F5: trap pairs rotate as the rule states, each met once per cell, the same on a second run", async () => {
	const go = async () => {
		const dir = copyPack();
		commitAll(dir);
		const records = path.join(scratch(), "records");
		const { dir: rd, record } = await conductRun(dir, { experiment: "relay", adapters: { opencode: agent("opencode"), codex: agent("codex") }, work: path.join(scratch(), "work"), records });
		return Object.fromEntries(record.cells.map((c) => [c, read<CellRecord>(rd, `cells/${c}.json`).traps!]));
	};
	const first = await go();
	const members = ["p1", "p2", "p3"], positions = ["early", "late", "resume"], versions = ["a", "b"];
	const phaseOf: Record<string, string> = { early: "work", late: "work", resume: "resume-own" };
	for (const [j, m] of members.entries()) for (let r = 0; r < 3; r++) {
		const traps = first[`relay.bare.${m}.${r + 1}`]!;
		assert.deepEqual(traps.map((t) => t.pair).sort(), ["frost", "wasp"], "a pair was not met exactly once");
		for (const [k, pair] of ["frost", "wasp"].entries()) {
			const t = traps.find((x) => x.pair === pair)!;
			assert.deepEqual([t.position, t.version, t.phase], [positions[(r + k) % 3], versions[(j + r) % 2], phaseOf[positions[(r + k) % 3]!]]);
		}
	}
	assert.deepEqual(await go(), first, "a second run recorded different assignments");
	assert.deepEqual(rotate({ id: "x", positions, versions: [{ id: "a", text: "" }, { id: "b", text: "" }], properties: [] }, 2, 1, 1), { position: "early", version: "b" });
});

test("F6: each property is judged on its phase; no other phase's outcome reaches a judge but a named note or start", async () => {
	const { rd, A, B } = await run();
	const prompts = [...A.judged, ...B.judged];
	const units = read<{ units: { phase: string; properties: string[]; text: string }[] }>(rd, "sealed/units.json").units;
	for (const u of units) {
		const others = { work: "WORK-FINAL-MARKER", "resume-own": "RESUME-OWN-FINAL", "resume-gen": "RESUME-GEN-FINAL", wrap: "WRAP-FINAL-MARKER" } as Record<string, string>;
		for (const [ph, marker] of Object.entries(others)) if (ph !== u.phase) assert.equal(u.text.includes(marker), false, `${marker} reached a unit of ${u.phase}`);
		if (u.properties.includes("relay-1")) assert.equal(u.phase, "work");
		if (u.properties.includes("relay-2")) { assert.equal(u.phase, "resume-own"); assert.match(u.text, /NOTE THIS SESSION WAS GIVEN ---\nNOTE-MARKER/); }
		if (u.properties.includes("relay-3")) { assert.equal(u.phase, "resume-gen"); assert.match(u.text, /CHANGES THIS SESSION STARTED FROM/); }
	}
	assert.ok(prompts.length > 0);
	const first = fs.readFileSync(path.join(rd, "RESULT.json"), "utf8");
	tallyRun(rd);
	assert.equal(fs.readFileSync(path.join(rd, "RESULT.json"), "utf8"), first);
});

test("a continuing phase on an adapter that cannot continue refuses the run at the pack check", async () => {
	const dir = copyPack();
	commitAll(dir);
	const noCont = { ...agent("opencode"), continue: false };
	await assert.rejects(conductRun(dir, { experiment: "relay", adapters: { opencode: noCont, codex: agent("codex") }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") }), /cannot/);
	void execFileSync;
});
