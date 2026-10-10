// Criterion E5: for each driven adapter, traces are classified by cause - a forbidden address or
// path reached by fetch tool, shell command or file read is isolation, naming it; a provider error
// or content filter is infrastructure; a timeout spent working, or an overflow, is behaviour - and
// each trace with its cause removed is valid.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, parseCodex, parseOpencode, type Line, type Outcome } from "../src/index.js";

const WS = "/work/ws";
const FORBIDDEN = { paths: ["/srv/forbidden"], addresses: ["https://example.invalid/almanac"] };
const lines = (evs: object[]): Line[] => evs.map((e, i) => ({ at: i * 10, text: JSON.stringify(e) }));
const ctx = { workspace: WS, home: "/work/home", exit: 0, signal: null, timedOut: false, seconds: 1, events: "/dev/null" };

const oc = (body: object[], over: Partial<typeof ctx> = {}): Outcome => parseOpencode(lines([{ type: "step_start", part: {} }, ...body, { type: "text", part: { messageID: "m", text: "Done." } }, { type: "step_finish", part: { reason: "stop" } }]), { ...ctx, ...over });
const cx = (body: object[], over: Partial<typeof ctx> = {}): Outcome => parseCodex(lines([{ type: "turn.started" }, ...body, { type: "item.completed", item: { id: "z", type: "agent_message", text: "Done." } }, { type: "turn.completed", usage: {} }]), { ...ctx, ...over });
const ocTool = (tool: string, input: object) => ({ type: "tool_use", part: { tool, state: { status: "completed", input } } });
const cxItem = (item: object) => ({ type: "item.completed", item: { id: "t", status: "completed", exit_code: 0, ...item } });

const isolation: [string, Outcome, Outcome, string][] = [
	["opencode fetch tool", oc([ocTool("webfetch", { url: "https://example.invalid/almanac/GUIDE.md" })]), oc([ocTool("webfetch", { url: "https://example.invalid/other" })]), "https://example.invalid/almanac/GUIDE.md"],
	["opencode shell command", oc([ocTool("bash", { command: "curl -s https://example.invalid/almanac | head" })]), oc([ocTool("bash", { command: "curl -s https://example.invalid/almanacs | head" })]), "https://example.invalid/almanac"],
	["opencode file read", oc([ocTool("read", { filePath: "/srv/forbidden/key.json" })]), oc([ocTool("read", { filePath: "/srv/forbidden-not/key.json" })]), "/srv/forbidden/key.json"],
	["Codex shell command", cx([cxItem({ type: "command_execution", command: "/bin/bash -lc 'curl https://example.invalid/almanac/x'" })]), cx([cxItem({ type: "command_execution", command: "/bin/bash -lc 'curl https://example.invalid/x'" })]), "https://example.invalid/almanac/x"],
	["Codex file read", cx([cxItem({ type: "command_execution", command: "cat ../../srv/forbidden/key.json" })], { workspace: "/work/ws" }), cx([cxItem({ type: "command_execution", command: "cat ../key.json" })]), "/srv/forbidden/key.json"],
	["Codex fetch tool", cx([cxItem({ type: "web_search", action: { type: "open_page", url: "https://example.invalid/almanac" } })]), cx([cxItem({ type: "web_search", action: { type: "open_page", url: "https://example.org/" } })]), "https://example.invalid/almanac"],
];
for (const [name, bad, good, what] of isolation) {
	test(`${name}: reaching a forbidden target is isolation, naming it; without it, valid`, () => {
		const v = classify(bad, FORBIDDEN);
		assert.equal(v.valid, false);
		if (!v.valid) { assert.equal(v.cause, "isolation"); assert.ok(v.detail.includes(what), v.detail); }
		assert.deepEqual(classify(good, FORBIDDEN), { valid: true });
	});
}

const causes: [string, Outcome, Outcome, string][] = [
	["opencode provider error", oc([{ type: "error", error: { name: "APIError", data: { message: "Bad Request: 400" } } }]), oc([]), "infrastructure"],
	["opencode content filter", oc([{ type: "error", error: { name: "ContentFilterError", data: { message: "blocked" } } }]), oc([]), "infrastructure"],
	["Codex provider error", cx([{ type: "error", message: "upstream returned 503 Service Unavailable" }]), cx([]), "infrastructure"],
	["Codex content filter", cx([{ type: "error", message: "The response was blocked by the content filter." }]), cx([]), "infrastructure"],
	["opencode timeout spent working", parseOpencode(lines([{ type: "step_start", part: {} }, { type: "step_finish", part: { reason: "tool-calls" } }, ocTool("bash", { command: "sleep 9" })]), { ...ctx, exit: null, signal: "SIGKILL", timedOut: true }), oc([]), "behaviour"],
	["Codex timeout spent working", parseCodex(lines([{ type: "turn.started" }, { type: "item.started", item: { id: "t", type: "command_execution", command: "sleep 9" } }]), { ...ctx, exit: null, signal: "SIGKILL", timedOut: true }), cx([]), "behaviour"],
	["opencode timeout waiting on the model", parseOpencode(lines([{ type: "step_start", part: {} }]), { ...ctx, exit: null, signal: "SIGKILL", timedOut: true }), oc([]), "infrastructure"],
	["Codex timeout waiting on the model", parseCodex(lines([{ type: "turn.started" }]), { ...ctx, exit: null, signal: "SIGKILL", timedOut: true }), cx([]), "infrastructure"],
	["opencode overflow", oc([{ type: "error", error: { name: "APIError", data: { message: "prompt is too long: 900000 tokens > 872000 maximum context" } } }]), oc([]), "behaviour"],
	["Codex overflow", cx([{ type: "turn.failed", error: { message: "Codex ran out of room in the model's context window." } }]), cx([]), "behaviour"],
	["no final message", parseOpencode(lines([{ type: "step_start", part: {} }, { type: "step_finish", part: { reason: "stop" } }]), ctx), oc([]), "behaviour"],
];
for (const [name, bad, good, cause] of causes) {
	test(`${name} is ${cause}; without it, valid`, () => {
		const v = classify(bad, FORBIDDEN);
		assert.equal(v.valid, false);
		if (!v.valid) assert.equal(v.cause, cause);
		assert.deepEqual(classify(good, FORBIDDEN), { valid: true });
	});
}

test("isolation is decided before any other cause", () => {
	const o = oc([ocTool("read", { filePath: "/srv/forbidden/key.json" }), { type: "error", error: { name: "APIError", data: { message: "500" } } }]);
	const v = classify(o, FORBIDDEN);
	assert.ok(!v.valid && v.cause === "isolation");
});
