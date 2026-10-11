// judge-panel - obtains validated votes on blinded outcomes (architecture section 5, principle P3).
//
// Every unit is judged by every judge of a family other than its agent's; a judge of the same
// family is refused, whatever the configuration says. Each judge sees its units in an order of
// its own, at most a set number to a prompt, with tools off and no corpus, the prompt delivered on
// standard input or as an attachment where the judge's runtime supports one. A reply is validated -
// every unit present, every property scored within its scale - and asked again up to three times;
// a vote still missing is recorded as missing, and the unit's property is incomplete.

import fs from "node:fs";
import path from "node:path";
import type { Adapter, DeliveryMode, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import { shuffle, type Unit } from "./blinder.js";
import type { Experiment, LoadedPack, Member, Scenario } from "./pack-schema.js";
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
}

/** The judges for a unit: every given judge of another family; a judge of the unit's own family is never assigned. */
export function assignJudges(unit: Unit, judges: Member[]): Member[] {
	return judges.filter((j) => j.family !== unit.family);
}

export const EMPTY_ARM: ComposedArm = { arm: "judges", instructions: [], folderFiles: [], onRequest: [], canaries: [], negativeCanaries: [], revisions: {} };

function judgePrompt(exp: Experiment, scenario: Scenario, units: Unit[], guessOptions: string[]): { text: string; local: Map<string, Unit> } {
	const props = scenario.properties.filter((p) => p.decidedBy === "judge" && units.some((u) => u.properties.includes(p.id)));
	const local = new Map(units.map((u, i) => [`o${i + 1}`, u]));
	const example = { outcomes: [{ id: "o1", scores: Object.fromEntries(units[0]!.properties.map((p) => [p, { v: 0, reason: "..." }])), guess: guessOptions[0] ?? "" }] };
	const lines = [
		exp.judgeInstructions ?? "You are judging what an agent produced, against the properties listed. Judge only the outcomes given.",
		"", `THE TASK EACH AGENT WAS GIVEN:\n${scenario.task}`,
		scenario.start ? `\nSTARTING STATE: ${scenario.start}` : "",
		scenario.scoring ? `\nWHAT TO SCORE: ${scenario.scoring}` : "",
		"\nPROPERTIES:",
		...props.map((p) => `${p.id} (score ${p.scale[0]} to ${p.scale[1]}): ${p.key}${p.rubric ? `\nRubric: ${p.rubric}` : ""}`),
		`\nAfter scoring each outcome, guess which condition produced it, one of: ${guessOptions.join(", ")}. The guess must not affect any score.`,
		`\nDo not use any tools. Reply with only a JSON object of this shape, covering every outcome (${[...local.keys()].join(", ")}) and only the properties each outcome lists:`,
		JSON.stringify(example),
		"",
		...[...local].map(([id, u]) => `=== OUTCOME ${id} - properties ${u.properties.join(", ")} ===\n${u.text}`),
	];
	return { text: lines.filter((l) => l !== "").join("\n"), local };
}

interface Reply { outcomes?: { id?: string; scores?: Record<string, { v?: unknown; reason?: unknown }>; guess?: unknown }[] }

function parseReply(text: string): Reply | null {
	const s = text.indexOf("{"), e = text.lastIndexOf("}");
	if (s < 0 || e < s) return null;
	try { return JSON.parse(text.slice(s, e + 1)) as Reply; } catch { return null; }
}

/** Votes from one reply, or null if it does not cover every unit and property validly. */
export function validate(reply: Reply | null, local: Map<string, Unit>, scenario: Scenario, judge: Member, prompt: string, guessOptions: string[]): Vote[] | null {
	if (reply === null || !Array.isArray(reply.outcomes)) return null;
	const votes: Vote[] = [];
	for (const [id, u] of local) {
		const o = reply.outcomes.find((x) => x.id === id);
		if (!o) return null;
		for (const pid of u.properties) {
			const p = scenario.properties.find((x) => x.id === pid)!;
			const v = o.scores?.[pid]?.v;
			if (typeof v !== "number" || !Number.isInteger(v) || v < p.scale[0] || v > p.scale[1]) return null;
			const guess = typeof o.guess === "string" && guessOptions.includes(o.guess) ? o.guess : null;
			votes.push({ unit: u.id, property: pid, judge: judge.id, family: judge.family, value: v, reason: String(o.scores?.[pid]?.reason ?? ""), guess, prompt });
		}
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

export async function judgeAll(o: PanelOptions): Promise<Vote[]> {
	const per = o.experiment.judging?.outcomesPerPrompt ?? 6;
	const jobs: { judge: Member; scenario: Scenario; units: Unit[]; name: string }[] = [];
	for (const judge of o.judges) {
		for (const [sid, scenario] of o.scenarios) {
			const mine = shuffle(o.units.filter((u) => u.scenario === sid && assignJudges(u, o.judges).some((j) => j.id === judge.id)), `${o.seed}:${judge.id}:${sid}`);
			for (let k = 0; k * per < mine.length; k++) jobs.push({ judge, scenario, units: mine.slice(k * per, (k + 1) * per), name: `${sid}.${judge.id}.${k + 1}` });
		}
	}
	const votes: Vote[] = [];
	fs.mkdirSync(path.join(o.recordsDir, "judging"), { recursive: true });
	await pool(jobs, o.parallel, async (job) => {
		const adapter = o.adapters[job.judge.runtime];
		if (!adapter) throw new Error(`no adapter for judge runtime ${job.judge.runtime}`);
		const { text, local } = judgePrompt(o.experiment, job.scenario, job.units, o.guessOptions);
		fs.writeFileSync(path.join(o.recordsDir, "judging", `${job.name}.txt`), text);
		const mode: DeliveryMode = adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!;
		let got: Vote[] | null = null;
		const replies: string[] = [];
		for (let attempt = 1; attempt <= 3 && got === null; attempt++) {
			const ws = createWorkspace(o.loaded, { id: "judge", tags: [], fixture: null, task: "", properties: [] }, EMPTY_ARM, { base: path.join(o.work, "judging", "workspaces"), rulesFiles: adapter.rulesFiles });
			fs.mkdirSync(path.join(o.work, "judging", "invocations"), { recursive: true });
			const inv = fs.mkdtempSync(path.join(o.work, "judging", "invocations", "j-"));
			fs.rmdirSync(inv);
			const invocation: Invocation = { arm: EMPTY_ARM, workspace: ws.dir, prompt: text, mode, member: job.judge, tools: "off", timeLimitSeconds: o.timeLimitSeconds, work: inv };
			const out = await adapter.invoke(invocation);
			replies.push(out.final);
			got = validate(parseReply(out.final), local, job.scenario, job.judge, job.name, o.guessOptions);
		}
		fs.writeFileSync(path.join(o.recordsDir, "judging", `${job.name}.replies.json`), JSON.stringify(replies, null, 2) + "\n");
		if (got !== null) votes.push(...got);
		else for (const u of job.units) for (const pid of u.properties) votes.push({ unit: u.id, property: pid, judge: job.judge.id, family: job.judge.family, value: null, reason: "no valid reply after three attempts", guess: null, prompt: job.name });
	});
	return votes.sort((a, b) => `${a.unit}.${a.property}.${a.judge}`.localeCompare(`${b.unit}.${b.property}.${b.judge}`));
}
