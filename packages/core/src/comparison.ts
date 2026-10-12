// comparison - the threshold deriver and the comparator (architecture section 5; Delta-2 section 1).
// Both flag and never decide.
//
// Values. A property's value in a cell run is the tally's, as a fraction of the property's scale -
// (v - bottom) / (top - bottom) - so a rate is a pass rate for a property scored 0 or 1. A present
// cell run is one the tally counted: valid, or invalid for agent behaviour and scored at the bottom;
// a cell run excluded for another cause is not present. An incomplete value counts in no rate.
//
// The standardised drop of a property from set A to set B is
//   d = (rateA - rateB) / sqrt(p (1 - p) (1/nA + 1/nB)),
// rateA and rateB the means over each set's values, nA and nB their counts, and p the mean over
// both sets' values together; d = 0 where p is 0 or 1 or either set has no value. With nA = nB = n
// it is section 1's (rateA - rateB) / sqrt(2 p (1 - p) / n). A drop is signed: A is the base.
//
// Held-out scenarios' properties take part in no threshold and no main flag: a comparison reports
// them in its held-out section only.

import fs from "node:fs";
import path from "node:path";
import { rng, shuffleWith } from "./blinder.js";
import { contentHash, type Exposure } from "./experiment-register.js";
import { propertiesOf, type Comparison, type LoadedPack, type Property, type Scenario } from "./pack-schema.js";
import { tallyRun, type CellRecord, type RunRecord } from "./run-conductor.js";
import type { Result } from "./tally.js";

// ---------------------------------------------------------------- the outcome table

export interface TableProperty { scenario: string; id: string; property: Property; heldOut: boolean }

export interface Table {
	dir: string;
	record: RunRecord;
	result: Result;
	/** Present cell runs, of every arm, with their values as fractions of each property's scale. */
	cells: { cell: string; scenario: string; arm: string; member: string; run: number; traps: unknown; values: Record<string, number | null> }[];
	properties: TableProperty[];
	/** Every cell run of the record, present or not, by its scenario, arm, member and run. */
	keys: Map<string, CellRecord>;
}

/** A run record read as a table of present cell runs, counting only runs 1 to `runs` if given. */
export function readTable(dir: string, runs?: number): Table {
	const record = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
	const result = tallyRun(dir, { ...(runs !== undefined ? { runs } : {}), write: false });
	const scenarios = new Map<string, Scenario>(record.snapshot.scenarios.map((s) => [s.id, s]));
	const properties: TableProperty[] = [...scenarios.values()].flatMap((s) => propertiesOf(s).map((p) => ({ scenario: s.id, id: p.id, property: p, heldOut: s.heldOut === true })));
	const keys = new Map<string, CellRecord>();
	const cells: Table["cells"] = [];
	for (const id of record.cells) {
		const c = JSON.parse(fs.readFileSync(path.join(dir, "cells", `${id}.json`), "utf8")) as CellRecord;
		if (runs !== undefined && c.run > runs) continue;
		keys.set(JSON.stringify([c.scenario, c.arm, c.member, c.run]), c);
		const raw = result.cellValues[c.cell] ?? result.heldOutCellValues[c.cell];
		if (raw === undefined) continue;
		const values: Record<string, number | null> = {};
		for (const p of properties.filter((x) => x.scenario === c.scenario)) {
			const v = raw[p.id];
			values[p.id] = typeof v === "number" ? (v - p.property.scale[0]) / (p.property.scale[1] - p.property.scale[0]) : null;
		}
		cells.push({ cell: c.cell, scenario: c.scenario, arm: c.arm, member: c.member, run: c.run, traps: c.traps ?? [], values });
	}
	return { dir, record, result, cells, properties, keys };
}

type Cell = Table["cells"][number];

