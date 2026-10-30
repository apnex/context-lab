// adapters - one runtime adapter per agent runtime (architecture section 5, principle P6).
//
// Everything that must be known about a runtime sits in its adapter: its configuration format,
// where it reads instructions, the rules files it loads, its delivery modes, the settings it can
// apply, its event shape, and its content-filter signal. The rest of the core speaks only the
// common form. Each driven adapter runs its runtime inside the filesystem sandbox, with a fresh
// configuration folder per invocation.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComposedArm } from "./arm-composer.js";
import { scrub, type Outcome } from "./outcome.js";
import { parseCodex } from "./parse-codex.js";
import { parseOpencode } from "./parse-opencode.js";
import type { Member } from "./pack-schema.js";
import { runSandboxed, type SandboxResult, type SandboxSpec } from "./runtime-sandbox.js";

export type DeliveryMode = "inline" | "attachment" | "stdin" | "file-pointer";

export type InvocationRole = "readerProbe" | "judgeProbe" | "reader" | "judge";

export interface InvocationRefusalRecord {
	role: InvocationRole;
	work: string;
	reason: "input-bytes" | "budget-exhausted" | "adapter-refused";
	message: string;
	controlledInputBytes?: number;
	maxInputBytes?: number;
}

export interface InvocationSummary {
	maxTotalInvocations: number | null;
	dispatchedTotal: number;
	dispatchedByRole: Record<InvocationRole, number>;
	refusedPreDispatch: InvocationRefusalRecord[];
	exhausted: boolean;
}

/** Shared pre-dispatch invocation counter and ceiling for a run (0040, B30). */
export class InvocationBudget {
	private nextId = 1;
	private readonly byRole: Record<InvocationRole, number> = { readerProbe: 0, judgeProbe: 0, reader: 0, judge: 0 };
	private readonly refusals: InvocationRefusalRecord[] = [];
	private hitCeiling = false;

	constructor(public readonly maxTotalInvocations: number | null = null, seed?: InvocationSummary) {
		if (seed) {
			this.nextId = seed.dispatchedTotal + 1;
			this.byRole.readerProbe = seed.dispatchedByRole.readerProbe ?? 0;
			this.byRole.judgeProbe = seed.dispatchedByRole.judgeProbe ?? 0;
			this.byRole.reader = seed.dispatchedByRole.reader ?? 0;
			this.byRole.judge = seed.dispatchedByRole.judge ?? 0;
			this.refusals.push(...(seed.refusedPreDispatch ?? []));
			this.hitCeiling = seed.exhausted ?? false;
		}
	}

	reserve(role: InvocationRole, work: string): number {
		const total = this.dispatchedTotal();
		if (this.maxTotalInvocations !== null && total >= this.maxTotalInvocations) {
			this.hitCeiling = true;
			const msg = `maxTotalInvocations (${this.maxTotalInvocations}) reached before dispatching ${role} at ${work}`;
			this.refusals.push({ role, work, reason: "budget-exhausted", message: msg });
			throw new BudgetExhausted(msg);
		}
		this.byRole[role] += 1;
		return this.nextId++;
	}

	recordRefusal(rec: InvocationRefusalRecord): void {
		this.refusals.push(rec);
		if (rec.reason === "budget-exhausted") this.hitCeiling = true;
	}

	dispatchedTotal(): number {
		return this.byRole.readerProbe + this.byRole.judgeProbe + this.byRole.reader + this.byRole.judge;
	}

	isExhausted(): boolean {
		return this.hitCeiling || (this.maxTotalInvocations !== null && this.dispatchedTotal() >= this.maxTotalInvocations);
	}

	summary(): InvocationSummary {
		return {
			maxTotalInvocations: this.maxTotalInvocations,
			dispatchedTotal: this.dispatchedTotal(),
			dispatchedByRole: { ...this.byRole },
			refusedPreDispatch: [...this.refusals],
			exhausted: this.hitCeiling,
		};
	}
}

export class BudgetExhausted extends Error {}

