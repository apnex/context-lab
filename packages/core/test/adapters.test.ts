// Criterion E6: each adapter passes every case of test/conformance/CASES.md, run against the stub
// runtime. Expected outcomes come from test/conformance/derive_expected.py, written independently.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
	ATTACHMENT_WRAPPER, CODEX_FEATURES_OFF, EMPTY_ARM, Refused, codexAdapter, externalAdapter, opencodeAdapter, sandboxMounts,
	type Adapter, type ComposedArm, type DeliveryMode, type Invocation, type Member, type Outcome,
} from "../src/index.js";
import { packageRoot, scratch } from "./helpers.js";
import { codexStub, opencodeStub, readRecord, type StubOptions } from "./conformance/stub.js";

const STREAMS = path.join(packageRoot, "test", "conformance", "streams");
// Written out here, not read from the adapter, so dropping a name from the adapter fails the test.
const FEATURES_OFF = ["apps", "browser_annotation_api", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "daemon_auto_start", "image_generation", "in_app_browser", "multi_agent", "plugin_sharing", "plugins", "remote_plugin", "skill_mcp_dependency_install", "tool_suggest"];
const KEY = "cl-test-credential-0123456789abcdef";
const AUTH_TOKEN = "cl-test-auth-token-abcdefghijklmnopqrstuvwxyz";

// A sentinel in the operator's real home, removed when the tests end.
const homeSentinel = path.join(os.homedir(), `.context-lab-sentinel-${process.pid}`);
fs.writeFileSync(homeSentinel, "sentinel\n");
after(() => fs.rmSync(homeSentinel, { force: true }));

interface Env { dir: string; workspace: string; work: string; arm: ComposedArm; onRequest: string; sentinels: string[] }

function setup(): Env {
	const dir = scratch();
	const workspace = path.join(dir, "space", "ws");
	fs.mkdirSync(workspace, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: workspace });
	fs.writeFileSync(path.join(dir, "space", "above.txt"), "above\n");
	fs.writeFileSync(path.join(dir, "space", "beside.txt"), "beside\n");
	const variant = path.join(dir, "variant");
	fs.mkdirSync(variant);
	fs.writeFileSync(path.join(variant, "ONE.md"), "first instruction\n");
	fs.writeFileSync(path.join(variant, "TWO.md"), "second \"instruction\"\n");
	const onRequest = path.join(dir, "corpus");
	fs.mkdirSync(onRequest);
	fs.writeFileSync(path.join(onRequest, "ENTRY.md"), "entry\n");
	const arm: ComposedArm = {
		arm: "a", folderFiles: [], canaries: [], negativeCanaries: [], revisions: {},
		instructions: [{ variant: "v", file: "ONE.md", path: path.join(variant, "ONE.md") }, { variant: "v", file: "TWO.md", path: path.join(variant, "TWO.md") }],
		onRequest: [{ variant: "v", path: onRequest }],
	};
	return { dir, workspace, work: path.join(dir, "work"), arm, onRequest, sentinels: [homeSentinel, path.join(dir, "space", "above.txt"), path.join(dir, "space", "beside.txt")] };
}

function operatorFiles(dir: string): { config: string; cache: string; auth: string; models: string } {
	const config = path.join(dir, "opencode.json");
	fs.writeFileSync(config, JSON.stringify({ provider: { test: { options: { apiKey: "{env:CL_TEST_KEY}" }, models: { m: { name: "m" } } } }, plugin: ["should-not-load"] }));
	const cache = path.join(dir, "cache");
	fs.mkdirSync(cache);
	fs.writeFileSync(path.join(cache, "models.json"), "{}");
	const auth = path.join(dir, "auth.json");
	fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: AUTH_TOKEN } }));
	const models = path.join(dir, "models.json");
	fs.writeFileSync(models, JSON.stringify({ models: [{ slug: "m", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] }] }));
	return { config, cache, auth, models };
}

type Kind = "opencode" | "codex";

function adapterFor(kind: Kind, e: Env, stub: StubOptions): Adapter {
	const op = operatorFiles(e.dir);
	const env = { ...process.env, CL_TEST_KEY: KEY };
	if (kind === "opencode") return opencodeAdapter({ binary: opencodeStub(path.join(e.dir, "stub"), stub), operatorConfig: op.config, operatorCache: op.cache, env });
	return codexAdapter({ vendor: codexStub(path.join(e.dir, "stub"), stub), auth: op.auth, models: op.models, env });
}

function invocation(e: Env, kind: Kind, over: Partial<Invocation> = {}): Invocation {
	const member: Member = { id: "x", family: "f", runtime: kind, model: kind === "opencode" ? "test/m" : "m" };
	return { arm: e.arm, workspace: e.workspace, prompt: "Do the task.\nSecond line.", mode: "inline", member, tools: "on", timeLimitSeconds: 30, work: e.work, ...over };
}

function comparable(o: Outcome): unknown {
	const { cost, events: _e, trace, ...rest } = o;
	const { seconds: _s, ...c } = cost;
	return { ...rest, cost: c, trace: trace.map(({ at: _a, ...t }) => t) };
}

function expectedFor(file: string, e: Env, home: string): unknown {
	const raw = fs.readFileSync(path.join(STREAMS, file.replace(/\.jsonl$/, ".expected.json")), "utf8")
		.split("${WORKSPACE}").join(e.workspace).split("${HOME}").join(home).split(KEY).join("[credential removed]").split(AUTH_TOKEN).join("[credential removed]");
	const x = JSON.parse(raw) as { tools: { paths: string[] }[] };
	for (const t of x.tools) t.paths = t.paths.map((p) => path.normalize(p));
	return x;
}

const streams = fs.readdirSync(STREAMS).filter((f) => f.endsWith(".jsonl"));

