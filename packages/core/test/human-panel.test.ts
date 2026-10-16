// Delta-3 stage 1: pair chooser and human panel (criteria G1, G2, G3).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
	CANARY_QUESTION, chooseCalibrationPairs, choosePreferencePairs, conductRun, flipFor, pickRun,
	readLegacyHumanRun, runHumanPanel, tallyHumanPicks, tallyRun,
	type Adapter, type Invocation, type Outcome, type Scenario, type Unit, type Vote,
} from "../src/index.js";
import { commitAll, copyPack, editJson, scratch } from "./helpers.js";

function outcome(final: string): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null" };
}

test("G1: chooseCalibrationPairs pairs only within scenario/arm/phase/property with differing means, orders high (>= midpoint) ahead of low, flips by seed, and repeats identically; choosePreferencePairs flips by seed", () => {
	const s1: Scenario = {
		id: "s1", tags: [], fixture: null, task: "t",
		properties: [{ id: "p1", type: "comprehension", decidedBy: "judge", key: "k", scale: [0, 2] }],
	};
	const s2: Scenario = {
		id: "s2", tags: [], fixture: null, task: "t",
		properties: [{ id: "p2", type: "comprehension", decidedBy: "judge", key: "k", scale: [0, 2] }],
	};
	const scenarios = new Map<string, Scenario>([["s1", s1], ["s2", s2]]);
	const units: Unit[] = [
		// s1, armA: u0001 (mean 0.0), u0002 (mean 0.5), u0003 (mean 1.0 -> high, exact midpoint 1.0)
		{ id: "u0001", cell: "s1.armA.p1.1", scenario: "s1", arm: "armA", member: "p1", family: "f1", phase: "work", properties: ["p1"], text: "TEXT-1", blindedAt: "" },
		{ id: "u0002", cell: "s1.armA.p2.1", scenario: "s1", arm: "armA", member: "p2", family: "f2", phase: "work", properties: ["p1"], text: "TEXT-2", blindedAt: "" },
		{ id: "u0003", cell: "s1.armA.p3.1", scenario: "s1", arm: "armA", member: "p3", family: "f3", phase: "work", properties: ["p1"], text: "TEXT-3", blindedAt: "" },
		// s1, armB: u0004 (mean 1.5) - different arm, must never pair with armA units
		{ id: "u0004", cell: "s1.armB.p1.1", scenario: "s1", arm: "armB", member: "p1", family: "f1", phase: "work", properties: ["p1"], text: "TEXT-4", blindedAt: "" },
		// s2, armA: u0005 (mean 2.0), u0006 (mean 2.0) - equal means, must not pair
		{ id: "u0005", cell: "s2.armA.p1.1", scenario: "s2", arm: "armA", member: "p1", family: "f1", phase: "work", properties: ["p2"], text: "TEXT-5", blindedAt: "" },
		{ id: "u0006", cell: "s2.armA.p2.1", scenario: "s2", arm: "armA", member: "p2", family: "f2", phase: "work", properties: ["p2"], text: "TEXT-6", blindedAt: "" },
	];
	const meanMap: Record<string, number> = { u0001: 0, u0002: 0.5, u0003: 1.0, u0004: 1.5, u0005: 2.0, u0006: 2.0 };
	const votes: Vote[] = units.flatMap((u) => [
		{ unit: u.id, property: u.properties[0]!, judge: "j1", family: "jf1", value: meanMap[u.id]!, reason: "r", guess: null, prompt: "p" },
		{ unit: u.id, property: u.properties[0]!, judge: "j2", family: "jf2", value: meanMap[u.id]!, reason: "r", guess: null, prompt: "p" },
	]);
	const pairs1 = chooseCalibrationPairs({ units, votes, scenarios, assigned: () => ["j1", "j2"], seed: "seed-alpha", count: 8 });
	const pairs2 = chooseCalibrationPairs({ units, votes, scenarios, assigned: () => ["j1", "j2"], seed: "seed-alpha", count: 8 });
	assert.deepEqual(pairs1, pairs2, "calibration pairs must repeat identically for the same seed");
	// Only s1/armA has differing pairs: (u0001,u0002) with max=0.5 < 1.0 (low), (u0001,u0003) with max=1.0 >= 1.0 (high), (u0002,u0003) with max=1.0 >= 1.0 (high).
	// Also check count=2 across seeds so that if max=1.0 fell into the low partition, some seed would put the 0.5 pair in the top 2.
	for (const sd of ["s-1", "s-2", "s-3", "s-4", "s-5"]) {
		const top2 = chooseCalibrationPairs({ units, votes, scenarios, assigned: () => ["j1", "j2"], seed: sd, count: 2 });
		assert.ok(top2.every((p) => Math.max(p.meanA, p.meanB) === 1.0), `seed ${sd}: exact-midpoint pair was not kept in high partition`);
	}
	assert.equal(pairs1.length, 3);
	for (const p of pairs1) {
		assert.equal(p.scenario, "s1");
		assert.equal(p.arm, "armA");
		assert.notEqual(p.meanA, p.meanB);
		const rawIds = p.id.split(":").slice(1);
		const expectedShownA = flipFor("seed-alpha", p.id) ? rawIds[1]! : rawIds[0]!;
		assert.equal(p.shownA, expectedShownA);
		assert.equal(p.higher, p.meanA > p.meanB ? "a" : "b");
	}
	// First two pairs must be the high ones (max >= 1.0), third must be the low one (max = 0.5 < 1.0).
	assert.equal(Math.max(pairs1[0]!.meanA, pairs1[0]!.meanB) >= 1.0, true);
	assert.equal(Math.max(pairs1[1]!.meanA, pairs1[1]!.meanB) >= 1.0, true);
	assert.equal(Math.max(pairs1[2]!.meanA, pairs1[2]!.meanB), 0.5);

	// Preference mode: shownA equals flipFor(seed, item.id), computed directly from sha256.
	assert.equal(flipFor("66f8fb2b0e54", "s1"), false); // sha256("66f8fb2b0e54:s1") starts with 98 (152, even)
	assert.equal(flipFor("66f8fb2b0e54", "s3"), true);  // sha256("66f8fb2b0e54:s3") starts with odd byte
	const prefItems = [
		{ id: "s1", move: "m1", scenario: "sc1", with: "WITH-1", without: "WITHOUT-1" },
		{ id: "s3", move: "m1", scenario: "sc2", with: "WITH-2", without: "WITHOUT-2" },
		{ id: "s6", move: "m2", scenario: "sc3", with: "WITH-3", without: "WITHOUT-3" },
	];
	const prefPairs = choosePreferencePairs(prefItems, "66f8fb2b0e54");
	assert.deepEqual(prefPairs.map((p) => p.shownA), ["without", "with", "without"]);
	for (const [idx, pp] of prefPairs.entries()) {
		const flip = pp.shownA === "with";
		assert.equal(pp.textA, flip ? prefItems[idx]!.with : prefItems[idx]!.without);
		assert.equal(pp.textB, flip ? prefItems[idx]!.without : prefItems[idx]!.with);
	}
});

