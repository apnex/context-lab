// measures - the result's diagnostic measures (Delta-2 section 1): the comprehension-behaviour
// link, restated-guidance flags, and the detectable difference beside an experiment's stated one.
// None of them is a score: they are computed from scores and outcomes, and feed nothing back.

import path from "node:path";
import type { DeliveryKind, Property, Scenario } from "./pack-schema.js";
import type { Outcome } from "./outcome.js";
import type { Attempt, CellRecord } from "./run-conductor.js";
import type { Vote } from "./judge-panel.js";

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

/** One file an arm delivered, and how: what the hydration profile needs to know which arms could only reach an entry on request. */
export interface ArmDelivery { file: string; as: DeliveryKind }

/** Of an adherence property naming the row's guidance: how often it was met in the cells that hydrated it, and in those that did not. */
export interface HydrationAdherence {
	property: string;
	/** Cells with a value that hydrated the entry, and how many of them met the property (at or above its scale's midpoint). */
	hydrated: { of: number; met: number };
	missed: { of: number; met: number };
}

export interface HydrationRow {
	scenario: string;
	arm: string;
	guidance: string;
	/** Valid cells counted. */
	cells: number;
	/** Of those, the cells that opened or read the entry. */
	hydrated: number;
	/** hydrated / cells. */
	rate: number;
	/** Members with at least one hydrating cell, and members with none. */
	membersHydrated: string[];
	membersMissed: string[];
	hydratedCells: string[];
	missedCells: string[];
	/**
	 * True where the arm's deliveries are known and the entry reached it only on request: no
	 * instruction or folder file of the arm is the entry, and the arm has an on-request folder. Null
	 * where the run record did not keep the arm's deliveries, so a low rate may only mean the entry was
	 * already delivered. False rows are not written.
	 */
	onRequestOnly: boolean | null;
	/** Filled by the tally from the cells' values; empty from hydrationProfile alone. */
	adherence: HydrationAdherence[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `file`, a path within a variant, is the entry with id `id`: its name starts with the id and a hyphen. */
export const isEntryFile = (file: string, id: string): boolean => new RegExp(`^${escapeRe(id)}-`, "i").test(path.basename(file));

/**
 * Per `(scenario, arm, guidance)`: how many valid cells hydrated the guidance entry - a tool call of
 * any phase of the scored attempt named a path, or had an input, holding the entry id followed by a
 * hyphen after a path separator, quote, space or the start (e.g. `axioms/A3-sovereign-composition.md`),
 * case ignored. So it measures that a call named the entry, which a read does and a search pattern
 * can; a bulk read such as `cat axioms/*.md` names no entry and is not counted. Entry files must be
 * named `<id>-...` to be seen at all.
 *
 * Given the arms' deliveries, a row is written only for an arm with an on-request folder and no
 * instruction or folder file named for the entry: the folder's contents are not checked, so it is an
 * arm that could have the entry only on request. Without deliveries every arm is written, with
 * onRequestOnly null.
 */
export function hydrationProfile(
	cells: Pick<CellRecord, "cell" | "scenario" | "arm" | "member" | "valid" | "attempts">[],
	scenarios: Map<string, Scenario>,
	propertiesOf: (s: Scenario) => Property[],
	deliveries?: Record<string, ArmDelivery[]>,
): HydrationRow[] {
	const map = new Map<string, { scenario: string; arm: string; guidance: string; hydrated: string[]; missed: string[]; byMember: Map<string, boolean> }>();
	const onRequestOnly = (arm: string, id: string): boolean | null => {
		if (deliveries === undefined) return null;
		const d = deliveries[arm] ?? [];
		return d.some((x) => x.as === "on-request") && !d.some((x) => x.as !== "on-request" && isEntryFile(x.file, id));
	};
	for (const c of cells) {
		if (!c.valid) continue;
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
			if (onRequestOnly(c.arm, id) === false) continue;
			const re = new RegExp(`(?:^|[\\\\/"'\\s])${escapeRe(id)}-`, "i");
			const didHydrate = re.test(touchedText);
			const key = JSON.stringify([c.scenario, c.arm, id]);
			const row = map.get(key) ?? { scenario: c.scenario, arm: c.arm, guidance: id, hydrated: [], missed: [], byMember: new Map<string, boolean>() };
			(didHydrate ? row.hydrated : row.missed).push(c.cell);
			row.byMember.set(c.member, (row.byMember.get(c.member) ?? false) || didHydrate);
			map.set(key, row);
		}
	}
	return [...map.values()]
		.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.arm.localeCompare(b.arm) || a.guidance.localeCompare(b.guidance))
		.map((r) => {
			const cellCount = r.hydrated.length + r.missed.length;
			return {
				scenario: r.scenario,
				arm: r.arm,
				guidance: r.guidance,
				cells: cellCount,
				hydrated: r.hydrated.length,
				rate: cellCount > 0 ? r.hydrated.length / cellCount : 0,
				membersHydrated: [...r.byMember].filter(([, h]) => h).map(([m]) => m).sort(),
				membersMissed: [...r.byMember].filter(([, h]) => !h).map(([m]) => m).sort(),
				hydratedCells: [...r.hydrated].sort(),
				missedCells: [...r.missed].sort(),
				onRequestOnly: onRequestOnly(r.arm, r.guidance),
				adherence: [],
			};
		});
}

