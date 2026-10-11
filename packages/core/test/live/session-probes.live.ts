// Live probes of session continuation and compaction (Delta-2 criteria F1 and F2), on both driven
// runtimes, inside the filesystem sandbox. Calls real models. Writes a record of what it found -
// extracted results only, never raw events - and removes everything else it made.
//
// Usage: node packages/core/dist/test/live/session-probes.live.js <record.json>
//
// For each runtime:
//   continuation  invocation 1 is given a token; invocation 2, in its own folder holding only a
//                 copy of invocation 1's session store and in the same workspace - which a resumed
//                 session needs, opencode running it in the directory it began in - is asked for
//                 the token, the workspace checked first to hold no copy of it; invocation 3, in another folder with its own empty
//                 store, tries to resume the same session.
//   compaction    the session is compacted on demand - opencode through its server's summarize
//                 route, Codex through its app-server's thread/compact/start - then resumed and
//                 asked for the canary planted in an instruction file and never quoted before.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CANARY_QUESTION, codexVendor, runSandboxed, sandboxMounts, scrub, which, type SandboxSpec } from "../../src/index.js";

const out = process.argv[2];
if (!out) { console.error("usage: session-probes <record.json>"); process.exit(2); }
const TOKEN = "KESTREL-4471";
const CANARY = "The owl keeps the gate key.";
const base = fs.mkdtempSync(path.join(os.homedir(), ".context-lab-probe-"));
const env = process.env;
const secrets: string[] = [];

function lines(text: string): unknown[] {
	return text.split("\n").flatMap((l) => { try { return [JSON.parse(l) as unknown]; } catch { return []; } });
}
const finalOf = (evs: unknown[], runtime: string): string => {
	if (runtime === "opencode") {
		const byMsg = new Map<string, string>();
		for (const e of evs as { type?: string; part?: { messageID?: string; text?: string } }[]) if (e.type === "text" && e.part?.messageID) byMsg.set(e.part.messageID, (byMsg.get(e.part.messageID) ?? "") + (e.part.text ?? ""));
		return [...byMsg.values()].pop() ?? "";
	}
	let f = "";
	for (const e of evs as { type?: string; item?: { type?: string; text?: string } }[]) if (e.type === "item.completed" && e.item?.type === "agent_message") f = e.item.text ?? "";
	return f;
};
const errorOf = (evs: unknown[]): string | null => {
	for (const e of evs as { type?: string; error?: { name?: string; message?: string; data?: { message?: string } }; message?: string }[]) {
		if (e.type === "error" || e.type === "turn.failed") return `${e.error?.name ?? ""} ${e.error?.data?.message ?? e.error?.message ?? e.message ?? ""}`.trim();
	}
	return null;
};

function holdsToken(dir: string): boolean {
	return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).some((e) => e.isFile() && fs.readFileSync(path.join(e.parentPath, e.name), "utf8").includes(TOKEN));
}

function workspace(name: string): string {
	const w = path.join(base, "spaces", name);
	fs.mkdirSync(w, { recursive: true });
	return w;
}

// --- opencode -----------------------------------------------------------------------------------

