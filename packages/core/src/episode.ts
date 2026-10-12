// episode - runs one attempt of a cell's episode: the scenario's phases, in order (architecture
// section 7; Delta-2).
//
// Each phase starts a new session or continues the session of the phase it follows. A new session
// starts from a copy of the ending state of the phase it follows, with any withheld files removed,
// and may be given a note - a file that phase wrote, or a note-generator hook's output. A
// continuing session runs in the very workspace of the phase it follows, as its runtime requires.
// Phases sharing the phase they follow are branches. Every phase's ending state is copied aside as
// it ends, so a branch, a later continuing phase, or the scored file can read it unchanged.
//
// Episode rules: a phase invalid for agent behaviour ends the episode, and no later phase runs; a
// phase invalid for any other cause makes the attempt invalid for that cause, and the whole episode
// is attempted again by the caller; a note hook that fails leaves its branch, and every phase
// following it, incomplete, and the episode goes on.
//
// Agents never see the copies: they live under the run's working folder, which is forbidden to
// every cell but for its own workspace and invocation folder.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Adapter, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import { runHook } from "./hook-runner.js";
import type { Outcome } from "./outcome.js";
import { phaseOfSlot, phasesOf, rotate, type Experiment, type LoadedPack, type Member, type Scenario, type ScenarioPhase } from "./pack-schema.js";
import { isInside } from "./paths.js";
import type { Validity } from "./validity-classifier.js";
import { createWorkspace } from "./workspace-builder.js";

export const NO_NOTE = "(no note was written)";

export interface TrapAssignment {
	pair: string;
	version: string;
	position: string;
	phase: string;
	text: string;
}

export interface PhaseRecord {
	phase: string;
	session: "new" | "continue";
	after: string | null;
	status: "run" | "incomplete" | "not-run";
	reason?: string;
	prompt: string;
	note: string | null;
	noteSource: "own" | "generated" | null;
	workspace: string;
	invocation: string;
	/** For a new session, the tree it was copied with, before anything was withheld. */
	copiedTree: string | null;
	startTree: string;
	startCommit: string;
	/** The changes from the episode's initial state to this phase's start. */
	startDiff: string;
	endTree: string | null;
	/** Where this phase's ending state was copied. */
	snapshot: string | null;
	/** The changes from the initial state to this phase's end. */
	endDiff: string | null;
	outcome: Outcome | null;
	validity: Validity | null;
	/** This phase's own changes, from its start. */
	diff: string | null;
	traps: TrapAssignment[];
}

export interface EpisodeResult {
	phases: PhaseRecord[];
	validity: Validity;
	endedAt?: string;
	timeouts: number;
	init: string;
}

const GIT = ["-c", "user.name=context-lab", "-c", "user.email=fixture@context-lab.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.quotepath=off"];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** The tree of the workspace as it stands, every file included, ignored ones too. */
export function treeOf(ws: string): string {
	git(ws, "add", "-A", "--force");
	return git(ws, "write-tree").trim();
}
function commitOf(ws: string, tree: string): string {
	return git(ws, "commit-tree", tree, "-p", "HEAD", "-m", "phase start").trim();
}
function diffFrom(ws: string, commit: string): string {
	git(ws, "add", "-A", "--force");
	return git(ws, "diff", "--cached", commit);
}

function readInside(dir: string, rel: string): string | null {
	const f = path.resolve(dir, rel);
	if (!isInside(f, dir)) return null;
	try {
		const real = fs.realpathSync(f);
		if (!isInside(real, fs.realpathSync(dir)) || !fs.lstatSync(real).isFile()) return null;
		return fs.readFileSync(real, "utf8");
	} catch {
		return null;
	}
}

/** The trap pairs' assignments for one cell, by the rotation rule. */
export function assignTraps(scenario: Scenario, phases: ScenarioPhase[], run: number, memberIndex: number): TrapAssignment[] {
	return (scenario.trapPairs ?? []).map((pair, k) => {
		const { position, version } = rotate(pair, run - 1, k, memberIndex);
		return { pair: pair.id, version, position, phase: phaseOfSlot(scenario, phases, position) ?? "", text: pair.versions.find((v) => v.id === version)!.text };
	});
}