/**
 * Fills each row's adherence split: for every adherence property of the row's scenario naming its
 * guidance, how many of the hydrating and of the other cells had a value, and how many met it. A
 * correlation, not a cause: an agent that opens an entry may differ in other ways from one that does not.
 */
export function hydrationAdherence(rows: HydrationRow[], values: Record<string, Record<string, number | "incomplete">>, scenarios: Map<string, Scenario>, propertiesOf: (s: Scenario) => Property[]): HydrationRow[] {
	return rows.map((r) => {
		const s = scenarios.get(r.scenario);
		const props = s ? propertiesOf(s).filter((p) => p.type === "adherence" && (p.guidance ?? []).includes(r.guidance)) : [];
		const split = (cells: string[], p: Property): { of: number; met: number } => {
			const vs = cells.map((c) => values[c]?.[p.id]).filter((v): v is number => typeof v === "number");
			return { of: vs.length, met: vs.filter((v) => met(v, p)).length };
		};
		return { ...r, adherence: props.map((p) => ({ property: p.id, hydrated: split(r.hydratedCells, p), missed: split(r.missedCells, p) })) };
	});
}

// ---------------------------------------------------------------- cost per arm

export interface CostRow {
	arm: string;
	/** Null for the arm's row over every member. */
	member: string | null;
	/** Cells counted: valid ones and those that ended on agent behaviour, which are scored, so costed (0004); cells excluded from scoring are not. */
	cells: number;
	/**
	 * Means per cell over the scored attempt, its phases summed. A token mean is over the cells whose
	 * runtime reported that count in every phase, and null where none did; input tokens include cached
	 * input, as both parsers count them.
	 */
	seconds: number | null;
	inputTokens: number | null;
	cachedInputTokens: number | null;
	outputTokens: number | null;
	toolCalls: number | null;
	/** Cells whose runtime reported input tokens. */
	tokenCells: number;
	/** The median of those cells' input tokens: a mean alone is carried by one runaway cell. */
	inputTokensMedian: number | null;
	/** The cell with the most input tokens, and its count. */
	costliest: { cell: string; inputTokens: number } | null;
}

/** What one cell's scored attempt cost: its phases summed where it had phases, else its outcome. */
export function cellCost(c: Pick<CellRecord, "attempts">): { seconds: number; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; toolCalls: number } {
	const last = c.attempts[c.attempts.length - 1];
	const ran = (last?.phases ?? []).filter((p) => p.status === "run" && p.outcome !== null).map((p) => p.outcome!.cost);
	const costs = ran.length ? ran : last ? [last.outcome.cost] : [];
	// A count missing from any phase makes the cell's count unknown, rather than a sum that reads low.
	const sum = (k: "inputTokens" | "cachedInputTokens" | "outputTokens"): number | null => (costs.length > 0 && costs.every((x) => x[k] != null) ? costs.reduce((a, x) => a + (x[k] as number), 0) : null);
	return {
		seconds: costs.reduce((a, x) => a + x.seconds, 0),
		inputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"), outputTokens: sum("outputTokens"),
		toolCalls: costs.reduce((a, x) => a + x.toolCalls, 0),
	};
}

