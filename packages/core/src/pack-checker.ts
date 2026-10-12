// pack-checker - validates a project pack (architecture section 5).
//
// Every check the checker runs is listed in PACK_CHECKS, so a test can hold one fixture per check
// and show each is load-bearing: remove a check and its fixture stops being rejected. A pack that
// passes every check is loaded and returned; one that fails is returned with every defect, each
// naming its check and where it was found.

import fs from "node:fs";
import path from "node:path";
import { runHook } from "./hook-runner.js";
import { isContainedRelative, isInside } from "./paths.js";
import {
	DECIDERS, DELIVERY_KINDS, EXERCISES_TAG, HOOK_KINDS, PACK_FILE, PACK_SCHEMA, PROPERTY_TYPES, STATUSES,
	phasesOf, propertiesOf,
	type Experiment, type LoadedPack, type Pack, type Scenario,
} from "./pack-schema.js";

export const PACK_CHECKS = {
	"pack-file": "pack.json exists and parses as JSON",
	"schema-version": `the pack declares schema ${PACK_SCHEMA}`,
	"shape": "every field of the pack, its experiments and scenarios has its declared type",
	"slug-ids": "every id is a lowercase slug",
	"unique-ids": "ids are unique within each collection, and scenario ids across the pack",
	"source-path": "every source path is a directory",
	"contained-paths": "every path the pack names inside a source, variant, fixture or the pack itself is relative and cannot leave it",
	"variant-source": "every variant names a declared source",
	"variant-transform": "a variant's transform names a variant-transform hook",
	"arm-variant": "every delivery names a declared variant",
	"hook-file": "every hook file exists",
	"experiment-file": "every experiment file exists and parses as JSON",
	"experiment-refs": "an experiment's arms and population are declared",
	"scenario-file": "every scenario file exists and parses as JSON",
	"fixture-dir": "a scenario's fixture, if named as a directory, is one",
	"probe-arms": "every leak probe names declared arms",
	"property-measure": "a code-decided property names an outcome-measure hook, and a judged one names none",
	"scale": "a property's scale runs from a lower to a higher number",
	"answer-heading": "a property with an answer heading belongs to a scenario that names a scored file",
	"phases": "a scenario's phases begin with a new session, follow only earlier phases, take notes only in new sessions, hold at most one continuing branch at a point, and continue only on runtimes that can",
	"trap-pairs": "every trap pair's positions are slots in exactly one phase's task, with two or more versions, and unique property ids",
	"comparison-refs": "a comparison names a declared experiment and two of its arms",
	"suite-experiment": "every suite names a declared experiment",
	"suite-nonempty": "every suite selects at least one scenario",
	"regex": "every mask and leak pattern is a valid regular expression",
	"one-declaration-check": "a pack declares at most one declaration-check hook",
	"declaration-check": "the pack's declaration-check hook, if any, reports no defect",
} as const;
export type CheckId = keyof typeof PACK_CHECKS;

export interface Defect {
	check: CheckId;
	where: string;
	message: string;
}

export type CheckResult = { ok: true; loaded: LoadedPack; defects: [] } | { ok: false; defects: Defect[] };

// --- shape ----------------------------------------------------------------------------------------

type Shape = "string" | "number" | "boolean" | "string[]" | "object" | "array" | ((v: unknown) => boolean);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const matches = (v: unknown, s: Shape): boolean => {
	if (typeof s === "function") return s(v);
	if (s === "string[]") return Array.isArray(v) && v.every((x) => typeof x === "string");
	if (s === "array") return Array.isArray(v);
	if (s === "object") return isObj(v);
	return typeof v === s;
};
const oneOf = (xs: readonly string[]) => (v: unknown): boolean => typeof v === "string" && xs.includes(v);
const fixtureShape = (v: unknown): boolean => v === null || typeof v === "string"
	|| (isObj(v) && Object.keys(v).length === 1 && isObj(v["files"]) && Object.values(v["files"]).every((x) => typeof x === "string"));
const pair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number");
const positiveInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;

