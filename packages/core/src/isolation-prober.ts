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
import { BudgetExhausted, Refused, type Adapter, type Invocation, type InvocationBudget, type InvocationRole } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import type { Outcome } from "./outcome.js";
import type { LoadedPack, Member } from "./pack-schema.js";
import { createWorkspace } from "./workspace-builder.js";

export type ProbeFinding = "ok" | "missing-canary" | "foreign-canary" | "leak" | "unanswered";

export type ProbeIneligibleReason =
	| "not-dispatched"
	| "filtered"
	| "timeout"
	| "stdout-overflow"
	| "runtime-error"
	| "tool-call"
	| "empty-reply"
	| "reply-bytes-exceeded";

export interface ProbeAttemptRecord {
	attempt: number;
	invocationId: number | null;
	prompt: string;
	promptBytes: number;
	controlledInputBytes: number | null;
	work: string;
	events: string | null;
	dispatched: boolean;
	refusalReason: "input-bytes" | "budget-exhausted" | "adapter-refused" | null;
	refusalMessage: string | null;
	answered: boolean;
	eligible: boolean;
	ineligibleReason: ProbeIneligibleReason | null;
	final: string;
	replyBytes: number;
	finding: ProbeFinding;
	toolCalls: number;
	usageComplete: boolean;
	outcome: Outcome | null;
}

