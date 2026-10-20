// judge-panel - obtains validated votes on blinded outcomes (architecture section 5, principle P3).
//
// Every unit is judged by every judge of a family other than its agent's; a judge of the unit's own
// family is never assigned. Each judge sees its units in an order of its own, at most a set number
// to a prompt, with tools off and no corpus, the prompt delivered on standard input or as an
// attachment where its runtime supports one. Units come in two shapes:
//
//   outcome units  an agent's final message and changes, judged against the scenario's properties
//                  together, with a guess at the condition that produced them
//   answer units   one answer to one question, judged against that question's key and rubric in
//                  the comprehension-test form mission-kit's eval.mjs used, with no guess, since that
//                  form tells judges not to infer where an answer came from
//
// A reply is validated outcome by outcome; outcomes still missing are asked again, up to three
// prompts in all, and any still missing then are recorded as missing votes. A reply from a judge
// that used a tool is discarded, since a judge with tools off that reached something was not judging
// what it was shown. One judge's failure is recorded and never stops the others.

import fs from "node:fs";
import path from "node:path";
import type { Adapter, DeliveryMode, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import { shuffle, type Unit } from "./blinder.js";
import type { Outcome } from "./outcome.js";
import { phasesOf, propertiesOf, type Experiment, type LoadedPack, type Member, type Property, type Scenario } from "./pack-schema.js";
import { createWorkspace } from "./workspace-builder.js";

export interface Vote {
	unit: string;
	property: string;
	judge: string;
	family: string;
	value: number | null;
	reason: string;
	guess: string | null;
	prompt: string;
	/** The 1-indexed attempt within the judge job that produced this vote (or null if missing). */
	attempt?: number | null;
}

export interface JudgeReplyRecord {
	attempt: number;
	prompt: string;
	local: Record<string, string>;
	work?: string;
	eligible: boolean;
	ineligibleReason: string | null;
	final: string;
	tools: number;
	error: string | null;
	outcome: Outcome | null;
}

/** Whether a judge invocation is eligible to cast votes: zero tools, clean exit (0), completed stop, not filtered, no error, and non-empty reply. */
export function judgeEligible(out: Outcome): { eligible: boolean; reason: string | null } {
	if (out.tools.length > 0) return { eligible: false, reason: `used ${out.tools.length} tool(s)` };
	if (out.filtered || out.error?.cause === "filter") return { eligible: false, reason: "blocked by content filter" };
	if (out.error !== null) return { eligible: false, reason: `error (${out.error.cause}): ${out.error.message.slice(0, 200)}` };
	if (out.stop.reason !== "completed") return { eligible: false, reason: `stop reason ${out.stop.reason}` };
	if (out.exit !== 0) return { eligible: false, reason: `exit ${String(out.exit)}` };
	if (out.final.trim() === "") return { eligible: false, reason: "empty reply" };
	return { eligible: true, reason: null };
}

/** The judges for a unit: every given judge of another family; a judge of the unit's own family is never assigned. */
export function assignJudges(unit: Unit, judges: Member[]): Member[] {
	return judges.filter((j) => j.family !== unit.family);
}

export const EMPTY_ARM: ComposedArm = { arm: "judges", instructions: [], folderFiles: [], onRequest: [], canaries: [], negativeCanaries: [], revisions: {} };

const isAnswer = (u: Unit, s: Scenario): boolean => u.properties.length === 1 && propertiesOf(s).find((p) => p.id === u.properties[0])?.answerHeading !== undefined;

/** The part of a task under one "### heading", up to the next blank line before a heading or the end. */
export function questionUnder(task: string, heading: string): string {
	const lines = task.split("\n");
	const i = lines.findIndex((l) => l.trim() === `### ${heading}`);
	if (i < 0) return "";
	const out: string[] = [];
	for (const l of lines.slice(i + 1)) {
		if (l.startsWith("### ")) break;
		out.push(l);
	}
	while (out.length && out[out.length - 1]!.trim() === "") out.pop();
	return out.join("\n").trim();
}

const neutral = (t: string): string => t.split("{WORKSPACE}").join("(the agent's working folder)").split("{ON_REQUEST}").join("(the agent's reference folder)")
	.split("{NOTE}").join("(a note from the earlier session)").replace(/\{SLOT:[^}]+\}/g, "(a passage placed here in some outcomes)");