const valuesOf = (cells: Cell[], pid: string): number[] => cells.map((c) => c.values[pid]).filter((v): v is number => typeof v === "number");
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The standardised drop of one property from set A to set B; see the header. */
export function standardisedDrop(a: number[], b: number[]): number {
	if (!a.length || !b.length) return 0;
	const p = (a.reduce((x, y) => x + y, 0) + b.reduce((x, y) => x + y, 0)) / (a.length + b.length);
	if (p <= 0 || p >= 1) return 0;
	return (mean(a)! - mean(b)!) / Math.sqrt(p * (1 - p) * (1 / a.length + 1 / b.length));
}

// ---------------------------------------------------------------- the threshold deriver

export const SPLITS = 1000;
export const SIZES = [3, 9] as const;
export const MIN_POOL = 12;

export interface ThresholdSet {
	comparison: string;
	experiment: string;
	run: string;
	/** The experiment's content hash, which seeds the splits. */
	hash: string;
	m: number;
	splits: number;
	/** Per size: the threshold a largest drop must exceed strictly to flag. */
	thresholds: { "3": number; "9": number };
	/** From the size-9 splits, nested so their first three runs per side are size-3 sets: how often the two-stage rule flags a persisting drop. */
	twoStageRate: number;
	/** The actual base-against-head largest drop, and how many of the size-9 splits' largest drops are strictly below it. */
	drift: { actual: number; below: number; of: number };
	/** Present runs per pool, by scenario and member. */
	pools: Record<string, number>;
	recordedAt: string;
}

interface Pool { scenario: string; member: string; runs: Cell[] }

/**
 * Derives thresholds from one A/A run. For each scenario and member, the pool is its present cell
 * runs of the comparison's two arms, ordered by arm then run, ids compared by code point. For a size k, one generator - the
 * blinder's, seeded with "<hash>:<k>" - draws 1000 splits: for each split, for each pool in order of
 * scenario then member, by code point, it shuffles the pool (Fisher-Yates, as the blinder does) and takes the
 * first k' = min(k, floor(n_pool / 2)) runs as set A and the next k' as set B. A split's largest
 * drop is the largest d over the m properties; the threshold is the 900th of the sorted 1000.
 * The two-stage rate uses the size-9 splits, their size-3 sets the first min(3, k') runs of each
 * side of each pool: a split counts if some property's size-3 drop exceeds the size-3 threshold and
 * its size-9 drop exceeds the size-9 threshold.
 */
