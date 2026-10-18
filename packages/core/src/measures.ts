// measures - the result's diagnostic measures (Delta-2 section 1): the comprehension-behaviour
// link, restated-guidance flags, and the detectable difference beside an experiment's stated one.
// None of them is a score: they are computed from scores and outcomes, and feed nothing back.

import type { Property, Scenario } from "./pack-schema.js";
import type { Outcome } from "./outcome.js";
import type { Attempt, CellRecord } from "./run-conductor.js";

// ---------------------------------------------------------------- words and restated guidance

const HTML_TAGS = "a|abbr|b|blockquote|br|code|dd|del|details|div|dl|dt|em|figcaption|figure|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|samp|small|span|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|u|ul|var";
const HTML_TAG = new RegExp(`<\\/?(?:${HTML_TAGS})(?:[ \\t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"'<>=\`]+))?)*[ \\t]*\\/?>`, "gi");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "'", lsquo: "'" };

/**
 * The words of a text, as section 1 defines them: markdown dropped, then lowercased, then maximal
 * runs of letters, digits and apostrophes. "Markdown dropped" is read as exactly these steps, and
 * no other mark is claimed to be handled:
 *   - a fenced code block's opening line loses its info string (```bash);
 *   - a reference-link definition line - a label, a colon and one target, with an optional quoted
 *     title, and nothing else: [id]: https://x "Title" - is removed, and a footnote reference [^id];
 *   - a link or image keeps its text and loses its target: [text](target) and ![text](target);
 *   - an autolink <scheme:...> is removed, and an HTML tag of a common element, on one line;
 *   - an HTML entity is decoded: named ones for &, <, >, quotes, apostrophes and a space, and
 *     numeric ones;
 *   - a backslash escape loses its backslash;
 *   - an ordered-list number is removed (1. or 1)) where markdown starts a list item: at the start
 *     of a line that begins the text, follows a blank line or another item, or numbers itself 1;
 *   - an asterisk is removed, so emphasis inside a word joins it (un*believ*able).
 * Other marks - #, |, -, >, backticks, underscores - are neither letter, digit nor apostrophe, so
 * they separate words as any punctuation does; that splits a word only where such a mark sits
 * inside it. A typographic apostrophe counts as one and is written as the plain one.
 */
