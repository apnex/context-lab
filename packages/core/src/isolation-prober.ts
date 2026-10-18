// isolation-prober - probes what an arm received (architecture section 5, principle P1).
//
// For one arm on one adapter and population member, it asks a tools-off agent one question at a
// time - combined questions tripped one provider's content filter - and judges the answers by code:
//
//   the canary       the agent must quote each canary planted in the arm's variants, which shows the
//                    arm's instructions arrived; and must not quote another variant's canary
//   leak probes      for each probe whose content is withheld from this arm, an answer matching the
//                    probe's leak pattern shows withheld content reached the agent
//   liveness         at least one question must be answered rather than filtered or failed, or the
//                    probe shows nothing either way
//
// An answer counts only if the agent made no tool call: an agent that read a file to answer shows the
// file was reachable, not that it was given - and a Codex shell can read its own configuration even
// with tools off. Leak patterns are matched without regard to case.
//
// An arm passes only if every condition holds; an arm without a pass never runs a cell.
// Probes sample named content: they show the named withheld content was absent, never that nothing
// else was present.

import fs from "node:fs";
import path from "node:path";
import type { Adapter, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import type { Outcome } from "./outcome.js";
import type { LoadedPack, Member } from "./pack-schema.js";
import { createWorkspace } from "./workspace-builder.js";

export interface ProbeAnswer {
	question: string;
	kind: "canary" | "leak";
	probe: string;
	answered: boolean;
	final: string;
	finding: "ok" | "missing-canary" | "foreign-canary" | "leak" | "unanswered";
	/** Tool calls in the attempt the finding is read from: the last one asked. */
	toolCalls: number;
	/** Invocations asked for this question, the first included: 1 to 3. */
	attempts: number;
}

/**
 * The prompt for a retry after a tool call. An agent whose instructions tell it to open an entry
 * before quoting it keeps trying to read it when only told not to: two live runs saw Codex retry the
 * read after "do not execute any shell command", giving that instruction as its reason. So the
 * retry says why a read cannot help - nothing is mounted - rather than only forbidding it.
 */
export const probeRetryPrompt = (question: string): string =>
	`No guidance entry or on-request folder is mounted for this question, so reading or searching for one cannot find it. ` +
	`Do not run any command or tool. Answer only from the instructions already in your context; if what is asked is not there, give the reply the question names for that case.\n\n${question}`;

export interface ProbeResult {
	arm: string;
	member: string;
	pass: boolean;
	answers: ProbeAnswer[];
	reasons: string[];
}

export const CANARY_QUESTION = "Do not use any tools. One of the files in your instructions is named context-lab-canary.md. Reply with its sentences, verbatim, one per line, and nothing else; reply NONE if you were given no such file.";

const answeredOf = (o: Outcome): boolean => !o.filtered && o.error === null && o.stop.reason === "completed" && o.final.trim() !== "" && o.tools.length === 0;

export interface ProbeOptions {
	/** Where workspaces and invocation folders are made. */
	base: string;
	timeLimitSeconds?: number;
	/** Ask every leak probe, whatever arms it names: a judge is withheld everything. */
	allLeaks?: boolean;
}

export async function probeArm(loaded: LoadedPack, arm: ComposedArm, member: Member, adapter: Adapter, opts: ProbeOptions): Promise<ProbeResult> {
	const questions: { kind: "canary" | "leak"; probe: string; text: string; leak?: RegExp }[] = [{ kind: "canary", probe: "canary", text: CANARY_QUESTION }];
	for (const l of loaded.pack.isolation.leakProbes) {
		if (opts.allLeaks === true || l.arms.includes(arm.arm)) questions.push({ kind: "leak", probe: l.id, text: `Do not use any tools. Answer in one line. ${l.question}`, leak: new RegExp(l.leak, "i") });
	}
	const scenario = { id: "isolation-probe", tags: [], fixture: null, task: "", properties: [] };
	const answers: ProbeAnswer[] = [];
	for (const q of questions) {
		const ws = createWorkspace(loaded, scenario, arm, { base: path.join(opts.base, "workspaces"), rulesFiles: adapter.rulesFiles });
		fs.mkdirSync(path.join(opts.base, "work"), { recursive: true });
		const work = fs.mkdtempSync(path.join(opts.base, "work", "p-"));
		fs.rmdirSync(work);
		const inv: Invocation = { arm, workspace: ws.dir, prompt: q.text, mode: adapter.modes[0]!, member, tools: "off", timeLimitSeconds: opts.timeLimitSeconds ?? 300, work };
		let o = await adapter.invoke(inv);
		let attempts = 1;
		// Once an attempt has made a tool call, every later retry carries the retry prompt, even after a provider failure between.
		let sawTool = o.tools.length > 0;
		// A tools-off probe has no on-request folders mounted; if the first attempt had a tool call or
		// an infrastructure/provider failure (such as a 429 rate limit), retry up to two more times in a
		// fresh invocation before failing the probe (B19). The criterion is unchanged: the answer read
		// is the last attempt's, and it counts only if that attempt made no tool call.
		for (let retry = 1; retry <= 2 && (o.tools.length > 0 || (!answeredOf(o) && !o.filtered)); retry++) {
			const wsRetry = createWorkspace(loaded, scenario, arm, { base: path.join(opts.base, "workspaces"), rulesFiles: adapter.rulesFiles });
			const workRetry = fs.mkdtempSync(path.join(opts.base, "work", "p-"));
			fs.rmdirSync(workRetry);
			o = await adapter.invoke({ ...inv, workspace: wsRetry.dir, work: workRetry, ...(sawTool ? { prompt: probeRetryPrompt(q.text) } : {}) });
			attempts++;
			sawTool ||= o.tools.length > 0;
		}
		const answered = answeredOf(o);
		let finding: ProbeAnswer["finding"] = answered ? "ok" : "unanswered";
		if (answered && q.kind === "canary") {
			if (!arm.canaries.every((c) => o.final.includes(c))) finding = "missing-canary";
			else if (arm.negativeCanaries.some((c) => o.final.includes(c))) finding = "foreign-canary";
		}
		if (answered && q.kind === "leak" && q.leak?.test(o.final)) finding = "leak";
		answers.push({ question: q.text, kind: q.kind, probe: q.probe, answered, final: o.final, finding, toolCalls: o.tools.length, attempts });
	}
	const reasons: string[] = [];
	// A tool call during a probe fails it outright: the probe runs with tools off, and an answer a
	// tool reached could hide a leak as easily as fake a canary.
	if (answers.some((a) => a.toolCalls > 0)) reasons.push("the agent made a tool call during a probe, with tools off");
	for (const a of answers) {
		if (a.finding === "missing-canary") reasons.push("the arm's canary was not quoted, so its instructions did not arrive");
		if (a.finding === "foreign-canary") reasons.push("another variant's canary was quoted");
		if (a.finding === "leak") reasons.push(`leak probe ${a.probe} matched its withheld content`);
	}
	const canary = answers.find((a) => a.kind === "canary");
	if (arm.canaries.length > 0 && canary !== undefined && !canary.answered) reasons.push("the canary question was not answered, so delivery is unshown");
	if (!answers.some((a) => a.answered)) reasons.push("no question was answered: the probe shows nothing");
	return { arm: arm.arm, member: member.id, pass: reasons.length === 0, answers, reasons };
}
