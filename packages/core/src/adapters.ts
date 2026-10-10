// adapters - one runtime adapter per agent runtime (architecture section 5, principle P6).
//
// Everything that must be known about a runtime sits in its adapter: its configuration format,
// where it reads instructions, the rules files it loads, its delivery modes, the settings it can
// apply, its event shape, and its content-filter signal. The rest of the core speaks only the
// common form. Each driven adapter runs its runtime inside the filesystem sandbox, with a fresh
// configuration folder per invocation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComposedArm } from "./arm-composer.js";
import { scrub, type Outcome } from "./outcome.js";
import { parseCodex } from "./parse-codex.js";
import { parseOpencode } from "./parse-opencode.js";
import type { Member } from "./pack-schema.js";
import { runSandboxed, type SandboxResult } from "./runtime-sandbox.js";

export type DeliveryMode = "inline" | "attachment" | "stdin" | "file-pointer";

export interface Invocation {
	arm: ComposedArm;
	workspace: string;
	prompt: string;
	mode: DeliveryMode;
	member: Member;
	tools: "on" | "off";
	timeLimitSeconds: number;
	/** An empty folder for this invocation alone: configuration, home, events. */
	work: string;
}

export interface Adapter {
	runtime: string;
	rulesFiles: string[];
	modes: DeliveryMode[];
	network: "denied" | "detected";
	/** Why the invocation cannot run, or null; checked before anything runs. */
	refuse(inv: Invocation): string | null;
	invoke(inv: Invocation): Promise<Outcome>;
}

export class Refused extends Error {}

function prepare(inv: Invocation, adapter: Adapter): { home: string; instr: string } {
	const why = adapter.refuse(inv);
	if (why !== null) throw new Refused(why);
	if (fs.existsSync(inv.work) && fs.readdirSync(inv.work).length) throw new Refused(`${inv.work} is not empty`);
	const home = path.join(inv.work, "home");
	const instr = path.join(inv.work, "instructions");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(instr, { recursive: true });
	return { home, instr };
}

/** Copy the arm's instruction files into the invocation's own folder, numbered to keep their order. */
function copyInstructions(arm: ComposedArm, into: string): { name: string; path: string }[] {
	return arm.instructions.map((f, i) => {
		const name = path.basename(f.file);
		const p = path.join(into, `${String(i).padStart(2, "0")}-${name}`);
		fs.copyFileSync(f.path, p);
		return { name, path: p };
	});
}

function writeEvents(inv: Invocation, r: SandboxResult, secrets: string[]): string {
	const file = path.join(inv.work, "events.jsonl");
	fs.writeFileSync(file, r.lines.map((l) => scrub(l.text, secrets) + "\n").join(""));
	return file;
}

function scrubOutcome(o: Outcome, secrets: string[]): Outcome {
	return JSON.parse(scrub(JSON.stringify(o), secrets)) as Outcome;
}

const commonRefusals = (inv: Invocation, adapter: Adapter): string | null =>
	adapter.modes.includes(inv.mode) ? null : `delivery mode ${inv.mode} is not one ${adapter.runtime} supports (${adapter.modes.join(", ")})`;

// --- opencode -------------------------------------------------------------------------------------

export interface OpencodeOptions {
	/** The opencode binary; resolved from PATH if not given. */
	binary?: string;
	/** The operator's opencode configuration, whose provider block is copied. */
	operatorConfig?: string;
	/** The operator's opencode cache, copied fresh into each invocation. */
	operatorCache?: string;
	env?: NodeJS.ProcessEnv;
}

const OPENCODE_TOOLS = ["bash", "edit", "write", "read", "glob", "grep", "list", "patch", "webfetch", "websearch", "codesearch", "task", "todowrite", "todoread", "skill", "question", "lsp"];

function which(name: string, env: NodeJS.ProcessEnv): string {
	for (const d of (env["PATH"] ?? "").split(":")) {
		const p = path.join(d, name);
		if (d && fs.existsSync(p)) return fs.realpathSync(p);
	}
	throw new Error(`${name} is not on PATH`);
}

