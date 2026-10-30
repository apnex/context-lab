// review-panel - orchestrates an on-demand review prompt across members of distinct model families
// and optionally cross-verifies their findings (architecture section 5, principles P1, P3, P6, P8;
// Delta-3 stage 3, rulings 0025/0026, B18, criteria G7-G8).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Adapter, DeliveryMode, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import { checkPack } from "./pack-checker.js";
import type { LoadedPack, Member } from "./pack-schema.js";
import { isInside } from "./paths.js";
import { makeReadOnly, makeWritable } from "./variant-builder.js";
import { createWorkspace } from "./workspace-builder.js";

/** Default directory basenames excluded from retained review workspaces so package caches and dependency trees are never duplicated into evidence (0041, B31). */
export const DEFAULT_EXCLUDED_RETENTION_DIRS = [
	"node_modules",
	".npm",
	"npm-cache",
	"_cacache",
	"_npx",
	"_prebuilds",
	".pnpm-store",
	".yarn",
	".cache",
] as const;

export interface ArchiveEntry {
	path: string;
	kind: "file" | "symlink";
	bytes: number;
	sha256: string | null;
	target: string | null;
}

export interface WorkspaceArchiveManifest {
	member: string;
	createdAt: string;
	totalBytes: number;
	entryCount: number;
	excludedPaths: string[];
	entries: ArchiveEntry[];
	manifestSha256: string;
}

export interface WorkspaceArchivalResult {
	status: "verified" | "failed" | "skipped";
	retainedPath: string | null;
	originalWorkspace: string;
	scratchPath: string;
	depCachePath: string | null;
	bytes: number;
	entryCount: number;
	manifestSha256: string | null;
	excludedPaths: string[];
	preservedPreviousValid: boolean;
	error: string | null;
}

export type ReviewSeverity = "blocking" | "should-fix" | "minor";

export interface ExtractedFinding {
	id: string;
	severity: ReviewSeverity;
	title: string;
	evidence: string;
	fix: string;
}

export interface ReviewerReply {
	member: string;
	family: string;
	runtime: string;
	model: string;
	raw: string;
	findings: ExtractedFinding[];
	seconds: number;
	error: string | null;
	/** Separate archival outcome for tools-enabled workspaces; invocation success never implies archival success (0041, B31). */
	archival?: WorkspaceArchivalResult;
}

export interface ReviewVerdict {
	item: string; // "<member>:<id>"
	proposer: string;
	proposerFamily: string;
	verifier: string;
	verifierFamily: string;
	supports: boolean;
	reason: string;
}

export interface AggregatedFinding extends ExtractedFinding {
	item: string;
	proposer: string;
	proposerFamily: string;
	verdicts: ReviewVerdict[];
	supportingFamilies: string[];
	familyCount: number;
}

export interface ReviewPacket {
	pack: string;
	createdAt: string;
	promptFile: string;
	files: string[];
	tools?: "on" | "off";
	sockets?: boolean;
	members: { id: string; family: string; runtime: string; model: string }[];
	verified: boolean;
	replies: ReviewerReply[];
	findings: AggregatedFinding[];
	/** Summary of workspace archival when tools === "on"; if any member failed archival, workDirPreserved is true and workDir names the preserved original working folder (0041, B31). */
	archivalSummary?: {
		allVerified: boolean;
		totalRetainedBytes: number;
		workDirPreserved: boolean;
		workDir: string | null;
		failedMembers: string[];
	};
}

export interface ReviewStorageLimits {
	/** Maximum retained bytes for a single reviewer workspace (default 256 MiB). */
	maxWorkspaceBytes?: number;
	/** Maximum aggregate retained bytes across all reviewer workspaces in this runReview call (default 1 GiB). */
	maxTotalRetainedBytes?: number;
	/** Minimum available bytes required on the destination filesystem before and during archival (default 1 GiB). */
	minFreeBytes?: number;
	/** Maximum bytes allowed in a per-attempt writable dependency cache (default 512 MiB). */
	maxDepCacheBytes?: number;
}

export interface ReviewOptions {
	promptFile: string;
	files?: string[];
	members?: string[];
	verify?: boolean;
	tools?: "on" | "off";
	sockets?: boolean;
	mountSources?: boolean;
	ro?: string[];
	/** Optional read-only host npm cache (e.g. ~/.npm) whose content-v2 store is linked into a separate per-attempt writable dep-cache outside the retained workspace (0041, B31). */
	npmCacheSource?: string;
	/** Optional relative paths inside {WORKSPACE} to retain explicitly (or to allow even if inside an excluded directory name). */
	retainPaths?: string[];
	/** Optional additional directory or file basenames to exclude from retained workspace copies. */
	excludeNames?: string[];
	/** Optional storage bounds for workspace retention and dependency caches (0041, B31). */
	storageLimits?: ReviewStorageLimits;
	/** Optional fault injection hook for deterministic testing of disk-full, permission, interruption, or corruption failures during archival. */
	archivalFaultHook?: (stage: "before-copy" | "after-copy" | "before-verify" | "before-swap", ctx: { member: string; sourceDir: string; stagingDir: string; destDir: string }) => void;
	outDir: string;
	work?: string;
	adapters: Record<string, Adapter>;
	parallel?: number;
	timeLimitSeconds?: number;
	now?: () => Date;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
	const q = items.slice();
	await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (q.length) await fn(q.shift()!); }));
}