// C1-C6, C16-C19: every stream, through the stub, equals its expected outcome.
for (const file of streams) {
	const kind: Kind = file.startsWith("codex") ? "codex" : "opencode";
	test(`${kind}: ${file} gives its expected outcome`, async () => {
		const e = setup();
		const o = await adapterFor(kind, e, { stream: path.join(STREAMS, file) }).invoke(invocation(e, kind));
		assert.deepEqual(comparable(o), expectedFor(file, e, path.join(e.work, "home")));
		assert.ok(o.cost.seconds >= 0);
		for (let i = 1; i < o.trace.length; i++) assert.ok(o.trace[i]!.at >= o.trace[i - 1]!.at, "trace times decrease");
		assert.ok(fs.existsSync(o.events));
		// C19: no credential in anything written.
		for (const text of [fs.readFileSync(o.events, "utf8"), JSON.stringify(o)]) {
			assert.equal(text.includes(KEY), false, "the provider key was written");
			assert.equal(text.includes(AUTH_TOKEN), false, "the login token was written");
		}
	});
}

// C7
test("each adapter declares the rules files its runtime loads", () => {
	assert.deepEqual(opencodeAdapter().rulesFiles, ["AGENTS.md", "CLAUDE.md"]);
	assert.deepEqual(codexAdapter().rulesFiles, ["AGENTS.md", "AGENTS.override.md"]);
	assert.deepEqual(externalAdapter().rulesFiles, []);
});

