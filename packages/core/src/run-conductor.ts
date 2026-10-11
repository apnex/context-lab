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
import { stripSelfExplanation } from "./answer-parser.js";
import type { Outcome } from "./outcome.js";
import type { LoadedPack, Member, Scenario, Status } from "./pack-schema.js";
import { runPhase } from "./phase-driver.js";
import { buildVariant, makeWritable, type BuiltVariant, type VariantManifest } from "./variant-builder.js";
import { classify, RERUN, type Validity } from "./validity-classifier.js";
import { createWorkspace } from "./workspace-builder.js";

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
	diff: string | null;
	codeScores: CodeScore[];
}

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
	population: string[];
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

function diffOf(workspace: string, init: string): string {
	const g = ["-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off"];
	execFileSync("git", [...g, "add", "-A"], { cwd: workspace, stdio: "ignore" });
	return execFileSync("git", [...g, "diff", "--cached", init], { cwd: workspace, encoding: "utf8", maxBuffer: 1 << 28 });
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
	enter("recorded");

	const startedAt = states[0]!.at;
	const runId = `${startedAt.replace(/[:.]/g, "").replace("T", "-").slice(0, 17)}-${experimentId}`;
	const recordsDir = path.resolve(opts.records ?? path.resolve(loaded.dir, loaded.pack.records.path), runId);
	const work = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"), runId);
	if (fs.existsSync(recordsDir)) throw new Error(`${recordsDir} exists`);
	fs.mkdirSync(work, { recursive: true });

	const armIds = exp.experiment.factors.arms;
	const variantIds = [...new Set(loaded.pack.arms.filter((a) => armIds.includes(a.id)).flatMap((a) => a.deliver.map((d) => d.variant)))];
	const built = new Map<string, BuiltVariant>();
	const variants: RunRecord["variants"] = {};
	for (const v of variantIds) {
		const source = loaded.pack.variants.find((x) => x.id === v)!.source;
		const sourceDir = path.resolve(loaded.dir, loaded.pack.sources.find((s) => s.id === source)!.path);
		const rev = opts.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
		const b = await buildVariant(loaded, v, rev, path.join(work, "variants", v));
		built.set(v, b);
		variants[v] = b.ok ? b.manifest : { failed: b.reason };
	}
	const arms: RunRecord["arms"] = {};
	const composed = new Map<string, ComposedArm>();
	for (const a of armIds) {
		const c = composeArm(loaded, a, built);
		arms[a] = c.ok ? { composed: true } : { composed: false, reason: c.reason };
		if (c.ok) composed.set(a, c.arm);
	}
	enter("built");

	const members: Member[] = exp.experiment.factors.population.map((id) => loaded.pack.population.find((m) => m.id === id)!);
	const adapterOf = (m: Member): Adapter => {
		const a = opts.adapters[m.runtime];
		if (!a) throw new Error(`no adapter for runtime ${m.runtime}`);
		return a;
	};
	const probes: ProbeResult[] = [];
	await pool([...composed.values()].flatMap((arm) => members.map((m) => ({ arm, m }))), opts.parallel ?? 4, async ({ arm, m }) => {
		probes.push(await probeArm(loaded, arm, m, adapterOf(m), { base: path.join(work, "probes", `${arm.arm}.${m.id}`), timeLimitSeconds: opts.timeLimitSeconds ?? 300 }));
	});
	const passed = (arm: string, m: string): boolean => probes.some((p) => p.arm === arm && p.member === m && p.pass);
	enter("probed");

	const runsPerCell = opts.runsPerCell ?? exp.experiment.runsPerCell;
	const forbidden = {
		paths: [...loaded.pack.isolation.forbidden.paths.map((p) => path.resolve(loaded.dir, p)), loaded.dir, recordsDir, path.join(work, "probes")],
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
		let ws = null as null | { dir: string; init: string };
		for (let attempt = 1; ; attempt++) {
			ws = createWorkspace(loaded, c.scenario, c.arm, { base: path.join(work, "workspaces"), rulesFiles: adapterOf(c.member).rulesFiles });
			fs.mkdirSync(path.join(work, "invocations"), { recursive: true });
			const inv = fs.mkdtempSync(path.join(work, "invocations", "i-"));
			fs.rmdirSync(inv);
			const outcome = await runPhase({ adapter: adapterOf(c.member), experiment: exp.experiment, scenario: c.scenario, arm: c.arm, member: c.member, workspace: ws.dir, work: inv, timeLimitSeconds: opts.timeLimitSeconds ?? 1200 });
			const validity = classify(outcome, forbidden, attempt);
			attempts.push({ attempt, validity, outcome });
			if (validity.valid || !RERUN[validity.cause] || attempt >= 2) break;
		}
		const last = attempts[attempts.length - 1]!;
		const marker = loaded.pack.masks.selfExplanationMarker;
		let scored: CellRecord["scoredFile"] = null;
		const diff = ws ? diffOf(ws.dir, ws.init) : null;
		if (c.scenario.scoredFile !== undefined && ws) {
			const f = path.join(ws.dir, c.scenario.scoredFile);
			const content = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
			scored = { path: c.scenario.scoredFile, content, matchesFinal: content !== null && content.trim() === last.outcome.final.trim() };
		}
		cellRecords.push({
			cell, scenario: c.scenario.id, arm: c.arm.arm, member: c.member.id, run: c.run, attempts, valid: last.validity.valid,
			final: last.validity.valid ? stripSelfExplanation(last.outcome.final, marker) : null, scoredFile: scored, diff, codeScores: [],
		});
	});
	enter("executed");

	for (const cr of cellRecords) {
		if (!cr.valid) continue;
		const scenario = scenarios.find((s) => s.id === cr.scenario)!;
		cr.codeScores = await measure(loaded, scenario, { final: cr.final ?? "", diff: cr.diff ?? "", scored: cr.scoredFile?.content ?? null }, now);
	}
	enter("measured");

	const record: RunRecord = {
		run: runId, pack: loaded.pack.id, experiment: experimentId, suite: suiteId, scenarios: scenarioIds,
		status: status.status, statusReason: status.reason, register: status.record,
		method: methodVersion(), states, variants, arms, probes,
		cells: cellRecords.map((c) => c.cell).sort(), runsPerCell, population: members.map((m) => m.id),
	};
	if (status.record !== null && status.record.recordedAt >= startedAt) throw new Error("the experiment's record is not earlier than the run");
	write(path.join(recordsDir, "run.json"), record);
	for (const cr of cellRecords) write(path.join(recordsDir, "cells", `${cr.cell}.json`), cr);
	for (const v of built.values()) if (v.ok) makeWritable(v.dir);
	return { dir: recordsDir, record };
}
