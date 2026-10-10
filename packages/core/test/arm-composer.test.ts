// The arm composer names real files for each delivery kind, adds the canary file to guided arms,
// and lists other variants' canaries as ones the arm must not be able to quote.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildVariant, checkPack, composeArm, CANARY_FILE, type BuiltVariant, type LoadedPack } from "../src/index.js";
import { commitAll, copyPack, editJson, scratch } from "./helpers.js";

async function load(dir: string): Promise<LoadedPack> {
	const r = await checkPack(dir);
	if (!r.ok) throw new Error(JSON.stringify(r.defects));
	return r.loaded;
}

test("arms are composed from built variants, with canaries and negative canaries", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => {
		j.variants.push({ id: "almanac-bare", source: "almanac", canaries: ["The owl keeps the gate key."] });
		j.arms[1].deliver.push({ variant: "almanac-full", file: "GUIDE.md", as: "folder-file" }, { variant: "almanac-full", file: ".", as: "on-request" });
	});
	commitAll(dir);
	const loaded = await load(dir);
	const built = new Map<string, BuiltVariant>();
	for (const v of ["almanac-full", "almanac-bare"]) built.set(v, await buildVariant(loaded, v, "HEAD", path.join(scratch(), v)));
	const bare = composeArm(loaded, "bare", built);
	assert.equal(bare.ok, true);
	if (bare.ok) {
		assert.deepEqual([bare.arm.instructions, bare.arm.folderFiles, bare.arm.onRequest, bare.arm.canaries], [[], [], [], []]);
		assert.deepEqual(bare.arm.negativeCanaries.sort(), ["The heron counts eleven stones.", "The owl keeps the gate key."]);
	}
	const guided = composeArm(loaded, "almanac", built);
	assert.equal(guided.ok, true);
	if (!guided.ok) return;
	const full = built.get("almanac-full");
	assert.ok(full?.ok);
	if (!full?.ok) return;
	assert.deepEqual(guided.arm.instructions.map((i) => i.file), ["GUIDE.md", CANARY_FILE]);
	assert.deepEqual(guided.arm.folderFiles.map((f) => f.path), [path.join(full.dir, "GUIDE.md")]);
	assert.deepEqual(guided.arm.onRequest.map((o) => o.path), [full.dir]);
	assert.deepEqual(guided.arm.canaries, ["The heron counts eleven stones."]);
	assert.deepEqual(guided.arm.negativeCanaries, ["The owl keeps the gate key."]);
	assert.equal(guided.arm.revisions["almanac-full"], full.manifest.revision);
});

test("an arm naming a file its variant does not hold is not composed", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => { j.arms[1].deliver[0].file = "NO-SUCH.md"; });
	commitAll(dir);
	const loaded = await load(dir);
	const built = new Map<string, BuiltVariant>([["almanac-full", await buildVariant(loaded, "almanac-full", "HEAD", path.join(scratch(), "v"))]]);
	assert.equal(composeArm(loaded, "almanac", built).ok, false);
});
