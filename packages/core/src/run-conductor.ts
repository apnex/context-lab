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

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvocationBudget, type Adapter, type InvocationSummary } from "./adapters.js";
import { composeArm, type ComposedArm } from "./arm-composer.js";
import { checkPack, selectScenarios } from "./pack-checker.js";
import { measure, type CodeScore } from "./code-measurer.js";
import { runStatus, contentHash, type Record as RegisterRecord } from "./experiment-register.js";
import { probeArm, type ProbeResult } from "./isolation-prober.js";
import { boundUtf8, extractAnswer, stripSelfExplanation, type AnswerExtraction, type ResponseBoundRecord } from "./answer-parser.js";
import type { Outcome } from "./outcome.js";
import { resolveEffectiveLimits, type DeliveryKind, type EffectiveLimits, type Experiment, type LimitOverrides, type LoadedPack, type Member, type Scenario, type Status } from "./pack-schema.js";
import { runPhase } from "./phase-driver.js";
import { buildVariant, makeReadOnly, makeWritable, opaqueName, variantDir, variantManifestFile, VARIANT_MANIFEST, type BuiltVariant, type VariantManifest } from "./variant-builder.js";
import { classify, forbiddenPathsNamed, RERUN, type Validity } from "./validity-classifier.js";
import { createWorkspace } from "./workspace-builder.js";
import { isInside } from "./paths.js";
import { propertyPhase, runEpisode, type PhaseRecord, type TrapAssignment } from "./episode.js";
import { sharedRun, type RestatedFlag } from "./measures.js";
import { readExposures, type Exposure } from "./experiment-register.js";
import { phasesOf, propertiesOf } from "./pack-schema.js";
import { blind, type Blinded } from "./blinder.js";
import { EMPTY_ARM, assignJudges, judgeAll, type Vote } from "./judge-panel.js";
import { resultMarkdown, tally, type Result } from "./tally.js";
import { chooseCalibrationPairs, choosePreferencePairs, type PreferenceItem } from "./pair-chooser.js";
import { runHumanPanel, type PicksRecord } from "./human-panel.js";
import { runJudgingChain, type ChainRecord } from "./judging-chain.js";
import { availableBytesAt, directoryAllocatedBytes } from "./review-panel.js";

