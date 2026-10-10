// The workspace builder makes an opaque, committed workspace with the scenario's files and the
// arm's folder files, and refuses a base below a rules file or inside a forbidden path.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildVariant, checkPack, composeArm, createWorkspace, type BuiltVariant, type ComposedArm, type LoadedPack } from "../src/index.js";
import { commitAll, copyPack, editJson, scratch } from "./helpers.js";

async function setup(edit?: (j: any) => void): Promise<{ loaded: LoadedPack; arm: ComposedArm; dir: string }> {
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => { j.arms[1].deliver.push({ variant: "almanac-full", file: "GUIDE.md", as: "folder-file" }); edit?.(j); });
	commitAll(dir);
	const r = await checkPack(dir);
	if (!r.ok) throw new Error(JSON.stringify(r.defects));
	const built = new Map<string, BuiltVariant>([["almanac-full", await buildVariant(r.loaded, "almanac-full", "HEAD", path.join(scratch(), "v"))]]);
	const c = composeArm(r.loaded, "almanac", built);
	if (!c.ok) throw new Error(c.reason);
	return { loaded: r.loaded, arm: c.arm, dir };
}
const scenario = (l: LoadedPack, id: string) => l.experiments.get("orchard")!.scenarios.get(id)!.scenario;
const RULES = ["AGENTS.md", "CLAUDE.md"];

test("a workspace holds the fixture and folder files, committed once, under an opaque name", async () => {
	const { loaded, arm } = await setup();
	const base = scratch();
	const ws = createWorkspace(loaded, scenario(loaded, "graft"), arm, { base, rulesFiles: RULES });
	assert.match(path.basename(ws.dir), /^w-[A-Za-z0-9]{6}$/);
	assert.equal(fs.readFileSync(path.join(ws.dir, "NOTES.txt"), "utf8"), "Rootstock: quince.\n");
	assert.ok(fs.existsSync(path.join(ws.dir, "GUIDE.md")));
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: ws.dir, encoding: "utf8" });
	assert.equal(status, "");
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.dir, encoding: "utf8" }).trim(), ws.init);
});

test("inline fixture files are written", async () => {
	const { loaded, arm } = await setup();
	const s = { ...scenario(loaded, "prune"), fixture: { files: { "a/b.txt": "inline\n" } } };
	const ws = createWorkspace(loaded, s, arm, { base: scratch(), rulesFiles: RULES });
	assert.equal(fs.readFileSync(path.join(ws.dir, "a", "b.txt"), "utf8"), "inline\n");
});

test("a base with a rules file above it is refused", async () => {
	const { loaded, arm } = await setup();
	const parent = scratch();
	fs.writeFileSync(path.join(parent, "AGENTS.md"), "rules\n");
	assert.throws(() => createWorkspace(loaded, scenario(loaded, "graft"), arm, { base: path.join(parent, "inner"), rulesFiles: RULES }), /rules file/);
});

test("a base inside a forbidden path declared as a link is refused", async () => {
	const real = scratch();
	const link = path.join(scratch(), "forbidden-link");
	fs.symlinkSync(real, link);
	const { loaded, arm } = await setup((j) => { j.isolation.forbidden.paths = [link]; });
	assert.throws(() => createWorkspace(loaded, scenario(loaded, "graft"), arm, { base: path.join(real, "ws"), rulesFiles: RULES }), /forbidden/);
});

test("a base inside a forbidden path is refused", async () => {
	const forbidden = scratch();
	const { loaded, arm } = await setup((j) => { j.isolation.forbidden.paths = [forbidden]; });
	assert.throws(() => createWorkspace(loaded, scenario(loaded, "graft"), arm, { base: path.join(forbidden, "ws"), rulesFiles: RULES }), /forbidden/);
});

test("an inline fixture file that escapes the workspace is refused", async () => {
	const { loaded, arm } = await setup();
	const s = { ...scenario(loaded, "prune"), fixture: { files: { "../escape.txt": "x" } } };
	assert.throws(() => createWorkspace(loaded, s, arm, { base: scratch(), rulesFiles: RULES }), /escapes/);
});

test("a folder file that escapes the workspace is refused", async () => {
	const { loaded, arm } = await setup();
	const bad = { ...arm, folderFiles: [{ ...arm.folderFiles[0]!, file: "../escape.md" }] };
	assert.throws(() => createWorkspace(loaded, scenario(loaded, "graft"), bad, { base: scratch(), rulesFiles: RULES }), /escapes/);
});

test("a base reached through a link is judged where it really is", async () => {
	const { loaded, arm } = await setup();
	const parent = scratch();
	fs.writeFileSync(path.join(parent, "AGENTS.md"), "rules\n");
	fs.mkdirSync(path.join(parent, "real"));
	const link = path.join(scratch(), "link");
	fs.symlinkSync(path.join(parent, "real"), link);
	assert.throws(() => createWorkspace(loaded, scenario(loaded, "graft"), arm, { base: link, rulesFiles: RULES }), /rules file/);
});

test("a fixture link to the pack's own key is refused", async () => {
	const { loaded, arm, dir } = await setup();
	fs.symlinkSync(path.join(dir, "scenarios", "graft.json"), path.join(dir, "fixtures", "graft", "KEY.json"));
	assert.throws(() => createWorkspace(loaded, scenario(loaded, "graft"), arm, { base: scratch(), rulesFiles: RULES }), /links outside/);
});

test("the workspace's commit runs none of the operator's git hooks", async () => {
	const { loaded, arm } = await setup();
	const home = scratch();
	const hooks = path.join(home, "hooks");
	fs.mkdirSync(hooks);
	const marker = path.join(home, "hook-ran");
	fs.writeFileSync(path.join(hooks, "post-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
	const template = path.join(home, "template");
	fs.mkdirSync(path.join(template, "hooks"), { recursive: true });
	fs.writeFileSync(path.join(template, "hooks", "post-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${template}\n`);
	const saved = process.env["HOME"];
	process.env["HOME"] = home;
	try {
		createWorkspace(loaded, scenario(loaded, "graft"), arm, { base: scratch(), rulesFiles: RULES });
	} finally {
		process.env["HOME"] = saved;
	}
	assert.equal(fs.existsSync(marker), false);
});