// C8, C9, C11, C12 - opencode
test("opencode: instructions, on-request folder, isolation and network as declared", async () => {
	const e = setup();
	const a = adapterFor("opencode", e, { stream: path.join(STREAMS, "opencode-notext.synthetic.jsonl"), sentinels: e.sentinels, visible: [e.workspace, path.join(e.onRequest, "ENTRY.md")] });
	await a.invoke(invocation(e, "opencode"));
	const cfg = JSON.parse(fs.readFileSync(path.join(e.work, "config", "opencode", "opencode.json"), "utf8"));
	assert.deepEqual(cfg.instructions.map((p: string) => fs.readFileSync(p, "utf8")), ["first instruction\n", "second \"instruction\"\n"]);
	assert.deepEqual(cfg.plugin, []);
	assert.deepEqual(Object.keys(cfg).sort(), ["instructions", "permission", "plugin", "provider"]);
	assert.deepEqual(cfg.permission.external_directory, { "*": "deny", [`${e.onRequest}/**`]: "allow" });
	assert.equal(cfg.permission.webfetch, "deny");
	assert.equal(cfg.permission.websearch, "deny");
	assert.equal(a.network, "detected");
	const r = readRecord(e.workspace);
	const shellSet = new Set(["SHLVL", "_", "OLDPWD"]);
	assert.deepEqual([...r.env.keys()].filter((k) => !shellSet.has(k)).sort(),
		["CL_TEST_KEY", "HOME", "OPENCODE_DISABLE_CLAUDE_CODE", "PATH", "PWD", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
	assert.equal(r.env.get("PWD"), e.workspace);
	assert.deepEqual(r.configFiles, ["./opencode/opencode.json"]);
	assert.equal(fs.existsSync(path.join(e.work, "cache")), false, "the cache copy was left behind");
	assert.equal(fs.existsSync(path.join(e.work, "home")), false, "the home was left behind");
	assert.equal(fs.existsSync(path.join(e.work, "data", "opencode", "auth.json")), false, "a login file was left in the kept data folder");
	assert.deepEqual(r.sentinels.sort(), [...e.sentinels.map((s) => `absent ${s}`), `readable ${e.workspace}`, `readable ${path.join(e.onRequest, "ENTRY.md")}`].sort());
});

// C8, C9, C11, C12 - Codex
test("Codex: instructions, on-request folder, isolation and network as declared", async () => {
	const e = setup();
	const a = adapterFor("codex", e, { stream: path.join(STREAMS, "codex-turns.synthetic.jsonl"), sentinels: e.sentinels, visible: [e.workspace, path.join(e.onRequest, "ENTRY.md")] });
	await a.invoke(invocation(e, "codex"));
	const tomlText = fs.readFileSync(path.join(e.work, "codex-home", "config.toml"), "utf8");
	const dev = "<file name=\"ONE.md\">\nfirst instruction\n</file>\n\n<file name=\"TWO.md\">\nsecond \"instruction\"\n</file>";
	assert.equal(tomlText, ['approval_policy = "never"', 'web_search = "disabled"', "project_doc_fallback_filenames = []", 'sandbox_mode = "workspace-write"', `developer_instructions = ${JSON.stringify(dev)}`, "", "[features]", ...FEATURES_OFF.map((f) => `${f} = false`), ""].join("\n"));
	assert.deepEqual([...CODEX_FEATURES_OFF].sort(), [...FEATURES_OFF].sort());
	assert.equal(fs.existsSync(path.join(e.work, "codex-home", "auth.json")), false, "the login copy was left behind");
	assert.equal(fs.existsSync(path.join(e.work, "instructions")), false, "a second copy of the instructions was made");
	assert.deepEqual(fs.readdirSync(path.join(e.work, "codex-home")).filter((f) => f.includes("sqlite")), [], "Codex's databases were left behind");
	assert.equal(a.network, "denied");
	const r = readRecord(e.workspace);
	assert.deepEqual([...r.env.keys()].filter((k) => !["SHLVL", "_", "OLDPWD"].includes(k)).sort(), ["CODEX_HOME", "HOME", "PATH", "PWD"]);
	assert.deepEqual(r.configFiles, ["./auth.json", "./config.toml"]);
	assert.ok(r.argv.includes("--strict-config"));
	assert.equal(r.argv.includes("--ignore-user-config"), false);
	assert.equal(r.argv.includes("--sandbox") || r.argv.includes("--ephemeral"), false);
	assert.deepEqual(r.sentinels.sort(), [...e.sentinels.map((s) => `absent ${s}`), `readable ${e.workspace}`, `readable ${path.join(e.onRequest, "ENTRY.md")}`].sort());
});

// C10
const modes: [Kind | "external", DeliveryMode, boolean][] = [
	["opencode", "inline", true], ["opencode", "attachment", true], ["opencode", "stdin", false], ["opencode", "file-pointer", false],
	["codex", "inline", true], ["codex", "stdin", true], ["codex", "attachment", false], ["codex", "file-pointer", false],
	["external", "file-pointer", true], ["external", "inline", false],
];
for (const [kind, mode, ok] of modes) {
	test(`${kind}: delivery mode ${mode} is ${ok ? "delivered as declared" : "refused before anything runs"}`, async () => {
		const e = setup();
		if (kind === "external") {
			const a = externalAdapter({ pollMs: 50 });
			if (!ok) {
				await assert.rejects(a.invoke(invocation(e, "opencode", { mode })), Refused);
				assert.equal(fs.existsSync(e.work), false);
				return;
			}
			setTimeout(() => fs.writeFileSync(path.join(e.work, "answer.md"), "the answer"), 300);
			const o = await a.invoke({ ...invocation(e, "opencode", { mode }), timeLimitSeconds: 10 });
			assert.equal(o.final, "the answer");
			assert.equal(fs.readFileSync(path.join(e.work, "prompt.md"), "utf8"), "Do the task.\nSecond line.");
			assert.equal(fs.readFileSync(path.join(e.work, "on-request.txt"), "utf8"), `${e.onRequest}\n`);
			assert.equal(fs.readdirSync(path.join(e.work, "instructions")).length, 2);
			return;
		}
		const a = adapterFor(kind, e, { stream: path.join(STREAMS, `${kind}-notext.synthetic.jsonl`) });
		const inv = invocation(e, kind, { mode });
		if (!ok) {
			await assert.rejects(a.invoke(inv), Refused);
			assert.equal(fs.existsSync(e.work), false, "something ran");
			return;
		}
		await a.invoke(inv);
		const r = readRecord(e.workspace);
		const last = r.argv[r.argv.length - 1];
		if (kind === "opencode" && mode === "inline") { assert.equal(last, inv.prompt); assert.equal(r.stdin, ""); }
		if (kind === "opencode" && mode === "attachment") {
			const i = r.argv.indexOf("--file");
			assert.equal(fs.readFileSync(r.argv[i + 1]!, "utf8"), inv.prompt);
			assert.notEqual(r.argv[i + 2], last, "the prompt was taken as a --file value");
		}
		if (kind === "codex" && mode === "inline") { assert.equal(last, inv.prompt); assert.equal(r.stdin, ""); }
		if (kind === "codex" && mode === "stdin") { assert.equal(last, "-"); assert.equal(r.stdin, inv.prompt); }
	});
}

// C13
test("opencode: tools off disables every tool and denies every permission", async () => {
	const e = setup();
	await adapterFor("opencode", e, { stream: path.join(STREAMS, "opencode-notext.synthetic.jsonl") }).invoke(invocation(e, "opencode", { tools: "off" }));
	const cfg = JSON.parse(fs.readFileSync(path.join(e.work, "config", "opencode", "opencode.json"), "utf8"));
	assert.ok(Object.values(cfg.tools).length >= 15 && Object.values(cfg.tools).every((v) => v === false));
	assert.ok(Object.values(cfg.permission).every((v) => v === "deny"));
});

test("Codex: tools off runs read-only in an empty workspace of its own", async () => {
	const e = setup();
	fs.writeFileSync(path.join(e.workspace, "task.txt"), "task\n");
	await adapterFor("codex", e, { stream: path.join(STREAMS, "codex-inflight-model.synthetic.jsonl"), visible: [path.join(e.workspace, "task.txt"), path.join(e.onRequest, "ENTRY.md")] }).invoke(invocation(e, "codex", { tools: "off" }));
	const empty = fs.readdirSync(e.work).find((d) => d.startsWith("empty-"));
	assert.ok(empty);
	const r = readRecord(path.join(e.work, empty!));
	assert.equal(r.argv.includes("--sandbox") || r.argv.includes("--ephemeral"), false);
	assert.match(fs.readFileSync(path.join(e.work, "codex-home", "config.toml"), "utf8"), /^sandbox_mode = "read-only"$/m);
	assert.deepEqual(r.sentinels.sort(), [`unreadable ${path.join(e.onRequest, "ENTRY.md")}`, `unreadable ${path.join(e.workspace, "task.txt")}`].sort());
	assert.match(fs.readFileSync(path.join(e.work, "codex-home", "config.toml"), "utf8"), /web_search = "disabled"/);
});

// C14
for (const kind of ["opencode", "codex"] as const) {
	test(`${kind}: a runtime that never exits is stopped at its limit, with every child`, { timeout: 30000 }, async () => {
		const e = setup();
		const tag = `${7000 + Math.floor(Math.random() * 999)}${kind === "codex" ? 1 : 2}`;
		const started = Date.now();
		const o = await adapterFor(kind, e, { hang: { tag } }).invoke(invocation(e, kind, { timeLimitSeconds: 2 }));
		assert.equal(o.stop.reason, "timeout");
		assert.ok((Date.now() - started) / 1000 < 4, "not stopped near its limit");
		await new Promise((r) => setTimeout(r, 500));
		// Anchored, so the pattern does not match the shell running pgrep.
		const left = execFileSync("sh", ["-c", `pgrep -f "^sleep ${tag}" || true`], { encoding: "utf8" }).trim();
		assert.equal(left, "", `processes outlived the runtime: ${left}`);
	});
}

// C15
test("settings a runtime cannot apply are refused before anything runs", async () => {
	const e = setup();
	const oc = adapterFor("opencode", e, { stream: path.join(STREAMS, "opencode-notext.synthetic.jsonl") });
	assert.match(oc.refuse(invocation(e, "opencode", { member: { id: "x", family: "f", runtime: "opencode", model: "test/m", settings: { reasoningEffort: "high" } } })) ?? "", /reasoningEffort high/);
	const cx = adapterFor("codex", setup(), { stream: path.join(STREAMS, "codex-turns.synthetic.jsonl") });
	assert.match(cx.refuse(invocation(e, "codex", { member: { id: "x", family: "f", runtime: "codex", model: "m", settings: { reasoningEffort: "minimal" } } })) ?? "", /minimal/);
	assert.equal(cx.refuse(invocation(e, "codex", { member: { id: "x", family: "f", runtime: "codex", model: "m", settings: { reasoningEffort: "high" } } })), null);
	assert.match(externalAdapter().refuse(invocation(e, "opencode", { mode: "file-pointer", member: { id: "x", family: "f", runtime: "external", model: "m", settings: { anything: 1 } } })) ?? "", /anything/);
	await assert.rejects(oc.invoke(invocation(e, "opencode", { member: { id: "x", family: "f", runtime: "opencode", model: "test/m", settings: { reasoningEffort: "high" } } })), Refused);
	assert.equal(fs.existsSync(e.work), false);
});

test("an external harness that never answers times out", async () => {
	const e = setup();
	const o = await externalAdapter({ pollMs: 50 }).invoke({ ...invocation(e, "opencode", { mode: "file-pointer" }), timeLimitSeconds: 1 });
	assert.equal(o.stop.reason, "timeout");
	assert.equal(o.final, "");
});

// C20-C25: continuation.
test("each adapter declares continuation and compaction as probed", () => {
	assert.deepEqual([opencodeAdapter().continue, opencodeAdapter().compaction], [true, { onDemand: true, instructionsAfterCompaction: "when delivered again" }]);
	assert.deepEqual([codexAdapter().continue, codexAdapter().compaction], [true, { onDemand: true, instructionsAfterCompaction: "carried by the session" }]);
	assert.deepEqual([externalAdapter().continue, externalAdapter().compaction], [false, { onDemand: false, instructionsAfterCompaction: "unknown" }]);
});

function earlierFolder(e: Env, kind: Kind, session: string): string {
	const earlier = path.join(e.dir, "earlier");
	if (kind === "opencode") {
		fs.mkdirSync(path.join(earlier, "data", "opencode"), { recursive: true });
		fs.writeFileSync(path.join(earlier, "data", "opencode", "opencode.db"), `store of ${session}\n`);
	} else {
		fs.mkdirSync(path.join(earlier, "codex-home", "sessions", "2026"), { recursive: true });
		fs.writeFileSync(path.join(earlier, "codex-home", "sessions", "2026", `rollout-${session}.jsonl`), `store of ${session}\n`);
	}
	fs.writeFileSync(path.join(earlier, "SENTINEL"), "s\n");
	return earlier;
}
const snapshot = (dir: string): string => JSON.stringify(fs.readdirSync(dir, { recursive: true }).map(String).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : ""]));

