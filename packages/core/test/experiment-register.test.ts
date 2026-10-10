// Criterion E2: a run is exploration, whatever status it declares, when its experiment is
// unrecorded or its content hash differs from the recorded one; each covered part moves the hash.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkPack, recordExperiment, runStatus, type LoadedPack } from "../src/index.js";
import { copyPack, editJson } from "./helpers.js";

async function load(dir: string): Promise<LoadedPack> {
	const r = await checkPack(dir);
	if (!r.ok) throw new Error(JSON.stringify(r.defects));
	return r.loaded;
}

test("an unrecorded experiment runs as exploration", async () => {
	const loaded = await load(copyPack());
	assert.equal(runStatus(loaded, "orchard").status, "exploration");
});

test("a recorded, unchanged experiment runs with its declared status", async () => {
	const loaded = await load(copyPack());
	recordExperiment(loaded, "orchard");
	assert.equal(runStatus(loaded, "orchard").status, "result");
});

const changes: Record<string, (d: string) => void> = {
	"the declaration": (d) => editJson(path.join(d, "experiments", "orchard.json"), (j) => { j.runsPerCell = 3; }),
	"a scenario": (d) => editJson(path.join(d, "scenarios", "prune.json"), (j) => { j.task += " Explain why."; }),
	"a key": (d) => editJson(path.join(d, "scenarios", "graft.json"), (j) => { j.properties[0].key = "The note records the scion only."; }),
	"a fixture file": (d) => fs.appendFileSync(path.join(d, "fixtures", "graft", "NOTES.txt"), "Scion: pear.\n"),
	"a rule": (d) => editJson(path.join(d, "pack.json"), (j) => { j.masks.identifiers.push("\\bORC-\\d+\\b"); }),
	"a hook file": (d) => fs.appendFileSync(path.join(d, "hooks", "count.mjs"), "// changed\n"),
	"the declaration-check hook file": (d) => fs.appendFileSync(path.join(d, "hooks", "check.mjs"), "// changed\n"),
	"a hook's time limit": (d) => editJson(path.join(d, "pack.json"), (j) => { j.hooks[2].timeLimitSeconds = 30; }),
	"the source declaration": (d) => editJson(path.join(d, "pack.json"), (j) => { j.sources[0].exclude = ["drafts/"]; }),
	"a suite's selection": (d) => editJson(path.join(d, "pack.json"), (j) => { j.suites[0].select = { scenarios: ["graft"] }; }),
};

for (const [what, change] of Object.entries(changes)) {
	test(`changing ${what} after recording makes the run exploration`, async () => {
		const dir = copyPack();
		recordExperiment(await load(dir), "orchard");
		change(dir);
		const after = runStatus(await load(dir), "orchard");
		assert.equal(after.status, "exploration");
		assert.match(after.reason, /changed/);
	});
}

test("changing a fixture file behind a symbolic link after recording makes the run exploration", async () => {
	const dir = copyPack();
	const real = path.join(dir, "linked.txt");
	fs.writeFileSync(real, "first\n");
	fs.symlinkSync(real, path.join(dir, "fixtures", "graft", "LINK.txt"));
	recordExperiment(await load(dir), "orchard");
	fs.writeFileSync(real, "second\n");
	assert.equal(runStatus(await load(dir), "orchard").status, "exploration");
});
