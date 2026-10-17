// Delta-4 stage 2 (M4.2, M4.3, B5, B7, criteria H2, H3): provider fault characterisation
// (`faultProfile`, `Result.faults`, `docs/probes/2026-10-17-provider-faults.json`) and
// per-scenario / per-property arm-guess blinding (`Result.guesses.byScenario` and `byProperty`,
// `notBlind`, and `RESULT.md` limit warning).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	FAULT_KINDS, classifyFaultKind, faultProfile, resultMarkdown, tally, tallyRun,
	type Attempt, type CellRecord, type Outcome, type Scenario, type Unit, type Vote,
} from "../src/index.js";
import { packageRoot, scratch } from "./helpers.js";

function baseOutcome(over: Partial<Outcome> = {}): Outcome {
	return {
		final: "done", exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" },
		cost: { seconds: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, toolCalls: 0 },
		tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null",
		...over,
	};
}

test("H2: classifyFaultKind and faultProfile classify all 10 fault kinds, inspect the first invalid phase in multi-phase episodes, and match docs/probes/2026-10-17-provider-faults.json", () => {
	// 1. Valid attempt returns null.
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: true }, outcome: baseOutcome(), diff: "" }), null);

	// 2. Isolation takes precedence even if outcome also carries a 500 provider error.
	const isoAttempt: Attempt = {
		attempt: 1,
		validity: { valid: false, cause: "isolation", detail: "read forbidden" },
		outcome: baseOutcome({ error: { cause: "provider", name: "APIError", message: "500 Internal Server Error" } }),
		diff: null,
	};
	assert.equal(classifyFaultKind(isoAttempt), "isolation");

	// 3. Multi-phase episode where phase 1 failed for behaviour (empty) and phase 2 on another branch ran validly:
	//    top-level a.outcome is phase 2's valid outcome, so classifyFaultKind must inspect the first invalid phase in a.phases.
	const multiPhaseAttempt: Attempt = {
		attempt: 1,
		validity: { valid: false, cause: "behaviour", detail: "ended with no message" },
		outcome: baseOutcome({ final: "Branch 2 succeeded." }),
		diff: "",
		phases: [
			{
				phase: "p1", session: "new", after: null, status: "run", prompt: "", note: null, noteSource: null,
				workspace: "", invocation: "", copiedTree: null, startTree: "", startDiff: "", endTree: "", snapshot: "", endDiff: "",
				outcome: baseOutcome({ final: "" }),
				validity: { valid: false, cause: "behaviour", detail: "ended with no message" },
				diff: "", traps: [],
			},
			{
				phase: "p2", session: "new", after: null, status: "run", prompt: "", note: null, noteSource: null,
				workspace: "", invocation: "", copiedTree: null, startTree: "", startDiff: "", endTree: "", snapshot: "", endDiff: "",
				outcome: baseOutcome({ final: "Branch 2 succeeded." }),
				validity: { valid: true },
				diff: "", traps: [],
			},
		],
	};
	assert.equal(classifyFaultKind(multiPhaseAttempt), "empty");

	// 4. All remaining kinds: filter, rate-limit, provider-5xx, provider-other, timeout-model, timeout-tool, overflow, crash.
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "f" }, outcome: baseOutcome({ filtered: true }), diff: null }), "filter");
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "r" }, outcome: baseOutcome({ error: { cause: "provider", name: "E", message: "HTTP 429 Too Many Requests" } }), diff: null }), "rate-limit");
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "5" }, outcome: baseOutcome({ error: { cause: "provider", name: "E", message: "503 Service Unavailable" } }), diff: null }), "provider-5xx");
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "o" }, outcome: baseOutcome({ error: { cause: "provider", name: "E", message: "400 missing thought_signature" } }), diff: null }), "provider-other");
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "tm" }, outcome: baseOutcome({ stop: { reason: "timeout", inFlight: "unknown" } }), diff: null }), "timeout-model");
	assert.equal(classifyFaultKind({ attempt: 2, validity: { valid: false, cause: "behaviour", detail: "tt" }, outcome: baseOutcome({ stop: { reason: "timeout", inFlight: "unknown" } }), diff: null }), "timeout-tool");
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "behaviour", detail: "ov" }, outcome: baseOutcome({ error: { cause: "overflow", name: "E", message: "maximum context" } }), diff: null }), "overflow");
	assert.equal(classifyFaultKind({ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "cr" }, outcome: baseOutcome({ exit: 2 }), diff: null }), "crash");

	// 5. faultProfile aggregates attempts, retriedCells (including attempt 1 that succeeded on attempt 2), and excludedCells.
	const cells: Pick<CellRecord, "cell" | "arm" | "member" | "valid" | "attempts">[] = [
		// Cell 1: attempt 1 failed with rate-limit, attempt 2 succeeded -> retriedCells: 1, excludedCells: 0, rate-limit: 1.
		{
			cell: "s.on.p1.1", arm: "on", member: "p1", valid: true,
			attempts: [
				{ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "429" }, outcome: baseOutcome({ error: { cause: "provider", name: "E", message: "429 rate limit" } }), diff: null },
				{ attempt: 2, validity: { valid: true }, outcome: baseOutcome(), diff: "" },
			],
		},
		// Cell 2: attempt 1 and attempt 2 both failed with 503 -> retriedCells: 1, excludedCells: 1, provider-5xx: 2.
		{
			cell: "s.on.p1.2", arm: "on", member: "p1", valid: false,
			attempts: [
				{ attempt: 1, validity: { valid: false, cause: "infrastructure", detail: "503" }, outcome: baseOutcome({ error: { cause: "provider", name: "E", message: "503 Service Unavailable" } }), diff: null },
				{ attempt: 2, validity: { valid: false, cause: "infrastructure", detail: "503" }, outcome: baseOutcome({ error: { cause: "provider", name: "E", message: "503 Service Unavailable" } }), diff: null },
			],
		},
		// Cell 3: behaviour failure (overflow) -> 1 attempt, retriedCells: 0, excludedCells: 0 (behaviour is scored 0, not excluded).
		{
			cell: "s.on.p1.3", arm: "on", member: "p1", valid: false,
			attempts: [
				{ attempt: 1, validity: { valid: false, cause: "behaviour", detail: "overflow" }, outcome: baseOutcome({ error: { cause: "overflow", name: "E", message: "maximum context" } }), diff: null },
			],
		},
	];
	const prof = faultProfile(cells, ["p1"], ["on"], new Map([["p1", "f1"]]));
	assert.equal(prof.length, 1);
	assert.equal(prof[0]!.family, "f1");
	assert.equal(prof[0]!.attempts, 5);
	assert.equal(prof[0]!.retriedCells, 2);
	assert.equal(prof[0]!.excludedCells, 1);
	assert.equal(prof[0]!.byKind["rate-limit"], 1);
	assert.equal(prof[0]!.byKind["provider-5xx"], 2);
	assert.equal(prof[0]!.byKind["overflow"], 1);
	for (const k of FAULT_KINDS) {
		if (!["rate-limit", "provider-5xx", "overflow"].includes(k)) assert.equal(prof[0]!.byKind[k], 0);
	}

	// 6. Verify docs/probes/2026-10-17-provider-faults.json exists and has consistent totals.
	const probeFile = path.resolve(packageRoot, "..", "..", "docs", "probes", "2026-10-17-provider-faults.json");
	assert.equal(fs.existsSync(probeFile), true);
	const probeData = JSON.parse(fs.readFileSync(probeFile, "utf8"));
	assert.equal(probeData.totals.runs, 21);
	assert.equal(probeData.totals.completedRuns, 14);
	assert.equal(probeData.totals.stoppedRuns, 7);
	assert.equal(probeData.totals.cells, 1864);
	assert.deepEqual(probeData.totals.byKind, {
		isolation: 0, filter: 0, "rate-limit": 10, "provider-5xx": 26, "provider-other": 2,
		"timeout-model": 0, "timeout-tool": 0, overflow: 0, empty: 0, crash: 0,
	});
});

