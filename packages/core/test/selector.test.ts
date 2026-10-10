// Criterion E3: a saved suite resolves to the same scenario list against an unchanged pack, and
// changes exactly as its selection rule predicts; the entry view lists every scenario under every
// entry its tags name.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkPack, entryView, resolveSuite, type LoadedPack } from "../src/index.js";
import { copyPack, editJson } from "./helpers.js";

async function load(dir: string): Promise<LoadedPack> {
	const r = await checkPack(dir);
	if (!r.ok) throw new Error(JSON.stringify(r.defects));
	return r.loaded;
}
const ids = async (dir: string, suite: string): Promise<string[]> => resolveSuite(await load(dir), suite).scenarios;

test("a suite resolves identically twice against an unchanged pack", async () => {
	const dir = copyPack();
	assert.deepEqual(await ids(dir, "all-orchard"), ["graft", "prune"]);
	assert.deepEqual(await ids(dir, "all-orchard"), await ids(dir, "all-orchard"));
	assert.deepEqual(await ids(dir, "pruning"), ["prune"]);
});

test("changing the suite's selection changes the list as the rule predicts", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "pack.json"), (j) => { j.suites[1].select = { anyTags: ["exercises:graft-rule"], scenarios: ["prune"] }; });
	assert.deepEqual(await ids(dir, "pruning"), ["graft", "prune"]);
});

test("changing a scenario's tags changes the list as the rule predicts", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "scenarios", "graft.json"), (j) => { j.tags.push("exercises:prune-rule"); });
	assert.deepEqual(await ids(dir, "pruning"), ["graft", "prune"]);
	editJson(path.join(dir, "scenarios", "graft.json"), (j) => { j.tags = ["exercises:graft-rule"]; });
	assert.deepEqual(await ids(dir, "all-orchard"), ["prune"]);
});

test("adding a scenario changes the list as the rule predicts", async () => {
	const dir = copyPack();
	fs.writeFileSync(path.join(dir, "scenarios", "harvest.json"), JSON.stringify({
		id: "harvest", tags: ["orchard"], fixture: null, task: "Say when to pick the plums.",
		properties: [{ id: "harvest-1", type: "comprehension", decidedBy: "judge", key: "Late summer.", scale: [0, 1] }],
	}));
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.scenarios.push("scenarios/harvest.json"); });
	assert.deepEqual(await ids(dir, "all-orchard"), ["graft", "prune", "harvest"]);
	assert.deepEqual(await ids(dir, "pruning"), ["prune"]);
});

test("removing a scenario changes the list as the rule predicts", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.scenarios = ["scenarios/prune.json"]; });
	assert.deepEqual(await ids(dir, "all-orchard"), ["prune"]);
});

test("the entry view lists every scenario under every entry its tags name", async () => {
	const view = entryView(await load(copyPack()));
	assert.deepEqual(Object.fromEntries(view), { "graft-rule": ["graft"], "prune-rule": ["prune"] });
});