export interface Invocation {
	arm: ComposedArm;
	workspace: string;
	prompt: string;
	mode: DeliveryMode;
	member: Member;
	tools: "on" | "off";
	/** When true (requires tools: "on"), permits local socket creation in runtimes whose workspace sandbox blocks it (Codex). */
	sockets?: boolean;
	/** Optional additional writable directories inside the sandbox (e.g. a per-attempt scratch/dependency-cache directory outside the retained workspace). */
	extraWritable?: string[];
	/** Optional environment variables passed into the sandboxed runtime (e.g. npm_config_cache / TMPDIR). */
	extraEnv?: Record<string, string>;
	/** Optional AbortSignal passed to runSandboxed so an active storage monitor can kill the sandbox immediately (0046, B31). */
	signal?: AbortSignal;
	timeLimitSeconds: number;
	/** Optional pre-dispatch UTF-8 byte ceiling on evaluator-controlled input (prompt + wrapper + delivered instructions and folderFiles). */
	maxInputBytes?: number;
	/** Optional UTF-8 byte ceiling on child stdout captured per runtime invocation before SIGKILL and overflow marking. */
	maxStdoutBytes?: number;
	/** Optional role for InvocationBudget accounting. */
	role?: InvocationRole;
	/** Optional shared InvocationBudget that reserves an invocationId before spawning the runtime. */
	budget?: InvocationBudget;
	/** An empty folder for this invocation alone: configuration, home, events. */
	work: string;
	/** Continue an earlier invocation's session: its id, its folder, and its workspace, which this invocation must share. */
	continueFrom?: { session: string; work: string; workspace: string };
}

export interface Compaction {
	onDemand: boolean;
	instructionsAfterCompaction: "when delivered again" | "carried by the session" | "unknown";
}

export interface Adapter {
	runtime: string;
	/** The runtime's version, for the run record; null if it cannot be read. */
	version?(): string | null;
	rulesFiles: string[];
	modes: DeliveryMode[];
	network: "denied" | "detected";
	/** Whether the runtime runs in the filesystem sandbox, so a path it was not given does not exist for it. */
	filesystem: "sandboxed" | "open";
	/** Whether an invocation may continue an earlier one's session, and what was probed of compaction (docs/probes). */
	continue: boolean;
	compaction: Compaction;
	/** Why the invocation cannot run, or null; checked before anything runs. */
	refuse(inv: Invocation): string | null;
	invoke(inv: Invocation): Promise<Outcome>;
	/**
	 * Prepares an invocation as invoke would - the same files written into inv.work, the same command,
	 * environment and mounts - without running the runtime, reading a credential or copying the
	 * runtime's cache (B20). What it could not render is listed, never filled in.
	 */
	prepare?(inv: Invocation): PreparedInvocation;
	/**
	 * How a member's requests reach its model - the client package, endpoint and model settings the
	 * runtime is given - for the run record, so two runs that reached a model differently are not
	 * compared as alike. Credentials and headers are left out.
	 */
	route?(member: Member): Record<string, unknown>;
}

export class Refused extends Error {}

/** A file an invocation writes for its runtime to read. */
export interface PreparedFile {
	/** Its path, under the invocation's folder. */
	path: string;
	/** What it is for the runtime. */
	role: string;
	/** UTF-8 bytes, and the text; text is null where the file holds a credential and is not rendered. */
	bytes: number | null;
	text: string | null;
}

/** What an invocation hands its runtime, as invoke would, rendered without running it (B20). */
export interface PreparedInvocation {
	runtime: string;
	/** The command, binary first, as the sandbox runs it. */
	command: string[];
	/** The environment; a credential's value is replaced by `<credential: NAME>`. */
	env: Record<string, string>;
	stdin: string | null;
	cwd: string;
	/** What the sandbox mounts: the runtime's installation read-only, these read-write, these read-only. */
	mounts: { install: string; writable: string[]; readOnly: string[] };
	/** The prompt, how it is delivered, and the fixed text sent beside it, if any. */
	prompt: { text: string; delivery: DeliveryMode; wrapper: string | null; bytes: number };
	/** Total UTF-8 bytes of evaluator-controlled prepared input (prompt + wrapper + delivered instructions and folderFiles). */
	controlledInputBytes?: number;
	files: PreparedFile[];
	/** What a live invocation adds that this rendering does not: copies of credentials and caches, a continued session. */
	notRendered: string[];
	/** Context the runtime itself adds, which context-lab neither controls nor sees. */
	outsideControl: string[];
}

const fileOf = (p: string, role: string): PreparedFile => { const text = fs.readFileSync(p, "utf8"); return { path: p, role, bytes: Buffer.byteLength(text, "utf8"), text }; };

