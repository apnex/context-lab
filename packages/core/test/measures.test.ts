// Delta-2 stage 3: the result's measures. Criteria F7 (the comprehension-behaviour link), F8
// (restated-guidance flags), F9 (stated variation and the detectable difference) and F10's result
// clause (held-out scenarios and exposure). Expected values are worked by hand in the comments,
// from section 1's definitions, not computed by the code under test.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, checkPack, conductRun, detectable, detectableDifference, exposureFile, linkRates, propertiesOf, readExposures, recordExperiment, recordExposure,
	sharedRun, tallyRun, words, type Adapter, type Invocation, type Outcome, type Property, type Scenario,
} from "../src/index.js";
import { commitAll, copyPack, editJson, isJudgePrompt, judgeReply, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}
function agent(runtime: string, work: (inv: Invocation) => string): Adapter {
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: true,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && isJudgePrompt(inv.prompt)) return outcome(judgeReply(inv.prompt));
			if (inv.tools === "off") return outcome("I do not know.");
			return outcome(work(inv), { session: "s" });
		},
	};
}
async function loadPack(dir: string) {
	const r = await checkPack(dir);
	if (!r.ok) throw new Error(JSON.stringify(r.defects));
	return r.loaded;
}
const read = <T>(rd: string, f: string): T => JSON.parse(fs.readFileSync(path.join(rd, f), "utf8")) as T;

// ---------------------------------------------------------------- F7

const prop = (id: string, type: Property["type"], guidance: string[], scale: [number, number] = [0, 1]): Property => ({ id, type, decidedBy: "judge", key: "k", scale, guidance });

test("F7: the link's four rates per member, arm and guidance id, a property naming two ids counting toward each", () => {
	const s: Scenario = { id: "s", tags: [], fixture: null, task: "t", properties: [
		prop("c1", "comprehension", ["G"], [0, 2]),
		prop("c2", "comprehension", ["G", "H"]),
		prop("a1", "adherence", ["G"]),
		prop("a2", "adherence", ["H"]),
		prop("x", "precision", ["G"]),
	] };
	const cells = [
		{ cell: "e1", scenario: "s", arm: "on", member: "m" },
		{ cell: "e2", scenario: "s", arm: "on", member: "m" },
		{ cell: "e3", scenario: "s", arm: "off", member: "m" },
	];
	const values = {
		// c1 on [0,2]: 1 is the midpoint, so met; c2 0 not met; a1 met; a2 not met.
		e1: { c1: 1, c2: 0, a1: 1, a2: 0, x: 1 },
		// c1 0.5 not met; c2 1 met; a1 incomplete makes no pair; a2 met.
		e2: { c1: 0.5, c2: 1, a1: "incomplete" as const, a2: 1, x: 0 },
		e3: { c1: 2, c2: 1, a1: 0, a2: 1, x: 1 },
	};
	const rows = linkRates(cells, values, new Map([["s", s]]), propertiesOf);
	// m/on/G: e1 pairs (c1 met, a1 met) -> met,met; (c2 not, a1 met) -> not,met; e2 has no adherence
	//   value for G. 2 pairs: metMet 1/2, notMet 1/2.
	// m/on/H: e1 (c2 not, a2 not) -> neither; e2 (c2 met, a2 met) -> met,met. 2 pairs: 1/2, 1/2.
	// m/off/G: (c1 met, a1 not) -> met,not; (c2 met, a1 not) -> met,not. 2 pairs: metNot 1.
	// m/off/H: (c2 met, a2 met) -> met,met. 1 pair.
	assert.deepEqual(rows, [
		{ member: "m", arm: "off", guidance: "G", pairs: 2, metMet: 0, metNot: 1, notMet: 0, neither: 0 },
		{ member: "m", arm: "off", guidance: "H", pairs: 1, metMet: 1, metNot: 0, notMet: 0, neither: 0 },
		{ member: "m", arm: "on", guidance: "G", pairs: 2, metMet: 0.5, metNot: 0, notMet: 0.5, neither: 0 },
		{ member: "m", arm: "on", guidance: "H", pairs: 2, metMet: 0.5, metNot: 0, notMet: 0, neither: 0.5 },
	]);
});