function shape(obj: unknown, where: string, required: Record<string, Shape>, optional: Record<string, Shape>, out: Defect[]): obj is Record<string, unknown> {
	if (!isObj(obj)) {
		out.push({ check: "shape", where, message: "is not an object" });
		return false;
	}
	let ok = true;
	for (const [k, s] of Object.entries(required)) {
		if (!(k in obj)) { out.push({ check: "shape", where, message: `lacks ${k}` }); ok = false; } else if (!matches(obj[k], s)) { out.push({ check: "shape", where: `${where}.${k}`, message: "has the wrong type" }); ok = false; }
	}
	for (const [k, s] of Object.entries(optional)) {
		if (k in obj && !matches(obj[k], s)) { out.push({ check: "shape", where: `${where}.${k}`, message: "has the wrong type" }); ok = false; }
	}
	for (const k of Object.keys(obj)) {
		if (!(k in required) && !(k in optional)) { out.push({ check: "shape", where, message: `has an unknown field ${k}` }); ok = false; }
	}
	return ok;
}

function eachShape(v: unknown, where: string, required: Record<string, Shape>, optional: Record<string, Shape>, out: Defect[]): void {
	if (!Array.isArray(v)) return;
	v.forEach((x, i) => shape(x, `${where}[${i}]`, required, optional, out));
}

function packShape(raw: unknown, out: Defect[]): raw is Pack {
	const before = out.length;
	if (!shape(raw, "pack", {
		schema: "string", id: "string", sources: "array", variants: "array", arms: "array", population: "array", hooks: "array",
		masks: "object", isolation: "object", experiments: "string[]", suites: "array", records: "object",
	}, { comparisons: "array" }, out)) return false;
	eachShape(raw["comparisons"], "comparisons", { id: "string", experiment: "string", rule: oneOf(["aa", "tolerance", "improve"]), base: "string", head: "string" }, { m: positiveInt, tolerance: "number" }, out);
	eachShape(raw["sources"], "sources", { id: "string", path: "string", addresses: "string[]" }, { exclude: "string[]" }, out);
	eachShape(raw["variants"], "variants", { id: "string", source: "string", canaries: "string[]" }, { include: "string[]", transform: "string", revision: "string" }, out);
	eachShape(raw["arms"], "arms", { id: "string", deliver: "array" }, {}, out);
	if (Array.isArray(raw["arms"])) raw["arms"].forEach((a, i) => { if (isObj(a)) eachShape(a["deliver"], `arms[${i}].deliver`, { variant: "string", file: "string", as: oneOf(DELIVERY_KINDS) }, {}, out); });
	eachShape(raw["population"], "population", { id: "string", family: "string", runtime: "string", model: "string" }, { settings: "object" }, out);
	eachShape(raw["hooks"], "hooks", { id: "string", kind: oneOf(HOOK_KINDS), file: "string", timeLimitSeconds: positiveInt }, {}, out);
	shape(raw["masks"], "masks", { identifiers: "string[]" }, { selfExplanationMarker: "string" }, out);
	if (shape(raw["isolation"], "isolation", { leakProbes: "array", forbidden: "object" }, {}, out)) {
		const iso = raw["isolation"] as Record<string, unknown>;
		eachShape(iso["leakProbes"], "isolation.leakProbes", { id: "string", question: "string", leak: "string", arms: "string[]" }, {}, out);
		shape(iso["forbidden"], "isolation.forbidden", { paths: "string[]", addresses: "string[]" }, {}, out);
	}
	eachShape(raw["suites"], "suites", { id: "string", experiment: "string", select: "object" }, {}, out);
	if (Array.isArray(raw["suites"])) raw["suites"].forEach((s, i) => { if (isObj(s)) shape(s["select"], `suites[${i}].select`, {}, { allTags: "string[]", anyTags: "string[]", scenarios: "string[]" }, out); });
	shape(raw["records"], "records", { path: "string" }, {}, out);
	return out.length === before;
}