/**
 * Computes the UTF-8 byte count of all evaluator-controlled input prepared for an invocation:
 * the prompt text, any adapter attachment wrapper, all delivered instruction files (as written
 * into the invocation's configuration or instruction directory), and when tools are on, any
 * arm-delivered workspace folderFiles (`inv.arm.folderFiles`). Excludes runtime base prompts,
 * tool schemas, and provider framing (`outsideControl`).
 */
export function measureControlledInputBytes(inv: Invocation, instructionBytes: number, wrapper: string | null): number {
	const promptBytes = Buffer.byteLength(inv.prompt, "utf8");
	const wrapperBytes = wrapper ? Buffer.byteLength(wrapper, "utf8") : 0;
	let folderFileBytes = 0;
	if (inv.tools === "on") {
		for (const f of inv.arm.folderFiles) {
			if (fs.existsSync(f.path)) folderFileBytes += fs.statSync(f.path).size;
		}
	}
	return promptBytes + wrapperBytes + instructionBytes + folderFileBytes;
}

function enforcePreDispatchGates(inv: Invocation, controlledInputBytes: number): number | undefined {
	if (inv.maxInputBytes !== undefined && controlledInputBytes > inv.maxInputBytes) {
		const msg = `controlled input (${controlledInputBytes} bytes) exceeds maxInputBytes (${inv.maxInputBytes} bytes)`;
		inv.budget?.recordRefusal({
			role: inv.role ?? "reader",
			work: inv.work,
			reason: "input-bytes",
			message: msg,
			controlledInputBytes,
			maxInputBytes: inv.maxInputBytes,
		});
		throw new Refused(msg);
	}
	return inv.budget ? inv.budget.reserve(inv.role ?? "reader", inv.work) : undefined;
}

function readVersion(binary: string): string | null {
	try {
		const out = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] ?? "";
		return out.length > 0 && out.length < 80 ? out : null;
	} catch {
		return null;
	}
}

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

/** Copy the arm's instruction files into the invocation's own folder, numbered to keep their order; multiple canary files are merged into one so runtimes that index by basename see every canary. */
function copyInstructions(arm: ComposedArm, into: string): { name: string; path: string }[] {
	const out: { name: string; path: string }[] = [];
	const canaryTexts: string[] = [];
	let idx = 0;
	for (const f of arm.instructions) {
		const name = path.basename(f.file);
		if (name === "context-lab-canary.md") {
			canaryTexts.push(fs.readFileSync(f.path, "utf8").trimEnd());
			continue;
		}
		const p = path.join(into, `${String(idx++).padStart(2, "0")}-${name}`);
		fs.copyFileSync(f.path, p);
		out.push({ name, path: p });
	}
	if (canaryTexts.length > 0) {
		const unique = [...new Set(canaryTexts.flatMap((t) => t.split("\n")).filter(Boolean))];
		const p = path.join(into, `${String(idx++).padStart(2, "0")}-context-lab-canary.md`);
		fs.writeFileSync(p, unique.map((c) => `${c}\n`).join(""));
		out.push({ name: "context-lab-canary.md", path: p });
	}
	return out;
}

function writeEvents(inv: Invocation, r: SandboxResult, secrets: string[]): string {
	const file = path.join(inv.work, "events.jsonl");
	fs.writeFileSync(file, r.lines.map((l) => scrub(l.text, secrets) + "\n").join(""));
	return file;
}

function scrubOutcome(o: Outcome, secrets: string[]): Outcome {
	return JSON.parse(scrub(JSON.stringify(o), secrets)) as Outcome;
}

function commonRefusals(inv: Invocation, adapter: Adapter, resumeModes: DeliveryMode[] = []): string | null {
	if (!adapter.modes.includes(inv.mode)) return `delivery mode ${inv.mode} is not one ${adapter.runtime} supports (${adapter.modes.join(", ")})`;
	if (inv.sockets && inv.tools === "off") return "sockets cannot be enabled when tools are off";
	const c = inv.continueFrom;
	if (c === undefined) return null;
	if (!adapter.continue) return `${adapter.runtime} does not continue sessions`;
	if (inv.tools === "off") return "a continuing invocation cannot have tools off";
	if (path.resolve(c.workspace) !== path.resolve(inv.workspace)) return `a continuing invocation must run in the workspace of the one it continues, ${c.workspace}`;
	if (!resumeModes.includes(inv.mode)) return `no probe has resumed a ${adapter.runtime} session in delivery mode ${inv.mode}`;
	return null;
}

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

/** The text an opencode invocation sends beside a prompt delivered as an attached file. */
export const ATTACHMENT_WRAPPER = "Read the attached file and follow it exactly.";