for (const kind of ["opencode", "codex"] as const) {
	test(`${kind}: a continuing invocation resumes from a copied store, the earlier folder unseen and unchanged`, async () => {
		const e = setup();
		const session = kind === "opencode" ? "ses_abc" : "0000-thread-1";
		const earlier = earlierFolder(e, kind, session);
		const before = snapshot(earlier);
		const store = kind === "opencode" ? ["data", "opencode", "opencode.db"] : ["codex-home", "sessions", "2026", `rollout-${session}.jsonl`];
		const a = adapterFor(kind, e, { stream: path.join(STREAMS, `${kind}-notext.synthetic.jsonl`), sentinels: [path.join(earlier, "SENTINEL")], visible: [path.join(e.work, ...store)] });
		await a.invoke(invocation(e, kind, { continueFrom: { session, work: earlier, workspace: e.workspace } }));
		const r = readRecord(e.workspace);
		const want = kind === "opencode"
			? ["run", "--format", "json", "-m", "test/m", "-s", session, "--", "Do the task.\nSecond line."]
			: ["exec", "resume", "--json", "--skip-git-repo-check", "--strict-config", "--ignore-rules", "-m", "m", session, "Do the task.\nSecond line."];
		assert.deepEqual(r.argv, want);
		assert.equal(r.env.get("PWD"), e.workspace);
		assert.equal(fs.readFileSync(path.join(e.work, ...store), "utf8"), `store of ${session}\n`);
		assert.deepEqual(r.sentinels.sort(), [`absent ${path.join(earlier, "SENTINEL")}`, `readable ${path.join(e.work, ...store)}`].sort());
		assert.equal(snapshot(earlier), before, "the earlier folder changed");
		assert.equal(fs.readdirSync(e.work, { recursive: true }).map(String).some((f) => f.endsWith("auth.json")), false, "a login file was left behind");
	});

	test(`${kind}: continuation is refused, before anything runs, for each unmet condition`, () => {
		const e = setup();
		const session = kind === "opencode" ? "ses_abc" : "0000-thread-1";
		const earlier = earlierFolder(e, kind, session);
		const a = adapterFor(kind, e, { stream: path.join(STREAMS, `${kind}-notext.synthetic.jsonl`) });
		const c = { session, work: earlier, workspace: e.workspace };
		assert.match(a.refuse(invocation(e, kind, { continueFrom: c, tools: "off" })) ?? "", /tools off/);
		assert.match(a.refuse(invocation(e, kind, { continueFrom: { ...c, workspace: path.join(e.dir, "other") } })) ?? "", /workspace/);
		assert.match(a.refuse(invocation(e, kind, { continueFrom: { ...c, work: path.join(e.dir, "empty") } })) ?? "", /no session/);
		assert.match(a.refuse(invocation(e, kind, { continueFrom: c, mode: kind === "opencode" ? "attachment" : "stdin" })) ?? "", /no probe has resumed/);
		assert.equal(a.refuse(invocation(e, kind, { continueFrom: c })), null);
	});
}

