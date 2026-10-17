// Delta-3 stage 3: on-demand multi-model review orchestration (B18, criteria G7-G8).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	checkPack, parseReviewFindings, runReview, selectReviewMembers,
	type Adapter, type Invocation, type Outcome,
} from "../src/index.js";
import { copyPack, editJson, packageRoot, scratch } from "./helpers.js";

function outcome(final: string): Outcome {
	return { final, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0.1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "/dev/null" };
}

test("G7: ARCHITECTURE-TARGET.md absorbs 0025/0026/B18, and runReview refuses < 2 families, runs in isolated read-only mode, parses JSON findings, verifies across families (F_v != F_r), and counts supportingFamilies", async () => {
	// 1. Check ARCHITECTURE-TARGET.md sections 2, 3, 5, 6 and 9.
	const targetDoc = fs.readFileSync(path.resolve(packageRoot, "..", "..", "docs", "ARCHITECTURE-TARGET.md"), "utf8");
	assert.match(targetDoc, /On-demand multi-model review/);
	assert.match(targetDoc, /\*\*Review panel\*\*/);
	assert.match(targetDoc, /\| Review packet \|/);
	assert.match(targetDoc, /\*\*CLOSED\*\* \(`0024`, `B2`\)/);
	assert.match(targetDoc, /\*\*CLOSED\*\* \(`0024`, `B3`\)/);

	// 2. Refuse < 2 families.
	const dir = copyPack();
	// Add a second member of family f1 ("p1b") so we can also test same-family deduplication.
	editJson(path.join(dir, "pack.json"), (j) => {
		j.population.push({ id: "p1b", family: "f1", runtime: "opencode", model: "m1b" });
	});
	const checked = await checkPack(dir);
	if (!checked.ok) throw new Error("pack invalid");
	assert.throws(() => selectReviewMembers(checked.loaded, ["p1", "p1b"]), /at least 2 distinct model families/);

	// Default selection picks 1 member per distinct family (p1, p2, p3).
	assert.deepEqual(selectReviewMembers(checked.loaded).map((m) => m.id), ["p1", "p2", "p3"]);

	// 3. parseReviewFindings parses fenced JSON blocks, handles preceding ```ts blocks, and short-circuits on [].
	const parsed = parseReviewFindings('Prose first.\n```ts\nconst x = [1, 2];\n```\n```json\n[{"id": "F1", "severity": "blocking", "title": "Leak", "evidence": "line 10", "fix": "close it"}]\n```\n');
	assert.deepEqual(parsed, [{ id: "F1", severity: "blocking", title: "Leak", evidence: "line 10", fix: "close it" }]);
	assert.deepEqual(parseReviewFindings('```json\n[]\n```\nLater prose: [{"id": "phantom", "title": "no"}]'), []);

	// 4. Full runReview with --verify across 3 families (plus a second f1 member p1b to verify same-family counting).
	const sDir = scratch();
	const promptFile = path.join(sDir, "prompt.md");
	const targetFile = path.join(sDir, "artifact.md");
	fs.writeFileSync(promptFile, "Review the artifact for defects.\n");
	fs.writeFileSync(targetFile, "# Artifact\nLine 1: some claim.\n");

	const invocations: Invocation[] = [];
	const reviewAdapter = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			invocations.push(inv);
			assert.equal(inv.tools, "off", "review invocations must run with tools off");
			// Check that the mounted review-files directory is read-only (0o555).
			for (const o of inv.arm.onRequest) {
				assert.equal(fs.statSync(o.path).mode & 0o222, 0, "mounted review files dir must not be writable");
			}
			if (inv.prompt.includes("=== FINDINGS TO VERIFY ===")) {
				// Verifier pass: support p1:F1 and p1b:F1b, reject p2:F2.
				const items = [...inv.prompt.matchAll(/^- ([a-z0-9]+:F[0-9a-z]+) /gm)].map((m) => m[1]!);
				return outcome("```json\n" + JSON.stringify(items.map((item) => ({
					item,
					supports: item !== "p2:F2",
					reason: item !== "p2:F2" ? "confirmed in artifact" : "not supported",
				}))) + "\n```");
			}
			// Reviewer pass.
			if (inv.member.id === "p1") {
				return outcome('```json\n[{"id": "F1", "severity": "blocking", "title": "Supported defect", "evidence": "Line 1", "fix": "Fix line 1"}]\n```');
			}
			if (inv.member.id === "p2") {
				return outcome('```json\n[{"id": "F2", "severity": "minor", "title": "Unsupported defect", "evidence": "Line 1", "fix": "None"}]\n```');
			}
			return outcome("```json\n[]\n```");
		},
	});

	const outDir = path.join(sDir, "out");
	const packet = await runReview(dir, {
		promptFile,
		files: [targetFile],
		members: ["p1", "p2", "p3"],
		verify: true,
		outDir,
		work: path.join(sDir, "work"),
		adapters: { opencode: reviewAdapter("opencode"), codex: reviewAdapter("codex") },
		parallel: 2,
	});
	assert.equal(packet.verified, true);
	assert.equal(packet.replies.length, 3);
	assert.equal(packet.findings.length, 2);

	const f1 = packet.findings.find((f) => f.item === "p1:F1")!;
	const f2 = packet.findings.find((f) => f.item === "p2:F2")!;
	// Proposer p1 is f1; verifiers are from both other families (f2 and f3), and both supported it -> supportingFamilies = ["f1", "f2", "f3"], familyCount = 3.
	assert.equal(f1.verdicts.length, 2);
	assert.ok(f1.verdicts.every((v) => v.verifierFamily !== f1.proposerFamily));
	assert.deepEqual(f1.supportingFamilies, ["f1", "f2", "f3"]);
	assert.equal(f1.familyCount, 3);

	// Proposer p2 is f2; verifiers (f1 and f3) rejected it -> supportingFamilies = ["f2"], familyCount = 1.
	assert.equal(f2.verdicts.length, 2);
	assert.ok(f2.verdicts.every((v) => v.verifierFamily !== f2.proposerFamily));
	assert.deepEqual(f2.supportingFamilies, ["f2"]);
	assert.equal(f2.familyCount, 1);

	assert.equal(fs.existsSync(path.join(outDir, "REVIEW.json")), true);
	assert.equal(fs.existsSync(path.join(outDir, "REVIEW.md")), true);
});