/** The task of the phase a unit was judged on: the scenario's for its first phase, else the phase's own. */
export function taskOf(scenario: Scenario, experiment: Experiment, phase: string | undefined): string {
	const phases = phasesOf(scenario, experiment);
	const i = phase === undefined ? 0 : phases.findIndex((p) => p.id === phase);
	return i <= 0 ? scenario.task : phases[i]!.task ?? "";
}

function outcomePrompt(exp: Experiment, scenario: Scenario, units: Unit[], guessOptions: string[]): { text: string; local: Map<string, Unit> } {
	const props = propertiesOf(scenario).filter((p) => p.decidedBy === "judge" && units.some((u) => u.properties.includes(p.id)));
	const local = new Map(units.map((u, i) => [`o${i + 1}`, u]));
	const guessing = guessOptions.length > 1;
	const example = { outcomes: [{ id: "o1", scores: Object.fromEntries(units[0]!.properties.map((p) => [p, { v: 0, reason: "..." }])), ...(guessing ? { guess: guessOptions[0] } : {}) }] };
	const lines = [
		exp.judgeInstructions ?? "You are judging what an agent produced, against the properties listed. Judge only the outcomes given.",
		"", `THE TASK EACH AGENT WAS GIVEN:\n${neutral(taskOf(scenario, exp, units[0]!.phase))}`,
		scenario.start ? `\nSTARTING STATE: ${scenario.start}` : "",
		scenario.scoring ? `\nWHAT TO SCORE: ${scenario.scoring}` : "",
		"\nPROPERTIES:",
		...props.map((p) => `${p.id} (score ${p.scale[0]} to ${p.scale[1]}): ${p.key}${p.rubric ? `\nRubric: ${p.rubric}` : ""}`),
		guessing ? `\nAfter scoring each outcome, give your guess - one of: ${guessOptions.join(", ")} - as "guess". The guess must not affect any score.` : "",
		`\nDo not use any tools. Reply with only a JSON object of this shape, covering every outcome (${[...local.keys()].join(", ")}) and only the properties each outcome lists:`,
		JSON.stringify(example),
		"",
		...[...local].map(([id, u]) => `=== OUTCOME ${id} - properties ${u.properties.join(", ")} ===\n${u.text}`),
	];
	return { text: lines.filter((l) => l !== "").join("\n"), local };
}

// The comprehension form, carried from mission-kit's tools/eval.mjs scorer prompt. Its lines are
// verbatim but for how the reply is delivered: eval.mjs's scorer wrote a file and replied DONE; a
// judge here has no tools, so it replies with the lines instead (0016). The opening line no longer
// names the records folder, whose name ends with the experiment's id (0035, B21).
function answerPrompt(exp: Experiment, scenario: Scenario, units: Unit[]): { text: string; local: Map<string, Unit> } {
	const local = new Map(units.map((u, i) => [`a${i + 1}`, u]));
	const lines = [
		"You are scoring answers to a comprehension test against an answer key. Read only this file. Do not open any other file.",
		"", exp.judgeInstructions ?? "Score each answer 0, 1 or 2 against the probe's key and rubric. An answer that labels its conclusion a guess, or says the text does not settle it, scores at most 1 unless the rubric says otherwise. Judge the answer, not its length or confidence.",
		"", "You do not know which answers came from which reader or document version, and must not try to infer it.",
		"", "Reply with one JSON object per line, for every answer id below and no others, and nothing else.",
		'Each line exactly: {"item": "<answer id>", "score": 0|1|2, "reason": "<one sentence>"}',
	];
	const props: Property[] = [];
	for (const u of units) { const p = propertiesOf(scenario).find((x) => x.id === u.properties[0])!; if (!props.includes(p)) props.push(p); }
	for (const p of props) {
		lines.push("", "=".repeat(70), `PROBE ${p.answerHeading}`, "", "Question:", p.question ?? questionUnder(taskOf(scenario, exp, units[0]!.phase), p.answerHeading!), "", "Key:", p.key, "", "Rubric:", p.rubric ?? "");
		for (const [id, u] of local) if (u.properties[0] === p.id) lines.push("", `--- answer ${id} ---`, u.text.replace(/^--- ANSWER ---\n/, "").trimEnd());
	}
	return { text: lines.join("\n") + "\n", local };
}

interface Reply { outcomes?: { id?: string; scores?: Record<string, { v?: unknown; reason?: unknown }>; guess?: unknown }[] }