function experimentShape(raw: unknown, where: string, out: Defect[]): raw is Experiment {
	const before = out.length;
	if (!shape(raw, where, { id: "string", declaredStatus: oneOf(STATUSES), scenarios: "string[]", factors: "object", runsPerCell: positiveInt, phases: "array" }, { instructions: "string", preamble: "string", judgeInstructions: "string", judging: "object", notes: "string", variation: "object", default: "string" }, out)) return false;
	if (isObj(raw["variation"])) shape(raw["variation"], `${where}.variation`, { difference: (v: unknown) => typeof v === "number" && v > 0 && v <= 1, scope: oneOf(["pooled", "property"]) }, {}, out);
	if (isObj(raw["judging"])) shape(raw["judging"], `${where}.judging`, {}, { judges: "string[]", guessGroups: "object", outcomesPerPrompt: positiveInt }, out);
	shape(raw["factors"], `${where}.factors`, { arms: "string[]", population: "string[]" }, {}, out);
	eachShape(raw["phases"], `${where}.phases`, { id: "string", session: oneOf(["new"]) }, {}, out);
	return out.length === before;
}

function scenarioShape(raw: unknown, where: string, out: Defect[]): raw is Scenario {
	const before = out.length;
	if (!shape(raw, where, { id: "string", tags: "string[]", fixture: fixtureShape, task: "string", properties: "array" }, { heldOut: "boolean", start: "string", scoring: "string", scoredFile: "string", notes: "string", phases: "array", trapPairs: "array" }, out)) return false;
	const propOptional: Record<string, Shape> = { guidance: "string[]", measure: "string", rubric: "string", notes: "string", answerHeading: "string", question: "string", phase: "string", judgedWith: (v: unknown) => Array.isArray(v) && v.every((x) => x === "note" || x === "start") };
	eachShape(raw["properties"], `${where}.properties`, { id: "string", type: oneOf(PROPERTY_TYPES), decidedBy: oneOf(DECIDERS), key: "string", scale: pair }, propOptional, out);
	const noteShape = (v: unknown): boolean => isObj(v) && Object.keys(v).length === 1 && (typeof v["file"] === "string" || typeof v["generator"] === "string");
	eachShape(raw["phases"], `${where}.phases`, { id: "string", session: oneOf(["new", "continue"]) }, { task: "string", after: "string", note: noteShape, withhold: "string[]" }, out);
	eachShape(raw["trapPairs"], `${where}.trapPairs`, { id: "string", positions: "string[]", versions: "array", properties: "array" }, {}, out);
	if (Array.isArray(raw["trapPairs"])) raw["trapPairs"].forEach((t, i) => {
		if (!isObj(t)) return;
		eachShape(t["versions"], `${where}.trapPairs[${i}].versions`, { id: "string", text: "string" }, { files: (v: unknown) => isObj(v) && Object.values(v).every((x) => typeof x === "string") }, out);
		eachShape(t["properties"], `${where}.trapPairs[${i}].properties`, { id: "string", type: oneOf(PROPERTY_TYPES), decidedBy: oneOf(DECIDERS), key: "string", scale: pair }, propOptional, out);
	});
	return out.length === before;
}

// --- loading --------------------------------------------------------------------------------------

function readJson(file: string): { ok: true; value: unknown } | { ok: false; message: string } {
	if (!fs.existsSync(file)) return { ok: false, message: "does not exist" };
	try {
		return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as unknown };
	} catch (e) {
		return { ok: false, message: `does not parse: ${String(e)}` };
	}
}

const SLUG = /^[a-z0-9][a-z0-9.-]*$/;

/** Entries under a fixture that cannot be followed, or that link outside the fixture. */
function unreadable(dir: string, root: string = dir, visiting: Set<string> = new Set()): string[] {
	const out: string[] = [];
	const realDir = fs.realpathSync(dir);
	if (visiting.has(realDir)) return [dir];
	visiting.add(realDir);
	for (const e of fs.readdirSync(dir)) {
		const p = path.join(dir, e);
		let real: string;
		try {
			real = fs.realpathSync(p);
		} catch {
			out.push(p);
			continue;
		}
		if (!isInside(real, fs.realpathSync(root))) { out.push(p); continue; }
		if (fs.statSync(real).isDirectory()) out.push(...unreadable(p, root, visiting));
	}
	visiting.delete(realDir);
	return out;
}