// ---------------------------------------------------------------- F8, words

test("F8: words are runs of letters, digits and apostrophes, lowercased, with markdown dropped", () => {
	assert.deepEqual(words("**Don't** see [the guide](https://x.invalid/a/b.md), `code_x` #3 <b>bold</b> <https://y.invalid/z>"), ["don't", "see", "the", "guide", "code", "x", "3", "bold"]);
	assert.deepEqual(words("It\u2019s ![alt text](img.png) | cell |"), ["it's", "alt", "text", "cell"]);
	const twelve = "one two three four five six seven eight nine ten eleven twelve";
	assert.equal(sharedRun(`Intro. ${twelve.toUpperCase()}!`, `# Head\n\n- ${twelve.split(" ").join(" **")} end`), twelve);
	const eleven = twelve.split(" ").slice(0, 11).join(" ");
	assert.equal(sharedRun(`x ${eleven} y`, `a ${twelve} b`), null);
	// Twelve shared words broken by a word between them is not a run.
	assert.equal(sharedRun("one two three four five six SEVEN-X seven eight nine ten eleven twelve", twelve), null);
});

// ---------------------------------------------------------------- F8, end to end

const guide = "# Almanac\n\nGraft in early spring when the buds are swelling but before any leaf has opened on the tree.\nPrune crossing branches in winter.\n";
const shelf = "Water the young saplings every second morning through the whole of the first dry summer season.\n";

test("F8: twelve words shared with an instruction or folder file are flagged with both paths; eleven, or an on-request file, are not; no score moves", async () => {
	const dir = copyPack();
	fs.writeFileSync(path.join(dir, "source", "GUIDE.md"), guide + "The heron counts eleven stones.\n");
	fs.writeFileSync(path.join(dir, "source", "SHELF.md"), shelf);
	editJson(path.join(dir, "pack.json"), (j) => {
		j.arms.push({ id: "folder", deliver: [{ variant: "almanac-full", file: "GUIDE.md", as: "folder-file" }] });
		j.arms.push({ id: "shelf", deliver: [{ variant: "almanac-full", file: ".", as: "on-request" }] });
		for (const l of j.isolation.leakProbes ?? []) for (const a of ["folder", "shelf"]) if (!l.arms.includes(a)) l.arms.push(a);
	});
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.factors.arms = ["almanac", "folder", "shelf"]; j.factors.population = ["p1", "p2"]; j.runsPerCell = 1; j.scenarios = ["scenarios/prune.json"]; });
	commitAll(dir);
	const twelve = "graft in early spring when the buds are swelling but before any";
	const eleven = "the young saplings every second morning through the whole of the";
	const folderRun = "but before any leaf has opened on the tree prune crossing branches";
	// almanac (instruction): p1 shares twelve words, p2 eleven; folder (folder file): both share
	// twelve; shelf (on request): both share fourteen with the on-request file only.
	const say = (inv: Invocation): string => inv.arm.arm === "shelf" ? `Note: water ${shelf.split(" ").slice(0, 14).join(" ")}` : inv.arm.arm === "folder" ? `Plan: ${folderRun}.` : inv.member.id === "p1" ? `Plan: ${twelve} leaf.` : `Plan: ${twelve.split(" ").slice(0, 11).join(" ")} buds. Also ${eleven}.`;
	const { dir: rd, record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: agent("opencode", say), codex: agent("codex", say) }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") });
	const r = read<{ restated: { cell: string; source: string; path: string; delivered: { file: string; path: string }; words: string }[]; cellValues: Record<string, unknown> }>(rd, "RESULT.json");
	assert.deepEqual(r.restated.map((x) => x.cell).sort(), ["prune.almanac.p1.1", "prune.folder.p1.1", "prune.folder.p2.1"], JSON.stringify(r.restated));
	assert.ok(r.restated.filter((x) => x.cell.startsWith("prune.folder.")).every((x) => x.words === folderRun && x.delivered.file === "GUIDE.md"));
	const f = r.restated.find((x) => x.cell === "prune.almanac.p1.1")!;
	assert.equal(f.source, "final");
	assert.equal(f.path, "(final message of work)");
	assert.equal(f.delivered.file, "GUIDE.md");
	assert.ok(f.delivered.path.endsWith("GUIDE.md") && path.isAbsolute(f.delivered.path));
	assert.equal(f.words, twelve);
	// Flags reach no score and no judge.
	assert.deepEqual(Object.keys(r.cellValues).sort(), record.cells.slice().sort());
	// Stub judges score every outcome 1, flagged or not.
	for (const v of Object.values(r.cellValues)) assert.deepEqual(v, { "prune-1": 1 });
	const units = fs.readFileSync(path.join(rd, "sealed", "units.json"), "utf8");
	assert.equal(units.includes("restated") || units.includes("GUIDE.md ("), false);
});

