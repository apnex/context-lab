// Criterion E13: a built variant contains no occurrence of any address the pack declares for its
// source, and records the revision it was built from. E12, stage 2: a variant whose transform hook
// fails is not built, and its arm is not composed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildVariant, checkPack, composeArm, CANARY_FILE, VARIANT_MANIFEST, variantManifestFile, type BuiltVariant, type LoadedPack } from "../src/index.js";
import { commitAll, copyPack, editJson, scratch } from "./helpers.js";

async function load(dir: string): Promise<LoadedPack> {
	const r = await checkPack(dir);
	if (!r.ok) throw new Error(JSON.stringify(r.defects));
	return r.loaded;
}

function allText(dir: string): string {
	return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8")).join("\n");
}

test("a built variant holds no declared address of its source, and records its revision", async () => {
	const dir = copyPack();
	const sha = commitAll(dir);
	const loaded = await load(dir);
	const out = path.join(scratch(), "v");
	const v = await buildVariant(loaded, "almanac-full", "HEAD", out);
	assert.equal(v.ok, true, JSON.stringify(v));
	if (!v.ok) return;
	const text = allText(out);
	for (const a of loaded.pack.sources[0]!.addresses) assert.equal(text.includes(a), false, `${a} survived`);
	assert.ok(text.includes(`${out}/GUIDE.md`), "the address was not rewritten to the copy");
	assert.equal(text.includes(`${out}/raw/main`), false, "a longer address was rewritten by its shorter prefix");
	assert.equal(v.manifest.revision, sha);
	// The manifest is beside the variant, not in it, so an agent given the variant cannot read it.
	assert.equal(JSON.parse(fs.readFileSync(variantManifestFile(out), "utf8")).revision, sha);
	assert.equal(fs.existsSync(path.join(out, VARIANT_MANIFEST)), false);
	assert.deepEqual(fs.readFileSync(path.join(out, CANARY_FILE), "utf8").trim().split("\n"), loaded.pack.variants[0]!.canaries);
});

test("a variant is built from its pinned revision, not the working tree", async () => {
	const dir = copyPack();
	const first = commitAll(dir);
	fs.appendFileSync(path.join(dir, "source", "GUIDE.md"), "Thin the fruit in June.\n");
	commitAll(dir, "second");
	fs.appendFileSync(path.join(dir, "source", "GUIDE.md"), "Uncommitted line.\n");
	const loaded = await load(dir);
	const out = path.join(scratch(), "v");
	const v = await buildVariant(loaded, "almanac-full", first, out);
	assert.equal(v.ok, true);
	const guide = fs.readFileSync(path.join(out, "GUIDE.md"), "utf8");
	assert.equal(guide.includes("Thin the fruit"), false);
	assert.equal(guide.includes("Uncommitted"), false);
});

test("excluded paths are dropped, and only included paths are kept", async () => {
	const dir = copyPack();
	fs.mkdirSync(path.join(dir, "source", "drafts"));
	fs.writeFileSync(path.join(dir, "source", "drafts", "secret.md"), "draft\n");
	fs.writeFileSync(path.join(dir, "source", "NOTES.md"), "notes\n");
	editJson(path.join(dir, "pack.json"), (j) => { j.sources[0].exclude = ["drafts"]; delete j.variants[0].transform; j.variants[0].include = ["*.md"]; });
	commitAll(dir);
	const loaded = await load(dir);
	const out = path.join(scratch(), "v");
	assert.equal((await buildVariant(loaded, "almanac-full", "HEAD", out)).ok, true);
	assert.equal(fs.existsSync(path.join(out, "drafts")), false);
	assert.equal(fs.existsSync(path.join(out, "NOTES.md")), true);
	editJson(path.join(dir, "pack.json"), (j) => { j.variants[0].include = ["GUIDE.md"]; });
	commitAll(dir, "narrow");
	const out2 = path.join(scratch(), "v");
	assert.equal((await buildVariant(await load(dir), "almanac-full", "HEAD", out2)).ok, true);
	assert.equal(fs.existsSync(path.join(out2, "NOTES.md")), false);
	assert.equal(fs.existsSync(path.join(out2, "GUIDE.md")), true);
});

test("a variant whose transform hook fails is not built, and its arm is not composed", async () => {
	const dir = copyPack();
	fs.writeFileSync(path.join(dir, "hooks", "trim.mjs"), "process.exit(3);\n");
	commitAll(dir);
	const loaded = await load(dir);
	const out = path.join(scratch(), "v");
	const v = await buildVariant(loaded, "almanac-full", "HEAD", out);
	assert.equal(v.ok, false);
	assert.equal(fs.existsSync(out), false, "a failed variant left files behind");
	const built = new Map<string, BuiltVariant>([["almanac-full", v]]);
	const arm = composeArm(loaded, "almanac", built);
	assert.equal(arm.ok, false);
	assert.equal(composeArm(loaded, "bare", built).ok, true, "an arm using no failed variant is still composed");
});