function duplicates(ids: string[]): string[] {
	const seen = new Set<string>();
	const dup = new Set<string>();
	for (const id of ids) (seen.has(id) ? dup : seen).add(id);
	return [...dup];
}

function validRegex(p: string): boolean {
	try {
		new RegExp(p);
		return true;
	} catch {
		return false;
	}
}

/** Scenario ids a suite's selection resolves to, in the experiment's scenario order. */
export function selectScenarios(scenarios: Scenario[], select: { allTags?: string[]; anyTags?: string[]; scenarios?: string[] }): string[] {
	const byTag = (select.allTags?.length ?? 0) > 0 || (select.anyTags?.length ?? 0) > 0;
	return scenarios
		.filter((s) => {
			if (select.scenarios?.includes(s.id)) return true;
			if (!byTag) return false;
			const all = (select.allTags ?? []).every((t) => s.tags.includes(t));
			const any = (select.anyTags ?? []).length === 0 || (select.anyTags ?? []).some((t) => s.tags.includes(t));
			return all && any;
		})
		.map((s) => s.id);
}

export interface CheckOptions {
	/** Runtimes and whether each can continue a session; given, a continuing phase on a runtime that cannot is a defect. */
	continueRuntimes?: Record<string, boolean>;
	/** The experiments the runtime check applies to; every experiment if not given. */
	experiments?: string[];
}