test("F8: a note a session was given is checked too, with its file's path", async () => {
	const dir = copyPack();
	fs.writeFileSync(path.join(dir, "source", "GUIDE.md"), "Prune crossing branches in winter.\n" + guide.replace("# Almanac\n\n", ""));
	editJson(path.join(dir, "experiments", "relay.json"), (j) => { j.factors.arms = ["almanac"]; j.factors.population = ["p1"]; j.runsPerCell = 1; });
	commitAll(dir);
	// The guide's words begin "prune crossing branches in winter graft in early spring when the buds".
	const words12 = "prune crossing branches in winter graft in early spring when the buds";
	const a = agent("opencode", (inv) => {
		if (inv.prompt.includes("Plant the rows")) fs.writeFileSync(path.join(inv.workspace, "NOTE.md"), `Remember: ${words12}.\n`);
		return "ok";
	});
	const { dir: rd } = await conductRun(dir, { experiment: "relay", adapters: { opencode: a }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") });
	const r = read<{ restated: { phase: string; source: string; path: string }[] }>(rd, "RESULT.json");
	// The note is given to resume-own; the generated branch's note lists changed files only.
	assert.deepEqual(r.restated.map((f) => [f.phase, f.source, f.path]), [["resume-own", "note", "NOTE.md"]]);
});

// ---------------------------------------------------------------- F9

test("F9: recordExperiment refuses a result with no variation or no default, and accepts an exploration without them", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { delete j.variation; });
	let L = await loadPack(dir);
	assert.throws(() => recordExperiment(L, "orchard"), /states no variation/);
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.variation = { difference: 0.25, scope: "pooled" }; delete j.default; });
	L = await loadPack(dir);
	assert.throws(() => recordExperiment(L, "orchard"), /states no default/);
	assert.equal(fs.existsSync(path.join(dir, "register", "orchard.json")), false);
	assert.equal(recordExperiment(L, "relay").declaredStatus, "exploration");
	// Both are covered by the hash: changing either after recording makes a run exploration.
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.default = "no change indicated"; });
	L = await loadPack(dir);
	const rec = recordExperiment(L, "orchard");
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.variation.difference = 0.3; });
	L = await loadPack(dir);
	const { contentHash } = await import("../src/index.js");
	assert.notEqual(contentHash(L, "orchard"), rec.hash);
});