function sha256File(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function availableBytesAt(dir: string): number | null {
	try {
		const target = fs.existsSync(dir) ? dir : path.dirname(dir);
		const st = fs.statfsSync(target);
		return Number(st.bavail) * Number(st.bsize);
	} catch {
		return null;
	}
}

export function directoryAllocatedBytes(dir: string): number {
	if (!fs.existsSync(dir)) return 0;
	let total = 0;
	const walk = (cur: string): void => {
		for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
			const p = path.join(cur, ent.name);
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) total += st.size;
		}
	};
	walk(dir);
	return total;
}

/**
 * Prepares an offline-install-compatible npm cache directory outside `{WORKSPACE}` (0041, B31).
 * The directory is writable by the sandboxed agent (`_locks`, `_logs`, `_cacache/tmp` and index
 * updates succeed without `EROFS`), while `_cacache/content-v2` (and `index-v5` when present)
 * symlinks to the read-only host cache (`roSource`) so multi-gigabyte package tarballs are never
 * duplicated into the working folder or retained workspace.
 */
export function prepareIsolatedDepCache(depCacheDir: string, roSource?: string): { dir: string; roMount: string | null; env: Record<string, string> } {
	fs.mkdirSync(path.join(depCacheDir, "_cacache", "tmp"), { recursive: true });
	fs.mkdirSync(path.join(depCacheDir, "_locks"), { recursive: true });
	fs.mkdirSync(path.join(depCacheDir, "_logs"), { recursive: true });
	let roMount: string | null = null;
	if (roSource !== undefined && fs.existsSync(roSource)) {
		const resolvedRo = fs.realpathSync(roSource);
		roMount = resolvedRo;
		const contentV2 = path.join(resolvedRo, "_cacache", "content-v2");
		if (fs.existsSync(contentV2)) {
			fs.symlinkSync(contentV2, path.join(depCacheDir, "_cacache", "content-v2"));
		} else {
			fs.mkdirSync(path.join(depCacheDir, "_cacache", "content-v2"), { recursive: true });
		}
		const indexV5 = path.join(resolvedRo, "_cacache", "index-v5");
		if (fs.existsSync(indexV5)) {
			// Copy only lightweight index-v5 metadata entries or symlink individual buckets so new index writes can land in depCacheDir.
			fs.symlinkSync(indexV5, path.join(depCacheDir, "_cacache", "index-v5"));
		} else {
			fs.mkdirSync(path.join(depCacheDir, "_cacache", "index-v5"), { recursive: true });
		}
	} else {
		fs.mkdirSync(path.join(depCacheDir, "_cacache", "content-v2"), { recursive: true });
		fs.mkdirSync(path.join(depCacheDir, "_cacache", "index-v5"), { recursive: true });
	}
	return {
		dir: depCacheDir,
		roMount,
		env: {
			npm_config_cache: depCacheDir,
			NPM_CONFIG_CACHE: depCacheDir,
			npm_config_prefer_offline: "true",
			npm_config_audit: "false",
			npm_config_fund: "false",
			npm_config_update_notifier: "false",
		},
	};
}

export interface PublishWorkspaceOptions {
	member: string;
	sourceDir: string;
	destDir: string;
	scratchPath: string;
	depCachePath: string | null;
	retainPaths?: string[];
	excludeNames?: string[];
	maxWorkspaceBytes?: number;
	maxTotalRetainedBytes?: number;
	currentTotalRetainedBytes?: number;
	minFreeBytes?: number;
	now?: () => Date;
	faultHook?: ReviewOptions["archivalFaultHook"];
}

/**
 * Copies declared/retained files from `sourceDir` (`{WORKSPACE}`) into a staging folder beside
 * `destDir`, excluding `.git` and package-cache/dependency payload directories by default (unless
 * explicitly listed in `retainPaths`), enforces per-workspace, aggregate, and free-space bounds,
 * writes and verifies a complete SHA-256 `MANIFEST.json`, and atomically swaps the verified tree
 * into `destDir` while preserving any prior valid `destDir` if staging or verification fails (0041, B31).
 */