test("G2: runHumanPanel and pickRun handle invalid lines, fault tags, early EOF, blind stdout, and tally agreement + <0.75 warning", async () => {
	// 1. Early EOF on preference pairs keeps partial picks and sets complete: false.
	const prefPairs = choosePreferencePairs([
		{ id: "i1", move: "m1", scenario: "sc1", with: "MSG-WITH-1", without: "MSG-WITHOUT-1" },
		{ id: "i2", move: "m1", scenario: "sc2", with: "MSG-WITH-2", without: "MSG-WITHOUT-2" },
		{ id: "i3", move: "m2", scenario: "sc3", with: "MSG-WITH-3", without: "MSG-WITHOUT-3" },
	], "seed-1");
	// Answer i1 with whatever side is "with" and tag "2" (too long), i2 with whatever side is "without" and tag "1" (must NOT count in tags), then EOF before i3.
	const pickWith1 = prefPairs[0]!.shownA === "with" ? "a" : "b";
	const pickWithout2 = prefPairs[1]!.shownA === "with" ? "b" : "a";
	let outBuf = "";
	const partial = await runHumanPanel({
		pairs: prefPairs,
		seed: "seed-1",
		input: Readable.from([`${pickWith1}\n2\n${pickWithout2}\n1\n`]),
		output: { write: (s: string) => { outBuf += s; return true; } },
	});
	assert.equal(partial.complete, false);
	assert.equal(partial.answers.length, 2);
	assert.equal(partial.answers[0]!.chose, "with");
	assert.equal(partial.answers[0]!.tag, "too long");
	assert.equal(partial.answers[1]!.chose, "without");
	assert.equal(partial.answers[1]!.tag, "point buried");
	const tPartial = tallyHumanPicks(partial);
	assert.deepEqual(tPartial.byMove["m1"], { with: 1, without: 1, same: 0, tags: { "too long": 1 } });
	assert.deepEqual(tPartial.totals, { with: 1, without: 1, same: 0 });

	// 2. Full calibration run through pickRun on a judged run record, with invalid input retried,
	//    and agreement 1 of 2 (50% < 75%) triggering the RESULT.md limit warning.
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => {
		j.runsPerCell = 1;
		j.scenarios = ["scenarios/prune.json"];
	});
	commitAll(dir);
	// Make p1 score 2 and p2 score 0 on prune-1 so their judge means differ within each arm.
	const adapter = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && inv.prompt.includes("=== OUTCOME")) {
				const blocks = inv.prompt.split(/^=== OUTCOME /m).slice(1);
				return outcome(JSON.stringify({
					outcomes: blocks.map((b) => {
						const id = /^(o\d+)/.exec(b)![1]!;
						const v = b.includes("HIGH-OUTCOME") ? 2 : 0;
						return { id, scores: { "prune-1": { v, reason: "r" } }, guess: "bare" };
					}),
				}));
			}
			if (inv.tools === "off") return outcome("I do not know.");
			return outcome(inv.member.id === "p1" ? "HIGH-OUTCOME" : "LOW-OUTCOME");
		},
	});
	const work = path.join(scratch(), "w"), records = path.join(scratch(), "r");
	const { dir: rd, record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: adapter("opencode"), codex: adapter("codex") }, work, records, parallel: 1 });
	// Two arms (bare, almanac) -> 2 calibration pairs.
	// Inspect the pairs chooseCalibrationPairs produces for this run so we can pick higher on pair 1 and lower on pair 2 (1/2 = 50% < 75%).
	const units = (JSON.parse(fs.readFileSync(path.join(rd, "sealed", "units.json"), "utf8")) as { units: Unit[] }).units;
	const votes = JSON.parse(fs.readFileSync(path.join(rd, "judging", "votes.json"), "utf8")) as Vote[];
	const scMap = new Map(record.snapshot.scenarios.map((s) => [s.id, s]));
	const calPairs = chooseCalibrationPairs({ units, votes, scenarios: scMap, assigned: (u) => record.judges.filter((j) => j !== u.member), seed: record.seed });
	assert.equal(calPairs.length, 2);
	const pick1 = calPairs[0]!.higher;
	const pick2 = calPairs[1]!.higher === "a" ? "b" : "a";
	let panelOut = "";
	const { picks, result } = await pickRun(rd, {
		mode: "calibration",
		input: Readable.from([`invalid\n${pick1}\n1\n${pick2}\n\n`]),
		output: { write: (s: string) => { panelOut += s; return true; } },
	});
	assert.equal(picks.complete, true);
	assert.match(panelOut, /please type one of: a b =/);
	// Blind stdout: neither arm names ("almanac", "bare") nor member ids ("p1", "p2") nor scores appear.
	assert.equal(panelOut.includes("almanac") || panelOut.includes("bare"), false, "arm name leaked to human panel stdout");
	assert.deepEqual(result.humanPicks?.agreement, { agree: 1, of: 2, rate: 0.5 });
	const updatedRun = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf8"));
	assert.ok(updatedRun.states.some((s: { state: string }) => s.state === "picked"));
	const md = fs.readFileSync(path.join(rd, "RESULT.md"), "utf8");
	assert.match(md, /Judge-person calibration agreement is 50%, below the 75% threshold/);
	assert.match(md, /Calibration agreement \(complete\): 1 of 2 \(50%\)\./);
	// Re-tallying from files alone reproduces the result.
	const retallied = tallyRun(rd);
	assert.deepEqual(retallied.humanPicks, result.humanPicks);
	// When agreement is >= 0.75 (both pairs chosen higher -> 2/2 = 100%), no warning appears in RESULT.md.
	await pickRun(rd, {
		mode: "calibration",
		input: Readable.from([`${calPairs[0]!.higher}\n\n${calPairs[1]!.higher}\n\n`]),
		output: { write: () => true },
	});
	const mdHigh = fs.readFileSync(path.join(rd, "RESULT.md"), "utf8");
	assert.equal(mdHigh.includes("below the 75% threshold"), false);
	// Tie picks ("=") are excluded from calibration agreement denominator.
	const calWithTie = tallyHumanPicks({
		mode: "calibration", seed: "s", created: "", complete: true,
		answers: [
			{ id: "p1", scenario: "s", property: "p", shownA: "u1", pick: "a", chose: "u1", choseHigher: true, tag: null },
			{ id: "p2", scenario: "s", property: "p", shownA: "u2", pick: "=", chose: "same", choseHigher: null, tag: null },
		],
	});
	assert.deepEqual(calWithTie.agreement, { agree: 1, of: 1, rate: 1 });
});

