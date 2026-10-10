// Criterion E1: one fixture per listed check, each with exactly that defect, each rejected with
// the defect named; the synthetic pack is accepted. Removing a check from the checker leaves its
// fixture accepted, which this test reports as a failure - so every check is shown load-bearing.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PACK_CHECKS, checkPack, type CheckId } from "../src/index.js";
import { copyPack, editJson, syntheticPack } from "./helpers.js";

const packJson = (d: string): string => path.join(d, "pack.json");
const expJson = (d: string): string => path.join(d, "experiments", "orchard.json");
const graft = (d: string): string => path.join(d, "scenarios", "graft.json");

// Several checks have more than one part; each part has its own fixture, so removing any part of a
// check, not only the whole check, leaves a fixture accepted.
const defects: Record<CheckId, ((dir: string) => void)[]> = {
	"pack-file": [(d) => fs.rmSync(packJson(d))],
	"schema-version": [(d) => editJson(packJson(d), (j) => { j.schema = "context-lab.pack/2"; })],
	"shape": [
		(d) => editJson(packJson(d), (j) => { j.sources[0].addresses = "https://example.invalid/almanac"; }),
		(d) => editJson(packJson(d), (j) => { delete j.records; }),
		(d) => editJson(graft(d), (j) => { delete j.task; }),
		(d) => editJson(packJson(d), (j) => { j.colour = "green"; }),
		(d) => editJson(graft(d), (j) => { j.properties[0].type = "taste"; }),
		(d) => editJson(expJson(d), (j) => { j.runsPerCell = 0; }),
	],
	"slug-ids": [
		(d) => editJson(packJson(d), (j) => { j.suites[0].id = "All-Orchard"; }),
		(d) => editJson(packJson(d), (j) => { j.id = "Orchard"; }),
	],
	"unique-ids": [
		(d) => editJson(packJson(d), (j) => { j.isolation.leakProbes.push({ ...j.isolation.leakProbes[0] }); }),
		(d) => {
			fs.writeFileSync(path.join(d, "scenarios", "graft-copy.json"), fs.readFileSync(graft(d)));
			editJson(expJson(d), (j) => { j.scenarios.push("scenarios/graft-copy.json"); });
		},
	],
	"source-path": [(d) => editJson(packJson(d), (j) => { j.sources[0].path = "no-such-dir"; })],
	"contained-paths": [
		(d) => editJson(packJson(d), (j) => { j.sources[0].exclude = ["../elsewhere"]; }),
		(d) => editJson(packJson(d), (j) => { j.arms[1].deliver[0].file = "../GUIDE.md"; }),
		(d) => editJson(packJson(d), (j) => { j.hooks[2].file = "../pack/hooks/count.mjs"; }),
		(d) => editJson(path.join(d, "scenarios", "prune.json"), (j) => { j.fixture = { files: { "../escape.txt": "x" } }; }),
		(d) => editJson(graft(d), (j) => { j.scoredFile = "/etc/passwd"; }),
		(d) => editJson(graft(d), (j) => { j.fixture = "../outside-fixture"; }),
		(d) => editJson(packJson(d), (j) => { j.sources[0].exclude = ["."]; }),
	],
	"variant-source": [(d) => editJson(packJson(d), (j) => { j.variants[0].source = "ghost"; })],
	"variant-transform": [(d) => editJson(packJson(d), (j) => { j.variants[0].transform = "count-words"; })],
	"arm-variant": [(d) => editJson(packJson(d), (j) => { j.arms[1].deliver[0].variant = "ghost"; })],
	"hook-file": [(d) => editJson(packJson(d), (j) => { j.hooks[2].file = "hooks/no-such-hook.mjs"; })],
	"experiment-file": [(d) => editJson(packJson(d), (j) => { j.experiments.push("experiments/no-such.json"); })],
	"experiment-refs": [
		(d) => editJson(expJson(d), (j) => { j.factors.arms.push("ghost"); }),
		(d) => editJson(expJson(d), (j) => { j.factors.population.push("ghost"); }),
	],
	"scenario-file": [(d) => editJson(expJson(d), (j) => { j.scenarios.push("scenarios/no-such.json"); })],
	"fixture-dir": [
		(d) => editJson(graft(d), (j) => { j.fixture = "fixtures/no-such"; }),
		(d) => fs.symlinkSync(path.join(d, "no-such-target.txt"), path.join(d, "fixtures", "graft", "BROKEN.txt")),
		(d) => fs.symlinkSync(path.join(d, "scenarios", "graft.json"), path.join(d, "fixtures", "graft", "KEY.json")),
		(d) => { fs.mkdirSync(path.join(d, "fixtures", "graft", "sub")); fs.symlinkSync("..", path.join(d, "fixtures", "graft", "sub", "up")); },
	],
	"probe-arms": [(d) => editJson(packJson(d), (j) => { j.isolation.leakProbes[0].arms = ["ghost"]; })],
	"property-measure": [
		(d) => editJson(graft(d), (j) => { j.properties[0].measure = "count-words"; }),
		(d) => editJson(graft(d), (j) => { delete j.properties[1].measure; }),
		(d) => editJson(graft(d), (j) => { j.properties[1].measure = "trim"; }),
	],
	"scale": [(d) => editJson(graft(d), (j) => { j.properties[0].scale = [1, 0]; })],
	"suite-experiment": [(d) => editJson(packJson(d), (j) => { j.suites[0].experiment = "ghost"; })],
	"suite-nonempty": [(d) => editJson(packJson(d), (j) => { j.suites[1].select = { allTags: ["no-such-tag"] }; })],
	"regex": [
		(d) => editJson(packJson(d), (j) => { j.masks.identifiers.push("("); }),
		(d) => editJson(packJson(d), (j) => { j.isolation.leakProbes[0].leak = "[unclosed"; }),
	],
	"one-declaration-check": [(d) => editJson(packJson(d), (j) => { j.hooks.push({ ...j.hooks[0], id: "check-decl-2" }); })],
	"declaration-check": [
		(d) => fs.writeFileSync(path.join(d, "hooks", "check.mjs"),
			'import fs from "node:fs"; fs.readFileSync(0, "utf8"); console.log(JSON.stringify({ defects: [{ where: "orchard", message: "planted defect" }] }));\n'),
		(d) => fs.writeFileSync(path.join(d, "hooks", "check.mjs"),
			'import fs from "node:fs"; fs.readFileSync(0, "utf8"); console.log(JSON.stringify({ verdict: "fine" }));\n'),
	],
};

test("the synthetic pack is accepted", async () => {
	const r = await checkPack(syntheticPack);
	assert.deepEqual(r.defects, []);
	assert.equal(r.ok, true);
});

test("every listed check has a defect fixture", () => {
	assert.deepEqual(Object.keys(defects).sort(), Object.keys(PACK_CHECKS).sort());
});

for (const check of Object.keys(PACK_CHECKS) as CheckId[]) {
	defects[check].forEach((defect, n) => {
		test(`a pack whose only defect is ${check} (part ${n + 1}) is rejected, naming it`, async () => {
			const dir = copyPack();
			defect(dir);
			const r = await checkPack(dir);
			assert.equal(r.ok, false, `the ${check} fixture was accepted`);
			assert.ok(r.defects.length > 0);
			for (const d of r.defects) assert.equal(d.check, check, `expected only ${check}, got ${d.check}: ${d.where} ${d.message}`);
		});
	});
}

test("a defect a declaration-check hook returns is reported as it was written", async () => {
	const dir = copyPack();
	(defects["declaration-check"][0] as (d: string) => void)(dir);
	const r = await checkPack(dir);
	assert.deepEqual(r.defects, [{ check: "declaration-check", where: "orchard", message: "planted defect" }]);
});
