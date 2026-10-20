// B20: the model-free preview renders what a run hands its readers and judges. A run is made with
// scripted runtimes, then a preview of the same pack with the same response and seed, through
// adapters that fail if invoked; the reader prompts and invocations, the extraction, the units and
// the judges' first and retry prompts must be the run's.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	CANARY_QUESTION, conductRun, previewRun,
	type Adapter, type CellRecord, type Invocation, type Outcome, type PreparedInvocation,
} from "../src/index.js";
import { commitAll, copyPack, editJson, isJudgePrompt, judgeReply, scratch } from "./helpers.js";

function outcome(final: string): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null" };
}

const RESPONSE = "### Q1\nThe rootstock is quince, as the guide says.\n## Aside\nAn aside under a heading no question names.\n";

/** A runtime for the run: it answers readers with RESPONSE, and judges - answering only the first item of a two-answer prompt, so the run asks again. */
function live(runtime: string): Adapter & { calls: Invocation[] } {
	const calls: Invocation[] = [];
	return {
		runtime, rulesFiles: ["AGENTS.md"], modes: runtime === "codex" ? ["inline", "stdin"] : ["inline", "attachment"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null, calls,
		async invoke(inv) {
			calls.push(inv);
			if (inv.prompt === CANARY_QUESTION) return outcome(inv.arm.canaries.join("\n") || "NONE");
			if (inv.tools === "off" && isJudgePrompt(inv.prompt)) {
				if (inv.prompt.includes("--- answer a2 ---")) return outcome(JSON.stringify({ item: "a1", score: 2, reason: "r" }));
				return outcome(judgeReply(inv.prompt, 1));
			}
			if (inv.tools === "off") return outcome("I do not know.");
			return outcome(RESPONSE);
		},
	};
}

/** A runtime for the preview: it records what it is asked to prepare, and fails if anything invokes it. */
function previewing(runtime: string): Adapter & { prepared: Invocation[]; invoked: number } {
	const a = { ...live(runtime), prepared: [] as Invocation[], invoked: 0 };
	a.invoke = async () => { a.invoked++; throw new Error("a preview invoked a runtime"); };
	a.prepare = (inv: Invocation): PreparedInvocation => {
		a.prepared.push(inv);
		return {
			runtime, command: ["stub"], env: {}, stdin: null, cwd: inv.workspace, mounts: { install: "stub", writable: [inv.work], readOnly: [] },
			prompt: { text: inv.prompt, delivery: inv.mode, wrapper: null, bytes: Buffer.byteLength(inv.prompt, "utf8") }, files: [], notRendered: [], outsideControl: [],
		};
	};
	return a;
}

test("a preview renders the run's reader prompts and invocations, extraction, units and first and retry judge prompts, and invokes nothing (B20)", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.runsPerCell = 1; j.scenarios = ["scenarios/graft.json"]; j.judging = { outcomesPerPrompt: 6 }; });
	editJson(path.join(dir, "pack.json"), (j) => { j.suites = j.suites.filter((s: { id: string; experiment: string }) => s.experiment === "orchard" && s.id !== "pruning"); });
	editJson(path.join(dir, "scenarios", "graft.json"), (j) => {
		j.answerSource = "final";
		delete j.scoredFile;
		j.properties = [
			{ id: "Q1", type: "comprehension", decidedBy: "judge", key: "quince", scale: [0, 2], answerHeading: "Q1", question: "Rootstock?", judgedWith: ["delivered"] },
			{ id: "G", type: "adherence", decidedBy: "judge", key: "Names the rootstock.", scale: [0, 1] },
		];
	});
	commitAll(dir);
	const oc = live("opencode"), cx = live("codex");
	const { dir: rd, record } = await conductRun(dir, { experiment: "orchard", adapters: { opencode: oc, codex: cx }, work: path.join(scratch(), "w"), records: path.join(scratch(), "r"), parallel: 1 });
	const poc = previewing("opencode"), pcx = previewing("codex");
	const out = path.join(scratch(), "preview");
	const p = await previewRun(dir, "orchard", { adapters: { opencode: poc, codex: pcx }, out, response: RESPONSE, seed: record.seed });

	// Nothing was invoked.
	assert.equal(poc.invoked + pcx.invoked, 0);
	assert.ok(fs.existsSync(path.join(out, "PREVIEW.json")) && fs.existsSync(path.join(out, "PREVIEW.md")));

	// Readers: the run's prompt, and the same invocation but for the folders a run generates.
	const cells = record.cells.map((c) => JSON.parse(fs.readFileSync(path.join(rd, "cells", `${c}.json`), "utf8")) as CellRecord);
	assert.equal(p.readers.length, cells.length);
	const shape = (inv: Invocation) => ({ mode: inv.mode, tools: inv.tools, member: inv.member.id, arm: inv.arm.arm, instructions: inv.arm.instructions.map((i) => [i.variant, i.file]), onRequest: inv.arm.onRequest.length, timeLimitSeconds: inv.timeLimitSeconds, prompt: inv.prompt });
	for (const c of cells) {
		const r = p.readers.find((x) => x.cell === c.cell)!;
		assert.equal(r.prompt, c.attempts[0]!.phases![0]!.prompt, `${c.cell} prompt`);
		const liveInv = [...oc.calls, ...cx.calls].find((i) => i.tools === "on" && i.member.id === c.member && i.arm.arm === c.arm)!;
		const prevInv = [...poc.prepared, ...pcx.prepared].find((i) => i.tools === "on" && i.member.id === c.member && i.arm.arm === c.arm)!;
		assert.deepEqual(shape(prevInv), shape(liveInv), `${c.cell} invocation`);
		// Extraction: the same record, including the aside cut away at an unrequested heading.
		assert.deepEqual(p.answers.find((a) => a.cell === c.cell && a.property === "Q1")!.extraction, c.extraction!["Q1"]);
	}
	assert.deepEqual(cells[0]!.extraction!["Q1"]!.findings, ["ended-at-unrequested-heading"]);

	// Judges: the run's units and jobs, and each job's first prompt; and where the run asked again, its retry.
	const units = (JSON.parse(fs.readFileSync(path.join(rd, "sealed", "units.json"), "utf8")) as { units: { id: string; cell: string; properties: string[] }[] }).units;
	const liveJobs = fs.readdirSync(path.join(rd, "judging")).filter((f) => f.endsWith(".json") && f !== "votes.json").map((f) => ({ name: f.replace(/\.json$/, ""), ...(JSON.parse(fs.readFileSync(path.join(rd, "judging", f), "utf8")) as { prompt: string; replies: { attempt: number; prompt: string; local: Record<string, string> }[] }) }));
	assert.deepEqual(p.judges.map((j) => j.name).sort(), liveJobs.map((j) => j.name).sort());
	let retries = 0;
	for (const j of p.judges) {
		const l = liveJobs.find((x) => x.name === j.name)!;
		assert.equal(j.first.prompt, l.prompt, `${j.name} first prompt`);
		assert.deepEqual(j.first.local, l.replies[0]!.local, `${j.name} first labels`);
		for (const u of j.units) assert.deepEqual(units.find((x) => x.id === u.id), { ...units.find((x) => x.id === u.id)!, cell: u.cell, properties: u.properties });
		const second = l.replies.find((r) => r.attempt === 2);
		if (second && j.retry) {
			retries++;
			assert.equal(j.retry.prompt, second.prompt, `${j.name} retry prompt`);
			assert.deepEqual(j.retry.local, second.local, `${j.name} retry labels`);
		}
	}
	assert.ok(retries > 0, "no job of the run asked again, so no retry was compared");
	// The reading and the answer stay apart in the judges' prompts: found by the label of a unit from the
	// arm that has a reading, since which unit comes first depends on the seed, the run id.
	let separated = 0;
	for (const j of p.judges.filter((x) => x.name.includes(".answers."))) {
		for (const [label, id] of Object.entries(j.first.local)) {
			if (!j.units.find((u) => u.id === id)!.cell.includes(".almanac.")) continue;
			const block = j.first.prompt.slice(j.first.prompt.indexOf(`--- answer ${label} ---`));
			assert.match(block, new RegExp(`^--- answer ${label} ---\\n--- ASSIGNED READING ---\\n[\\s\\S]+?\\n--- ANSWER ---\\nThe rootstock is quince, as the guide says\\.\\n`));
			separated++;
		}
	}
	assert.ok(separated > 0, "no answer with an assigned reading was checked");
	// Judge invocations as a run makes them: tools off, the empty arm, the judge's mode.
	for (const inv of [...poc.prepared, ...pcx.prepared].filter((i) => i.tools === "off")) {
		assert.equal(inv.arm.instructions.length + inv.arm.onRequest.length, 0);
		assert.equal(inv.mode, inv.member.runtime === "codex" ? "stdin" : "attachment");
	}
	// What a run generates is named, not filled in.
	assert.ok(p.generated.length > 0 && p.notRendered.length > 0);
	assert.equal(p.status.status, "exploration");
});

test("a preview refuses a folder that is not empty, and names a member whose runtime cannot prepare (B20)", async () => {
	const dir = copyPack();
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => { j.runsPerCell = 1; j.scenarios = ["scenarios/prune.json"]; });
	commitAll(dir);
	const out = path.join(scratch(), "full");
	fs.mkdirSync(out);
	fs.writeFileSync(path.join(out, "x"), "x");
	const noPrepare = (rt: string): Adapter => { const a = live(rt); delete (a as Partial<Adapter>).prepare; return a; };
	await assert.rejects(() => previewRun(dir, "orchard", { adapters: { opencode: previewing("opencode"), codex: previewing("codex") }, out }), /is not empty/);
	const p = await previewRun(dir, "orchard", { adapters: { opencode: previewing("opencode"), codex: noPrepare("codex") }, out: path.join(scratch(), "p") });
	assert.deepEqual(p.unsupported, [{ member: "p2", reason: "the codex adapter cannot prepare an invocation without running it" }]);
	assert.ok(p.readers.every((r) => r.member === "p1"));
	// The placeholder response answers every heading, so a preview needs no response to render the judges.
	assert.equal(p.response.given, false);
});