/** The phase a property is judged on in a cell. */
export function propertyPhase(scenario: Scenario, phases: ScenarioPhase[], property: string, traps: TrapAssignment[]): string {
	const pair = (scenario.trapPairs ?? []).find((t) => t.properties.some((p) => p.id === property));
	if (pair) return traps.find((t) => t.pair === pair.id)?.phase ?? phases[phases.length - 1]!.id;
	return scenario.properties.find((p) => p.id === property)?.phase ?? phases[phases.length - 1]!.id;
}

function fillSlots(text: string, traps: TrapAssignment[]): string {
	return text.replace(/\{SLOT:([^}]+)\}/g, (_, slot: string) => traps.filter((t) => t.position === slot).map((t) => t.text).join(" "));
}

export function phasePrompt(experiment: Experiment, scenario: Scenario, phase: ScenarioPhase, first: boolean, arm: ComposedArm, workspace: string, note: string | null, traps: TrapAssignment[]): string {
	let task = fillSlots(first ? scenario.task : phase.task ?? "", traps);
	if (note !== null) task = task.includes("{NOTE}") ? task.split("{NOTE}").join(note) : `${task}\n\n${note}`;
	const parts = phase.session === "continue" ? [task] : [experiment.instructions, experiment.preamble, task];
	const fill = (t: string): string => t.split("{ON_REQUEST}").join(arm.onRequest.map((o) => o.path).join("\n")).split("{WORKSPACE}").join(workspace);
	return parts.filter((x): x is string => x !== undefined && x !== "").map(fill).join("\n\n");
}

export interface EpisodeRun {
	loaded: LoadedPack;
	experiment: Experiment;
	scenario: Scenario;
	arm: ComposedArm;
	member: Member;
	memberIndex: number;
	run: number;
	adapter: Adapter;
	/** The run's working folder; workspaces, invocations and copies are made under it. */
	work: string;
	key: string;
	timeLimitSeconds: number;
	/** Open-step timeouts already counted in earlier attempts of this cell (0012). */
	timeouts: number;
	classify: (outcome: Outcome, workspace: string, invocation: string, timeouts: number) => Validity;
}