export function opencodeAdapter(opts: OpencodeOptions = {}): Adapter {
	const env = opts.env ?? process.env;
	const operatorConfig = opts.operatorConfig ?? path.join(env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "opencode", "opencode.json");
	const operatorCache = opts.operatorCache ?? path.join(os.homedir(), ".cache", "opencode");
	const provider = (): { block: Record<string, unknown>; credentialVars: string[]; variants: (model: string) => string[] } => {
		const c = JSON.parse(fs.readFileSync(operatorConfig, "utf8")) as { $schema?: string; provider?: Record<string, { options?: Record<string, unknown>; models?: Record<string, { variants?: Record<string, unknown> | string[] }> }> };
		const block = c.provider ?? {};
		const vars = [...JSON.stringify(block).matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
		const variants = (model: string): string[] => {
			const [prov, ...rest] = model.split("/");
			const v = block[prov ?? ""]?.models?.[rest.join("/")]?.variants;
			return Array.isArray(v) ? v : v ? Object.keys(v) : [];
		};
		return { block, credentialVars: [...new Set(vars)], variants };
	};
	const adapter: Adapter = {
		runtime: "opencode",
		rulesFiles: ["AGENTS.md", "CLAUDE.md"],
		modes: ["inline", "attachment"],
		network: "detected",
		refuse(inv) {
			const m = commonRefusals(inv, adapter);
			if (m) return m;
			for (const [k, v] of Object.entries(inv.member.settings ?? {})) {
				if (k !== "reasoningEffort") return `setting ${k} is not one opencode can apply`;
				if (!provider().variants(inv.member.model).includes(String(v))) return `setting reasoningEffort ${v} is not a variant of ${inv.member.model}`;
			}
			return null;
		},
		async invoke(inv) {
			const { home, instr } = prepare(inv, adapter);
			const p = provider();
			const xdg = path.join(inv.work, "config");
			for (const d of ["config/opencode", "data", "state", "cache"]) fs.mkdirSync(path.join(inv.work, d), { recursive: true });
			if (fs.existsSync(operatorCache)) fs.cpSync(operatorCache, path.join(inv.work, "cache", "opencode"), { recursive: true });
			const onRequest = inv.arm.onRequest.map((o) => o.path);
			const permission = inv.tools === "off"
				? Object.fromEntries(["edit", "bash", "read", "webfetch", "websearch", "task", "glob", "grep", "list", "external_directory"].map((k) => [k, "deny"]))
				: { edit: "allow", bash: "allow", read: "allow", webfetch: "deny", websearch: "deny", task: "deny", external_directory: onRequest.length ? Object.fromEntries([["*", "deny"], ...onRequest.map((o) => [`${o}/**`, "allow"])]) : "deny" };
			const config: Record<string, unknown> = { provider: p.block, plugin: [], permission, instructions: copyInstructions(inv.arm, instr).map((f) => f.path) };
			if (inv.tools === "off") config["tools"] = Object.fromEntries(OPENCODE_TOOLS.map((t) => [t, false]));
			if (inv.member.settings?.["reasoningEffort"] !== undefined) config["variant"] = inv.member.settings["reasoningEffort"];
			fs.writeFileSync(path.join(xdg, "opencode", "opencode.json"), JSON.stringify(config, null, 2));
			const binary = opts.binary ?? which("opencode", env);
			const args = ["run", "--format", "json", "-m", inv.member.model];
			if (inv.mode === "attachment") {
				const f = path.join(inv.work, "prompt.md");
				fs.writeFileSync(f, inv.prompt);
				args.push("--file", f, "--", "Read the attached file and follow it exactly.");
			} else args.push("--", inv.prompt);
			const secrets = p.credentialVars.map((v) => env[v] ?? "").filter(Boolean);
			const runEnv: Record<string, string> = {
				PATH: "/usr/bin:/bin", PWD: inv.workspace, HOME: home,
				XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: path.join(inv.work, "data"), XDG_STATE_HOME: path.join(inv.work, "state"), XDG_CACHE_HOME: path.join(inv.work, "cache"),
				OPENCODE_DISABLE_CLAUDE_CODE: "1",
			};
			for (const v of p.credentialVars) if (env[v] !== undefined) runEnv[v] = env[v]!;
			const r = await runSandboxed({ install: binary, writable: [inv.work, inv.workspace], readOnly: onRequest, home, cwd: inv.workspace, command: [binary, ...args], env: runEnv, stdin: null, timeLimitSeconds: inv.timeLimitSeconds });
			const events = writeEvents(inv, r, secrets);
			return scrubOutcome(parseOpencode(r.lines, { workspace: inv.workspace, home, exit: r.exit, signal: r.signal, timedOut: r.timedOut, seconds: r.seconds, events }), secrets);
		},
	};
	return adapter;
}

// --- Codex ----------------------------------------------------------------------------------------

export interface CodexOptions {
	/** Codex's vendored native directory, holding bin/codex; resolved from the codex on PATH if not given. */
	vendor?: string;
	/** The binary to run, inside vendor; bin/codex if not given. */
	binary?: string;
	/** The operator's Codex login, copied into each invocation. */
	auth?: string;
	/** Codex's model metadata, read for each model's supported reasoning efforts. */
	models?: string;
	env?: NodeJS.ProcessEnv;
}

function codexVendor(env: NodeJS.ProcessEnv): string {
	const js = which("codex", env);
	const pkg = path.dirname(path.dirname(js));
	const base = path.join(pkg, "node_modules", "@openai");
	for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
		const vendor = path.join(base, d, "vendor");
		if (!d.startsWith("codex-linux") || !fs.existsSync(vendor)) continue;
		for (const t of fs.readdirSync(vendor)) if (fs.existsSync(path.join(vendor, t, "bin", "codex"))) return path.join(vendor, t);
	}
	throw new Error(`no native Codex binary found under ${base}`);
}