test("external: continuation is refused", () => {
	const e = setup();
	assert.match(externalAdapter().refuse(invocation(e, "opencode", { mode: "file-pointer", continueFrom: { session: "s", work: e.dir, workspace: e.workspace } })) ?? "", /does not continue/);
});

test("opencode: the route names the client package, endpoint and model settings, leaves out credentials, and is fixed for the adapter's life", () => {
	const dir = scratch();
	const config = path.join(dir, "opencode.json");
	const write = (npm: string): void => fs.writeFileSync(config, JSON.stringify({ provider: { lx: {
		npm: "@ai-sdk/anthropic", options: { baseURL: "http://lx.invalid/v1", apiKey: "{env:CL_TEST_KEY}", headers: { "X-Secret": "s" } },
		models: { claude: { name: "C", options: { thinking: { type: "adaptive" } }, limit: { context: 10, output: 5 } }, gem: { name: "G", provider: { npm } } },
	} } }));
	write("@ai-sdk/openai-compatible");
	const a = opencodeAdapter({ binary: "/bin/true", operatorConfig: config, operatorCache: path.join(dir, "none"), env: { PATH: "/usr/bin:/bin" } });
	const member = (model: string) => ({ id: "x", family: "f", runtime: "opencode", model });
	assert.deepEqual(a.route!(member("lx/claude")), {
		runtime: "opencode", model: "lx/claude", npm: "@ai-sdk/anthropic", endpoint: { baseURL: "http://lx.invalid/v1" },
		settings: { options: { thinking: { type: "adaptive" } }, limit: { context: 10, output: 5 } },
	});
	assert.equal(a.route!(member("lx/gem")).npm, "@ai-sdk/openai-compatible", "a model's own client package does not override the provider's");
	assert.equal(JSON.stringify(a.route!(member("lx/claude"))).includes("CL_TEST_KEY") || JSON.stringify(a.route!(member("lx/claude"))).includes("X-Secret"), false);
	// The operator's file changing mid-run changes nothing for this adapter.
	write("@ai-sdk/anthropic");
	assert.equal(a.route!(member("lx/gem")).npm, "@ai-sdk/openai-compatible");
	assert.equal(opencodeAdapter({ binary: "/bin/true", operatorConfig: config, operatorCache: path.join(dir, "none"), env: { PATH: "/usr/bin:/bin" } }).route!(member("lx/gem")).npm, "@ai-sdk/anthropic");
	assert.deepEqual(codexAdapter({ vendor: dir, auth: path.join(dir, "a"), models: path.join(dir, "m") }).route!({ ...member("gpt-x"), runtime: "codex", settings: { reasoningEffort: "high" } }), { runtime: "codex", model: "gpt-x", memberSettings: { reasoningEffort: "high" } });
});

test("opencode: outputTokenMax is passed into the sandbox from the member, and only from the member", async () => {
	const e = setup();
	const stub: StubOptions = {};
	// The operator's shell holding the variable changes nothing.
	const op = operatorFiles(e.dir);
	const shell = { ...process.env, CL_TEST_KEY: KEY, OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "999" };
	const a = opencodeAdapter({ binary: opencodeStub(path.join(e.dir, "stub"), stub), operatorConfig: op.config, operatorCache: op.cache, env: shell });
	await a.invoke(invocation(e, "opencode"));
	assert.equal(readRecord(e.workspace).env.get("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"), undefined, "the operator's shell reached the agent");
	const member: Member = { id: "x", family: "f", runtime: "opencode", model: "test/m", settings: { outputTokenMax: 1048576 } };
	fs.rmSync(e.work, { recursive: true, force: true });
	await a.invoke(invocation(e, "opencode", { member }));
	assert.equal(readRecord(e.workspace).env.get("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"), "1048576");
	for (const bad of [0, -5, 1.5, "1000"]) assert.match(a.refuse(invocation(e, "opencode", { member: { ...member, settings: { outputTokenMax: bad as number } } })) ?? "", /outputTokenMax/);
	const cx = codexAdapter({ vendor: e.dir, auth: op.auth, models: op.models, env: shell });
	assert.match(cx.refuse(invocation(e, "codex", { member: { id: "x", family: "f", runtime: "codex", model: "m", settings: { outputTokenMax: 1000 } } })) ?? "", /outputTokenMax is not one Codex can apply/);
	assert.deepEqual(a.route!(member).memberSettings, { outputTokenMax: 1048576 });
});

test("adapters: multiple context-lab-canary.md instructions from multiple variants are merged into one file", async () => {
	for (const kind of ["opencode", "codex"] as const) {
		const e = setup();
		const v2 = path.join(e.dir, "variant2");
		fs.mkdirSync(v2);
		fs.writeFileSync(path.join(e.dir, "variant", "context-lab-canary.md"), "Canary one.\n");
		fs.writeFileSync(path.join(v2, "context-lab-canary.md"), "Canary two.\nCanary one.\n");
		e.arm.instructions.push(
			{ variant: "v", file: "context-lab-canary.md", path: path.join(e.dir, "variant", "context-lab-canary.md") },
			{ variant: "v2", file: "context-lab-canary.md", path: path.join(v2, "context-lab-canary.md") },
		);
		await adapterFor(kind, e, {}).invoke(invocation(e, kind));
		if (kind === "opencode") {
			const ocInstr = fs.readdirSync(path.join(e.work, "instructions")).filter((f) => f.endsWith("context-lab-canary.md"));
			assert.equal(ocInstr.length, 1, "opencode must receive exactly one context-lab-canary.md instruction file");
			assert.equal(fs.readFileSync(path.join(e.work, "instructions", ocInstr[0]!), "utf8"), "Canary one.\nCanary two.\n");
		} else {
			const tomlText = fs.readFileSync(path.join(e.work, "codex-home", "config.toml"), "utf8");
			assert.equal((tomlText.match(/name=\\"context-lab-canary\.md\\"/g) ?? []).length, 1, "codex developer_instructions must hold one context-lab-canary.md block");
			assert.match(tomlText, /Canary one\.\\nCanary two\./);
		}
	}
});

