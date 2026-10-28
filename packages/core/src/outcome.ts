// outcome - the common form every runtime adapter returns (conformance cases, "The common form").
//
// An adapter collects its runtime's event lines as they arrive, each stamped with the time since
// the invocation began, and hands them to its runtime's parser, which returns an Outcome. The
// helpers here are shared by every parser: finding paths and addresses in a tool's input, and
// removing credentials from anything written.

import os from "node:os";
import path from "node:path";

export type StopReason = "completed" | "timeout" | "error";
export type InFlight = "model" | "tool" | "none" | "unknown";
export type ToolStatus = "completed" | "error" | "declined" | "running";
export type ErrorCause = "filter" | "provider" | "overflow" | "unknown";
export type TraceKind = "model-start" | "model-end" | "text" | "tool-start" | "tool-end" | "error";

export interface ToolCall {
	name: string;
	input: unknown;
	status: ToolStatus;
	paths: string[];
	addresses: string[];
}

export interface TraceEvent {
	at: number;
	kind: TraceKind;
	[field: string]: unknown;
}

export interface Outcome {
	final: string;
	exit: number | null;
	signal: string | null;
	stop: { reason: StopReason; inFlight: InFlight };
	cost: { seconds: number; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; toolCalls: number };
	tools: ToolCall[];
	filtered: boolean;
	error: { cause: ErrorCause; name: string; message: string } | null;
	session: string | null;
	trace: TraceEvent[];
	events: string;
	/** Set to true when child stdout exceeded maxStdoutBytes and was cut at a line boundary with SIGKILL (0040, B30). */
	stdoutTruncated?: boolean;
	/** Number of UTF-8 bytes of child stdout retained before the invocation completed or was cut. */
	capturedStdoutBytes?: number;
	/** False when stdoutTruncated or timedOut interrupted the event stream before completion, so token/tool usage is a lower bound rather than complete. */
	usageComplete?: boolean;
	/** Monotonic invocation ID reserved from the run's InvocationBudget before dispatch. */
	invocationId?: number;
	/** Measured UTF-8 bytes of evaluator-controlled prepared input (prompt + wrapper + delivered instructions and folderFiles). */
	controlledInputBytes?: number;
}

/** One line of a runtime's event stream, with when it arrived. */
export interface Line {
	at: number;
	text: string;
}

/** What a parser needs to know about the invocation besides its events. */
export interface ParseContext {
	workspace: string;
	home: string;
	exit: number | null;
	signal: string | null;
	timedOut: boolean;
	stdoutTruncated?: boolean;
	capturedStdoutBytes?: number;
	seconds: number;
	events: string;
}

const ADDRESS = /https?:\/\/[^\s"'`<>)\]\\]+/g;
const SPLIT = /[\s;|&<>()'"`,=]+/;

/** Every string in a tool's input, however deeply it is nested. */
function stringsIn(v: unknown): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.flatMap(stringsIn);
	if (typeof v === "object" && v !== null) return Object.values(v).flatMap(stringsIn);
	return [];
}

const trimEnd = (t: string): string => t.replace(/[.,;:]+$/, "");

/** Every http(s) address in a tool's input. */
export function addressesIn(input: unknown): string[] {
	const out: string[] = [];
	for (const s of stringsIn(input)) for (const m of s.matchAll(ADDRESS)) { const a = trimEnd(m[0]); if (!out.includes(a)) out.push(a); }
	return out;
}

/**
 * Every path in a tool's input that reaches outside a relative position. The input's strings are
 * split into words on whitespace, quotes and the characters ; | & < > ( ) ` , = - addresses removed
 * first - and a word is a path if it begins with / (absolute), with ~/ (expanded against the agent's
 * home), or with ../ or holds /../ (resolved against the workspace). The rule over-counts words
 * inside quoted expressions, such as a sed substitution; it never misses a word that is a path.
 */
export function pathsIn(input: unknown, workspace: string, home: string): string[] {
	const out: string[] = [];
	const add = (p: string): void => { if (!out.includes(p)) out.push(p); };
	const norm = (p: string): string => { const n = path.normalize(p); return n.length > 1 ? n.replace(/\/+$/, "") : n; };
	for (const s of stringsIn(input)) {
		for (const raw of s.replace(ADDRESS, " ").split(SPLIT)) {
			const t = trimEnd(raw);
			if (t.startsWith("/")) add(norm(t));
			else if (t.startsWith("~/")) add(norm(path.join(home, t.slice(2))));
			else if (t.startsWith("../") || t.includes("/../")) add(norm(path.resolve(workspace, t)));
		}
	}
	return out;
}

/** Classify an error from its runtime name and message. */
export function errorCause(name: string, message: string): ErrorCause {
	if (name === "ContentFilterError" || /content filter|blocked by the provider/i.test(message)) return "filter";
	if (/context (?:window|length)|maximum context|too many tokens|prompt is too long/i.test(message)) return "overflow";
	if (name === "APIError" || name === "UnknownError" || /\b(?:4\d\d|5\d\d)\b|bad request|rate limit|unavailable|at capacity|overloaded/i.test(message)) return "provider";
	return "unknown";
}

/** Replace every occurrence of every secret, longest first, in text written to disk. */
export function scrub(text: string, secrets: string[]): string {
	let out = text;
	for (const s of [...secrets].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)) out = out.split(s).join("[credential removed]");
	return out;
}

export const defaultHome = (): string => os.homedir();