export async function checkPack(packDir: string, options: CheckOptions = {}): Promise<CheckResult> {
	const dir = path.resolve(packDir);
	const defects: Defect[] = [];
	const file = path.join(dir, PACK_FILE);
	const raw = readJson(file);
	if (!raw.ok) return { ok: false, defects: [{ check: "pack-file", where: PACK_FILE, message: raw.message }] };
	if (isObj(raw.value) && raw.value["schema"] !== PACK_SCHEMA) {
		return { ok: false, defects: [{ check: "schema-version", where: "pack.schema", message: `is ${JSON.stringify(raw.value["schema"])}, not ${PACK_SCHEMA}` }] };
	}
	if (!packShape(raw.value, defects)) return { ok: false, defects };
	const pack = raw.value;

	// Experiments and scenarios load before reference checks, so every check sees the whole pack.
	const experiments: LoadedPack["experiments"] = new Map();
	// A scenario file may serve several experiments; ids must be unique across distinct files.
	const scenarioFiles = new Map<string, string>();
	const experimentIds: string[] = [];
	for (const ef of pack.experiments) {
		const r = readJson(path.join(dir, ef));
		if (!r.ok) { defects.push({ check: "experiment-file", where: ef, message: r.message }); continue; }
		if (!experimentShape(r.value, ef, defects)) continue;
		const scenarios = new Map<string, { file: string; scenario: Scenario }>();
		for (const sf of r.value.scenarios) {
			const s = readJson(path.join(dir, sf));
			if (!s.ok) { defects.push({ check: "scenario-file", where: sf, message: s.message }); continue; }
			if (!scenarioShape(s.value, sf, defects)) continue;
			scenarios.set(s.value.id, { file: sf, scenario: s.value });
			scenarioFiles.set(path.normalize(sf), s.value.id);
		}
		experiments.set(r.value.id, { file: ef, experiment: r.value, scenarios });
		experimentIds.push(r.value.id);
	}
	if (defects.some((d) => d.check === "shape")) return { ok: false, defects };

	const ids: [string, string[]][] = [
		["sources", pack.sources.map((x) => x.id)], ["variants", pack.variants.map((x) => x.id)], ["arms", pack.arms.map((x) => x.id)],
		["population", pack.population.map((x) => x.id)], ["hooks", pack.hooks.map((x) => x.id)], ["suites", pack.suites.map((x) => x.id)],
		["isolation.leakProbes", pack.isolation.leakProbes.map((x) => x.id)], ["experiments", experimentIds], ["scenarios", [...scenarioFiles.values()]],
	];
	if (!SLUG.test(pack.id)) defects.push({ check: "slug-ids", where: "pack.id", message: `${pack.id} is not a lowercase slug` });
	for (const [where, xs] of ids) {
		for (const id of xs) if (!SLUG.test(id)) defects.push({ check: "slug-ids", where, message: `${id} is not a lowercase slug` });
		for (const id of duplicates(xs)) defects.push({ check: "unique-ids", where, message: `${id} is declared more than once` });
	}

	for (const s of pack.sources) {
		const p = path.resolve(dir, s.path);
		if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) defects.push({ check: "source-path", where: `sources.${s.id}`, message: `${s.path} is not a directory` });
	}
	const contained = (p: string, where: string): boolean => {
		if (!isContainedRelative(p)) { defects.push({ check: "contained-paths", where, message: `${p} is absolute or leaves its directory` }); return false; }
		return true;
	};
	for (const s of pack.sources) for (const ex of s.exclude ?? []) {
		if (contained(ex, `sources.${s.id}.exclude`) && path.normalize(ex || ".") === ".") defects.push({ check: "contained-paths", where: `sources.${s.id}.exclude`, message: "excludes the whole source" });
	}
	for (const a of pack.arms) for (const d of a.deliver) contained(d.file, `arms.${a.id}`);
	for (const h of pack.hooks) contained(h.file, `hooks.${h.id}`);
	for (const [, { scenarios }] of experiments) for (const [sid, { scenario }] of scenarios) {
		if (typeof scenario.fixture === "string") contained(scenario.fixture, `scenarios.${sid}.fixture`);
		else if (scenario.fixture !== null) for (const f of Object.keys(scenario.fixture.files)) contained(f, `scenarios.${sid}.fixture`);
		if (scenario.scoredFile !== undefined) contained(scenario.scoredFile, `scenarios.${sid}.scoredFile`);
	}
	const hooks = new Map(pack.hooks.map((h) => [h.id, h]));
	for (const v of pack.variants) {
		if (!pack.sources.some((s) => s.id === v.source)) defects.push({ check: "variant-source", where: `variants.${v.id}`, message: `names undeclared source ${v.source}` });
		if (v.transform !== undefined && hooks.get(v.transform)?.kind !== "variant-transform") defects.push({ check: "variant-transform", where: `variants.${v.id}`, message: `${v.transform} is not a variant-transform hook` });
	}
	for (const a of pack.arms) for (const d of a.deliver) {
		if (!pack.variants.some((v) => v.id === d.variant)) defects.push({ check: "arm-variant", where: `arms.${a.id}`, message: `names undeclared variant ${d.variant}` });
	}
	for (const h of pack.hooks) {
		if (!fs.existsSync(path.resolve(dir, h.file))) defects.push({ check: "hook-file", where: `hooks.${h.id}`, message: `${h.file} does not exist` });
	}
	for (const [eid, { experiment, scenarios }] of experiments) {
		for (const a of experiment.factors.arms) if (!pack.arms.some((x) => x.id === a)) defects.push({ check: "experiment-refs", where: `experiments.${eid}`, message: `names undeclared arm ${a}` });
		for (const m of experiment.factors.population) if (!pack.population.some((x) => x.id === m)) defects.push({ check: "experiment-refs", where: `experiments.${eid}`, message: `names undeclared population member ${m}` });
		for (const m of experiment.judging?.judges ?? []) if (!pack.population.some((x) => x.id === m)) defects.push({ check: "experiment-refs", where: `experiments.${eid}.judging`, message: `names undeclared judge ${m}` });
		for (const [g, as] of Object.entries(experiment.judging?.guessGroups ?? {})) for (const a of Array.isArray(as) ? as : []) if (!experiment.factors.arms.includes(String(a))) defects.push({ check: "experiment-refs", where: `experiments.${eid}.judging.guessGroups.${g}`, message: `names arm ${a}, not one of the experiment's` });
		for (const [sid, { scenario }] of scenarios) {
			if (typeof scenario.fixture === "string" && isContainedRelative(scenario.fixture)) {
				const f = path.resolve(dir, scenario.fixture);
				if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) defects.push({ check: "fixture-dir", where: `scenarios.${sid}`, message: `${scenario.fixture} is not a directory` });
				else for (const bad of unreadable(f)) defects.push({ check: "fixture-dir", where: `scenarios.${sid}`, message: `${path.relative(dir, bad)} is a link that is broken, loops, or leaves the fixture` });
			}
			const phases = phasesOf(scenario, experiment);
			const phaseIds = phases.map((p) => p.id);
			const pd = (message: string): void => { defects.push({ check: "phases", where: `scenarios.${sid}.phases`, message }); };
			for (const id of duplicates(phaseIds)) pd(`${id} is declared more than once`);
			phases.forEach((ph, i) => {
				if (i === 0) {
					if (ph.session !== "new") pd(`the first phase, ${ph.id}, continues a session`);
					if (ph.after !== undefined || ph.note !== undefined) pd(`the first phase, ${ph.id}, follows or takes a note from another`);
					if (ph.task !== undefined || ph.withhold !== undefined) pd(`the first phase, ${ph.id}, has a task or withholds files; its task is the scenario's`);
					return;
				}
				const after = ph.after ?? phases[i - 1]!.id;
				if (!phaseIds.slice(0, i).includes(after)) pd(`${ph.id} follows ${after}, not an earlier phase`);
				if (ph.task === undefined) pd(`${ph.id} has no task`);
				if (ph.session === "continue" && (ph.note !== undefined || ph.withhold !== undefined)) pd(`${ph.id} continues a session, so takes no note and withholds nothing`);
				if (ph.note !== undefined && "generator" in ph.note && hooks.get(ph.note.generator)?.kind !== "note-generator") pd(`${ph.id}'s note generator ${ph.note.generator} is not a note-generator hook`);
				if (ph.note !== undefined && "file" in ph.note && !isContainedRelative(ph.note.file)) pd(`${ph.id}'s note file ${ph.note.file} leaves the workspace`);
				for (const w of ph.withhold ?? []) if (!isContainedRelative(w)) pd(`${ph.id} withholds ${w}, which leaves the workspace`);
				if (ph.session === "continue" && options.continueRuntimes && (options.experiments === undefined || options.experiments.includes(eid))) {
					for (const mid of experiment.factors.population) {
						const rt = pack.population.find((m) => m.id === mid)?.runtime;
						if (rt !== undefined && options.continueRuntimes[rt] !== true) pd(`${ph.id} continues a session, but member ${mid}'s runtime ${rt} cannot`);
					}
				}
			});
			const continuing = new Map<string, number>();
			phases.forEach((ph, i) => { if (i > 0 && ph.session === "continue") { const a = ph.after ?? phases[i - 1]!.id; continuing.set(a, (continuing.get(a) ?? 0) + 1); } });
			for (const [a, n] of continuing) if (n > 1) pd(`${n} phases continue the session of ${a}; at most one may`);
			const allProps = propertiesOf(scenario);
			for (const id of duplicates(allProps.map((p) => p.id))) defects.push({ check: "trap-pairs", where: `scenarios.${sid}`, message: `property ${id} is declared more than once` });
			for (const t of scenario.trapPairs ?? []) {
				if (t.versions.length < 2) defects.push({ check: "trap-pairs", where: `scenarios.${sid}.${t.id}`, message: "has fewer than two versions" });
				for (const pos of t.positions) {
					const holders = phases.filter((ph, i) => (i === 0 ? scenario.task : ph.task ?? "").includes(`{SLOT:${pos}}`)).length;
					if (holders !== 1) defects.push({ check: "trap-pairs", where: `scenarios.${sid}.${t.id}`, message: `position ${pos} is a slot in ${holders} phases, not one` });
				}
			}
			for (const p of allProps) if (p.phase !== undefined && !phaseIds.includes(p.phase)) pd(`property ${p.id} names phase ${p.phase}, not one of the scenario's`);
			for (const p of allProps) {
				const where = `scenarios.${sid}.${p.id}`;
				if (p.decidedBy === "code" && hooks.get(p.measure ?? "")?.kind !== "outcome-measure") defects.push({ check: "property-measure", where, message: "is decided by code but names no outcome-measure hook" });
				if (p.decidedBy === "judge" && p.measure !== undefined) defects.push({ check: "property-measure", where, message: "is judged but names a measure hook" });
				if (!(p.scale[0] < p.scale[1])) defects.push({ check: "scale", where, message: `scale ${JSON.stringify(p.scale)} does not rise` });
				if (p.answerHeading !== undefined && scenario.scoredFile === undefined) defects.push({ check: "answer-heading", where, message: "names an answer heading, but its scenario names no scored file" });
			}
		}
	}
	for (const c of pack.comparisons ?? []) {
		const e = experiments.get(c.experiment);
		if (!e) defects.push({ check: "comparison-refs", where: `comparisons.${c.id}`, message: `names undeclared experiment ${c.experiment}` });
		else for (const a of [c.base, c.head]) if (!e.experiment.factors.arms.includes(a)) defects.push({ check: "comparison-refs", where: `comparisons.${c.id}`, message: `names arm ${a}, not one of ${c.experiment}'s` });
	}
	for (const s of pack.suites) {
		const e = experiments.get(s.experiment);
		if (!e) { defects.push({ check: "suite-experiment", where: `suites.${s.id}`, message: `names undeclared experiment ${s.experiment}` }); continue; }
		if (selectScenarios([...e.scenarios.values()].map((x) => x.scenario), s.select).length === 0) defects.push({ check: "suite-nonempty", where: `suites.${s.id}`, message: "selects no scenario" });
	}
	for (const [i, p] of pack.masks.identifiers.entries()) if (!validRegex(p)) defects.push({ check: "regex", where: `masks.identifiers[${i}]`, message: `${p} is not a valid pattern` });
	for (const l of pack.isolation.leakProbes) {
		if (!validRegex(l.leak)) defects.push({ check: "regex", where: `isolation.leakProbes.${l.id}`, message: `${l.leak} is not a valid pattern` });
		for (const a of l.arms) if (!pack.arms.some((x) => x.id === a)) defects.push({ check: "probe-arms", where: `isolation.leakProbes.${l.id}`, message: `names undeclared arm ${a}` });
	}

	const declChecks = pack.hooks.filter((h) => h.kind === "declaration-check");
	if (declChecks.length > 1) defects.push({ check: "one-declaration-check", where: "hooks", message: `declares ${declChecks.length} declaration-check hooks: ${declChecks.map((h) => h.id).join(", ")}` });
	const declCheck = declChecks[0];
	if (declCheck && defects.length === 0) {
		const r = await runHook(dir, declCheck, { pack, packDir: dir }, { readable: [dir] });
		if (!r.ok) defects.push({ check: "declaration-check", where: `hooks.${declCheck.id}`, message: `failed (${r.reason}): ${r.detail}` });
		else {
			const out = r.output;
			const list = isObj(out) && Array.isArray(out["defects"]) ? out["defects"] : null;
			if (list === null) defects.push({ check: "declaration-check", where: `hooks.${declCheck.id}`, message: "returned no defects list" });
			else for (const d of list) defects.push({ check: "declaration-check", where: isObj(d) && typeof d["where"] === "string" ? d["where"] : declCheck.id, message: isObj(d) && typeof d["message"] === "string" ? d["message"] : JSON.stringify(d) });
		}
	}

	if (defects.length) return { ok: false, defects };
	return { ok: true, loaded: { dir, pack, experiments }, defects: [] };
}

/** The entry-to-scenario view, generated from scenarios' exercises: tags. */
export function entryView(loaded: LoadedPack): Map<string, string[]> {
	const view = new Map<string, string[]>();
	for (const { scenarios } of loaded.experiments.values()) {
		for (const { scenario } of scenarios.values()) {
			for (const t of scenario.tags) {
				if (!t.startsWith(EXERCISES_TAG)) continue;
				const entry = t.slice(EXERCISES_TAG.length);
				const list = view.get(entry) ?? [];
				if (!list.includes(scenario.id)) view.set(entry, [...list, scenario.id]);
			}
		}
	}
	return view;
}