test("runtime-sandbox: node is bound on PATH inside the sandbox without leaking the operator's home (B15)", async () => {
	const e = setup();
	fs.writeFileSync(path.join(e.workspace, "check-node.js"), "console.log(21 * 2);\n");
	const bin = path.join(e.dir, "stub-node", "opencode");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(
		bin,
		'#!/bin/sh\n' +
		'OUT=$(node "$PWD/check-node.js")\n' +
		'printf \'{"type":"step_start","part":{}}\\n{"type":"text","part":{"messageID":"m1","text":"%s"}}\\n{"type":"step_finish","part":{"reason":"stop"}}\\n\' "$OUT"\n',
		{ mode: 0o755 },
	);
	const op = operatorFiles(e.dir);
	const a = opencodeAdapter({ binary: bin, operatorConfig: op.config, operatorCache: op.cache, env: { ...process.env, CL_TEST_KEY: KEY } });
	const o = await a.invoke(invocation(e, "opencode"));
	assert.equal(o.final, "42");

	// Also verify Codex sockets opt-in: refused when tools === "off", and writes [sandbox_workspace_write]\nnetwork_access = true when tools === "on".
	const e2 = setup();
	const cx = adapterFor("codex", e2, {});
	assert.match(cx.refuse(invocation(e2, "codex", { tools: "off", sockets: true })) ?? "", /sockets cannot be enabled when tools are off/);
	await cx.invoke(invocation(e2, "codex", { tools: "on", sockets: true }));
	const tomlSockets = fs.readFileSync(path.join(e2.work, "codex-home", "config.toml"), "utf8");
	assert.match(tomlSockets, /\[sandbox_workspace_write\]\nnetwork_access = true/);
});

test("runtime-sandbox: a private directory is mounted read-write at its target inside the sandbox, owner-only, and named a Codex writable root", async () => {
	const e = setup();
	const source = path.join(e.dir, "private-1");
	fs.mkdirSync(source, { mode: 0o700 });
	fs.chmodSync(source, 0o700);
	const target = "/home/context-lab-private-probe/.state";
	// The stub runtime reports the target's mode as the sandbox shows it and writes a file there.
	const bin = path.join(e.dir, "stub-private", "opencode");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(
		bin,
		'#!/bin/sh\n' +
		`MODE=$(stat -c %a '${target}')\n` +
		`echo written > '${target}/probe.txt'\n` +
		'printf \'{"type":"step_start","part":{}}\\n{"type":"text","part":{"messageID":"m1","text":"%s"}}\\n{"type":"step_finish","part":{"reason":"stop"}}\\n\' "$MODE"\n',
		{ mode: 0o755 },
	);
	const op = operatorFiles(e.dir);
	const a = opencodeAdapter({ binary: bin, operatorConfig: op.config, operatorCache: op.cache, env: { ...process.env, CL_TEST_KEY: KEY } });
	const o = await a.invoke(invocation(e, "opencode", { privateDirs: [{ source, target }] }));
	assert.equal(o.final, "700", "the target is the owner-only source");
	assert.equal(fs.readFileSync(path.join(source, "probe.txt"), "utf8"), "written\n", "a write at the target lands in the source");

	// The bind comes after every other mount, and with tools off no private directory is mounted at all.
	const mounts = sandboxMounts({ install: bin, writable: [e.work], readOnly: [e.onRequest], binds: [{ source, target }], home: path.join(e.work, "home"), cwd: e.workspace, command: [bin], env: {}, stdin: null, timeLimitSeconds: 1 });
	const at = mounts.indexOf("--bind", mounts.lastIndexOf("--ro-bind"));
	assert.deepEqual(mounts.slice(at, at + 3), ["--bind", source, target]);
	assert.match(a.refuse(invocation(e, "opencode", { tools: "off", privateDirs: [{ source, target }] })) ?? "", /private directories cannot be mounted when tools are off/);

	// Codex's own workspace sandbox names the target a writable root, beside network access when sockets are on.
	const e2 = setup();
	await adapterFor("codex", e2, {}).invoke(invocation(e2, "codex", { tools: "on", sockets: true, privateDirs: [{ source, target }] }));
	const toml = fs.readFileSync(path.join(e2.work, "codex-home", "config.toml"), "utf8");
	assert.match(toml, /\[sandbox_workspace_write\]\nnetwork_access = true\nwritable_roots = \["\/home\/context-lab-private-probe\/\.state"\]/);
	const e3 = setup();
	await adapterFor("codex", e3, {}).invoke(invocation(e3, "codex", { tools: "on" }));
	assert.doesNotMatch(fs.readFileSync(path.join(e3.work, "codex-home", "config.toml"), "utf8"), /sandbox_workspace_write|writable_roots/, "no section without sockets or private directories");
});

