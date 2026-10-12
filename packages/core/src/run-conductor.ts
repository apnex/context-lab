// run-conductor - conducts a run through its lifecycle (architecture sections 5 and 7, principle P8).
//
// A run, at this stage, moves through: validated, recorded, built, probed, executed, measured. Each
// state is entered once, in order, and its time is kept in the run record, so a later state can
// show it came after an earlier one. The run record holds everything needed to repeat and audit
// the run: the pack, the experiment's register entry, the method's version, every variant's
// revision, the scenarios resolved, the probe answers, and every attempt of every cell.
//
// Variants and workspaces live in a working folder of the operator's, outside the pack and its
// records, because agents must never see either; the run record holds what was recorded about them.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "./adapters.js";
import { composeArm, type ComposedArm } from "./arm-composer.js";
import { checkPack, selectScenarios } from "./pack-checker.js";
import { measure, type CodeScore } from "./code-measurer.js";
import { runStatus, type Record as RegisterRecord } from "./experiment-register.js";
import { probeArm, type ProbeResult } from "./isolation-prober.js";
import { splitAnswers, stripSelfExplanation } from "./answer-parser.js";
import type { Outcome } from "./outcome.js";
import type { LoadedPack, Member, Scenario, Status } from "./pack-schema.js";
import { runPhase } from "./phase-driver.js";
import { buildVariant, makeWritable, type BuiltVariant, type VariantManifest } from "./variant-builder.js";
import { classify, forbiddenPathsNamed, RERUN, type Validity } from "./validity-classifier.js";
import { createWorkspace } from "./workspace-builder.js";
import { isInside } from "./paths.js";
import { propertyPhase, runEpisode, type PhaseRecord, type TrapAssignment } from "./episode.js";
import { phasesOf, propertiesOf } from "./pack-schema.js";
import { blind, type Blinded } from "./blinder.js";
import { EMPTY_ARM, assignJudges, judgeAll, type Vote } from "./judge-panel.js";
import { resultMarkdown, tally, type Result } from "./tally.js";

const EMPTY_OUTCOME: Outcome = { final: "", exit: null, signal: null, stop: { reason: "error", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" };

export const STATES = ["validated", "recorded", "built", "probed", "executed", "measured", "blinded", "judged", "tallied"] as const;
export type State = (typeof STATES)[number];

export interface RunOptions {
	experiment?: string;
	suite?: string;
	adapters: Record<string, Adapter>;
	/** The operator's working folder; variants and workspaces are made under it. */
	work?: string;
	/** Where the run record is written; the pack's records path if not given. */
	records?: string;
	/** The source revision variants are built from; each source's HEAD if not given. */
	revision?: string;
	runsPerCell?: number;
	timeLimitSeconds?: number;
	judgeTimeLimitSeconds?: number;
	parallel?: number;
	now?: () => Date;
}

export interface Attempt {
	attempt: number;
	validity: Validity;
	outcome: Outcome;
	/** The workspace's changes after this attempt, against its initial commit. */
	diff: string | null;
	/** Where the attempt ran, so the blinder can remove the path from what judges see. */
	workspace?: string;
	/** Forbidden paths a sandboxed agent named, which did not exist for it. */
	unreachable?: string[];
	/** Every phase of the episode, as it ran. */
	phases?: PhaseRecord[];
	/** The phase whose agent-behaviour failure ended the episode. */
	endedAt?: string;
	/** The episode's ledger: a repository holding the tree of every phase's start and end. */
	ledger?: string;
	/** Set when the attempt could not be completed by the core itself: the adapter or the workspace failed. */
	failure?: string;
}

export interface CellRecord {
	cell: string;
	scenario: string;
	arm: string;
	member: string;
	run: number;
	attempts: Attempt[];
	valid: boolean;
	final: string | null;
	scoredFile: { path: string; content: string | null; matchesFinal: boolean } | null;
	/** Per property with an answer heading: its answer split from the scored file, self-explanation cut; null if absent. */
	answers: Record<string, string | null>;
	diff: string | null;
	codeScores: CodeScore[];
	/** The trap versions and positions this cell met. */
	traps?: TrapAssignment[];
	/** Per property: the phase it is judged on, and whether that phase ran validly, ended the episode, or is incomplete. */
	propertyPhases?: Record<string, { phase: string; state: PhaseState }>;
	/** Per phase of the last attempt that ran: what judges may be shown. */
	phaseOutcomes?: Record<string, { final: string; diff: string; note: string | null; startDiff: string; scored: string | null; traps: string[] }>;
}

export type PhaseState = "valid" | "ended" | "incomplete";

export type RunEnd = "completed" | "failed";

export interface RunRecord {
	run: string;
	pack: string;
	experiment: string;
	suite: string | null;
	scenarios: string[];
	status: Status;
	statusReason: string;
	register: RegisterRecord | null;
	method: { package: string; version: string; revision: string | null };
	states: { state: State; at: string }[];
	variants: Record<string, VariantManifest | { failed: string }>;
	arms: Record<string, { composed: boolean; reason?: string }>;
	probes: ProbeResult[];
	cells: string[];
	runsPerCell: number;
	timeLimitSeconds: number;
	population: string[];
	runtimes: Record<string, string | null>;
	judges: string[];
	judgeProbes: ProbeResult[];
	/** What the tally needs, as it stood when the run began, so a re-tally does not depend on the pack. */
	snapshot: { scenarios: Scenario[]; arms: string[]; population: Member[] };
	guessGroups: Record<string, string[]>;
	seed: string;
	end: RunEnd | null;
	endReason?: string;
}

/** The core's name and version, held equal to its package manifest by a test. */
export const METHOD = { package: "@apnex/context-lab-core", version: "0.0.0" };

function methodVersion(): RunRecord["method"] {
	const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const pkg = METHOD;
	let revision: string | null = null;
	try {
		revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: pkgDir, encoding: "utf8" }).trim() !== "") revision += "+uncommitted";
	} catch { /* not a git checkout */ }
	return { package: pkg.package, version: pkg.version, revision };
}

