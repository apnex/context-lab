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
import { classify, RERUN, type Validity } from "./validity-classifier.js";
import { createWorkspace } from "./workspace-builder.js";
import { isInside } from "./paths.js";

export const STATES = ["validated", "recorded", "built", "probed", "executed", "measured"] as const;
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
	parallel?: number;
	now?: () => Date;
}

export interface Attempt {
	attempt: number;
	validity: Validity;
	outcome: Outcome;
	/** The workspace's changes after this attempt, against its initial commit. */
	diff: string | null;
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
}

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

/** A file in the workspace, read only if it is a regular file there and not a link to elsewhere. */
function readInside(workspace: string, rel: string): string | null {
	const f = path.resolve(workspace, rel);
	if (!isInside(f, workspace)) return null;
	let st: fs.Stats;
	try { st = fs.lstatSync(f); } catch { return null; }
	if (!st.isFile()) return null;
	return fs.readFileSync(f, "utf8");
}

export async function conductRun(packDir: string, opts: RunOptions): Promise<{ dir: string; record: RunRecord }> {
	const now = opts.now ?? ((): Date => new Date());
	const states: RunRecord["states"] = [];
	const enter = (s: State): void => {
		const last = states[states.length - 1];
		if (STATES.indexOf(s) !== (last ? STATES.indexOf(last.state) + 1 : 0)) throw new Error(`state ${s} out of order`);
		states.push({ state: s, at: now().toISOString() });
	};

	const checked = await checkPack(packDir);
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
	const record: RunRecord = {
		run: runId, pack: loaded.pack.id, experiment: experimentId, suite: suiteId, scenarios: scenarioIds,
		status: statusValue, statusReason, register: status.record, method: methodVersion(), states,
		variants: {}, arms: {}, probes: [], cells: [], runsPerCell, timeLimitSeconds,
		population: exp.experiment.factors.population, runtimes: {}, end: null,
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
		const attempts: Attempt[] = [];
		let timeouts = 0;
		let lastWs: { dir: string; init: string } | null = null;
		for (let attempt = 1; ; attempt++) {
			let a: Attempt;
			try {
				const ws = createWorkspace(loaded, c.scenario, c.arm, { base: path.join(work, "workspaces"), rulesFiles: adapterOf(c.member).rulesFiles });
				lastWs = ws;
				fs.mkdirSync(path.join(work, "invocations"), { recursive: true });
				const inv = fs.mkdtempSync(path.join(work, "invocations", "i-"));
				fs.rmdirSync(inv);
				const outcome = await runPhase({ adapter: adapterOf(c.member), experiment: exp.experiment, scenario: c.scenario, arm: c.arm, member: c.member, workspace: ws.dir, work: inv, timeLimitSeconds });
				if (outcome.stop.reason === "timeout" && outcome.stop.inFlight === "unknown") timeouts++;
				const allow = [ws.dir, inv, ...c.arm.onRequest.map((o) => o.path)];
				const validity = classify(outcome, { ...forbiddenBase, allow }, Math.max(1, timeouts));
				let diff: string | null = null;
				try { diff = diffOf(ws.dir, ws.init); } catch { diff = null; }
				a = { attempt, validity, outcome, diff };
				if (diff === null && validity.valid) a = { ...a, validity: { valid: false, cause: "behaviour", detail: "the workspace's changes could not be read: the agent removed or broke its repository" } };
			} catch (e) {
				// The core could not complete the attempt; it is recorded, and the run goes on.
				const empty: Outcome = { final: "", exit: null, signal: null, stop: { reason: "error", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" };
				a = { attempt, validity: { valid: false, cause: "infrastructure", detail: `the attempt failed in the core: ${String(e).slice(0, 300)}` }, outcome: empty, diff: null, failure: String(e).slice(0, 1000) };
			}
			attempts.push(a);
			if (a.validity.valid || !RERUN[a.validity.cause] || attempt >= 2) break;
		}
		const last = attempts[attempts.length - 1]!;
		const marker = loaded.pack.masks.selfExplanationMarker;
		let scored: CellRecord["scoredFile"] = null;
		if (c.scenario.scoredFile !== undefined && lastWs !== null) {
			const content = readInside(lastWs.dir, c.scenario.scoredFile);
			scored = { path: c.scenario.scoredFile, content, matchesFinal: content !== null && content.trim() === last.outcome.final.trim() };
		}
		const answers: Record<string, string | null> = {};
		const headed = c.scenario.properties.filter((p) => p.answerHeading !== undefined);
		if (headed.length && last.validity.valid) {
			const split = splitAnswers(scored?.content ?? "", headed.map((p) => p.answerHeading!), marker);
			for (const p of headed) answers[p.id] = split.get(p.answerHeading!) ?? null;
		}
		const cr: CellRecord = {
			cell, scenario: c.scenario.id, arm: c.arm.arm, member: c.member.id, run: c.run, attempts, valid: last.validity.valid,
			final: last.validity.valid ? stripSelfExplanation(last.outcome.final, marker) : null, scoredFile: scored, answers, diff: last.diff, codeScores: [],
		};
		cellRecords.push(cr);
		write(path.join(recordsDir, "cells", `${cell}.json`), cr);
		record.cells = cellRecords.map((x) => x.cell).sort();
		save();
	});
	enter("executed");

	for (const cr of cellRecords) {
		if (!cr.valid) continue;
		const scenario = scenarios.find((s) => s.id === cr.scenario)!;
		// The measure hook gets the outcome unmasked and uncut, as the agent left it.
		const raw = cr.attempts[cr.attempts.length - 1]!.outcome.final;
		cr.codeScores = await measure(loaded, scenario, { final: raw, diff: cr.diff ?? "", scored: cr.scoredFile?.content ?? null }, now);
		write(path.join(recordsDir, "cells", `${cr.cell}.json`), cr);
	}
	enter("measured");
	record.end = "completed";
	save();
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
