// Criterion E6: each adapter passes every case of test/conformance/CASES.md, run against the stub
// runtime. Expected outcomes come from test/conformance/derive_expected.py, written independently.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
	CODEX_FEATURES_OFF, Refused, codexAdapter, externalAdapter, opencodeAdapter,
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
	assert.deepEqual(r.sentinels.sort(), [...e.sentinels.map((s) => `absent ${s}`), `readable ${e.workspace}`, `readable ${path.join(e.onRequest, "ENTRY.md")}`].sort());
});

// C8, C9, C11, C12 - Codex
test("Codex: instructions, on-request folder, isolation and network as declared", async () => {
	const e = setup();
	const a = adapterFor("codex", e, { stream: path.join(STREAMS, "codex-turns.synthetic.jsonl"), sentinels: e.sentinels, visible: [e.workspace, path.join(e.onRequest, "ENTRY.md")] });
	await a.invoke(invocation(e, "codex"));
	const tomlText = fs.readFileSync(path.join(e.work, "codex-home", "config.toml"), "utf8");
	const dev = "<file name=\"ONE.md\">\nfirst instruction\n</file>\n\n<file name=\"TWO.md\">\nsecond \"instruction\"\n</file>";
	assert.equal(tomlText, ['approval_policy = "never"', 'web_search = "disabled"', "project_doc_fallback_filenames = []", `developer_instructions = ${JSON.stringify(dev)}`, "", "[features]", ...FEATURES_OFF.map((f) => `${f} = false`), ""].join("\n"));
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
	assert.deepEqual(r.argv.slice(r.argv.indexOf("--sandbox"), r.argv.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
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
	await adapterFor("codex", e, { stream: path.join(STREAMS, "codex-inflight-model.synthetic.jsonl"), visible: [path.join(e.workspace, "task.txt")] }).invoke(invocation(e, "codex", { tools: "off" }));
	const empty = fs.readdirSync(e.work).find((d) => d.startsWith("empty-"));
	assert.ok(empty);
	const r = readRecord(path.join(e.work, empty!));
	assert.deepEqual(r.argv.slice(r.argv.indexOf("--sandbox"), r.argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
	assert.deepEqual(r.sentinels, [`unreadable ${path.join(e.workspace, "task.txt")}`]);
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