const write = (file: string, o: unknown): void => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
};

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
	const q = items.slice();
	await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (q.length) await fn(q.shift()!); }));
}

// Every change is staged with --force, so files any exclude rule would hide - the operator's own or a
// .gitignore the agent wrote - are included, and the diff does not depend on the machine.
function diffOf(workspace: string, init: string): string {
	const g = ["-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off"];
	execFileSync("git", [...g, "add", "-A", "--force"], { cwd: workspace, stdio: "ignore" });
	return execFileSync("git", [...g, "diff", "--cached", init], { cwd: workspace, encoding: "utf8", maxBuffer: 1 << 28 });
}

/** A file in the workspace, read only if its real path - every folder on the way resolved - is a regular file inside it. */
function readInside(workspace: string, rel: string): string | null {
	const f = path.resolve(workspace, rel);
	if (!isInside(f, workspace)) return null;
	let real: string;
	try { real = fs.realpathSync(f); } catch { return null; }
	if (!isInside(real, fs.realpathSync(workspace)) || !fs.lstatSync(real).isFile()) return null;
	return fs.readFileSync(real, "utf8");
}

export async function conductRun(packDir: string, opts: RunOptions): Promise<{ dir: string; record: RunRecord }> {
	const now = opts.now ?? ((): Date => new Date());
	const states: RunRecord["states"] = [];
	const enter = (s: State): void => {
		const last = states[states.length - 1];
		if (STATES.indexOf(s) !== (last ? STATES.indexOf(last.state) + 1 : 0)) throw new Error(`state ${s} out of order`);
		states.push({ state: s, at: now().toISOString() });
	};

	// The runtime check applies to the experiment being run, named directly or through its suite.
	const pre = await checkPack(packDir);
	const target = opts.experiment ?? (pre.ok ? pre.loaded.pack.suites.find((x) => x.id === opts.suite)?.experiment : undefined);
	const checked = await checkPack(packDir, { continueRuntimes: Object.fromEntries(Object.entries(opts.adapters).map(([k, a]) => [k, a.continue])), ...(target !== undefined ? { experiments: [target] } : {}) });
	if (!checked.ok) throw new Error(`the pack fails its check: ${checked.defects.map((d) => `${d.check} ${d.where} ${d.message}`).join("; ")}`);
	const loaded: LoadedPack = checked.loaded;
	enter("validated");

	let experimentId = opts.experiment;
	let suiteId: string | null = null;
	if (opts.suite !== undefined) {
		const s = loaded.pack.suites.find((x) => x.id === opts.suite);
		if (!s) throw new Error(`no suite ${opts.suite}`);
		suiteId = s.id;
		if (experimentId !== undefined && experimentId !== s.experiment) throw new Error(`suite ${s.id} runs ${s.experiment}, not ${experimentId}`);
		experimentId = s.experiment;
	}
	if (experimentId === undefined) throw new Error("a run names an experiment or a suite");
	const exp = loaded.experiments.get(experimentId);
	if (!exp) throw new Error(`no experiment ${experimentId}`);
	const allScenarios = [...exp.scenarios.values()].map((x) => x.scenario);
	const suite = loaded.pack.suites.find((x) => x.id === suiteId);
	const scenarioIds = suite ? selectScenarios(allScenarios, suite.select) : allScenarios.map((s) => s.id);
	const scenarios = scenarioIds.map((id) => exp.scenarios.get(id)!.scenario);
	const status = runStatus(loaded, experimentId);
	const startedAt = states[0]!.at;
	// A run rests only on a record made before it began (B13).
	if (status.record !== null && status.record.recordedAt >= startedAt) throw new Error("the experiment's record is not earlier than the run");
	const runsPerCell = opts.runsPerCell ?? exp.experiment.runsPerCell;
	let statusValue = status.status, statusReason = status.reason;
	if (runsPerCell !== exp.experiment.runsPerCell && statusValue === "result") {
		statusValue = "exploration";
		statusReason = `runs per cell overridden to ${runsPerCell}, from the recorded ${exp.experiment.runsPerCell}`;
	}
	enter("recorded");

	const runId = `${startedAt.replace(/[:.]/g, "").replace("T", "-").slice(0, 17)}-${experimentId}`;
	const recordsRoot = path.resolve(opts.records ?? path.resolve(loaded.dir, loaded.pack.records.path));
	const recordsDir = path.join(recordsRoot, runId);
	const workRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
	const work = path.join(workRoot, runId);
	fs.mkdirSync(recordsRoot, { recursive: true });
	fs.mkdirSync(workRoot, { recursive: true });
	// Made without recursion, so a second run started in the same second is refused, not merged.
	fs.mkdirSync(recordsDir);
	fs.mkdirSync(work);
	const timeLimitSeconds = opts.timeLimitSeconds ?? 1200;
	const armIds0 = exp.experiment.factors.arms;
	const record: RunRecord = {
		run: runId, pack: loaded.pack.id, experiment: experimentId, suite: suiteId, scenarios: scenarioIds,
		status: statusValue, statusReason, register: status.record, method: methodVersion(), states,
		variants: {}, arms: {}, probes: [], cells: [], runsPerCell, timeLimitSeconds,
		population: exp.experiment.factors.population, runtimes: {}, judges: [], judgeProbes: [],
		snapshot: { scenarios, arms: armIds0, population: loaded.pack.population },
		guessGroups: exp.experiment.judging?.guessGroups ?? Object.fromEntries(armIds0.map((a) => [a, [a]])), seed: runId, end: null,
	};
	// The record is written at every state and as each cell ends, so a run that stops part way
	// leaves everything it did.
	const save = (): void => write(path.join(recordsDir, "run.json"), record);
	save();
	const built = new Map<string, BuiltVariant>();
	try {

	const armIds = exp.experiment.factors.arms;
	const variantIds = [...new Set(loaded.pack.arms.filter((a) => armIds.includes(a.id)).flatMap((a) => a.deliver.map((d) => d.variant)))];
	const variants = record.variants;
	for (const v of variantIds) {
		const source = loaded.pack.variants.find((x) => x.id === v)!.source;
		const sourceDir = path.resolve(loaded.dir, loaded.pack.sources.find((s) => s.id === source)!.path);
		const rev = opts.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
		const b = await buildVariant(loaded, v, rev, path.join(work, "variants", v));
		built.set(v, b);
		variants[v] = b.ok ? b.manifest : { failed: b.reason };
	}
	const arms = record.arms;
	const composed = new Map<string, ComposedArm>();
	for (const a of armIds) {
		const c = composeArm(loaded, a, built);
		arms[a] = c.ok ? { composed: true } : { composed: false, reason: c.reason };
		if (c.ok) composed.set(a, c.arm);
	}
	enter("built");
	save();

	const members: Member[] = exp.experiment.factors.population.map((id) => loaded.pack.population.find((m) => m.id === id)!);
	const adapterOf = (m: Member): Adapter => {
		const a = opts.adapters[m.runtime];
		if (!a) throw new Error(`no adapter for runtime ${m.runtime}`);
		return a;
	};
	for (const m of members) if (!(m.runtime in record.runtimes)) record.runtimes[m.runtime] = adapterOf(m).version?.() ?? null;
	const probes: ProbeResult[] = record.probes;
	await pool([...composed.values()].flatMap((arm) => members.map((m) => ({ arm, m }))), opts.parallel ?? 4, async ({ arm, m }) => {
		probes.push(await probeArm(loaded, arm, m, adapterOf(m), { base: path.join(work, "probes", `${arm.arm}.${m.id}`), timeLimitSeconds: opts.timeLimitSeconds ?? 300 }));
	});
	probes.sort((a, b) => `${a.arm}.${a.member}`.localeCompare(`${b.arm}.${b.member}`));
	// Judges are probed as agents are, with nothing given and every leak probe asked.
	const judgeMembers: Member[] = (exp.experiment.judging?.judges ?? exp.experiment.factors.population).map((id) => loaded.pack.population.find((m) => m.id === id)!);
	for (const j of judgeMembers) if (!(j.runtime in record.runtimes)) record.runtimes[j.runtime] = adapterOf(j).version?.() ?? null;
	await pool(judgeMembers, opts.parallel ?? 4, async (j) => {
		record.judgeProbes.push(await probeArm(loaded, EMPTY_ARM, j, adapterOf(j), { base: path.join(work, "probes", `judge.${j.id}`), timeLimitSeconds: opts.timeLimitSeconds ?? 300, allLeaks: true }));
	});
	record.judgeProbes.sort((a, b) => a.member.localeCompare(b.member));
	const judges = judgeMembers.filter((j) => record.judgeProbes.some((p) => p.member === j.id && p.pass));
	record.judges = judges.map((j) => j.id);
	const passed = (arm: string, m: string): boolean => probes.some((p) => p.arm === arm && p.member === m && p.pass);
	enter("probed");
	save();

	// Forbidden to every cell: the pack and its declared paths, every source, all run records, and
	// the whole working folder - except, per cell, its own workspace and its arm's on-request folders.
	const forbiddenBase = {
		paths: [
			...loaded.pack.isolation.forbidden.paths.map((p) => path.resolve(loaded.dir, p)), loaded.dir, recordsRoot, workRoot,
			...loaded.pack.sources.map((s) => path.resolve(loaded.dir, s.path)),
		],
		addresses: [...new Set([...loaded.pack.isolation.forbidden.addresses, ...loaded.pack.sources.flatMap((s) => s.addresses)])],
	};
	const cells: { scenario: Scenario; arm: ComposedArm; member: Member; run: number }[] = [];
	for (const scenario of scenarios) for (const arm of composed.values()) for (const member of members) {
		if (!passed(arm.arm, member.id)) continue;
		for (let run = 1; run <= runsPerCell; run++) cells.push({ scenario, arm, member, run });
	}
	const cellRecords: CellRecord[] = [];
	await pool(cells, opts.parallel ?? 4, async (c) => {
		const cell = `${c.scenario.id}.${c.arm.arm}.${c.member.id}.${c.run}`;
		const phases = phasesOf(c.scenario, exp.experiment);
		const attempts: Attempt[] = [];
		let timeouts = 0;
		let lastPhases: PhaseRecord[] = [];
		let traps: TrapAssignment[] = [];
		const adapter = adapterOf(c.member);
		const sandboxed = adapter.filesystem === "sandboxed";
		// A cell may touch what its arm was given - its instruction and folder files at their source
		// paths, which rewritten links in them point at, and its on-request folders - and nothing else
		// of its variants; and, per phase, its own workspace and invocation folder.
		const given = [...c.arm.instructions.map((f) => f.path), ...c.arm.folderFiles.map((f) => f.path), ...c.arm.onRequest.map((o) => o.path)];
		for (let attempt = 1; ; attempt++) {
			let a: Attempt;
			const unreachable: string[] = [];
			try {
				const ep = await runEpisode({
					loaded, experiment: exp.experiment, scenario: c.scenario, arm: c.arm, member: c.member, memberIndex: members.indexOf(c.member), run: c.run,
					adapter, work, key: `${cell}.${attempt}`, timeLimitSeconds, timeouts,
					classify: (outcome, ws, inv, t) => {
						const allow = [ws, inv, ...given];
						if (sandboxed) unreachable.push(...forbiddenPathsNamed(outcome, { ...forbiddenBase, allow }));
						return classify(outcome, { ...forbiddenBase, allow, sandboxed }, t);
					},
				});
				timeouts = ep.timeouts;
				lastPhases = ep.phases;
				traps = ep.phases.flatMap((p) => p.traps);
				const ran = ep.phases.filter((p) => p.status === "run");
				const lastRan = ran[ran.length - 1];
				a = {
					attempt, validity: ep.validity, outcome: lastRan?.outcome ?? EMPTY_OUTCOME, diff: lastRan?.diff ?? null, workspace: lastRan?.workspace ?? "",
					phases: ep.phases, ledger: ep.ledger, ...(ep.endedAt !== undefined ? { endedAt: ep.endedAt } : {}), ...(unreachable.length ? { unreachable: [...new Set(unreachable)] } : {}),
				};
			} catch (e) {
				// The core could not complete the attempt; it is recorded, and the run goes on.
				a = { attempt, validity: { valid: false, cause: "infrastructure", detail: `the attempt failed in the core: ${String(e).slice(0, 300)}` }, outcome: EMPTY_OUTCOME, diff: null, failure: String(e).slice(0, 1000) };
				lastPhases = [];
			}
			attempts.push(a);
			if (a.validity.valid || !RERUN[a.validity.cause] || attempt >= 2) break;
		}
		const last = attempts[attempts.length - 1]!;
		const marker = loaded.pack.masks.selfExplanationMarker;
		const byPhase = new Map(lastPhases.map((p) => [p.phase, p]));
		const stateOf = (phase: string): PhaseState => {
			const p = byPhase.get(phase);
			if (p?.status === "run" && p.validity?.valid === true) return last.validity.valid || last.validity.cause === "behaviour" ? "valid" : "incomplete";
			if (p?.status === "incomplete") return "incomplete";
			return !last.validity.valid && last.validity.cause === "behaviour" ? "ended" : "incomplete";
		};
		const propertyPhases: NonNullable<CellRecord["propertyPhases"]> = {};
		for (const pr of propertiesOf(c.scenario)) { const ph = propertyPhase(c.scenario, phases, pr.id, traps); propertyPhases[pr.id] = { phase: ph, state: stateOf(ph) }; }
		const phaseOutcomes: NonNullable<CellRecord["phaseOutcomes"]> = {};
		for (const p of lastPhases) {
			if (p.status !== "run" || p.validity?.valid !== true || p.outcome === null) continue;
			const scoredContent = c.scenario.scoredFile !== undefined && p.snapshot !== null ? readInside(p.snapshot, c.scenario.scoredFile) : null;
			phaseOutcomes[p.phase] = { final: stripSelfExplanation(p.outcome.final, marker), diff: p.diff ?? "", note: p.note, startDiff: p.startDiff, scored: scoredContent, traps: p.traps.map((t) => t.text) };
		}
		const lastRan = [...lastPhases].reverse().find((p) => p.status === "run" && p.snapshot !== null);
		let scored: CellRecord["scoredFile"] = null;
		if (c.scenario.scoredFile !== undefined && lastRan !== undefined) {
			const content = readInside(lastRan.snapshot!, c.scenario.scoredFile);
			scored = { path: c.scenario.scoredFile, content, matchesFinal: content !== null && content.trim() === (lastRan.outcome?.final ?? "").trim() };
		}
		const answers: Record<string, string | null> = {};
		for (const pr of propertiesOf(c.scenario).filter((x) => x.answerHeading !== undefined)) {
			const pp = propertyPhases[pr.id]!;
			if (pp.state !== "valid") continue;
			answers[pr.id] = splitAnswers(phaseOutcomes[pp.phase]?.scored ?? "", [pr.answerHeading!], marker).get(pr.answerHeading!) ?? null;
		}
		const cr: CellRecord = {
			cell, scenario: c.scenario.id, arm: c.arm.arm, member: c.member.id, run: c.run, attempts, valid: last.validity.valid,
			final: last.validity.valid ? stripSelfExplanation(last.outcome.final, marker) : null, scoredFile: scored, answers, diff: last.diff, codeScores: [],
			traps, propertyPhases, phaseOutcomes,
		};
		cellRecords.push(cr);
		write(path.join(recordsDir, "cells", `${cell}.json`), cr);
		record.cells = cellRecords.map((x) => x.cell).sort();
		save();
	});
	enter("executed");

	for (const cr of cellRecords) {
		const scenario = scenarios.find((s) => s.id === cr.scenario)!;
		const lastAttempt = cr.attempts[cr.attempts.length - 1]!;
		// Each phase's code-decided properties are measured on that phase's outcome, unmasked and
		// uncut, as the agent left it; a phase that did not run validly is measured on nothing.
		for (const p of lastAttempt.phases ?? []) {
			const props = propertiesOf(scenario).filter((x) => x.decidedBy === "code" && cr.propertyPhases?.[x.id]?.phase === p.phase && cr.propertyPhases[x.id]!.state === "valid");
			if (!props.length || p.outcome === null) continue;
			const sub: Scenario = { ...scenario, properties: props, trapPairs: [] };
			cr.codeScores.push(...await measure(loaded, sub, { final: p.outcome.final, diff: p.diff ?? "", scored: cr.phaseOutcomes?.[p.phase]?.scored ?? null }, now));
		}
		write(path.join(recordsDir, "cells", `${cr.cell}.json`), cr);
	}
	enter("measured");
	save();

	// Blinding comes strictly after the last code score, so "earlier than its blinding" holds to the millisecond.
	await new Promise((r) => setTimeout(r, 2));
	const scenarioMap = new Map(scenarios.map((x) => [x.id, x]));
	const families = new Map(loaded.pack.population.map((m) => [m.id, m.family]));
	const canaries = loaded.pack.variants.flatMap((v) => v.canaries);
	const blinded = blind(loaded, scenarioMap, cellRecords, families, record.seed, now, { paths: [workRoot, recordsRoot, loaded.dir], literals: canaries });
	write(path.join(recordsDir, "sealed", "units.json"), blinded);
	enter("blinded");
	save();

	const votes = await judgeAll({
		loaded, experiment: exp.experiment, scenarios: scenarioMap, units: blinded.units, judges, adapters: opts.adapters,
		guessOptions: Object.keys(record.guessGroups), recordsDir, work, seed: record.seed, timeLimitSeconds: opts.judgeTimeLimitSeconds ?? 900, parallel: opts.parallel ?? 4,
	});
	write(path.join(recordsDir, "judging", "votes.json"), votes);
	enter("judged");
	save();

	const result = tallyRun(recordsDir);
	enter("tallied");
	record.end = "completed";
	save();
	void result;
	} catch (e) {
		record.end = "failed";
		record.endReason = String(e).slice(0, 1000);
		save();
		throw e;
	} finally {
		for (const v of built.values()) if (v.ok && fs.existsSync(v.dir)) makeWritable(v.dir);
	}
	return { dir: recordsDir, record };
}

