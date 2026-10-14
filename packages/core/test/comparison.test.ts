// Delta-2 stage 4: the threshold deriver and the comparator. Criteria F11 (thresholds equal those of
// an independent implementation, test/comparison/derive_thresholds.py, written from section 1; a
// pool of eleven refused), F12 (each rule flags exactly what its definition flags; refusals; the
// output's keys) and F10's comparison clause (held-out properties only in their section; exposure
// listed).
//
// Agents are scripted: each cell run's values are written into its final message as markers, and
// stub judges score what the markers say. Known outcomes are read back from the markers in the cell
// records - what the agents said - not from the tally, so the expected values do not pass through
// the code under test. Runs go one cell at a time, so a member's calls arrive in run order.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, assertIdenticalArms, checkPack, compare, runFlags, standardisedDrop, conductRun, deriveThresholds, readTable, readThresholds, recordExperiment, recordExposure, recordThresholds, tallyRun,
	type Adapter, type CellRecord, type Comparison, type Invocation, type Outcome, type ThresholdSet,
} from "../src/index.js";
import { commitAll, copyPack, editJson, packageRoot, scratch } from "./helpers.js";

function outcome(final: string, over: Partial<Outcome> = {}): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null", ...over };
}

/** A judge reply scoring each outcome's properties by the V:<property>=<value> markers in its text. */
function markerReply(prompt: string): string {
	const blocks = prompt.split(/^=== OUTCOME /m).slice(1);
	return JSON.stringify({ outcomes: blocks.map((b) => {
		const [, id, props] = /^(o\d+) - properties ([^=]+) ===/.exec(b)!;
		return { id, scores: Object.fromEntries(props!.split(",").map((p) => p.trim()).map((p) => [p, { v: Number(new RegExp(`V:${p}=(\\d+)`).exec(b)?.[1] ?? 0), reason: "r" }])) };
	}) });
}

type Plan = { graft1: number; graft2: 0 | 1; prune1: number } | "filtered" | "empty";
/** An agent whose cell run r of a scenario, arm and member says what plan(...) gives. */
function scripted(runtime: string, plan: (scenario: string, arm: string, member: string, run: number) => Plan): Adapter {
	const state = new Map<string, { run: number; tries: number }>();
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: true,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		route: (m) => ({ runtime, model: m.model }),
		async invoke(inv: Invocation) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && inv.prompt.includes("=== OUTCOME")) return outcome(markerReply(inv.prompt));
			if (inv.tools === "off") return outcome("I do not know.");
			const scenario = inv.prompt.includes("Graft the pear") ? "graft" : "prune";
			const key = `${scenario}.${inv.arm.arm}.${inv.member.id}`;
			const st = state.get(key) ?? { run: 1, tries: 0 };
			state.set(key, st);
			const p = plan(scenario, inv.arm.arm, inv.member.id, st.run);
			if (p === "filtered") { if (++st.tries === 2) { st.run++; st.tries = 0; } return outcome("", { filtered: true }); }
			st.run++; st.tries = 0;
			if (p === "empty") return outcome("");
			// graft-2 is the code property: under fifty words scores 1.
			const pad = p.graft2 === 1 ? "" : ` ${"word ".repeat(60)}`;
			return outcome(`done V:graft-1=${p.graft1} V:prune-1=${p.prune1}${pad}`, { session: "s" });
		},
	};
}

const read = <T>(dir: string, f: string): T => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
async function loadPack(dir: string) { const r = await checkPack(dir); if (!r.ok) throw new Error(JSON.stringify(r.defects)); return r.loaded; }

/** A pseudo-random value from a key, so plans vary without depending on the code under test. */
function pick(key: string, levels: number): number {
	let h = 2166136261;
	for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	return h % levels;
}

// ---------------------------------------------------------------- F11