export function words(text: string): string[] {
	const dropped = text
		.replace(/^(\s*(?:`{3,}|~{3,}))[^\n]*$/gm, "$1")
		.replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S+(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm, " ")
		.replace(/\[\^[^\]\n]*\]/g, " ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*>/g, " ")
		.replace(HTML_TAG, " ")
		.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (m, e: string) => {
			if (!e.startsWith("#")) return ENTITIES[e.toLowerCase()] ?? m;
			const cp = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			// A code point that is not a character - a surrogate (55296 to 57343), or past the last plane
			// (1114111) - becomes a space.
			return cp > 0 && cp <= 1114111 && (cp < 55296 || cp > 57343) ? String.fromCodePoint(cp) : " ";
		})
		.replace(/\\([!-\/:-@\[-`{-~])/g, "$1");
	return (dropListNumbers(dropped).replace(/\*/g, "").toLowerCase().replace(/\u2019/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []);
}

const LIST_ITEM = /^([ \t]*)(\d{1,9})[.)](?=[ \t])/;
const BULLET = /^[ \t]*[-+*][ \t]/;
function dropListNumbers(text: string): string {
	const lines = text.split("\n");
	let prevItem = false;
	return lines.map((line, i) => {
		const m = LIST_ITEM.exec(line);
		const prev = i === 0 ? "" : lines[i - 1]!;
		const starts = m !== null && (i === 0 || prev.trim() === "" || prevItem || BULLET.test(prev) || Number(m[2]) === 1);
		prevItem = starts || (prevItem && line.trim() !== "" && /^[ \t]/.test(line));
		return starts ? line.replace(LIST_ITEM, "$1") : line;
	}).join("\n");
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

// ---------------------------------------------------------------- provider and agent fault profile

export const FAULT_KINDS = [
	"isolation",
	"filter",
	"rate-limit",
	"provider-5xx",
	"provider-other",
	"timeout-model",
	"timeout-tool",
	"overflow",
	"empty",
	"crash",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export interface FaultRow {
	member: string;
	family: string;
	arm: string;
	attempts: number;
	retriedCells: number;
	excludedCells: number;
	byKind: Record<FaultKind, number>;
}

/** Classifies one invalid attempt into its specific fault kind (Delta-4 stage 2, H2). */
export function classifyFaultKind(a: Attempt): FaultKind | null {
	if (a.validity.valid) return null;
	if (a.validity.cause === "isolation") return "isolation";
	const o: Outcome = a.phases?.find((p) => p.validity !== null && !p.validity.valid)?.outcome ?? a.outcome;
	if (o.filtered || o.error?.cause === "filter") return "filter";
	if (o.error?.cause === "provider") {
		const msg = o.error.message;
		if (/429|rate.?limit|quota|too many requests/i.test(msg)) return "rate-limit";
		if (/\b50[0234]\b|service unavailable|bad gateway|overloaded/i.test(msg)) return "provider-5xx";
		return "provider-other";
	}
	if (o.error?.cause === "overflow") return "overflow";
	if (o.stop.reason === "timeout") {
		return a.validity.cause === "infrastructure" ? "timeout-model" : "timeout-tool";
	}
	if (a.validity.cause === "behaviour" && o.final.trim() === "") return "empty";
	return "crash";
}

function emptyByKind(): Record<FaultKind, number> {
	return {
		isolation: 0,
		filter: 0,
		"rate-limit": 0,
		"provider-5xx": 0,
		"provider-other": 0,
		"timeout-model": 0,
		"timeout-tool": 0,
		overflow: 0,
		empty: 0,
		crash: 0,
	};
}

/**
 * Aggregates attempt counts, retries, exclusions, and fault kinds per `(member, family, arm)`
 * across `cells` in `(members, arms)` declaration order.
 */
export function faultProfile(
	cells: Pick<CellRecord, "cell" | "arm" | "member" | "valid" | "attempts">[],
	members: string[],
	arms: string[],
	memberFamilies?: Map<string, string>,
): FaultRow[] {
	const out: FaultRow[] = [];
	for (const m of members) {
		const family = memberFamilies?.get(m) ?? m;
		for (const a of arms) {
			const group = cells.filter((c) => c.member === m && c.arm === a);
			if (group.length === 0) continue;
			const byKind = emptyByKind();
			let attempts = 0;
			let retriedCells = 0;
			let excludedCells = 0;
			for (const c of group) {
				attempts += c.attempts.length;
				if (c.attempts.length > 1) retriedCells++;
				const last = c.attempts[c.attempts.length - 1];
				if (!c.valid && last && !last.validity.valid && last.validity.cause !== "behaviour") {
					excludedCells++;
				}
				for (const att of c.attempts) {
					const k = classifyFaultKind(att);
					if (k !== null) byKind[k]++;
				}
			}
			out.push({ member: m, family, arm: a, attempts, retriedCells, excludedCells, byKind });
		}
	}
	return out;
}

// ---------------------------------------------------------------- on-request hydration profile

export interface HydrationRow {
	scenario: string;
	arm: string;
	guidance: string;
	cells: number;
	hydrated: number;
	rate: number;
	membersHydrated: string[];
	membersMissed: string[];
}

/**
 * Per `(scenario, arm, guidance)`: how many valid cells whose arm delivered `on-request` folders
 * opened or read a file matching the guidance entry id (e.g. `A3-sovereign-composition.md` or
 * `S15-message-to-a-human.md`) during their episode.
 */
export function hydrationProfile(
	cells: Pick<CellRecord, "cell" | "scenario" | "arm" | "member" | "valid" | "attempts">[],
	scenarios: Map<string, Scenario>,
	propertiesOf: (s: Scenario) => Property[],
	onRequestArms?: Set<string>,
): HydrationRow[] {
	const map = new Map<string, { scenario: string; arm: string; guidance: string; hydrated: Set<string>; missed: Set<string>; cells: number }>();
	for (const c of cells) {
		if (!c.valid) continue;
		if (onRequestArms !== undefined && !onRequestArms.has(c.arm)) continue;
		const s = scenarios.get(c.scenario);
		if (!s) continue;
		const ids = [...new Set(propertiesOf(s).flatMap((p) => p.guidance ?? []))].sort();
		if (ids.length === 0) continue;
		const last = c.attempts[c.attempts.length - 1];
		const tools = [
			...(last?.outcome?.tools ?? []),
			...(last?.phases?.flatMap((p) => p.outcome?.tools ?? []) ?? []),
		];
		const touchedText = tools.map((t) => `${(t.paths ?? []).join(" ")} ${JSON.stringify(t.input ?? {})}`).join(" ");
		for (const id of ids) {
			const re = new RegExp(`(?:^|[\\\\/"'\\s])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-`, "i");
			const didHydrate = re.test(touchedText);
			const key = JSON.stringify([c.scenario, c.arm, id]);
			const row = map.get(key) ?? { scenario: c.scenario, arm: c.arm, guidance: id, hydrated: new Set<string>(), missed: new Set<string>(), cells: 0 };
			row.cells++;
			if (didHydrate) row.hydrated.add(c.member);
			else row.missed.add(c.member);
			map.set(key, row);
		}
	}
	return [...map.values()]
		.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.arm.localeCompare(b.arm) || a.guidance.localeCompare(b.guidance))
		.map((r) => ({
			scenario: r.scenario,
			arm: r.arm,
			guidance: r.guidance,
			cells: r.cells,
			hydrated: r.hydrated.size,
			rate: r.cells > 0 ? r.hydrated.size / r.cells : 0,
			membersHydrated: [...r.hydrated].sort(),
			membersMissed: [...r.missed].filter((m) => !r.hydrated.has(m)).sort(),
		}));
}