export interface ProbeAnswer {
	question: string;
	kind: "canary" | "leak";
	probe: string;
	answered: boolean;
	final: string;
	finding: ProbeFinding;
	/** Tool calls in the attempt the finding is read from: the last one asked. */
	toolCalls: number;
	/** Invocations asked for this question, the first included: 1 to 3. */
	attempts: number;
	/** Complete per-attempt provenance for this probe question (0040, B30). */
	history?: ProbeAttemptRecord[];
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

const answeredOf = (o: Outcome, maxReplyBytes?: number): boolean =>
	!o.filtered &&
	!o.stdoutTruncated &&
	o.error === null &&
	o.stop.reason === "completed" &&
	o.final.trim() !== "" &&
	o.tools.length === 0 &&
	(maxReplyBytes === undefined || Buffer.byteLength(o.final, "utf8") <= maxReplyBytes);

function ineligibleReasonOf(o: Outcome, maxReplyBytes?: number): ProbeIneligibleReason | null {
	if (o.filtered) return "filtered";
	if (o.stdoutTruncated) return "stdout-overflow";
	if (o.stop.reason === "timeout") return "timeout";
	if (o.error !== null || o.stop.reason === "error") return "runtime-error";
	if (o.tools.length > 0) return "tool-call";
	if (o.final.trim() === "") return "empty-reply";
	if (maxReplyBytes !== undefined && Buffer.byteLength(o.final, "utf8") > maxReplyBytes) return "reply-bytes-exceeded";
	return null;
}

function violationInReply(kind: "canary" | "leak", text: string, arm: ComposedArm, leak?: RegExp): "foreign-canary" | "leak" | null {
	if (!text) return null;
	if (kind === "canary" && arm.negativeCanaries.some((c) => text.includes(c))) return "foreign-canary";
	if (kind === "leak" && leak?.test(text)) return "leak";
	return null;
}

function findingForAttempt(kind: "canary" | "leak", o: Outcome, eligible: boolean, arm: ComposedArm, leak?: RegExp): ProbeFinding {
	// Even if a reply is ineligible on size, stdout overflow, or tool call, an observed foreign-canary
	// or leak in its captured text is recorded immediately so a violation is never masked (0040, B30).
	const violation = violationInReply(kind, o.final, arm, leak);
	if (violation !== null) return violation;
	if (!eligible) return "unanswered";
	if (kind === "canary" && !arm.canaries.every((c) => o.final.includes(c))) return "missing-canary";
	return "ok";
}

export interface ProbeOptions {
	/** Where workspaces and invocation folders are made. */
	base: string;
	timeLimitSeconds?: number;
	/** Ask every leak probe, whatever arms it names: a judge is withheld everything. */
	allLeaks?: boolean;
	/** Maximum attempts per probe question (1, 2 or 3; default 3). */
	maxAttempts?: 1 | 2 | 3;
	/** Pre-dispatch UTF-8 byte ceiling on evaluator-controlled probe input. */
	maxInputBytes?: number;
	/** Post-generation UTF-8 byte eligibility ceiling on raw probe reply (`Outcome.final`). */
	maxReplyBytes?: number;
	/** Maximum UTF-8 bytes of child stdout captured per probe invocation. */
	maxStdoutBytes?: number;
	/** Shared run invocation budget. */
	budget?: InvocationBudget;
	/** Role recorded in InvocationBudget ("readerProbe" by default, or "judgeProbe" when allLeaks is true). */
	role?: InvocationRole;
}

export async function probeArm(loaded: LoadedPack, arm: ComposedArm, member: Member, adapter: Adapter, opts: ProbeOptions): Promise<ProbeResult> {
	const maxAttempts = opts.maxAttempts ?? 3;
	const role: InvocationRole = opts.role ?? (opts.allLeaks ? "judgeProbe" : "readerProbe");
	const questions: { kind: "canary" | "leak"; probe: string; text: string; leak?: RegExp }[] = [{ kind: "canary", probe: "canary", text: CANARY_QUESTION }];
	for (const l of loaded.pack.isolation.leakProbes) {
		if (opts.allLeaks === true || l.arms.includes(arm.arm)) questions.push({ kind: "leak", probe: l.id, text: `Do not use any tools. Answer in one line. ${l.question}`, leak: new RegExp(l.leak, "i") });
	}
	const scenario = { id: "isolation-probe", tags: [], fixture: null, task: "", properties: [] };
	const answers: ProbeAnswer[] = [];
	for (const q of questions) {
		const history: ProbeAttemptRecord[] = [];
		let sawTool = false;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const prompt = sawTool ? probeRetryPrompt(q.text) : q.text;
			const promptBytes = Buffer.byteLength(prompt, "utf8");
			const ws = createWorkspace(loaded, scenario, arm, { base: path.join(opts.base, "workspaces"), rulesFiles: adapter.rulesFiles });
			fs.mkdirSync(path.join(opts.base, "work"), { recursive: true });
			const work = fs.mkdtempSync(path.join(opts.base, "work", "p-"));
			fs.rmdirSync(work);
			const inv: Invocation = {
				arm,
				workspace: ws.dir,
				prompt,
				mode: adapter.modes[0]!,
				member,
				tools: "off",
				timeLimitSeconds: opts.timeLimitSeconds ?? 300,
				...(opts.maxInputBytes !== undefined ? { maxInputBytes: opts.maxInputBytes } : {}),
				...(opts.maxStdoutBytes !== undefined ? { maxStdoutBytes: opts.maxStdoutBytes } : {}),
				...(opts.budget !== undefined ? { budget: opts.budget } : {}),
				role,
				work,
			};
			let o: Outcome;
			try {
				o = await adapter.invoke(inv);
			} catch (err) {
				const isBudget = err instanceof BudgetExhausted;
				const isInput = err instanceof Refused && /exceeds maxInputBytes/.test(err.message);
				const refusalReason = isBudget ? "budget-exhausted" : isInput ? "input-bytes" : "adapter-refused";
				const refusalMessage = err instanceof Error ? err.message : String(err);
				history.push({
					attempt,
					invocationId: null,
					prompt,
					promptBytes,
					controlledInputBytes: null,
					work,
					events: null,
					dispatched: false,
					refusalReason,
					refusalMessage,
					answered: false,
					eligible: false,
					ineligibleReason: "not-dispatched",
					final: "",
					replyBytes: 0,
					finding: "unanswered",
					toolCalls: 0,
					usageComplete: false,
					outcome: null,
				});
				// Pre-dispatch refusal (oversized input or exhausted invocation ceiling) never retries unchanged input.
				break;
			}
			const eligible = answeredOf(o, opts.maxReplyBytes);
			const inelig = eligible ? null : ineligibleReasonOf(o, opts.maxReplyBytes);
			const finding = findingForAttempt(q.kind, o, eligible, arm, q.leak);
			const usageComplete = o.usageComplete ?? (!o.stdoutTruncated && o.stop.reason !== "timeout");
			history.push({
				attempt,
				invocationId: o.invocationId ?? null,
				prompt,
				promptBytes,
				controlledInputBytes: o.controlledInputBytes ?? null,
				work,
				events: o.events,
				dispatched: true,
				refusalReason: null,
				refusalMessage: null,
				answered: eligible,
				eligible,
				ineligibleReason: inelig,
				final: o.final,
				replyBytes: Buffer.byteLength(o.final, "utf8"),
				finding,
				toolCalls: o.tools.length,
				usageComplete,
				outcome: o,
			});
			sawTool ||= o.tools.length > 0;
			// Do not retry if we already got an eligible answer, if the reply was content-filtered, or if a violation was already observed.
			if (eligible || o.filtered || finding === "foreign-canary" || finding === "leak") break;
			if (opts.budget?.isExhausted()) break;
		}
		const last = history[history.length - 1]!;
		// Sticky violation rule (0040, B30): if any attempt in history observed a foreign-canary or leak,
		// preserve that violation as the question's finding even if a later attempt returned a clean or empty reply.
		const stickyViolation = history.find((h) => h.finding === "foreign-canary" || h.finding === "leak")?.finding;
		const finding = stickyViolation ?? last.finding;
		answers.push({
			question: q.text,
			kind: q.kind,
			probe: q.probe,
			answered: last.answered,
			final: last.final,
			finding,
			toolCalls: last.toolCalls,
			attempts: history.length,
			history,
		});
	}
	const reasons: string[] = [];
	// A tool call during the final attempt (or any attempt that also observed a violation or left the question unanswered) fails it.
	if (answers.some((a) => a.toolCalls > 0)) reasons.push("the agent made a tool call during a probe, with tools off");
	for (const a of answers) {
		if (a.finding === "missing-canary") reasons.push("the arm's canary was not quoted, so its instructions did not arrive");
		if (a.finding === "foreign-canary") reasons.push("another variant's canary was quoted");
		if (a.finding === "leak") reasons.push(`leak probe ${a.probe} matched its withheld content`);
		const refused = a.history?.find((h) => !h.dispatched);
		if (refused) reasons.push(`probe ${a.probe} was refused before dispatch (${refused.refusalReason}): ${refused.refusalMessage}`);
		const overflow = a.history?.find((h) => h.ineligibleReason === "stdout-overflow");
		if (overflow && !a.answered) reasons.push(`probe ${a.probe} exceeded maxStdoutBytes and was cut as incomplete`);
		const replyOver = a.history?.find((h) => h.ineligibleReason === "reply-bytes-exceeded");
		if (replyOver && !a.answered) reasons.push(`probe ${a.probe} reply (${replyOver.replyBytes} bytes) exceeded maxProbeReplyBytes`);
	}
	const canary = answers.find((a) => a.kind === "canary");
	if (arm.canaries.length > 0 && canary !== undefined && !canary.answered) reasons.push("the canary question was not answered, so delivery is unshown");
	if (!answers.some((a) => a.answered)) reasons.push("no question was answered: the probe shows nothing");
	return { arm: arm.arm, member: member.id, pass: reasons.length === 0, answers, reasons };
}