async function aaRun() {
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => {
		j.arms.push({ id: "bare-b", deliver: [] });
		j.isolation.leakProbes[0].arms.push("bare-b");
		j.experiments.push("experiments/twin.json");
		j.comparisons = [{ id: "twin-gate", experiment: "twin", rule: "aa", base: "bare", head: "bare-b", m: 3 }];
	});
	fs.writeFileSync(path.join(dir, "experiments", "twin.json"), JSON.stringify({
		id: "twin", declaredStatus: "exploration", scenarios: ["scenarios/graft.json", "scenarios/prune.json"],
		factors: { arms: ["bare", "bare-b"], population: ["p1", "p2"] }, runsPerCell: 9, phases: [{ id: "work", session: "new" }],
	}));
	recordExperiment(await loadPack(dir), "twin");
	commitAll(dir);
	// graft run 5 of bare, p1 is filtered twice: excluded. prune run 3 of bare-b, p2 is empty: behaviour, every property at the bottom.
	const plan = (s: string, a: string, m: string, r: number): Plan => {
		if (s === "graft" && a === "bare" && m === "p1" && r === 5) return "filtered";
		if (s === "prune" && a === "bare-b" && m === "p2" && r === 3) return "empty";
		const k = `${s}|${a}|${m}|${r}`;
		return { graft1: pick(`${k}|g1`, 2), graft2: pick(`${k}|g2`, 3) === 0 ? 0 : 1, prune1: pick(`${k}|p1`, 3) };
	};
	const { dir: rd } = await conductRun(dir, { experiment: "twin", adapters: { opencode: scripted("opencode", plan), codex: scripted("codex", plan) }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r"), parallel: 1 });
	return { dir, rd };
}

/** Known outcomes, read from what each agent said in its cell record. */
function knownCells(rd: string, runs?: number) {
	const record = read<{ cells: string[] }>(rd, "run.json");
	const out: { scenario: string; arm: string; member: string; run: number; values: Record<string, number | null> }[] = [];
	for (const id of record.cells) {
		const c = read<CellRecord>(rd, `cells/${id}.json`);
		if (runs !== undefined && c.run > runs) continue;
		const last = c.attempts[c.attempts.length - 1]!;
		if (!last.validity.valid && last.validity.cause !== "behaviour") continue;
		const said = last.validity.valid ? last.outcome.final : "";
		const g1 = Number(/V:graft-1=(\d+)/.exec(said)?.[1] ?? 0), p1 = Number(/V:prune-1=(\d+)/.exec(said)?.[1] ?? 0);
		const g2 = last.validity.valid && said.split(/\s+/).filter(Boolean).length < 50 ? 1 : 0;
		out.push({ scenario: c.scenario, arm: c.arm, member: c.member, run: c.run, values: c.scenario === "graft" ? { "graft-1": g1, "graft-2": g2 } : { "prune-1": p1 / 2 } });
	}
	return out;
}

function independent(rd: string, runs?: number): { "3": number; "9": number; twoStageRate: number; drift: { actual: number; below: number; of: number } } & { refused?: string } {
	const hash = read<{ register: { hash: string } }>(rd, "run.json").register.hash;
	const input = { hash, base: "bare", head: "bare-b", population: ["p1", "p2"], properties: [{ scenario: "graft", id: "graft-1" }, { scenario: "graft", id: "graft-2" }, { scenario: "prune", id: "prune-1" }], cells: knownCells(rd, runs) };
	return JSON.parse(execFileSync("python3", [path.join(packageRoot, "test", "comparison", "derive_thresholds.py")], { input: JSON.stringify(input), encoding: "utf8" }));
}

test("F11: thresholds, the two-stage rate and the drift rank equal an independent implementation's; eleven present runs are refused", { timeout: 120000 }, async () => {
	const { dir, rd } = await aaRun();
	const loaded = await loadPack(dir);
	const cmp = loaded.pack.comparisons![0]!;
	// The fixture holds what it should: one excluded cell run, one at the bottom for behaviour.
	const known = knownCells(rd);
	assert.equal(known.length, 71);
	assert.equal(known.filter((c) => c.scenario === "graft" && c.member === "p1").length, 17);
	const set = deriveThresholds(readTable(rd), cmp, new Date("2026-10-12T00:00:00Z"));
	const ind = independent(rd);
	assert.equal(ind.refused, undefined);
	const close = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) < 1e-12, `${what}: core ${a}, independent ${b}`);
	close(set.thresholds["3"], ind["3"], "size-3 threshold");
	close(set.thresholds["9"], ind["9"], "size-9 threshold");
	close(set.twoStageRate, ind.twoStageRate, "two-stage rate");
	close(set.drift.actual, ind.drift.actual, "drift");
	assert.deepEqual([set.drift.below, set.drift.of], [ind.drift.below, ind.drift.of]);
	assert.ok(set.thresholds["3"] > 0 && set.thresholds["9"] > 0, "a degenerate fixture: thresholds of zero test nothing");
	assert.deepEqual([set.m, set.splits, set.run, set.pools["graft/p1"]], [3, 1000, read<{ run: string }>(rd, "run.json").run, 17]);
	// Recorded append-only, and read back.
	recordThresholds(loaded, set);
	assert.deepEqual(readThresholds(loaded, "twin-gate"), [set]);
	assert.throws(() => recordThresholds(loaded, set), /not earlier/);
	// Six runs per cell leave graft/p1 with eleven present runs: refused, by both implementations.
	assert.throws(() => deriveThresholds(readTable(rd, 6), cmp), /fewer than 12 present runs: graft\/p1 11/);
	assert.ok(independent(rd, 6).refused);
	// m must match the properties held.
	assert.throws(() => deriveThresholds(readTable(rd), { ...cmp, m: 16 }), /declares m = 16/);
});

// ---------------------------------------------------------------- F12

