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
			assert.equal(inv.arm.onRequest.length, 0, "tools='off' review invocations inline files and mount no 0o555 onRequest directory");
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

	// 5. Severity aliases (high/critical -> blocking; medium/major/material -> should-fix) and --tools on with --mount-sources, --ro, --timeout, and retained workspaces/events.
	const aliasParsed = parseReviewFindings('```json\n[{"id":"A1","severity":"high","title":"H"},{"id":"A2","severity":"critical","title":"C"},{"id":"A3","severity":"medium","title":"M"},{"id":"A4","severity":"major","title":"J"},{"id":"A5","severity":"material","title":"T"}]\n```');
	assert.deepEqual(aliasParsed.map((x) => x.severity), ["blocking", "blocking", "should-fix", "should-fix", "should-fix"]);

	const roExtra = path.join(sDir, "ro-extra");
	fs.mkdirSync(roExtra, { recursive: true });
	const toolsPrompt = path.join(sDir, "tools-prompt.md");
	fs.writeFileSync(toolsPrompt, "Inspect {SOURCES} and write {WORKSPACE}/cert.md.\n");
	const eventsSample = path.join(sDir, "sample-events.jsonl");
	fs.writeFileSync(eventsSample, '{"type":"turn"}\n');

	const toolsInvocations: Invocation[] = [];
	const toolsAdapter = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			toolsInvocations.push(inv);
			if (inv.tools === "on") {
				fs.writeFileSync(path.join(inv.workspace, "cert.md"), `certified by ${inv.member.id}\n`);
				return { ...outcome('```json\n[{"id": "T1", "severity": "high", "title": "Tool finding", "evidence": "cert.md", "fix": "none"}]\n```'), events: eventsSample };
			}
			return outcome("```json\n[]\n```");
		},
	});
	const outTools = path.join(sDir, "out-tools");
	await assert.rejects(
		() => runReview(dir, {
			promptFile: toolsPrompt,
			members: ["p1", "p2"],
			tools: "off",
			sockets: true,
			outDir: outTools,
			work: path.join(sDir, "work-tools-bad"),
			adapters: { opencode: toolsAdapter("opencode"), codex: toolsAdapter("codex") },
		}),
		/--sockets requires --tools on/,
	);
	const toolsPacket = await runReview(dir, {
		promptFile: toolsPrompt,
		members: ["p1", "p2"],
		tools: "on",
		sockets: true,
		mountSources: true,
		ro: [roExtra],
		timeLimitSeconds: 450,
		outDir: outTools,
		work: path.join(sDir, "work-tools"),
		adapters: { opencode: toolsAdapter("opencode"), codex: toolsAdapter("codex") },
	});
	assert.equal(toolsPacket.tools, "on");
	assert.equal(toolsPacket.sockets, true);
	assert.equal(toolsInvocations.length, 2);
	for (const inv of toolsInvocations) {
		assert.equal(inv.tools, "on");
		assert.equal(inv.sockets, true);
		assert.equal(inv.timeLimitSeconds, 450);
		assert.equal(inv.prompt.includes("Do not use any tools."), false);
		assert.ok(inv.prompt.includes(inv.workspace), "{WORKSPACE} must be substituted");
		assert.ok(inv.arm.onRequest.some((o) => o.path === roExtra), "--ro path must be mounted in arm.onRequest");
		assert.ok(inv.arm.onRequest.some((o) => o.variant.startsWith("source-")), "--mount-sources must mount pack sources in arm.onRequest");
	}
	assert.equal(fs.readFileSync(path.join(outTools, "workspaces", "p1", "cert.md"), "utf8").trim(), "certified by p1");
	assert.equal(fs.readFileSync(path.join(outTools, "events", "p1.jsonl"), "utf8").trim(), '{"type":"turn"}');
	assert.equal(toolsPacket.findings[0]?.severity, "blocking");
});
