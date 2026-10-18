// Delta-3 stage 2: classify-then-verify judging chains and candidate writer (criteria G4, G5, G6).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, assignChainJudges, buildVariant, checkPack, conductRun, countChain, evaluateCandidates,
	measure, quoteInOutcome, readZorgLegacyRun, runJudgingChain, writeRunCandidates,
	type Adapter, type ChainRecord, type Invocation, type Member, type Outcome, type Result, type Scenario, type Unit,
} from "../src/index.js";
import { commitAll, copyPack, editJson, judgeReply, scratch } from "./helpers.js";

function outcome(final: string): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null" };
}

test("G4: assignChainJudges and runJudgingChain require >= 3 families, never assign a classifier or verifier of the reader's or classifier's family, and reject invalid quotes by code before stage 2", async () => {
	const j1: Member = { id: "p1", family: "f1", runtime: "opencode", model: "m1" };
	const j2: Member = { id: "p2", family: "f2", runtime: "codex", model: "m2" };
	const j3: Member = { id: "p3", family: "f3", runtime: "opencode", model: "m3" };

	// Fewer than 3 families is refused before any call.
	assert.throws(() => assignChainJudges("f1", [j1, j2]), /at least 3 distinct model families/);

	for (const rf of ["f1", "f2", "f3"]) {
		const { classifier, verifier } = assignChainJudges(rf, [j1, j2, j3]);
		assert.notEqual(classifier.family, rf);
		assert.notEqual(verifier.family, rf);
		assert.notEqual(verifier.family, classifier.family);
	}

	// quoteInOutcome: empty, > 25 words, or word absent from outcome is rejected; 1..25 words all present is accepted.
	assert.equal(quoteInOutcome("", "some text here").ok, false);
	assert.equal(quoteInOutcome("absentword", "some text here").ok, false);
	assert.equal(quoteInOutcome(Array.from({ length: 26 }, (_, i) => `w${i}`).join(" "), Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")).ok, false);
	assert.equal(quoteInOutcome(Array.from({ length: 25 }, (_, i) => `w${i}`).join(" "), Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")).ok, true);

	// Full runJudgingChain over 3 families: check family separation and stage-1 code filtering.
	const dir = copyPack();
	const checked = await checkPack(dir);
	if (!checked.ok) throw new Error("pack invalid");
	const units: Unit[] = [
		{ id: "u0001", cell: "graft.almanac.p1.1", scenario: "graft", arm: "almanac", member: "p1", family: "f1", properties: [], text: "The pear scion is grafted onto the quince rootstock in spring.", blindedAt: "" },
		{ id: "u0002", cell: "graft.almanac.p2.1", scenario: "graft", arm: "almanac", member: "p2", family: "f2", properties: [], text: "The pear scion is grafted onto the quince rootstock in spring.", blindedAt: "" },
		{ id: "u0003", cell: "graft.almanac.p3.1", scenario: "graft", arm: "almanac", member: "p3", family: "f3", properties: [], text: "The pear scion is grafted onto the quince rootstock in spring.", blindedAt: "" },
	];
	const chain = {
		findings: [
			{ id: "F1", kind: "named" as const, statement: "Names quince rootstock.", countsWhen: "Says quince rootstock." },
			{ id: "F2", kind: "named" as const, statement: "Names fabricated word.", countsWhen: "Says fabricated." },
		],
	};
	const work = path.join(scratch(), "w"), records = path.join(scratch(), "r");
	// Refuse < 3 families in runJudgingChain before any adapter call.
	let called = 0;
	const countingAdapter: Adapter = {
		runtime: "opencode", rulesFiles: [], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke() { called++; return outcome("{}"); },
	};
	await assert.rejects(
		() => runJudgingChain({ loaded: checked.loaded, chain, units, judges: [j1, j2], adapters: { opencode: countingAdapter, codex: countingAdapter }, recordsDir: records, work }),
		/at least 3 distinct model families/,
	);
	assert.equal(called, 0, "adapter was called despite fewer than 3 judge families");

	const verifierCalls: { member: Member; prompt: string }[] = [];
	const chainAdapter = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			if (inv.prompt.includes("You are classifying an outcome")) {
				// Return F1 with a valid quote and F2 with a fabricated word ("cherries") not in the outcome.
				return outcome(JSON.stringify({ findings: { F1: "pear scion is grafted onto the quince rootstock", F2: "cherries in summer" }, new: ["unlisted observation"] }));
			}
			verifierCalls.push({ member: inv.member, prompt: inv.prompt });
			return outcome(JSON.stringify({ supports: true, reason: "supported" }));
		},
	});
	const rec = await runJudgingChain({
		loaded: checked.loaded, chain, units, judges: [j1, j2, j3],
		adapters: { opencode: chainAdapter("opencode"), codex: chainAdapter("codex") },
		recordsDir: records, work,
	});
	// F1 (3 hits) passes code check and goes to stage 2; F2 (3 hits) is rejected by code before stage 2.
	assert.equal(rec.classified.length, 3);
	assert.equal(rec.codeRejected.length, 3);
	assert.ok(rec.codeRejected.every((cr) => cr.finding === "F2"));
	assert.equal(verifierCalls.length, 3, "code-rejected quotes must not be sent to stage 2");
	for (const hit of rec.classified) {
		assert.notEqual(hit.classifierFamily, hit.readerFamily);
		const v = rec.verified.find((x) => x.unit === hit.unit && x.finding === hit.finding)!;
		assert.notEqual(v.verifierFamily, hit.readerFamily);
		assert.notEqual(v.verifierFamily, hit.classifierFamily);
	}
});

test("G5: countChain counts only verifier-supported named evidence and >0 codeScores computed evidence, deduplicates multiple readers of one family, and evaluates meets against threshold", () => {
	const findings = [
		{ id: "L1", kind: "computed" as const, statement: "Computed block", countsWhen: "code" },
		{ id: "L2", kind: "named" as const, statement: "Named gap", countsWhen: "named" },
		{ id: "L8", kind: "named or computed" as const, statement: "Both", countsWhen: "both" },
		{ id: "L9", kind: "named" as const, statement: "Single family only", countsWhen: "one fam" },
		{ id: "L10", kind: "named" as const, statement: "No held-out scenario", countsWhen: "no held-out" },
	];
	const record: ChainRecord = {
		findings,
		threshold: { minScenarios: 3, minHeldOut: 1, minFamilies: 2 },
		classified: [
			// L2: s1 (f1, two readers r1 and r2), s2 (f2), s3 held-out (f1) -> 3 scenarios, 1 held-out, 2 families -> meets = true!
			{ unit: "u1", pid: "s1.a.p1.1", scenario: "s1", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L2", quote: "q" },
			{ unit: "u2", pid: "s1.a.p1.2", scenario: "s1", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L2", quote: "q" },
			{ unit: "u3", pid: "s2.a.p2.1", scenario: "s2", readerFamily: "f2", classifier: "p3", classifierFamily: "f3", finding: "L2", quote: "q" },
			{ unit: "u4", pid: "s3.a.p1.1", scenario: "s3", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L2", quote: "q" },
			// Rejected hit on L2 in s4 (supports: false) -> must not count in scenarios, must increment rejected.
			{ unit: "u5", pid: "s4.a.p3.1", scenario: "s4", readerFamily: "f3", classifier: "p1", classifierFamily: "f1", finding: "L2", quote: "bad" },
			// Unverified hit on L2 in s4 (no verdict) -> must increment unverified.
			{ unit: "u6", pid: "s4.a.p3.2", scenario: "s4", readerFamily: "f3", classifier: "p1", classifierFamily: "f1", finding: "L2", quote: "unver" },
			// L8 named hit on s1.a.p1.1 (same reader also has computed L8 codeScore -> deduplicated to 1 reader!).
			{ unit: "u1", pid: "s1.a.p1.1", scenario: "s1", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L8", quote: "q8" },
			// L9: 3 scenarios (s1, s2, s3 held-out), 2 readers per scenario, but ALL in family f1 -> families = ["f1"] (length 1 < 2) -> meets = false!
			{ unit: "u1", pid: "s1.a.p1.1", scenario: "s1", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L9", quote: "q9" },
			{ unit: "u2", pid: "s1.a.p1.2", scenario: "s1", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L9", quote: "q9" },
			{ unit: "u7", pid: "s2.a.p1.1", scenario: "s2", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L9", quote: "q9" },
			{ unit: "u4", pid: "s3.a.p1.1", scenario: "s3", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L9", quote: "q9" },
			// L10: 3 non-held-out scenarios (s1, s2, s4) and 2 families (f1, f2), but heldOut.length === 0 < 1 -> meets = false!
			{ unit: "u1", pid: "s1.a.p1.1", scenario: "s1", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L10", quote: "q10" },
			{ unit: "u3", pid: "s2.a.p2.1", scenario: "s2", readerFamily: "f2", classifier: "p3", classifierFamily: "f3", finding: "L10", quote: "q10" },
			{ unit: "u8", pid: "s4.a.p1.1", scenario: "s4", readerFamily: "f1", classifier: "p2", classifierFamily: "f2", finding: "L10", quote: "q10" },
		],
		codeRejected: [],
		verified: [
			{ unit: "u1", pid: "s1.a.p1.1", finding: "L2", quote: "q", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u2", pid: "s1.a.p1.2", finding: "L2", quote: "q", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u3", pid: "s2.a.p2.1", finding: "L2", quote: "q", verifier: "p1", verifierFamily: "f1", supports: true, reason: "ok" },
			{ unit: "u4", pid: "s3.a.p1.1", finding: "L2", quote: "q", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u5", pid: "s4.a.p3.1", finding: "L2", quote: "bad", verifier: "p2", verifierFamily: "f2", supports: false, reason: "no" },
			{ unit: "u1", pid: "s1.a.p1.1", finding: "L8", quote: "q8", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u1", pid: "s1.a.p1.1", finding: "L9", quote: "q9", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u2", pid: "s1.a.p1.2", finding: "L9", quote: "q9", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u7", pid: "s2.a.p1.1", finding: "L9", quote: "q9", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u4", pid: "s3.a.p1.1", finding: "L9", quote: "q9", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u1", pid: "s1.a.p1.1", finding: "L10", quote: "q10", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
			{ unit: "u3", pid: "s2.a.p2.1", finding: "L10", quote: "q10", verifier: "p1", verifierFamily: "f1", supports: true, reason: "ok" },
			{ unit: "u8", pid: "s4.a.p1.1", finding: "L10", quote: "q10", verifier: "p3", verifierFamily: "f3", supports: true, reason: "ok" },
		],
		unclassified: [],
		news: [],
	};
	const cells = [
		{ cell: "s1.a.p1.1", scenario: "s1", member: "p1", codeScores: [{ property: "L1", value: 1, measuredAt: "" }, { property: "L8", value: 1, measuredAt: "" }] },
		{ cell: "s2.a.p2.1", scenario: "s2", member: "p2", codeScores: [{ property: "L1", value: 0, measuredAt: "" }, { property: "L8", value: 1, measuredAt: "" }] },
		{ cell: "s3.a.p1.1", scenario: "s3", member: "p1", codeScores: [{ property: "L8", value: 1, measuredAt: "" }] },
	];
	const members = new Map([["p1", "f1"], ["p2", "f2"], ["p3", "f3"]]);
	const res = countChain({ record, cells, members, heldOutScenarios: new Set(["s3"]) });
	const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));

	// L1: only s1.a.p1.1 has value > 0 -> 1 scenario, 0 held-out, 1 family -> meets = false.
	assert.equal(byId["L1"]!.readers, 1);
	assert.equal(byId["L1"]!.meets, false);

	// L2: 4 supported readers across s1, s2, s3 (held out), families f1, f2; 1 rejected, 1 unverified -> meets = true.
	assert.equal(byId["L2"]!.readers, 4);
	assert.deepEqual(byId["L2"]!.scenarios, ["s1", "s2", "s3"]);
	assert.deepEqual(byId["L2"]!.heldOut, ["s3"]);
	assert.deepEqual(byId["L2"]!.families, ["f1", "f2"]);
	assert.equal(byId["L2"]!.rejected, 1);
	assert.equal(byId["L2"]!.unverified, 1);
	assert.equal(byId["L2"]!.meets, true);

	// L8: named on s1.a.p1.1 (1 reader), computed on s1.a.p1.1, s2.a.p2.1, s3.a.p1.1 (3 readers total, deduplicated on s1.a.p1.1) -> meets = true, namedOnly.readers = 1.
	assert.equal(byId["L8"]!.readers, 3);
	assert.equal(byId["L8"]!.namedOnly.readers, 1);
	assert.equal(byId["L8"]!.meets, true);

	// L9: 4 readers across 3 scenarios including s3 held-out, but all in f1 -> families.length === 1 < 2 -> meets = false.
	assert.equal(byId["L9"]!.readers, 4);
	assert.deepEqual(byId["L9"]!.families, ["f1"]);
	assert.equal(byId["L9"]!.meets, false);

	// L10: 3 scenarios (s1, s2, s4) and 2 families (f1, f2), but 0 held-out -> meets = false.
	assert.deepEqual(byId["L10"]!.scenarios, ["s1", "s2", "s4"]);
	assert.deepEqual(byId["L10"]!.heldOut, []);
	assert.deepEqual(byId["L10"]!.families, ["f1", "f2"]);
	assert.equal(byId["L10"]!.meets, false);
});

test("G6: evaluateCandidates and writeRunCandidates emit candidates for all four rules when and only when thresholds hold, and write CANDIDATES.json/md inside recordsDir only", async () => {
	const s: Scenario = {
		id: "sc", tags: [], fixture: null, task: "t",
		properties: [
			{ id: "adh-fail", type: "adherence", decidedBy: "judge", key: "k", scale: [0, 1], guidance: ["A1"] },
			{ id: "adh-pass", type: "adherence", decidedBy: "judge", key: "k", scale: [0, 1], guidance: ["A2"] },
			// Scale [0, 2] precision property: mean = 1.4 -> normalised pass = 0.7 -> fail rate = 0.3 > 0.25 (triggers!).
			{ id: "prec-bad", type: "precision", decidedBy: "judge", key: "k", scale: [0, 2], guidance: ["A3"] },
			// Scale [0, 2] precision property: mean = 1.5 -> normalised pass = 0.75 -> fail rate = 0.25 <= 0.25 (does NOT trigger!).
			{ id: "prec-ok", type: "precision", decidedBy: "judge", key: "k", scale: [0, 2], guidance: ["A4"] },
		],
	};
	const scenarios = new Map([["sc", s]]);
	const result: Result = {
		run: "r1", status: "result", arms: ["bare", "almanac", "always"], members: ["p1", "p2"],
		properties: [
			{ scenario: "sc", property: "adh-fail", byArm: { bare: { mean: 0, of: 2, incomplete: 0 }, almanac: { mean: 0, of: 2, incomplete: 0 }, always: { mean: 0, of: 2, incomplete: 0 } }, byArmMember: {}, agreement: { agree: 2, of: 2 } },
			// adh-pass: 0 in almanac, 0.5 in always -> NOT failing in every guided arm!
			{ scenario: "sc", property: "adh-pass", byArm: { bare: { mean: 0, of: 2, incomplete: 0 }, almanac: { mean: 0, of: 2, incomplete: 0 }, always: { mean: 0.5, of: 2, incomplete: 0 } }, byArmMember: {}, agreement: { agree: 2, of: 2 } },
			{ scenario: "sc", property: "prec-bad", byArm: { bare: { mean: 2, of: 2, incomplete: 0 }, almanac: { mean: 1.4, of: 2, incomplete: 0 }, always: { mean: 2, of: 2, incomplete: 0 } }, byArmMember: {}, agreement: { agree: 2, of: 2 } },
			{ scenario: "sc", property: "prec-ok", byArm: { bare: { mean: 2, of: 2, incomplete: 0 }, almanac: { mean: 1.5, of: 2, incomplete: 0 }, always: { mean: 2, of: 2, incomplete: 0 } }, byArmMember: {}, agreement: { agree: 2, of: 2 } },
		],
		totals: { bare: 4, almanac: 2.9, always: 4.5 }, excluded: [], absent: [], guesses: { right: 0, all: 0, byGuess: {}, baseRate: null, byScenario: {}, byProperty: {} },
		faults: [],
		unreachable: [], cellValues: {}, heldOut: [], heldOutCellValues: {}, heldOutAbsent: [], heldOutGuesses: { right: 0, all: 0 },
		exposed: [], restated: [], variation: { stated: null, default: null, pooled: null, byProperty: [] },
		link: [
			// G-high: in guided arm almanac, p1 has metNot=0.75 (4 pairs) and p2 has metNot=0.5 (2 pairs) -> weighted 4/6 = 0.6667 > 0.5 (triggers!).
			{ member: "p1", arm: "almanac", guidance: "G-high", pairs: 4, metMet: 0.25, metNot: 0.75, notMet: 0, neither: 0 },
			{ member: "p2", arm: "almanac", guidance: "G-high", pairs: 2, metMet: 0.5, metNot: 0.5, notMet: 0, neither: 0 },
			// G-border: in guided arm almanac, metNot = 0.5 <= 0.5 (does NOT trigger; even if bare has 1.0, bare is unguided!).
			{ member: "p1", arm: "almanac", guidance: "G-border", pairs: 4, metMet: 0.5, metNot: 0.5, notMet: 0, neither: 0 },
			{ member: "p1", arm: "bare", guidance: "G-border", pairs: 4, metMet: 0, metNot: 1.0, notMet: 0, neither: 0 },
		],
		chain: {
			threshold: { minScenarios: 3, minHeldOut: 1, minFamilies: 2 },
			heldOut: ["h1"], unclassified: [], news: [],
			rows: [
				{ id: "L-yes", readers: 5, scenarios: ["s1", "s2", "h1"], briefs: ["s1", "s2", "h1"], heldOut: ["h1"], families: ["f1", "f2"], namedOnly: { readers: 5, scenarios: ["s1", "s2", "h1"], briefs: ["s1", "s2", "h1"], heldOut: ["h1"], families: ["f1", "f2"] }, meets: true, rejected: 0, unverified: 0, codeRejected: 0, evidence: [], rejectedEvidence: [] },
				{ id: "L-no", readers: 2, scenarios: ["s1", "s2"], briefs: ["s1", "s2"], heldOut: [], families: ["f1", "f2"], namedOnly: { readers: 2, scenarios: ["s1", "s2"], briefs: ["s1", "s2"], heldOut: [], families: ["f1", "f2"] }, meets: false, rejected: 0, unverified: 0, codeRejected: 0, evidence: [], rejectedEvidence: [] },
			],
		},
	};
	const packet = evaluateCandidates({ result, scenarios, guidedArms: ["almanac", "always"] });
	assert.deepEqual(
		packet.candidates.map((c) => [c.rule, c.target]),
		[
			["all-guided-fail", "sc/adh-fail"],
			["wrong-firing", "sc/prec-bad"],
			["knows-not-acts", "G-high"],
			["chain-threshold", "L-yes"],
		],
	);

	// Rules 5 and 6 read hydration rows of guided arms that could reach the entry only on request.
	const row = (arm: string, guidance: string, cells: number, hydrated: number, onRequestOnly: boolean | null, adherence: NonNullable<Result["hydration"]>[number]["adherence"]) => ({
		scenario: "sc", arm, guidance, cells, hydrated, rate: hydrated / cells, membersHydrated: [], membersMissed: ["p2"], hydratedCells: [], missedCells: [], onRequestOnly, adherence,
	});
	const hydration: NonNullable<Result["hydration"]> = [
		// R-low: 1 of 4 hydrated (0.25 < 0.5) -> routing-miss. Its 1 hydrating cell is below the 2 rule 6 needs.
		row("almanac", "R-low", 4, 1, true, [{ property: "adh-r", hydrated: { of: 1, met: 0 }, missed: { of: 3, met: 0 } }]),
		// R-half: 2 of 4 (0.5, not below) -> no routing-miss; 2 of 2 hydrating cells not met (1.0 > 0.5) -> hydrated-not-acted.
		row("almanac", "R-half", 4, 2, true, [{ property: "adh-h", hydrated: { of: 2, met: 0 }, missed: { of: 2, met: 1 } }, { property: "adh-ok", hydrated: { of: 2, met: 1 }, missed: { of: 2, met: 0 } }]),
		// One cell only: below the 2 cells routing-miss needs.
		row("almanac", "R-one", 1, 0, true, []),
		// Deliveries unknown, or an unguided arm: neither rule reads the row.
		row("almanac", "R-unknown", 4, 0, null, [{ property: "adh-u", hydrated: { of: 2, met: 0 }, missed: { of: 2, met: 0 } }]),
		row("bare", "R-bare", 4, 0, true, [{ property: "adh-b", hydrated: { of: 2, met: 0 }, missed: { of: 2, met: 0 } }]),
	];
	const p2 = evaluateCandidates({ result: { ...result, properties: [], link: [], chain: null, hydration }, scenarios, guidedArms: ["almanac", "always"] });
	assert.deepEqual(p2.candidates.map((c) => [c.rule, c.target]), [["routing-miss", "sc/R-low@almanac"], ["hydrated-not-acted", "sc/adh-h@almanac"]]);
	assert.deepEqual(p2.rules, { wrongFiringThreshold: 0.25, knowsNotActsThreshold: 0.5, routingMissThreshold: 0.5, hydratedNotActedThreshold: 0.5, judgeOutlierThreshold: 0.5 });
	// A scenario declaring what it exercises: rows for other guidance it names emit nothing, and a
	// property flagged from two exercised entries' rows is written once.
	const tagged = new Map([["sc", { ...s, tags: ["exercises:R-half", "exercises:R-dup"] }]]);
	const dup = [...hydration, row("almanac", "R-dup", 4, 2, true, [{ property: "adh-h", hydrated: { of: 2, met: 0 }, missed: { of: 2, met: 1 } }])];
	const p4 = evaluateCandidates({ result: { ...result, properties: [], link: [], chain: null, hydration: dup }, scenarios: tagged, guidedArms: ["almanac"] });
	assert.deepEqual(p4.candidates.map((c) => [c.rule, c.target]), [["hydrated-not-acted", "sc/adh-h@almanac"]]);
	// Rule 7: a judge alone differing in more than half of at least 10 splits.
	const dissent = [
		{ judge: "x", votes: 90, splits: 20, lone: 14, rate: 0.7 },
		{ judge: "o", votes: 90, splits: 20, lone: 3, rate: 0.15 },
		// A high rate on fewer than 10 splits is not enough.
		{ judge: "c", votes: 90, splits: 9, lone: 9, rate: 1 },
	];
	const p5 = evaluateCandidates({ result: { ...result, properties: [], link: [], chain: null, judgeDissent: dissent }, scenarios, guidedArms: ["almanac"] });
	assert.deepEqual(p5.candidates.map((c) => [c.rule, c.target]), [["judge-outlier", "x"]]);
	const p3 = evaluateCandidates({ result: { ...result, properties: [], link: [], chain: null, hydration }, scenarios, guidedArms: ["almanac"], rules: { routingMissThreshold: 0.6, hydratedNotActedThreshold: 0.99 } });
	assert.deepEqual(p3.candidates.map((c) => [c.rule, c.target]), [["routing-miss", "sc/R-low@almanac"], ["routing-miss", "sc/R-half@almanac"], ["hydrated-not-acted", "sc/adh-h@almanac"]]);

	// End-to-end writeRunCandidates on a run folder: writes CANDIDATES.json/md, appends "candidates-written", touches nothing outside.
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.runsPerCell = 1; });
	commitAll(dir);
	const a = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && inv.prompt.includes("=== OUTCOME")) return outcome(judgeReply(inv.prompt, 0));
			if (inv.tools === "off") return outcome("I do not know.");
			return outcome("done");
		},
	});
	const work = path.join(scratch(), "w"), records = path.join(scratch(), "r");
	const { dir: rd } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: a("opencode"), codex: a("codex") }, work, records, parallel: 1 });
	const packBefore = fs.readdirSync(dir).sort();
	const written = await writeRunCandidates(dir, rd);
	assert.equal(written.candidates.some((c) => c.rule === "all-guided-fail" && c.target === "graft/graft-1"), true);
	assert.equal(fs.existsSync(path.join(rd, "CANDIDATES.json")), true);
	assert.equal(fs.existsSync(path.join(rd, "CANDIDATES.md")), true);
	const updatedRun = JSON.parse(fs.readFileSync(path.join(rd, "run.json"), "utf8"));
	assert.ok(updatedRun.states.some((st: { state: string }) => st.state === "candidates-written"));
	assert.deepEqual(fs.readdirSync(dir).sort(), packBefore, "writeRunCandidates must not add files to the pack directory");
});

test("G9: readZorgLegacyRun converts a legacy zorg census folder and countChain reproduces exact counts; when l-02 is present on disk, all 26 findings match FINDINGS-COUNT.json", async () => {
	// 1. Self-contained synthetic legacy zorg folder (passes even when sibling repos are absent, per E7).
	const synDir = scratch();
	fs.mkdirSync(path.join(synDir, "sealed"), { recursive: true });
	fs.mkdirSync(path.join(synDir, "classify"), { recursive: true });
	fs.mkdirSync(path.join(synDir, "verify"), { recursive: true });
	fs.writeFileSync(path.join(synDir, "sealed", "manifest.json"), JSON.stringify({
		prompts: [
			{ pid: "r-1", label: "V-c", group: "census-zorg" },
			{ pid: "r-2", label: "V-g", group: "census-fleet" },
			{ pid: "r-3", label: "V-o", group: "census-feature-flags" },
		],
	}));
	fs.writeFileSync(path.join(synDir, "classify", "classify-c1.jsonl"), JSON.stringify({ pid: "r-1", findings: { L2: "q1" }, new: ["obs1"] }) + "\n");
	fs.writeFileSync(path.join(synDir, "classify", "classify-g1.jsonl"), JSON.stringify({ pid: "r-2", findings: { L2: "q2" }, new: [] }) + "\n");
	fs.writeFileSync(path.join(synDir, "classify", "classify-o1.jsonl"), JSON.stringify({ pid: "r-3", findings: { L2: "q3" }, new: [] }) + "\n");
	fs.writeFileSync(path.join(synDir, "verify", "verify-c1.items.json"), JSON.stringify([
		{ item: "v1", pid: "r-1", id: "L2", quote: "q1", suffix: "c" },
		{ item: "v2", pid: "r-2", id: "L2", quote: "q2", suffix: "g" },
		{ item: "v3", pid: "r-3", id: "L2", quote: "q3", suffix: "o" },
	]));
	fs.writeFileSync(path.join(synDir, "verify", "verify-c1.jsonl"), [
		JSON.stringify({ item: "v1", supports: true, reason: "ok" }),
		JSON.stringify({ item: "v2", supports: true, reason: "ok" }),
		JSON.stringify({ item: "v3", supports: true, reason: "ok" }),
	].join("\n") + "\n");
	fs.writeFileSync(path.join(synDir, "AGGREGATE.json"), JSON.stringify({
		rows: [
			{ pid: "r-1", family: "claude", brief: "zorg", block: "all used", census: { agp: { unused: ["request-correlation"] } } },
			{ pid: "r-2", family: "gemini", brief: "fleet-config", block: "all unused", census: { agp: { unused: ["request-correlation"] } } },
			{ pid: "r-3", family: "gpt", brief: "feature-flags", block: "all used", census: { agp: { unused: ["request-correlation"] } } },
		],
	}));
	const synInput = readZorgLegacyRun({
		runDir: synDir,
		findings: [
			{ id: "L1", kind: "computed", statement: "s1", countsWhen: "c1" },
			{ id: "L2", kind: "named", statement: "s2", countsWhen: "c2" },
			{ id: "L8", kind: "named or computed", statement: "s8", countsWhen: "c8" },
		],
		heldOutScenarios: ["feature-flags"],
	});
	const synCount = countChain(synInput);
	assert.equal(synCount.rows.length, 3);
	assert.ok(synCount.rows.every((r) => r.meets === true && r.readers === 3));

	// 2. Real l-02 parity check across all 26 findings when zorg-eval-runs/runs/l-02 is present on disk.
	const l02Dir = "/home/apnex/taceng/zorg-eval-runs/runs/l-02";
	const zorgFindingsFile = "/home/apnex/taceng/zorg/evals/census-findings.json";
	if (fs.existsSync(l02Dir) && fs.existsSync(zorgFindingsFile)) {
		const zorgPack = "/home/apnex/taceng/zorg/evals/context-lab";
		if (fs.existsSync(zorgPack)) {
			const chk = await checkPack(zorgPack);
			assert.equal(chk.ok, true, chk.ok ? "" : JSON.stringify(chk.defects));
		}
		const findings = (JSON.parse(fs.readFileSync(zorgFindingsFile, "utf8")) as { findings: ChainRecord["findings"] }).findings;
		const want = JSON.parse(fs.readFileSync(path.join(l02Dir, "FINDINGS-COUNT.json"), "utf8")) as {
			unclassified: string[];
			news: unknown[];
			rows: { id: string; readers: number; briefs: string[]; heldOut: string[]; families: string[]; namedOnly: { readers: number; briefs: string[]; heldOut: string[]; families: string[] }; meets: boolean; rejected: number; unverified: number }[];
		};
		const got = countChain(readZorgLegacyRun({ runDir: l02Dir, findings, heldOutScenarios: ["agent-memory", "feature-flags"] }));
		assert.deepEqual(got.unclassified, want.unclassified);
		assert.equal(got.news.length, want.news.length);
		assert.equal(got.rows.length, want.rows.length);
		for (const w of want.rows) {
			const g = got.rows.find((r) => r.id === w.id)!;
			assert.ok(g, `missing row ${w.id}`);
			assert.equal(g.readers, w.readers, `${w.id}.readers`);
			assert.deepEqual(g.briefs, w.briefs, `${w.id}.briefs`);
			assert.deepEqual(g.heldOut, w.heldOut, `${w.id}.heldOut`);
			assert.deepEqual(g.families, w.families, `${w.id}.families`);
			assert.deepEqual(
				{ readers: g.namedOnly.readers, briefs: g.namedOnly.briefs, heldOut: g.namedOnly.heldOut, families: g.namedOnly.families },
				w.namedOnly,
				`${w.id}.namedOnly`,
			);
			assert.equal(g.meets, w.meets, `${w.id}.meets`);
			assert.equal(g.rejected, w.rejected, `${w.id}.rejected`);
			assert.equal(g.unverified, w.unverified, `${w.id}.unverified`);
		}
	}

	// 3. Verify that buildVariant (variant-transform) and measure (outcome-measure) bind pack-declared
	//    sibling source paths read-only inside the hook sandbox (kills M7 and M8 on synthetic fixtures).
	const siblingSrc = scratch();
	fs.writeFileSync(path.join(siblingSrc, "SIBLING.txt"), "sibling-marker\n");
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => {
		j.sources.push({ id: "sibling", path: siblingSrc, addresses: ["https://sibling.invalid"] });
	});
	const sibPathJson = JSON.stringify(path.join(siblingSrc, "SIBLING.txt"));
	fs.writeFileSync(
		path.join(dir, "hooks", "trim.mjs"),
		`import fs from "node:fs"; import path from "node:path";\nconst i = JSON.parse(fs.readFileSync(0, "utf8"));\nconst sib = fs.readFileSync(${sibPathJson}, "utf8").trim();\nfor (const f of fs.readdirSync(i.from)) fs.writeFileSync(path.join(i.to, f), fs.readFileSync(path.join(i.from, f), "utf8") + sib + "\\n");\nconsole.log(JSON.stringify({ ok: true }));\n`,
	);
	fs.writeFileSync(
		path.join(dir, "hooks", "count.mjs"),
		`import fs from "node:fs";\nconst sib = fs.readFileSync(${sibPathJson}, "utf8").trim();\nconsole.log(JSON.stringify({ scores: { "graft-2": sib === "sibling-marker" ? 1 : 0 } }));\n`,
	);
	commitAll(dir);
	const chkSib = await checkPack(dir);
	assert.equal(chkSib.ok, true);
	if (!chkSib.ok) throw new Error("pack invalid");
	const vOut = path.join(scratch(), "v-out");
	const bv = await buildVariant(chkSib.loaded, "almanac-full", "HEAD", vOut);
	assert.equal(bv.ok, true, bv.ok ? "" : bv.reason);
	const graftSc = chkSib.loaded.experiments.get("orchard")!.scenarios.get("graft")!.scenario;
	const cs = await measure(chkSib.loaded, graftSc, { final: "done", diff: "", scored: null });
	assert.deepEqual(cs.map((x) => ("value" in x ? x.value : null)), [1]);
});