test("G3: readLegacyHumanRun and tallyHumanPicks reproduce mission-kit's delta2-check human preference run", () => {
	// Verbatim record of mission-kit's delta2-check-2026-10-03-66f8fb/result.json (kept inline so
	// the core test suite depends on no external repository path, per E7).
	const delta2Check = {
		suite: "delta2-check",
		seed: "66f8fb2b0e54",
		created: "2026-10-03T10:11:39.991262+00:00",
		complete: true,
		delivered: "in chat, rendered markdown, one pair per turn, messages as written",
		answers: [
			{ item: "s1", move: "landed-guidance-bad-news", shownA: "without", pick: "b" as const, chose: "with", tag: null },
			{ item: "s2", move: "landed-guidance-a-status-update", shownA: "without", pick: "b" as const, chose: "with", tag: null },
			{ item: "s3", move: "landed-guidance-an-explanation-the-director-asked-for", shownA: "with", pick: "a" as const, chose: "with", tag: null },
			{ item: "s4", move: "landed-guidance-teaching-a-concept", shownA: "without", pick: "b" as const, chose: "with", tag: null },
			{ item: "s5", move: "landed-guidance-a-single-decision", shownA: "without", pick: "b" as const, chose: "with", tag: null },
			{ item: "s6", move: "landed-guidance-two-linked-decisions", shownA: "without", pick: "b" as const, chose: "with", tag: null },
		],
	};
	const converted = readLegacyHumanRun(delta2Check);
	const tallied = tallyHumanPicks(converted);
	assert.equal(tallied.mode, "preference");
	assert.equal(tallied.complete, true);
	assert.deepEqual(tallied.totals, { with: 6, without: 0, same: 0 });
	assert.equal(Object.keys(tallied.byMove).length, 6);
	for (const move of Object.keys(tallied.byMove)) {
		assert.deepEqual(tallied.byMove[move], { with: 1, without: 0, same: 0, tags: {} });
	}
});