test("F9: the detectable difference per scope, by section 1's formula, beside the stated one", async () => {
	// (1.96 + 0.84) sqrt(2 * 0.5 * 0.5 / 8) = 2.8 * 0.25 = 0.70
	assert.equal(detectableDifference(0.5, 8).toFixed(2), "0.70");
	// Scale [0, 2] values are fractions of the scale: 0, 1, 2 -> 0, 0.5, 1.
	const p: Property = prop("q", "comprehension", [], [0, 2]);
	// arm A: 2, 2, 0 -> 1, 1, 0; arm B: 1, 0 -> 0.5, 0. p = 2.5 / 5 = 0.5; n = min(3, 2) = 2.
	const d = detectable([{ property: p, byArm: { A: [2, 2, 0], B: [1, 0] } }], ["A", "B"])!;
	assert.deepEqual([d.p, d.n], [0.5, 2]);
	assert.equal(d.difference.toFixed(2), "1.40");
	assert.equal(detectable([{ property: p, byArm: { A: [1], B: [] } }], ["A", "B"]), null);

	// End to end: orchard, two arms, two members, two runs. Stub judges score every judged property
	// 1: graft-1 on [0, 1] is 1, prune-1 on [0, 2] is 0.5 of its scale; graft-2 (code, words < 50)
	// scores 1. 2 members x 2 runs = 4 cell runs per scenario and arm.
	const dir = copyPack();
	commitAll(dir);
	const { dir: rd } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: agent("opencode", () => "done"), codex: agent("codex", () => "done") }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") });
	const r = read<{ variation: { stated: unknown; default: string; pooled: { p: number; n: number; difference: number }; byProperty: { property: string; detectable: { p: number; n: number } }[] } }>(rd, "RESULT.json");
	assert.deepEqual(r.variation.stated, { difference: 0.25, scope: "pooled" });
	assert.equal(r.variation.default, "no change indicated");
	// Pooled: 3 properties x 4 cell runs = 12 outcomes per arm; per arm 4 + 4 + 4 * 0.5 = 10, so
	// p = 20 / 24 = 0.8333; difference = 2.8 sqrt(2 * 0.8333 * 0.1667 / 12) = 2.8 * 0.15215 = 0.43.
	assert.deepEqual([r.variation.pooled.p.toFixed(4), r.variation.pooled.n, r.variation.pooled.difference.toFixed(2)], ["0.8333", 12, "0.43"]);
	assert.deepEqual(r.variation.byProperty.map((x) => [x.property, x.detectable.n]), [["graft-1", 4], ["graft-2", 4], ["prune-1", 4]]);
	assert.match(fs.readFileSync(path.join(rd, "RESULT.md"), "utf8"), /Stated: a difference of 0\.25 in pass rate, pooled; default when none is detected: no change indicated\.\nDetectable at 80% power, 5% two-sided, pooled: 0\.43 \(p 0\.83, n 12\)\./);
	// The result keeps the stated variation from the record, not the pack: a re-tally is the same.
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.variation.difference = 0.9; });
	const before = fs.readFileSync(path.join(rd, "RESULT.json"), "utf8");
	tallyRun(rd);
	assert.equal(fs.readFileSync(path.join(rd, "RESULT.json"), "utf8"), before);
});

// ---------------------------------------------------------------- F10, result clause