function parseOutcomeReply(text: string): Reply | null {
	const s = text.indexOf("{"), e = text.lastIndexOf("}");
	if (s < 0 || e < s) return null;
	try { return JSON.parse(text.slice(s, e + 1)) as Reply; } catch { return null; }
}

function parseAnswerReply(text: string): Reply {
	const outcomes: NonNullable<Reply["outcomes"]> = [];
	for (const line of text.split("\n")) {
		const t = line.trim().replace(/^```\w*|```$/g, "");
		if (!t.startsWith("{")) continue;
		try {
			const o = JSON.parse(t) as { item?: string; score?: unknown; reason?: unknown };
			if (typeof o.item === "string") outcomes.push({ id: o.item, scores: { "*": { v: o.score, reason: o.reason } } });
		} catch { /* not a line of the reply */ }
	}
	return { outcomes };
}

/** Valid votes from one reply, outcome by outcome; an outcome missing or invalid gives none. */
export function validate(reply: Reply | null, local: Map<string, Unit>, scenario: Scenario, judge: Member, prompt: string, guessOptions: string[], attempt = 1): Vote[] {
	if (reply === null || !Array.isArray(reply.outcomes)) return [];
	const votes: Vote[] = [];
	for (const [id, u] of local) {
		const o = reply.outcomes.find((x) => x.id === id);
		if (!o) continue;
		const mine: Vote[] = [];
		for (const pid of u.properties) {
			const p = propertiesOf(scenario).find((x) => x.id === pid)!;
			const sc = o.scores?.[pid] ?? o.scores?.["*"];
			const v = sc?.v;
			if (typeof v !== "number" || !Number.isInteger(v) || v < p.scale[0] || v > p.scale[1]) { mine.length = 0; break; }
			const guess = typeof o.guess === "string" && guessOptions.includes(o.guess) ? o.guess : null;
			mine.push({ unit: u.id, property: pid, judge: judge.id, family: judge.family, value: v, reason: String(sc?.reason ?? ""), guess, prompt, attempt });
		}
		if (mine.length === u.properties.length) votes.push(...mine);
	}
	return votes;
}

export interface PanelOptions {
	loaded: LoadedPack;
	experiment: Experiment;
	scenarios: Map<string, Scenario>;
	units: Unit[];
	judges: Member[];
	adapters: Record<string, Adapter>;
	guessOptions: string[];
	recordsDir: string;
	work: string;
	seed: string;
	timeLimitSeconds: number;
	parallel: number;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
	const q = items.slice();
	await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (q.length) await fn(q.shift()!); }));
}

/** One judge's prompt over some units of one scenario and phase: its name, the units, and whether they are answers. */
export interface JudgeJob { judge: Member; scenario: Scenario; units: Unit[]; name: string; answers: boolean }

/** The jobs judgeAll runs: per judge, scenario, phase and kind, the units assigned to that judge, shuffled by the seed and cut into prompts of outcomesPerPrompt. */
export function planJudgeJobs(o: Pick<PanelOptions, "experiment" | "scenarios" | "units" | "judges" | "seed">): JudgeJob[] {
	const per = o.experiment.judging?.outcomesPerPrompt ?? 6;
	const jobs: JudgeJob[] = [];
	for (const judge of o.judges) {
		for (const [sid, scenario] of o.scenarios) {
			const mine = o.units.filter((u) => u.scenario === sid && assignJudges(u, o.judges).some((j) => j.id === judge.id));
			// One prompt holds units of one phase, so the task shown is the one those agents were given.
			const phaseKeys = [...new Set(mine.map((u) => u.phase ?? ""))].sort();
			for (const ph of phaseKeys) for (const answers of [false, true]) {
				const group = shuffle(mine.filter((u) => (u.phase ?? "") === ph && isAnswer(u, scenario) === answers), `${o.seed}:${judge.id}:${sid}:${ph}:${answers}`);
				const tag = ph ? `${sid}.${ph}` : sid;
				for (let k = 0; k * per < group.length; k++) jobs.push({ judge, scenario, units: group.slice(k * per, (k + 1) * per), name: `${tag}.${answers ? "answers" : "outcomes"}.${judge.id}.${k + 1}`, answers });
			}
		}
	}
	return jobs;
}

/** How a judge's prompt reaches its runtime: on stdin where it can, else as an attached file, else its first mode. */
export const judgeMode = (adapter: Pick<Adapter, "modes">): DeliveryMode => (adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!);