export async function runEpisode(r: EpisodeRun): Promise<EpisodeResult> {
	const phases = phasesOf(r.scenario, r.experiment);
	const traps = assignTraps(r.scenario, phases, r.run, r.memberIndex);
	const base = path.join(r.work, "workspaces");
	const first = createWorkspace(r.loaded, r.scenario, r.arm, { base, rulesFiles: r.adapter.rulesFiles });
	// Files of the trap versions this cell meets are part of its starting state.
	const extra = traps.flatMap((t) => Object.entries((r.scenario.trapPairs ?? []).find((p) => p.id === t.pair)!.versions.find((v) => v.id === t.version)!.files ?? {}));
	for (const [rel, body] of extra) {
		const f = path.resolve(first.dir, rel);
		if (!isInside(f, first.dir) || f === first.dir) throw new Error(`trap file ${rel} escapes the workspace`);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, body);
	}
	let init = first.init;
	if (extra.length) { git(first.dir, "add", "-A", "--force"); git(first.dir, "commit", "-q", "--amend", "-m", "initial"); init = git(first.dir, "rev-parse", "HEAD").trim(); }

	const records: PhaseRecord[] = [];
	let timeouts = r.timeouts;
	let episode: Validity = { valid: true };
	let endedAt: string | undefined;
	const snapDir = path.join(r.work, "snapshots", r.key);
	fs.mkdirSync(path.join(r.work, "invocations"), { recursive: true });

	for (let i = 0; i < phases.length; i++) {
		const ph = phases[i]!;
		const afterId = i === 0 ? null : ph.after ?? phases[i - 1]!.id;
		const prev = afterId === null ? undefined : records.find((x) => x.phase === afterId);
		const inv = fs.mkdtempSync(path.join(r.work, "invocations", "i-"));
		fs.rmdirSync(inv);
		const rec: PhaseRecord = {
			phase: ph.id, session: ph.session, after: afterId, status: "not-run", prompt: "", note: null, noteSource: null, workspace: "", invocation: inv,
			copiedTree: null, startTree: "", startCommit: "", startDiff: "", endTree: null, snapshot: null, endDiff: null, outcome: null, validity: null, diff: null,
			traps: traps.filter((t) => t.phase === ph.id),
		};
		records.push(rec);
		if (prev !== undefined && (prev.status !== "run" || prev.validity?.valid !== true)) {
			rec.status = prev.status === "incomplete" ? "incomplete" : "not-run";
			rec.reason = `the phase it follows, ${prev.phase}, ${prev.status === "run" ? "was invalid" : `is ${prev.status}`}`;
			continue;
		}
		// The workspace.
		if (prev === undefined) rec.workspace = first.dir;
		else if (ph.session === "continue") rec.workspace = prev.workspace;
		else {
			rec.workspace = fs.mkdtempSync(path.join(base, "w-"));
			fs.cpSync(prev.snapshot!, rec.workspace, { recursive: true });
			rec.copiedTree = treeOf(rec.workspace);
			for (const w of ph.withhold ?? []) {
				const f = path.resolve(rec.workspace, w);
				if (isInside(f, rec.workspace) && f !== rec.workspace) fs.rmSync(f, { recursive: true, force: true });
			}
		}
		rec.startTree = treeOf(rec.workspace);
		rec.startCommit = commitOf(rec.workspace, rec.startTree);
		rec.startDiff = git(rec.workspace, "diff", init, rec.startCommit);
		// The note.
		if (ph.note !== undefined && prev !== undefined) {
			if ("file" in ph.note) {
				rec.note = readInside(prev.snapshot!, ph.note.file) ?? NO_NOTE;
				rec.noteSource = "own";
			} else {
				const hook = r.loaded.pack.hooks.find((h) => h.id === (ph.note as { generator: string }).generator);
				const res = hook === undefined ? null : await runHook(r.loaded.dir, hook, { scenario: r.scenario.id, phase: ph.id, after: prev.phase, diff: prev.endDiff ?? "" });
				const note = res?.ok && typeof res.output === "object" && res.output !== null ? (res.output as { note?: unknown }).note : undefined;
				if (typeof note !== "string") {
					rec.status = "incomplete";
					rec.reason = `its note generator failed${res && !res.ok ? ` (${res.reason}): ${res.detail.slice(0, 200)}` : ": no note returned"}`;
					continue;
				}
				rec.note = note;
				rec.noteSource = "generated";
			}
		}
		rec.prompt = phasePrompt(r.experiment, r.scenario, ph, i === 0, r.arm, rec.workspace, rec.note, rec.traps);
		const invocation: Invocation = {
			arm: r.arm, workspace: rec.workspace, prompt: rec.prompt, mode: r.adapter.modes[0]!, member: r.member, tools: "on", timeLimitSeconds: r.timeLimitSeconds, work: inv,
			...(ph.session === "continue" ? { continueFrom: { session: prev!.outcome?.session ?? "", work: prev!.invocation, workspace: prev!.workspace } } : {}),
		};
		const why = ph.session === "continue" && !prev!.outcome?.session ? "the phase it continues returned no session" : r.adapter.refuse(invocation);
		if (why !== null) {
			rec.status = "incomplete";
			rec.reason = why;
			continue;
		}
		const outcome = await r.adapter.invoke(invocation);
		rec.outcome = outcome;
		rec.status = "run";
		if (outcome.stop.reason === "timeout" && outcome.stop.inFlight === "unknown") timeouts++;
		rec.validity = r.classify(outcome, rec.workspace, inv, Math.max(1, timeouts));
		try {
			rec.diff = diffFrom(rec.workspace, rec.startCommit);
			rec.endTree = treeOf(rec.workspace);
			rec.endDiff = diffFrom(rec.workspace, init);
			rec.snapshot = path.join(snapDir, ph.id);
			fs.mkdirSync(path.dirname(rec.snapshot), { recursive: true });
			fs.cpSync(rec.workspace, rec.snapshot, { recursive: true });
		} catch {
			if (rec.validity.valid) rec.validity = { valid: false, cause: "behaviour", detail: "the workspace's changes could not be read: the agent removed or broke its repository" };
		}
		if (!rec.validity.valid) {
			if (rec.validity.cause === "behaviour") endedAt = ph.id;
			episode = rec.validity;
			break;
		}
	}
	for (const p of phases) if (!records.some((x) => x.phase === p.id)) records.push({
		phase: p.id, session: p.session, after: null, status: "not-run", reason: "the episode ended before it", prompt: "", note: null, noteSource: null, workspace: "", invocation: "",
		copiedTree: null, startTree: "", startCommit: "", startDiff: "", endTree: null, snapshot: null, endDiff: null, outcome: null, validity: null, diff: null, traps: traps.filter((t) => t.phase === p.id),
	});
	return { phases: records, validity: episode, ...(endedAt !== undefined ? { endedAt } : {}), timeouts, init };
}
