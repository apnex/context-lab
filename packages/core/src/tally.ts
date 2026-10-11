// tally - computes results per factor (architecture section 5, principle P8).
//
// From the run record's cells, the sealed units and the votes, it computes each property's value
// for each cell, then rates per arm and per arm and population member. A judged property's value
// for a cell is the mean of its assigned votes, and incomplete if any assigned vote is missing; a
// code property's value is its code score. A cell invalid for agent behaviour scores 0 on every
// property, since it reached none; a cell invalid for any other cause is excluded and listed; an
// absent answer scores 0 and is flagged. The tally reads only files, so re-running it on a run
// record gives the same result.

import type { Unit, Absent } from "./blinder.js";
import type { Vote } from "./judge-panel.js";
import type { CellRecord } from "./run-conductor.js";
import type { Scenario } from "./pack-schema.js";

export interface Rate { mean: number | null; of: number; incomplete: number }

export interface PropertyResult {
	scenario: string;
	property: string;
	byArm: Record<string, Rate>;
	byArmMember: Record<string, Record<string, Rate>>;
	agreement: { agree: number; of: number };
}

export interface Result {
	run: string;
	status: string;
	arms: string[];
	members: string[];
	properties: PropertyResult[];
	totals: Record<string, number>;
	excluded: { cell: string; cause: string }[];
	absent: Absent[];
	guesses: { right: number; all: number; byGuess: Record<string, number>; baseRate: number | null };
	cellValues: Record<string, Record<string, number | "incomplete">>;
}

