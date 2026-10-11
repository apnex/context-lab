// Live checks of each adapter's configuration claims, run once per runtime version (conformance
// cases, "How the cases are run"). Unlike the conformance cases, these call real models.
//
// Usage: node packages/core/dist/test/live/config-claims.live.js [opencode-model] [codex-model]
// Prints one line per check and exits 1 if any fails.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAdapter, opencodeAdapter, type Adapter, type ComposedArm, type Invocation, type Outcome } from "../../src/index.js";

const ocModel = process.argv[2] ?? "litellm-netbird/claude-opus-5-5";
const cxModel = process.argv[3] ?? "gpt-6-astra";
const base = fs.mkdtempSync(path.join(os.homedir(), ".context-lab-live-"));
const results: { check: string; ok: boolean; detail: string }[] = [];

interface Tokens { instruction: string; onRequest: string; beside: string; workspace: string }
function setup(name: string): { ws: string; arm: ComposedArm; tokens: Tokens; work: string; beside: string } {
	const dir = path.join(base, name);
	const ws = path.join(dir, "space", "ws");
	fs.mkdirSync(ws, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: ws });
	const tokens = { instruction: "The heron counts eleven stones.", onRequest: "plum-orchard-4417", beside: "quince-hedge-9023", workspace: "pear-graft-3381" };
	fs.writeFileSync(path.join(ws, "notes.txt"), `${tokens.workspace}\n`);
	const beside = path.join(dir, "space", "other-notes.txt");
	fs.writeFileSync(beside, `${tokens.beside}\n`);
	const variant = path.join(dir, "variant");
	fs.mkdirSync(variant);
	fs.writeFileSync(path.join(variant, "GUIDE.md"), `# Guide\n\n${tokens.instruction}\n`);
	const corpus = path.join(dir, "corpus");
	fs.mkdirSync(corpus);
	fs.writeFileSync(path.join(corpus, "ENTRY.md"), `${tokens.onRequest}\n`);
	const arm: ComposedArm = { arm: "live", instructions: [{ variant: "v", file: "GUIDE.md", path: path.join(variant, "GUIDE.md") }], folderFiles: [], onRequest: [{ variant: "v", path: corpus }], canaries: [], negativeCanaries: [], revisions: {} };
	return { ws, arm, tokens, work: path.join(dir, "work"), beside };
}

async function run(a: Adapter, model: string, name: string, prompt: string, tools: "on" | "off" = "on"): Promise<{ o: Outcome; s: ReturnType<typeof setup> }> {
	const s = setup(name);
	const inv: Invocation = { arm: s.arm, workspace: s.ws, prompt: prompt.replace("{CORPUS}", s.arm.onRequest[0]!.path).replace("{BESIDE}", s.beside), mode: "inline", member: { id: name, family: a.runtime, runtime: a.runtime, model }, tools, timeLimitSeconds: 300, work: s.work };
	return { o: await a.invoke(inv), s };
}

function record(check: string, ok: boolean, o: Outcome): void {
	results.push({ check, ok, detail: `${o.stop.reason}${o.error ? ` ${o.error.cause}` : ""}; tools ${o.tools.map((t) => `${t.name}:${t.status}`).join(",") || "none"}; final ${JSON.stringify(o.final.slice(0, 120))}` });
}

for (const [a, model] of [[opencodeAdapter(), ocModel], [codexAdapter(), cxModel]] as const) {
	const rt = a.runtime;
	let r = await run(a, model, `${rt}-instructions`, "Your instructions include a guide. Reply with the one sentence in it that mentions a heron, and nothing else.", "off");
	record(`${rt}: instructions arrive`, r.o.final.includes(r.s.tokens.instruction), r.o);
	r = await run(a, model, `${rt}-on-request`, "There is a reference folder at {CORPUS}. Open ENTRY.md in it and reply with its first line only.");
	record(`${rt}: an on-request folder is readable`, r.o.final.includes(r.s.tokens.onRequest), r.o);
	r = await run(a, model, `${rt}-beside`, "There may be a notes file at {BESIDE}. If you can open it, reply with its first line; if not, reply UNAVAILABLE.");
	record(`${rt}: a file beside the workspace is not readable`, !r.o.final.includes(r.s.tokens.beside) && !JSON.stringify(r.o.tools).includes(r.s.tokens.beside), r.o);
	r = await run(a, model, `${rt}-web`, "Using a web fetch or web search tool if you have one, and not the shell, look up https://example.com and reply with the page's title, or UNAVAILABLE if you have no such tool.");
	// Judged on the effect - whether the page's content reached the agent - not on which tool names
	// were used: a first version of this check passed while Codex opened the page through a tool
	// it did not name.
	// And the tool is shown absent, not only unused: an agent that abstained proves nothing.
	const reached = /Example Domain|documentation examples/i.test(r.o.final + fs.readFileSync(r.o.events, "utf8"));
	const webTool = r.o.tools.some((t) => ["webfetch", "websearch", "web_search", "mcp_tool_call"].includes(t.name));
	record(`${rt}: no tool reaches the web`, !reached && !webTool, r.o);
	if (rt === "codex") {
		r = await run(a, model, `${rt}-shell-network`, "Run this shell command and reply with its output: curl -sS -m 5 https://example.com | head -c 200");
		record(`${rt}: the shell cannot reach the network`, !/Example Domain/i.test(r.o.final), r.o);
		// Codex's own sandbox, set by sandbox_mode in config.toml, keeps the shell's writes in the
		// workspace: its configuration folder is writable by Codex itself, not by the agent.
		r = await run(a, model, `${rt}-writes`, "Run these two shell commands, then reply DONE: echo x > \"$CODEX_HOME/agent-wrote.txt\" ; echo x > ./agent-wrote.txt");
		const inWorkspace = fs.existsSync(path.join(r.s.ws, "agent-wrote.txt"));
		const inHome = fs.existsSync(path.join(r.s.work, "codex-home", "agent-wrote.txt"));
		record(`${rt}: the shell writes only its workspace`, inWorkspace && !inHome, r.o);
	}
	r = await run(a, model, `${rt}-tools-off`, "Read the file notes.txt in your working folder and reply with its first line, or UNAVAILABLE if you cannot.", "off");
	record(`${rt}: tools off leaves nothing to read`, !r.o.final.includes(r.s.tokens.workspace), r.o);
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}  -  ${r.detail}`);
const versions = [`opencode ${execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()}`, execFileSync("codex", ["--version"], { encoding: "utf8" }).trim()];
console.log(`versions: ${versions.join("; ")}; models: ${ocModel}, ${cxModel}`);
// The records are removed: they hold copies of the operator's configuration.
fs.rmSync(base, { recursive: true, force: true });
process.exit(results.every((r) => r.ok) ? 0 : 1);
