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
import type { ExtractionFinding } from "./answer-parser.js";
import type { Vote } from "./judge-panel.js";
import type { CellRecord } from "./run-conductor.js";
import { propertiesOf, type Experiment, type Scenario } from "./pack-schema.js";
import { FAULT_KINDS, costProfile, detectable, faultProfile, hydrationAdherence, hydrationProfile, judgeDissent, linkRates, type ArmDelivery, type CostRow, type Detectable, type FaultRow, type HydrationRow, type JudgeDissentRow, type LinkRow, type RestatedFlag } from "./measures.js";
import type { Exposure } from "./experiment-register.js";
import { tallyHumanPicks, type HumanPicksTally, type PicksRecord } from "./human-panel.js";
import { countChain, type ChainCountResult, type ChainRecord } from "./judging-chain.js";

export interface Rate { mean: number | null; of: number; incomplete: number }

export interface GuessBucket {
	right: number;
	all: number;
	baseRate: number | null;
	rate: number | null;
	notBlind: boolean;
}

export interface PropertyGuessBucket extends GuessBucket {
	scenario: string;
	property: string;
}

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
	guesses: {
		right: number;
		all: number;
		byGuess: Record<string, number>;
		baseRate: number | null;
		byScenario: Record<string, GuessBucket>;
		byProperty: Record<string, PropertyGuessBucket>;
	};
	/** Provider and agent fault profile per member, family and arm across all attempts (Delta-4 stage 2, H2). */
	faults: FaultRow[];
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
	/** Per scenario, arm and guidance id: how often valid cells opened or read the target guidance entry from on-request context, and the adherence of those that did and did not. */
	hydration?: HydrationRow[];
	/** Per arm, then per arm and member: the mean tokens, seconds and tool calls of a counted cell's scored attempt. */
	costs?: CostRow[];
	/** Per judge: how often it alone differed where at least three judges valued one unit's property and disagreed. */
	judgeDissent?: JudgeDissentRow[];
	/** Present answers whose extraction found something - a cut, a duplicate heading, text lost at a heading - with the findings (B23); absent answers carry theirs in `absent`. */
	extractionFlags?: { cell: string; property: string; findings: ExtractionFinding[] }[];
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
	/** Classify-then-verify judging chain counts across scenarios, held-out scenarios and families. */
	chain?: ChainCountResult | null;
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
	chain?: ChainRecord | null;
	memberFamilies?: Map<string, string>;
	/** Per arm, the files it delivered and how, as recorded when the run began; absent from older records. */
	deliveries?: Record<string, ArmDelivery[]>;
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
	const byScenarioAcc = new Map<string, { right: number; all: number; truth: Map<string, number> }>();
	const byPropertyAcc = new Map<string, { scenario: string; property: string; right: number; all: number; truth: Map<string, number> }>();
	for (const s of t.scenarios.values()) {
		if (s.heldOut === true) continue;
		byScenarioAcc.set(s.id, { right: 0, all: 0, truth: new Map() });
		for (const p of propertiesOf(s)) {
			if (p.decidedBy === "judge") {
				byPropertyAcc.set(`${s.id}/${p.id}`, { scenario: s.id, property: p.id, right: 0, all: 0, truth: new Map() });
			}
		}
	}
	const guesses = {
		right: 0, all: 0, byGuess: {} as Record<string, number>, baseRate: null as number | null,
		byScenario: {} as Record<string, GuessBucket>,
		byProperty: {} as Record<string, PropertyGuessBucket>,
	};
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
		const g = groupOf(unit.arm) ?? "";
		const correct = g === v.guess;
		guesses.all++;
		guesses.byGuess[v.guess] = (guesses.byGuess[v.guess] ?? 0) + 1;
		if (correct) guesses.right++;
		const scAcc = byScenarioAcc.get(unit.scenario);
		if (scAcc) {
			scAcc.all++;
			if (correct) scAcc.right++;
			scAcc.truth.set(g, (scAcc.truth.get(g) ?? 0) + 1);
		}
		for (const pid of unit.properties) {
			const prAcc = byPropertyAcc.get(`${unit.scenario}/${pid}`);
			if (prAcc) {
				prAcc.all++;
				if (correct) prAcc.right++;
				prAcc.truth.set(g, (prAcc.truth.get(g) ?? 0) + 1);
			}
		}
	}
	// The base rate: always guessing the condition most of the guessed outcomes came from.
	const truth = new Map<string, number>();
	for (const unit of seen.values()) { const g = groupOf(unit.arm) ?? ""; truth.set(g, (truth.get(g) ?? 0) + 1); }
	if (guesses.all) guesses.baseRate = Math.max(...truth.values()) / guesses.all;
	const toBucket = (acc: { right: number; all: number; truth: Map<string, number> }): GuessBucket => {
		const rate = acc.all > 0 ? acc.right / acc.all : null;
		const baseRate = acc.all > 0 ? Math.max(...acc.truth.values()) / acc.all : null;
		const notBlind = acc.all >= 6 && rate !== null && baseRate !== null && rate >= 0.75 && rate > baseRate + 0.25;
		return { right: acc.right, all: acc.all, baseRate, rate, notBlind };
	};
	for (const [sid, acc] of byScenarioAcc) guesses.byScenario[sid] = toBucket(acc);
	for (const [k, acc] of byPropertyAcc) guesses.byProperty[k] = { scenario: acc.scenario, property: acc.property, ...toBucket(acc) };
	const faults = faultProfile(t.cells, t.members, t.arms, t.memberFamilies);
	const unreachable = t.cells.filter((c) => c.attempts.some((a) => (a.unreachable ?? []).length > 0)).map((c) => c.cell);
	const mainCells = t.cells.filter((c) => !isHeldOut(c.scenario));
	const link = linkRates(mainCells, cellValues, t.scenarios, propertiesOf);
	const hydration = hydrationAdherence(hydrationProfile(mainCells, t.scenarios, propertiesOf, t.deliveries), cellValues, t.scenarios, propertiesOf);
	const costs = costProfile(mainCells, t.members, t.arms);
	const dissent = judgeDissent(t.votes);
	const extractionFlags = mainCells.flatMap((c) => Object.entries(c.extraction ?? {})
		.filter(([pid, x]) => x.findings.length > 0 && (c.answers[pid] ?? "").trim() !== "")
		.map(([pid, x]) => ({ cell: c.cell, property: pid, findings: x.findings })));
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
	const heldOutSet = new Set([...t.scenarios.values()].filter((s) => s.heldOut === true).map((s) => s.id));
	const chain = t.chain
		? countChain({
			record: t.chain,
			cells: t.cells.filter((c) => (cellValues[c.cell] ?? heldOutCellValues[c.cell]) !== undefined),
			members: t.memberFamilies ?? new Map(),
			heldOutScenarios: heldOutSet,
		})
		: null;
	return { run: t.run, status: t.status, arms: t.arms, members: t.members, properties, totals, excluded, absent: t.absent.filter((a) => !heldCell(a.cell)), guesses, faults, unreachable, cellValues, heldOut, heldOutCellValues, heldOutAbsent: t.absent.filter((a) => heldCell(a.cell)), heldOutGuesses, exposed, link, ...(hydration.length ? { hydration } : {}), ...(costs.length ? { costs } : {}), ...(dissent.length ? { judgeDissent: dissent } : {}), ...(extractionFlags.length ? { extractionFlags } : {}), restated, variation, ...(humanPicks ? { humanPicks } : {}), ...(chain ? { chain } : {}) };
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