/** The provider block with any key or header that is not an environment reference replaced, for a rendering that must not show a secret. */
function redactProvider(block: Record<string, unknown>): Record<string, unknown> {
	const walk = (v: unknown, key: string): unknown => {
		if (typeof v === "string") return /^(apiKey|key|token|authorization)$/i.test(key) && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v) ? "<credential redacted>" : v;
		if (Array.isArray(v)) return v.map((x) => walk(x, key));
		if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.toLowerCase() === "headers" ? Object.fromEntries(Object.keys(x as object).map((h) => [h, "<header redacted>"])) : walk(x, k)]));
		return v;
	};
	return walk(block, "") as Record<string, unknown>;
}

const OPENCODE_TOOLS = ["bash", "edit", "write", "read", "glob", "grep", "list", "patch", "webfetch", "websearch", "codesearch", "task", "todowrite", "todoread", "skill", "question", "lsp"];
const sandboxPath = (): string => {
	const dir = path.dirname(fs.realpathSync(process.execPath));
	return ["/usr/bin", "/bin"].includes(dir) ? "/usr/bin:/bin" : `/usr/bin:/bin:${dir}`;
};

export function which(name: string, env: NodeJS.ProcessEnv): string {
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
	// The provider block is read once per adapter, so every invocation of a run reaches its model the
	// same way as the route the run recorded, whatever happens to the operator's file meanwhile.
	let read: ReturnType<typeof readProvider> | undefined;
	const provider = (): ReturnType<typeof readProvider> => (read ??= readProvider());
	const readProvider = (): { block: Record<string, unknown>; credentialVars: string[]; variants: (model: string) => string[] } => {
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
		version: () => readVersion(opts.binary ?? which("opencode", env)),
		rulesFiles: ["AGENTS.md", "CLAUDE.md"],
		modes: ["inline", "attachment"],
		network: "detected",
		filesystem: "sandboxed",
		continue: true,
		compaction: { onDemand: true, instructionsAfterCompaction: "when delivered again" },
		route(member) {
			const [prov, ...rest] = member.model.split("/");
			const block = provider().block[prov ?? ""] as { npm?: string; api?: string; options?: Record<string, unknown>; models?: Record<string, Record<string, unknown>> } | undefined;
			const model = block?.models?.[rest.join("/")] ?? {};
			const pm = (model["provider"] ?? {}) as { npm?: string; api?: string };
			const { apiKey: _k, headers: _h, ...endpoint } = block?.options ?? {};
			const { provider: _p, headers: _mh, name: _n, ...settings } = model;
			return {
				runtime: "opencode", model: member.model, npm: pm.npm ?? block?.npm ?? null, ...(pm.api ?? block?.api ? { api: pm.api ?? block?.api } : {}),
				endpoint, settings, ...(member.settings ? { memberSettings: member.settings } : {}),
			};
		},
		refuse(inv) {
			const m = commonRefusals(inv, adapter, ["inline"]);
			if (m) return m;
			if (inv.continueFrom && !fs.existsSync(path.join(inv.continueFrom.work, "data"))) return `${inv.continueFrom.work} holds no session store (data)`;
			for (const [k, v] of Object.entries(inv.member.settings ?? {})) {
				if (k === "outputTokenMax") {
					if (!(typeof v === "number" && Number.isInteger(v) && v > 0)) return `setting outputTokenMax ${JSON.stringify(v)} is not a whole number of tokens above zero`;
					continue;
				}
				if (k !== "reasoningEffort") return `setting ${k} is not one opencode can apply`;
				if (!provider().variants(inv.member.model).includes(String(v))) return `setting reasoningEffort ${v} is not a variant of ${inv.member.model}`;
			}
			return null;
		},
		async invoke(inv) {
			const b = build(inv, true);
			let invocationId: number | undefined;
			try {
				invocationId = enforcePreDispatchGates(inv, b.controlledInputBytes);
			} catch (err) {
				fs.rmSync(path.join(inv.work, "cache"), { recursive: true, force: true });
				fs.rmSync(b.home, { recursive: true, force: true });
				throw err;
			}
			const r = await runSandboxed(b.spec);
			// opencode installs packages into its configuration folder and the home's npm cache on every
			// invocation, and the cache copy is about 150 MB: none is part of any record, so all go as
			// soon as the runtime ends, leaving the configuration file.
			fs.rmSync(path.join(inv.work, "cache"), { recursive: true, force: true });
			fs.rmSync(b.home, { recursive: true, force: true });
			for (const f of fs.readdirSync(path.join(b.xdg, "opencode"))) if (f !== "opencode.json") fs.rmSync(path.join(b.xdg, "opencode", f), { recursive: true, force: true });
			removeLogins(path.join(inv.work, "data"));
			const events = writeEvents(inv, r, b.secrets);
			const out = scrubOutcome(parseOpencode(r.lines, { workspace: inv.workspace, home: b.home, exit: r.exit, signal: r.signal, timedOut: r.timedOut, ...(r.stdoutTruncated !== undefined ? { stdoutTruncated: r.stdoutTruncated } : {}), ...(r.capturedStdoutBytes !== undefined ? { capturedStdoutBytes: r.capturedStdoutBytes } : {}), seconds: r.seconds, events }), b.secrets);
			return invocationId !== undefined || inv.maxInputBytes !== undefined
				? { ...out, ...(invocationId !== undefined ? { invocationId } : {}), controlledInputBytes: b.controlledInputBytes }
				: out;
		},
		prepare(inv) {
			const b = build(inv, false);
			const files: PreparedFile[] = [fileOf(path.join(b.xdg, "opencode", "opencode.json"), "opencode configuration: provider, permissions, tools and the instruction files it lists")];
			for (const f of b.instructions) files.push(fileOf(f.path, `instruction file ${f.name}, listed in the configuration`));
			if (inv.mode === "attachment") files.push(fileOf(path.join(inv.work, "prompt.md"), "the prompt, attached to the message"));
			return {
				runtime: "opencode", command: b.spec.command, env: b.shownEnv, stdin: b.spec.stdin, cwd: b.spec.cwd,
				mounts: { install: b.spec.install, writable: b.spec.writable, readOnly: b.spec.readOnly },
				prompt: { text: inv.prompt, delivery: inv.mode, wrapper: inv.mode === "attachment" ? ATTACHMENT_WRAPPER : null, bytes: Buffer.byteLength(inv.prompt, "utf8") },
				controlledInputBytes: b.controlledInputBytes,
				files,
				notRendered: [
					"the operator's opencode cache, copied into cache/opencode before a live invocation: packages and model metadata, no prompt text",
					...b.credentialVars.map((v) => `the value of ${v}, a credential, passed in the environment`),
					...(b.redacted ? ["a key or header written literally in the operator's provider block, written in the live configuration and redacted here"] : []),
					...(inv.continueFrom ? [`the session store of the invocation continued (${inv.continueFrom.work}/data), copied into data/`] : []),
				],
				outsideControl: [
					"opencode's own system prompt and tool descriptions, which include an environment block naming the working directory",
					"anything the model provider adds before the model",
					"what opencode writes into these files once it starts: a live run's opencode.json gains a $schema key, so the file a live invocation leaves differs from the one prepared by that line",
				],
			};
		},
	};
	/** Everything invoke does before the runtime runs; live, it also copies the cache and a continued session, and reads credential values. */
	function build(inv: Invocation, live: boolean) {
		const { home, instr } = prepare(inv, adapter);
		const p = provider();
		const xdg = path.join(inv.work, "config");
		for (const d of ["config/opencode", "data", "state", "cache"]) fs.mkdirSync(path.join(inv.work, d), { recursive: true });
		if (live && inv.continueFrom) fs.cpSync(path.join(inv.continueFrom.work, "data"), path.join(inv.work, "data"), { recursive: true });
		if (live && fs.existsSync(operatorCache)) fs.cpSync(operatorCache, path.join(inv.work, "cache", "opencode"), { recursive: true });
		const onRequest = inv.tools === "off" ? [] : inv.arm.onRequest.map((o) => o.path);
		const permission = inv.tools === "off"
			? Object.fromEntries(["edit", "bash", "read", "webfetch", "websearch", "task", "glob", "grep", "list", "external_directory"].map((k) => [k, "deny"]))
			: { edit: "allow", bash: "allow", read: "allow", webfetch: "deny", websearch: "deny", task: "deny", external_directory: onRequest.length ? Object.fromEntries([["*", "deny"], ...onRequest.map((o) => [`${o}/**`, "allow"])]) : "deny" };
		const instructions = copyInstructions(inv.arm, instr);
		const config: Record<string, unknown> = { provider: live ? p.block : redactProvider(p.block), plugin: [], permission, instructions: instructions.map((f) => f.path) };
		if (inv.tools === "off") config["tools"] = Object.fromEntries(OPENCODE_TOOLS.map((t) => [t, false]));
		if (inv.member.settings?.["reasoningEffort"] !== undefined) config["variant"] = inv.member.settings["reasoningEffort"];
		fs.writeFileSync(path.join(xdg, "opencode", "opencode.json"), JSON.stringify(config, null, 2));
		const binary = opts.binary ?? which("opencode", env);
		const args = ["run", "--format", "json", "-m", inv.member.model, ...(inv.continueFrom ? ["-s", inv.continueFrom.session] : [])];
		if (inv.mode === "attachment") {
			const f = path.join(inv.work, "prompt.md");
			fs.writeFileSync(f, inv.prompt);
			args.push("--file", f, "--", ATTACHMENT_WRAPPER);
		} else args.push("--", inv.prompt);
		const secrets = live ? p.credentialVars.map((v) => env[v] ?? "").filter(Boolean) : [];
		const runEnv: Record<string, string> = {
			PATH: sandboxPath(), PWD: inv.workspace, HOME: home,
			XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: path.join(inv.work, "data"), XDG_STATE_HOME: path.join(inv.work, "state"), XDG_CACHE_HOME: path.join(inv.work, "cache"),
			OPENCODE_DISABLE_CLAUDE_CODE: "1",
			...(inv.extraEnv ?? {}),
		};
		const shownEnv: Record<string, string> = { ...runEnv };
		for (const v of p.credentialVars) {
			if (live && env[v] !== undefined) runEnv[v] = env[v]!;
			if (env[v] !== undefined) shownEnv[v] = `<credential: ${v}>`;
		}
		// opencode caps every reply at 32,000 tokens, or at this, whichever is lower than the model's own
		// limit.output; the cap is declared by the member in the pack, never read from the operator's shell.
		if (inv.member.settings?.["outputTokenMax"] !== undefined) runEnv["OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"] = shownEnv["OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"] = String(inv.member.settings["outputTokenMax"]);
		const instructionBytes = instructions.reduce((sum, f) => sum + fs.statSync(f.path).size, 0);
		const controlledInputBytes = measureControlledInputBytes(inv, instructionBytes, inv.mode === "attachment" ? ATTACHMENT_WRAPPER : null);
		const writable = [inv.work, inv.workspace, ...(inv.tools === "on" ? (inv.extraWritable ?? []) : [])];
		const spec: SandboxSpec = { install: binary, writable, readOnly: onRequest, home, cwd: inv.workspace, command: [binary, ...args], env: runEnv, stdin: null, timeLimitSeconds: inv.timeLimitSeconds, ...(inv.maxStdoutBytes !== undefined ? { maxStdoutBytes: inv.maxStdoutBytes } : {}), ...(inv.signal !== undefined ? { signal: inv.signal } : {}) };
		return { spec, home, xdg, secrets, shownEnv, instructions, controlledInputBytes, credentialVars: p.credentialVars, redacted: JSON.stringify(redactProvider(p.block)) !== JSON.stringify(p.block) };
	}
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

export function codexVendor(env: NodeJS.ProcessEnv): string {
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
export const CODEX_FEATURES_OFF = [
	"apps", "browser_annotation_api", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
	"daemon_auto_start", "image_generation", "in_app_browser", "multi_agent", "plugin_sharing", "plugins", "remote_plugin",
	"skill_mcp_dependency_install", "tool_suggest",
];

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
		version: () => { const v = opts.vendor ?? codexVendor(env); return readVersion(opts.binary ?? path.join(v, "bin", "codex")); },
		rulesFiles: ["AGENTS.md", "AGENTS.override.md"],
		modes: ["inline", "stdin"],
		network: "denied",
		filesystem: "sandboxed",
		continue: true,
		compaction: { onDemand: true, instructionsAfterCompaction: "carried by the session" },
		route(member) {
			return { runtime: "codex", model: member.model, ...(member.settings ? { memberSettings: member.settings } : {}) };
		},
		refuse(inv) {
			const m = commonRefusals(inv, adapter, ["inline"]);
			if (m) return m;
			if (inv.continueFrom) {
				const dir = path.join(inv.continueFrom.work, "codex-home", "sessions");
				const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : [];
				if (!files.some((f) => f.includes(inv.continueFrom!.session))) return `${inv.continueFrom.work} holds no session file for ${inv.continueFrom.session}`;
			}
			for (const [k, v] of Object.entries(inv.member.settings ?? {})) {
				if (k !== "reasoningEffort") return `setting ${k} is not one Codex can apply`;
				if (!efforts(inv.member.model).includes(String(v))) return `setting reasoningEffort ${v} is not supported by ${inv.member.model}`;
			}
			return null;
		},
		async invoke(inv) {
			const b = build(inv, true);
			let invocationId: number | undefined;
			try {
				invocationId = enforcePreDispatchGates(inv, b.controlledInputBytes);
			} catch (err) {
				fs.rmSync(path.join(b.codexHome, "auth.json"), { force: true });
				fs.rmSync(b.home, { recursive: true, force: true });
				throw err;
			}
			const r = await runSandboxed(b.spec);
			// The login copy and Codex's own databases are removed, so no run record carries them.
			fs.rmSync(path.join(b.codexHome, "auth.json"), { force: true });
			fs.rmSync(b.home, { recursive: true, force: true });
			for (const f of fs.readdirSync(b.codexHome)) if (/\.sqlite(-shm|-wal)?$/.test(f)) fs.rmSync(path.join(b.codexHome, f), { force: true });
			const events = writeEvents(inv, r, b.secrets);
			const out = scrubOutcome(parseCodex(r.lines, { workspace: b.workspace, home: b.home, exit: r.exit, signal: r.signal, timedOut: r.timedOut, ...(r.stdoutTruncated !== undefined ? { stdoutTruncated: r.stdoutTruncated } : {}), ...(r.capturedStdoutBytes !== undefined ? { capturedStdoutBytes: r.capturedStdoutBytes } : {}), seconds: r.seconds, events }), b.secrets);
			return invocationId !== undefined || inv.maxInputBytes !== undefined
				? { ...out, ...(invocationId !== undefined ? { invocationId } : {}), controlledInputBytes: b.controlledInputBytes }
				: out;
		},
		prepare(inv) {
			const b = build(inv, false);
			return {
				runtime: "codex", command: b.spec.command, env: b.spec.env, stdin: b.spec.stdin, cwd: b.spec.cwd,
				mounts: { install: b.spec.install, writable: b.spec.writable, readOnly: b.spec.readOnly },
				prompt: { text: inv.prompt, delivery: inv.mode, wrapper: null, bytes: Buffer.byteLength(inv.prompt, "utf8") },
				controlledInputBytes: b.controlledInputBytes,
				files: [
					fileOf(path.join(b.codexHome, "config.toml"), "Codex configuration: approval, sandbox, features off, and the instruction files as developer_instructions"),
					{ path: path.join(b.codexHome, "auth.json"), role: "the operator's Codex login, copied before a live invocation; a credential, not rendered", bytes: null, text: null },
				],
				notRendered: [
					"the operator's Codex login, copied into codex-home/auth.json before a live invocation",
					...(inv.continueFrom ? [`the session files of the invocation continued (${inv.continueFrom.work}/codex-home/sessions), copied into codex-home/sessions`] : []),
				],
				outsideControl: [
					"Codex's own base instructions and its environment context, which names the working directory",
					"anything the model provider adds before the model",
					"what Codex writes into these files once it starts: a live run's config.toml gains a trust entry for the working directory ([projects.\"<directory>\"] trust_level = \"trusted\"), so the file a live invocation leaves differs from the one prepared by those lines",
				],
			};
		},
	};
	/** Everything invoke does before the runtime runs; live, it also copies the login and a continued session, and reads the login's secrets to scrub. */
	function build(inv: Invocation, live: boolean) {
		const { home, instr } = prepare(inv, adapter);
		const codexHome = path.join(inv.work, "codex-home");
		fs.mkdirSync(codexHome);
		if (live) {
			fs.copyFileSync(auth, path.join(codexHome, "auth.json"));
			fs.chmodSync(path.join(codexHome, "auth.json"), 0o600);
		}
		// The instructions go only into config.toml, which Codex itself must read; no second copy is made.
		fs.rmdirSync(instr);
		const nonCanary = inv.arm.instructions.filter((f) => path.basename(f.file) !== "context-lab-canary.md");
		const canaryLines = [...new Set(inv.arm.instructions.filter((f) => path.basename(f.file) === "context-lab-canary.md").flatMap((f) => fs.readFileSync(f.path, "utf8").split("\n")).filter(Boolean))];
		const devParts = nonCanary.map((f) => `<file name="${path.basename(f.file)}">\n${fs.readFileSync(f.path, "utf8")}</file>`);
		if (canaryLines.length > 0) devParts.push(`<file name="context-lab-canary.md">\n${canaryLines.map((c) => `${c}\n`).join("")}</file>`);
		const dev = devParts.join("\n\n");
		if (live && inv.continueFrom) fs.cpSync(path.join(inv.continueFrom.work, "codex-home", "sessions"), path.join(codexHome, "sessions"), { recursive: true });
		// No --ephemeral, so a session can be resumed; and the sandbox mode in configuration, since
		// exec resume takes no --sandbox.
		const lines = ['approval_policy = "never"', 'web_search = "disabled"', "project_doc_fallback_filenames = []", `sandbox_mode = ${toml(inv.tools === "off" ? "read-only" : "workspace-write")}`];
		if (dev) lines.push(`developer_instructions = ${toml(dev)}`);
		const effort = inv.member.settings?.["reasoningEffort"];
		if (effort !== undefined) lines.push(`model_reasoning_effort = ${toml(String(effort))}`);
		// Hosted tools reach the web outside the sandbox: a live check found Codex opening a page
		// through its apps connector with web search disabled. Each is switched off by name.
		lines.push("", "[features]", ...CODEX_FEATURES_OFF.map((f) => `${f} = false`));
		if (inv.sockets && inv.tools === "on") {
			lines.push("", "[sandbox_workspace_write]", "network_access = true");
		}
		fs.writeFileSync(path.join(codexHome, "config.toml"), lines.join("\n") + "\n");
		const vendor = opts.vendor ?? codexVendor(env);
		const binary = opts.binary ?? path.join(vendor, "bin", "codex");
		const common = ["--json", "--skip-git-repo-check", "--strict-config", "--ignore-rules", "-m", inv.member.model];
		// With tools off the agent's shell remains, so its workspace is an empty folder of its own.
		const workspace = inv.tools === "off" ? fs.mkdtempSync(path.join(inv.work, "empty-")) : inv.workspace;
		const args = inv.continueFrom
			? ["exec", "resume", ...common, inv.continueFrom.session, inv.prompt]
			: ["exec", ...common, "-C", workspace, inv.mode === "stdin" ? "-" : inv.prompt];
		const secrets = live ? authSecrets(auth) : [];
		const controlledInputBytes = measureControlledInputBytes(inv, Buffer.byteLength(dev, "utf8"), null);
		const writable = inv.tools === "off" ? [inv.work] : [inv.work, inv.workspace, ...(inv.extraWritable ?? [])];
		const spec: SandboxSpec = {
			install: vendor, writable, readOnly: inv.tools === "off" ? [] : inv.arm.onRequest.map((o) => o.path), home, cwd: workspace,
			command: [binary, ...args], env: { PATH: sandboxPath(), PWD: workspace, HOME: home, CODEX_HOME: codexHome, ...(inv.extraEnv ?? {}) }, stdin: inv.mode === "stdin" ? inv.prompt : null, timeLimitSeconds: inv.timeLimitSeconds, ...(inv.maxStdoutBytes !== undefined ? { maxStdoutBytes: inv.maxStdoutBytes } : {}), ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
		};
		return { spec, home, codexHome, workspace, secrets, controlledInputBytes };
	}
	return adapter;
}

/** Remove any login file a runtime wrote under a folder that is kept. */
function removeLogins(dir: string): void {
	if (!fs.existsSync(dir)) return;
	for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile() && e.name === "auth.json") fs.rmSync(path.join(e.parentPath, e.name), { force: true });
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
		filesystem: "open",
		continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" },
		refuse(inv) {
			const m = commonRefusals(inv, adapter);
			if (m) return m;
			const keys = Object.keys(inv.member.settings ?? {});
			return keys.length ? `setting ${keys[0]} is not one an external harness can be given` : null;
		},
		async invoke(inv) {
			const { instr } = prepare(inv, adapter);
			const instructions = copyInstructions(inv.arm, instr);
			const instructionBytes = instructions.reduce((sum, f) => sum + fs.statSync(f.path).size, 0);
			const controlledInputBytes = measureControlledInputBytes(inv, instructionBytes, null);
			const invocationId = enforcePreDispatchGates(inv, controlledInputBytes);
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
				...(invocationId !== undefined || inv.maxInputBytes !== undefined ? { ...(invocationId !== undefined ? { invocationId } : {}), controlledInputBytes } : {}),
			};
		},
	};
	return adapter;
}