// The gate fixture: orchard, base arm bare and head arm almanac, members p1 (family f1) and p2 (f2),
// nine runs. Plans:
//   graft-1  base 1 always; head 1, but 0 at p2's run 7          -> a small drop, outside runs 1-3
//   graft-2  base 1 always; head 1 for p1, 0 for p2              -> a drop, in family f2 only
//   prune-1  base 2 always; head 0 always                        -> the largest drop
async function gateRun(edit?: (dir: string) => void, plan?: (s: string, a: string, m: string, r: number) => Plan, record = false) {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.runsPerCell = 9; });
	editJson(path.join(dir, "pack.json"), (j) => { j.comparisons = [
		{ id: "tol", experiment: "orchard", rule: "tolerance", base: "bare", head: "almanac", tolerance: 0.3 },
		{ id: "aa", experiment: "orchard", rule: "aa", base: "bare", head: "almanac", m: 3 },
		{ id: "imp", experiment: "orchard", rule: "improve", base: "bare", head: "almanac" },
	]; });
	edit?.(dir);
	if (record) recordExperiment(await loadPack(dir), "orchard");
	commitAll(dir);
	const p = plan ?? ((s: string, a: string, m: string, r: number): Plan => a === "bare" ? { graft1: 1, graft2: 1, prune1: 2 } : { graft1: m === "p2" && r === 7 ? 0 : 1, graft2: m === "p2" ? 0 : 1, prune1: 0 });
	const { dir: rd } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode", p), codex: scripted("codex", p) }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r"), parallel: 1 });
	return { dir, rd, loaded: await loadPack(dir) };
}
const rule = (l: Awaited<ReturnType<typeof loadPack>>, id: string): Comparison => l.pack.comparisons!.find((c) => c.id === id)!;
const hand = (t3: number, t9: number, m = 3): ThresholdSet => ({ comparison: "aa", experiment: "orchard", run: "fixture", hash: "h", m, splits: 1000, thresholds: { "3": t3, "9": t9 }, twoStageRate: 0, drift: { actual: 0, below: 0, of: 1000 }, pools: {}, recordedAt: "2026-10-12T00:00:00.000Z" });