const EMPTY_OUTCOME: Outcome = { final: "", exit: null, signal: null, stop: { reason: "error", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" };

export const STATES = ["validated", "recorded", "built", "probed", "executed", "measured", "blinded", "judged", "tallied"] as const;
export type State = (typeof STATES)[number] | "picked" | "candidates-written";

export interface RunOptions extends LimitOverrides {
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
	/** Maximum attempts per cell when an infrastructure or isolation failure triggers a re-run (1 for no retries, 2 by default). */
	maxAttemptsPerCell?: 1 | 2;
	/** Legacy alias for readerTimeLimitSeconds. */
	timeLimitSeconds?: number;
	judgeTimeLimitSeconds?: number;
	parallel?: number;
	now?: () => Date;
}

export interface CalibrateOptions extends LimitOverrides {
	experiment?: string;
	suite?: string;
	/** Path to the fixed-answer markdown file to score across the experiment's judge panel. */
	responseFile: string;
	/** Optional arm ID whose delivered files should be attached when scenario.judgedWith includes "delivered" (defaults to first guided arm or first arm). */
	arm?: string;
	/** Explicit output directory for the calibration run record (must not already exist). */
	out?: string;
	adapters: Record<string, Adapter>;
	work?: string;
	records?: string;
	revision?: string;
	/** Legacy alias for readerTimeLimitSeconds. */
	timeLimitSeconds?: number;
	judgeTimeLimitSeconds?: number;
	parallel?: number;
	now?: () => Date;
}

export interface FixedResponseProvenance {
	path: string;
	sha256: string;
	bytes: number;
	arm: string;
	syntheticMember: string;
	syntheticFamily: string;
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
	/** The first phase whose agent-behaviour failure ended its line of the episode (0020). */
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
	/** Per answer property: how its answer was extracted, and what extraction found (B23); absent from records made before it was kept. */
	extraction?: Record<string, AnswerExtraction>;
	diff: string | null;
	codeScores: CodeScore[];
	/** The trap versions and positions this cell met. */
	traps?: TrapAssignment[];
	/** Per property: the phase it is judged on, and whether that phase ran validly, ended the episode, or is incomplete. */
	propertyPhases?: Record<string, { phase: string; state: PhaseState }>;
	/** Notes and final messages sharing a run of words with a delivered instruction or folder file; diagnostic only. */
	restated?: RestatedFlag[];
	/** Non-canary instruction and folder files delivered to this cell's arm, so judgedWith: ["delivered"] can attach the assigned reading to blinded units. */
	deliveredFiles?: { file: string; text: string }[];
	/** Per phase of the last attempt that ran: what judges may be shown. */
	phaseOutcomes?: Record<string, { final: string; diff: string; note: string | null; startDiff: string; scored: string | null; traps: string[]; responseBound?: ResponseBoundRecord }>;
	/** If maxResponseBytes was configured, the UTF-8 byte bound accounting for the last phase's scored response text. */
	responseBound?: ResponseBoundRecord;
	/** Set to true when this cell record was synthesized from a fixed calibration response file rather than a live reader invocation (0040, B30). */
	syntheticCalibration?: boolean;
	fixedResponse?: FixedResponseProvenance;
}

export type PhaseState = "valid" | "ended" | "incomplete";

export type RunEnd = "completed" | "failed" | "incomplete";

export interface RunRecord {
	run: string;
	/** Execution mode: "run" for normal cold-reader experiments, or "calibrate" for fixed-answer judge calibration with zero reader calls (0040, B30). */
	mode?: "run" | "calibrate";
	/** Provenance of the fixed-answer markdown file when mode === "calibrate". */
	fixedResponse?: FixedResponseProvenance;
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
	/** Cells for which at least one attempt was dispatched (recorded before runEpisode starts). */
	dispatchedCells?: string[];
	/** Cells or judge jobs left un-run when maxTotalInvocations was exhausted. */
	missingWork?: { cells: string[]; judgeJobs: string[] };
	/** Working folder path where variants, ledgers, workspaces and invocations for this run live. */
	work?: string;
	runsPerCell: number;
	maxAttemptsPerCell?: 1 | 2;
	timeLimitSeconds: number;
	/** Complete resolved execution limits and the origin ("experiment" | "override" | "default") of each setting (0040, B30). */
	effectiveLimits?: EffectiveLimits;
	/** Public runtime-invocation accounting summary by role and pre-dispatch refusals (0040, B30). */
	invocationSummary?: InvocationSummary;
	/** Public storage accounting summary across `work` and `recordsDir` (0051, B33). */
	storageSummary?: {
		workAllocatedBytes: number;
		recordsAllocatedBytes: number;
		totalAllocatedBytes: number;
		maxRunWorkBytes: number | null;
		minFreeBytes: number | null;
		availableFreeBytesAtWork: number | null;
		availableFreeBytesAtRecords: number | null;
		storageExhausted: boolean;
		storageExhaustedReason: string | null;
	};
	population: string[];
	runtimes: Record<string, string | null>;
	/** Per member, agent or judge: how its requests reached its model, as its adapter reports (Adapter.route). */
	routes?: Record<string, Record<string, unknown> | null>;
	judges: string[];
	judgeProbes: ProbeResult[];
	/** What the tally needs, as it stood when the run began, so a re-tally does not depend on the pack. */
	snapshot: {
		scenarios: Scenario[]; arms: string[]; population: Member[];
		/** The experiment's stated variation, default, and full frozen declaration. */
		experiment?: { variation?: Experiment["variation"]; default?: string; full?: Experiment };
		/** Exposures of this run's held-out scenarios recorded before it began. */
		exposed?: Exposure[];
		/** Per arm, the files it delivered and how, so the hydration profile can tell which arms could reach an entry only on request. */
		deliveries?: Record<string, { file: string; as: DeliveryKind }[]>;
	};
	guessGroups: Record<string, string[]>;
	seed: string;
	end: RunEnd | null;
	endReason?: string;
	/** Times the run was resumed after stopping during execution (0023, B16). */
	resumedAt?: string[];
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

export interface RunLockMarker {
	owner: "context-lab";
	kind: "run" | "calibrate";
	runId: string;
	pid: number;
	startedAt: string;
	recordsDir: string;
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function writeRunLock(work: string, kind: "run" | "calibrate", runId: string, recordsDir: string, startedAt: string): void {
	const marker: RunLockMarker = { owner: "context-lab", kind, runId, pid: process.pid, startedAt, recordsDir };
	fs.writeFileSync(path.join(work, "LOCK.json"), JSON.stringify(marker, null, 2) + "\n");
	fs.writeFileSync(path.join(work, "ACTIVE"), `${process.pid}\n`);
}

function clearRunActive(work: string): void {
	try { fs.rmSync(path.join(work, "ACTIVE"), { force: true }); } catch { /* ignore */ }
}

function checkRunPreflightFreeBytes(minFreeBytes: number | null, workRoot: string, recordsTarget: string): void {
	if (minFreeBytes === null || minFreeBytes <= 0) return;
	for (const p of [workRoot, recordsTarget]) {
		const avail = availableBytesAt(p);
		if (avail.bytes === null) {
			throw new Error(`available disk space could not be measured at ${p} (${avail.error ?? "unknown"}) under minFreeBytes (${minFreeBytes} bytes) before run dispatch`);
		}
		if (avail.bytes < minFreeBytes) {
			throw new Error(`available disk space (${avail.bytes} bytes) at ${p} is below minFreeBytes (${minFreeBytes} bytes) before run dispatch`);
		}
	}
}

function makeRunStorageGuard(effectiveLimits: EffectiveLimits, work: string, recordsDir: string): () => string | null {
	return (): string | null => {
		if (effectiveLimits.minFreeBytes !== null && effectiveLimits.minFreeBytes > 0) {
			for (const p of [work, recordsDir]) {
				const avail = availableBytesAt(p);
				if (avail.bytes === null) {
					return `available disk space could not be measured at ${p} (${avail.error ?? "unknown"}) under minFreeBytes (${effectiveLimits.minFreeBytes} bytes)`;
				}
				if (avail.bytes < effectiveLimits.minFreeBytes) {
					return `available disk space (${avail.bytes} bytes) at ${p} fell below minFreeBytes (${effectiveLimits.minFreeBytes} bytes)`;
				}
			}
		}
		if (effectiveLimits.maxRunWorkBytes !== null && effectiveLimits.maxRunWorkBytes > 0) {
			const used = directoryAllocatedBytes(work) + directoryAllocatedBytes(recordsDir);
			if (used > effectiveLimits.maxRunWorkBytes) {
				return `run storage (${used} bytes across work and records) exceeds maxRunWorkBytes (${effectiveLimits.maxRunWorkBytes} bytes)`;
			}
		}
		return null;
	};
}

function computeRunStorageSummary(effectiveLimits: EffectiveLimits, work: string, recordsDir: string, budget: InvocationBudget): NonNullable<RunRecord["storageSummary"]> {
	const workAllocatedBytes = fs.existsSync(work) ? directoryAllocatedBytes(work) : 0;
	const recordsAllocatedBytes = fs.existsSync(recordsDir) ? directoryAllocatedBytes(recordsDir) : 0;
	const workAvail = availableBytesAt(work);
	const recAvail = availableBytesAt(recordsDir);
	return {
		workAllocatedBytes,
		recordsAllocatedBytes,
		totalAllocatedBytes: workAllocatedBytes + recordsAllocatedBytes,
		maxRunWorkBytes: effectiveLimits.maxRunWorkBytes,
		minFreeBytes: effectiveLimits.minFreeBytes,
		availableFreeBytesAtWork: workAvail.bytes,
		availableFreeBytesAtRecords: recAvail.bytes,
		storageExhausted: budget.isStorageExhausted(),
		storageExhaustedReason: budget.storageExhaustedReason(),
	};
}

/**
 * Reconciles transient runtime artifacts inside an interrupted invocation or `run-*` working directory
 * while preserving all session stores (`data/`, `codex-home/sessions/`), `events.jsonl`, `workspaces/`,
 * `snapshots/`, `ledgers/`, and `opencode.json` / `config.toml` (0051, B33).
 * Refuses to modify a `run-*` directory whose `LOCK.json` / `ACTIVE` marker names a live PID.
 */
export function reconcileInterruptedInvocationWork(dir: string): { removedPaths: string[]; reclaimedBytes: number; skippedActive: boolean } {
	const removedPaths: string[] = [];
	let reclaimedBytes = 0;
	if (!fs.existsSync(dir)) return { removedPaths, reclaimedBytes, skippedActive: false };

	const lockFile = path.join(dir, "LOCK.json");
	if (fs.existsSync(lockFile) && fs.existsSync(path.join(dir, "ACTIVE"))) {
		try {
			const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number };
			if (typeof lock?.pid === "number" && isPidAlive(lock.pid)) {
				return { removedPaths, reclaimedBytes, skippedActive: true };
			}
		} catch { /* proceed */ }
	}

	const removeTransient = (target: string): void => {
		if (!fs.existsSync(target)) return;
		const st = fs.lstatSync(target);
		reclaimedBytes += st.isDirectory() ? directoryAllocatedBytes(target) : (st.isFile() ? st.size : 0);
		if (st.isDirectory()) makeWritable(target);
		else if (!st.isSymbolicLink()) fs.chmodSync(target, 0o600);
		fs.rmSync(target, { recursive: true, force: true });
		removedPaths.push(target);
	};

	const cleanInvocationDir = (invDir: string): void => {
		if (!fs.existsSync(invDir)) return;
		removeTransient(path.join(invDir, "cache"));
		removeTransient(path.join(invDir, "home"));
		const xdgOc = path.join(invDir, "config", "opencode");
		if (fs.existsSync(xdgOc)) {
			for (const f of fs.readdirSync(xdgOc)) {
				if (f !== "opencode.json") removeTransient(path.join(xdgOc, f));
			}
		}
		const dataDir = path.join(invDir, "data");
		if (fs.existsSync(dataDir)) {
			for (const e of fs.readdirSync(dataDir, { recursive: true, withFileTypes: true })) {
				if (e.isFile() && e.name === "auth.json") removeTransient(path.join(e.parentPath, e.name));
			}
		}
		const codexHome = path.join(invDir, "codex-home");
		if (fs.existsSync(codexHome)) {
			removeTransient(path.join(codexHome, "auth.json"));
			for (const f of fs.readdirSync(codexHome)) {
				if (/\.sqlite(-shm|-wal)?$/.test(f)) removeTransient(path.join(codexHome, f));
			}
		}
	};

	// `dir` may be either a single invocation folder (`work` passed to `adapter.invoke`) or a whole `run-*` folder.
	cleanInvocationDir(dir);
	for (const sub of ["invocations", path.join("judging", "invocations")]) {
		const p = path.join(dir, sub);
		if (fs.existsSync(p)) {
			for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
				if (ent.isDirectory()) cleanInvocationDir(path.join(p, ent.name));
			}
		}
	}
	const probesDir = path.join(dir, "probes");
	if (fs.existsSync(probesDir)) {
		for (const pEnt of fs.readdirSync(probesDir, { withFileTypes: true })) {
			if (!pEnt.isDirectory()) continue;
			const wSub = path.join(probesDir, pEnt.name, "work");
			if (fs.existsSync(wSub)) {
				for (const invEnt of fs.readdirSync(wSub, { withFileTypes: true })) {
					if (invEnt.isDirectory()) cleanInvocationDir(path.join(wSub, invEnt.name));
				}
			}
		}
	}
	return { removedPaths, reclaimedBytes, skippedActive: false };
}

/**
 * Safely reconciles or retires `run-*` working directories under `workRoot` (0051, B33):
 * - Skips any directory without a `context-lab` `LOCK.json` ownership marker (`skippedUnowned`).
 * - Skips any directory with an `ACTIVE` lock for a live PID (`skippedActive`).
 * - By default (`retireCompletedWork: false`), strips only transient cache/home/auth files from dead-PID
 *   `run-*` folders via `reconcileInterruptedInvocationWork`, preserving all session, workspace, snapshot,
 *   ledger, and event evidence (`reconciled`).
 * - When `retireCompletedWork: true` is passed, removes `run-*` folders whose corresponding `recordsDir/run.json`
 *   has `end === "completed"` and a verified `RESULT.json` on disk (`retiredCompleted`), while still preserving
 *   incomplete or failed runs (`skippedIncomplete`).
 */
export function cleanRunWorkRoot(
	workRoot: string,
	opts: { retireCompletedWork?: boolean } = {},
): { reconciled: string[]; retiredCompleted: string[]; skippedActive: string[]; skippedIncomplete: string[]; skippedUnowned: string[]; reclaimedBytes: number } {
	const reconciled: string[] = [];
	const retiredCompleted: string[] = [];
	const skippedActive: string[] = [];
	const skippedIncomplete: string[] = [];
	const skippedUnowned: string[] = [];
	let reclaimedBytes = 0;
	if (!fs.existsSync(workRoot)) return { reconciled, retiredCompleted, skippedActive, skippedIncomplete, skippedUnowned, reclaimedBytes };

	for (const ent of fs.readdirSync(workRoot, { withFileTypes: true })) {
		if (!ent.isDirectory() || !ent.name.startsWith("run-")) continue;
		const dir = path.join(workRoot, ent.name);
		const lockFile = path.join(dir, "LOCK.json");
		if (!fs.existsSync(lockFile)) {
			skippedUnowned.push(dir);
			continue;
		}
		let lock: RunLockMarker | null = null;
		try {
			lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as RunLockMarker;
		} catch {
			skippedUnowned.push(dir);
			continue;
		}
		if (lock?.owner !== "context-lab" || (lock.kind !== "run" && lock.kind !== "calibrate")) {
			skippedUnowned.push(dir);
			continue;
		}
		if (fs.existsSync(path.join(dir, "ACTIVE")) && isPidAlive(lock.pid)) {
			skippedActive.push(dir);
			continue;
		}
		const rec = reconcileInterruptedInvocationWork(dir);
		reclaimedBytes += rec.reclaimedBytes;
		reconciled.push(dir);

		if (opts.retireCompletedWork) {
			const runJsonPath = path.join(lock.recordsDir, "run.json");
			const resultJsonPath = path.join(lock.recordsDir, "RESULT.json");
			let isCompleted = false;
			if (fs.existsSync(runJsonPath) && fs.existsSync(resultJsonPath)) {
				try {
					const rj = JSON.parse(fs.readFileSync(runJsonPath, "utf8")) as { end?: string };
					isCompleted = rj?.end === "completed";
				} catch {
					isCompleted = false;
				}
			}
			if (isCompleted) {
				reclaimedBytes += directoryAllocatedBytes(dir);
				makeWritable(dir);
				fs.rmSync(dir, { recursive: true, force: true });
				retiredCompleted.push(dir);
			} else {
				skippedIncomplete.push(dir);
			}
		}
	}
	return { reconciled, retiredCompleted, skippedActive, skippedIncomplete, skippedUnowned, reclaimedBytes };
}

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
	const enter = (s: (typeof STATES)[number]): void => {
		const last = states[states.length - 1];
		if (STATES.indexOf(s) !== (last ? STATES.indexOf(last.state as (typeof STATES)[number]) + 1 : 0)) throw new Error(`state ${s} out of order`);
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
	if (opts.maxAttemptsPerCell !== undefined && opts.maxAttemptsPerCell !== 1 && opts.maxAttemptsPerCell !== 2) {
		throw new Error(`maxAttemptsPerCell must be 1 or 2, got ${String(opts.maxAttemptsPerCell)}`);
	}
	const readerTimeOverride = opts.readerTimeLimitSeconds ?? opts.timeLimitSeconds;
	const effectiveLimits = resolveEffectiveLimits(exp.experiment, {
		...(readerTimeOverride !== undefined ? { readerTimeLimitSeconds: readerTimeOverride } : {}),
		...(opts.judgeTimeLimitSeconds !== undefined ? { judgeTimeLimitSeconds: opts.judgeTimeLimitSeconds } : {}),
		...(opts.probeTimeLimitSeconds !== undefined ? { probeTimeLimitSeconds: opts.probeTimeLimitSeconds } : {}),
		...(opts.maxAttemptsPerCell !== undefined ? { maxAttemptsPerCell: opts.maxAttemptsPerCell } : {}),
		...(opts.maxProbeAttempts !== undefined ? { maxProbeAttempts: opts.maxProbeAttempts } : {}),
		...(opts.maxJudgeAttempts !== undefined ? { maxJudgeAttempts: opts.maxJudgeAttempts } : {}),
		...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
		...(opts.maxReaderInputBytes !== undefined ? { maxReaderInputBytes: opts.maxReaderInputBytes } : {}),
		...(opts.maxJudgeInputBytes !== undefined ? { maxJudgeInputBytes: opts.maxJudgeInputBytes } : {}),
		...(opts.maxProbeInputBytes !== undefined ? { maxProbeInputBytes: opts.maxProbeInputBytes } : {}),
		...(opts.maxJudgeReplyBytes !== undefined ? { maxJudgeReplyBytes: opts.maxJudgeReplyBytes } : {}),
		...(opts.maxProbeReplyBytes !== undefined ? { maxProbeReplyBytes: opts.maxProbeReplyBytes } : {}),
		...(opts.maxStdoutBytes !== undefined ? { maxStdoutBytes: opts.maxStdoutBytes } : {}),
		...(opts.maxTotalInvocations !== undefined ? { maxTotalInvocations: opts.maxTotalInvocations } : {}),
		...(opts.minFreeBytes !== undefined ? { minFreeBytes: opts.minFreeBytes } : {}),
		...(opts.maxRunWorkBytes !== undefined ? { maxRunWorkBytes: opts.maxRunWorkBytes } : {}),
	});
	const maxAttemptsPerCell: 1 | 2 = effectiveLimits.maxAttemptsPerCell;
	let statusValue = status.status, statusReason = status.reason;
	if (runsPerCell !== exp.experiment.runsPerCell && statusValue === "result") {
		statusValue = "exploration";
		statusReason = `runs per cell overridden to ${runsPerCell}, from the recorded ${exp.experiment.runsPerCell}`;
	}
	const overriddenKeys = (Object.entries(effectiveLimits.origins) as [keyof Omit<EffectiveLimits, "origins">, string][])
		.filter(([, origin]) => origin === "override")
		.map(([k]) => k);
	if (overriddenKeys.length > 0 && status.record !== null) {
		throw new Error(`execution limits overridden (${overriddenKeys.join(", ")}) disagree with registered experiment ${experimentId} (${status.record.hash}); register the updated profile or omit the override`);
	}
	if (overriddenKeys.length > 0 && statusValue === "result") {
		statusValue = "exploration";
		statusReason = `execution limits overridden (${overriddenKeys.join(", ")}) from the recorded experiment declaration`;
	}
	enter("recorded");

	const runId = `${startedAt.replace(/[:.]/g, "").replace("T", "-").slice(0, 17)}-${experimentId}`;
	const recordsRoot = path.resolve(opts.records ?? path.resolve(loaded.dir, loaded.pack.records.path));
	const recordsDir = path.join(recordsRoot, runId);
	const workRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
	checkRunPreflightFreeBytes(effectiveLimits.minFreeBytes, workRoot, recordsRoot);
	fs.mkdirSync(recordsRoot, { recursive: true });
	fs.mkdirSync(workRoot, { recursive: true });
	// Made without recursion, so a second run started in the same second is refused, not merged.
	fs.mkdirSync(recordsDir);
	// The work folder holds every path an agent or judge is given, so its name carries no run id,
	// which ends with the experiment's (B21); run.json records where it is.
	const work = fs.mkdtempSync(path.join(workRoot, "run-"));
	writeRunLock(work, "run", runId, recordsDir, startedAt);
	const timeLimitSeconds = effectiveLimits.readerTimeLimitSeconds;
	const budget = new InvocationBudget(effectiveLimits.maxTotalInvocations, undefined, makeRunStorageGuard(effectiveLimits, work, recordsDir));
	const armIds0 = exp.experiment.factors.arms;
	const record: RunRecord = {
		run: runId, mode: "run", pack: loaded.pack.id, experiment: experimentId, suite: suiteId, scenarios: scenarioIds,
		status: statusValue, statusReason, register: status.record, method: methodVersion(), states,
		variants: {}, arms: {}, probes: [], cells: [], dispatchedCells: [], work, runsPerCell, maxAttemptsPerCell, timeLimitSeconds,
		effectiveLimits, invocationSummary: budget.summary(),
		population: exp.experiment.factors.population, runtimes: {}, judges: [], judgeProbes: [],
		snapshot: {
			scenarios, arms: armIds0, population: loaded.pack.population,
			experiment: { ...(exp.experiment.variation !== undefined ? { variation: exp.experiment.variation } : {}), ...(exp.experiment.default !== undefined ? { default: exp.experiment.default } : {}), full: exp.experiment },
			exposed: readExposures(loaded).filter((e) => scenarios.some((x) => x.id === e.scenario && x.heldOut === true)),
			deliveries: Object.fromEntries(armIds0.map((a) => [a, (loaded.pack.arms.find((x) => x.id === a)?.deliver ?? []).map((d) => ({ file: d.file, as: d.as }))])),
		},
		guessGroups: exp.experiment.judging?.guessGroups ?? Object.fromEntries(armIds0.map((a) => [a, [a]])), seed: runId, end: null,
	};
	// The record is written at every state and as each cell ends, so a run that stops part way
	// leaves everything it did.
	const save = (includeStorage = false): void => {
		record.invocationSummary = budget.summary();
		if (includeStorage) record.storageSummary = computeRunStorageSummary(effectiveLimits, work, recordsDir, budget);
		write(path.join(recordsDir, "run.json"), record);
	};
	save();
	const built = new Map<string, BuiltVariant>();
	try {

	const armIds = exp.experiment.factors.arms;
	const variantIds = [...new Set(loaded.pack.arms.filter((a) => armIds.includes(a.id)).flatMap((a) => a.deliver.map((d) => d.variant)))];
	const variants = record.variants;
	for (const v of variantIds) {
		const decl = loaded.pack.variants.find((x) => x.id === v)!;
		const source = decl.source;
		const sourceDir = path.resolve(loaded.dir, loaded.pack.sources.find((s) => s.id === source)!.path);
		const rev = decl.revision ?? opts.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
		const b = await buildVariant(loaded, v, rev, variantDir(work, v));
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
	record.routes ??= {};
	for (const m of members) record.routes[m.id] = adapterOf(m).route?.(m) ?? null;
	const probes: ProbeResult[] = record.probes;
	await pool([...composed.values()].flatMap((arm) => members.map((m) => ({ arm, m }))), opts.parallel ?? 4, async ({ arm, m }) => {
		probes.push(await probeArm(loaded, arm, m, adapterOf(m), {
			base: path.join(work, "probes", opaqueName("p", `${arm.arm}.${m.id}`)),
			timeLimitSeconds: effectiveLimits.probeTimeLimitSeconds,
			maxAttempts: effectiveLimits.maxProbeAttempts,
			...(effectiveLimits.maxProbeInputBytes !== null ? { maxInputBytes: effectiveLimits.maxProbeInputBytes } : {}),
			...(effectiveLimits.maxProbeReplyBytes !== null ? { maxReplyBytes: effectiveLimits.maxProbeReplyBytes } : {}),
			...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
			budget,
			role: "readerProbe",
		}));
	});
	probes.sort((a, b) => `${a.arm}.${a.member}`.localeCompare(`${b.arm}.${b.member}`));
	// Judges are probed as agents are, with nothing given and every leak probe asked.
	const judgeMembers: Member[] = (exp.experiment.judging?.judges ?? exp.experiment.factors.population).map((id) => loaded.pack.population.find((m) => m.id === id)!);
	for (const j of judgeMembers) if (!(j.runtime in record.runtimes)) record.runtimes[j.runtime] = adapterOf(j).version?.() ?? null;
	record.routes ??= {};
	for (const j of judgeMembers) record.routes[j.id] ??= adapterOf(j).route?.(j) ?? null;
	await pool(judgeMembers, opts.parallel ?? 4, async (j) => {
		record.judgeProbes.push(await probeArm(loaded, EMPTY_ARM, j, adapterOf(j), {
			base: path.join(work, "probes", opaqueName("p", `judge.${j.id}`)),
			timeLimitSeconds: effectiveLimits.probeTimeLimitSeconds,
			allLeaks: true,
			maxAttempts: effectiveLimits.maxProbeAttempts,
			...(effectiveLimits.maxProbeInputBytes !== null ? { maxInputBytes: effectiveLimits.maxProbeInputBytes } : {}),
			...(effectiveLimits.maxProbeReplyBytes !== null ? { maxReplyBytes: effectiveLimits.maxProbeReplyBytes } : {}),
			...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
			budget,
			role: "judgeProbe",
		}));
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
	const missingCells: string[] = [];
	await pool(cells, opts.parallel ?? 4, async (c) => {
		const cell = `${c.scenario.id}.${c.arm.arm}.${c.member.id}.${c.run}`;
		if (budget.isExhausted()) {
			missingCells.push(cell);
			return;
		}
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
			if (budget.isExhausted()) break;
			let a: Attempt;
			const unreachable: string[] = [];
			record.dispatchedCells = [...new Set([...(record.dispatchedCells ?? []), cell])].sort();
			save();
			try {
				const ep = await runEpisode({
					loaded, experiment: exp.experiment, scenario: c.scenario, arm: c.arm, member: c.member, memberIndex: members.indexOf(c.member), run: c.run,
					adapter, work, key: `${cell}.${attempt}`, timeLimitSeconds,
					...(effectiveLimits.maxReaderInputBytes !== null ? { maxInputBytes: effectiveLimits.maxReaderInputBytes } : {}),
					...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
					budget,
					timeouts,
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
			const maxAttempts = effectiveLimits.maxAttemptsPerCell;
			if (a.validity.valid || !RERUN[a.validity.cause] || attempt >= maxAttempts || budget.isExhausted()) break;
		}
		if (attempts.length === 0) {
			missingCells.push(cell);
			return;
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
		const maxBytes = c.scenario.maxResponseBytes ?? effectiveLimits.maxResponseBytes ?? undefined;
		let lastBound: ResponseBoundRecord | undefined;
		const beforeBound: Record<string, { final: string; scored: string | null }> = {};
		for (const p of lastPhases) {
			if (p.status !== "run" || p.validity?.valid !== true || p.outcome === null) continue;
			const rawScored = c.scenario.scoredFile !== undefined && p.snapshot !== null ? readInside(p.snapshot, c.scenario.scoredFile) : null;
			const { final, scored: scoredContent, responseBound, pre } = phaseText(c.scenario, maxBytes, marker, p.outcome.final, rawScored);
			if (maxBytes !== undefined) lastBound = responseBound;
			beforeBound[p.phase] = pre;
			phaseOutcomes[p.phase] = {
				final, diff: p.diff ?? "", note: p.note, startDiff: p.startDiff, scored: scoredContent, traps: p.traps.map((t) => t.text),
				...(responseBound !== undefined ? { responseBound } : {}),
			};
		}
		const lastRan = [...lastPhases].reverse().find((p) => p.status === "run" && p.snapshot !== null);
		let scored: CellRecord["scoredFile"] = null;
		if (c.scenario.scoredFile !== undefined && lastRan !== undefined) {
			const content = readInside(lastRan.snapshot!, c.scenario.scoredFile);
			scored = { path: c.scenario.scoredFile, content, matchesFinal: content !== null && content.trim() === (lastRan.outcome?.final ?? "").trim() };
		}
		const { answers, extraction } = answersOf(c.scenario, propertyPhases, phaseOutcomes, beforeBound, marker, attempts.length);
		// Restated guidance: every final message and every note a session was given, in the last attempt,
		// against every file delivered to the arm as an instruction or a folder file.
		const restated: RestatedFlag[] = [];
		const { delivered, deliveredFiles } = deliveredOf(c.arm);
		for (const p of lastPhases.filter((x) => x.status === "run")) {
			const decl = phases.find((x) => x.id === p.phase);
			const texts: { source: "final" | "note"; path: string; text: string }[] = [];
			if (p.outcome !== null) texts.push({ source: "final", path: `(final message of ${p.phase})`, text: p.outcome.final });
			if (p.note !== null && p.noteSource !== null) texts.push({ source: "note", path: decl?.note !== undefined && "file" in decl.note ? decl.note.file : `(note from hook ${decl?.note !== undefined && "generator" in decl.note ? decl.note.generator : "?"})`, text: p.note });
			for (const t of texts) for (const d of delivered) {
				const run = sharedRun(t.text, d.text);
				if (run !== null) restated.push({ cell, phase: p.phase, source: t.source, path: t.path, delivered: { file: d.file, path: d.path }, words: run });
			}
		}
		const cr: CellRecord = {
			cell, scenario: c.scenario.id, arm: c.arm.arm, member: c.member.id, run: c.run, attempts, valid: last.validity.valid,
			final: last.validity.valid ? (lastRan ? (phaseOutcomes[lastRan.phase]?.final ?? stripSelfExplanation(last.outcome.final, marker)) : stripSelfExplanation(last.outcome.final, marker)) : null,
			scoredFile: scored, answers, ...(Object.keys(extraction).length ? { extraction } : {}), diff: last.diff, codeScores: [],
			traps, propertyPhases, phaseOutcomes, restated,
			...(deliveredFiles.length ? { deliveredFiles } : {}),
			...(lastBound !== undefined ? { responseBound: lastBound } : {}),
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
			const po = cr.phaseOutcomes?.[p.phase];
			const maxBytes = scenario.maxResponseBytes ?? exp.experiment.maxResponseBytes;
			const rawScored = scenario.scoredFile !== undefined && p.snapshot !== null ? readInside(p.snapshot, scenario.scoredFile) : null;
			const measuredFinal = maxBytes !== undefined ? boundUtf8(p.outcome.final, maxBytes).text : p.outcome.final;
			const measuredScored = maxBytes !== undefined && rawScored !== null ? boundUtf8(rawScored, maxBytes).text : (po?.scored ?? null);
			cr.codeScores.push(...await measure(loaded, sub, { final: measuredFinal, rawFinal: p.outcome.final, diff: p.diff ?? "", scored: measuredScored, rawScored, snapshot: p.snapshot }, now));
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
		guessOptions: Object.keys(record.guessGroups), recordsDir, work, seed: record.seed,
		timeLimitSeconds: effectiveLimits.judgeTimeLimitSeconds, parallel: opts.parallel ?? 4,
		maxAttempts: effectiveLimits.maxJudgeAttempts,
		...(effectiveLimits.maxJudgeInputBytes !== null ? { maxInputBytes: effectiveLimits.maxJudgeInputBytes } : {}),
		...(effectiveLimits.maxJudgeReplyBytes !== null ? { maxReplyBytes: effectiveLimits.maxJudgeReplyBytes } : {}),
		...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
		budget,
	});
	write(path.join(recordsDir, "judging", "votes.json"), votes);
	if (exp.experiment.judging?.chain !== undefined && !budget.isExhausted()) {
		await runJudgingChain({
			loaded, chain: exp.experiment.judging.chain, units: blinded.units, judges, adapters: opts.adapters,
			recordsDir, work, timeLimitSeconds: effectiveLimits.judgeTimeLimitSeconds,
		});
	}
	enter("judged");
	save();

	const missingJudgeJobs = [...new Set(votes.filter((v) => v.value === null && /maxTotalInvocations|budget-exhausted|storage|minFreeBytes|maxRunWorkBytes/.test(v.reason)).map((v) => v.prompt))].sort();
	if (missingCells.length > 0 || missingJudgeJobs.length > 0 || budget.summary().exhausted) {
		record.missingWork = { cells: missingCells.sort(), judgeJobs: missingJudgeJobs };
	}
	const result = tallyRun(recordsDir);
	enter("tallied");
	if (record.missingWork !== undefined) {
		record.end = "incomplete";
		record.endReason = budget.isStorageExhausted()
			? `${budget.storageExhaustedReason() ?? "run storage ceiling exhausted"}; missing ${record.missingWork.cells.length} cell(s) and ${record.missingWork.judgeJobs.length} judge job(s)`
			: `maxTotalInvocations (${effectiveLimits.maxTotalInvocations}) exhausted; missing ${record.missingWork.cells.length} cell(s) and ${record.missingWork.judgeJobs.length} judge job(s)`;
	} else {
		record.end = "completed";
	}
	save(true);
	void result;
	} catch (e) {
		record.end = "failed";
		record.endReason = String(e).slice(0, 1000);
		save(true);
		throw e;
	} finally {
		clearRunActive(work);
		for (const v of built.values()) if (v.ok && fs.existsSync(v.dir)) makeWritable(v.dir);
	}
	return { dir: recordsDir, record };
}

export interface ResumeOptions extends LimitOverrides {
	adapters: Record<string, Adapter>;
	/** The operator's working folder; ~/context-lab-work if not given. */
	work?: string;
	timeLimitSeconds?: number;
	judgeTimeLimitSeconds?: number;
	parallel?: number;
	now?: () => Date;
}

const canonicalJson = (v: unknown): string => {
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
	if (typeof v === "object" && v !== null) return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
	return JSON.stringify(v);
};

/**
 * Resume a run that stopped during execution, after its probes finished and before blinding began
 * (0023, B16). Checks that the pack, the experiment's register hash, the routes and the already
 * recorded cells are intact, runs only the remaining cells, then proceeds through measurement,
 * blinding, judging and tallying.
 */
export async function resumeRun(packDir: string, recordsDir: string, opts: ResumeOptions): Promise<{ dir: string; record: RunRecord }> {
	const now = opts.now ?? ((): Date => new Date());
	const resolvedRecords = path.resolve(recordsDir);
	const recordsRoot = path.dirname(resolvedRecords);
	const recordFile = path.join(resolvedRecords, "run.json");
	if (!fs.existsSync(recordFile)) throw new Error(`no run.json in ${resolvedRecords}`);
	const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as RunRecord;
	if (record.end === "completed") throw new Error(`run ${record.run} is already completed`);
	const stateList = record.states.map((s) => s.state);
	const afterExecuted = stateList.join(",") === "validated,recorded,built,probed,executed" ||
		stateList.join(",") === "validated,recorded,built,probed,executed,measured" ||
		stateList.join(",") === "validated,recorded,built,probed,executed,measured,blinded" ||
		stateList.join(",") === "validated,recorded,built,probed,executed,measured,blinded,judged";
	if (stateList.join(",") !== "validated,recorded,built,probed" && !afterExecuted) {
		throw new Error(`run ${record.run} is at state ${stateList[stateList.length - 1] ?? "none"}; only a run stopped after probed and before tallied can be resumed`);
	}
	const checked = await checkPack(packDir, {
		continueRuntimes: Object.fromEntries(Object.entries(opts.adapters).map(([k, a]) => [k, a.continue])),
		experiments: [record.experiment],
	});
	if (!checked.ok) throw new Error(`the pack fails its check: ${checked.defects.map((d) => `${d.check} ${d.where} ${d.message}`).join("; ")}`);
	const loaded = checked.loaded;
	if (loaded.pack.id !== record.pack) throw new Error(`run ${record.run} belongs to pack ${record.pack}, not ${loaded.pack.id}`);
	const exp = loaded.experiments.get(record.experiment);
	if (!exp) throw new Error(`no experiment ${record.experiment}`);
	if (record.register !== null && contentHash(loaded, record.experiment) !== record.register.hash) {
		throw new Error(`experiment ${record.experiment} has changed since run ${record.run} was recorded, so the run cannot be resumed`);
	}
	const scenarios = record.snapshot.scenarios;
	const members: Member[] = record.population.map((id) => record.snapshot.population.find((m) => m.id === id)!);
	const judgeMembers: Member[] = (exp.experiment.judging?.judges ?? record.population).map((id) => record.snapshot.population.find((m) => m.id === id)!);
	const adapterOf = (m: Member): Adapter => {
		const a = opts.adapters[m.runtime];
		if (!a) throw new Error(`no adapter for runtime ${m.runtime}`);
		return a;
	};
	if (record.routes !== undefined) {
		const currentRoutes: Record<string, Record<string, unknown> | null> = {};
		for (const m of members) currentRoutes[m.id] = adapterOf(m).route?.(m) ?? null;
		for (const j of judgeMembers) currentRoutes[j.id] ??= adapterOf(j).route?.(j) ?? null;
		if (canonicalJson(currentRoutes) !== canonicalJson(record.routes)) {
			throw new Error(`routes to the models have changed since run ${record.run} began, so the run cannot be resumed`);
		}
	}

	const workRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
	// The recorded folder's name under the given root; a record made before run.json kept its work
	// folder used the run id.
	const work = path.join(workRoot, record.work !== undefined ? path.basename(record.work) : record.run);
	const baseEffective = record.effectiveLimits ?? resolveEffectiveLimits(exp.experiment, {
		readerTimeLimitSeconds: record.timeLimitSeconds,
		...(record.maxAttemptsPerCell !== undefined ? { maxAttemptsPerCell: record.maxAttemptsPerCell } : {}),
	});
	const readerTimeOverride = opts.readerTimeLimitSeconds ?? opts.timeLimitSeconds;
	const checkNotOverridden = <T>(name: string, ov: T | undefined, rec: T): void => {
		if (ov !== undefined && ov !== rec) {
			throw new Error(`cannot override ${name} (${String(ov)} vs recorded ${String(rec)}) when resuming run ${record.run}`);
		}
	};
	checkNotOverridden("readerTimeLimitSeconds", readerTimeOverride, baseEffective.readerTimeLimitSeconds);
	checkNotOverridden("judgeTimeLimitSeconds", opts.judgeTimeLimitSeconds, baseEffective.judgeTimeLimitSeconds);
	checkNotOverridden("probeTimeLimitSeconds", opts.probeTimeLimitSeconds, baseEffective.probeTimeLimitSeconds);
	checkNotOverridden("maxAttemptsPerCell", opts.maxAttemptsPerCell, baseEffective.maxAttemptsPerCell);
	checkNotOverridden("maxProbeAttempts", opts.maxProbeAttempts, baseEffective.maxProbeAttempts);
	checkNotOverridden("maxJudgeAttempts", opts.maxJudgeAttempts, baseEffective.maxJudgeAttempts);
	checkNotOverridden("maxResponseBytes", opts.maxResponseBytes, baseEffective.maxResponseBytes ?? undefined);
	checkNotOverridden("maxReaderInputBytes", opts.maxReaderInputBytes, baseEffective.maxReaderInputBytes ?? undefined);
	checkNotOverridden("maxJudgeInputBytes", opts.maxJudgeInputBytes, baseEffective.maxJudgeInputBytes ?? undefined);
	checkNotOverridden("maxProbeInputBytes", opts.maxProbeInputBytes, baseEffective.maxProbeInputBytes ?? undefined);
	checkNotOverridden("maxJudgeReplyBytes", opts.maxJudgeReplyBytes, baseEffective.maxJudgeReplyBytes ?? undefined);
	checkNotOverridden("maxProbeReplyBytes", opts.maxProbeReplyBytes, baseEffective.maxProbeReplyBytes ?? undefined);
	checkNotOverridden("maxStdoutBytes", opts.maxStdoutBytes, baseEffective.maxStdoutBytes ?? undefined);
	checkNotOverridden("maxTotalInvocations", opts.maxTotalInvocations, baseEffective.maxTotalInvocations ?? undefined);
	checkNotOverridden("minFreeBytes", opts.minFreeBytes, baseEffective.minFreeBytes ?? undefined);
	checkNotOverridden("maxRunWorkBytes", opts.maxRunWorkBytes, baseEffective.maxRunWorkBytes ?? undefined);
	const effectiveLimits = baseEffective;
	record.effectiveLimits ??= effectiveLimits;
	checkRunPreflightFreeBytes(effectiveLimits.minFreeBytes, workRoot, resolvedRecords);
	const budget = new InvocationBudget(effectiveLimits.maxTotalInvocations, record.invocationSummary, makeRunStorageGuard(effectiveLimits, work, resolvedRecords));
	const maxAttemptsPerCell: 1 | 2 = effectiveLimits.maxAttemptsPerCell;
	if (maxAttemptsPerCell === 1 && record.work !== undefined && path.resolve(record.work) !== path.resolve(work)) {
		throw new Error(`run ${record.run} recorded working folder ${record.work}, not ${work}, under maxAttemptsPerCell: 1`);
	}
	if (maxAttemptsPerCell === 1 && !fs.existsSync(work)) {
		throw new Error(`working folder ${work} is missing under maxAttemptsPerCell: 1, so prior dispatch cannot be excluded`);
	}
	fs.mkdirSync(work, { recursive: true });
	writeRunLock(work, record.mode === "calibrate" ? "calibrate" : "run", record.run, resolvedRecords, now().toISOString());
	const built = new Map<string, BuiltVariant>();
	const save = (includeStorage = false): void => {
		record.invocationSummary = budget.summary();
		if (includeStorage) record.storageSummary = computeRunStorageSummary(effectiveLimits, work, resolvedRecords, budget);
		write(recordFile, record);
	};
	const enter = (s: (typeof STATES)[number]): void => {
		if (record.states.some((x) => x.state === s)) return;
		const last = record.states[record.states.length - 1];
		if (STATES.indexOf(s) !== (last ? STATES.indexOf(last.state as (typeof STATES)[number]) + 1 : 0)) throw new Error(`state ${s} out of order`);
		record.states.push({ state: s, at: now().toISOString() });
	};

	try {
		for (const [v, entry] of Object.entries(record.variants)) {
			if ("failed" in entry) {
				built.set(v, { ok: false, variant: v, reason: entry.failed });
				continue;
			}
			// A run made before variant folders were opaque built each under its id, its manifest inside.
			const legacy = path.join(work, "variants", v);
			const vDir = fs.existsSync(legacy) && !fs.existsSync(variantDir(work, v)) ? legacy : variantDir(work, v);
			const mfFile = vDir === legacy ? path.join(vDir, VARIANT_MANIFEST) : variantManifestFile(vDir);
			if (fs.existsSync(mfFile)) {
				const onDisk = JSON.parse(fs.readFileSync(mfFile, "utf8")) as VariantManifest;
				if (canonicalJson(onDisk) !== canonicalJson(entry)) throw new Error(`variant ${v} on disk does not match run.json`);
				makeReadOnly(vDir);
				built.set(v, { ok: true, dir: vDir, manifest: onDisk });
			} else {
				const b = await buildVariant(loaded, v, entry.revision, vDir);
				if (!b.ok || canonicalJson(b.manifest) !== canonicalJson(entry)) throw new Error(`variant ${v} could not be rebuilt identically at ${entry.revision}`);
				built.set(v, b);
			}
		}
		const composed = new Map<string, ComposedArm>();
		for (const a of record.snapshot.arms) {
			const c = composeArm(loaded, a, built);
			if ((record.arms[a]?.composed ?? false) !== c.ok) throw new Error(`arm ${a} composition does not match run.json`);
			if (c.ok) composed.set(a, c.arm);
		}
		const passed = (arm: string, m: string): boolean => record.probes.some((p) => p.arm === arm && p.member === m && p.pass);
		const allCells: { scenario: Scenario; arm: ComposedArm; member: Member; run: number }[] = [];
		for (const scenario of scenarios) for (const arm of composed.values()) for (const member of members) {
			if (!passed(arm.arm, member.id)) continue;
			for (let run = 1; run <= record.runsPerCell; run++) allCells.push({ scenario, arm, member, run });
		}
		const expectedSet = new Set(allCells.map((c) => `${c.scenario.id}.${c.arm.arm}.${c.member.id}.${c.run}`));
		const cellRecords: CellRecord[] = [];
		const doneSet = new Set<string>();
		for (const cell of record.cells) {
			if (!expectedSet.has(cell)) throw new Error(`recorded cell ${cell} is not part of run ${record.run}`);
			const cf = path.join(resolvedRecords, "cells", `${cell}.json`);
			if (!fs.existsSync(cf)) throw new Error(`recorded cell ${cell} is missing its file ${cf}`);
			const cr = JSON.parse(fs.readFileSync(cf, "utf8")) as CellRecord;
			if (cr.cell !== cell || !Array.isArray(cr.attempts) || cr.attempts.length === 0) throw new Error(`recorded cell ${cell} is malformed`);
			cellRecords.push(cr);
			doneSet.add(cell);
		}
		const timeLimitSeconds = effectiveLimits.readerTimeLimitSeconds;
		const remaining = allCells.filter((c) => !doneSet.has(`${c.scenario.id}.${c.arm.arm}.${c.member.id}.${c.run}`));
		if (afterExecuted && remaining.length > 0) {
			throw new Error(`run ${record.run} is past executed, but ${remaining.length} expected cell(s) are missing from cells/`);
		}
		// Refuse to resume a single-attempt run (or a run with a total-invocation ceiling) if an unrecorded cell was already dispatched.
		if ((maxAttemptsPerCell === 1 || effectiveLimits.maxTotalInvocations !== null) && remaining.length > 0) {
			const dispatchedSet = new Set(record.dispatchedCells ?? []);
			const checkDirs = [path.join(work, "ledgers"), path.join(work, "snapshots"), path.join(work, "workspaces"), path.join(work, "invocations")];
			for (const c of remaining) {
				const cell = `${c.scenario.id}.${c.arm.arm}.${c.member.id}.${c.run}`;
				const prefix = `${cell}.`;
				const hasPartial = dispatchedSet.has(cell) || checkDirs.some((dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((e) => e.startsWith(prefix)));
				if (hasPartial) {
					throw new Error(`cell ${cell} has an unrecorded partial attempt on disk in ${work} under maxAttemptsPerCell: ${maxAttemptsPerCell}${effectiveLimits.maxTotalInvocations !== null ? ` / maxTotalInvocations: ${effectiveLimits.maxTotalInvocations}` : ""}, so the run cannot be resumed without risking an uncounted or duplicate attempt`);
				}
			}
		}
		record.end = null;
		delete record.endReason;
		record.resumedAt = [...(record.resumedAt ?? []), now().toISOString()];
		save();

		const forbiddenBase = {
			paths: [
				...loaded.pack.isolation.forbidden.paths.map((p) => path.resolve(loaded.dir, p)), loaded.dir, recordsRoot, workRoot,
				...loaded.pack.sources.map((s) => path.resolve(loaded.dir, s.path)),
			],
			addresses: [...new Set([...loaded.pack.isolation.forbidden.addresses, ...loaded.pack.sources.flatMap((s) => s.addresses)])],
		};
		const missingCells: string[] = [];
		await pool(remaining, opts.parallel ?? 4, async (c) => {
			const cell = `${c.scenario.id}.${c.arm.arm}.${c.member.id}.${c.run}`;
			if (budget.isExhausted()) {
				missingCells.push(cell);
				return;
			}
			const phases = phasesOf(c.scenario, exp.experiment);
			const attempts: Attempt[] = [];
			let timeouts = 0;
			let lastPhases: PhaseRecord[] = [];
			let traps: TrapAssignment[] = [];
			const adapter = adapterOf(c.member);
			const sandboxed = adapter.filesystem === "sandboxed";
			const given = [...c.arm.instructions.map((f) => f.path), ...c.arm.folderFiles.map((f) => f.path), ...c.arm.onRequest.map((o) => o.path)];
			for (let attempt = 1; ; attempt++) {
				if (budget.isExhausted()) break;
				let a: Attempt;
				const unreachable: string[] = [];
				record.dispatchedCells = [...new Set([...(record.dispatchedCells ?? []), cell])].sort();
				save();
				try {
					const ep = await runEpisode({
						loaded, experiment: exp.experiment, scenario: c.scenario, arm: c.arm, member: c.member, memberIndex: members.indexOf(c.member), run: c.run,
						adapter, work, key: `${cell}.${attempt}`, timeLimitSeconds,
						...(effectiveLimits.maxReaderInputBytes !== null ? { maxInputBytes: effectiveLimits.maxReaderInputBytes } : {}),
						...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
						budget,
						timeouts,
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
					a = { attempt, validity: { valid: false, cause: "infrastructure", detail: `the attempt failed in the core: ${String(e).slice(0, 300)}` }, outcome: EMPTY_OUTCOME, diff: null, failure: String(e).slice(0, 1000) };
					lastPhases = [];
				}
				attempts.push(a);
				if (a.validity.valid || !RERUN[a.validity.cause] || attempt >= maxAttemptsPerCell || budget.isExhausted()) break;
			}
			if (attempts.length === 0) {
				missingCells.push(cell);
				return;
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
			const maxBytes = c.scenario.maxResponseBytes ?? effectiveLimits.maxResponseBytes ?? undefined;
			let lastBound: ResponseBoundRecord | undefined;
			const beforeBound: Record<string, { final: string; scored: string | null }> = {};
			for (const p of lastPhases) {
				if (p.status !== "run" || p.validity?.valid !== true || p.outcome === null) continue;
				const rawScored = c.scenario.scoredFile !== undefined && p.snapshot !== null ? readInside(p.snapshot, c.scenario.scoredFile) : null;
				const { final, scored: scoredContent, responseBound, pre } = phaseText(c.scenario, maxBytes, marker, p.outcome.final, rawScored);
				if (maxBytes !== undefined) lastBound = responseBound;
				beforeBound[p.phase] = pre;
				phaseOutcomes[p.phase] = {
					final, diff: p.diff ?? "", note: p.note, startDiff: p.startDiff, scored: scoredContent, traps: p.traps.map((t) => t.text),
					...(responseBound !== undefined ? { responseBound } : {}),
				};
			}
			const lastRan = [...lastPhases].reverse().find((p) => p.status === "run" && p.snapshot !== null);
			let scored: CellRecord["scoredFile"] = null;
			if (c.scenario.scoredFile !== undefined && lastRan !== undefined) {
				const content = readInside(lastRan.snapshot!, c.scenario.scoredFile);
				scored = { path: c.scenario.scoredFile, content, matchesFinal: content !== null && content.trim() === (lastRan.outcome?.final ?? "").trim() };
			}
			const { answers, extraction } = answersOf(c.scenario, propertyPhases, phaseOutcomes, beforeBound, marker, attempts.length);
			const restated: RestatedFlag[] = [];
			const { delivered, deliveredFiles } = deliveredOf(c.arm);
			for (const p of lastPhases.filter((x) => x.status === "run")) {
				const decl = phases.find((x) => x.id === p.phase);
				const texts: { source: "final" | "note"; path: string; text: string }[] = [];
				if (p.outcome !== null) texts.push({ source: "final", path: `(final message of ${p.phase})`, text: p.outcome.final });
				if (p.note !== null && p.noteSource !== null) texts.push({ source: "note", path: decl?.note !== undefined && "file" in decl.note ? decl.note.file : `(note from hook ${decl?.note !== undefined && "generator" in decl.note ? decl.note.generator : "?"})`, text: p.note });
				for (const t of texts) for (const d of delivered) {
					const run = sharedRun(t.text, d.text);
					if (run !== null) restated.push({ cell, phase: p.phase, source: t.source, path: t.path, delivered: { file: d.file, path: d.path }, words: run });
				}
			}
			const cr: CellRecord = {
				cell, scenario: c.scenario.id, arm: c.arm.arm, member: c.member.id, run: c.run, attempts, valid: last.validity.valid,
				final: last.validity.valid ? (lastRan ? (phaseOutcomes[lastRan.phase]?.final ?? stripSelfExplanation(last.outcome.final, marker)) : stripSelfExplanation(last.outcome.final, marker)) : null,
				scoredFile: scored, answers, ...(Object.keys(extraction).length ? { extraction } : {}), diff: last.diff, codeScores: [],
				traps, propertyPhases, phaseOutcomes, restated,
				...(deliveredFiles.length ? { deliveredFiles } : {}),
				...(lastBound !== undefined ? { responseBound: lastBound } : {}),
			};
			cellRecords.push(cr);
			write(path.join(resolvedRecords, "cells", `${cell}.json`), cr);
			record.cells = cellRecords.map((x) => x.cell).sort();
			save();
		});
		enter("executed");

		for (const cr of cellRecords) {
			cr.codeScores = [];
			const scenario = scenarios.find((s) => s.id === cr.scenario)!;
			const lastAttempt = cr.attempts[cr.attempts.length - 1]!;
			for (const p of lastAttempt.phases ?? []) {
				const props = propertiesOf(scenario).filter((x) => x.decidedBy === "code" && cr.propertyPhases?.[x.id]?.phase === p.phase && cr.propertyPhases[x.id]!.state === "valid");
				if (!props.length || p.outcome === null) continue;
				const sub: Scenario = { ...scenario, properties: props, trapPairs: [] };
				const po = cr.phaseOutcomes?.[p.phase];
				const maxBytes = scenario.maxResponseBytes ?? exp.experiment.maxResponseBytes;
				const rawScored = scenario.scoredFile !== undefined && p.snapshot !== null ? readInside(p.snapshot, scenario.scoredFile) : null;
				const measuredFinal = maxBytes !== undefined ? boundUtf8(p.outcome.final, maxBytes).text : p.outcome.final;
				const measuredScored = maxBytes !== undefined && rawScored !== null ? boundUtf8(rawScored, maxBytes).text : (po?.scored ?? null);
				cr.codeScores.push(...await measure(loaded, sub, { final: measuredFinal, rawFinal: p.outcome.final, diff: p.diff ?? "", scored: measuredScored, rawScored, snapshot: p.snapshot }, now));
			}
			write(path.join(resolvedRecords, "cells", `${cr.cell}.json`), cr);
		}
		enter("measured");
		save();

		await new Promise((r) => setTimeout(r, 2));
		const scenarioMap = new Map(scenarios.map((x) => [x.id, x]));
		const families = new Map(record.snapshot.population.map((m) => [m.id, m.family]));
		const canaries = loaded.pack.variants.flatMap((v) => v.canaries);
		const judges = record.judges.map((id) => record.snapshot.population.find((m) => m.id === id)!);
		const blinded = blind(loaded, scenarioMap, cellRecords, families, record.seed, now, { paths: [workRoot, recordsRoot, loaded.dir], literals: canaries });
		write(path.join(resolvedRecords, "sealed", "units.json"), blinded);
		enter("blinded");
		save();

		const votes = await judgeAll({
			loaded, experiment: exp.experiment, scenarios: scenarioMap, units: blinded.units, judges, adapters: opts.adapters,
			guessOptions: Object.keys(record.guessGroups), recordsDir: resolvedRecords, work, seed: record.seed,
			timeLimitSeconds: effectiveLimits.judgeTimeLimitSeconds, parallel: opts.parallel ?? 4,
			maxAttempts: effectiveLimits.maxJudgeAttempts,
			...(effectiveLimits.maxJudgeInputBytes !== null ? { maxInputBytes: effectiveLimits.maxJudgeInputBytes } : {}),
			...(effectiveLimits.maxJudgeReplyBytes !== null ? { maxReplyBytes: effectiveLimits.maxJudgeReplyBytes } : {}),
			...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
			budget,
		});
		write(path.join(resolvedRecords, "judging", "votes.json"), votes);
		if (exp.experiment.judging?.chain !== undefined && !budget.isExhausted()) {
			await runJudgingChain({
				loaded, chain: exp.experiment.judging.chain, units: blinded.units, judges, adapters: opts.adapters,
				recordsDir: resolvedRecords, work, timeLimitSeconds: effectiveLimits.judgeTimeLimitSeconds,
			});
		}
		enter("judged");
		save();

		const missingJudgeJobs = [...new Set(votes.filter((v) => v.value === null && /maxTotalInvocations|budget-exhausted|storage|minFreeBytes|maxRunWorkBytes/.test(v.reason)).map((v) => v.prompt))].sort();
		if (missingCells.length > 0 || missingJudgeJobs.length > 0 || budget.summary().exhausted) {
			record.missingWork = { cells: missingCells.sort(), judgeJobs: missingJudgeJobs };
		} else {
			delete record.missingWork;
		}
		const result = tallyRun(resolvedRecords);
		enter("tallied");
		if (record.missingWork !== undefined) {
			record.end = "incomplete";
			record.endReason = budget.isStorageExhausted()
				? `${budget.storageExhaustedReason() ?? "run storage ceiling exhausted"}; missing ${record.missingWork.cells.length} cell(s) and ${record.missingWork.judgeJobs.length} judge job(s)`
				: `maxTotalInvocations (${effectiveLimits.maxTotalInvocations}) exhausted; missing ${record.missingWork.cells.length} cell(s) and ${record.missingWork.judgeJobs.length} judge job(s)`;
		} else {
			record.end = "completed";
		}
		save(true);
		void result;
	} catch (e) {
		record.end = "failed";
		record.endReason = String(e).slice(0, 1000);
		save(true);
		throw e;
	} finally {
		clearRunActive(work);
		for (const v of built.values()) if (v.ok && fs.existsSync(v.dir)) makeWritable(v.dir);
	}
	return { dir: resolvedRecords, record };
}

export const CALIBRATION_SYNTHETIC_MEMBER: Member = {
	id: "fixed-response",
	family: "fixed-calibration",
	runtime: "synthetic",
	model: "fixed-response",
};

/**
 * Runs fixed-answer judge calibration (0040, B30): validates the pack, builds variants and composes
 * the selected arm so `judgedWith: ["delivered"]` attaches the exact reading material, runs only
 * `judgeProbes` (zero reader probes and zero reader invocations), synthesizes one cell per selected
 * scenario from `opts.responseFile` using a synthetic member whose family (`"fixed-calibration"`) is
 * distinct from every judge family (so every judge family scores every unit), and runs the ordinary
 * public extraction, measurement, blinding, comprehension judging and tally pipeline.
 */
export async function calibrateRun(packDir: string, opts: CalibrateOptions): Promise<{ dir: string; record: RunRecord }> {
	const now = opts.now ?? ((): Date => new Date());
	const states: RunRecord["states"] = [];
	const enter = (s: (typeof STATES)[number]): void => {
		const last = states[states.length - 1];
		if (STATES.indexOf(s) !== (last ? STATES.indexOf(last.state as (typeof STATES)[number]) + 1 : 0)) throw new Error(`state ${s} out of order`);
		states.push({ state: s, at: now().toISOString() });
	};

	const respPath = path.resolve(opts.responseFile);
	if (!fs.existsSync(respPath) || !fs.statSync(respPath).isFile()) {
		throw new Error(`calibration response file does not exist: ${respPath}`);
	}
	const rawResponse = fs.readFileSync(respPath, "utf8");
	const responseBytes = Buffer.byteLength(rawResponse, "utf8");
	const responseSha256 = createHash("sha256").update(rawResponse, "utf8").digest("hex");

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
	if (experimentId === undefined) throw new Error("a calibration run names an experiment or a suite");
	const exp = loaded.experiments.get(experimentId);
	if (!exp) throw new Error(`no experiment ${experimentId}`);
	const allScenarios = [...exp.scenarios.values()].map((x) => x.scenario);
	const suite = loaded.pack.suites.find((x) => x.id === suiteId);
	const scenarioIds = suite ? selectScenarios(allScenarios, suite.select) : allScenarios.map((s) => s.id);
	const scenarios = scenarioIds.map((id) => exp.scenarios.get(id)!.scenario);
	const status = runStatus(loaded, experimentId);
	const startedAt = states[0]!.at;
	if (status.record !== null && status.record.recordedAt >= startedAt) throw new Error("the experiment's record is not earlier than the run");

	const readerTimeOverride = opts.readerTimeLimitSeconds ?? opts.timeLimitSeconds;
	const effectiveLimits = resolveEffectiveLimits(exp.experiment, {
		...(readerTimeOverride !== undefined ? { readerTimeLimitSeconds: readerTimeOverride } : {}),
		...(opts.judgeTimeLimitSeconds !== undefined ? { judgeTimeLimitSeconds: opts.judgeTimeLimitSeconds } : {}),
		...(opts.probeTimeLimitSeconds !== undefined ? { probeTimeLimitSeconds: opts.probeTimeLimitSeconds } : {}),
		...(opts.maxAttemptsPerCell !== undefined ? { maxAttemptsPerCell: opts.maxAttemptsPerCell } : {}),
		...(opts.maxProbeAttempts !== undefined ? { maxProbeAttempts: opts.maxProbeAttempts } : {}),
		...(opts.maxJudgeAttempts !== undefined ? { maxJudgeAttempts: opts.maxJudgeAttempts } : {}),
		...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
		...(opts.maxReaderInputBytes !== undefined ? { maxReaderInputBytes: opts.maxReaderInputBytes } : {}),
		...(opts.maxJudgeInputBytes !== undefined ? { maxJudgeInputBytes: opts.maxJudgeInputBytes } : {}),
		...(opts.maxProbeInputBytes !== undefined ? { maxProbeInputBytes: opts.maxProbeInputBytes } : {}),
		...(opts.maxJudgeReplyBytes !== undefined ? { maxJudgeReplyBytes: opts.maxJudgeReplyBytes } : {}),
		...(opts.maxProbeReplyBytes !== undefined ? { maxProbeReplyBytes: opts.maxProbeReplyBytes } : {}),
		...(opts.maxStdoutBytes !== undefined ? { maxStdoutBytes: opts.maxStdoutBytes } : {}),
		...(opts.maxTotalInvocations !== undefined ? { maxTotalInvocations: opts.maxTotalInvocations } : {}),
		...(opts.minFreeBytes !== undefined ? { minFreeBytes: opts.minFreeBytes } : {}),
		...(opts.maxRunWorkBytes !== undefined ? { maxRunWorkBytes: opts.maxRunWorkBytes } : {}),
	});
	// Condition 2 (0042, B30): if the experiment is registered in register/<experiment>.json,
	// any CLI/API execution-limit override that disagrees with the registered declaration is refused before dispatch.
	const overriddenKeys = (Object.entries(effectiveLimits.origins) as [keyof Omit<EffectiveLimits, "origins">, string][])
		.filter(([, origin]) => origin === "override")
		.map(([k]) => k);
	if (overriddenKeys.length > 0 && status.record !== null) {
		throw new Error(`execution limits overridden (${overriddenKeys.join(", ")}) disagree with registered experiment ${experimentId} (${status.record.hash}); register the updated profile or omit the override`);
	}
	// Fixed-answer calibration always records status "exploration" so a synthetic calibration run can never be mistaken for a cold-reader result.
	const statusValue: Status = "exploration";
	const statusReason = `fixed-answer calibration from ${path.basename(respPath)} (sha256:${responseSha256.slice(0, 12)})`;
	enter("recorded");

	const armIds0 = exp.experiment.factors.arms;
	const defaultArm = exp.experiment.default !== undefined
		? (armIds0.find((a) => a !== exp.experiment.default) ?? armIds0[0]!)
		: (armIds0.find((a) => (loaded.pack.arms.find((x) => x.id === a)?.deliver.length ?? 0) > 0) ?? armIds0[0]!);
	const selectedArmId = opts.arm ?? defaultArm;
	if (!armIds0.includes(selectedArmId)) {
		throw new Error(`arm ${selectedArmId} is not in experiment ${experimentId}'s arms (${armIds0.join(", ")})`);
	}

	const runId = `${startedAt.replace(/[:.]/g, "").replace("T", "-").slice(0, 17)}-calibrate-${experimentId}`;
	const recordsRoot = path.resolve(opts.records ?? path.resolve(loaded.dir, loaded.pack.records.path));
	const recordsDir = opts.out !== undefined ? path.resolve(opts.out) : path.join(recordsRoot, runId);
	const workRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
	checkRunPreflightFreeBytes(effectiveLimits.minFreeBytes, workRoot, path.dirname(recordsDir));
	fs.mkdirSync(path.dirname(recordsDir), { recursive: true });
	fs.mkdirSync(workRoot, { recursive: true });
	fs.mkdirSync(recordsDir);
	const work = fs.mkdtempSync(path.join(workRoot, "run-"));
	writeRunLock(work, "calibrate", runId, recordsDir, startedAt);
	const budget = new InvocationBudget(effectiveLimits.maxTotalInvocations, undefined, makeRunStorageGuard(effectiveLimits, work, recordsDir));
	const fixedProvenance: FixedResponseProvenance = {
		path: respPath,
		sha256: responseSha256,
		bytes: responseBytes,
		arm: selectedArmId,
		syntheticMember: CALIBRATION_SYNTHETIC_MEMBER.id,
		syntheticFamily: CALIBRATION_SYNTHETIC_MEMBER.family,
	};
	const record: RunRecord = {
		run: runId,
		mode: "calibrate",
		fixedResponse: fixedProvenance,
		pack: loaded.pack.id,
		experiment: experimentId,
		suite: suiteId,
		scenarios: scenarioIds,
		status: statusValue,
		statusReason,
		register: status.record,
		method: methodVersion(),
		states,
		variants: {},
		arms: {},
		probes: [],
		cells: [],
		dispatchedCells: [],
		work,
		runsPerCell: 1,
		maxAttemptsPerCell: 1,
		timeLimitSeconds: effectiveLimits.readerTimeLimitSeconds,
		effectiveLimits,
		invocationSummary: budget.summary(),
		population: [CALIBRATION_SYNTHETIC_MEMBER.id],
		runtimes: {},
		judges: [],
		judgeProbes: [],
		snapshot: {
			scenarios,
			arms: [selectedArmId],
			population: [...loaded.pack.population, CALIBRATION_SYNTHETIC_MEMBER],
			experiment: { ...(exp.experiment.variation !== undefined ? { variation: exp.experiment.variation } : {}), ...(exp.experiment.default !== undefined ? { default: exp.experiment.default } : {}), full: exp.experiment },
			exposed: readExposures(loaded).filter((e) => scenarios.some((x) => x.id === e.scenario && x.heldOut === true)),
			deliveries: { [selectedArmId]: (loaded.pack.arms.find((x) => x.id === selectedArmId)?.deliver ?? []).map((d) => ({ file: d.file, as: d.as })) },
		},
		guessGroups: exp.experiment.judging?.guessGroups ?? { [selectedArmId]: [selectedArmId] },
		seed: runId,
		end: null,
	};
	const save = (includeStorage = false): void => {
		record.invocationSummary = budget.summary();
		if (includeStorage) record.storageSummary = computeRunStorageSummary(effectiveLimits, work, recordsDir, budget);
		write(path.join(recordsDir, "run.json"), record);
	};
	save();
	const built = new Map<string, BuiltVariant>();
	try {
		const variantIds = [...new Set(loaded.pack.arms.filter((a) => a.id === selectedArmId).flatMap((a) => a.deliver.map((d) => d.variant)))];
		for (const v of variantIds) {
			const decl = loaded.pack.variants.find((x) => x.id === v)!;
			const sourceDir = path.resolve(loaded.dir, loaded.pack.sources.find((s) => s.id === decl.source)!.path);
			const rev = decl.revision ?? opts.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
			const b = await buildVariant(loaded, v, rev, variantDir(work, v));
			built.set(v, b);
			record.variants[v] = b.ok ? b.manifest : { failed: b.reason };
		}
		const comp = composeArm(loaded, selectedArmId, built);
		record.arms[selectedArmId] = comp.ok ? { composed: true } : { composed: false, reason: comp.reason };
		if (!comp.ok) throw new Error(`could not compose calibration arm ${selectedArmId}: ${comp.reason}`);
		const composedArm = comp.arm;
		enter("built");
		save();

		// Zero reader probes in calibration mode; only judgeProbes run.
		const judgeMembers: Member[] = (exp.experiment.judging?.judges ?? exp.experiment.factors.population).map((id) => loaded.pack.population.find((m) => m.id === id)!);
		const adapterOf = (m: Member): Adapter => {
			const a = opts.adapters[m.runtime];
			if (!a) throw new Error(`no adapter for runtime ${m.runtime}`);
			return a;
		};
		for (const j of judgeMembers) if (!(j.runtime in record.runtimes)) record.runtimes[j.runtime] = adapterOf(j).version?.() ?? null;
		record.routes ??= {};
		for (const j of judgeMembers) record.routes[j.id] ??= adapterOf(j).route?.(j) ?? null;
		await pool(judgeMembers, opts.parallel ?? 4, async (j) => {
			record.judgeProbes.push(await probeArm(loaded, EMPTY_ARM, j, adapterOf(j), {
				base: path.join(work, "probes", opaqueName("p", `judge.${j.id}`)),
				timeLimitSeconds: effectiveLimits.probeTimeLimitSeconds,
				allLeaks: true,
				maxAttempts: effectiveLimits.maxProbeAttempts,
				...(effectiveLimits.maxProbeInputBytes !== null ? { maxInputBytes: effectiveLimits.maxProbeInputBytes } : {}),
				...(effectiveLimits.maxProbeReplyBytes !== null ? { maxReplyBytes: effectiveLimits.maxProbeReplyBytes } : {}),
				...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
				budget,
				role: "judgeProbe",
			}));
		});
		record.judgeProbes.sort((a, b) => a.member.localeCompare(b.member));
		const judges = judgeMembers.filter((j) => record.judgeProbes.some((p) => p.member === j.id && p.pass));
		record.judges = judges.map((j) => j.id);
		enter("probed");
		save();

		// Synthesize one cell per scenario from the fixed-answer markdown file with zero reader invocations.
		const cellRecords: CellRecord[] = [];
		const marker = loaded.pack.masks.selfExplanationMarker;
		const { deliveredFiles } = deliveredOf(composedArm);
		for (const scenario of scenarios) {
			const cell = `${scenario.id}.${selectedArmId}.${CALIBRATION_SYNTHETIC_MEMBER.id}.1`;
			const phases = phasesOf(scenario, exp.experiment);
			const lastPhase = phases[phases.length - 1]!;
			const snapDir = path.join(work, "snapshots", `${cell}.1`, lastPhase.id);
			fs.mkdirSync(snapDir, { recursive: true });
			if (scenario.scoredFile !== undefined) {
				const scoredTarget = path.resolve(snapDir, scenario.scoredFile);
				fs.mkdirSync(path.dirname(scoredTarget), { recursive: true });
				fs.writeFileSync(scoredTarget, rawResponse);
			}
			const syntheticOutcome: Outcome = {
				final: rawResponse,
				exit: 0,
				signal: null,
				stop: { reason: "completed", inFlight: "none" },
				cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 },
				tools: [],
				filtered: false,
				error: null,
				session: null,
				trace: [],
				events: "",
			};
			const phaseRec: PhaseRecord = {
				phase: lastPhase.id,
				session: lastPhase.session,
				after: null,
				status: "run",
				prompt: "",
				note: null,
				noteSource: null,
				workspace: snapDir,
				invocation: "",
				copiedTree: null,
				startTree: "",
				startDiff: "",
				endTree: "",
				snapshot: snapDir,
				endDiff: "",
				outcome: syntheticOutcome,
				validity: { valid: true },
				diff: "",
				traps: [],
			};
			const propertyPhases: NonNullable<CellRecord["propertyPhases"]> = {};
			for (const pr of propertiesOf(scenario)) {
				propertyPhases[pr.id] = { phase: lastPhase.id, state: "valid" };
			}
			const maxBytes = scenario.maxResponseBytes ?? effectiveLimits.maxResponseBytes ?? undefined;
			const rawScored = scenario.scoredFile !== undefined ? rawResponse : null;
			const { final, scored: scoredContent, responseBound, pre } = phaseText(scenario, maxBytes, marker, rawResponse, rawScored);
			const beforeBound: Record<string, { final: string; scored: string | null }> = { [lastPhase.id]: pre };
			const phaseOutcomes: NonNullable<CellRecord["phaseOutcomes"]> = {
				[lastPhase.id]: {
					final,
					diff: "",
					note: null,
					startDiff: "",
					scored: scoredContent,
					traps: [],
					...(responseBound !== undefined ? { responseBound } : {}),
				},
			};
			const { answers, extraction } = answersOf(scenario, propertyPhases, phaseOutcomes, beforeBound, marker, 1);
			const cr: CellRecord = {
				cell,
				scenario: scenario.id,
				arm: selectedArmId,
				member: CALIBRATION_SYNTHETIC_MEMBER.id,
				run: 1,
				attempts: [{ attempt: 1, validity: { valid: true }, outcome: syntheticOutcome, diff: "", workspace: snapDir, phases: [phaseRec] }],
				valid: true,
				final,
				scoredFile: scenario.scoredFile !== undefined ? { path: scenario.scoredFile, content: rawResponse, matchesFinal: true } : null,
				answers,
				...(Object.keys(extraction).length ? { extraction } : {}),
				diff: "",
				codeScores: [],
				traps: [],
				propertyPhases,
				phaseOutcomes,
				restated: [],
				...(deliveredFiles.length ? { deliveredFiles } : {}),
				...(responseBound !== undefined ? { responseBound } : {}),
				syntheticCalibration: true,
				fixedResponse: fixedProvenance,
			};
			cellRecords.push(cr);
			write(path.join(recordsDir, "cells", `${cell}.json`), cr);
			record.cells = cellRecords.map((x) => x.cell).sort();
			save();
		}
		enter("executed");

		for (const cr of cellRecords) {
			const scenario = scenarios.find((s) => s.id === cr.scenario)!;
			const lastAttempt = cr.attempts[cr.attempts.length - 1]!;
			for (const p of lastAttempt.phases ?? []) {
				const props = propertiesOf(scenario).filter((x) => x.decidedBy === "code" && cr.propertyPhases?.[x.id]?.phase === p.phase && cr.propertyPhases[x.id]!.state === "valid");
				if (!props.length || p.outcome === null) continue;
				const sub: Scenario = { ...scenario, properties: props, trapPairs: [] };
				const po = cr.phaseOutcomes?.[p.phase];
				const maxBytes = scenario.maxResponseBytes ?? effectiveLimits.maxResponseBytes ?? undefined;
				const rawScored = scenario.scoredFile !== undefined ? rawResponse : null;
				const measuredFinal = maxBytes !== undefined ? boundUtf8(p.outcome.final, maxBytes).text : p.outcome.final;
				const measuredScored = maxBytes !== undefined && rawScored !== null ? boundUtf8(rawScored, maxBytes).text : (po?.scored ?? null);
				cr.codeScores.push(...await measure(loaded, sub, { final: measuredFinal, rawFinal: p.outcome.final, diff: "", scored: measuredScored, rawScored, snapshot: p.snapshot }, now));
			}
			write(path.join(recordsDir, "cells", `${cr.cell}.json`), cr);
		}
		enter("measured");
		save();

		await new Promise((r) => setTimeout(r, 2));
		const scenarioMap = new Map(scenarios.map((x) => [x.id, x]));
		const families = new Map(record.snapshot.population.map((m) => [m.id, m.family]));
		const canaries = loaded.pack.variants.flatMap((v) => v.canaries);
		const blinded = blind(loaded, scenarioMap, cellRecords, families, record.seed, now, { paths: [workRoot, recordsRoot, loaded.dir], literals: canaries });
		write(path.join(recordsDir, "sealed", "units.json"), blinded);
		enter("blinded");
		save();

		const votes = await judgeAll({
			loaded,
			experiment: exp.experiment,
			scenarios: scenarioMap,
			units: blinded.units,
			judges,
			adapters: opts.adapters,
			guessOptions: Object.keys(record.guessGroups),
			recordsDir,
			work,
			seed: record.seed,
			timeLimitSeconds: effectiveLimits.judgeTimeLimitSeconds,
			parallel: opts.parallel ?? 4,
			maxAttempts: effectiveLimits.maxJudgeAttempts,
			...(effectiveLimits.maxJudgeInputBytes !== null ? { maxInputBytes: effectiveLimits.maxJudgeInputBytes } : {}),
			...(effectiveLimits.maxJudgeReplyBytes !== null ? { maxReplyBytes: effectiveLimits.maxJudgeReplyBytes } : {}),
			...(effectiveLimits.maxStdoutBytes !== null ? { maxStdoutBytes: effectiveLimits.maxStdoutBytes } : {}),
			budget,
		});
		write(path.join(recordsDir, "judging", "votes.json"), votes);
		enter("judged");
		save();

		const missingJudgeJobs = [...new Set(votes.filter((v) => v.value === null && /maxTotalInvocations|budget-exhausted|storage|minFreeBytes|maxRunWorkBytes/.test(v.reason)).map((v) => v.prompt))].sort();
		if (missingJudgeJobs.length > 0 || budget.summary().exhausted) {
			record.missingWork = { cells: [], judgeJobs: missingJudgeJobs };
		}
		const result = tallyRun(recordsDir);
		enter("tallied");
		if (record.missingWork !== undefined) {
			record.end = "incomplete";
			record.endReason = budget.isStorageExhausted()
				? `${budget.storageExhaustedReason() ?? "run storage ceiling exhausted"}; missing ${record.missingWork.judgeJobs.length} judge job(s)`
				: `maxTotalInvocations (${effectiveLimits.maxTotalInvocations}) exhausted; missing ${record.missingWork.judgeJobs.length} judge job(s)`;
		} else {
			record.end = "completed";
		}
		save(true);
		void result;
	} catch (e) {
		record.end = "failed";
		record.endReason = String(e).slice(0, 1000);
		save(true);
		throw e;
	} finally {
		clearRunActive(work);
		for (const v of built.values()) if (v.ok && fs.existsSync(v.dir)) makeWritable(v.dir);
	}
	return { dir: recordsDir, record };
}

/**
 * A phase's text as judges and measures are given it: the final message after self-explanation
 * stripping, and the scored file; the one answers are read from is cut to maxResponseBytes, and its
 * text before the cut is kept for extraction provenance. One function for every path that records a
 * cell, and for the preview.
 */
export function phaseText(scenario: Scenario, maxBytes: number | undefined, marker: string | undefined, rawFinal: string, rawScored: string | null): { final: string; scored: string | null; responseBound?: ResponseBoundRecord; pre: { final: string; scored: string | null } } {
	const stripped = stripSelfExplanation(rawFinal, marker);
	const pre = { final: stripped, scored: rawScored };
	if (maxBytes === undefined) return { final: stripped, scored: rawScored, pre };
	if (scenario.answerSource === "final" || scenario.scoredFile === undefined) {
		const b = boundUtf8(stripped, maxBytes);
		return { final: b.text, scored: rawScored, responseBound: b.bound, pre };
	}
	if (rawScored === null) return { final: stripped, scored: null, pre };
	pre.scored = stripSelfExplanation(rawScored, marker);
	const b = boundUtf8(pre.scored, maxBytes);
	return { final: stripped, scored: b.text, responseBound: b.bound, pre };
}

/** The files an arm delivers as instructions or folder files, read; and those judges may be shown with judgedWith delivered, the canary left out. */
export function deliveredOf(arm: ComposedArm): { delivered: { file: string; path: string; text: string }[]; deliveredFiles: { file: string; text: string }[] } {
	const delivered = [...arm.instructions, ...arm.folderFiles].map((f) => ({ file: f.file, path: f.path, text: fs.readFileSync(f.path, "utf8") }));
	return { delivered, deliveredFiles: delivered.filter((d) => path.basename(d.file) !== "context-lab-canary.md").map((d) => ({ file: d.file, text: d.text })) };
}

/**
 * Each answer property's answer, from its phase's text as judges are given it, and how it was
 * extracted (B23). One function for every path that records a cell, so a run and a resume cannot
 * extract differently.
 */
export function answersOf(
	scenario: Scenario, propertyPhases: NonNullable<CellRecord["propertyPhases"]>, phaseOutcomes: NonNullable<CellRecord["phaseOutcomes"]>,
	beforeBound: Record<string, { final: string; scored: string | null }>, marker: string | undefined, attempt: number,
): { answers: Record<string, string | null>; extraction: Record<string, AnswerExtraction> } {
	const answers: Record<string, string | null> = {};
	const extraction: Record<string, AnswerExtraction> = {};
	const heads = propertiesOf(scenario).filter((x) => x.answerHeading !== undefined);
	const requested = heads.map((x) => x.answerHeading!);
	const source = scenario.answerSource === "final" ? "final" : "scored-file";
	const splitOpts = {
		...(scenario.expectedHeadings !== undefined ? { expectedHeadings: scenario.expectedHeadings } : {}),
		...(scenario.answerTermination !== undefined ? { answerTermination: scenario.answerTermination } : {}),
	};
	for (const pr of heads) {
		const pp = propertyPhases[pr.id]!;
		if (pp.state !== "valid") continue;
		const po = phaseOutcomes[pp.phase];
		const text = source === "final" ? (po?.final ?? "") : (po?.scored ?? "");
		const pre = beforeBound[pp.phase];
		const before = source === "final" ? (pre?.final ?? text) : (pre?.scored ?? text);
		const r = extractAnswer(text, before, pr.answerHeading!, requested, marker, { source, phase: pp.phase, attempt }, splitOpts);
		answers[pr.id] = r.answer;
		extraction[pr.id] = r.extraction;
	}
	return { answers, extraction };
}

/** Re-tally a run from its record alone: the same files give the same result, whatever the pack is now. */
export interface TallyOptions {
	/** Count only cell runs 1 to this number, so a nine-run record reads as a shorter one. */
	runs?: number;
	/** Write RESULT.json and RESULT.md; true unless runs is given, since a restricted tally is not the run's result. */
	write?: boolean;
}

export function tallyRun(recordsDir: string, opts: TallyOptions = {}): Result {
	const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(recordsDir, f), "utf8")) as T;
	const record = read<RunRecord>("run.json");
	const scenarios = new Map(record.snapshot.scenarios.map((x) => [x.id, x]));
	if (opts.runs !== undefined && !(Number.isInteger(opts.runs) && opts.runs >= 1)) throw new Error(`runs must be a whole number from 1, not ${opts.runs}`);
	const cells = record.cells.map((c) => read<CellRecord>(path.join("cells", `${c}.json`))).filter((c) => opts.runs === undefined || c.run <= opts.runs);
	const blinded = read<Blinded>(path.join("sealed", "units.json"));
	const votes = read<Vote[]>(path.join("judging", "votes.json"));
	const judges = record.judges.map((id) => record.snapshot.population.find((m) => m.id === id)!);
	const picksFile = path.join(recordsDir, "picks.json");
	const picks = fs.existsSync(picksFile) ? read<PicksRecord>("picks.json") : null;
	const chainFile = path.join(recordsDir, "judging", "chain.json");
	const chain = fs.existsSync(chainFile) ? read<ChainRecord>(path.join("judging", "chain.json")) : null;
	const memberFamilies = new Map(record.snapshot.population.map((m) => [m.id, m.family]));
	const result = tally({
		run: record.run, status: record.status, arms: record.snapshot.arms, members: record.population, scenarios, cells,
		units: blinded.units, absent: blinded.absent, votes, assigned: (u) => assignJudges(u, judges).map((j) => j.id), guessGroups: record.guessGroups,
		...(record.snapshot.experiment !== undefined ? { experiment: record.snapshot.experiment } : {}), exposed: record.snapshot.exposed ?? [],
		...(picks !== null ? { picks } : {}),
		...(chain !== null ? { chain } : {}),
		memberFamilies,
		...(record.snapshot.deliveries !== undefined ? { deliveries: record.snapshot.deliveries } : {}),
	});
	if (!(opts.write ?? opts.runs === undefined)) return result;
	write(path.join(recordsDir, "RESULT.json"), result);
	const limits = [
		`${record.runsPerCell} run(s) per cell: one outcome moves a cell's mean by up to 1/${record.runsPerCell} of the scale.`,
		"Agents and judges are language models; each outcome is judged by the families other than its agent's, which removes self-judging, not shared blind spots.",
		result.guesses.all > 0 ? "Judges can often tell the condition from the outcome itself; the guess rate below says how often." : "Judges can often tell the condition from the outcome itself; no judge guessed it in this run, so how often is unmeasured.",
		record.status === "exploration" ? `This run is exploration: ${record.statusReason}.` : "This run's experiment was recorded before the run, unchanged.",
	];
	fs.writeFileSync(path.join(recordsDir, "RESULT.md"), resultMarkdown(result, limits));
	return result;
}

export interface PickRunOptions {
	mode?: "calibration" | "preference";
	/** For preference mode on a run record: the arm with the move and the arm without it. */
	withArm?: string;
	withoutArm?: string;
	/** Or explicit preference items, when pairing static messages. */
	items?: PreferenceItem[];
	count?: number;
	seed?: string;
	input?: NodeJS.ReadableStream;
	output?: { write: (s: string) => unknown };
	now?: () => Date;
}

/**
 * Runs the human panel on a judged run record, writes `picks.json`, appends state `"picked"` to
 * `run.json`, and re-tallies `RESULT.json` and `RESULT.md` (Delta-3 stage 1, G2).
 */
export async function pickRun(recordsDir: string, opts: PickRunOptions = {}): Promise<{ picks: PicksRecord; result: Result }> {
	const now = opts.now ?? (() => new Date());
	const resolved = path.resolve(recordsDir);
	const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(resolved, f), "utf8")) as T;
	const record = read<RunRecord>("run.json");
	const scenarios = new Map(record.snapshot.scenarios.map((x) => [x.id, x]));
	const blinded = read<Blinded>(path.join("sealed", "units.json"));
	const votes = read<Vote[]>(path.join("judging", "votes.json"));
	const judges = record.judges.map((id) => record.snapshot.population.find((m) => m.id === id)!);
	const seed = opts.seed ?? record.seed;
	const mode = opts.mode ?? (opts.items || (opts.withArm && opts.withoutArm) ? "preference" : "calibration");
	let pairs;
	if (mode === "preference") {
		let items = opts.items;
		if (!items) {
			const withArm = opts.withArm ?? record.snapshot.arms[1];
			const withoutArm = opts.withoutArm ?? record.snapshot.arms[0];
			if (!withArm || !withoutArm) throw new Error("preference mode requires two arms or explicit items");
			const cells = record.cells.map((c) => read<CellRecord>(path.join("cells", `${c}.json`))).filter((c) => c.valid);
			items = [];
			for (const s of scenarios.values()) {
				for (const m of record.population) {
					for (let r = 1; r <= record.runsPerCell; r++) {
						const w = cells.find((c) => c.scenario === s.id && c.arm === withArm && c.member === m && c.run === r);
						const wo = cells.find((c) => c.scenario === s.id && c.arm === withoutArm && c.member === m && c.run === r);
						if (w?.final !== null && w?.final !== undefined && wo?.final !== null && wo?.final !== undefined) {
							items.push({ id: `${s.id}.${m}.${r}`, move: s.id, scenario: s.id, with: w.final, without: wo.final });
						}
					}
				}
			}
		}
		pairs = choosePreferencePairs(items, seed);
	} else {
		pairs = chooseCalibrationPairs({
			units: blinded.units,
			votes,
			scenarios,
			assigned: (u) => assignJudges(u, judges).map((j) => j.id),
			seed,
			...(opts.count !== undefined ? { count: opts.count } : {}),
		});
	}
	const picks = await runHumanPanel({
		pairs,
		seed,
		...(opts.input !== undefined ? { input: opts.input } : {}),
		...(opts.output !== undefined ? { output: opts.output } : {}),
		now,
	});
	write(path.join(resolved, "picks.json"), picks);
	if (!record.states.some((s) => s.state === "picked")) {
		record.states.push({ state: "picked", at: now().toISOString() });
		write(path.join(resolved, "run.json"), record);
	}
	const result = tallyRun(resolved);
	return { picks, result };
}