// B20: prepare renders what invoke runs. A live invocation goes through the stub, which records the
// arguments, environment and stdin it was given; the same invocation is prepared in another folder;
// the two must agree but for that folder's path, a credential's value, and an empty workspace's name.
for (const kind of ["opencode", "codex"] as const) for (const role of ["reader", "judge"] as const) {
	test(`${kind}: prepare renders the ${role} invocation invoke runs, and reads no credential (B20)`, async () => {
		const e = setup();
		const a = adapterFor(kind, e, { stream: path.join(STREAMS, kind === "codex" ? "codex-inflight-model.synthetic.jsonl" : "opencode-notext.synthetic.jsonl") });
		const judge = role === "judge";
		const over: Partial<Invocation> = judge ? { tools: "off", arm: EMPTY_ARM, mode: kind === "opencode" ? "attachment" : "stdin", prompt: "Score these.\nLine two." } : {};
		await a.invoke(invocation(e, kind, over));
		const cwd = judge && kind === "codex" ? path.join(e.work, fs.readdirSync(e.work).find((d) => d.startsWith("empty-"))!) : e.workspace;
		const live = readRecord(cwd);
		const work2 = path.join(e.dir, "work2");
		const pv = a.prepare!(invocation(e, kind, { ...over, work: work2 }));
		const norm = (t: string): string => t.split(work2).join("<WORK>").split(e.work).join("<WORK>").replace(/empty-[A-Za-z0-9]{6}/g, "empty-*");
		assert.deepEqual(pv.command.slice(1).map(norm), live.argv.map(norm), "arguments differ");
		const shell = new Set(["SHLVL", "_", "OLDPWD"]);
		const liveEnv = Object.fromEntries([...live.env].filter(([k]) => !shell.has(k)).map(([k, v]) => [k, v === KEY ? "<credential: CL_TEST_KEY>" : norm(v)]));
		assert.deepEqual(Object.fromEntries(Object.entries(pv.env).map(([k, v]) => [k, norm(v)])), liveEnv, "environment differs");
		assert.equal(pv.stdin ?? "", live.stdin, "stdin differs");
		// Every file prepare lists, but a credential, is the file invoke left in its folder.
		for (const f of pv.files) {
			if (f.text === null) continue;
			const livePath = f.path.split(work2).join(e.work);
			assert.equal(norm(f.text), norm(fs.readFileSync(livePath, "utf8")), `${path.relative(work2, f.path)} differs`);
		}
		assert.equal(pv.prompt.wrapper, judge && kind === "opencode" ? ATTACHMENT_WRAPPER : null);
		if (judge && kind === "opencode") assert.ok(live.argv.includes(ATTACHMENT_WRAPPER));
		// Nothing ran, and no credential was read or written.
		assert.equal(fs.existsSync(path.join(work2, "events.jsonl")), false, "prepare ran the runtime");
		assert.equal(fs.existsSync(path.join(work2, "codex-home", "auth.json")), false, "prepare copied the login");
		assert.equal(fs.existsSync(path.join(work2, "cache", "opencode")), false, "prepare copied the cache");
		for (const t of [JSON.stringify(pv), ...pv.files.filter((f) => f.text !== null).map((f) => f.text!)]) {
			assert.equal(t.includes(KEY), false, "a provider key was rendered");
			assert.equal(t.includes(AUTH_TOKEN), false, "a login token was rendered");
		}
		assert.ok(pv.notRendered.length > 0 && pv.outsideControl.length > 0);
	});
}