const toml = (s: string): string => JSON.stringify(s);

/** Codex features that reach outside the sandbox or start other agents, each disabled. */
export const CODEX_FEATURES_OFF = ["apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "plugins", "remote_plugin", "multi_agent"];

export function codexAdapter(opts: CodexOptions = {}): Adapter {
	const env = opts.env ?? process.env;
	const auth = opts.auth ?? path.join(os.homedir(), ".codex", "auth.json");
	const modelsFile = opts.models ?? path.join(os.homedir(), ".codex", "models_cache.json");
	const efforts = (model: string): string[] => {
		if (!fs.existsSync(modelsFile)) return [];
		const d = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as { models?: { slug?: string; supported_reasoning_levels?: { effort?: string }[] }[] };
		const m = (d.models ?? []).find((x) => x.slug === model);
		return (m?.supported_reasoning_levels ?? []).map((l) => l.effort ?? "").filter(Boolean);
	};
	const adapter: Adapter = {
		runtime: "codex",
		rulesFiles: ["AGENTS.md", "AGENTS.override.md"],
		modes: ["inline", "stdin"],
		network: "denied",
		refuse(inv) {
			const m = commonRefusals(inv, adapter);
			if (m) return m;
			for (const [k, v] of Object.entries(inv.member.settings ?? {})) {
				if (k !== "reasoningEffort") return `setting ${k} is not one Codex can apply`;
				if (!efforts(inv.member.model).includes(String(v))) return `setting reasoningEffort ${v} is not supported by ${inv.member.model}`;
			}
			return null;
		},
		async invoke(inv) {
			const { home, instr } = prepare(inv, adapter);
			const codexHome = path.join(inv.work, "codex-home");
			fs.mkdirSync(codexHome);
			fs.copyFileSync(auth, path.join(codexHome, "auth.json"));
			fs.chmodSync(path.join(codexHome, "auth.json"), 0o600);
			const files = copyInstructions(inv.arm, instr);
			const dev = files.map((f) => `<file name="${f.name}">\n${fs.readFileSync(f.path, "utf8")}</file>`).join("\n\n");
			const lines = ['approval_policy = "never"', 'web_search = "disabled"', "project_doc_fallback_filenames = []"];
			if (dev) lines.push(`developer_instructions = ${toml(dev)}`);
			const effort = inv.member.settings?.["reasoningEffort"];
			if (effort !== undefined) lines.push(`model_reasoning_effort = ${toml(String(effort))}`);
			// Hosted tools reach the web outside the sandbox: a live check found Codex opening a page
			// through its apps connector with web search disabled. Each is switched off by name.
			lines.push("", "[features]", ...CODEX_FEATURES_OFF.map((f) => `${f} = false`));
			fs.writeFileSync(path.join(codexHome, "config.toml"), lines.join("\n") + "\n");
			const vendor = opts.vendor ?? codexVendor(env);
			const binary = opts.binary ?? path.join(vendor, "bin", "codex");
			const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--strict-config", "--ignore-rules", "-m", inv.member.model, "--sandbox", inv.tools === "off" ? "read-only" : "workspace-write", "-C", inv.workspace];
			args.push(inv.mode === "stdin" ? "-" : inv.prompt);
			// With tools off the agent's shell remains, so its workspace is an empty folder of its own.
			const workspace = inv.tools === "off" ? fs.mkdtempSync(path.join(inv.work, "empty-")) : inv.workspace;
			if (inv.tools === "off") args[args.indexOf(inv.workspace)] = workspace;
			const secrets = authSecrets(auth);
			const r = await runSandboxed({
				install: vendor, writable: inv.tools === "off" ? [inv.work] : [inv.work, inv.workspace], readOnly: inv.arm.onRequest.map((o) => o.path), home, cwd: workspace,
				command: [binary, ...args], env: { PATH: "/usr/bin:/bin", PWD: workspace, HOME: home, CODEX_HOME: codexHome }, stdin: inv.mode === "stdin" ? inv.prompt : null, timeLimitSeconds: inv.timeLimitSeconds,
			});
			const events = writeEvents(inv, r, secrets);
			return scrubOutcome(parseCodex(r.lines, { workspace, home, exit: r.exit, signal: r.signal, timedOut: r.timedOut, seconds: r.seconds, events }), secrets);
		},
	};
	return adapter;
}

/** Every long string in the login file, removed from anything written. */
function authSecrets(file: string): string[] {
	if (!fs.existsSync(file)) return [];
	const out: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === "string" && v.length >= 20) out.push(v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
	};
	try { walk(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* not JSON: nothing to remove */ }
	return out;
}

// --- external -------------------------------------------------------------------------------------

export interface ExternalOptions {
	/** How often to look for the answer, in milliseconds. */
	pollMs?: number;
}

/**
 * Hands the prompt to a harness context-lab does not drive: writes it, with the arm's instructions
 * and on-request folders, into the invocation's folder, and waits for an answer file there.
 */
export function externalAdapter(opts: ExternalOptions = {}): Adapter {
	const adapter: Adapter = {
		runtime: "external",
		rulesFiles: [],
		modes: ["file-pointer"],
		network: "detected",
		refuse(inv) {
			const m = commonRefusals(inv, adapter);
			if (m) return m;
			const keys = Object.keys(inv.member.settings ?? {});
			return keys.length ? `setting ${keys[0]} is not one an external harness can be given` : null;
		},
		async invoke(inv) {
			const { instr } = prepare(inv, adapter);
			copyInstructions(inv.arm, instr);
			fs.writeFileSync(path.join(inv.work, "prompt.md"), inv.prompt);
			fs.writeFileSync(path.join(inv.work, "on-request.txt"), inv.arm.onRequest.map((o) => o.path + "\n").join(""));
			fs.writeFileSync(path.join(inv.work, "workspace.txt"), inv.workspace + "\n");
			const answer = path.join(inv.work, "answer.md");
			const started = Date.now();
			while (!fs.existsSync(answer) && Date.now() - started < inv.timeLimitSeconds * 1000) await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
			const got = fs.existsSync(answer);
			const events = path.join(inv.work, "events.jsonl");
			fs.writeFileSync(events, "");
			return {
				final: got ? fs.readFileSync(answer, "utf8") : "",
				exit: got ? 0 : null,
				signal: null,
				stop: { reason: got ? "completed" : "timeout", inFlight: "none" },
				cost: { seconds: (Date.now() - started) / 1000, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 },
				tools: [], filtered: false, error: null, session: null, trace: [], events,
			};
		},
	};
	return adapter;
}