/**
 * The prompt for a job's pending units, and the label each unit has in it. The first attempt's
 * pending units are all the job's; a retry's are those without a valid vote yet, so a retry is the
 * same prompt over fewer units, relabelled from a1 or o1.
 */
export function judgePrompt(experiment: Experiment, job: Pick<JudgeJob, "scenario" | "answers">, pending: Unit[], guessOptions: string[]): { text: string; local: Map<string, Unit> } {
	return job.answers ? answerPrompt(experiment, job.scenario, pending) : outcomePrompt(experiment, job.scenario, pending, guessOptions);
}

/** The invocation of one judge attempt: tools off, the empty arm, the prompt in the judge's mode. */
export const judgeInvocation = (judge: Member, adapter: Pick<Adapter, "modes">, prompt: string, workspace: string, work: string, timeLimitSeconds: number): Invocation => (
	{ arm: EMPTY_ARM, workspace, prompt, mode: judgeMode(adapter), member: judge, tools: "off", timeLimitSeconds, work }
);

export async function judgeAll(o: PanelOptions): Promise<Vote[]> {
	const jobs = planJudgeJobs(o);
	const votes: Vote[] = [];
	fs.mkdirSync(path.join(o.recordsDir, "judging"), { recursive: true });
	await pool(jobs, o.parallel, async (job) => {
		const record: { prompt: string; replies: JudgeReplyRecord[]; failure?: string } = { prompt: "", replies: [] };
		let got: Vote[] = [];
		try {
			const adapter = o.adapters[job.judge.runtime];
			if (!adapter) throw new Error(`no adapter for judge runtime ${job.judge.runtime}`);
			for (let attempt = 1; attempt <= 3; attempt++) {
				const pending = job.units.filter((u) => !got.some((v) => v.unit === u.id));
				if (!pending.length) break;
				const { text, local } = judgePrompt(o.experiment, job, pending, o.guessOptions);
				if (attempt === 1) record.prompt = text;
				const ws = createWorkspace(o.loaded, { id: "judge", tags: [], fixture: null, task: "", properties: [] }, EMPTY_ARM, { base: path.join(o.work, "judging", "workspaces"), rulesFiles: adapter.rulesFiles });
				fs.mkdirSync(path.join(o.work, "judging", "invocations"), { recursive: true });
				const inv = fs.mkdtempSync(path.join(o.work, "judging", "invocations", "j-"));
				fs.rmdirSync(inv);
				const invocation = judgeInvocation(job.judge, adapter, text, ws.dir, inv, o.timeLimitSeconds);
				const localMap = Object.fromEntries([...local.entries()].map(([k, u]) => [k, u.id]));
				const entry: JudgeReplyRecord = {
					attempt, prompt: text, local: localMap, work: inv,
					eligible: false, ineligibleReason: "invocation did not complete",
					final: "", tools: 0, error: null, outcome: null,
				};
				record.replies.push(entry);
				const out = await adapter.invoke(invocation);
				const elig = judgeEligible(out);
				entry.eligible = elig.eligible;
				entry.ineligibleReason = elig.reason;
				entry.final = out.final;
				entry.tools = out.tools.length;
				entry.error = out.error?.message ?? null;
				entry.outcome = out;
				if (!elig.eligible) continue;
				const reply = job.answers ? parseAnswerReply(out.final) : parseOutcomeReply(out.final);
				got = [...got, ...validate(reply, local, job.scenario, job.judge, job.name, job.answers ? [] : o.guessOptions, attempt)];
			}
		} catch (e) {
			record.failure = String(e).slice(0, 1000);
			const lastReply = record.replies[record.replies.length - 1];
			if (lastReply && lastReply.outcome === null) {
				lastReply.ineligibleReason = `invocation threw: ${record.failure}`;
				lastReply.error = record.failure;
			}
		}
		fs.writeFileSync(path.join(o.recordsDir, "judging", `${job.name}.json`), JSON.stringify(record, null, 2) + "\n");
		votes.push(...got);
		for (const u of job.units) for (const pid of u.properties) {
			if (!got.some((v) => v.unit === u.id && v.property === pid)) votes.push({ unit: u.id, property: pid, judge: job.judge.id, family: job.judge.family, value: null, reason: record.failure ?? "no valid vote after three prompts", guess: null, prompt: job.name, attempt: null });
		}
	});
	return votes.sort((a, b) => `${a.unit}.${a.property}.${a.judge}`.localeCompare(`${b.unit}.${b.property}.${b.judge}`));
}
