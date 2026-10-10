// Criterion E7, its second half: no file under the core's source contains a literal frozen at
// stage 1 from mission-kit's pack. The first half - the tests pass with mission-kit's pack absent -
// holds because no test reads outside the synthetic pack.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { packageRoot } from "./helpers.js";

const frozen = JSON.parse(fs.readFileSync(path.join(packageRoot, "test", "fixtures", "mission-kit-literals.json"), "utf8")) as { literals: string[] };

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? sourceFiles(p) : [p];
	});
}

test("the core's source names nothing from mission-kit's pack", () => {
	const hits: string[] = [];
	for (const f of sourceFiles(path.join(packageRoot, "src"))) {
		const text = fs.readFileSync(f, "utf8");
		for (const l of frozen.literals) if (text.includes(l)) hits.push(`${path.relative(packageRoot, f)}: ${l}`);
	}
	assert.deepEqual(hits, []);
});
