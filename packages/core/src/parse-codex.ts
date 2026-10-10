// parse-codex - Codex's `exec --json` event stream to the common form.

import { addressesIn, errorCause, pathsIn, type Line, type Outcome, type ParseContext, type ToolCall, type TraceEvent } from "./outcome.js";

interface Item {
	id?: string;
	type?: string;
	text?: string;
	command?: string;
	status?: string;
	exit_code?: number | null;
	changes?: { path?: string }[];
	action?: { url?: string; query?: string; [k: string]: unknown };
	query?: string;
	message?: string;
	[k: string]: unknown;
}
interface Ev {
	type?: string;
	thread_id?: string;
	item?: Item;
	usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
	error?: { message?: string };
	message?: string;
}

const TOOL_TYPES = new Set(["command_execution", "file_change", "web_search", "mcp_tool_call", "collab_tool_call"]);

function toolInput(it: Item): unknown {
	switch (it.type) {
		case "command_execution": return it.command ?? "";
		case "file_change": return (it.changes ?? []).map((c) => c.path ?? "");
		case "web_search": return { query: it.query ?? it.action?.query ?? null, url: it.action?.url ?? null };
		default: {
			const { id: _id, type: _type, status: _status, ...rest } = it;
			return rest;
		}
	}
}

export function parseCodex(lines: Line[], ctx: ParseContext): Outcome {
	const trace: TraceEvent[] = [];
	const tools = new Map<string, ToolCall>();
	let final = "";
	let input = 0, cached = 0, output = 0, sawTokens = false;
	let openModel = false;
	let error: Outcome["error"] = null;
	let session: string | null = null;
	const fail = (message: string, at: number): void => {
		const cause = errorCause("", message);
		error ??= { cause, name: "", message };
		trace.push({ at, kind: "error", cause });
	};
	for (const { at, text } of lines) {
		let e: Ev;
		try { e = JSON.parse(text) as Ev; } catch { continue; }
		switch (e.type) {
			case "thread.started":
				session ??= e.thread_id ?? null;
				break;
			case "turn.started":
				openModel = true;
				trace.push({ at, kind: "model-start" });
				break;
			case "turn.completed":
				openModel = false;
				if (e.usage) {
					sawTokens = true;
					input += e.usage.input_tokens ?? 0;
					cached += e.usage.cached_input_tokens ?? 0;
					output += e.usage.output_tokens ?? 0;
				}
				trace.push({ at, kind: "model-end" });
				break;
			case "turn.failed":
				openModel = false;
				trace.push({ at, kind: "model-end" });
				fail(e.error?.message ?? e.message ?? "", at);
				break;
			case "error":
				fail(e.message ?? e.error?.message ?? "", at);
				break;
			case "item.started":
			case "item.completed": {
				const it = e.item ?? {};
				const done = e.type === "item.completed";
				if (it.type === "agent_message" && done) {
					final = it.text ?? "";
					trace.push({ at, kind: "text", item: it.id ?? null });
				} else if (it.type === "error" && done) {
					fail(it.message ?? "", at);
				} else if (it.type !== undefined && TOOL_TYPES.has(it.type)) {
					const inp = toolInput(it);
					const status = !done ? "running" : it.status === "failed" || (typeof it.exit_code === "number" && it.exit_code !== 0) ? "error" : it.status === "declined" ? "declined" : "completed";
					tools.set(it.id ?? `${tools.size}`, { name: it.type, input: inp, status, paths: pathsIn(inp, ctx.workspace, ctx.home), addresses: addressesIn(inp) });
					trace.push({ at, kind: done ? "tool-end" : "tool-start", tool: it.type, status });
				}
				break;
			}
		}
	}
	const all = [...tools.values()];
	const reason = ctx.timedOut ? "timeout" : error !== null || (ctx.exit !== 0 && ctx.exit !== null) ? "error" : "completed";
	return {
		final,
		exit: ctx.exit,
		signal: ctx.signal,
		stop: { reason, inFlight: all.some((t) => t.status === "running") ? "tool" : openModel ? "model" : "none" },
		cost: { seconds: ctx.seconds, inputTokens: sawTokens ? input : null, cachedInputTokens: sawTokens ? cached : null, outputTokens: sawTokens ? output : null, toolCalls: all.length },
		tools: all,
		filtered: false,
		error,
		session,
		trace,
		events: ctx.events,
	};
}