test("F10: held-out properties appear only in the held-out section and in no total; exposure appends and is listed by a later result", async () => {
	const dir = copyPack();
	// prune gains an adherence property naming the guidance its comprehension property names, so it
	// would add to the link if it were not held out.
	editJson(path.join(dir, "scenarios", "prune.json"), (j) => {
		j.properties[0].guidance = ["prune-rule"];
		j.properties.push({ id: "prune-2", type: "adherence", decidedBy: "judge", key: "Prunes in winter.", scale: [0, 1], guidance: ["prune-rule"] });
	});
	commitAll(dir);
	const control = (await conductRun(dir, { experiment: "orchard", adapters: { opencode: agent("opencode", () => "done"), codex: agent("codex", () => "done") }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") })).dir;
	// Not held out: 2 members x 2 arms rows; per member and arm 2 runs, each one pair; prune-1 is 1
	// on [0, 2], the midpoint, so met; prune-2 is 1, met: every pair met and met.
	assert.deepEqual(read<{ link: { member: string; arm: string; pairs: number; metMet: number }[] }>(control, "RESULT.json").link.map((l) => [l.member, l.arm, l.pairs, l.metMet]),
		[["p1", "almanac", 2, 1], ["p1", "bare", 2, 1], ["p2", "almanac", 2, 1], ["p2", "bare", 2, 1]]);
	editJson(path.join(dir, "scenarios", "prune.json"), (j) => { j.heldOut = true; });
	commitAll(dir);
	let C = await loadPack(dir);
	assert.throws(() => recordExposure(C, "graft", "rev-1"), /not held out/);
	assert.throws(() => recordExposure(C, "ghost", "rev-1"), /no scenario/);
	const run = async () => (await conductRun(dir, { experiment: "orchard", adapters: { opencode: agent("opencode", () => "done"), codex: agent("codex", () => "done") }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r") })).dir;
	const first = await run();
	type R = { properties: { property: string }[]; heldOut: { property: string }[]; totals: Record<string, number>; exposed: { scenario: string; change: string }[]; variation: { byProperty: { property: string }[] }; link: unknown[] };
	const r1 = read<R>(first, "RESULT.json");
	assert.deepEqual(r1.properties.map((p) => p.property), ["graft-1", "graft-2"]);
	assert.deepEqual(r1.heldOut.map((p) => p.property), ["prune-1", "prune-2"]);
	assert.deepEqual(r1.link, [], "a held-out scenario counted toward the link");
	// Totals: graft-1 (top 1) + graft-2 (1) = 2 per arm; prune-1 (top 2) would make 4.
	assert.deepEqual(r1.totals, { bare: 2, almanac: 2 });
	assert.deepEqual(r1.variation.byProperty.map((p) => p.property), ["graft-1", "graft-2"]);
	assert.deepEqual(r1.exposed, []);
	const md = fs.readFileSync(path.join(first, "RESULT.md"), "utf8");
	const [main, held] = md.split("## Held-out scenarios");
	assert.equal(main!.includes("prune-1") || main!.includes("prune-2"), false, "a held-out property appears outside its section");
	assert.ok(held!.includes("| prune | prune-1 |"));

	// Exposure: appended, never rewriting an earlier entry.
	C = await loadPack(dir);
	recordExposure(C, "prune", "rev-1", new Date("2026-10-12T10:00:00Z"));
	const bytes = fs.readFileSync(exposureFile(C));
	recordExposure(C, "prune", "rev-2", new Date("2026-10-12T11:00:00Z"));
	const after = fs.readFileSync(exposureFile(C));
	assert.deepEqual(after.subarray(0, bytes.length), bytes, "an earlier entry was rewritten");
	assert.throws(() => recordExposure(C, "prune", "rev-0", new Date("2026-10-12T09:00:00Z")), /not earlier/);
	assert.deepEqual(readExposures(C).map((e) => e.change), ["rev-1", "rev-2"]);

	const second = await run();
	assert.deepEqual(read<R>(second, "RESULT.json").exposed.map((e) => [e.scenario, e.change]), [["prune", "rev-1"], ["prune", "rev-2"]]);
	assert.match(fs.readFileSync(path.join(second, "RESULT.md"), "utf8"), /Exposed to a change: prune to rev-1 \(recorded 2026-10-12T10:00:00\.000Z\); prune to rev-2/);
	// The earlier result is unchanged on a re-tally: exposure is as the register stood when a run began.
	tallyRun(first);
	assert.deepEqual(read<R>(first, "RESULT.json").exposed, []);
});

test("F10: the expose command appends an entry and refuses a scenario that is not held out", async () => {
	const { execFileSync, spawnSync } = await import("node:child_process");
	const { packageRoot } = await import("./helpers.js");
	const cli = path.join(packageRoot, "dist", "src", "cli.js");
	const dir = copyPack();
	editJson(path.join(dir, "scenarios", "prune.json"), (j) => { j.heldOut = true; });
	const out = execFileSync(process.execPath, [cli, "expose", dir, "prune", "abc1234"], { encoding: "utf8" });
	assert.match(out, /^exposed prune to abc1234 at \d{4}-/);
	const bad = spawnSync(process.execPath, [cli, "expose", dir, "graft", "abc1234"], { encoding: "utf8" });
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /not held out/);
	const lines = fs.readFileSync(path.join(dir, "register", "exposure.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	assert.deepEqual(Object.keys(JSON.parse(lines[0]!)), ["scenario", "change", "recordedAt"]);
});
