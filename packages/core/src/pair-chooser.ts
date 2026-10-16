// pair-chooser - chooses outcome pairs for a person (architecture section 5, principle P3; Delta-3
// stage 1, criteria G1-G3).
//
// Two modes:
//   1. Preference pairs: pairs items (each with a "with" and "without" version) and flips display
//      order (A vs B) deterministically from "<seed>:<id>".
//   2. Calibration pairs (0004, mission-kit 0085): from one run's judged outcomes, enumerates all
//      candidate pairs (u1, u2) with u1.id < u2.id within the same scenario, arm, phase and
//      property whose judge-mean scores m1 and m2 are both numbers and m1 !== m2. Pairs where at
//      least one outcome scored at or above the property scale's midpoint are ordered ahead of
//      pairs where both scored below, each partition shuffled with "<seed>:calibration".

import { createHash } from "node:crypto";
import { shuffle, type Unit } from "./blinder.js";
import type { Vote } from "./judge-panel.js";
import { propertiesOf, type Property, type Scenario } from "./pack-schema.js";

/** Deterministic bit flip from a seed and item id, matching eval-human.mjs's flipFor. */
export function flipFor(seed: string, id: string): boolean {
	return parseInt(createHash("sha256").update(`${seed}:${id}`).digest("hex").slice(0, 2), 16) % 2 === 1;
}

export interface PreferenceItem {
	id: string;
	move: string;
	scenario: string;
	with: string;
	without: string;
}

export interface PreferencePair {
	kind: "preference";
	id: string;
	move: string;
	scenario: string;
	shownA: "with" | "without";
	textA: string;
	textB: string;
}

/** Chooses display order for preference items, deterministically from `seed`. */
export function choosePreferencePairs(items: PreferenceItem[], seed: string): PreferencePair[] {
	return items.map((it) => {
		const flip = flipFor(seed, it.id);
		const shownA: "with" | "without" = flip ? "with" : "without";
		return {
			kind: "preference",
			id: it.id,
			move: it.move,
			scenario: it.scenario,
			shownA,
			textA: flip ? it.with : it.without,
			textB: flip ? it.without : it.with,
		};
	});
}

export interface CalibrationPair {
	kind: "calibration";
	id: string;
	scenario: string;
	arm: string;
	phase: string;
	property: string;
	unitA: string;
	unitB: string;
	meanA: number;
	meanB: number;
	shownA: string;
	higher: "a" | "b";
	textA: string;
	textB: string;
}

export interface CalibrationOptions {
	units: Unit[];
	votes: Vote[];
	scenarios: Map<string, Scenario>;
	assigned: (unit: Unit) => string[];
	seed: string;
	count?: number;
}

const meanOf = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Chooses up to `count` (by default 8) calibration pairs from a run's judged outcomes. Pairs come
 * from the same scenario, arm, phase and property, have differing judge means, and over-sample
 * outcomes where at least one judge mean is at or above the property scale's midpoint.
 */
export function chooseCalibrationPairs(o: CalibrationOptions): CalibrationPair[] {
	const count = o.count ?? 8;
	const propDef = new Map<string, Property>();
	for (const [sid, s] of o.scenarios) {
		for (const p of propertiesOf(s)) propDef.set(`${sid}/${p.id}`, p);
	}
	// Group scored units by (scenario, arm, phase, property).
	const groups = new Map<string, { scenario: string; arm: string; phase: string; property: string; items: { unit: Unit; mean: number }[] }>();
	for (const u of o.units) {
		const judges = o.assigned(u);
		if (!judges.length) continue;
		for (const pid of u.properties) {
			const vs = judges.map((j) => o.votes.find((v) => v.unit === u.id && v.property === pid && v.judge === j)?.value ?? null);
			if (!vs.every((x): x is number => typeof x === "number")) continue;
			const m = meanOf(vs)!;
			const phase = u.phase ?? "";
			const key = JSON.stringify([u.scenario, u.arm, phase, pid]);
			const g = groups.get(key) ?? { scenario: u.scenario, arm: u.arm, phase, property: pid, items: [] };
			g.items.push({ unit: u, mean: m });
			groups.set(key, g);
		}
	}

	interface Candidate {
		id: string;
		scenario: string;
		arm: string;
		phase: string;
		property: string;
		u1: Unit;
		m1: number;
		u2: Unit;
		m2: number;
		high: boolean;
	}
	const candidates: Candidate[] = [];
	for (const g of groups.values()) {
		const p = propDef.get(`${g.scenario}/${g.property}`);
		const mid = p ? (p.scale[0] + p.scale[1]) / 2 : 0.5;
		const sorted = [...g.items].sort((a, b) => (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0));
		for (let i = 0; i < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) {
				const a = sorted[i]!, b = sorted[j]!;
				if (a.mean === b.mean) continue;
				const id = `${g.scenario}/${g.arm}/${g.property}:${a.unit.id}:${b.unit.id}`;
				candidates.push({
					id, scenario: g.scenario, arm: g.arm, phase: g.phase, property: g.property,
					u1: a.unit, m1: a.mean, u2: b.unit, m2: b.mean,
					high: Math.max(a.mean, b.mean) >= mid,
				});
			}
		}
	}
	const byId = (a: Candidate, b: Candidate): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const high = shuffle(candidates.filter((c) => c.high).sort(byId), `${o.seed}:calibration`);
	const low = shuffle(candidates.filter((c) => !c.high).sort(byId), `${o.seed}:calibration`);
	const chosen = [...high, ...low].slice(0, count);
	return chosen.map((c) => {
		const flip = flipFor(o.seed, c.id);
		const aUnit = flip ? c.u2 : c.u1;
		const bUnit = flip ? c.u1 : c.u2;
		const meanA = flip ? c.m2 : c.m1;
		const meanB = flip ? c.m1 : c.m2;
		return {
			kind: "calibration",
			id: c.id,
			scenario: c.scenario,
			arm: c.arm,
			phase: c.phase,
			property: c.property,
			unitA: aUnit.id,
			unitB: bUnit.id,
			meanA,
			meanB,
			shownA: aUnit.id,
			higher: meanA > meanB ? "a" : "b",
			textA: aUnit.text,
			textB: bUnit.text,
		};
	});
}