export function deriveThresholds(table: Table, comparison: Comparison, now: Date = new Date()): ThresholdSet {
	if (comparison.rule !== "aa") throw new Error(`comparison ${comparison.id} is a ${comparison.rule} rule; thresholds are derived for the A/A rule`);
	const rec = table.record;
	if (rec.experiment !== comparison.experiment) throw new Error(`run ${rec.run} is of experiment ${rec.experiment}, not ${comparison.experiment}`);
	if (rec.register === null) throw new Error(`run ${rec.run}'s experiment was not recorded, so it has no hash to seed the splits`);
	if (rec.runsPerCell !== 9) throw new Error(`run ${rec.run} has ${rec.runsPerCell} runs per cell; the deriver takes an A/A run at nine`);
	for (const a of [comparison.base, comparison.head]) if (!rec.snapshot.arms.includes(a)) throw new Error(`run ${rec.run} has no arm ${a}`);
	const props = table.properties.filter((p) => !p.heldOut);
	const m = comparison.m ?? props.length;
	if (m !== props.length) throw new Error(`comparison ${comparison.id} declares m = ${m}, but the run's experiment holds ${props.length} properties outside held-out scenarios`);
	const pools: Pool[] = [];
	const scen = [...new Set(table.cells.map((c) => c.scenario))].filter((s) => props.some((p) => p.scenario === s)).sort();
	for (const s of scen) for (const mem of [...rec.population].sort()) {
		const runs = table.cells.filter((c) => c.scenario === s && c.member === mem && (c.arm === comparison.base || c.arm === comparison.head))
			.sort((a, b) => (a.arm < b.arm ? -1 : a.arm > b.arm ? 1 : a.run - b.run));
		pools.push({ scenario: s, member: mem, runs });
	}
	for (const s of [...new Set(props.map((p) => p.scenario))]) for (const mem of rec.population) if (!pools.some((p) => p.scenario === s && p.member === mem)) pools.push({ scenario: s, member: mem, runs: [] });
	const small = pools.filter((p) => p.runs.length < MIN_POOL);
	if (small.length) throw new Error(`a pool has fewer than ${MIN_POOL} present runs: ${small.map((p) => `${p.scenario}/${p.member} ${p.runs.length}`).join(", ")}`);
	const largest = (a: Cell[], b: Cell[]): number => Math.max(...props.map((p) => standardisedDrop(valuesOf(a.filter((c) => c.scenario === p.scenario), p.id), valuesOf(b.filter((c) => c.scenario === p.scenario), p.id))));
	const draw = (k: number): { a: Cell[]; b: Cell[]; a3: Cell[]; b3: Cell[] }[] => {
		const rand = rng(`${rec.register!.hash}:${k}`);
		const out: { a: Cell[]; b: Cell[]; a3: Cell[]; b3: Cell[] }[] = [];
		for (let i = 0; i < SPLITS; i++) {
			const split = { a: [] as Cell[], b: [] as Cell[], a3: [] as Cell[], b3: [] as Cell[] };
			for (const pool of pools) {
				const sh = shuffleWith(pool.runs, rand);
				const kk = Math.min(k, Math.floor(pool.runs.length / 2));
				const a = sh.slice(0, kk), b = sh.slice(kk, 2 * kk);
				split.a.push(...a); split.b.push(...b);
				split.a3.push(...a.slice(0, Math.min(3, kk))); split.b3.push(...b.slice(0, Math.min(3, kk)));
			}
			out.push(split);
		}
		return out;
	};
	const ninth = (xs: number[]): number => [...xs].sort((x, y) => x - y)[899]!;
	const s3 = draw(3).map((s) => largest(s.a, s.b));
	const splits9 = draw(9);
	const s9 = splits9.map((s) => largest(s.a, s.b));
	const t3 = ninth(s3), t9 = ninth(s9);
	const persisting = splits9.filter((s) => props.some((p) => {
		const v = (cs: Cell[]): number[] => valuesOf(cs.filter((c) => c.scenario === p.scenario), p.id);
		return standardisedDrop(v(s.a3), v(s.b3)) > t3 && standardisedDrop(v(s.a), v(s.b)) > t9;
	})).length;
	const base = table.cells.filter((c) => c.arm === comparison.base), head = table.cells.filter((c) => c.arm === comparison.head);
	const actual = largest(base, head);
	return {
		comparison: comparison.id, experiment: rec.experiment, run: rec.run, hash: rec.register.hash, m, splits: SPLITS,
		thresholds: { "3": t3, "9": t9 }, twoStageRate: persisting / SPLITS,
		drift: { actual, below: s9.filter((x) => x < actual).length, of: SPLITS },
		pools: Object.fromEntries(pools.map((p) => [`${p.scenario}/${p.member}`, p.runs.length])), recordedAt: now.toISOString(),
	};
}

/** Refuses a comparison whose two arms deliver different things: an A/A run's arms are identical. */
export function assertIdenticalArms(loaded: LoadedPack, comparison: Comparison, run?: RunRecord): void {
	// The arms read are the pack's now; they are the run's only if the experiment is unchanged since the run's record.
	if (run !== undefined && (run.register === null || run.register.hash !== contentHash(loaded, comparison.experiment))) throw new Error(`the pack's experiment ${comparison.experiment} has changed since run ${run.run} was recorded, so its arms may not be the run's`);
	const deliver = (id: string): string => canonical(loaded.pack.arms.find((a) => a.id === id)?.deliver ?? null);
	if (deliver(comparison.base) !== deliver(comparison.head)) throw new Error(`arms ${comparison.base} and ${comparison.head} deliver different things, so a run of them is not an A/A run`);
}

/** Threshold sets are kept per comparison, one JSON line each, appended and never rewritten. */
export const thresholdFile = (loaded: LoadedPack, comparison: string): string => path.resolve(loaded.dir, "register", "thresholds", `${comparison}.jsonl`);

