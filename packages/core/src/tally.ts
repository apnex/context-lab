// tally - computes results per factor (architecture section 5, principle P8).
//
// From the run record's cells, the sealed units and the votes, it computes each property's value
// for each cell, then rates per arm and per arm and population member. A judged property's value
// for a cell is the mean of its assigned votes, and incomplete if any assigned vote is missing; a
// code property's value is its code score. A cell invalid for agent behaviour scores 0 on every
// property, since it reached none; a cell invalid for any other cause is excluded and listed; an
// absent answer scores 0 and is flagged. The tally reads only files, so re-running it on a run
// record gives the same result.
//
// Held-out scenarios' properties are reported only in their own section and count toward no total,
// no link and no detectable difference; the scenarios exposed to a change, as the register stood
// when the run began, are listed. The link, restated-guidance flags and detectable difference are
// diagnostics beside the scores, computed from them and from outcomes, and change none.

import type { Unit, Absent } from "./blinder.js";
import type { Vote } from "./judge-panel.js";
import type { CellRecord } from "./run-conductor.js";
import { propertiesOf, type Experiment, type Scenario } from "./pack-schema.js";
import { detectable, linkRates, type Detectable, type LinkRow, type RestatedFlag } from "./measures.js";
import type { Exposure } from "./experiment-register.js";
import { tallyHumanPicks, type HumanPicksTally, type PicksRecord } from "./human-panel.js";

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
	totals: Record<string, number | null>;
	excluded: { cell: string; cause: string }[];
	absent: Absent[];
	guesses: { right: number; all: number; byGuess: Record<string, number>; baseRate: number | null };
	/** Cells whose sandboxed agent named a forbidden path that did not exist for it. */
	unreachable: string[];
	cellValues: Record<string, Record<string, number | "incomplete">>;
	/** Properties of held-out scenarios, reported here only, and in no total. */
	heldOut: PropertyResult[];
	/** Held-out scenarios' cells' values, kept apart from cellValues so nothing summing those mixes them in. */
	heldOutCellValues: Record<string, Record<string, number | "incomplete">>;
	/** Held-out properties' absent answers, kept apart from the absent list above. */
	heldOutAbsent: Absent[];
	/** Judges' guesses on held-out outcomes, kept apart from the guess count above. */
	heldOutGuesses: { right: number; all: number };
	/** Held-out scenarios of this run exposed to a change, as recorded before the run began. */
	exposed: Exposure[];
	/** The comprehension-behaviour link, per member, arm and guidance id. */
	link: LinkRow[];
	/** Notes and final messages sharing a run of words with a delivered instruction or folder file. */
	restated: RestatedFlag[];
	/** The stated variation and default, beside the difference detectable per scope. */
	variation: {
		stated: Experiment["variation"] | null;
		default: string | null;
		pooled: Detectable | null;
		byProperty: { scenario: string; property: string; detectable: Detectable | null }[];
	};
	/** A person's picks on paired outcomes: preference wins per move, or judge-person calibration agreement. */
	humanPicks?: HumanPicksTally | null;
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
	experiment?: { variation?: Experiment["variation"]; default?: string };
	exposed?: Exposure[];
	picks?: PicksRecord | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function tally(t: TallyInput): Result {
	const cellValues: Result["cellValues"] = {};
	const excluded: Result["excluded"] = [];
	const agreement = new Map<string, { agree: number; of: number }>();
	for (const c of t.cells) {
		const s = t.scenarios.get(c.scenario)!;
		const last = c.attempts[c.attempts.length - 1]!;
		const props = propertiesOf(s);
		const phased = c.propertyPhases !== undefined;
		if (!c.valid) {
			const cause = last.validity.valid ? "unknown" : last.validity.cause;
			if (cause !== "behaviour") { excluded.push({ cell: c.cell, cause }); continue; }
			// The episode ended on agent behaviour: properties of phases that had already run validly
			// keep their judged value; the rest score the bottom of their scale. Without phases, all do.
			if (!phased) { cellValues[c.cell] = Object.fromEntries(props.map((p) => [p.id, p.scale[0]])); continue; }
		}
		const v: Record<string, number | "incomplete"> = {};
		for (const p of props) {
			const state = c.propertyPhases?.[p.id]?.state;
			if (phased && state === "ended") { v[p.id] = p.scale[0]; continue; }
			if (phased && state === "incomplete") { v[p.id] = "incomplete"; continue; }
			if (p.decidedBy === "code") {
				const cs = c.codeScores.find((x) => x.property === p.id);
				v[p.id] = cs !== undefined && "value" in cs ? cs.value : "incomplete";
				continue;
			}
			if (t.absent.some((a) => a.cell === c.cell && a.property === p.id)) { v[p.id] = p.scale[0]; continue; }
			const unit = t.units.find((u) => u.cell === c.cell && u.properties.includes(p.id));
			if (!unit) { v[p.id] = "incomplete"; continue; }
			const judges = t.assigned(unit);
			const vs = judges.map((j) => t.votes.find((x) => x.unit === unit.id && x.property === p.id && x.judge === j)?.value ?? null);
			const complete = vs.length > 0 && vs.every((x) => x !== null);
			v[p.id] = complete ? mean(vs as number[])! : "incomplete";
			const key = `${s.id}/${p.id}`;
			const ag = agreement.get(key) ?? { agree: 0, of: 0 };
			// Agreement needs at least two votes to mean anything.
			if (complete && vs.length >= 2) { ag.of++; if ((vs as number[]).every((x) => x === vs[0])) ag.agree++; }
			agreement.set(key, ag);
		}
		cellValues[c.cell] = v;
	}
	const rate = (cells: CellRecord[], pid: string): Rate => {
		const vals = cells.filter((c) => cellValues[c.cell] !== undefined).map((c) => cellValues[c.cell]![pid]);
		const ok = vals.filter((x): x is number => typeof x === "number");
		return { mean: mean(ok), of: ok.length, incomplete: vals.length - ok.length };
	};
	const all: PropertyResult[] = [];
	for (const s of t.scenarios.values()) for (const p of propertiesOf(s)) {
		const cells = t.cells.filter((c) => c.scenario === s.id);
		all.push({
			scenario: s.id, property: p.id,
			byArm: Object.fromEntries(t.arms.map((a) => [a, rate(cells.filter((c) => c.arm === a), p.id)])),
			byArmMember: Object.fromEntries(t.arms.map((a) => [a, Object.fromEntries(t.members.map((m) => [m, rate(cells.filter((c) => c.arm === a && c.member === m), p.id)]))])),
			agreement: agreement.get(`${s.id}/${p.id}`) ?? { agree: 0, of: 0 },
		});
	}
	const isHeldOut = (sid: string): boolean => t.scenarios.get(sid)?.heldOut === true;
	const heldOutCellValues: Result["heldOutCellValues"] = {};
	for (const c of t.cells) if (isHeldOut(c.scenario) && cellValues[c.cell] !== undefined) { heldOutCellValues[c.cell] = cellValues[c.cell]!; delete cellValues[c.cell]; }
	const properties = all.filter((p) => !isHeldOut(p.scenario));
	const heldOut = all.filter((p) => isHeldOut(p.scenario));
	// A total is shown only when every property has a mean for that arm; it sums each property's own scale.
	const totals = Object.fromEntries(t.arms.map((a) => [a, properties.every((p) => p.byArm[a]!.mean !== null) ? properties.reduce((sum, p) => sum + p.byArm[a]!.mean!, 0) : null]));
	const groupOf = (arm: string): string | undefined => Object.entries(t.guessGroups).find(([, arms]) => arms.includes(arm))?.[0];
	const guesses = { right: 0, all: 0, byGuess: {} as Record<string, number>, baseRate: null as number | null };
	const heldOutGuesses = { right: 0, all: 0 };
	// Keyed by unit and judge as a pair, not a joined string: a unit id may contain the separator.
	const seen = new Map<string, Unit>();
	const heldSeen = new Set<string>();
	for (const v of t.votes) {
		const key = JSON.stringify([v.unit, v.judge]);
		if (v.guess === null || seen.has(key) || heldSeen.has(key)) continue;
		const unit = t.units.find((u) => u.id === v.unit)!;
		if (isHeldOut(unit.scenario)) { heldSeen.add(key); heldOutGuesses.all++; if (groupOf(unit.arm) === v.guess) heldOutGuesses.right++; continue; }
		seen.set(key, unit);
		guesses.all++;
		guesses.byGuess[v.guess] = (guesses.byGuess[v.guess] ?? 0) + 1;
		if (groupOf(unit.arm) === v.guess) guesses.right++;
	}
	// The base rate: always guessing the condition most of the guessed outcomes came from.
	const truth = new Map<string, number>();
	for (const unit of seen.values()) { const g = groupOf(unit.arm) ?? ""; truth.set(g, (truth.get(g) ?? 0) + 1); }
	if (guesses.all) guesses.baseRate = Math.max(...truth.values()) / guesses.all;
	const unreachable = t.cells.filter((c) => c.attempts.some((a) => (a.unreachable ?? []).length > 0)).map((c) => c.cell);
	const mainCells = t.cells.filter((c) => !isHeldOut(c.scenario));
	const link = linkRates(mainCells, cellValues, t.scenarios, propertiesOf);
	const valuesOf = (sid: string, pid: string): Record<string, number[]> => Object.fromEntries(t.arms.map((a) => [a, mainCells
		.filter((c) => c.scenario === sid && c.arm === a && cellValues[c.cell] !== undefined).map((c) => cellValues[c.cell]![pid]).filter((x): x is number => typeof x === "number")]));
	const mainProps = [...t.scenarios.values()].filter((s) => !s.heldOut).flatMap((s) => propertiesOf(s).map((p) => ({ scenario: s.id, property: p, byArm: valuesOf(s.id, p.id) })));
	const variation: Result["variation"] = {
		stated: t.experiment?.variation ?? null, default: t.experiment?.default ?? null,
		pooled: detectable(mainProps, t.arms),
		byProperty: mainProps.map((x) => ({ scenario: x.scenario, property: x.property.id, detectable: detectable([x], t.arms) })),
	};
	const restated = t.cells.flatMap((c) => c.restated ?? []);
	const heldCell = (cell: string): boolean => isHeldOut(t.cells.find((c) => c.cell === cell)?.scenario ?? "");
	const exposed = (t.exposed ?? []).filter((e) => isHeldOut(e.scenario));
	const humanPicks = t.picks ? tallyHumanPicks(t.picks) : null;
	return { run: t.run, status: t.status, arms: t.arms, members: t.members, properties, totals, excluded, absent: t.absent.filter((a) => !heldCell(a.cell)), guesses, unreachable, cellValues, heldOut, heldOutCellValues, heldOutAbsent: t.absent.filter((a) => heldCell(a.cell)), heldOutGuesses, exposed, link, restated, variation, ...(humanPicks ? { humanPicks } : {}) };
}