export function publishRetainedWorkspace(opts: PublishWorkspaceOptions): WorkspaceArchivalResult {
	const maxWs = opts.maxWorkspaceBytes ?? 256 * 1024 * 1024;
	const maxTotal = opts.maxTotalRetainedBytes ?? 1024 * 1024 * 1024;
	const minFree = opts.minFreeBytes ?? 0;
	const currentTotal = opts.currentTotalRetainedBytes ?? 0;
	const excludedSet = new Set<string>([".git", ...DEFAULT_EXCLUDED_RETENTION_DIRS, ...(opts.excludeNames ?? [])]);
	const explicitRetain = (opts.retainPaths ?? []).map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
	const parentDir = path.dirname(opts.destDir);
	fs.mkdirSync(parentDir, { recursive: true });
	const stagingDir = path.join(parentDir, `.staging-${opts.member}-${process.pid}-${Date.now()}`);
	const backupDir = path.join(parentDir, `.backup-${opts.member}-${process.pid}-${Date.now()}`);
	const hadPreviousValid = fs.existsSync(path.join(opts.destDir, "MANIFEST.json"));
	const excludedPaths: string[] = [];
	const entries: ArchiveEntry[] = [];
	let totalBytes = 0;

	const isExplicitlyRetained = (rel: string): boolean =>
		explicitRetain.some((r) => rel === r || rel.startsWith(`${r}/`) || r.startsWith(`${rel}/`));

	const shouldExclude = (rel: string, name: string): boolean => {
		if (name === ".git") return true;
		if (isExplicitlyRetained(rel)) return false;
		if (excludedSet.has(name)) return true;
		if (explicitRetain.length > 0 && !explicitRetain.some((r) => rel === r || rel.startsWith(`${r}/`) || r.startsWith(`${rel}/`))) {
			return true;
		}
		return false;
	};

	try {
		if (minFree > 0) {
			const avail = availableBytesAt(parentDir);
			if (avail !== null && avail < minFree) {
				throw new Error(`available disk space (${avail} bytes) is below minFreeBytes (${minFree} bytes) before archiving ${opts.member}`);
			}
		}
		fs.rmSync(stagingDir, { recursive: true, force: true });
		fs.mkdirSync(stagingDir, { recursive: true });
		opts.faultHook?.("before-copy", { member: opts.member, sourceDir: opts.sourceDir, stagingDir, destDir: opts.destDir });

		const walkAndCopy = (relDir: string): void => {
			const absDir = relDir ? path.join(opts.sourceDir, relDir) : opts.sourceDir;
			const dirEntries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
			for (const ent of dirEntries) {
				const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
				if (shouldExclude(rel, ent.name)) {
					excludedPaths.push(rel);
					continue;
				}
				const srcPath = path.join(opts.sourceDir, rel);
				const dstPath = path.join(stagingDir, rel);
				const st = fs.lstatSync(srcPath);
				if (st.isSymbolicLink()) {
					const linkTarget = fs.readlinkSync(srcPath);
					const resolvedTarget = path.resolve(path.dirname(srcPath), linkTarget);
					if (!isInside(resolvedTarget, opts.sourceDir)) {
						excludedPaths.push(`${rel} (external symlink)`);
						continue;
					}
					fs.mkdirSync(path.dirname(dstPath), { recursive: true });
					fs.symlinkSync(linkTarget, dstPath);
					entries.push({ path: rel, kind: "symlink", bytes: 0, sha256: null, target: linkTarget });
				} else if (st.isDirectory()) {
					walkAndCopy(rel);
				} else if (st.isFile()) {
					if (totalBytes + st.size > maxWs) {
						throw new Error(`retained workspace for ${opts.member} (${totalBytes + st.size} bytes) exceeds maxWorkspaceBytes (${maxWs} bytes)`);
					}
					if (currentTotal + totalBytes + st.size > maxTotal) {
						throw new Error(`aggregate retained workspaces (${currentTotal + totalBytes + st.size} bytes) exceed maxTotalRetainedBytes (${maxTotal} bytes)`);
					}
					if (minFree > 0) {
						const avail = availableBytesAt(parentDir);
						if (avail !== null && avail - st.size < minFree) {
							throw new Error(`available disk space (${avail} bytes) would fall below minFreeBytes (${minFree} bytes) while copying ${rel}`);
						}
					}
					fs.mkdirSync(path.dirname(dstPath), { recursive: true });
					fs.copyFileSync(srcPath, dstPath);
					const srcSha = sha256File(srcPath);
					totalBytes += st.size;
					entries.push({ path: rel, kind: "file", bytes: st.size, sha256: srcSha, target: null });
				}
			}
		};

		walkAndCopy("");
		opts.faultHook?.("after-copy", { member: opts.member, sourceDir: opts.sourceDir, stagingDir, destDir: opts.destDir });
		opts.faultHook?.("before-verify", { member: opts.member, sourceDir: opts.sourceDir, stagingDir, destDir: opts.destDir });

		// Verify every staged entry against its source record before writing MANIFEST.json or publishing.
		for (const e of entries) {
			const stagedPath = path.join(stagingDir, e.path);
			if (!fs.existsSync(stagedPath) && e.kind !== "symlink") {
				throw new Error(`verification failed: staged entry ${e.path} is missing`);
			}
			const st = fs.lstatSync(stagedPath);
			if (e.kind === "symlink") {
				if (!st.isSymbolicLink() || fs.readlinkSync(stagedPath) !== e.target) {
					throw new Error(`verification failed: staged symlink ${e.path} target mismatch`);
				}
			} else {
				if (!st.isFile() || st.size !== e.bytes) {
					throw new Error(`verification failed: staged file ${e.path} size ${st.size} !== ${e.bytes}`);
				}
				const stagedSha = sha256File(stagedPath);
				if (stagedSha !== e.sha256) {
					throw new Error(`verification failed: staged file ${e.path} sha256 ${stagedSha} !== ${e.sha256}`);
				}
			}
		}

		const createdAt = (opts.now ?? (() => new Date()))().toISOString();
		const manifestBody = {
			member: opts.member,
			createdAt,
			totalBytes,
			entryCount: entries.length,
			excludedPaths,
			entries,
		};
		const manifestSha256 = createHash("sha256").update(JSON.stringify(manifestBody), "utf8").digest("hex");
		const manifest: WorkspaceArchiveManifest = { ...manifestBody, manifestSha256 };
		fs.writeFileSync(path.join(stagingDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

		opts.faultHook?.("before-swap", { member: opts.member, sourceDir: opts.sourceDir, stagingDir, destDir: opts.destDir });

		// Atomic replacement preserving existing valid publication if rename fails.
		const hadDest = fs.existsSync(opts.destDir);
		if (hadDest) {
			fs.rmSync(backupDir, { recursive: true, force: true });
			fs.renameSync(opts.destDir, backupDir);
		}
		try {
			fs.renameSync(stagingDir, opts.destDir);
		} catch (swapErr) {
			if (hadDest && fs.existsSync(backupDir) && !fs.existsSync(opts.destDir)) {
				try { fs.renameSync(backupDir, opts.destDir); } catch { /* best-effort restore */ }
			}
			throw swapErr;
		}
		if (hadDest && fs.existsSync(backupDir)) {
			fs.rmSync(backupDir, { recursive: true, force: true });
		}

		return {
			status: "verified",
			retainedPath: opts.destDir,
			originalWorkspace: opts.sourceDir,
			scratchPath: opts.scratchPath,
			depCachePath: opts.depCachePath,
			bytes: totalBytes,
			entryCount: entries.length,
			manifestSha256,
			excludedPaths,
			preservedPreviousValid: false,
			error: null,
		};
	} catch (err) {
		fs.rmSync(stagingDir, { recursive: true, force: true });
		const preservedPreviousValid = hadPreviousValid && fs.existsSync(path.join(opts.destDir, "MANIFEST.json"));
		return {
			status: "failed",
			retainedPath: preservedPreviousValid ? opts.destDir : null,
			originalWorkspace: opts.sourceDir,
			scratchPath: opts.scratchPath,
			depCachePath: opts.depCachePath,
			bytes: 0,
			entryCount: 0,
			manifestSha256: null,
			excludedPaths,
			preservedPreviousValid,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export interface LockMarker {
	owner: "context-lab";
	kind: "review" | "run";
	pid: number;
	startedAt: string;
	outDir: string;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Safely cleans retired `review-*` working directories under `workRoot` while skipping:
 * (1) any directory not carrying a `context-lab` ownership marker (`LOCK.json`),
 * (2) any directory whose `LOCK.json` names a still-alive PID, and
 * (3) any directory carrying `PRESERVE_ON_FAILURE.json` (an unarchived failed run whose original workspace must be kept until explicitly disposed of) unless `opts.includeFailedPreserved` is true (0041, B31).
 */
export function cleanReviewWorkRoot(workRoot: string, opts: { includeFailedPreserved?: boolean } = {}): { removed: string[]; skippedActive: string[]; skippedPreserved: string[]; skippedUnowned: string[] } {
	const removed: string[] = [];
	const skippedActive: string[] = [];
	const skippedPreserved: string[] = [];
	const skippedUnowned: string[] = [];
	if (!fs.existsSync(workRoot)) return { removed, skippedActive, skippedPreserved, skippedUnowned };
	for (const ent of fs.readdirSync(workRoot, { withFileTypes: true })) {
		if (!ent.isDirectory() || !ent.name.startsWith("review-")) continue;
		const dir = path.join(workRoot, ent.name);
		const lockFile = path.join(dir, "LOCK.json");
		if (!fs.existsSync(lockFile)) {
			skippedUnowned.push(dir);
			continue;
		}
		let lock: LockMarker | null = null;
		try {
			lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockMarker;
		} catch {
			skippedUnowned.push(dir);
			continue;
		}
		if (lock?.owner !== "context-lab") {
			skippedUnowned.push(dir);
			continue;
		}
		if (fs.existsSync(path.join(dir, "ACTIVE")) && isProcessAlive(lock.pid)) {
			skippedActive.push(dir);
			continue;
		}
		if (fs.existsSync(path.join(dir, "PRESERVE_ON_FAILURE.json")) && !opts.includeFailedPreserved) {
			skippedPreserved.push(dir);
			continue;
		}
		makeWritable(dir);
		fs.rmSync(dir, { recursive: true, force: true });
		removed.push(dir);
	}
	return { removed, skippedActive, skippedPreserved, skippedUnowned };
}

/** Extracts the JSON findings array from a reviewer's raw reply. */
export function parseReviewFindings(raw: string): ExtractedFinding[] {
	const fenced: string[] = [];
	// Match each fenced block independently so ```ts ... ``` before ```json ... ``` cannot pair across blocks.
	for (const m of raw.matchAll(/```([^\n`]*)\n([\s\S]*?)\n```/g)) {
		const info = (m[1] ?? "").trim().toLowerCase();
		if ((info === "" || info === "json") && m[2]) fenced.push(m[2].trim());
	}
	const tryBlocks = (blocks: string[]): ExtractedFinding[] | null => {
		let sawEmpty = false;
		for (const c of blocks) {
			try {
				const parsed = JSON.parse(c) as unknown;
				const arr = Array.isArray(parsed)
					? parsed
					: parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings)
						? (parsed as { findings: unknown[] }).findings
						: null;
				if (!arr) continue;
				if (arr.length === 0) { sawEmpty = true; continue; }
				const out: ExtractedFinding[] = [];
				for (const item of arr) {
					if (!item || typeof item !== "object") continue;
					const o = item as Record<string, unknown>;
					if (typeof o["id"] !== "string" || typeof o["title"] !== "string") continue;
					const rawSev = typeof o["severity"] === "string" ? o["severity"].trim().toLowerCase() : "";
					const sev: ReviewSeverity =
						rawSev === "blocking" || rawSev === "high" || rawSev === "critical"
							? "blocking"
							: rawSev === "should-fix" || rawSev === "medium" || rawSev === "major" || rawSev === "material"
								? "should-fix"
								: "minor";
					out.push({
						id: o["id"],
						severity: sev,
						title: o["title"],
						evidence: typeof o["evidence"] === "string" ? o["evidence"] : "",
						fix: typeof o["fix"] === "string" ? o["fix"] : "",
					});
				}
				if (out.length > 0) return out;
			} catch {
				// Try next candidate block.
			}
		}
		return sawEmpty ? [] : null;
	};
	const fromFenced = tryBlocks(fenced);
	if (fromFenced !== null) return fromFenced;
	const firstBracket = raw.indexOf("["), lastBracket = raw.lastIndexOf("]");
	if (firstBracket >= 0 && lastBracket > firstBracket) {
		return tryBlocks([raw.slice(firstBracket, lastBracket + 1)]) ?? [];
	}
	return [];
}

function parseVerdictList(raw: string): { item: string; supports: boolean; reason: string }[] {
	const fenced: string[] = [];
	for (const m of raw.matchAll(/```([^\n`]*)\n([\s\S]*?)\n```/g)) {
		const info = (m[1] ?? "").trim().toLowerCase();
		if ((info === "" || info === "json") && m[2]) fenced.push(m[2].trim());
	}
	const tryBlocks = (blocks: string[]): { item: string; supports: boolean; reason: string }[] | null => {
		let sawEmpty = false;
		for (const c of blocks) {
			try {
				const parsed = JSON.parse(c) as unknown;
				const arr = Array.isArray(parsed)
					? parsed
					: parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { verdicts?: unknown }).verdicts)
						? (parsed as { verdicts: unknown[] }).verdicts
						: null;
				if (!arr) continue;
				if (arr.length === 0) { sawEmpty = true; continue; }
				const res: { item: string; supports: boolean; reason: string }[] = [];
				for (const v of arr) {
					if (!v || typeof v !== "object") continue;
					const o = v as Record<string, unknown>;
					if (typeof o["item"] === "string" && typeof o["supports"] === "boolean") {
						res.push({ item: o["item"], supports: o["supports"], reason: typeof o["reason"] === "string" ? o["reason"] : "" });
					}
				}
				if (res.length > 0) return res;
			} catch {
				// continue
			}
		}
		return sawEmpty ? [] : null;
	};
	const fromFenced = tryBlocks(fenced);
	if (fromFenced !== null) return fromFenced;
	const fallbacks: string[] = [];
	const fb = raw.indexOf("["), lb = raw.lastIndexOf("]");
	if (fb >= 0 && lb > fb) fallbacks.push(raw.slice(fb, lb + 1));
	const fo = raw.indexOf("{"), lo = raw.lastIndexOf("}");
	if (fo >= 0 && lo > fo) fallbacks.push(raw.slice(fo, lo + 1));
	return tryBlocks(fallbacks) ?? [];
}

/** Selects the reviewer members from the pack and verifies at least 2 distinct families are present. */
export function selectReviewMembers(loaded: LoadedPack, memberIds?: string[]): Member[] {
	let members: Member[];
	if (memberIds && memberIds.length > 0) {
		const uniqueIds = [...new Set(memberIds)];
		members = uniqueIds.map((id) => {
			const m = loaded.pack.population.find((p) => p.id === id);
			if (!m) throw new Error(`no member ${id} in pack ${loaded.pack.id}`);
			return m;
		});
	} else {
		// Default: first member of each distinct family in pack.population.
		const seenFamilies = new Set<string>();
		members = [];
		for (const m of loaded.pack.population) {
			if (!seenFamilies.has(m.family)) {
				seenFamilies.add(m.family);
				members.push(m);
			}
		}
	}
	const families = new Set(members.map((m) => m.family));
	if (families.size < 2) {
		throw new Error(`context-lab review requires members from at least 2 distinct model families, found ${families.size}`);
	}
	return members;
}

export function reviewMarkdown(packet: ReviewPacket): string {
	const lines = [
		`# Multi-model review (${packet.pack})`, "",
		`Created: ${packet.createdAt}. Verified across families: **${packet.verified ? "yes" : "no"}**.`,
		`Models (${packet.members.length}, ${new Set(packet.members.map((m) => m.family)).size} families): ${packet.members.map((m) => `${m.id} (${m.family}, ${m.model})`).join(", ")}.`, "",
		"## Findings", "",
	];
	if (packet.findings.length === 0) {
		lines.push("No structured finding was reported.");
	} else {
		const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
		lines.push(
			"| Item | Severity | Proposer (family) | Supporting families | Count | Title |",
			"|---|---|---|---|---|---|",
			...packet.findings.map((f) => `| \`${esc(f.item)}\` | ${f.severity} | ${f.proposer} (${f.proposerFamily}) | ${f.supportingFamilies.join(", ")} | ${f.familyCount} | ${esc(f.title)} |`),
		);
	}
	lines.push("", "## Raw replies", "");
	for (const r of packet.replies) {
		lines.push(`### ${r.member} (${r.family} - ${r.model})`, "", r.raw.trim() || "(empty reply)", "");
	}
	return lines.join("\n") + "\n";
}

/**
 * Runs an on-demand review prompt across selected members of distinct model families in isolated
 * sandboxes, optionally runs a cross-family verification pass, and writes `REVIEW.json` and
 * `REVIEW.md` in `opts.outDir`.
 */
export async function runReview(packDir: string, opts: ReviewOptions): Promise<ReviewPacket> {
	const now = opts.now ?? (() => new Date());
	const checked = await checkPack(packDir);
	if (!checked.ok) throw new Error(`the pack fails its check: ${checked.defects.map((d) => `${d.check} ${d.where} ${d.message}`).join("; ")}`);
	const loaded = checked.loaded;
	const members = selectReviewMembers(loaded, opts.members);
	const promptText = fs.readFileSync(path.resolve(opts.promptFile), "utf8");
	const inputFiles = (opts.files ?? []).map((f) => path.resolve(f));
	for (const f of inputFiles) {
		if (!fs.existsSync(f)) throw new Error(`review file ${f} does not exist`);
	}
	const extraRo = (opts.ro ?? []).map((p) => path.resolve(p));
	for (const p of extraRo) {
		if (!fs.existsSync(p)) throw new Error(`read-only mount ${p} does not exist`);
	}
	const toolsMode: "on" | "off" = opts.tools ?? "off";
	if (opts.sockets && toolsMode !== "on") {
		throw new Error("--sockets requires --tools on");
	}
	const sourcePaths = opts.mountSources
		? loaded.pack.sources.map((s) => path.resolve(loaded.dir, s.path)).filter((p) => fs.existsSync(p))
		: [];

	const workRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
	fs.mkdirSync(workRoot, { recursive: true });
	const workDir = fs.mkdtempSync(path.join(workRoot, "review-"));
	const outDir = path.resolve(opts.outDir);
	fs.mkdirSync(outDir, { recursive: true });
	const lockMarker: LockMarker = { owner: "context-lab", kind: "review", pid: process.pid, startedAt: now().toISOString(), outDir };
	fs.writeFileSync(path.join(workDir, "LOCK.json"), JSON.stringify(lockMarker, null, 2) + "\n");
	fs.writeFileSync(path.join(workDir, "ACTIVE"), `${process.pid}\n`);

	// Detect if any --ro path is a host npm cache (e.g. ~/.npm) or if opts.npmCacheSource is provided.
	const roNpmSource = opts.npmCacheSource !== undefined
		? path.resolve(opts.npmCacheSource)
		: extraRo.find((p) => path.basename(p) === ".npm" || fs.existsSync(path.join(p, "_cacache", "content-v2")));

	// Copy any input files into a read-only folder mounted as onRequest when tools="on", and inline
	// their contents in the prompt when tools="off" (or when mountSources is not set) so tools="off"
	// invocations can read them directly without leaving a 0o555 directory behind if interrupted.
	const roFilesDir = path.join(workDir, "files");
	const fileBlobs: { name: string; content: string }[] = [];
	for (const [idx, f] of inputFiles.entries()) {
		const base = `${idx + 1}-${path.basename(f)}`;
		if (fs.statSync(f).isFile()) {
			const content = fs.readFileSync(f, "utf8");
			if (toolsMode === "on") {
				fs.mkdirSync(roFilesDir, { recursive: true });
				fs.writeFileSync(path.join(roFilesDir, base), content);
			}
			fileBlobs.push({ name: f, content });
		}
	}
	if (toolsMode === "on" && fs.existsSync(roFilesDir)) makeReadOnly(roFilesDir);

	const onRequest: { variant: string; path: string }[] = [
		...(toolsMode === "on" && fileBlobs.length ? [{ variant: "review-files", path: roFilesDir }] : []),
		...sourcePaths.map((p, i) => ({ variant: `source-${i + 1}`, path: p })),
		...extraRo.map((p, i) => ({ variant: `ro-${i + 1}`, path: p })),
	];
	if (roNpmSource !== undefined && fs.existsSync(roNpmSource) && !onRequest.some((o) => o.path === fs.realpathSync(roNpmSource))) {
		onRequest.push({ variant: "ro-npm-cache", path: fs.realpathSync(roNpmSource) });
	}

	const arm: ComposedArm = {
		arm: "review",
		instructions: [],
		folderFiles: [],
		onRequest,
		canaries: [],
		negativeCanaries: [],
		revisions: {},
	};

	const inlineFiles = toolsMode === "off" || !opts.mountSources;
	const filesBlock = inlineFiles && fileBlobs.length
		? ["", "=== FILES UNDER REVIEW ===", ...fileBlobs.map((b) => `--- FILE: ${b.name} ---\n${b.content}`)].join("\n")
		: "";

	const buildReviewerPrompt = (wsDir: string, scratchDir: string, depCacheDir: string): string => {
		const substituted = promptText.trim()
			.split("{WORKSPACE}").join(wsDir)
			.split("{SCRATCH}").join(scratchDir)
			.split("{DEP_CACHE}").join(depCacheDir)
			.split("{SOURCES}").join(sourcePaths.join(", "));
		return [
			substituted,
			filesBlock,
			"",
			"Emit your findings as a JSON array in a ```json fenced block of this exact shape (or [] if none):",
			'```json\n[{"id": "F1", "severity": "blocking", "title": "one-line summary", "evidence": "file/line or quote", "fix": "concrete fix"}]\n```',
			...(toolsMode === "off" ? ["Do not use any tools."] : []),
		].join("\n");
	};

	const replies: ReviewerReply[] = [];
	let preserveWorkOnFailure = false;
	let currentTotalRetainedBytes = 0;
	try {
		await pool(members, opts.parallel ?? 4, async (member) => {
			const adapter = opts.adapters[member.runtime];
			if (!adapter) throw new Error(`no adapter for runtime ${member.runtime}`);
			const mode: DeliveryMode = toolsMode === "on"
				? (adapter.modes.includes("inline") ? "inline" : adapter.modes[0]!)
				: (adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!);
			const ws = createWorkspace(loaded, { id: "review", tags: [], fixture: null, task: "", properties: [] }, arm, { base: path.join(workDir, "workspaces"), rulesFiles: adapter.rulesFiles });
			const scratchDir = path.join(workDir, "scratch", member.id);
			const depCacheDir = path.join(workDir, "dep-cache", member.id);
			fs.mkdirSync(scratchDir, { recursive: true });
			const depCache = toolsMode === "on" ? prepareIsolatedDepCache(depCacheDir, roNpmSource) : null;
			fs.mkdirSync(path.join(workDir, "invocations"), { recursive: true });
			const invDir = fs.mkdtempSync(path.join(workDir, "invocations", "r-"));
			fs.rmdirSync(invDir);
			const inv: Invocation = {
				arm, workspace: ws.dir, prompt: buildReviewerPrompt(ws.dir, scratchDir, depCacheDir), mode, member,
				tools: toolsMode, ...(opts.sockets ? { sockets: true } : {}),
				...(toolsMode === "on" ? {
					extraWritable: [scratchDir, depCacheDir],
					extraEnv: {
						TMPDIR: scratchDir,
						...(depCache ? depCache.env : {}),
					},
				} : {}),
				timeLimitSeconds: opts.timeLimitSeconds ?? 900, work: invDir,
			};
			const out = await adapter.invoke(inv);
			let archival: WorkspaceArchivalResult | undefined;
			if (toolsMode === "on") {
				const maxDepBytes = opts.storageLimits?.maxDepCacheBytes ?? 512 * 1024 * 1024;
				const depBytes = directoryAllocatedBytes(depCacheDir);
				if (depBytes > maxDepBytes) {
					preserveWorkOnFailure = true;
					archival = {
						status: "failed",
						retainedPath: null,
						originalWorkspace: ws.dir,
						scratchPath: scratchDir,
						depCachePath: depCacheDir,
						bytes: 0,
						entryCount: 0,
						manifestSha256: null,
						excludedPaths: [],
						preservedPreviousValid: fs.existsSync(path.join(outDir, "workspaces", member.id, "MANIFEST.json")),
						error: `dependency cache for ${member.id} (${depBytes} bytes) exceeded maxDepCacheBytes (${maxDepBytes} bytes)`,
					};
				} else {
					const retainedWs = path.join(outDir, "workspaces", member.id);
					archival = publishRetainedWorkspace({
						member: member.id,
						sourceDir: ws.dir,
						destDir: retainedWs,
						scratchPath: scratchDir,
						depCachePath: depCacheDir,
						...(opts.retainPaths !== undefined ? { retainPaths: opts.retainPaths } : {}),
						...(opts.excludeNames !== undefined ? { excludeNames: opts.excludeNames } : {}),
						...(opts.storageLimits?.maxWorkspaceBytes !== undefined ? { maxWorkspaceBytes: opts.storageLimits.maxWorkspaceBytes } : {}),
						...(opts.storageLimits?.maxTotalRetainedBytes !== undefined ? { maxTotalRetainedBytes: opts.storageLimits.maxTotalRetainedBytes } : {}),
						...(opts.storageLimits?.minFreeBytes !== undefined ? { minFreeBytes: opts.storageLimits.minFreeBytes } : {}),
						currentTotalRetainedBytes,
						now,
						...(opts.archivalFaultHook !== undefined ? { faultHook: opts.archivalFaultHook } : {}),
					});
					if (archival.status === "verified") {
						currentTotalRetainedBytes += archival.bytes;
						// Once workspace evidence is verified, clean the per-attempt scratch and dep-cache directories immediately.
						fs.rmSync(scratchDir, { recursive: true, force: true });
						fs.rmSync(depCacheDir, { recursive: true, force: true });
					} else {
						preserveWorkOnFailure = true;
					}
				}
				if (out.events && fs.existsSync(out.events)) {
					try {
						const eventsDir = path.join(outDir, "events");
						fs.mkdirSync(eventsDir, { recursive: true });
						fs.copyFileSync(out.events, path.join(eventsDir, `${member.id}.jsonl`));
					} catch (evErr) {
						preserveWorkOnFailure = true;
						if (archival && archival.status === "verified") {
							archival.status = "failed";
							archival.error = `events copy failed: ${evErr instanceof Error ? evErr.message : String(evErr)}`;
						}
					}
				}
			}
			replies.push({
				member: member.id, family: member.family, runtime: member.runtime, model: member.model,
				raw: out.final, findings: parseReviewFindings(out.final),
				seconds: out.cost.seconds, error: out.error?.message ?? null,
				...(archival !== undefined ? { archival } : {}),
			});
		});
		replies.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));

		const allFindings: AggregatedFinding[] = replies.flatMap((r) => {
			const seenIds = new Set<string>();
			return r.findings.map((f) => {
				let id = f.id;
				let suffix = 2;
				while (seenIds.has(id)) {
					id = `${f.id}-${suffix++}`;
				}
				seenIds.add(id);
				return {
					...f,
					id,
					item: `${r.member}:${id}`,
					proposer: r.member,
					proposerFamily: r.family,
					verdicts: [],
					supportingFamilies: [r.family],
					familyCount: 1,
				};
			});
		});

		if (opts.verify && allFindings.length > 0) {
			const families = [...new Set(members.map((m) => m.family))].sort();
			// One verifier member per distinct family, each verifying every finding from other families (F_v != F_r).
			const verifiers = families.map((fam) => members.find((m) => m.family === fam)!);
			const byVerifier = new Map<string, { verifier: Member; items: AggregatedFinding[] }>();
			for (const verifier of verifiers) {
				const items = allFindings.filter((f) => f.proposerFamily !== verifier.family);
				if (items.length > 0) byVerifier.set(verifier.id, { verifier, items });
			}
			await pool([...byVerifier.values()], opts.parallel ?? 4, async ({ verifier, items }) => {
				const adapter = opts.adapters[verifier.runtime];
				if (!adapter) throw new Error(`no adapter for verifier runtime ${verifier.runtime}`);
				const mode: DeliveryMode = adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!;
				const vPrompt = [
					"You are verifying review findings proposed by other model families against the prompt and files under review.",
					"For each finding item below, decide whether the evidence and prompt/files genuinely support the finding.",
					"",
					"=== ORIGINAL REVIEW PROMPT ===",
					promptText.trim(),
					filesBlock,
					"",
					"=== FINDINGS TO VERIFY ===",
					...items.map((it) => `- ${it.item} (${it.severity}): ${it.title} | Evidence: ${it.evidence} | Proposed fix: ${it.fix}`),
					"",
					"Do not use any tools. Reply with a JSON array in a ```json fenced block of this exact shape:",
					'```json\n[{"item": "<member>:<id>", "supports": true, "reason": "one sentence"}]\n```',
				].join("\n");
				const ws = createWorkspace(loaded, { id: "review-verify", tags: [], fixture: null, task: "", properties: [] }, arm, { base: path.join(workDir, "workspaces"), rulesFiles: adapter.rulesFiles });
				const invDir = fs.mkdtempSync(path.join(workDir, "invocations", "rv-"));
				fs.rmdirSync(invDir);
				const inv: Invocation = {
					arm, workspace: ws.dir, prompt: vPrompt, mode, member: verifier,
					tools: "off", timeLimitSeconds: opts.timeLimitSeconds ?? 900, work: invDir,
				};
				const out = await adapter.invoke(inv);
				const parsed = parseVerdictList(out.final);
				for (const it of items) {
					const pv = parsed.find((x) => x.item === it.item);
					const supports = pv?.supports ?? false;
					const verdict: ReviewVerdict = {
						item: it.item, proposer: it.proposer, proposerFamily: it.proposerFamily,
						verifier: verifier.id, verifierFamily: verifier.family,
						supports, reason: pv?.reason ?? "no verdict returned",
					};
					it.verdicts.push(verdict);
					it.verdicts.sort((a, b) => (a.verifier < b.verifier ? -1 : a.verifier > b.verifier ? 1 : 0));
					const famSet = new Set([it.proposerFamily, ...it.verdicts.filter((x) => x.supports).map((x) => x.verifierFamily)]);
					it.supportingFamilies = [...famSet].sort();
					it.familyCount = it.supportingFamilies.length;
				}
			});
		}

		const failedArchivalMembers = replies.filter((r) => r.archival && r.archival.status !== "verified").map((r) => r.member);
		if (failedArchivalMembers.length > 0) {
			preserveWorkOnFailure = true;
			fs.writeFileSync(path.join(workDir, "PRESERVE_ON_FAILURE.json"), JSON.stringify({
				createdAt: now().toISOString(),
				outDir,
				failedMembers: failedArchivalMembers,
				workspaces: Object.fromEntries(replies.filter((r) => r.archival).map((r) => [r.member, r.archival!.originalWorkspace])),
			}, null, 2) + "\n");
		}
		const packet: ReviewPacket = {
			pack: loaded.pack.id,
			createdAt: now().toISOString(),
			promptFile: path.resolve(opts.promptFile),
			files: inputFiles,
			...(toolsMode === "on" ? { tools: "on" } : {}),
			...(opts.sockets ? { sockets: true } : {}),
			members: members.map((m) => ({ id: m.id, family: m.family, runtime: m.runtime, model: m.model })),
			verified: Boolean(opts.verify),
			replies,
			findings: allFindings,
			...(toolsMode === "on" ? {
				archivalSummary: {
					allVerified: failedArchivalMembers.length === 0,
					totalRetainedBytes: currentTotalRetainedBytes,
					workDirPreserved: preserveWorkOnFailure || opts.work !== undefined,
					workDir: preserveWorkOnFailure || opts.work !== undefined ? workDir : null,
					failedMembers: failedArchivalMembers,
				},
			} : {}),
		};
		fs.writeFileSync(path.join(outDir, "REVIEW.json"), JSON.stringify(packet, null, 2) + "\n");
		fs.writeFileSync(path.join(outDir, "REVIEW.md"), reviewMarkdown(packet));
		return packet;
	} catch (runErr) {
		preserveWorkOnFailure = true;
		try {
			fs.writeFileSync(path.join(workDir, "PRESERVE_ON_FAILURE.json"), JSON.stringify({
				createdAt: now().toISOString(),
				outDir,
				error: runErr instanceof Error ? runErr.message : String(runErr),
			}, null, 2) + "\n");
		} catch { /* ignore */ }
		throw runErr;
	} finally {
		fs.rmSync(path.join(workDir, "ACTIVE"), { force: true });
		if (fs.existsSync(roFilesDir)) makeWritable(roFilesDir);
		if (opts.work === undefined && !preserveWorkOnFailure) {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	}
}