const num = (x: number | null): string => (x === null ? "-" : Math.round(x).toLocaleString("en-US"));

const fmt = (r: Rate): string => (r.mean === null ? "-" : `${r.mean.toFixed(2)} (${r.of})`) + (r.incomplete ? ` +${r.incomplete} inc` : "");

export function resultMarkdown(r: Result, limits: string[]): string {
	const calRate = r.humanPicks?.mode === "calibration" ? r.humanPicks.agreement?.rate ?? null : null;
	const notBlindProps = Object.entries(r.guesses.byProperty ?? {}).filter(([, v]) => v.notBlind).map(([k]) => k);
	const allLimits = [
		...limits,
		...(calRate !== null && calRate < 0.75 ? [`Judge-person calibration agreement is ${(calRate * 100).toFixed(0)}%, below the 75% threshold: review the keys before the next run.`] : []),
		...(notBlindProps.length > 0 ? [`Blinding to condition did not hold on ${notBlindProps.join(", ")}: lean on code-scored properties there.`] : []),
	];
	const lines = [
		`# Result - ${r.run}`, "",
		`Status: **${r.status}**.`, "",
		"## Limits", "", ...allLimits.map((l) => `- ${l}`), "",
		"## Properties", "",
		`| Scenario | Property | ${r.arms.join(" | ")} | votes agree |`, `|---|---|${r.arms.map(() => "---").join("|")}|---|`,
		...r.properties.map((p) => `| ${p.scenario} | ${p.property} | ${r.arms.map((a) => fmt(p.byArm[a]!)).join(" | ")} | ${p.agreement.of ? `${p.agreement.agree}/${p.agreement.of}` : "-"} |`),
		"", `Totals, each property on its own scale: ${r.arms.map((a) => `${a} ${r.totals[a] === null ? "- (a property has no mean)" : r.totals[a]!.toFixed(2)}`).join(", ")}.`, "",
		r.guesses.all > 0
			? `Judges guessed the condition right ${r.guesses.right} of ${r.guesses.all} times; always guessing the largest condition would score ${r.guesses.baseRate === null ? "-" : `${Math.round(r.guesses.baseRate * 100)}%`}.`
			: "No judge guessed the condition, so whether judges could tell it from the outcome is unmeasured in this run.", "",
		...(r.guesses.all > 0 && Object.keys(r.guesses.byScenario ?? {}).length > 0 ? [
			"| Scenario | right / all | rate | base rate | not blind |",
			"|---|---|---|---|---|",
			...Object.entries(r.guesses.byScenario).map(([sid, b]) => `| ${sid} | ${b.right}/${b.all} | ${b.rate === null ? "-" : `${Math.round(b.rate * 100)}%`} | ${b.baseRate === null ? "-" : `${Math.round(b.baseRate * 100)}%`} | ${b.notBlind ? "yes" : "no"} |`),
			"",
		] : []),
		r.excluded.length ? `Excluded cells: ${r.excluded.map((e) => `${e.cell} (${e.cause})`).join(", ")}.` : "No cell excluded.", "",
		r.absent.length ? `Absent answers, scored at the bottom of their scale: ${r.absent.map((a) => `${a.cell} ${a.property} (${a.findings?.join(", ") ?? "reason not recorded"})`).join(", ")}.` : "No answer absent.", "",
		...(r.extractionFlags?.length ? [`Present answers extraction flagged: ${r.extractionFlags.map((f) => `${f.cell} ${f.property} (${f.findings.join(", ")})`).join(", ")}.`, ""] : []),
		r.unreachable.length ? `Sandboxed agents named forbidden paths that did not exist for them, in: ${r.unreachable.join(", ")}.` : "No sandboxed agent named a forbidden path.", "",
		"## Stated variation", "",
		r.variation.stated ? `Stated: a difference of ${r.variation.stated.difference} in pass rate, ${r.variation.stated.scope}; default when none is detected: ${r.variation.default ?? "-"}.` : "No variation stated: the experiment is not declared result.",
		`Detectable at 80% power, 5% two-sided, pooled: ${dd(r.variation.pooled)}.`,
		...(r.variation.stated?.scope === "property" || r.variation.byProperty.length <= 30 ? ["", "| Scenario | Property | detectable (p, n per arm) |", "|---|---|---|", ...r.variation.byProperty.map((x) => `| ${x.scenario} | ${x.property} | ${dd(x.detectable)} |`)] : []),
		"Outcomes of one cell run are counted as independent, which they are not, so the pooled figure understates the difference truly detectable.",
		...undetectable(r),
		"",
		"## Held-out scenarios", "",
		...(r.heldOut.length ? [`| Scenario | Property | ${r.arms.join(" | ")} |`, `|---|---|${r.arms.map(() => "---").join("|")}|`, ...r.heldOut.map((p) => `| ${p.scenario} | ${p.property} | ${r.arms.map((a) => fmt(p.byArm[a]!)).join(" | ")} |`), "", `${r.heldOutAbsent.length ? `Absent answers, scored at the bottom of their scale: ${r.heldOutAbsent.map((a) => `${a.cell} ${a.property} (${a.findings?.join(", ") ?? "reason not recorded"})`).join(", ")}. ` : ""}Counted in no total; judges guessed the condition of these outcomes right ${r.heldOutGuesses.right} of ${r.heldOutGuesses.all} times, counted apart from the guesses above.`] : ["None in this run."]),
		...(r.exposed.length ? ["", `Exposed to a change: ${r.exposed.map((e) => `${e.scenario} to ${e.change} (recorded ${e.recordedAt})`).join("; ")}.`] : []),
		"",
		"## Comprehension and behaviour", "",
		...(r.link.length ? ["| Member | Arm | Guidance | pairs | met, met | met, not | not, met | neither |", "|---|---|---|---|---|---|---|---|", ...r.link.map((l) => `| ${l.member} | ${l.arm} | ${l.guidance} | ${l.pairs} | ${l.metMet.toFixed(2)} | ${l.metNot.toFixed(2)} | ${l.notMet.toFixed(2)} | ${l.neither.toFixed(2)} |`), "", "A correlation, not a cause."] : ["No episode scored a comprehension and an adherence property naming the same guidance."]),
		"",
		...(r.hydration?.length ? [
			"## On-request guidance hydration", "",
			...(r.hydration.some((h) => h.onRequestOnly === null)
				? ["The run record kept no arm deliveries, so every arm is listed: a low rate may only mean the entry was already delivered.", ""]
				: ["Only arms that could reach the entry on request alone are listed: not given it as an instruction or folder file, and given an on-request folder.", ""]),
			"| Scenario | Arm | Guidance | Hydrated / cells | Rate | Members hydrated | Members missed | Adherence met: hydrated, not |",
			"|---|---|---|---|---|---|---|---|",
			...r.hydration.map((h) => `| ${h.scenario} | ${h.arm} | ${h.guidance} | ${h.hydrated}/${h.cells} | ${Math.round(h.rate * 100)}% | ${h.membersHydrated.join(", ") || "-"} | ${h.membersMissed.join(", ") || "-"} | ${(h.adherence ?? []).map((a) => `${a.property} ${a.hydrated.met}/${a.hydrated.of}, ${a.missed.met}/${a.missed.of}`).join("; ") || "-"} |`),
			"", "A property is met at or above its scale's midpoint. A correlation, not a cause.", "",
		] : []),
		...(r.costs?.length ? [
			"## Cost per arm", "",
			"Means per counted cell - valid, or ended on agent behaviour - over its scored attempt, phases summed; a token mean is over the cells whose runtime reported that count in every phase, in brackets where fewer than all.", "",
			"| Arm | Cells | Input tokens | Median input | Cached input | Output tokens | Tool calls | Seconds | Costliest cell |",
			"|---|---|---|---|---|---|---|---|---|",
			...r.costs.filter((c) => c.member === null).map((c) => `| ${c.arm} | ${c.cells} | ${num(c.inputTokens)}${c.tokenCells < c.cells ? ` (${c.tokenCells})` : ""} | ${num(c.inputTokensMedian ?? null)} | ${num(c.cachedInputTokens)} | ${num(c.outputTokens)} | ${c.toolCalls === null ? "-" : c.toolCalls.toFixed(1)} | ${c.seconds === null ? "-" : c.seconds.toFixed(0)} | ${c.costliest ? `${c.costliest.cell} (${num(c.costliest.inputTokens)})` : "-"} |`),
			"",
		] : []),
		...(r.judgeDissent?.length ? [
			"## Judge dissent", "",
			"Where at least three judges valued one unit's property and disagreed: how often each judge was in such a split, and how often it alone differed.", "",
			"| Judge | Values cast | In splits | Lone dissent | Rate |",
			"|---|---|---|---|---|",
			...r.judgeDissent.map((d) => `| ${d.judge} | ${d.votes} | ${d.splits} | ${d.lone} | ${d.rate === null ? "-" : `${Math.round(d.rate * 100)}%`} |`),
			"",
		] : []),
		"## Restated guidance", "",
		...(r.restated.length ? [`Diagnostic only; flags change no score. ${r.restated.length} flag(s):`, "", ...r.restated.map((f) => `- ${f.cell}, ${f.phase}, ${f.source} ${f.path}, shares ${f.words.split(" ").length} words with ${f.delivered.file} (${f.delivered.path}): "${f.words}"`)] : ["No note or final message shares a run of twelve words with a delivered file."]),
		"",
		"## Provider and agent faults", "",
		...(r.faults?.length ? [
			"| Member | Family | Arm | Attempts | Retried cells | Excluded cells | Faults by kind |",
			"|---|---|---|---|---|---|---|",
			...r.faults.map((f) => {
				const kinds = FAULT_KINDS.filter((k) => f.byKind[k] > 0).map((k) => `${k} ${f.byKind[k]}`).join(", ") || "none";
				return `| ${f.member} | ${f.family} | ${f.arm} | ${f.attempts} | ${f.retriedCells} | ${f.excludedCells} | ${kinds} |`;
			}),
			"",
		] : ["No cells in this run.", ""]),
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
		...(r.chain ? [
			"## Judging chain", "",
			`Threshold: at least ${r.chain.threshold.minScenarios} scenario(s), ${r.chain.threshold.minHeldOut} held out, ${r.chain.threshold.minFamilies} model famil${r.chain.threshold.minFamilies === 1 ? "y" : "ies"}.`, "",
			...(r.chain.rows.length ? [
				"| Finding | Readers | Scenarios | Held out | Families | Rejected | Meets |",
				"|---|---|---|---|---|---|---|",
				...r.chain.rows.map((row) => `| ${row.id} | ${row.readers} | ${row.scenarios.length} | ${row.heldOut.join(", ") || "none"} | ${row.families.join(", ") || "none"} | ${row.rejected} | ${row.meets ? "yes" : "no"} |`),
			] : ["No finding had evidence."]),
			"",
		] : []),
	];
	return lines.join("\n");
}