export interface TallyInput {
	run: string;
	status: string;
	arms: string[];
	members: string[];
	scenarios: Map<string, Scenario>;
	cells: CellRecord[];
	units: Unit[];
	absent: Absent[];
	votes: Vote[];
	assigned: (unit: Unit) => string[];
	guessGroups: Record<string, string[]>;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function tally(t: TallyInput): Result {
	const cellValues: Result["cellValues"] = {};
	const excluded: Result["excluded"] = [];
	const agreement = new Map<string, { agree: number; of: number }>();
	for (const c of t.cells) {
		const s = t.scenarios.get(c.scenario)!;
		const last = c.attempts[c.attempts.length - 1]!;
		if (!c.valid) {
			const cause = last.validity.valid ? "unknown" : last.validity.cause;
			if (cause === "behaviour") cellValues[c.cell] = Object.fromEntries(s.properties.map((p) => [p.id, 0]));
			else excluded.push({ cell: c.cell, cause });
			continue;
		}
		const v: Record<string, number | "incomplete"> = {};
		for (const p of s.properties) {
			if (p.decidedBy === "code") {
				const cs = c.codeScores.find((x) => x.property === p.id);
				v[p.id] = cs !== undefined && "value" in cs ? cs.value : "incomplete";
				continue;
			}
			if (t.absent.some((a) => a.cell === c.cell && a.property === p.id)) { v[p.id] = 0; continue; }
			const unit = t.units.find((u) => u.cell === c.cell && u.properties.includes(p.id));
			if (!unit) { v[p.id] = "incomplete"; continue; }
			const judges = t.assigned(unit);
			const vs = judges.map((j) => t.votes.find((x) => x.unit === unit.id && x.property === p.id && x.judge === j)?.value ?? null);
			const complete = vs.length > 0 && vs.every((x) => x !== null);
			v[p.id] = complete ? mean(vs as number[])! : "incomplete";
			const key = `${s.id}/${p.id}`;
			const ag = agreement.get(key) ?? { agree: 0, of: 0 };
			if (complete) { ag.of++; if ((vs as number[]).every((x) => x === vs[0])) ag.agree++; }
			agreement.set(key, ag);
		}
		cellValues[c.cell] = v;
	}
	const rate = (cells: CellRecord[], pid: string): Rate => {
		const vals = cells.filter((c) => cellValues[c.cell] !== undefined).map((c) => cellValues[c.cell]![pid]);
		const ok = vals.filter((x): x is number => typeof x === "number");
		return { mean: mean(ok), of: ok.length, incomplete: vals.length - ok.length };
	};
	const properties: PropertyResult[] = [];
	for (const s of t.scenarios.values()) for (const p of s.properties) {
		const cells = t.cells.filter((c) => c.scenario === s.id);
		properties.push({
			scenario: s.id, property: p.id,
			byArm: Object.fromEntries(t.arms.map((a) => [a, rate(cells.filter((c) => c.arm === a), p.id)])),
			byArmMember: Object.fromEntries(t.arms.map((a) => [a, Object.fromEntries(t.members.map((m) => [m, rate(cells.filter((c) => c.arm === a && c.member === m), p.id)]))])),
			agreement: agreement.get(`${s.id}/${p.id}`) ?? { agree: 0, of: 0 },
		});
	}
	const totals = Object.fromEntries(t.arms.map((a) => [a, properties.reduce((sum, p) => sum + (p.byArm[a]!.mean ?? 0), 0)]));
	const groupOf = (arm: string): string | undefined => Object.entries(t.guessGroups).find(([, arms]) => arms.includes(arm))?.[0];
	const guesses = { right: 0, all: 0, byGuess: {} as Record<string, number>, baseRate: null as number | null };
	const seen = new Set<string>();
	for (const v of t.votes) {
		const key = `${v.unit}.${v.judge}`;
		if (v.guess === null || seen.has(key)) continue;
		seen.add(key);
		const unit = t.units.find((u) => u.id === v.unit)!;
		guesses.all++;
		guesses.byGuess[v.guess] = (guesses.byGuess[v.guess] ?? 0) + 1;
		if (groupOf(unit.arm) === v.guess) guesses.right++;
	}
	const groups = Object.keys(t.guessGroups);
	if (t.units.length && groups.length) {
		const largest = Math.max(...groups.map((g) => t.units.filter((u) => groupOf(u.arm) === g).length));
		guesses.baseRate = largest / t.units.length;
	}
	return { run: t.run, status: t.status, arms: t.arms, members: t.members, properties, totals, excluded, absent: t.absent, guesses, cellValues };
}

const fmt = (r: Rate): string => (r.mean === null ? "-" : `${r.mean.toFixed(2)} (${r.of})`) + (r.incomplete ? ` +${r.incomplete} inc` : "");

export function resultMarkdown(r: Result, limits: string[]): string {
	const lines = [
		`# Result - ${r.run}`, "",
		`Status: **${r.status}**.`, "",
		"## Limits", "", ...limits.map((l) => `- ${l}`), "",
		"## Properties", "",
		`| Scenario | Property | ${r.arms.join(" | ")} | votes agree |`, `|---|---|${r.arms.map(() => "---").join("|")}|---|`,
		...r.properties.map((p) => `| ${p.scenario} | ${p.property} | ${r.arms.map((a) => fmt(p.byArm[a]!)).join(" | ")} | ${p.agreement.of ? `${p.agreement.agree}/${p.agreement.of}` : "-"} |`),
		"", `Totals: ${r.arms.map((a) => `${a} ${r.totals[a]!.toFixed(2)}`).join(", ")}.`, "",
		`Judges guessed the condition right ${r.guesses.right} of ${r.guesses.all} times; always guessing the largest condition would score ${r.guesses.baseRate === null ? "-" : `${Math.round(r.guesses.baseRate * 100)}%`}.`, "",
		r.excluded.length ? `Excluded cells: ${r.excluded.map((e) => `${e.cell} (${e.cause})`).join(", ")}.` : "No cell excluded.", "",
		r.absent.length ? `Absent answers, scored 0: ${r.absent.map((a) => `${a.cell} ${a.property}`).join(", ")}.` : "No answer absent.", "",
	];
	return lines.join("\n");
}
