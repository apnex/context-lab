// parse-opencode - opencode's `run --format json` event stream to the common form.

import { addressesIn, errorCause, pathsIn, type Line, type Outcome, type ParseContext, type ToolCall, type ToolStatus, type TraceEvent } from "./outcome.js";

interface Ev {
	type?: string;
	sessionID?: string;
	part?: { messageID?: string; text?: string; tool?: string; reason?: string; state?: { input?: unknown; status?: string; error?: unknown }; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } };
	error?: { name?: string; data?: { message?: string } };
}

const toolStatus = (s: string | undefined, error: unknown): ToolStatus => {
	if (s === "completed") return "completed";
	if (s === "error") return /rejected|prevents you|denied|not allowed/i.test(String(error)) ? "declined" : "error";
	return "running";
};

export function parseOpencode(lines: Line[], ctx: ParseContext): Outcome {
	const trace: TraceEvent[] = [];
	const textByMessage = new Map<string, string>();
	const tools: ToolCall[] = [];
	let input = 0, cached = 0, output = 0, sawTokens = false;
	let openModel = false;
	let filtered = false;
	let error: Outcome["error"] = null;
	let session: string | null = null;
	for (const { at, text } of lines) {
		let e: Ev;
		try { e = JSON.parse(text) as Ev; } catch { continue; }
		session ??= e.sessionID ?? null;
		const p = e.part;
		switch (e.type) {
			case "step_start":
				openModel = true;
				trace.push({ at, kind: "model-start" });
				break;
			case "step_finish": {
				openModel = false;
				const t = p?.tokens;
				if (t) {
					sawTokens = true;
					input += (t.input ?? 0) + (t.cache?.write ?? 0) + (t.cache?.read ?? 0);
					cached += t.cache?.read ?? 0;
					output += (t.output ?? 0) + (t.reasoning ?? 0);
				}
				if (p?.reason === "content-filter") filtered = true;
				trace.push({ at, kind: "model-end", reason: p?.reason ?? null });
				break;
			}
			case "text":
				if (p?.messageID !== undefined && typeof p.text === "string") textByMessage.set(p.messageID, (textByMessage.get(p.messageID) ?? "") + p.text);
				trace.push({ at, kind: "text", message: p?.messageID ?? null });
				break;
			case "tool_use": {
				const inp = p?.state?.input ?? {};
				const status = toolStatus(p?.state?.status, p?.state?.error);
				tools.push({ name: p?.tool ?? "", input: inp, status, paths: pathsIn(inp, ctx.workspace, ctx.home), addresses: addressesIn(inp) });
				trace.push({ at, kind: "tool-end", tool: p?.tool ?? "", status });
				break;
			}
			case "error": {
				const name = e.error?.name ?? "";
				const message = e.error?.data?.message ?? "";
				const cause = errorCause(name, message);
				if (cause === "filter") filtered = true;
				error ??= { cause, name, message };
				trace.push({ at, kind: "error", cause, name });
				break;
			}
		}
	}
	const messages = [...textByMessage.values()];
	const reason = ctx.timedOut ? "timeout" : error !== null || (ctx.exit !== 0 && ctx.exit !== null) ? "error" : "completed";
	return {
		final: messages.length ? messages[messages.length - 1]! : "",
		exit: ctx.exit,
		signal: ctx.signal,
		// opencode reports a tool call only when it ends, and runs tools inside a step, so an open step
		// is a model call or a tool, and the stream cannot say which.
		stop: { reason, inFlight: openModel ? "unknown" : "none" },
		cost: { seconds: ctx.seconds, inputTokens: sawTokens ? input : null, cachedInputTokens: sawTokens ? cached : null, outputTokens: sawTokens ? output : null, toolCalls: tools.length },
		tools,
		filtered,
		error,
		session,
		trace,
		events: ctx.events,
	};
}