test("a variant's files and folders are read-only", async () => {
	const dir = copyPack();
	commitAll(dir);
	const out = path.join(scratch(), "v");
	assert.equal((await buildVariant(await load(dir), "almanac-full", "HEAD", out)).ok, true);
	assert.equal(fs.statSync(out).mode & 0o222, 0, "the variant's folder is writable");
	assert.equal(fs.statSync(path.join(out, "GUIDE.md")).mode & 0o222, 0, "a variant file is writable");
});

test("an exclude that leaves the source is refused by the builder, and deletes nothing", async () => {
	const dir = copyPack();
	commitAll(dir);
	const loaded = await load(dir);
	const parent = scratch();
	const victim = path.join(parent, "victim");
	fs.mkdirSync(victim);
	loaded.pack.sources[0]!.exclude = ["../victim"];
	const v = await buildVariant(loaded, "almanac-full", "HEAD", path.join(parent, "v"));
	assert.equal(v.ok, false);
	assert.equal(fs.existsSync(victim), true);
});

test("a source link that leaves the source is refused", async () => {
	const dir = copyPack();
	// The link points at a scratch folder, never at a real one: a test that links to a real folder
	// lets a mutated builder act on it, and one such mutant once changed the home folder's mode.
	const outside = scratch();
	fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
	fs.symlinkSync(outside, path.join(dir, "source", "outside"));
	editJson(path.join(dir, "pack.json"), (j) => { delete j.variants[0].transform; });
	commitAll(dir);
	const v = await buildVariant(await load(dir), "almanac-full", "HEAD", path.join(scratch(), "v"));
	assert.equal(v.ok, false);
});

test("a link a transform hook makes to outside its output is refused", async () => {
	const dir = copyPack();
	const outside = path.join(scratch(), "outside.txt");
	fs.writeFileSync(outside, "outside\n");
	fs.writeFileSync(path.join(dir, "hooks", "trim.mjs"), `import fs from "node:fs"; const i = JSON.parse(fs.readFileSync(0, "utf8")); fs.symlinkSync(${JSON.stringify(outside)}, i.to + "/host.txt"); console.log("{}");\n`);
	commitAll(dir);
	const out = path.join(scratch(), "v");
	const v = await buildVariant(await load(dir), "almanac-full", "HEAD", out);
	assert.equal(v.ok, false);
	assert.equal(fs.existsSync(out), false);
});

test("a source folder that links back to its parent is refused, not copied without end", async () => {
	const dir = copyPack();
	fs.mkdirSync(path.join(dir, "source", "sub"));
	fs.symlinkSync("..", path.join(dir, "source", "sub", "up"));
	editJson(path.join(dir, "pack.json"), (j) => { delete j.variants[0].transform; });
	commitAll(dir);
	const v = await buildVariant(await load(dir), "almanac-full", "HEAD", path.join(scratch(), "v"));
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /links back/);
});

test("makeReadOnly and makeWritable leave a link's target alone", async () => {
	const { makeReadOnly, makeWritable } = await import("../src/index.js");
	const target = scratch();
	const tree = scratch();
	fs.symlinkSync(target, path.join(tree, "link"));
	const before = fs.statSync(target).mode;
	makeReadOnly(tree);
	assert.equal(fs.statSync(target).mode, before);
	makeWritable(tree);
	assert.equal(fs.statSync(target).mode, before);
	makeReadOnly(path.join(tree, "link"));
	assert.equal(fs.statSync(target).mode, before);
});

test("a failed export leaves no staging folder, and an existing one beside the output is untouched", async () => {
	const dir = copyPack();
	commitAll(dir);
	const loaded = await load(dir);
	const parent = scratch();
	fs.mkdirSync(path.join(parent, "v.export"));
	const v = await buildVariant(loaded, "almanac-full", "no-such-revision", path.join(parent, "v"));
	assert.equal(v.ok, false);
	assert.deepEqual(fs.readdirSync(parent), ["v.export"]);
});

test("include leaves no empty folders behind", async () => {
	const dir = copyPack();
	fs.mkdirSync(path.join(dir, "source", "sub"));
	fs.writeFileSync(path.join(dir, "source", "sub", "a.txt"), "a\n");
	editJson(path.join(dir, "pack.json"), (j) => { delete j.variants[0].transform; j.variants[0].include = ["*.md"]; });
	commitAll(dir);
	const out = path.join(scratch(), "v");
	assert.equal((await buildVariant(await load(dir), "almanac-full", "HEAD", out)).ok, true);
	assert.equal(fs.existsSync(path.join(out, "sub")), false);
});
