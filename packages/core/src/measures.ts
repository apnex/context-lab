// measures - the result's diagnostic measures (Delta-2 section 1): the comprehension-behaviour
// link, restated-guidance flags, and the detectable difference beside an experiment's stated one.
// None of them is a score: they are computed from scores and outcomes, and feed nothing back.

import type { Property, Scenario } from "./pack-schema.js";

// ---------------------------------------------------------------- words and restated guidance

/**
 * The words of a text, as section 1 defines them: markdown dropped, then lowercased, then maximal
 * runs of letters, digits and apostrophes. Markdown dropped means: a link or image keeps its text
 * and loses its target - `[text](target)` and `![text](target)` become `text` - and an autolink
 * `<scheme:...>` or an HTML tag `<...>` is removed. Every other markdown mark is neither letter,
 * digit nor apostrophe, so it already separates words. A typographic apostrophe counts as one and
 * is written as the plain one.
 */
export function words(text: string): string[] {
	const dropped = text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*>/g, " ")
		.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
	return (dropped.toLowerCase().replace(/\u2019/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []);
}

export const RESTATED_RUN = 12;

export interface RestatedFlag {
	cell: string;
	phase: string;
	/** What the agent wrote: its final message, or a note a session was given. */
	source: "final" | "note";
	/** Where that text is: the note's file in the workspace, or a description of the final message or generated note. */
	path: string;
	/** The delivered file it shares words with: its declared name and the path it was delivered from. */
	delivered: { file: string; path: string };
	/** The first run of shared words found, at the threshold's length. */
	words: string;
}

/** The first run of `n` consecutive words a text shares with a delivered text, or null. */
export function sharedRun(text: string, delivered: string, n = RESTATED_RUN): string | null {
	const d = words(delivered);
	const grams = new Set<string>();
	for (let i = 0; i + n <= d.length; i++) grams.add(d.slice(i, i + n).join(" "));
	const t = words(text);
	for (let i = 0; i + n <= t.length; i++) { const g = t.slice(i, i + n).join(" "); if (grams.has(g)) return g; }
	return null;
}

// ---------------------------------------------------------------- the link

export interface LinkRow {
	member: string;
	arm: string;
	guidance: string;
	pairs: number;
	/** Fractions of pairs: comprehension met and adherence met; met and not; not and met; neither. */
	metMet: number;
	metNot: number;
	notMet: number;
	neither: number;
}

/** A score counts as met at or above the midpoint of its scale. */
export const met = (v: number, p: Property): boolean => v >= (p.scale[0] + p.scale[1]) / 2;

export interface LinkCell { cell: string; scenario: string; arm: string; member: string }

/**
 * Per member, arm and guidance id: every pair, within one episode, of a comprehension property and
 * an adherence property both naming that id, each with a value, sorted into the four rates. A
 * property naming several ids counts toward each. Incomplete values make no pair.
 */
export function linkRates(cells: LinkCell[], values: Record<string, Record<string, number | "incomplete">>, scenarios: Map<string, Scenario>, propertiesOf: (s: Scenario) => Property[]): LinkRow[] {
	const rows = new Map<string, { member: string; arm: string; guidance: string; n: [number, number, number, number] }>();
	for (const c of cells) {
		const v = values[c.cell];
		const s = scenarios.get(c.scenario);
		if (!v || !s) continue;
		const props = propertiesOf(s);
		const ids = [...new Set(props.flatMap((p) => p.guidance ?? []))].sort();
		for (const id of ids) {
			const scored = (type: string): [Property, number][] => props.filter((p) => p.type === type && (p.guidance ?? []).includes(id) && typeof v[p.id] === "number").map((p) => [p, v[p.id] as number]);
			const comp = scored("comprehension"), adh = scored("adherence");
			if (!comp.length || !adh.length) continue;
			const key = JSON.stringify([c.member, c.arm, id]);
			const row = rows.get(key) ?? { member: c.member, arm: c.arm, guidance: id, n: [0, 0, 0, 0] };
			for (const [cp, cv] of comp) for (const [ap, av] of adh) row.n[(met(cv, cp) ? 0 : 2) + (met(av, ap) ? 0 : 1)]!++;
			rows.set(key, row);
		}
	}
	return [...rows.values()].sort((a, b) => a.member.localeCompare(b.member) || a.arm.localeCompare(b.arm) || a.guidance.localeCompare(b.guidance)).map((r) => {
		const pairs = r.n.reduce((a, b) => a + b, 0);
		return { member: r.member, arm: r.arm, guidance: r.guidance, pairs, metMet: r.n[0] / pairs, metNot: r.n[1] / pairs, notMet: r.n[2] / pairs, neither: r.n[3] / pairs };
	});
}

// ---------------------------------------------------------------- detectable difference

/** The difference in pass rate detectable at 80% power and 5% two-sided: (1.96 + 0.84) sqrt(2 p (1 - p) / n). */
export function detectableDifference(p: number, n: number): number {
	return (1.96 + 0.84) * Math.sqrt((2 * p * (1 - p)) / n);
}

export interface Detectable {
	/** The pooled rate: the mean, over every outcome counted in every arm, of its value as a fraction of its scale. */
	p: number;
	/** Outcomes per arm: the fewest any arm has. */
	n: number;
	difference: number;
}

/**
 * The detectable difference over a set of properties. An outcome is one cell run's value on one
 * property, as a fraction of the property's scale - (v - bottom) / (top - bottom) - so a pass rate
 * for a property scored 0 or 1; p pools every outcome of every arm; n is the outcomes per arm,
 * the fewest of any arm. Null where an arm has no outcome.
 */
export function detectable(props: { property: Property; byArm: Record<string, number[]> }[], arms: string[]): Detectable | null {
	const perArm = arms.map((a) => props.flatMap(({ property: p, byArm }) => (byArm[a] ?? []).map((v) => (v - p.scale[0]) / (p.scale[1] - p.scale[0]))));
	const n = Math.min(...perArm.map((x) => x.length));
	if (!arms.length || n === 0) return null;
	const all = perArm.flat();
	const p = all.reduce((a, b) => a + b, 0) / all.length;
	return { p, n, difference: detectableDifference(p, n) };
}