export function readThresholds(loaded: LoadedPack, comparison: string): ThresholdSet[] {
	const f = thresholdFile(loaded, comparison);
	if (!fs.existsSync(f)) return [];
	return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as ThresholdSet);
}

export function recordThresholds(loaded: LoadedPack, set: ThresholdSet): void {
	const f = thresholdFile(loaded, set.comparison);
	const prior = readThresholds(loaded, set.comparison);
	const last = prior[prior.length - 1];
	if (last !== undefined && last.recordedAt >= set.recordedAt) throw new Error(`a threshold set at ${last.recordedAt} is not earlier than ${set.recordedAt}`);
	if (fs.existsSync(f) && fs.statSync(f).size > 0 && !fs.readFileSync(f, "utf8").endsWith("\n")) throw new Error(`${f} does not end with a newline, so it was edited by hand`);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.appendFileSync(f, JSON.stringify(set) + "\n");
}

// ---------------------------------------------------------------- the comparator

export interface Side { dir: string; arm: string; runs?: number }

export interface CompareInput {
	comparison: Comparison;
	base: Side;
	head: Side;
	/** For the A/A rule: base and head at nine runs, supplied by the caller, for persistence. */
	nine?: { base: Side; head: Side };
	/** For the A/A rule: the threshold set to compare against. */
	thresholds?: ThresholdSet;
}

export interface Flag {
	scenario: string;
	property: string;
	/** Why it flags: the drop and what it exceeded, or that the head has no mean. */
	reason: string;
	drop?: number;
	/** The A/A rule: whether the drop persists at nine runs; null where nine-run results were not supplied. */
	persisting?: boolean | null;
	/** The improve rule: the families in which the head is worse. */
	families?: string[];
}

export interface ComparisonResult {
	rule: { id: string; rule: Comparison["rule"]; experiment: string; base: string; head: string; m?: number; tolerance?: number };
	inputs: { base: { run: string; arm: string; runs: number }; head: { run: string; arm: string; runs: number }; nine: { base: { run: string; arm: string }; head: { run: string; arm: string } } | null; thresholds: { run: string; recordedAt: string; m: number; "3": number; "9": number } | null };
	flags: Flag[];
	heldOut: { flags: Flag[]; properties: string[] };
	exposed: Exposure[];
	limits: string[];
}

const canonical = (v: unknown): string => {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (typeof v === "object" && v !== null) return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
	return JSON.stringify(v);
};

/** Refuses two sides that differ in anything but the variant revisions under comparison. */
function sameDesign(a: Table, b: Table, aArm: string, bArm: string, aRuns: number | undefined, bRuns: number | undefined): void {
	const ra = a.record, rb = b.record;
	const bad = (what: string): never => { throw new Error(`the inputs differ in ${what}, so they cannot be compared`); };
	if (ra.experiment !== rb.experiment) bad(`experiment (${ra.experiment}, ${rb.experiment})`);
	if (canonical(ra.snapshot.scenarios) !== canonical(rb.snapshot.scenarios)) bad("scenarios");
	// The population is its members as declared - id, family, runtime, model and settings - not their ids alone.
	const pop = (r: RunRecord): string => canonical(r.snapshot.population.filter((mm) => r.population.includes(mm.id)).sort((x, y) => (x.id < y.id ? -1 : 1)));
	if (canonical([...ra.population].sort()) !== canonical([...rb.population].sort()) || pop(ra) !== pop(rb)) bad("population");
	if (ra.runsPerCell !== rb.runsPerCell) bad(`runs per cell (${ra.runsPerCell}, ${rb.runsPerCell})`);
	if (aRuns !== bRuns) bad(`runs counted (${aRuns ?? "all"}, ${bRuns ?? "all"})`);
	for (const [t, arm] of [[a, aArm], [b, bArm]] as const) if (!t.record.snapshot.arms.includes(arm)) bad(`arms: run ${t.record.run} has no arm ${arm}`);
	// Trap assignment: every cell run of one side has a counterpart in the other with the same traps.
	const side = (t: Table, arm: string): Map<string, string> => new Map([...t.keys.values()].filter((c) => c.arm === arm).map((c) => [JSON.stringify([c.scenario, c.member, c.run]), canonical(c.traps ?? [])]));
	const sa = side(a, aArm), sb = side(b, bArm);
	if (sa.size !== sb.size || [...sa.keys()].some((k) => !sb.has(k))) bad("cell runs");
	for (const [k, v] of sa) if (sb.get(k) !== v) bad(`trap assignment (${k})`);
}