/** A warning where a difference of the stated size would usually go undetected, in the stated scope. */
function undetectable(r: Result): string[] {
	const st = r.variation.stated;
	if (!st) return [];
	if (st.scope === "pooled") return r.variation.pooled && r.variation.pooled.difference > st.difference ? ["", "The stated difference is smaller than the pooled detectable one, so a difference of the stated size would usually go undetected here."] : [];
	const over = r.variation.byProperty.filter((x) => x.detectable !== null && x.detectable.difference > st.difference);
	return over.length ? ["", `For ${over.length} of ${r.variation.byProperty.length} properties the stated difference is smaller than the detectable one, so a difference of the stated size in them would usually go undetected here.`] : [];
}

const dd = (d: Detectable | null): string => (d === null ? "- (an arm has no outcome)" : `${d.difference.toFixed(2)} (p ${d.p.toFixed(2)}, n ${d.n})`);

const fmt = (r: Rate): string => (r.mean === null ? "-" : `${r.mean.toFixed(2)} (${r.of})`) + (r.incomplete ? ` +${r.incomplete} inc` : "");

export function resultMarkdown(r: Result, limits: string[]): string {
	const calRate = r.humanPicks?.mode === "calibration" ? r.humanPicks.agreement?.rate ?? null : null;
	const allLimits = calRate !== null && calRate < 0.75
		? [...limits, `Judge-person calibration agreement is ${(calRate * 100).toFixed(0)}%, below the 75% threshold: review the keys before the next run.`]
		: limits;
	const lines = [
		`# Result - ${r.run}`, "",
		`Status: **${r.status}**.`, "",
		"## Limits", "", ...allLimits.map((l) => `- ${l}`), "",
		"## Properties", "",
		`| Scenario | Property | ${r.arms.join(" | ")} | votes agree |`, `|---|---|${r.arms.map(() => "---").join("|")}|---|`,
		...r.properties.map((p) => `| ${p.scenario} | ${p.property} | ${r.arms.map((a) => fmt(p.byArm[a]!)).join(" | ")} | ${p.agreement.of ? `${p.agreement.agree}/${p.agreement.of}` : "-"} |`),
		"", `Totals, each property on its own scale: ${r.arms.map((a) => `${a} ${r.totals[a] === null ? "- (a property has no mean)" : r.totals[a]!.toFixed(2)}`).join(", ")}.`, "",
		`Judges guessed the condition right ${r.guesses.right} of ${r.guesses.all} times; always guessing the largest condition would score ${r.guesses.baseRate === null ? "-" : `${Math.round(r.guesses.baseRate * 100)}%`}.`, "",
		r.excluded.length ? `Excluded cells: ${r.excluded.map((e) => `${e.cell} (${e.cause})`).join(", ")}.` : "No cell excluded.", "",
		r.absent.length ? `Absent answers, scored at the bottom of their scale: ${r.absent.map((a) => `${a.cell} ${a.property}`).join(", ")}.` : "No answer absent.", "",
		r.unreachable.length ? `Sandboxed agents named forbidden paths that did not exist for them, in: ${r.unreachable.join(", ")}.` : "No sandboxed agent named a forbidden path.", "",
		"## Stated variation", "",
		r.variation.stated ? `Stated: a difference of ${r.variation.stated.difference} in pass rate, ${r.variation.stated.scope}; default when none is detected: ${r.variation.default ?? "-"}.` : "No variation stated: the experiment is not declared result.",
		`Detectable at 80% power, 5% two-sided, pooled: ${dd(r.variation.pooled)}.`,
		...(r.variation.stated?.scope === "property" || r.variation.byProperty.length <= 30 ? ["", "| Scenario | Property | detectable (p, n per arm) |", "|---|---|---|", ...r.variation.byProperty.map((x) => `| ${x.scenario} | ${x.property} | ${dd(x.detectable)} |`)] : []),
		"Outcomes of one cell run are counted as independent, which they are not, so the pooled figure understates the difference truly detectable.",
		...undetectable(r),
		"",
		"## Held-out scenarios", "",
		...(r.heldOut.length ? [`| Scenario | Property | ${r.arms.join(" | ")} |`, `|---|---|${r.arms.map(() => "---").join("|")}|`, ...r.heldOut.map((p) => `| ${p.scenario} | ${p.property} | ${r.arms.map((a) => fmt(p.byArm[a]!)).join(" | ")} |`), "", `${r.heldOutAbsent.length ? `Absent answers, scored at the bottom of their scale: ${r.heldOutAbsent.map((a) => `${a.cell} ${a.property}`).join(", ")}. ` : ""}Counted in no total; judges guessed the condition of these outcomes right ${r.heldOutGuesses.right} of ${r.heldOutGuesses.all} times, counted apart from the guesses above.`] : ["None in this run."]),
		...(r.exposed.length ? ["", `Exposed to a change: ${r.exposed.map((e) => `${e.scenario} to ${e.change} (recorded ${e.recordedAt})`).join("; ")}.`] : []),
		"",
		"## Comprehension and behaviour", "",
		...(r.link.length ? ["| Member | Arm | Guidance | pairs | met, met | met, not | not, met | neither |", "|---|---|---|---|---|---|---|---|", ...r.link.map((l) => `| ${l.member} | ${l.arm} | ${l.guidance} | ${l.pairs} | ${l.metMet.toFixed(2)} | ${l.metNot.toFixed(2)} | ${l.notMet.toFixed(2)} | ${l.neither.toFixed(2)} |`), "", "A correlation, not a cause."] : ["No episode scored a comprehension and an adherence property naming the same guidance."]),
		"",
		"## Restated guidance", "",
		...(r.restated.length ? [`Diagnostic only; flags change no score. ${r.restated.length} flag(s):`, "", ...r.restated.map((f) => `- ${f.cell}, ${f.phase}, ${f.source} ${f.path}, shares ${f.words.split(" ").length} words with ${f.delivered.file} (${f.delivered.path}): "${f.words}"`)] : ["No note or final message shares a run of twelve words with a delivered file."]),
		"",
		...(r.humanPicks ? [
			"## Human panel", "",
			...(r.humanPicks.mode === "preference"
				? [
					`Preference picks (${r.humanPicks.complete ? "complete" : "incomplete"}): with ${r.humanPicks.totals.with}, without ${r.humanPicks.totals.without}, same ${r.humanPicks.totals.same}.`, "",
					...Object.entries(r.humanPicks.byMove).map(([m, v]) => {
						const tags = Object.entries(v.tags).map(([k, n]) => `${k} x${n}`).join(", ");
						return `- ${m}: with ${v.with}, without ${v.without}, same ${v.same}${tags ? ` (faults named in without: ${tags})` : ""}`;
					}),
				]
				: [
					`Calibration agreement (${r.humanPicks.complete ? "complete" : "incomplete"}): ${r.humanPicks.agreement?.agree ?? 0} of ${r.humanPicks.agreement?.of ?? 0} (${r.humanPicks.agreement?.rate === null || r.humanPicks.agreement?.rate === undefined ? "-" : `${(r.humanPicks.agreement.rate * 100).toFixed(0)}%`}).`,
				]),
			"",
		] : []),
	];
	return lines.join("\n");
}
