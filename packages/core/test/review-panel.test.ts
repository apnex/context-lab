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

test("B31: runReview and publishRetainedWorkspace isolate dep-cache and scratch, exclude package-cache payloads, verify MANIFEST.json before atomic publication, preserve existing valid archives and original workspaces on fault, and cleanReviewWorkRoot honors active/preserved locks", async () => {
	const {
		cleanReviewWorkRoot,
		directoryAllocatedBytes,
		prepareIsolatedDepCache,
		publishRetainedWorkspace,
	} = await import("../src/index.js");
	const dir = copyPack();
	const sDir = scratch();
	const promptFile = path.join(sDir, "prompt-b31.md");
	fs.writeFileSync(promptFile, "Verify workspace {WORKSPACE} using scratch {SCRATCH} and dep-cache {DEP_CACHE}.\n");

	// Create a simulated shared read-only host npm cache (~/.npm) with a large payload in _cacache/content-v2.
	const fakeHostNpm = path.join(sDir, "host-npm");
	fs.mkdirSync(path.join(fakeHostNpm, "_cacache", "content-v2", "sha512", "ab"), { recursive: true });
	fs.mkdirSync(path.join(fakeHostNpm, "_cacache", "index-v5", "cd"), { recursive: true });
	const bigTarball = Buffer.alloc(64 * 1024, "T");
	fs.writeFileSync(path.join(fakeHostNpm, "_cacache", "content-v2", "sha512", "ab", "tarball.tgz"), bigTarball);
	fs.writeFileSync(path.join(fakeHostNpm, "_cacache", "index-v5", "cd", "idx.json"), '{"key":"pkg"}\n');

	// 1. Test prepareIsolatedDepCache links content-v2 without copying bytes and leaves _locks/_logs/_cacache/tmp writable.
	const isoCache = path.join(sDir, "iso-dep-cache");
	const prep = prepareIsolatedDepCache(isoCache, fakeHostNpm);
	assert.equal(prep.roMount, fs.realpathSync(fakeHostNpm));
	assert.equal(prep.env["npm_config_cache"], isoCache);
	assert.equal(prep.env["npm_config_prefer_offline"], "true");
	assert.equal(fs.lstatSync(path.join(isoCache, "_cacache", "content-v2")).isSymbolicLink(), true);
	assert.equal(directoryAllocatedBytes(isoCache), 0, "symlinked content-v2 must allocate 0 duplicate payload bytes");

	// 2. Repeated attempts retain declared evidence while excluding node_modules, .npm, npm-cache, _cacache, _npx, _prebuilds.
	const out1 = path.join(sDir, "out-clean");
	const workRoot1 = path.join(sDir, "work-root-1");
	const cachingAdapter = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "open", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			// Verify extraWritable and extraEnv carry isolated scratch and dep-cache outside workspace.
			assert.ok(inv.extraWritable && inv.extraWritable.length === 2);
			assert.ok(inv.extraEnv?.["npm_config_cache"]?.includes("dep-cache"));
			assert.ok(inv.extraEnv?.["TMPDIR"]?.includes("scratch"));
			// Write legitimate certification evidence AND simulated package-cache bloat inside workspace.
			fs.writeFileSync(path.join(inv.workspace, "cert.json"), JSON.stringify({ member: inv.member.id, ok: true }));
			fs.mkdirSync(path.join(inv.workspace, "node_modules", "pkg"), { recursive: true });
			fs.writeFileSync(path.join(inv.workspace, "node_modules", "pkg", "index.js"), "A".repeat(32768));
			fs.mkdirSync(path.join(inv.workspace, "npm-cache", "_cacache", "content-v2"), { recursive: true });
			fs.writeFileSync(path.join(inv.workspace, "npm-cache", "_cacache", "content-v2", "blob"), "B".repeat(32768));
			// Write scratch data in TMPDIR.
			fs.writeFileSync(path.join(inv.extraEnv!["TMPDIR"]!, "temp.bin"), "C".repeat(16384));
			return outcome('```json\n[{"id": "C1", "severity": "minor", "title": "Clean", "evidence": "cert.json", "fix": "none"}]\n```');
		},
	});
	const pkt1 = await runReview(dir, {
		promptFile,
		members: ["p1", "p2"],
		tools: "on",
		ro: [fakeHostNpm],
		outDir: out1,
		work: workRoot1,
		adapters: { opencode: cachingAdapter("opencode"), codex: cachingAdapter("codex") },
	});
	assert.equal(pkt1.archivalSummary?.allVerified, true);
	for (const m of ["p1", "p2"]) {
		const wsRet = path.join(out1, "workspaces", m);
		assert.equal(fs.existsSync(path.join(wsRet, "cert.json")), true);
		assert.equal(fs.existsSync(path.join(wsRet, "MANIFEST.json")), true);
		assert.equal(fs.existsSync(path.join(wsRet, "node_modules")), false, "node_modules must not enter retained evidence");
		assert.equal(fs.existsSync(path.join(wsRet, "npm-cache")), false, "npm-cache must not enter retained evidence");
		const reply = pkt1.replies.find((r) => r.member === m)!;
		assert.equal(reply.archival?.status, "verified");
		assert.ok(reply.archival?.excludedPaths.includes("node_modules"));
		assert.ok(reply.archival?.excludedPaths.includes("npm-cache"));
	}

	// 3. Fault injection: checksum corruption before verification refuses publication, preserves existing valid publication on replacement failure, and preserves original workspace when work is omitted.
	// First, verify out1/workspaces/p1 has valid content from pkt1.
	const origManifest = fs.readFileSync(path.join(out1, "workspaces", "p1", "MANIFEST.json"), "utf8");
	const pktFault = await runReview(dir, {
		promptFile,
		members: ["p1", "p2"],
		tools: "on",
		outDir: out1,
		// Omit `work` so default workDir cleanup in `finally` would run if not guarded!
		archivalFaultHook: (stage, ctx) => {
			if (stage === "before-verify" && ctx.member === "p1") {
				// Corrupt staged file after copy to trigger SHA-256 verification failure.
				fs.writeFileSync(path.join(ctx.stagingDir, "cert.json"), "CORRUPTED");
			}
		},
		adapters: { opencode: cachingAdapter("opencode"), codex: cachingAdapter("codex") },
	});
	const p1Fault = pktFault.replies.find((r) => r.member === "p1")!;
	assert.equal(p1Fault.archival?.status, "failed");
	assert.match(p1Fault.archival?.error ?? "", /verification failed: staged file cert\.json/);
	assert.equal(p1Fault.archival?.preservedPreviousValid, true, "prior valid publication must remain intact when replacement verification fails");
	assert.equal(fs.readFileSync(path.join(out1, "workspaces", "p1", "MANIFEST.json"), "utf8"), origManifest);
	assert.equal(pktFault.archivalSummary?.allVerified, false);
	assert.equal(pktFault.archivalSummary?.workDirPreserved, true);
	assert.ok(pktFault.archivalSummary?.workDir && fs.existsSync(pktFault.archivalSummary.workDir), "default workDir must be preserved when archival fails");
	assert.equal(fs.existsSync(path.join(p1Fault.archival!.originalWorkspace, "cert.json")), true, "original workspace evidence must still exist on disk");

	// 4. Storage bounds: maxWorkspaceBytes refusal preserves original workspace and leaves no partial archive.
	const outBound = path.join(sDir, "out-bound");
	const pktBound = await runReview(dir, {
		promptFile,
		members: ["p1", "p2"],
		tools: "on",
		outDir: outBound,
		storageLimits: { maxWorkspaceBytes: 10 }, // cert.json is > 10 bytes
		adapters: { opencode: cachingAdapter("opencode"), codex: cachingAdapter("codex") },
	});
	assert.equal(pktBound.archivalSummary?.allVerified, false);
	for (const r of pktBound.replies) {
		assert.equal(r.archival?.status, "failed");
		assert.match(r.archival?.error ?? "", /exceeds maxWorkspaceBytes/);
		assert.equal(fs.existsSync(path.join(outBound, "workspaces", r.member)), false, "no partial archive may be published on maxWorkspaceBytes failure");
		assert.equal(fs.existsSync(path.join(r.archival!.originalWorkspace, "cert.json")), true, "sole original workspace must be preserved");
	}

	// 5. cleanReviewWorkRoot skips active PIDs, unowned folders, and failed-preserved folders (until includeFailedPreserved: true).
	const cleanRoot = path.join(sDir, "clean-root");
	const activeDir = path.join(cleanRoot, "review-active");
	const preservedDir = pktFault.archivalSummary!.workDir!;
	const preservedCopy = path.join(cleanRoot, path.basename(preservedDir));
	const retiredDir = path.join(cleanRoot, "review-retired");
	const unownedDir = path.join(cleanRoot, "review-unowned");
	fs.mkdirSync(activeDir, { recursive: true });
	fs.writeFileSync(path.join(activeDir, "LOCK.json"), JSON.stringify({ owner: "context-lab", kind: "review", pid: process.pid, startedAt: new Date().toISOString(), outDir: out1 }));
	fs.writeFileSync(path.join(activeDir, "ACTIVE"), `${process.pid}\n`);
	fs.cpSync(preservedDir, preservedCopy, { recursive: true });
	fs.mkdirSync(retiredDir, { recursive: true });
	fs.writeFileSync(path.join(retiredDir, "LOCK.json"), JSON.stringify({ owner: "context-lab", kind: "review", pid: 999999, startedAt: new Date().toISOString(), outDir: out1 }));
	fs.mkdirSync(unownedDir, { recursive: true });

	const c1 = cleanReviewWorkRoot(cleanRoot);
	assert.deepEqual(c1.removed, [retiredDir]);
	assert.deepEqual(c1.skippedActive, [activeDir]);
	assert.deepEqual(c1.skippedPreserved, [preservedCopy]);
	assert.deepEqual(c1.skippedUnowned, [unownedDir]);

	const c2 = cleanReviewWorkRoot(cleanRoot, { includeFailedPreserved: true });
	assert.deepEqual(c2.removed, [preservedCopy]);

	// Clean up preserved default workDirs created during the test.
	fs.rmSync(preservedDir, { recursive: true, force: true });
	if (pktBound.archivalSummary?.workDir) fs.rmSync(pktBound.archivalSummary.workDir, { recursive: true, force: true });

	// 6. Test publishRetainedWorkspace explicit retainPaths override.
	const srcWs = path.join(sDir, "src-ws-retain");
	const dstWs = path.join(sDir, "dst-ws-retain");
	fs.mkdirSync(path.join(srcWs, ".cache", "keep"), { recursive: true });
	fs.writeFileSync(path.join(srcWs, ".cache", "keep", "proof.txt"), "kept\n");
	fs.writeFileSync(path.join(srcWs, "other.txt"), "dropped\n");
	const pub = publishRetainedWorkspace({
		member: "p1",
		sourceDir: srcWs,
		destDir: dstWs,
		scratchPath: sDir,
		depCachePath: null,
		retainPaths: [".cache/keep"],
	});
	assert.equal(pub.status, "verified");
	assert.equal(fs.existsSync(path.join(dstWs, ".cache", "keep", "proof.txt")), true);
	assert.equal(fs.existsSync(path.join(dstWs, "other.txt")), false);

	// 7. Invalid storageLimits (NaN, 0, negative, float) are rejected before dispatch.
	const { recoverInterruptedPublication, validateReviewStorageLimits } = await import("../src/index.js");
	for (const bad of [Number.NaN, 0, -5, 1.5, Number.POSITIVE_INFINITY]) {
		assert.throws(() => validateReviewStorageLimits({ maxWorkspaceBytes: bad }), TypeError);
		assert.throws(() => validateReviewStorageLimits({ maxTotalRetainedBytes: bad }), TypeError);
		assert.throws(() => validateReviewStorageLimits({ maxDepCacheBytes: bad }), TypeError);
	}
	assert.throws(() => validateReviewStorageLimits({ minFreeBytes: -1 }), TypeError);

	// 8. Interrupted replacement recovery: if a dead-PID .backup-<member>-<pid>-<ts> with a verified MANIFEST.json + payload exists and destDir is missing,
	// recoverInterruptedPublication skips payload-damaged backups, restores the verified backup to destDir, cleans owned dead-PID .staging-*/.backup-* dirs,
	// and preserves unowned directories (such as .staging-p1-manual-notes).
	const intParent = path.join(sDir, "interrupted-parent");
	const intDest = path.join(intParent, "p1");
	const intSource = path.join(sDir, "int-source");
	fs.mkdirSync(intSource, { recursive: true });
	fs.writeFileSync(path.join(intSource, "proof.txt"), "prior valid\n");
	assert.equal(publishRetainedWorkspace({ member: "p1", sourceDir: intSource, destDir: intDest, scratchPath: sDir, depCachePath: null }).status, "verified");
	const intGoodBackup = path.join(intParent, ".backup-p1-999999-1000");
	const intDamagedBackup = path.join(intParent, ".backup-p1-999999-2000");
	const intStaging = path.join(intParent, ".staging-p1-999999-1000");
	const intUnownedNumericStaging = path.join(intParent, ".staging-p1-999999-3000");
	const intUnowned = path.join(intParent, ".staging-p1-manual-notes");
	fs.renameSync(intDest, intGoodBackup);
	fs.cpSync(intGoodBackup, intDamagedBackup, { recursive: true });
	fs.unlinkSync(path.join(intDamagedBackup, "proof.txt"));
	fs.mkdirSync(intStaging, { recursive: true });
	fs.writeFileSync(path.join(intStaging, ".context-lab-owner.json"), JSON.stringify({ owner: "context-lab", kind: "staging", member: "p1", pid: 999999, timestamp: 1000, createdAt: new Date().toISOString() }));
	fs.writeFileSync(path.join(intStaging, "partial.txt"), "abandoned\n");
	fs.mkdirSync(intUnownedNumericStaging, { recursive: true });
	fs.writeFileSync(path.join(intUnownedNumericStaging, "notes.txt"), "numeric but no owner metadata\n");
	fs.mkdirSync(intUnowned, { recursive: true });
	fs.writeFileSync(path.join(intUnowned, "notes.txt"), "keep me\n");
	const rec = recoverInterruptedPublication(intDest, "p1");
	assert.equal(rec.restoredFromBackup, true);
	assert.equal(fs.existsSync(path.join(intDest, "MANIFEST.json")), true);
	assert.equal(fs.existsSync(path.join(intDest, "proof.txt")), true);
	assert.equal(fs.existsSync(intUnowned), true, "unowned directory without numeric <pid>-<ts> must survive");
	assert.equal(fs.existsSync(intUnownedNumericStaging), true, "numeric staging directory without .context-lab-owner.json must survive");
	assert.deepEqual(fs.readdirSync(intParent).filter((n) => n.startsWith(".")).sort(), [".staging-p1-999999-3000", ".staging-p1-manual-notes"]);

	// 9. Invocation-local preload visibility inside runSandboxed, zero process.env.NODE_OPTIONS mutation, and byte-faithful ENOSPC refusal.
	const { runSandboxed } = await import("../src/index.js");
	const origNodeOpts = process.env["NODE_OPTIONS"] ?? null;
	const sandboxAdapter = (runtime: string): Adapter => ({
		runtime, rulesFiles: ["AGENTS.md"], modes: ["inline"], network: "detected", filesystem: "sandboxed", continue: false,
		compaction: { onDemand: false, instructionsAfterCompaction: "unknown" }, refuse: () => null,
		async invoke(inv: Invocation) {
			fs.mkdirSync(inv.work, { recursive: true });
			// Run a child Node process inside real bwrap (`runSandboxed`) with the invocation's mounts and env:
			// (a) an in-budget write (100 bytes <= 1024) succeeds with exact bytes;
			// (b) an over-budget write (2048 bytes > 1024) throws ENOSPC without shortening the existing 100-byte file.
			const script = [
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				'const cacheFile = path.join(process.env.npm_config_cache, "exact.bin");',
				'fs.writeFileSync(cacheFile, Buffer.alloc(100, "A"));',
				'let code = null;',
				'try { fs.writeFileSync(cacheFile, Buffer.alloc(2048, "B")); } catch (e) { code = e.code; }',
				'console.log(JSON.stringify({ sizeAfter: fs.statSync(cacheFile).size, code }));',
			].join(" ");
			const res = await runSandboxed({
				install: fs.realpathSync(process.execPath),
				writable: [inv.work, inv.workspace, ...(inv.extraWritable ?? [])],
				readOnly: inv.arm.onRequest.map((o) => o.path),
				home: path.join(inv.work, "home"),
				cwd: inv.workspace,
				command: [process.execPath, "-e", script],
				env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...(inv.extraEnv ?? {}) },
				stdin: null,
				timeLimitSeconds: 10,
			});
			assert.equal(res.exit, 0, res.stderr);
			const parsed = JSON.parse(res.lines[0]!.text) as { sizeAfter: number; code: string | null };
			assert.equal(parsed.code, "ENOSPC");
			assert.equal(parsed.sizeAfter, 100, "failed over-budget write must not shorten or overwrite the valid 100-byte file");
			return outcome("```json\n[]\n```");
		},
	});
	const pktSandbox = await runReview(dir, {
		promptFile,
		members: ["p1", "p2"],
		parallel: 2,
		tools: "on",
		outDir: path.join(sDir, "out-sandbox-quota"),
		work: path.join(sDir, "work-sandbox-quota"),
		storageLimits: { maxDepCacheBytes: 1024 },
		adapters: { opencode: sandboxAdapter("opencode"), codex: sandboxAdapter("codex") },
	});
	assert.equal(process.env["NODE_OPTIONS"] ?? null, origNodeOpts, "parent process.env.NODE_OPTIONS must never be mutated");
	assert.equal(pktSandbox.archivalSummary?.allVerified, false, "recorded ENOSPC violation must fail archival");
});
