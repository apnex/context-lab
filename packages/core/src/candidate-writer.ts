// candidate-writer - writes candidate findings from results (architecture section 5, principle P9;
// Delta-3 stage 2, criterion G6).
//
// Evaluates a run's Result against four rules (0004, customizable via pack.findingRules):
//   1. all-guided-fail  an adherence property whose normalised pass rate is 0 in every guided arm
//                       (each guided arm having at least 1 counted outcome);
//   2. wrong-firing     a precision property whose normalised fail rate 1 - (mean - low)/(high - low)
//                       exceeds wrongFiringThreshold (0.25 by default) in any guided arm;
//   3. knows-not-acts   a guidance entry in result.link whose pairs-weighted metNot rate across
//                       guided arms exceeds knowsNotActsThreshold (0.5 by default);
//   4. chain-threshold  a classify-then-verify finding in result.chain.rows with meets === true.
//
// Writes CANDIDATES.json and CANDIDATES.md inside the run folder and modifies no file outside it.

import fs from "node:fs";
import path from "node:path";
import { checkPack } from "./pack-checker.js";
import { propertiesOf, type FindingRules, type LoadedPack, type Property, type Scenario } from "./pack-schema.js";
import type { RunRecord } from "./run-conductor.js";
import type { Result } from "./tally.js";

export type CandidateRuleId = "all-guided-fail" | "wrong-firing" | "knows-not-acts" | "chain-threshold";

export interface CandidateFinding {
	rule: CandidateRuleId;
	target: string;
	summary: string;
	evidence: Record<string, unknown>;
	draftBacklogRow: string;
	revivalTrigger: string;
}

export interface CandidatesPacket {
	run: string;
	createdAt: string;
	rules: Required<FindingRules>;
	guidedArms: string[];
	candidates: CandidateFinding[];
}

export interface EvaluateCandidatesOptions {
	result: Result;
	scenarios: Map<string, Scenario>;
	guidedArms: string[];
	rules?: FindingRules;
	now?: () => Date;
}