/**
 * Per arm, then per arm and member: the mean cost of a counted cell's scored attempt - a valid cell,
 * or one that ended on agent behaviour, as the tally scores both. Beside the scores, it says what an
 * arm's added context cost in tokens and time for the adherence it bought.
 */
export function costProfile(cells: Pick<CellRecord, "cell" | "arm" | "member" | "valid" | "attempts">[], members: string[], arms: string[]): CostRow[] {
	const row = (arm: string, member: string | null, group: typeof cells): CostRow => {
		const cs = group.map(cellCost);
		const tok = group.map((c, i) => ({ cell: c.cell, n: cs[i]!.inputTokens })).filter((x): x is { cell: string; n: number } => x.n !== null);
		const sorted = tok.map((x) => x.n).sort((a, b) => a - b);
		const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
		const top = tok.reduce<{ cell: string; n: number } | null>((m, x) => (m === null || x.n > m.n ? x : m), null);
		const avg = (xs: (number | null)[]): number | null => { const ok = xs.filter((x): x is number => x !== null); return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null; };
		return {
			arm, member, cells: cs.length,
			seconds: avg(cs.map((x) => x.seconds)), inputTokens: avg(cs.map((x) => x.inputTokens)), cachedInputTokens: avg(cs.map((x) => x.cachedInputTokens)),
			outputTokens: avg(cs.map((x) => x.outputTokens)), toolCalls: avg(cs.map((x) => x.toolCalls)),
			tokenCells: cs.filter((x) => x.inputTokens !== null).length,
			inputTokensMedian: median,
			costliest: top === null ? null : { cell: top.cell, inputTokens: top.n },
		};
	};
	const valid = cells.filter((c) => {
		const last = c.attempts[c.attempts.length - 1];
		return c.valid || (last !== undefined && !last.validity.valid && last.validity.cause === "behaviour");
	});
	const out: CostRow[] = [];
	for (const a of arms) {
		const inArm = valid.filter((c) => c.arm === a);
		if (!inArm.length) continue;
		out.push(row(a, null, inArm));
		for (const m of members) { const g = inArm.filter((c) => c.member === m); if (g.length) out.push(row(a, m, g)); }
	}
	return out;
}

// ---------------------------------------------------------------- judge dissent

export interface JudgeDissentRow {
	judge: string;
	/** (unit, property) pairs this judge cast a value on. */
	votes: number;
	/** Of the pairs with values from at least three judges that were not unanimous, those this judge was in. */
	splits: number;
	/** Of those, the pairs where every other judge agreed and this judge alone differed. */
	lone: number;
	/** lone / splits, or null without a split. */
	rate: number | null;
}

/**
 * Per judge: how often it was the lone dissenter where at least three judges valued one (unit,
 * property) pair and they disagreed. A judge whose rate stands far above the others' is the first
 * place to look when agreement is low: it is more often that judge than the key. Held-out units are
 * counted too, since a judge's reading does not depend on the scenario being held out.
 */
export function judgeDissent(votes: Pick<Vote, "unit" | "property" | "judge" | "value">[]): JudgeDissentRow[] {
	const byPair = new Map<string, Map<string, number>>();
	const cast = new Map<string, number>();
	for (const v of votes) {
		if (v.value === null) continue;
		const key = JSON.stringify([v.unit, v.property]);
		const m = byPair.get(key) ?? new Map<string, number>();
		if (!m.has(v.judge)) { m.set(v.judge, v.value); cast.set(v.judge, (cast.get(v.judge) ?? 0) + 1); }
		byPair.set(key, m);
	}
	const splits = new Map<string, number>(), lone = new Map<string, number>();
	for (const m of byPair.values()) {
		if (m.size < 3 || new Set(m.values()).size === 1) continue;
		for (const [j, v] of m) {
			splits.set(j, (splits.get(j) ?? 0) + 1);
			const others = [...m].filter(([k]) => k !== j).map(([, w]) => w);
			if (new Set(others).size === 1 && others[0] !== v) lone.set(j, (lone.get(j) ?? 0) + 1);
		}
	}
	return [...cast.keys()].sort().map((j) => {
		const sp = splits.get(j) ?? 0, lo = lone.get(j) ?? 0;
		return { judge: j, votes: cast.get(j) ?? 0, splits: sp, lone: lo, rate: sp > 0 ? lo / sp : null };
	});
}