/** Compares base and head under a declared rule; it flags, and decides nothing. */
export function compare(input: CompareInput): ComparisonResult {
	const c = input.comparison;
	const base = readTable(input.base.dir, input.base.runs), head = readTable(input.head.dir, input.head.runs);
	sameDesign(base, head, input.base.arm, input.head.arm, input.base.runs, input.head.runs);
	const nine = input.nine ? { base: readTable(input.nine.base.dir, input.nine.base.runs), head: readTable(input.nine.head.dir, input.nine.head.runs) } : null;
	if (nine) {
		sameDesign(nine.base, nine.head, input.nine!.base.arm, input.nine!.head.arm, input.nine!.base.runs, input.nine!.head.runs);
		if (canonical(nine.base.record.snapshot.scenarios) !== canonical(base.record.snapshot.scenarios)) throw new Error("the inputs differ in scenarios, so they cannot be compared");
	}
	const props = base.properties;
	const main = props.filter((p) => !p.heldOut);
	if (c.rule === "aa") {
		// The A/A rule's first stage reads three runs per cell, and persistence reads nine.
		// The runs counted are those the record holds, at most: a restriction past them counts no more.
		const counted = (s: Side, t: Table): number => Math.min(s.runs ?? t.record.runsPerCell, t.record.runsPerCell);
		if (counted(input.base, base) !== 3) throw new Error(`the A/A rule's first stage reads 3 runs per cell, not ${counted(input.base, base)}: restrict the tally to runs 1 to 3`);
		if (nine && (counted(input.nine!.base, nine.base) !== 9 || counted(input.nine!.head, nine.head) !== 9)) throw new Error("the A/A rule reads persistence at 9 runs per cell");
		if (!input.thresholds) throw new Error(`the A/A rule needs a threshold set`);
		if (input.thresholds.m !== main.length) throw new Error(`the threshold set's m is ${input.thresholds.m}, but ${main.length} properties are compared`);
		if (input.thresholds.experiment !== base.record.experiment) throw new Error(`the threshold set is of experiment ${input.thresholds.experiment}, not ${base.record.experiment}`);
	}
	const families = new Map(base.record.snapshot.population.map((mm) => [mm.id, mm.family]));
	const cellsOf = (t: Table, arm: string, p: TableProperty, member?: (m: string) => boolean): Cell[] => t.cells.filter((x) => x.arm === arm && x.scenario === p.scenario && (member === undefined || member(x.member)));
	const flagsFor = (ps: TableProperty[]): Flag[] => {
		const out: Flag[] = [];
		for (const p of ps) {
			const bv = valuesOf(cellsOf(base, input.base.arm, p), p.id), hv = valuesOf(cellsOf(head, input.head.arm, p), p.id);
			const f = { scenario: p.scenario, property: p.id };
			// A property absent from the head - none of its cell runs present - or with no mean there counts as a drop.
			if (!hv.length) {
				// Under the A/A rule, a drop of this kind persists if the head has no value at nine either.
				let persisting: boolean | null = null;
				if (c.rule === "aa" && nine) {
					const b9 = valuesOf(cellsOf(nine.base, input.nine!.base.arm, p), p.id), h9 = valuesOf(cellsOf(nine.head, input.nine!.head.arm, p), p.id);
					persisting = !h9.length || standardisedDrop(b9, h9) > input.thresholds!.thresholds["9"];
				}
				out.push({ ...f, reason: cellsOf(head, input.head.arm, p).length ? "the head has no mean: every value is incomplete" : "absent from the head: none of its cell runs is present", ...(c.rule === "aa" ? { persisting } : {}) });
				continue;
			}
			if (c.rule === "tolerance") {
				const tol = c.tolerance ?? 0;
				if (!bv.length) continue;
				const drop = mean(bv)! - mean(hv)!;
				if (drop > tol) out.push({ ...f, reason: `the rate falls by ${drop.toFixed(4)}, more than the tolerance ${tol}`, drop });
			} else if (c.rule === "aa") {
				const t = input.thresholds!;
				const drop = standardisedDrop(bv, hv);
				if (!(drop > t.thresholds["3"])) continue;
				let persisting: boolean | null = null;
				if (nine) persisting = standardisedDrop(valuesOf(cellsOf(nine.base, input.nine!.base.arm, p), p.id), valuesOf(cellsOf(nine.head, input.nine!.head.arm, p), p.id)) > t.thresholds["9"];
				out.push({ ...f, reason: `the standardised drop ${drop.toFixed(4)} exceeds the size-3 threshold ${t.thresholds["3"].toFixed(4)}`, drop, persisting });
			} else {
				const worse: string[] = [];
				for (const fam of [...new Set(families.values())].sort()) {
					const inFam = (m: string): boolean => families.get(m) === fam;
					const b = valuesOf(cellsOf(base, input.base.arm, p, inFam), p.id), h = valuesOf(cellsOf(head, input.head.arm, p, inFam), p.id);
					if (!b.length) continue;
					if (!h.length || mean(h)! < mean(b)!) worse.push(fam);
				}
				if (worse.length) out.push({ ...f, reason: `the head is worse in ${worse.length} famil${worse.length === 1 ? "y" : "ies"}`, families: worse });
			}
		}
		return out;
	};
	const ex = (t: Table): Exposure[] => t.result.exposed;
	const exposed = [...new Map([...ex(base), ...ex(head)].map((e) => [canonical(e), e])).values()];
	const limits = [
		"A flag is a signal for a person to look at, not a decision.",
		...(c.rule === "aa" ? [
			"Thresholds come from splits of one A/A run, assuming runs within a scenario and member are exchangeable; they hold for the suite, models and runtimes they were derived on, and each is exceeded about one time in ten by chance.",
			nine ? "Persistence was read from the nine-run results supplied." : "No nine-run results were supplied, so persistence was not evaluated.",
		] : []),
		...(c.rule === "improve" ? ["A property flags where the head's rate is below the base's in any family; a family with no base value is not compared."] : []),
		"Properties are not independent; the count of flags is not a count of independent findings.",
	];
	const runsOf = (s: Side, t: Table): number => s.runs ?? t.record.runsPerCell;
	return {
		rule: { id: c.id, rule: c.rule, experiment: c.experiment, base: c.base, head: c.head, ...(c.m !== undefined ? { m: c.m } : {}), ...(c.tolerance !== undefined ? { tolerance: c.tolerance } : {}) },
		inputs: {
			base: { run: base.record.run, arm: input.base.arm, runs: runsOf(input.base, base) }, head: { run: head.record.run, arm: input.head.arm, runs: runsOf(input.head, head) },
			nine: nine ? { base: { run: nine.base.record.run, arm: input.nine!.base.arm }, head: { run: nine.head.record.run, arm: input.nine!.head.arm } } : null,
			thresholds: input.thresholds ? { run: input.thresholds.run, recordedAt: input.thresholds.recordedAt, m: input.thresholds.m, "3": input.thresholds.thresholds["3"], "9": input.thresholds.thresholds["9"] } : null,
		},
		flags: flagsFor(main),
		heldOut: { flags: flagsFor(props.filter((p) => p.heldOut)), properties: props.filter((p) => p.heldOut).map((p) => `${p.scenario}/${p.id}`) },
		exposed,
		limits,
	};
}
