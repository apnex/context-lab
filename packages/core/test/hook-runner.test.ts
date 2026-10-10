// Criterion E12, at stage 1: every hook kind runs under its contract. A hook that needs the
// network, reads outside its inputs, writes outside its folder, or runs past its time limit does
// not succeed, and a declaration-check hook that fails fails the pack. The failure results of the
// other two kinds are enacted by the components that call them, at stages 2 and 4.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HOOK_FAILURE_RESULT, HOOK_KINDS, checkPack, runHook, type Hook, type HookKind } from "../src/index.js";
import { copyPack, scratch } from "./helpers.js";

function hookIn(dir: string, kind: HookKind, body: string, timeLimitSeconds = 10): Hook {
	const file = `hook-${kind}.mjs`;
	fs.writeFileSync(path.join(dir, file), body);
	return { id: `h-${kind}`, kind, file, timeLimitSeconds };
}

const readInput = 'import fs from "node:fs"; const input = JSON.parse(fs.readFileSync(0, "utf8"));\n';

for (const kind of HOOK_KINDS) {
	test(`${kind}: a hook within its bounds succeeds and returns its output`, async () => {
		const dir = scratch();
		const inputs = scratch();
		const out = scratch();
		fs.writeFileSync(path.join(inputs, "given.txt"), "given");
		const h = hookIn(dir, kind, readInput + 'fs.writeFileSync(input.out + "/made.txt", fs.readFileSync(input.inputs + "/given.txt", "utf8")); console.log(JSON.stringify({ ok: input.n + 1 }));\n');
		const r = await runHook(dir, h, { n: 41, inputs, out }, { readable: [inputs], writable: out });
		assert.equal(r.ok, true, JSON.stringify(r));
		if (r.ok) assert.deepEqual(r.output, { ok: 42 });
		assert.equal(fs.readFileSync(path.join(out, "made.txt"), "utf8"), "given");
	});

	test(`${kind}: a hook that needs the network does not succeed`, async () => {
		const dir = scratch();
		const h = hookIn(dir, kind, readInput + 'const r = await fetch("https://github.com", { signal: AbortSignal.timeout(5000) }); console.log(JSON.stringify({ status: r.status }));\n');
		const r = await runHook(dir, h, {});
		assert.equal(r.ok, false);
	});

	test(`${kind}: a hook that reads outside its inputs does not succeed`, async () => {
		const dir = scratch();
		const elsewhere = scratch();
		fs.writeFileSync(path.join(elsewhere, "secret.txt"), "not given");
		const h = hookIn(dir, kind, readInput + 'console.log(JSON.stringify({ read: fs.readFileSync(input.secret, "utf8") }));\n');
		const r = await runHook(dir, h, { secret: path.join(elsewhere, "secret.txt") });
		assert.equal(r.ok, false);
	});

	test(`${kind}: a hook that writes outside its folder does not succeed, and writes nothing`, async () => {
		const dir = scratch();
		const readable = scratch();
		const h = hookIn(dir, kind, readInput + 'fs.writeFileSync(input.target, "x"); console.log("{}");\n');
		const target = path.join(readable, "written.txt");
		const r = await runHook(dir, h, { target }, { readable: [readable] });
		assert.equal(r.ok, false);
		assert.equal(fs.existsSync(target), false);
	});

	test(`${kind}: a hook past its time limit is stopped`, async () => {
		const dir = scratch();
		const h = hookIn(dir, kind, readInput + "setTimeout(() => console.log('{}'), 60000);\n", 1);
		const r = await runHook(dir, h, {});
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reason, "timeout");
	});

	test(`${kind}: its failure result is stated`, () => {
		assert.ok(HOOK_FAILURE_RESULT[kind].length > 0);
	});
}

test("a declaration-check hook that times out fails the pack", async () => {
	const dir = copyPack();
	fs.writeFileSync(path.join(dir, "hooks", "check.mjs"), "setTimeout(() => console.log('{\"defects\":[]}'), 60000);\n");
	const j = JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8"));
	j.hooks[0].timeLimitSeconds = 1;
	fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify(j));
	const r = await checkPack(dir);
	assert.equal(r.ok, false);
	assert.equal(r.defects[0]?.check, "declaration-check");
});
