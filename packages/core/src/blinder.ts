// blinder - blinds valid outcomes for judging (architecture section 5, principle P3).
//
// Each judged unit is one cell's judged properties together, or, for a property that names an
// answer heading, that property alone with its answer. A unit's text is masked - the pack's
// identifier patterns replaced with [ID], the workspace's path removed - and given an opaque id.
// The mapping from opaque ids to cells is sealed in the run record, beside the time each unit was
// blinded, and the blinder refuses any unit whose code scores were not all taken before that time
// (criterion E14). An absent answer is not judged; it scores 0, and is recorded as absent.

import { createHash } from "node:crypto";
import type { CellRecord } from "./run-conductor.js";
import type { LoadedPack, Property, Scenario } from "./pack-schema.js";

export interface Unit {
	id: string;
	cell: string;
	scenario: string;
	arm: string;
	member: string;
	family: string;
	properties: string[];
	text: string;
	blindedAt: string;
}

export interface Absent {
	cell: string;
	property: string;
}

export interface Blinded {
	seed: string;
	units: Unit[];
	absent: Absent[];
}

function rng(seed: string): () => number {
	let a = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
	return () => {
		a = (a + 1831565813) >>> 0; // the mulberry32 increment, in decimal
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffle<T>(xs: T[], seed: string): T[] {
	const rand = rng(seed);
	const a = xs.slice();
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
	return a;
}

export function mask(text: string, loaded: LoadedPack, paths: string[]): string {
	let out = text;
	for (const p of [...paths].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(`${p}/`).join("").split(p).join(".");
	for (const pattern of loaded.pack.masks.identifiers) out = out.replace(new RegExp(pattern, "g"), "[ID]");
	return out;
}

const judged = (s: Scenario): Property[] => s.properties.filter((p) => p.decidedBy === "judge");

export function blind(loaded: LoadedPack, scenarios: Map<string, Scenario>, cells: CellRecord[], families: Map<string, string>, seed: string, now: () => Date = () => new Date()): Blinded {
	const units: Unit[] = [];
	const absent: Absent[] = [];
	for (const c of cells) {
		if (!c.valid) continue;
		const s = scenarios.get(c.scenario);
		if (!s) throw new Error(`no scenario ${c.scenario}`);
		const last = c.attempts[c.attempts.length - 1]!;
		const paths = [last.workspace ?? ""];
		const base = { cell: c.cell, scenario: c.scenario, arm: c.arm, member: c.member, family: families.get(c.member) ?? "" };
		const plain = judged(s).filter((p) => p.answerHeading === undefined);
		if (plain.length) {
			const text = `--- FINAL MESSAGE ---\n${mask(c.final ?? "", loaded, paths)}\n--- DIFF ---\n${mask(c.diff ?? "", loaded, paths).trim() || "(no changes)"}\n`;
			units.push({ id: "", ...base, properties: plain.map((p) => p.id), text, blindedAt: "" });
		}
		for (const p of judged(s).filter((x) => x.answerHeading !== undefined)) {
			const answer = c.answers[p.id];
			if (answer === null || answer === undefined) absent.push({ cell: c.cell, property: p.id });
			else units.push({ id: "", ...base, properties: [p.id], text: `--- ANSWER ---\n${mask(answer, loaded, paths)}\n`, blindedAt: "" });
		}
	}
	const ordered = shuffle(units, seed);
	ordered.forEach((u, i) => {
		u.id = `u${String(i + 1).padStart(4, "0")}`;
		u.blindedAt = now().toISOString();
		const cell = cells.find((c) => c.cell === u.cell)!;
		for (const cs of cell.codeScores) if (!(cs.measuredAt < u.blindedAt)) throw new Error(`code score ${cs.property} of ${u.cell} was not taken before its outcome was blinded`);
	});
	return { seed, units: ordered, absent };
}