test("H3: Result.guesses.byScenario and byProperty flag notBlind iff all >= 6 && rate >= 0.75 && rate > baseRate + 0.25, warn in RESULT.md, and reproduce 2026-10-11-092325-adherence and 2026-10-14-112229-adherence", () => {
	// 1. Synthetic fixture testing all boundaries:
	//    - s-blind: 6 guesses, 4 right across 2 groups (rate 4/6 = 0.6667 < 0.75, baseRate 0.5) -> notBlind: false
	//    - s-lowfloor: 6 guesses, 4 right across 3 equal groups (rate 4/6 = 0.6667 < 0.75, baseRate 2/6 = 0.3333, so rate > baseRate + 0.25 holds, but rate < 0.75) -> notBlind: false
	//    - s-unblind: 6 guesses, 5 right across 2 groups (rate 5/6 = 0.8333 >= 0.75, baseRate 0.5, 0.8333 > 0.75) -> notBlind: true
	//    - s-small: 5 guesses, 5 right (all = 5 < 6) -> notBlind: false
	//    - s-held: heldOut scenario, 6 guesses, 6 right -> excluded from byScenario and byProperty
	const mkSc = (id: string, prop: string, heldOut = false): Scenario => ({
		id, tags: [], heldOut, fixture: null, task: "t",
		properties: [{ id: prop, type: "adherence", decidedBy: "judge", key: "k", scale: [0, 1] }],
	});
	const scenarios = new Map<string, Scenario>([
		["s-blind", mkSc("s-blind", "pb")],
		["s-lowfloor", mkSc("s-lowfloor", "pl")],
		["s-unblind", mkSc("s-unblind", "pu")],
		["s-small", mkSc("s-small", "ps")],
		["s-held", mkSc("s-held", "ph", true)],
	]);
	const mkCell = (id: string, sc: string, arm: string): CellRecord => ({
		cell: id, scenario: sc, arm, member: "p1", run: 1, valid: true, final: "ok", scoredFile: null, answers: {}, diff: "", codeScores: [],
		attempts: [{ attempt: 1, validity: { valid: true }, outcome: baseOutcome(), diff: "" }],
	});
	const cells: CellRecord[] = [];
	const units: Unit[] = [];
	const votes: Vote[] = [];

	const addBucket = (sc: string, prop: string, arms: string[], rightCount: number) => {
		arms.forEach((arm, idx) => {
			const cid = `${sc}.${arm}.${idx + 1}`;
			const uid = `u-${cid}`;
			cells.push(mkCell(cid, sc, arm));
			units.push({ id: uid, cell: cid, scenario: sc, arm, member: "p1", family: "f1", properties: [prop], text: "t", blindedAt: "" });
			const truth = arm === "on" ? "guided" : arm === "mid" ? "midgroup" : "unguided";
			const guess = idx < rightCount ? truth : truth === "guided" ? "unguided" : "guided";
			votes.push({ unit: uid, property: prop, judge: "j1", family: "f2", value: 1, reason: "r", guess, prompt: "p" });
		});
	};
	addBucket("s-blind", "pb", ["on", "on", "on", "off", "off", "off"], 4);
	addBucket("s-lowfloor", "pl", ["on", "on", "mid", "mid", "off", "off"], 4);
	addBucket("s-unblind", "pu", ["on", "on", "on", "off", "off", "off"], 5);
	addBucket("s-small", "ps", ["on", "on", "on", "off", "off"], 5);
	addBucket("s-held", "ph", ["on", "on", "on", "off", "off", "off"], 6);

	const res = tally({
		run: "test-guesses", status: "result", arms: ["on", "mid", "off"], members: ["p1"], scenarios, cells, units, absent: [], votes,
		assigned: () => ["j1"], guessGroups: { guided: ["on"], midgroup: ["mid"], unguided: ["off"] },
	});
	assert.equal("s-held" in res.guesses.byScenario, false, "held-out scenario must not appear in byScenario");
	assert.equal("s-held/ph" in res.guesses.byProperty, false, "held-out property must not appear in byProperty");

	assert.equal(res.guesses.byScenario["s-blind"]!.notBlind, false);
	assert.equal(res.guesses.byScenario["s-lowfloor"]!.notBlind, false, "rate 4/6 < 0.75 must not flag notBlind even when > baseRate + 0.25");
	assert.equal(res.guesses.byScenario["s-unblind"]!.notBlind, true);
	assert.equal(res.guesses.byScenario["s-small"]!.notBlind, false);
	assert.equal(res.guesses.byProperty["s-unblind/pu"]!.notBlind, true);

	const md = resultMarkdown(res, ["base limit"]);
	assert.match(md, /Blinding to condition did not hold on s-unblind\/pu: lean on code-scored properties there\./);

	// 2. Re-tally copies of mission-kit's 2026-10-11-092325-adherence and 2026-10-14-112229-adherence runs.
	const run3m = "/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-11-092325-adherence";
	const run5m = "/home/apnex/taceng/mission-kit/docs/evals/runs/context-lab/2026-10-14-112229-adherence";
	if (fs.existsSync(run3m)) {
		const copy3m = path.join(scratch(), "adh-3m");
		fs.cpSync(run3m, copy3m, { recursive: true });
		const r3 = tallyRun(copy3m);
		assert.deepEqual(r3.guesses.byScenario["adherence-x"], {
			right: 53, all: 54, baseRate: 36 / 54, rate: 53 / 54, notBlind: true,
		});
		assert.deepEqual(r3.guesses.byScenario["adherence-a13"], {
			right: 51, all: 54, baseRate: 36 / 54, rate: 51 / 54, notBlind: true,
		});
		assert.equal(r3.guesses.byScenario["adherence-a11"]!.notBlind, false);
		assert.equal(r3.guesses.byProperty["adherence-x/x1"]!.notBlind, true);
		assert.equal(r3.guesses.byProperty["adherence-a13/a13-1"]!.notBlind, true);
		const md3 = fs.readFileSync(path.join(copy3m, "RESULT.md"), "utf8");
		assert.match(md3, /Blinding to condition did not hold on adherence-x\/x1/);
	}
	if (fs.existsSync(run5m)) {
		const copy5m = path.join(scratch(), "adh-5m");
		fs.cpSync(run5m, copy5m, { recursive: true });
		const r5 = tallyRun(copy5m);
		assert.deepEqual(r5.guesses.byScenario["adherence-x"], {
			right: 111, all: 135, baseRate: 90 / 135, rate: 111 / 135, notBlind: false,
		});
		assert.ok(Object.values(r5.guesses.byProperty).every((b) => b.notBlind === false));
	}
});
