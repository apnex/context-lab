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
				if (!o.noNote) {
					fs.writeFileSync(path.join(inv.workspace, "NOTE.md"), "NOTE-MARKER: frost cover after row two.\n");
					execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@a.invalid", "commit", "-qam", "handoff", "--allow-empty"], { cwd: inv.workspace });
					execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@a.invalid", "add", "NOTE.md"], { cwd: inv.workspace });
					execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@a.invalid", "commit", "-qm", "handoff note"], { cwd: inv.workspace });
				}
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
	// Nor can it be read from history or from any object in either branch's repository, though the
	// work phase committed its note (the stub's work phase commits NOTE.md).
	for (const ws of [own!.workspace, gen!.workspace]) {
		const objects = execFileSync("git", ["cat-file", "--batch-all-objects", "--batch"], { cwd: ws, encoding: "utf8" });
		assert.equal(objects.includes("frost cover goes on after the second row"), false, "a withheld file is readable from git");
		assert.equal(objects.includes("NOTE-MARKER"), false, "the withheld own note is readable from git");
		assert.equal(execFileSync("git", ["log", "--oneline", "--all"], { cwd: ws, encoding: "utf8" }).trim().split("\n").length, 1);
	}
	assert.match(execFileSync("git", ["log", "--oneline"], { cwd: work!.workspace, encoding: "utf8" }), /handoff/, "the stub did not commit its note");
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
	for (const p of ["relay-1", "relay-2", "relay-3", "relay-4", "frost-1", "wasp-1"]) assert.equal(r.cellValues["relay.bare.p1.1"]![p], 0);
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
		if (u.properties.includes("relay-3")) { assert.equal(u.phase, "resume-gen"); assert.match(u.text, /CHANGES THIS SESSION STARTED FROM/); assert.equal(u.text.includes("PLAN.txt"), false, "a withheld path reached a judge"); }
	}
	assert.ok(prompts.length > 0);
	// A unit shows a note or starting changes only where every property in it names them.
	const named = new Map([["relay-2", ["note"]], ["relay-3", ["note", "start"]]]);
	assert.ok(units.some((u) => u.properties.includes("relay-4")), "no unit of the property that names nothing");
	for (const u of units) {
		const withs = u.properties.map((p) => named.get(p) ?? []);
		assert.equal(u.text.includes("NOTE THIS SESSION WAS GIVEN"), withs.every((w) => w.includes("note")), `note shown wrongly in a unit of ${u.properties}`);
		assert.equal(u.text.includes("CHANGES THIS SESSION STARTED FROM"), withs.every((w) => w.includes("start")), `start shown wrongly in a unit of ${u.properties}`);
	}
	const markers = ["WORK-FINAL-MARKER", "RESUME-OWN-FINAL", "RESUME-GEN-FINAL", "WRAP-FINAL-MARKER"];
	for (const p of prompts) assert.ok(markers.filter((m) => p.includes(m)).length <= 1, "one judge prompt holds outcomes of two phases");
	// The note reaches a judge only with the phase that wrote it (in its diff) or the phase whose
	// property names it; never with the generated branch or the continuing phase.
	assert.ok(prompts.some((p) => p.includes("RESUME-OWN-FINAL") && p.includes("NOTE THIS SESSION WAS GIVEN ---\nNOTE-MARKER")));
	for (const p of prompts) if (p.includes("RESUME-GEN-FINAL") || p.includes("WRAP-FINAL-MARKER")) assert.equal(p.includes("NOTE-MARKER"), false, "the own note reached a judge of a phase that does not name it");
	const first = fs.readFileSync(path.join(rd, "RESULT.json"), "utf8");
	tallyRun(rd);
	assert.equal(fs.readFileSync(path.join(rd, "RESULT.json"), "utf8"), first);
});

test("a continuing phase on an adapter that cannot continue refuses the run at the pack check", async () => {
	const dir = copyPack();
	commitAll(dir);
	const noCont = { ...agent("opencode"), continue: false };
	await assert.rejects(conductRun(dir, { experiment: "relay", adapters: { opencode: noCont, codex: agent("codex") }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") }), /cannot/);
});

for (const [name, body] of [
	["attempts the network", (port: number) => `import net from "node:net"; await new Promise((res, rej) => { const s = net.connect({ host: "127.0.0.1", port: ${port}, timeout: 3000 }, () => { s.destroy(); res(); }); s.on("error", rej); s.on("timeout", () => rej(new Error("timeout"))); }); console.log(JSON.stringify({ note: "reached" }));\n`],
	["reads outside its inputs", (_: number, secret: string) => `import fs from "node:fs"; console.log(JSON.stringify({ note: fs.readFileSync(${JSON.stringify(secret)}, "utf8") }));\n`],
	["writes outside its folder", (_: number, __: string, target: string) => `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(target)}, "x"); console.log(JSON.stringify({ note: "wrote" }));\n`],
	["overruns its limit", () => "for (;;) {}\n"],
] as const) {
	test(`F4: a note hook that ${name} is stopped; its branch is incomplete, the other judged`, { timeout: 60000 }, async () => {
		const server = (await import("node:net")).createServer((c) => c.end("open")).listen(0, "127.0.0.1");
		await new Promise((r) => server.once("listening", r));
		const port = (server.address() as import("node:net").AddressInfo).port;
		const elsewhere = scratch();
		const secret = path.join(elsewhere, "secret.txt");
		fs.writeFileSync(secret, "SECRET-MARKER");
		const target = path.join(elsewhere, "written.txt");
		try {
			const { rd, A } = await run((d) => {
				fs.writeFileSync(path.join(d, "hooks", "relay-note.mjs"), body(port, secret, target));
				editJson(path.join(d, "pack.json"), (j) => { j.hooks.find((h: { id: string }) => h.id === "relay-note").timeLimitSeconds = 2; });
			});
			assert.equal(A.calls.length, 3, "the failed branch ran");
			assert.equal(A.calls.some((c) => c.prompt.includes("SECRET-MARKER") || c.prompt.includes("reached") || c.prompt.includes("wrote")), false);
			assert.equal(fs.existsSync(target), false, "the hook wrote outside its folder");
			const c = read<CellRecord>(rd, "cells/relay.bare.p1.1.json");
			assert.equal(phasesOf(c).find((p) => p.phase === "resume-gen")!.status, "incomplete");
			const r = read<{ cellValues: Record<string, Record<string, unknown>> }>(rd, "RESULT.json");
			assert.equal(r.cellValues["relay.bare.p1.1"]!["relay-3"], "incomplete");
			assert.equal(r.cellValues["relay.bare.p1.1"]!["relay-2"], 1);
		} finally {
			server.close();
		}
	});
}