test("opencode: prepare redacts a key or header written literally in the operator's provider block, and says so (B20)", () => {
	const e = setup();
	const literal = "cl-test-literal-key-9876543210", header = "Bearer cl-test-literal-header-abcdef";
	const config = path.join(e.dir, "literal.json");
	fs.writeFileSync(config, JSON.stringify({ provider: { test: { options: { apiKey: literal, headers: { Authorization: header }, baseURL: "http://x.invalid/v1" }, models: { m: { name: "m" } } } } }));
	const a = opencodeAdapter({ binary: opencodeStub(path.join(e.dir, "stub"), {}), operatorConfig: config, operatorCache: path.join(e.dir, "none"), env: { ...process.env } });
	const pv = a.prepare!(invocation(e, "opencode"));
	const cfg = pv.files.find((f) => f.path.endsWith("opencode.json"))!.text!;
	assert.equal(cfg.includes(literal) || cfg.includes(header) || JSON.stringify(pv).includes(literal) || JSON.stringify(pv).includes(header), false, "a literal credential was rendered");
	const opts = JSON.parse(cfg).provider.test.options;
	assert.deepEqual([opts.apiKey, opts.headers.Authorization, opts.baseURL], ["<credential redacted>", "<header redacted>", "http://x.invalid/v1"]);
	assert.ok(pv.notRendered.some((n) => /written literally in the operator's provider block/.test(n)));
});

test("B30: opencode and codex adapters enforce pre-dispatch maxInputBytes refusal, InvocationBudget reservation, and maxStdoutBytes prefix cut under bwrap", async () => {
	const eOc = setup(), eCx = setup();
	const budget = new (await import("../src/index.js")).InvocationBudget(3);
	const oc = adapterFor("opencode", eOc, { stream: path.join(STREAMS, "opencode-success.recorded.jsonl") });
	const cx = adapterFor("codex", eCx, { stream: path.join(STREAMS, "codex-success.recorded.jsonl") });

	// 1. Pre-dispatch input-byte gate refuses before spawning bwrap and does not consume a budget slot.
	await assert.rejects(
		() => oc.invoke(invocation(eOc, "opencode", { work: path.join(eOc.dir, "w-refused"), maxInputBytes: 10, budget, role: "reader" })),
		/exceeds maxInputBytes/,
	);
	assert.equal(budget.dispatchedTotal(), 0);
	assert.equal(budget.summary().refusedPreDispatch.length, 1);
	assert.equal(budget.summary().refusedPreDispatch[0]!.reason, "input-bytes");

	// 2. Normal dispatch within maxInputBytes reserves an invocationId and records controlledInputBytes.
	const okOut = await oc.invoke(invocation(eOc, "opencode", { work: path.join(eOc.dir, "w-ok"), maxInputBytes: 5000, budget, role: "reader" }));
	assert.equal(okOut.invocationId, 1);
	assert.equal(typeof okOut.controlledInputBytes, "number");
	assert.ok(okOut.controlledInputBytes! > 50);

	// 3. maxStdoutBytes cuts the stream at a complete line boundary, kills bwrap, and marks stdoutTruncated + usageComplete: false + error.cause: "overflow".
	const truncOc = await oc.invoke(invocation(eOc, "opencode", { work: path.join(eOc.dir, "w-trunc-oc"), maxStdoutBytes: 250, budget, role: "reader" }));
	assert.equal(truncOc.stdoutTruncated, true);
	assert.ok((truncOc.capturedStdoutBytes ?? 0) <= 250);
	assert.equal(truncOc.usageComplete, false);
	assert.equal(truncOc.error?.cause, "overflow");
	assert.equal(truncOc.stop.reason, "error");
	assert.equal(truncOc.invocationId, 2);

	const truncCx = await cx.invoke(invocation(eCx, "codex", { work: path.join(eCx.dir, "w-trunc-cx"), maxStdoutBytes: 250, budget, role: "judge", tools: "off" }));
	assert.equal(truncCx.stdoutTruncated, true);
	assert.ok((truncCx.capturedStdoutBytes ?? 0) <= 250);
	assert.equal(truncCx.usageComplete, false);
	assert.equal(truncCx.error?.cause, "overflow");
	assert.equal(truncCx.invocationId, 3);

	// 4. Next invocation hits maxTotalInvocations (3) and throws BudgetExhausted before dispatch.
	await assert.rejects(
		() => cx.invoke(invocation(eCx, "codex", { work: path.join(eCx.dir, "w-exhaust"), budget, role: "judge", tools: "off" })),
		/maxTotalInvocations \(3\) reached/,
	);
	assert.equal(budget.dispatchedTotal(), 3);
	assert.equal(budget.summary().exhausted, true);
});

test("B33 (0051): opencode and codex adapters resolve binaries before copying caches/credentials and remove transient cache/home/auth on preparation failure", async () => {
	const eOc = setup(), eCx = setup();
	const opOc = operatorFiles(eOc.dir), opCx = operatorFiles(eCx.dir);
	const budget = new (await import("../src/index.js")).InvocationBudget(5);

	// 1. Missing opencode binary on PATH: fails before cache copy, leaves zero cache/home files and 0 dispatched invocations.
	const badOc = opencodeAdapter({ operatorConfig: opOc.config, operatorCache: opOc.cache, env: { PATH: "" } });
	const wOcMissing = path.join(eOc.dir, "w-oc-missing-bin");
	await assert.rejects(
		() => badOc.invoke(invocation(eOc, "opencode", { work: wOcMissing, budget, role: "reader" })),
		/opencode is not on PATH/,
	);
	assert.equal(budget.dispatchedTotal(), 0);
	assert.equal(fs.existsSync(path.join(wOcMissing, "cache")), false);
	assert.equal(fs.existsSync(path.join(wOcMissing, "home")), false);
	assert.equal(fs.existsSync(path.join(wOcMissing, "events.jsonl")), false);

	// 2. Malformed opencode operatorConfig: fails in build(), catch block cleans up home and cache.
	const brokenCfg = path.join(eOc.dir, "broken-operator.json");
	fs.writeFileSync(brokenCfg, "{not valid json");
	const brokenOc = opencodeAdapter({ binary: opencodeStub(path.join(eOc.dir, "stub"), {}), operatorConfig: brokenCfg, operatorCache: opOc.cache, env: { PATH: "/usr/bin:/bin" } });
	const wOcBroken = path.join(eOc.dir, "w-oc-broken-cfg");
	await assert.rejects(
		() => brokenOc.invoke(invocation(eOc, "opencode", { work: wOcBroken, budget, role: "reader" })),
	);
	assert.equal(budget.dispatchedTotal(), 0);
	assert.equal(fs.existsSync(path.join(wOcBroken, "cache")), false);
	assert.equal(fs.existsSync(path.join(wOcBroken, "home")), false);

	// 3. Missing codex binary on PATH: fails before auth copy, leaves zero auth.json/home files and 0 dispatched invocations.
	const badCx = codexAdapter({ auth: opCx.auth, models: opCx.models, env: { PATH: "" } });
	const wCxMissing = path.join(eCx.dir, "w-cx-missing-bin");
	await assert.rejects(
		() => badCx.invoke(invocation(eCx, "codex", { work: wCxMissing, budget, role: "reader" })),
		/codex is not on PATH/,
	);
	assert.equal(budget.dispatchedTotal(), 0);
	assert.equal(fs.existsSync(path.join(wCxMissing, "codex-home", "auth.json")), false);
	assert.equal(fs.existsSync(path.join(wCxMissing, "home")), false);

	// 4. Missing instruction file during codex build() after auth copy: catch block removes auth.json and home.
	const cxOk = codexAdapter({ vendor: codexStub(path.join(eCx.dir, "stub"), {}), auth: opCx.auth, models: opCx.models, env: { ...process.env, CL_TEST_KEY: KEY } });
	const wCxMissingInstr = path.join(eCx.dir, "w-cx-missing-instr");
	const brokenArm = { ...eCx.arm, instructions: [{ variant: "v", file: "missing.md", path: path.join(eCx.dir, "no-such-file.md") }] };
	await assert.rejects(
		() => cxOk.invoke(invocation(eCx, "codex", { work: wCxMissingInstr, arm: brokenArm, budget, role: "reader" })),
		/ENOENT/,
	);
	assert.equal(budget.dispatchedTotal(), 0);
	assert.equal(fs.existsSync(path.join(wCxMissingInstr, "codex-home", "auth.json")), false);
	assert.equal(fs.existsSync(path.join(wCxMissingInstr, "home")), false);
});
