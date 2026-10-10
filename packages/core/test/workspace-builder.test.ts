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