/** Re-tally a run from its record alone: the same files give the same result, whatever the pack is now. */
export function tallyRun(recordsDir: string): Result {
	const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(recordsDir, f), "utf8")) as T;
	const record = read<RunRecord>("run.json");
	const scenarios = new Map(record.snapshot.scenarios.map((x) => [x.id, x]));
	const cells = record.cells.map((c) => read<CellRecord>(path.join("cells", `${c}.json`)));
	const blinded = read<Blinded>(path.join("sealed", "units.json"));
	const votes = read<Vote[]>(path.join("judging", "votes.json"));
	const judges = record.judges.map((id) => record.snapshot.population.find((m) => m.id === id)!);
	const result = tally({
		run: record.run, status: record.status, arms: record.snapshot.arms, members: record.population, scenarios, cells,
		units: blinded.units, absent: blinded.absent, votes, assigned: (u) => assignJudges(u, judges).map((j) => j.id), guessGroups: record.guessGroups,
	});
	write(path.join(recordsDir, "RESULT.json"), result);
	const limits = [
		`${record.runsPerCell} run(s) per cell: one outcome moves a cell's mean by up to 1/${record.runsPerCell} of the scale.`,
		"Agents and judges are language models; each outcome is judged by the families other than its agent's, which removes self-judging, not shared blind spots.",
		"Judges can often tell the condition from the outcome itself; the guess rate below says how often.",
		record.status === "exploration" ? `This run is exploration: ${record.statusReason}.` : "This run's experiment was recorded before the run, unchanged.",
	];
	fs.writeFileSync(path.join(recordsDir, "RESULT.md"), resultMarkdown(result, limits));
	return result;
}