const ocBinary = which("opencode", env);
const ocConfig = JSON.parse(fs.readFileSync(path.join(env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "opencode", "opencode.json"), "utf8")) as { provider: Record<string, unknown> };
const ocVars = [...JSON.stringify(ocConfig.provider).matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
for (const v of ocVars) if (env[v]) secrets.push(env[v]!);

function ocFolder(name: string, withCanary: boolean, sessionFrom?: string): string {
	const f = path.join(base, "oc", name);
	for (const d of ["config/opencode", "data", "state", "home", "instructions"]) fs.mkdirSync(path.join(f, d), { recursive: true });
	fs.cpSync(path.join(os.homedir(), ".cache", "opencode"), path.join(f, "cache", "opencode"), { recursive: true });
	const instructions: string[] = [];
	if (withCanary) { const c = path.join(f, "instructions", "context-lab-canary.md"); fs.writeFileSync(c, `${CANARY}\n`); instructions.push(c); }
	fs.writeFileSync(path.join(f, "config", "opencode", "opencode.json"), JSON.stringify({ provider: ocConfig.provider, plugin: [], instructions, permission: { edit: "allow", bash: "allow", read: "allow", webfetch: "deny", websearch: "deny", task: "deny", external_directory: "deny" } }));
	if (sessionFrom) fs.cpSync(path.join(sessionFrom, "data"), path.join(f, "data"), { recursive: true });
	return f;
}
function ocEnv(f: string, ws: string): Record<string, string> {
	const e: Record<string, string> = { PATH: "/usr/bin:/bin", PWD: ws, HOME: path.join(f, "home"), XDG_CONFIG_HOME: path.join(f, "config"), XDG_DATA_HOME: path.join(f, "data"), XDG_STATE_HOME: path.join(f, "state"), XDG_CACHE_HOME: path.join(f, "cache"), OPENCODE_DISABLE_CLAUDE_CODE: "1" };
	for (const v of ocVars) if (env[v] !== undefined) e[v] = env[v]!;
	return e;
}
async function ocRun(f: string, ws: string, args: string[]): Promise<unknown[]> {
	const spec: SandboxSpec = { install: ocBinary, writable: [f, ws], readOnly: [], home: path.join(f, "home"), cwd: ws, command: [ocBinary, "run", "--format", "json", "-m", "litellm-netbird/claude-opus-5-5", ...args], env: ocEnv(f, ws), stdin: null, timeLimitSeconds: 300 };
	return (await runSandboxed(spec)).lines.map((l) => { try { return JSON.parse(l.text) as unknown; } catch { return null; } }).filter(Boolean);
}
function background(spec: SandboxSpec, stdin: "pipe" | "ignore"): ChildProcess {
	return spawn("bwrap", [...sandboxMounts(spec), ...spec.command], { env: spec.env, stdio: [stdin, "pipe", "pipe"] });
}

async function probeOpencode(): Promise<Record<string, unknown>> {
	const r: Record<string, unknown> = { runtime: "opencode", model: "litellm-netbird/claude-opus-5-5" };
	const f1 = ocFolder("inv1", true), w1 = workspace("oc1");
	const e1 = await ocRun(f1, w1, ["--", `Remember this token: ${TOKEN}. Reply only OK.`]);
	const sid = (e1 as { sessionID?: string }[]).find((e) => e.sessionID)?.sessionID ?? null;
	r["session"] = sid !== null;
	const f2 = ocFolder("inv2", true, f1), w2 = w1;
	r["workspaceHoldsToken"] = holdsToken(w1);
	const e2 = sid ? await ocRun(f2, w2, ["-s", sid, "--", "What token did I ask you to remember? Reply with the token only."]) : [];
	r["invocation2"] = { reply: finalOf(e2, "opencode").slice(0, 200), error: errorOf(e2), recalled: finalOf(e2, "opencode").includes(TOKEN) };
	const f3 = ocFolder("inv3", true), w3 = workspace("oc3");
	const e3 = sid ? await ocRun(f3, w3, ["-s", sid, "--", "What token did I ask you to remember? Reply with the token only."]) : [];
	r["invocation3"] = { reply: finalOf(e3, "opencode").slice(0, 200), error: errorOf(e3), recalled: finalOf(e3, "opencode").includes(TOKEN) };
	r["continuationWorks"] = !r["workspaceHoldsToken"] && (r["invocation2"] as { recalled: boolean }).recalled && !(r["invocation3"] as { recalled: boolean }).recalled;

	// Compaction, through the server's summarize route, inside the sandbox.
	const f4 = ocFolder("inv4", true, f2), w4 = w1;
	const port = 40000 + Math.floor(Math.random() * 20000);
	const server = background({ install: ocBinary, writable: [f4, w4], readOnly: [], home: path.join(f4, "home"), cwd: w4, command: [ocBinary, "serve", "--port", String(port), "--hostname", "127.0.0.1"], env: ocEnv(f4, w4), stdin: null, timeLimitSeconds: 600 }, "ignore");
	try {
		let up = false;
		for (let i = 0; i < 60 && !up; i++) { await new Promise((res) => setTimeout(res, 1000)); try { up = (await fetch(`http://127.0.0.1:${port}/session`)).ok; } catch { /* not yet */ } }
		r["compactionCommand"] = "opencode serve, then POST /session/<id>/summarize";
		const resp = up && sid ? await fetch(`http://127.0.0.1:${port}/session/${sid}/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerID: "litellm-netbird", modelID: "claude-opus-5-5" }), signal: AbortSignal.timeout(300000) }) : null;
		const msgs = up && sid ? (await (await fetch(`http://127.0.0.1:${port}/session/${sid}/message`)).json()) as { info: { summary?: boolean } }[] : [];
		r["compacted"] = resp?.ok === true && msgs.some((m) => m.info.summary === true);
	} finally {
		server.kill("SIGKILL");
	}
	const e5 = sid && r["compacted"] ? await ocRun(f4, w4, ["-s", sid, "--", CANARY_QUESTION]) : [];
	r["afterCompaction"] = { reply: finalOf(e5, "opencode").slice(0, 200), error: errorOf(e5), canaryQuoted: finalOf(e5, "opencode").includes(CANARY) };
	return r;
}

// --- Codex --------------------------------------------------------------------------------------

const vendor = codexVendor(env);
const cxBinary = path.join(vendor, "bin", "codex");
const auth = path.join(os.homedir(), ".codex", "auth.json");
const walk = (v: unknown): void => { if (typeof v === "string" && v.length >= 20) secrets.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
walk(JSON.parse(fs.readFileSync(auth, "utf8")));

function cxFolder(name: string, sessionFrom?: string): string {
	const f = path.join(base, "cx", name);
	const home = path.join(f, "codex-home");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(f, "home"), { recursive: true });
	fs.copyFileSync(auth, path.join(home, "auth.json"));
	fs.chmodSync(path.join(home, "auth.json"), 0o600);
	const dev = `<file name="context-lab-canary.md">\n${CANARY}\n</file>`;
	fs.writeFileSync(path.join(home, "config.toml"), ['approval_policy = "never"', 'web_search = "disabled"', "project_doc_fallback_filenames = []", 'sandbox_mode = "read-only"', `developer_instructions = ${JSON.stringify(dev)}`, ""].join("\n"));
	if (sessionFrom) fs.cpSync(path.join(sessionFrom, "codex-home", "sessions"), path.join(home, "sessions"), { recursive: true });
	return f;
}
const cxEnv = (f: string, ws: string): Record<string, string> => ({ PATH: "/usr/bin:/bin", PWD: ws, HOME: path.join(f, "home"), CODEX_HOME: path.join(f, "codex-home") });
async function cxRun(f: string, ws: string, args: string[]): Promise<unknown[]> {
	const spec: SandboxSpec = { install: vendor, writable: [f, ws], readOnly: [], home: path.join(f, "home"), cwd: ws, command: [cxBinary, ...args], env: cxEnv(f, ws), stdin: null, timeLimitSeconds: 300 };
	return (await runSandboxed(spec)).lines.map((l) => { try { return JSON.parse(l.text) as unknown; } catch { return null; } }).filter(Boolean);
}
const cxCommon = ["--json", "--skip-git-repo-check", "--strict-config", "--ignore-rules", "-m", "gpt-6-astra"];

async function probeCodex(): Promise<Record<string, unknown>> {
	const r: Record<string, unknown> = { runtime: "codex", model: "gpt-6-astra" };
	const f1 = cxFolder("inv1"), w1 = workspace("cx1");
	const e1 = await cxRun(f1, w1, ["exec", ...cxCommon, "-C", w1, `Remember this token: ${TOKEN}. Reply only OK.`]);
	const tid = (e1 as { type?: string; thread_id?: string }[]).find((e) => e.type === "thread.started")?.thread_id ?? null;
	r["session"] = tid !== null;
	const ask = "What token did I ask you to remember? Reply with the token only.";
	const f2 = cxFolder("inv2", f1), w2 = w1;
	r["workspaceHoldsToken"] = holdsToken(w1);
	const e2 = tid ? await cxRun(f2, w2, ["exec", "resume", ...cxCommon, tid, ask]) : [];
	r["invocation2"] = { reply: finalOf(e2, "codex").slice(0, 200), error: errorOf(e2), recalled: finalOf(e2, "codex").includes(TOKEN) };
	const f3 = cxFolder("inv3"), w3 = workspace("cx3");
	const e3 = tid ? await cxRun(f3, w3, ["exec", "resume", ...cxCommon, tid, ask]) : [];
	r["invocation3"] = { reply: finalOf(e3, "codex").slice(0, 200), error: errorOf(e3), recalled: finalOf(e3, "codex").includes(TOKEN) };
	r["continuationWorks"] = !r["workspaceHoldsToken"] && (r["invocation2"] as { recalled: boolean }).recalled && !(r["invocation3"] as { recalled: boolean }).recalled;

	// Compaction, through the app-server's thread/compact/start, inside the sandbox.
	const f4 = cxFolder("inv4", f2), w4 = w1;
	r["compactionCommand"] = "codex app-server: thread/resume, then thread/compact/start";
	const srv = background({ install: vendor, writable: [f4, w4], readOnly: [], home: path.join(f4, "home"), cwd: w4, command: [cxBinary, "app-server"], env: cxEnv(f4, w4), stdin: null, timeLimitSeconds: 600 }, "pipe");
	try {
		let id = 0, buf = "";
		const pending = new Map<number, (m: unknown) => void>();
		const notes: string[] = [];
		srv.stdout!.on("data", (d: Buffer) => {
			buf += d.toString();
			let n: number;
			while ((n = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, n); buf = buf.slice(n + 1);
				let m: { id?: number; method?: string };
				try { m = JSON.parse(line) as { id?: number; method?: string }; } catch { continue; }
				if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else if (m.method) notes.push(m.method);
			}
		});
		const send = (method: string, params: unknown): Promise<unknown> => new Promise((res) => { const i = ++id; pending.set(i, res); srv.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
		await send("initialize", { clientInfo: { name: "context-lab", version: "0" } });
		srv.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
		const resumed = tid ? await send("thread/resume", { threadId: tid }) as { result?: unknown } : {};
		const started = tid ? await send("thread/compact/start", { threadId: tid }) as { result?: unknown } : {};
		const t0 = Date.now();
		while (Date.now() - t0 < 240000 && !notes.includes("turn/completed")) await new Promise((res) => setTimeout(res, 500));
		r["compacted"] = resumed.result !== undefined && started.result !== undefined && notes.includes("turn/completed");
	} finally {
		srv.kill("SIGKILL");
	}
	const e5 = tid && r["compacted"] ? await cxRun(f4, w4, ["exec", "resume", ...cxCommon, tid, CANARY_QUESTION]) : [];
	r["afterCompaction"] = { reply: finalOf(e5, "codex").slice(0, 200), error: errorOf(e5), canaryQuoted: finalOf(e5, "codex").includes(CANARY) };
	return r;
}

const versions = { opencode: (await runSandboxed({ install: ocBinary, writable: [], readOnly: [], home: path.join(base, "h"), cwd: "/tmp", command: [ocBinary, "--version"], env: { PATH: "/usr/bin:/bin" }, stdin: null, timeLimitSeconds: 30 })).lines.map((l) => l.text).join("").trim() };
const record = { probedAt: new Date().toISOString(), sandbox: "bubblewrap filesystem sandbox, network shared", versions, results: [await probeOpencode(), await probeCodex()] };
fs.writeFileSync(out, scrub(JSON.stringify(record, null, 2), secrets) + "\n");
for (const r of record.results) console.log(JSON.stringify(r));
fs.rmSync(base, { recursive: true, force: true });