export function evaluateCandidates(o: EvaluateCandidatesOptions): CandidatesPacket {
	const now = o.now ?? (() => new Date());
	const rules: Required<FindingRules> = {
		wrongFiringThreshold: o.rules?.wrongFiringThreshold ?? 0.25,
		knowsNotActsThreshold: o.rules?.knowsNotActsThreshold ?? 0.5,
	};
	const guidedArms = o.guidedArms.filter((a) => o.result.arms.includes(a));
	const propMap = new Map<string, Property>();
	for (const [sid, s] of o.scenarios) {
		for (const p of propertiesOf(s)) propMap.set(`${sid}/${p.id}`, p);
	}

	const candidates: CandidateFinding[] = [];

	// Rule 1 (all-guided-fail) & Rule 2 (wrong-firing)
	if (guidedArms.length > 0) {
		for (const pr of o.result.properties) {
			const def = propMap.get(`${pr.scenario}/${pr.property}`);
			if (!def) continue;
			const [low, high] = def.scale;
			const span = high - low;
			if (def.type === "adherence") {
				const rates = guidedArms.map((a) => {
					const r = pr.byArm[a];
					if (!r || r.of === 0 || r.mean === null) return null;
					return (r.mean - low) / span;
				});
				if (rates.every((r) => r === 0)) {
					const target = `${pr.scenario}/${pr.property}`;
					const trigger = `guidance for ${ (def.guidance ?? [target]).join(", ") } is revised`;
					candidates.push({
						rule: "all-guided-fail",
						target,
						summary: `Adherence property ${target} scored 0 in every guided arm (${guidedArms.join(", ")}).`,
						evidence: Object.fromEntries(guidedArms.map((a) => [a, pr.byArm[a]])),
						revivalTrigger: trigger,
						draftBacklogRow: `| **B-TBD** | S3 | A8 signal | **Adherence property \`${target}\` failed in every guided arm (${guidedArms.join(", ")}).** | \`[M, run ${o.result.run} RESULT.json]\` | open - TRIGGER: ${trigger} |`,
					});
				}
			} else if (def.type === "precision") {
				const failingArms: Record<string, { failRate: number; mean: number; of: number }> = {};
				for (const a of guidedArms) {
					const r = pr.byArm[a];
					if (!r || r.of === 0 || r.mean === null) continue;
					const normPass = (r.mean - low) / span;
					const failRate = 1 - normPass;
					if (failRate > rules.wrongFiringThreshold) {
						failingArms[a] = { failRate: Number(failRate.toFixed(4)), mean: r.mean, of: r.of };
					}
				}
				if (Object.keys(failingArms).length > 0) {
					const target = `${pr.scenario}/${pr.property}`;
					const trigger = `trigger or scope of ${(def.guidance ?? [target]).join(", ")} is narrowed`;
					candidates.push({
						rule: "wrong-firing",
						target,
						summary: `Precision property ${target} exceeded the ${rules.wrongFiringThreshold} wrong-firing threshold in guided arm(s): ${Object.entries(failingArms).map(([a, v]) => `${a} (${v.failRate})`).join(", ")}.`,
						evidence: failingArms,
						revivalTrigger: trigger,
						draftBacklogRow: `| **B-TBD** | S3 | A12 signal | **Precision property \`${target}\` wrong-firing rate exceeded ${rules.wrongFiringThreshold} in ${Object.keys(failingArms).join(", ")}.** | \`[M, run ${o.result.run} RESULT.json]\` | open - TRIGGER: ${trigger} |`,
					});
				}
			}
		}

		// Rule 3 (knows-not-acts): pairs-weighted metNot rate across guided arms per guidance id.
		const byGuidance = new Map<string, { metNotPairs: number; totalPairs: number }>();
		for (const row of o.result.link) {
			if (!guidedArms.includes(row.arm) || row.pairs <= 0) continue;
			const cur = byGuidance.get(row.guidance) ?? { metNotPairs: 0, totalPairs: 0 };
			cur.metNotPairs += row.metNot * row.pairs;
			cur.totalPairs += row.pairs;
			byGuidance.set(row.guidance, cur);
		}
		for (const [gid, agg] of [...byGuidance.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			if (agg.totalPairs <= 0) continue;
			const rate = agg.metNotPairs / agg.totalPairs;
			if (rate > rules.knowsNotActsThreshold) {
				const trigger = `salience or hydration trigger of ${gid} is revised`;
				candidates.push({
					rule: "knows-not-acts",
					target: gid,
					summary: `Guidance entry ${gid} has a pairs-weighted metNot (knows but does not act) rate of ${rate.toFixed(2)} across guided arms (threshold > ${rules.knowsNotActsThreshold}).`,
					evidence: { guidance: gid, metNotRate: Number(rate.toFixed(4)), pairs: agg.totalPairs },
					revivalTrigger: trigger,
					draftBacklogRow: `| **B-TBD** | S3 | A12 signal | **Agents know \`${gid}\` when asked but do not act on it (metNot rate ${rate.toFixed(2)} across ${agg.totalPairs} pairs).** | \`[M, run ${o.result.run} RESULT.json link]\` | open - TRIGGER: ${trigger} |`,
				});
			}
		}
	}

	// Rule 4 (chain-threshold): any finding in result.chain.rows with meets === true.
	for (const row of o.result.chain?.rows ?? []) {
		if (!row.meets) continue;
		const trigger = `component or entry addressed by finding ${row.id} is revised`;
		candidates.push({
			rule: "chain-threshold",
			target: row.id,
			summary: `Chain finding ${row.id} met threshold: ${row.scenarios.length} scenario(s), ${row.heldOut.length} held-out (${row.heldOut.join(", ")}), ${row.families.length} families (${row.families.join(", ")}).`,
			evidence: { id: row.id, readers: row.readers, scenarios: row.scenarios, heldOut: row.heldOut, families: row.families },
			revivalTrigger: trigger,
			draftBacklogRow: `| **B-TBD** | S3 | A3 signal | **Finding \`${row.id}\` met cross-family threshold (${row.scenarios.length} scenarios, held-out: ${row.heldOut.join(", ")}, families: ${row.families.join(", ")}).** | \`[M, run ${o.result.run} RESULT.json chain]\` | open - TRIGGER: ${trigger} |`,
		});
	}

	return {
		run: o.result.run,
		createdAt: now().toISOString(),
		rules,
		guidedArms,
		candidates,
	};
}

export function candidatesMarkdown(packet: CandidatesPacket): string {
	const lines = [
		`# Candidate findings - ${packet.run}`, "",
		`Generated at ${packet.createdAt}. Guided arms: ${packet.guidedArms.join(", ") || "none"}.`,
		"Candidates are evidence for project triage (P9); no project backlog was modified.", "",
	];
	if (packet.candidates.length === 0) {
		lines.push("No candidate finding met its threshold.");
		return lines.join("\n") + "\n";
	}
	lines.push("| Rule | Target | Summary | Revival trigger |", "|---|---|---|---|");
	for (const c of packet.candidates) {
		lines.push(`| \`${c.rule}\` | \`${c.target}\` | ${c.summary} | ${c.revivalTrigger} |`);
	}
	lines.push("", "## Draft backlog rows", "");
	for (const c of packet.candidates) {
		lines.push(c.draftBacklogRow);
	}
	return lines.join("\n") + "\n";
}

/**
 * Evaluates candidates for `result` and `loaded`, writes `CANDIDATES.json` and `CANDIDATES.md` in
 * `recordsDir`, and returns the packet.
 */
export function writeCandidates(
	loaded: LoadedPack,
	result: Result,
	scenarios: Map<string, Scenario>,
	recordsDir: string,
	now?: () => Date,
): CandidatesPacket {
	const guidedArms = loaded.pack.arms.filter((a) => a.deliver.length > 0 && result.arms.includes(a.id)).map((a) => a.id);
	const packet = evaluateCandidates({
		result,
		scenarios,
		guidedArms,
		...(loaded.pack.findingRules !== undefined ? { rules: loaded.pack.findingRules } : {}),
		...(now !== undefined ? { now } : {}),
	});
	const resolved = path.resolve(recordsDir);
	fs.writeFileSync(path.join(resolved, "CANDIDATES.json"), JSON.stringify(packet, null, 2) + "\n");
	fs.writeFileSync(path.join(resolved, "CANDIDATES.md"), candidatesMarkdown(packet));
	return packet;
}

/**
 * Loads `packDir` and `recordsDir`, writes `CANDIDATES.json` and `CANDIDATES.md` in `recordsDir`,
 * and appends state `"candidates-written"` to `run.json`.
 */
export async function writeRunCandidates(packDir: string, recordsDir: string, now: () => Date = () => new Date()): Promise<CandidatesPacket> {
	const checked = await checkPack(packDir);
	if (!checked.ok) throw new Error(`the pack fails its check: ${checked.defects.map((d) => `${d.check} ${d.where} ${d.message}`).join("; ")}`);
	const resolved = path.resolve(recordsDir);
	const record = JSON.parse(fs.readFileSync(path.join(resolved, "run.json"), "utf8")) as RunRecord;
	const result = JSON.parse(fs.readFileSync(path.join(resolved, "RESULT.json"), "utf8")) as Result;
	const scenarios = new Map(record.snapshot.scenarios.map((s) => [s.id, s]));
	const packet = writeCandidates(checked.loaded, result, scenarios, resolved, now);
	if (!record.states.some((s) => s.state === "candidates-written")) {
		record.states.push({ state: "candidates-written", at: now().toISOString() });
		fs.writeFileSync(path.join(resolved, "run.json"), JSON.stringify(record, null, 2) + "\n");
	}
	return packet;
}