test("F12: each rule flags exactly the properties its definition flags; persistence read at nine from a tally of runs 1 to 3", { timeout: 120000 }, async () => {
	const { rd, loaded } = await gateRun();
	const keys = (r: { flags: { property: string }[] }): string[] => r.flags.map((f) => f.property).sort();

	// Tolerance 0.3, rates as fractions of scale: graft-1 drops 1/18 = 0.056, graft-2 drops 0.5,
	// prune-1 drops 1. Flags graft-2 and prune-1.
	const tol = compare({ comparison: rule(loaded, "tol"), base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" } });
	assert.deepEqual(keys(tol), ["graft-2", "prune-1"]);
	assert.deepEqual(Object.keys(tol).sort(), ["exposed", "flags", "heldOut", "inputs", "limits", "rule"]);

	// A/A at runs 1-3, thresholds by hand T3 = 1, T9 = 4. n = 6 per arm (2 members x 3 runs).
	//   graft-1: no drop in runs 1-3 (p2's 0 is at run 7): d = 0, not flagged.
	//   graft-2: base 1, head 0.5, p = 0.75: d3 = 0.5 / sqrt(0.1875 * (1/6 + 1/6)) = 2.0 > 1, flagged;
	//            at nine, n = 18: d9 = 0.5 / sqrt(0.1875 * (2/18)) = 3.46 <= 4, not persisting.
	//   prune-1: base 1, head 0, p = 0.5: d3 = 1 / sqrt(0.25 / 3) = 3.46 > 1, flagged;
	//            d9 = 1 / sqrt(0.25 * (2/18)) = 6 > 4, persisting.
	const aa = compare({ comparison: rule(loaded, "aa"), base: { dir: rd, arm: "bare", runs: 3 }, head: { dir: rd, arm: "almanac", runs: 3 }, nine: { base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" } }, thresholds: hand(1, 4) });
	assert.deepEqual(aa.flags.map((f) => [f.property, Number(f.drop!.toFixed(4)), f.persisting]).sort(), [["graft-2", 2, false], ["prune-1", 3.4641, true]]);
	assert.deepEqual(aa.inputs.base, { run: read<{ run: string }>(rd, "run.json").run, arm: "bare", runs: 3 });
	// Without nine-run results, persistence is not evaluated, and the limits say so.
	const aa3 = compare({ comparison: rule(loaded, "aa"), base: { dir: rd, arm: "bare", runs: 3 }, head: { dir: rd, arm: "almanac", runs: 3 }, thresholds: hand(1, 4) });
	assert.ok(aa3.flags.every((f) => f.persisting === null));
	assert.ok(aa3.limits.some((l) => /persistence was not evaluated/.test(l)));
	// The tally restricted to runs 1 to 3 counts only those runs.
	const r3 = tallyRun(rd, { runs: 3 });
	assert.ok(Object.keys(r3.cellValues).every((c) => Number(c.split(".").pop()) <= 3) && Object.keys(r3.cellValues).length === 24);
	assert.equal(fs.readFileSync(path.join(rd, "RESULT.json"), "utf8").includes('"graft.bare.p1.9"'), true, "a restricted tally overwrote the run's result");

	// Improve without worsening, by family: graft-1 worse in f2 (8/9 against 1), graft-2 worse in f2,
	// prune-1 worse in both.
	const imp = compare({ comparison: rule(loaded, "imp"), base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" } });
	assert.deepEqual(imp.flags.map((f) => [f.property, f.families]).sort(), [["graft-1", ["f2"]], ["graft-2", ["f2"]], ["prune-1", ["f1", "f2"]]]);
});

test("F12: a property absent from the head, or with no mean there, counts as a drop under every rule", { timeout: 120000 }, async () => {
	// Every head cell run of prune is filtered twice: excluded, so prune-1 is absent from the head.
	// graft-1 in the head is judged by a judge whose replies never validate: no mean.
	const plan = (s: string, a: string): Plan => (a === "almanac" && s === "prune" ? "filtered" : { graft1: 1, graft2: 1, prune1: 2 });
	const { rd, loaded } = await gateRun(undefined, plan);
	// Make graft-1 incomplete in the head by removing its votes from the record, then re-tally.
	const votesFile = path.join(rd, "judging", "votes.json");
	const units = read<{ units: { id: string; arm: string; properties: string[] }[] }>(rd, "sealed/units.json").units;
	const headGraft = new Set(units.filter((u) => u.arm === "almanac" && u.properties.includes("graft-1")).map((u) => u.id));
	fs.writeFileSync(votesFile, JSON.stringify(read<{ unit: string; property: string }[]>(rd, "judging/votes.json").filter((v) => !(headGraft.has(v.unit) && v.property === "graft-1"))));
	tallyRun(rd);
	for (const id of ["tol", "aa", "imp"]) {
		const k = id === "aa" ? { runs: 3 } : {};
		const r = compare({ comparison: rule(loaded, id), base: { dir: rd, arm: "bare", ...k }, head: { dir: rd, arm: "almanac", ...k }, ...(id === "aa" ? { thresholds: hand(100, 100), nine: { base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" } } } : {}) });
		const f = Object.fromEntries(r.flags.map((x) => [x.property, x.reason]));
		// Absent at nine too, so under the A/A rule the drop persists.
		if (id === "aa") assert.deepEqual(r.flags.map((x) => [x.property, x.persisting]).sort(), [["graft-1", true], ["prune-1", true]]);
		assert.match(f["prune-1"] ?? "", /absent from the head/, `${id}: ${JSON.stringify(r.flags)}`);
		assert.match(f["graft-1"] ?? "", /no mean/, `${id}: ${JSON.stringify(r.flags)}`);
		assert.equal(f["graft-2"], undefined, `${id}: graft-2 did not drop`);
	}
});

test("F12: the comparator refuses inputs differing in scenarios, population, runs per cell or trap assignment, and thresholds of another m", { timeout: 180000 }, async () => {
	const a = await gateRun();
	const cmp = rule(a.loaded, "tol");
	const refuses = (head: string, why: RegExp, over: Partial<{ runs: number }> = {}) => assert.throws(() => compare({ comparison: cmp, base: { dir: a.rd, arm: "bare" }, head: { dir: head, arm: "almanac", ...over } }), why);
	// Two results of the same design compare.
	const b = await gateRun();
	assert.doesNotThrow(() => compare({ comparison: cmp, base: { dir: a.rd, arm: "bare" }, head: { dir: b.rd, arm: "almanac" } }));
	// Scenarios: a key changed.
	const s = await gateRun((d) => editJson(path.join(d, "scenarios", "graft.json"), (j) => { j.properties[0].key = "Another key."; }));
	refuses(s.rd, /differ in scenarios/);
	// Population.
	const p = await gateRun((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.factors.population = ["p1", "p3"]; }));
	refuses(p.rd, /differ in population/);
	// Runs per cell.
	const r = await gateRun((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.runsPerCell = 8; }));
	refuses(r.rd, /differ in runs per cell/);
	// Runs counted.
	refuses(b.rd, /differ in runs counted/, { runs: 3 });
	// Trap assignment: a copy of b whose cell records hold another assignment.
	const t = path.join(scratch(), "traps");
	fs.cpSync(b.rd, t, { recursive: true });
	const cellFile = path.join(t, "cells", "graft.almanac.p2.4.json");
	editJson(cellFile, (j) => { j.traps = [{ pair: "x", version: "b", position: "early", phase: "work", text: "t" }]; });
	refuses(t, /differ in trap assignment/);
	// Thresholds of another m.
	const three = { base: { dir: a.rd, arm: "bare", runs: 3 }, head: { dir: a.rd, arm: "almanac", runs: 3 } };
	assert.throws(() => compare({ comparison: rule(a.loaded, "aa"), ...three, thresholds: hand(1, 4, 16) }), /m is 16, but 3 properties are compared/);
	assert.throws(() => compare({ comparison: rule(a.loaded, "aa"), ...three }), /needs a threshold set/);
	assert.throws(() => compare({ comparison: rule(a.loaded, "aa"), ...three, thresholds: { ...hand(1, 4), experiment: "twin" } }), /threshold set is of experiment twin/);
});

// ---------------------------------------------------------------- F10, comparison clause

test("F10: a comparison reports held-out properties only in its held-out section, and lists exposures", { timeout: 120000 }, async () => {
	const { dir, rd } = await gateRun((d) => editJson(path.join(d, "scenarios", "prune.json"), (j) => { j.heldOut = true; }));
	const loaded = await loadPack(dir);
	recordExposure(loaded, "prune", "rev-9", new Date("2026-10-12T09:00:00Z"));
	const later = (await conductRun(dir, { experiment: "orchard", adapters: { opencode: scripted("opencode", (_s, a, m) => a === "bare" ? { graft1: 1, graft2: 1, prune1: 2 } : { graft1: 1, graft2: m === "p2" ? 0 : 1, prune1: 0 }), codex: scripted("codex", (_s, a, m) => a === "bare" ? { graft1: 1, graft2: 1, prune1: 2 } : { graft1: 1, graft2: m === "p2" ? 0 : 1, prune1: 0 }) }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r"), parallel: 1 })).dir;
	for (const id of ["tol", "aa", "imp"]) {
		const k = id === "aa" ? { runs: 3 } : {};
		const aaOpts = (base: string, head: string) => (id === "aa" ? { thresholds: hand(1, 4, 2), nine: { base: { dir: base, arm: "bare" }, head: { dir: head, arm: "almanac" } } } : {});
		const r = compare({ comparison: rule(loaded, id), base: { dir: rd, arm: "bare", ...k }, head: { dir: rd, arm: "almanac", ...k }, ...aaOpts(rd, rd) });
		assert.equal(r.flags.some((f) => f.scenario === "prune"), false, `${id}: a held-out property among the main flags`);
		assert.deepEqual(r.heldOut.properties, ["prune/prune-1"]);
		assert.deepEqual(r.heldOut.flags.map((f) => f.property), ["prune-1"], id);
		assert.deepEqual(r.exposed, [], "the earlier run lists an exposure recorded after it began");
		const r2 = compare({ comparison: rule(loaded, id), base: { dir: later, arm: "bare", ...k }, head: { dir: later, arm: "almanac", ...k }, ...aaOpts(later, later) });
		assert.deepEqual(r2.exposed.map((e) => [e.scenario, e.change]), [["prune", "rev-9"]]);
		// An exposure the head's run lists is listed, whichever side lists it.
		const r3 = compare({ comparison: rule(loaded, id), base: { dir: rd, arm: "bare", ...k }, head: { dir: later, arm: "almanac", ...k }, ...aaOpts(rd, later) });
		assert.deepEqual(r3.exposed.map((e) => [e.scenario, e.change]), [["prune", "rev-9"]]);
	}
});

test("the thresholds and compare commands record a threshold set and print a comparison", { timeout: 120000 }, async () => {
	const { dir, rd } = await aaRun();
	const cli = path.join(packageRoot, "dist", "src", "cli.js");
	const set = JSON.parse(execFileSync(process.execPath, [cli, "thresholds", dir, "twin-gate", rd], { encoding: "utf8" })) as ThresholdSet;
	assert.equal(readThresholds(await loadPack(dir), "twin-gate").length, 1);
	const out = path.join(scratch(), "c.json");
	const r = JSON.parse(execFileSync(process.execPath, [cli, "compare", dir, "twin-gate", rd, "--runs", "3", "--nine", rd, "--out", out], { encoding: "utf8" }));
	assert.deepEqual(r.inputs.thresholds["3"], set.thresholds["3"]);
	assert.equal(r.inputs.base.runs, 3);
	assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), r);
});

test("the standardised drop, by hand: unequal sets, equal sets, and the cases defined as 0", () => {
	// a = 1, 1, 0 (mean 2/3), b = 1, 0 (mean 1/2); p = 3/5; d = (1/6) / sqrt(0.24 * (1/3 + 1/2)) = (1/6) / sqrt(0.2) = 0.37268.
	assert.equal(standardisedDrop([1, 1, 0], [1, 0]).toFixed(5), "0.37268");
	// Equal sets of n = 4: section 1's (rateA - rateB) / sqrt(2 p (1 - p) / n) = 0.5 / sqrt(2 * 0.25 / 4) = 1.41421.
	assert.equal(standardisedDrop([1, 1, 1, 0], [1, 0, 0, 0]).toFixed(5), "1.41421");
	assert.equal(standardisedDrop([1, 1], [1, 1]), 0);
	assert.equal(standardisedDrop([0, 0], [0]), 0);
	assert.equal(standardisedDrop([], [1]), 0);
	assert.equal(standardisedDrop([0, 1], [1, 1]).toFixed(5), (-0.5 / Math.sqrt(0.75 * 0.25 * 1)).toFixed(5), "a rise is a negative drop");
});

test("F11: on continuous values, with incomplete values and a missing run, the deriver equals the independent implementation", () => {
	// A table built directly: three members, two scenarios, three properties, values in tenths,
	// about one value in twenty incomplete, and one cell run absent. Distinct largest drops, so the
	// 900th of 1000 differs from its neighbours and the percentile is pinned.
	const props = [{ scenario: "s1", id: "x" }, { scenario: "s1", id: "y" }, { scenario: "s2", id: "z" }];
	const cells: { cell: string; scenario: string; arm: string; member: string; run: number; traps: unknown; values: Record<string, number | null> }[] = [];
	for (const sc of ["s1", "s2"]) for (const arm of ["A", "B"]) for (const m of ["m1", "m2", "m3"]) for (let r = 1; r <= 9; r++) {
		if (sc === "s2" && arm === "A" && m === "m2" && r === 4) continue;
		const values: Record<string, number | null> = {};
		for (const p of props.filter((x) => x.scenario === sc)) values[p.id] = pick(`${sc}${arm}${m}${r}${p.id}!`, 20) === 0 ? null : pick(`${sc}|${arm}|${m}|${r}|${p.id}`, 11) / 10;
		cells.push({ cell: `${sc}.${arm}.${m}.${r}`, scenario: sc, arm, member: m, run: r, traps: [], values });
	}
	const property = (id: string) => ({ id, type: "adherence" as const, decidedBy: "judge" as const, key: "k", scale: [0, 1] as [number, number] });
	const table = {
		dir: "", result: {} as never, keys: new Map(), cells,
		properties: props.map((p) => ({ scenario: p.scenario, id: p.id, property: property(p.id), heldOut: false })),
		record: { run: "fixture", experiment: "e", runsPerCell: 9, register: { experiment: "e", hash: "continuous-fixture-hash", recordedAt: "", declaredStatus: "result" }, population: ["m3", "m1", "m2"], snapshot: { arms: ["A", "B"] } } as never,
	};
	const set = deriveThresholds(table, { id: "g", experiment: "e", rule: "aa", base: "A", head: "B" });
	const ind = JSON.parse(execFileSync("python3", [path.join(packageRoot, "test", "comparison", "derive_thresholds.py")], {
		input: JSON.stringify({ hash: "continuous-fixture-hash", base: "A", head: "B", population: ["m1", "m2", "m3"], properties: props, cells }), encoding: "utf8",
	}));
	for (const [a, b, what] of [[set.thresholds["3"], ind["3"], "size 3"], [set.thresholds["9"], ind["9"], "size 9"], [set.twoStageRate, ind.twoStageRate, "two-stage"], [set.drift.actual, ind.drift.actual, "drift"]] as const) {
		assert.ok(Math.abs(a - b) < 1e-12, `${what}: core ${a}, independent ${b}`);
	}
	assert.equal(set.drift.below, ind.drift.below);
	assert.equal(set.pools["s2/m2"], 17);
	assert.ok(set.twoStageRate > 0 && set.twoStageRate < 0.1, `the two-stage rate ${set.twoStageRate} should sit below one in ten`);
});

test("F12: boundaries - a drop equal to its threshold or tolerance does not flag", { timeout: 120000 }, async () => {
	const { rd, loaded } = await gateRun();
	const nine = { base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" } };
	const first = compare({ comparison: rule(loaded, "aa"), base: { dir: rd, arm: "bare", runs: 3 }, head: { dir: rd, arm: "almanac", runs: 3 }, nine, thresholds: hand(1, 4) });
	const g2 = first.flags.find((f) => f.property === "graft-2")!.drop!;
	const at = compare({ comparison: rule(loaded, "aa"), base: { dir: rd, arm: "bare", runs: 3 }, head: { dir: rd, arm: "almanac", runs: 3 }, nine, thresholds: hand(g2, 4) });
	assert.equal(at.flags.some((f) => f.property === "graft-2"), false, "a drop equal to the size-3 threshold flagged");
	// graft-2's rate falls by exactly 0.5: a tolerance of 0.5 does not flag it.
	const tol = compare({ comparison: { ...rule(loaded, "tol"), tolerance: 0.5 }, base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" } });
	assert.deepEqual(tol.flags.map((f) => f.property), ["prune-1"]);
	// The A/A rule reads three runs, then nine.
	assert.throws(() => compare({ comparison: rule(loaded, "aa"), base: { dir: rd, arm: "bare" }, head: { dir: rd, arm: "almanac" }, thresholds: hand(1, 4) }), /first stage reads 3 runs per cell, not 9/);
	assert.throws(() => compare({ comparison: rule(loaded, "aa"), base: { dir: rd, arm: "bare", runs: 3 }, head: { dir: rd, arm: "almanac", runs: 3 }, nine: { base: { dir: rd, arm: "bare", runs: 3 }, head: { dir: rd, arm: "almanac", runs: 3 } }, thresholds: hand(1, 4) }), /persistence at 9/);
});

test("F12: a member declared differently is a different population; nine-run inputs of other scenarios are refused", { timeout: 120000 }, async () => {
	const a = await gateRun();
	const m = await gateRun((d) => editJson(path.join(d, "pack.json"), (j) => { j.population[1].model = "m2-next"; }));
	assert.throws(() => compare({ comparison: rule(a.loaded, "tol"), base: { dir: a.rd, arm: "bare" }, head: { dir: m.rd, arm: "almanac" } }), /differ in population/);
	const s = await gateRun((d) => editJson(path.join(d, "scenarios", "graft.json"), (j) => { j.properties[0].key = "Another key."; }));
	assert.throws(() => compare({ comparison: rule(a.loaded, "aa"), base: { dir: a.rd, arm: "bare", runs: 3 }, head: { dir: a.rd, arm: "almanac", runs: 3 }, nine: { base: { dir: s.rd, arm: "bare" }, head: { dir: s.rd, arm: "almanac" } }, thresholds: hand(1, 4) }), /differ in scenarios/);
});

test("F11: the deriver refuses a scenario with no present runs, leaves held-out properties out, and takes nine runs per cell", () => {
	const props = [{ scenario: "s1", id: "x" }, { scenario: "s2", id: "z" }];
	const property = (id: string) => ({ id, type: "adherence" as const, decidedBy: "judge" as const, key: "k", scale: [0, 1] as [number, number] });
	const build = (cells: { scenario: string; arm: string; member: string; run: number; values: Record<string, number | null> }[], heldOut: string[] = [], runsPerCell = 9) => ({
		dir: "", result: {} as never, keys: new Map(), cells: cells.map((c) => ({ ...c, cell: `${c.scenario}.${c.arm}.${c.member}.${c.run}`, traps: [] })),
		properties: props.map((p) => ({ scenario: p.scenario, id: p.id, property: property(p.id), heldOut: heldOut.includes(p.scenario) })),
		record: { run: "f", experiment: "e", runsPerCell, register: { experiment: "e", hash: "h2", recordedAt: "", declaredStatus: "result" }, population: ["m1"], snapshot: { arms: ["A", "B"] } } as never,
	});
	const cells = (sc: string[]) => sc.flatMap((s) => ["A", "B"].flatMap((arm) => Array.from({ length: 9 }, (_, i) => ({ scenario: s, arm, member: "m1", run: i + 1, values: { [s === "s1" ? "x" : "z"]: pick(`${s}${arm}${i}`, 11) / 10 } }))));
	const g = { id: "g", experiment: "e", rule: "aa" as const, base: "A", head: "B" };
	assert.throws(() => deriveThresholds(build(cells(["s1"])), g), /s2\/m1 0/);
	// s2 held out: the deriver takes x alone, and equals the independent implementation on x alone.
	const t = build(cells(["s1", "s2"]), ["s2"]);
	const set = deriveThresholds(t, g);
	assert.equal(set.m, 1);
	const ind = JSON.parse(execFileSync("python3", [path.join(packageRoot, "test", "comparison", "derive_thresholds.py")], {
		input: JSON.stringify({ hash: "h2", base: "A", head: "B", population: ["m1"], properties: [props[0]], cells: t.cells.filter((c) => c.scenario === "s1") }), encoding: "utf8",
	}));
	assert.ok(Math.abs(set.thresholds["3"] - ind["3"]) < 1e-12 && Math.abs(set.thresholds["9"] - ind["9"]) < 1e-12);
	assert.throws(() => deriveThresholds(build(cells(["s1", "s2"]), [], 8), g), /8 runs per cell; the deriver takes an A\/A run at nine/);
});

test("thresholds are derived only from a comparison whose arms deliver the same things", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => {
		j.arms.push({ id: "bare-b", deliver: [] });
		j.isolation.leakProbes[0].arms.push("bare-b");
		j.comparisons = [{ id: "same", experiment: "orchard", rule: "aa", base: "bare", head: "bare-b" }, { id: "diff", experiment: "orchard", rule: "aa", base: "bare", head: "almanac" }];
	});
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.factors.arms.push("bare-b"); });
	const l = await loadPack(dir);
	assert.doesNotThrow(() => assertIdenticalArms(l, l.pack.comparisons![0]!));
	assert.throws(() => assertIdenticalArms(l, l.pack.comparisons![1]!), /deliver different things/);
});

test("--revision and a variant's own revision pin what a run delivers; the variant's wins", { timeout: 120000 }, async () => {
	assert.deepEqual(runFlags(["node", "cli", "run", "pack", "suite", "--revision", "abc123", "--runs", "3", "--parallel", "2"]), { runsPerCell: 3, parallel: 2, revision: "abc123" });
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.factors.arms = ["almanac"]; j.factors.population = ["p1"]; j.runsPerCell = 1; j.scenarios = ["scenarios/prune.json"]; });
	const first = commitAll(dir, "revision A");
	fs.appendFileSync(path.join(dir, "source", "GUIDE.md"), "REVISION-B-MARKER\n");
	const second = commitAll(dir, "revision B");
	const sha = (rev: string): string => execFileSync("git", ["rev-parse", rev], { cwd: dir, encoding: "utf8" }).trim();
	const seen: string[] = [];
	const agent = scripted("opencode", () => ({ graft1: 1, graft2: 1, prune1: 2 }));
	const watching: Adapter = { ...agent, async invoke(inv) { if (inv.tools === "on" && inv.prompt !== CANARY_QUESTION) seen.push(inv.arm.instructions.map((f) => fs.readFileSync(f.path, "utf8")).join("")); return agent.invoke(inv); } };
	const go = async (revision?: string) => {
		seen.length = 0;
		const { dir: rd } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: watching }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r"), ...(revision !== undefined ? { revision } : {}) });
		return { rev: read<{ variants: Record<string, { revision: string }> }>(rd, "run.json").variants["almanac-full"]!.revision, delivered: seen.join("") };
	};
	const head = await go();
	assert.equal(head.rev, sha(second));
	assert.ok(head.delivered.includes("REVISION-B-MARKER"));
	const pinned = await go(first);
	assert.equal(pinned.rev, sha(first));
	assert.equal(pinned.delivered.includes("REVISION-B-MARKER"), false);
	editJson(path.join(dir, "pack.json"), (j) => { j.variants[0].revision = first; });
	const own = await go(second);
	assert.equal(own.rev, sha(first), "the run's revision overrode the variant's own");
	assert.equal(own.delivered.includes("REVISION-B-MARKER"), false);
});

test("the runs counted are those the record holds; the thresholds command checks the arms, as they were at the run", { timeout: 180000 }, async () => {
	const two = await gateRun((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.runsPerCell = 2; }));
	assert.throws(() => compare({ comparison: rule(two.loaded, "aa"), base: { dir: two.rd, arm: "bare", runs: 3 }, head: { dir: two.rd, arm: "almanac", runs: 3 }, thresholds: hand(1, 4) }), /reads 3 runs per cell, not 2/);
	const cli = path.join(packageRoot, "dist", "src", "cli.js");
	const { spawnSync } = await import("node:child_process");
	// gateRun's aa comparison is bare against almanac: not identical.
	const g = await gateRun(undefined, undefined, true);
	const diff = spawnSync(process.execPath, [cli, "thresholds", g.dir, "aa", g.rd], { encoding: "utf8" });
	assert.notEqual(diff.status, 0);
	assert.match(diff.stderr, /deliver different things/);
	// The twin run is identical-armed; once its experiment changes after the run, it is refused.
	const { dir, rd } = await aaRun();
	editJson(path.join(dir, "experiments", "twin.json"), (j) => { j.notes = "changed after the run"; });
	const changed = spawnSync(process.execPath, [cli, "thresholds", dir, "twin-gate", rd], { encoding: "utf8" });
	assert.notEqual(changed.status, 0);
	assert.match(changed.stderr, /has changed since run/);
});

test("the run record holds each member's route, and the comparator refuses two runs whose routes differ", { timeout: 120000 }, async () => {
	// p3 judges and is no agent, so agents' routes and judges' routes are each recorded on their own path.
	const a = await gateRun((d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.judging = { judges: ["p3"] }; }));
	const routes = read<{ routes: Record<string, unknown> }>(a.rd, "run.json").routes;
	assert.deepEqual(routes, { p1: { runtime: "opencode", model: "m1" }, p2: { runtime: "codex", model: "m2" }, p3: { runtime: "opencode", model: "m3" } });
	const b = path.join(scratch(), "other-route");
	fs.cpSync(a.rd, b, { recursive: true });
	assert.doesNotThrow(() => compare({ comparison: rule(a.loaded, "tol"), base: { dir: a.rd, arm: "bare" }, head: { dir: b, arm: "almanac" } }));
	editJson(path.join(b, "run.json"), (j) => { j.routes.p1 = { runtime: "opencode", model: "m1", npm: "@ai-sdk/openai-compatible" }; });
	assert.throws(() => compare({ comparison: rule(a.loaded, "tol"), base: { dir: a.rd, arm: "bare" }, head: { dir: b, arm: "almanac" } }), /differ in routes to the models/);
});
