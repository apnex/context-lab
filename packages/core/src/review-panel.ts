// review-panel - orchestrates an on-demand review prompt across members of distinct model families
// and optionally cross-verifies their findings (architecture section 5, principles P1, P3, P6, P8;
// Delta-3 stage 3, rulings 0025/0026, B18, criteria G7-G8).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
	/** Maximum aggregate owned working + retained bytes across all active and preserved reviewer trees (ws + depCache + scratch + retained; default maxTotalRetainedBytes + 2 * maxDepCacheBytes). */
	maxTotalWorkingBytes?: number;
	/** When true, refuses before dispatch if the execution environment cannot enforce a kernel/write-time block ceiling on native non-Node binaries (0047, B31). */
	requireHardNativeQuota?: boolean;
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

/**
 * Resolves the available disk bytes at `dir` (walking up to the nearest existing ancestor when
 * `dir` and its immediate parent have not yet been created), returning `{ bytes, error }` so a
 * positive `minFreeBytes` requirement fails closed when `statfsSync` cannot complete (0049, B31).
 */
export function availableBytesAt(dir: string): { bytes: number | null; error: string | null } {
	try {
		let cur = path.resolve(dir);
		while (!fs.existsSync(cur)) {
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
		const st = fs.statfsSync(cur);
		const bytes = Number(st.bavail) * Number(st.bsize);
		if (!Number.isFinite(bytes) || bytes < 0) {
			return { bytes: null, error: `invalid statfs result (${String(bytes)}) at ${cur}` };
		}
		return { bytes, error: null };
	} catch (err) {
		return { bytes: null, error: err instanceof Error ? err.message : String(err) };
	}
}

export function directoryAllocatedBytes(dir: string, opts: { ignoreGit?: boolean } = {}): number {
	if (!fs.existsSync(dir)) return 0;
	let total = 0;
	const walk = (cur: string): void => {
		for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
			if (opts.ignoreGit && ent.name === ".git") continue;
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

function assertPositiveFiniteInt(name: string, val: unknown): number {
	if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val) || val <= 0 || val > Number.MAX_SAFE_INTEGER) {
		throw new TypeError(`${name} must be a positive safe integer, got ${JSON.stringify(val)}`);
	}
	return val;
}

function assertNonNegativeFiniteInt(name: string, val: unknown): number {
	if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val) || val < 0 || val > Number.MAX_SAFE_INTEGER) {
		throw new TypeError(`${name} must be a non-negative safe integer, got ${JSON.stringify(val)}`);
	}
	return val;
}

/** Validates a `ReviewStorageLimits` object, throwing a `TypeError` before dispatch if any supplied limit is non-finite, non-integer, or out of range (0043, 0047, B31). */
export function validateReviewStorageLimits(limits?: ReviewStorageLimits): {
	maxWorkspaceBytes: number;
	maxTotalRetainedBytes: number;
	minFreeBytes: number;
	maxDepCacheBytes: number;
	maxTotalWorkingBytes: number;
	requireHardNativeQuota: boolean;
} {
	if (limits !== undefined && (typeof limits !== "object" || limits === null)) {
		throw new TypeError(`storageLimits must be an object, got ${JSON.stringify(limits)}`);
	}
	if (limits?.requireHardNativeQuota !== undefined && typeof limits.requireHardNativeQuota !== "boolean") {
		throw new TypeError(`requireHardNativeQuota must be a boolean, got ${JSON.stringify(limits.requireHardNativeQuota)}`);
	}
	const maxWorkspaceBytes = limits?.maxWorkspaceBytes !== undefined ? assertPositiveFiniteInt("maxWorkspaceBytes", limits.maxWorkspaceBytes) : 256 * 1024 * 1024;
	const maxTotalRetainedBytes = limits?.maxTotalRetainedBytes !== undefined ? assertPositiveFiniteInt("maxTotalRetainedBytes", limits.maxTotalRetainedBytes) : 1024 * 1024 * 1024;
	const minFreeBytes = limits?.minFreeBytes !== undefined ? assertNonNegativeFiniteInt("minFreeBytes", limits.minFreeBytes) : 0;
	const maxDepCacheBytes = limits?.maxDepCacheBytes !== undefined ? assertPositiveFiniteInt("maxDepCacheBytes", limits.maxDepCacheBytes) : 512 * 1024 * 1024;
	const maxTotalWorkingBytes = limits?.maxTotalWorkingBytes !== undefined
		? assertPositiveFiniteInt("maxTotalWorkingBytes", limits.maxTotalWorkingBytes)
		: maxTotalRetainedBytes + 2 * maxDepCacheBytes;
	return {
		maxWorkspaceBytes,
		maxTotalRetainedBytes,
		minFreeBytes,
		maxDepCacheBytes,
		maxTotalWorkingBytes,
		requireHardNativeQuota: Boolean(limits?.requireHardNativeQuota),
	};
}

export interface ArchiveOwnerMetadata {
	owner: "context-lab";
	kind: "staging" | "backup";
	member: string;
	pid: number;
	timestamp: number;
	createdAt: string;
}

const ARCHIVE_OWNER_FILE = ".context-lab-owner.json";

function writeArchiveOwnerMetadata(dir: string, meta: ArchiveOwnerMetadata): void {
	fs.writeFileSync(path.join(dir, ARCHIVE_OWNER_FILE), JSON.stringify(meta, null, 2) + "\n");
}

function readArchiveOwnerMetadata(dir: string): ArchiveOwnerMetadata | null {
	const p = path.join(dir, ARCHIVE_OWNER_FILE);
	if (!fs.existsSync(p)) return null;
	try {
		const m = JSON.parse(fs.readFileSync(p, "utf8")) as ArchiveOwnerMetadata;
		if (
			typeof m === "object" && m !== null &&
			m.owner === "context-lab" &&
			(m.kind === "staging" || m.kind === "backup") &&
			typeof m.member === "string" &&
			Number.isSafeInteger(m.pid) && m.pid > 0 &&
			Number.isSafeInteger(m.timestamp) && m.timestamp >= 0
		) {
			return m;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Verifies that an archive directory has a structurally valid `MANIFEST.json` whose `manifestSha256`
 * matches its body, whose every listed file/symlink exists with the exact recorded size, SHA-256 or
 * symlink target, and that contains no unexpected unlisted entries (0044, B31).
 */
export function verifyArchiveDirectory(dir: string): { valid: boolean; reason: string | null; manifest: WorkspaceArchiveManifest | null } {
	const mfPath = path.join(dir, "MANIFEST.json");
	if (!fs.existsSync(mfPath)) return { valid: false, reason: "missing MANIFEST.json", manifest: null };
	let mf: WorkspaceArchiveManifest;
	try {
		mf = JSON.parse(fs.readFileSync(mfPath, "utf8")) as WorkspaceArchiveManifest;
	} catch {
		return { valid: false, reason: "malformed MANIFEST.json", manifest: null };
	}
	if (
		typeof mf !== "object" || mf === null ||
		typeof mf.member !== "string" ||
		typeof mf.createdAt !== "string" ||
		typeof mf.totalBytes !== "number" ||
		typeof mf.entryCount !== "number" ||
		!Array.isArray(mf.excludedPaths) ||
		!Array.isArray(mf.entries) ||
		typeof mf.manifestSha256 !== "string"
	) {
		return { valid: false, reason: "invalid MANIFEST.json schema", manifest: null };
	}
	const body = {
		member: mf.member,
		createdAt: mf.createdAt,
		totalBytes: mf.totalBytes,
		entryCount: mf.entryCount,
		excludedPaths: mf.excludedPaths,
		entries: mf.entries,
	};
	const computedManifestSha = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
	if (computedManifestSha !== mf.manifestSha256) {
		return { valid: false, reason: "MANIFEST.json checksum mismatch", manifest: null };
	}
	if (mf.entries.length !== mf.entryCount) {
		return { valid: false, reason: "entryCount mismatch", manifest: null };
	}
	let sumBytes = 0;
	for (const e of mf.entries) {
		if (!e || typeof e.path !== "string") return { valid: false, reason: "invalid entry", manifest: null };
		const p = path.join(dir, e.path);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(p);
		} catch {
			return { valid: false, reason: `missing payload entry ${e.path}`, manifest: null };
		}
		if (e.kind === "symlink") {
			if (!st.isSymbolicLink() || fs.readlinkSync(p) !== e.target) {
				return { valid: false, reason: `symlink mismatch for ${e.path}`, manifest: null };
			}
		} else if (e.kind === "file") {
			if (!st.isFile() || st.size !== e.bytes) {
				return { valid: false, reason: `size mismatch for ${e.path}`, manifest: null };
			}
			if (sha256File(p) !== e.sha256) {
				return { valid: false, reason: `sha256 mismatch for ${e.path}`, manifest: null };
			}
			sumBytes += st.size;
		} else {
			return { valid: false, reason: `unknown entry kind for ${e.path}`, manifest: null };
		}
	}
	if (sumBytes !== mf.totalBytes) {
		return { valid: false, reason: "totalBytes mismatch", manifest: null };
	}
	return { valid: true, reason: null, manifest: mf };
}

/**
 * Reconciles abandoned `.backup-<member>-<pid>-<ts>` and `.staging-<member>-<pid>-<ts>` directories
 * in `parentDir` for `member` whose owning PID is no longer alive (0043, 0044, B31).
 * Requires strict `<prefix><digits>-<digits>` naming (plus either `MANIFEST.json` or `.context-lab-staging.json`)
 * so unowned directories (such as `.staging-fixture-manual-notes`) are never touched.
 * Validates full archive payload fidelity (`verifyArchiveDirectory`) before selecting a backup to restore
 * or retiring redundant backups.
 */
export function recoverInterruptedPublication(destDir: string, member: string): { restoredFromBackup: boolean; cleanedDirs: string[]; skippedUnowned: string[]; skippedDamaged: string[] } {
	const parentDir = path.dirname(destDir);
	const cleanedDirs: string[] = [];
	const skippedUnowned: string[] = [];
	const skippedDamaged: string[] = [];
	let restoredFromBackup = false;
	if (!fs.existsSync(parentDir)) return { restoredFromBackup, cleanedDirs, skippedUnowned, skippedDamaged };

	const backupPrefix = `.backup-${member}-`;
	const stagingPrefix = `.staging-${member}-`;
	const parseOwnedName = (name: string, prefix: string): { pid: number; ts: number } | null => {
		if (!name.startsWith(prefix)) return null;
		const rest = name.slice(prefix.length);
		const m = /^(\d+)-(\d+)$/.exec(rest);
		if (!m) return null;
		const pid = Number(m[1]), ts = Number(m[2]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ts) || ts < 0) return null;
		return { pid, ts };
	};
	const isOwnedDir = (full: string, parsed: { pid: number; ts: number }): boolean => {
		const ownerMeta = readArchiveOwnerMetadata(full);
		if (ownerMeta !== null) return ownerMeta.member === member && ownerMeta.pid === parsed.pid;
		const check = verifyArchiveDirectory(full);
		if (check.valid && check.manifest?.member === member) return true;
		// Also recognize a damaged backup whose MANIFEST.json has a valid schema + checksum for `member`.
		const mfPath = path.join(full, "MANIFEST.json");
		if (fs.existsSync(mfPath)) {
			try {
				const mf = JSON.parse(fs.readFileSync(mfPath, "utf8")) as WorkspaceArchiveManifest;
				return mf?.member === member && typeof mf?.manifestSha256 === "string";
			} catch {
				return false;
			}
		}
		return false;
	};

	const entries = fs.readdirSync(parentDir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
	const destCheck = fs.existsSync(destDir) ? verifyArchiveDirectory(destDir) : { valid: false, reason: "absent", manifest: null };
	let destValid = destCheck.valid;

	if (!destValid) {
		for (const ent of entries) {
			if (!ent.isDirectory() || !ent.name.startsWith(backupPrefix)) continue;
			const parsed = parseOwnedName(ent.name, backupPrefix);
			const candidate = path.join(parentDir, ent.name);
			if (!parsed || !isOwnedDir(candidate, parsed)) {
				skippedUnowned.push(candidate);
				continue;
			}
			if (isProcessAlive(parsed.pid)) continue;
			const check = verifyArchiveDirectory(candidate);
			if (check.valid && check.manifest?.member === member) {
				fs.rmSync(destDir, { recursive: true, force: true });
				fs.renameSync(candidate, destDir);
				fs.rmSync(path.join(destDir, ARCHIVE_OWNER_FILE), { force: true });
				restoredFromBackup = true;
				destValid = true;
				break;
			} else {
				skippedDamaged.push(candidate);
			}
		}
	}

	// Only retire dead-PID owned staging/backup directories once a valid destination exists (or for staging dirs with verified ownership metadata).
	for (const ent of fs.readdirSync(parentDir, { withFileTypes: true })) {
		if (!ent.isDirectory()) continue;
		const isBackup = ent.name.startsWith(backupPrefix);
		const isStaging = ent.name.startsWith(stagingPrefix);
		if (!isBackup && !isStaging) continue;
		const full = path.join(parentDir, ent.name);
		const parsed = parseOwnedName(ent.name, isBackup ? backupPrefix : stagingPrefix);
		if (!parsed || !isOwnedDir(full, parsed)) {
			if (!skippedUnowned.includes(full)) skippedUnowned.push(full);
			continue;
		}
		if (isProcessAlive(parsed.pid)) continue;
		if (isBackup && !destValid) continue;
		makeWritable(full);
		fs.rmSync(full, { recursive: true, force: true });
		cleanedDirs.push(full);
	}
	return { restoredFromBackup, cleanedDirs, skippedUnowned, skippedDamaged };
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
	const validated = validateReviewStorageLimits({
		...(opts.maxWorkspaceBytes !== undefined ? { maxWorkspaceBytes: opts.maxWorkspaceBytes } : {}),
		...(opts.maxTotalRetainedBytes !== undefined ? { maxTotalRetainedBytes: opts.maxTotalRetainedBytes } : {}),
		...(opts.minFreeBytes !== undefined ? { minFreeBytes: opts.minFreeBytes } : {}),
	});
	const maxWs = validated.maxWorkspaceBytes;
	const maxTotal = validated.maxTotalRetainedBytes;
	const minFree = validated.minFreeBytes;
	const currentTotal = opts.currentTotalRetainedBytes !== undefined ? assertNonNegativeFiniteInt("currentTotalRetainedBytes", opts.currentTotalRetainedBytes) : 0;
	const excludedSet = new Set<string>([".git", ...DEFAULT_EXCLUDED_RETENTION_DIRS, ...(opts.excludeNames ?? [])]);
	const explicitRetain = (opts.retainPaths ?? []).map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
	const parentDir = path.dirname(opts.destDir);
	fs.mkdirSync(parentDir, { recursive: true });
	// Reconcile any interrupted prior replacement for this member before starting a new staging pass (0043, 0045, B31).
	recoverInterruptedPublication(opts.destDir, opts.member);
	const tsNow = Date.now();
	const createdAt = (opts.now ?? (() => new Date()))().toISOString();
	const stagingDir = path.join(parentDir, `.staging-${opts.member}-${process.pid}-${tsNow}`);
	const backupDir = path.join(parentDir, `.backup-${opts.member}-${process.pid}-${tsNow}`);
	const hadPreviousValid = verifyArchiveDirectory(opts.destDir).valid;
	const excludedPaths: string[] = [];
	const entries: ArchiveEntry[] = [];
	let totalBytes = 0;

	const isExplicitlyRetained = (rel: string): boolean =>
		explicitRetain.some((r) => rel === r || rel.startsWith(`${r}/`) || r.startsWith(`${rel}/`));

	const shouldExclude = (rel: string, name: string): boolean => {
		if (name === ".git" || name === ARCHIVE_OWNER_FILE) return true;
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
			if (avail.bytes === null) {
				throw new Error(`available disk space could not be measured at ${parentDir} (${avail.error ?? "unknown"}) under minFreeBytes (${minFree} bytes) before archiving ${opts.member}`);
			}
			if (avail.bytes < minFree) {
				throw new Error(`available disk space (${avail.bytes} bytes) is below minFreeBytes (${minFree} bytes) before archiving ${opts.member}`);
			}
		}
		fs.rmSync(stagingDir, { recursive: true, force: true });
		fs.mkdirSync(stagingDir, { recursive: true });
		writeArchiveOwnerMetadata(stagingDir, { owner: "context-lab", kind: "staging", member: opts.member, pid: process.pid, timestamp: tsNow, createdAt });
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
						if (avail.bytes === null) {
							throw new Error(`available disk space could not be measured at ${parentDir} (${avail.error ?? "unknown"}) under minFreeBytes (${minFree} bytes) while copying ${rel}`);
						}
						if (avail.bytes - st.size < minFree) {
							throw new Error(`available disk space (${avail.bytes} bytes) would fall below minFreeBytes (${minFree} bytes) while copying ${rel}`);
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

		// Replacement preserving existing valid publication and deterministic restart recovery (0045, B31).
		const hadDest = fs.existsSync(opts.destDir);
		if (hadDest) {
			fs.rmSync(backupDir, { recursive: true, force: true });
			writeArchiveOwnerMetadata(opts.destDir, { owner: "context-lab", kind: "backup", member: opts.member, pid: process.pid, timestamp: tsNow, createdAt });
			fs.renameSync(opts.destDir, backupDir);
		}
		try {
			fs.rmSync(path.join(stagingDir, ARCHIVE_OWNER_FILE), { force: true });
			fs.renameSync(stagingDir, opts.destDir);
		} catch (swapErr) {
			if (hadDest && fs.existsSync(backupDir) && !fs.existsSync(opts.destDir)) {
				try {
					fs.rmSync(path.join(backupDir, ARCHIVE_OWNER_FILE), { force: true });
					fs.renameSync(backupDir, opts.destDir);
				} catch { /* best-effort restore */ }
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
		recoverInterruptedPublication(opts.destDir, opts.member);
		const preservedPreviousValid = hadPreviousValid && verifyArchiveDirectory(opts.destDir).valid;
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
	];
	if (packet.archivalSummary) {
		lines.push(
			"## Workspace archival", "",
			packet.archivalSummary.allVerified
				? `All ${packet.replies.length} workspace archive(s) verified (${packet.archivalSummary.totalRetainedBytes} retained bytes).`
				: `**ARCHIVAL FAILED** for member(s): ${packet.archivalSummary.failedMembers.join(", ")}. Original workspaces preserved at \`${packet.archivalSummary.workDir ?? "unknown"}\`.`,
			"",
		);
	}
	lines.push("## Findings", "");
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
	const validatedLimits = validateReviewStorageLimits(opts.storageLimits);
	if (opts.timeLimitSeconds !== undefined) assertPositiveFiniteInt("timeLimitSeconds", opts.timeLimitSeconds);
	if (opts.parallel !== undefined) assertPositiveFiniteInt("parallel", opts.parallel);
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
	if (toolsMode === "on" && validatedLimits.requireHardNativeQuota) {
		throw new Error("requireHardNativeQuota is not supported on unprivileged bwrap bind mounts (Linux user namespaces cannot mount size-bounded tmpfs over host paths or enforce kernel prjquota); omit requireHardNativeQuota to use synchronous Node ENOSPC + 5ms active SIGKILL monitoring");
	}
	if (validatedLimits.minFreeBytes > 0) {
		const checkRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
		const availWork = availableBytesAt(checkRoot);
		if (availWork.bytes === null) {
			throw new Error(`available disk space could not be measured at ${checkRoot} (${availWork.error ?? "unknown"}) under minFreeBytes (${validatedLimits.minFreeBytes} bytes) before review dispatch`);
		}
		if (availWork.bytes < validatedLimits.minFreeBytes) {
			throw new Error(`available disk space (${availWork.bytes} bytes) at ${checkRoot} is below minFreeBytes (${validatedLimits.minFreeBytes} bytes) before review dispatch`);
		}
		const resolvedOut = path.resolve(opts.outDir);
		const availOut = availableBytesAt(resolvedOut);
		if (availOut.bytes === null) {
			throw new Error(`available disk space could not be measured at ${resolvedOut} (${availOut.error ?? "unknown"}) under minFreeBytes (${validatedLimits.minFreeBytes} bytes) before review dispatch`);
		}
		if (availOut.bytes < validatedLimits.minFreeBytes) {
			throw new Error(`available disk space (${availOut.bytes} bytes) at ${resolvedOut} is below minFreeBytes (${validatedLimits.minFreeBytes} bytes) before review dispatch`);
		}
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
	const activeWorkingDirs = new Map<string, { ws: string; scratch: string; depCache: string }>();
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
			const abortController = new AbortController();
			const inv: Invocation = {
				arm, workspace: ws.dir, prompt: buildReviewerPrompt(ws.dir, scratchDir, depCacheDir), mode, member,
				tools: toolsMode, ...(opts.sockets ? { sockets: true } : {}),
				...(toolsMode === "on" ? {
					extraWritable: [scratchDir, depCacheDir],
					extraEnv: {
						TMPDIR: scratchDir,
						...(depCache ? depCache.env : {}),
					},
					signal: abortController.signal,
				} : {}),
				timeLimitSeconds: opts.timeLimitSeconds ?? 900, work: invDir,
			};
			if (toolsMode === "on") {
				activeWorkingDirs.set(member.id, { ws: ws.dir, scratch: scratchDir, depCache: depCacheDir });
			}

			// Invocation-local working-storage enforcement (0045, 0046, B31):
			// - Preload module and violation markers live inside `scratchDir/.context-lab-quota/` (which is in
			//   `inv.extraWritable`, so it is mounted inside `runSandboxed`).
			// - `NODE_OPTIONS` is set only in `inv.extraEnv` (never mutating `process.env.NODE_OPTIONS` in the parent).
			// - Inside the preload, synchronous, callback, promise, stream, and FD writes across `depCacheDir`,
			//   `scratchDir`, and `ws.dir` (and run-wide aggregate working storage) that would exceed their cap
			//   record a violation and reject/throw an explicit `ENOSPC` error before writing any bytes.
			// - In the parent, `scanWorkingDirs` scans `{DEP_CACHE}`, `{SCRATCH}`, `{WORKSPACE}`, and aggregate
			//   active working bytes across concurrent reviewers, calling `abortController.abort()` to immediately
			//   SIGKILL the sandbox (`bwrap`) if an unguarded native binary breaches a cap.
			let activeDepViolation: string | null = null;
			let activeWsViolation: string | null = null;
			const maxDepBytes = validatedLimits.maxDepCacheBytes;
			const maxWsBytes = validatedLimits.maxWorkspaceBytes;
			const maxTotalBytes = validatedLimits.maxTotalRetainedBytes;
			const maxTotalWorkBytes = validatedLimits.maxTotalWorkingBytes;
			const quotaDir = path.join(scratchDir, ".context-lab-quota");
			const preloadFile = path.join(quotaDir, "preload.mjs");
			const depViolationFile = path.join(quotaDir, "dep-violation.txt");
			const wsViolationFile = path.join(quotaDir, "ws-violation.txt");

			if (toolsMode === "on") {
				fs.mkdirSync(quotaDir, { recursive: true });
				const preloadCode = [
					'import fs from "node:fs";',
					'import path from "node:path";',
					`const depDir = ${JSON.stringify(depCacheDir)};`,
					`const scratchDir = ${JSON.stringify(scratchDir)};`,
					`const quotaDir = ${JSON.stringify(quotaDir)};`,
					`const wsDir = ${JSON.stringify(ws.dir)};`,
					`const maxDep = ${maxDepBytes};`,
					`const maxWs = ${maxWsBytes};`,
					`const maxTotal = ${maxTotalBytes};`,
					`const depViol = ${JSON.stringify(depViolationFile)};`,
					`const wsViol = ${JSON.stringify(wsViolationFile)};`,
					"const origWriteSync = fs.writeFileSync.bind(fs);",
					"const origAppendSync = fs.appendFileSync.bind(fs);",
					"const origCopySync = fs.copyFileSync.bind(fs);",
					"const origCpSync = fs.cpSync.bind(fs);",
					"const origWriteFdSync = fs.writeSync.bind(fs);",
					"const origWriteFd = fs.write.bind(fs);",
					"const origOpenSync = fs.openSync.bind(fs);",
					"const origOpen = fs.open.bind(fs);",
					"const origCloseSync = fs.closeSync.bind(fs);",
					"const origClose = fs.close.bind(fs);",
					"const origWriteFile = fs.writeFile.bind(fs);",
					"const origAppendFile = fs.appendFile.bind(fs);",
					"const origCopyFile = fs.copyFile.bind(fs);",
					"const origCreateWriteStream = fs.createWriteStream.bind(fs);",
					"const origPromWrite = fs.promises.writeFile.bind(fs.promises);",
					"const origPromAppend = fs.promises.appendFile.bind(fs.promises);",
					"const origPromCopy = fs.promises.copyFile.bind(fs.promises);",
					"const fdMeta = new Map();",
					"const isAppendFlag = (fl) => typeof fl === 'string' ? fl.includes('a') : (typeof fl === 'number' ? Boolean(fl & fs.constants.O_APPEND) : false);",
					"const isInside = (p, d) => { const r = path.relative(d, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };",
					"const dirBytes = (d, skipGit) => {",
					"  if (!fs.existsSync(d)) return 0;",
					"  let t = 0;",
					"  const w = (c) => { for (const e of fs.readdirSync(c, { withFileTypes: true })) { if (skipGit && e.name === '.git') continue; if (e.name === '.context-lab-quota') continue; const p = path.join(c, e.name); let st; try { st = fs.lstatSync(p); } catch { continue; } if (st.isSymbolicLink()) continue; if (st.isDirectory()) w(p); else if (st.isFile()) t += st.size; } };",
					"  w(d); return t;",
					"};",
					"const toBuf = (d, o) => typeof d === 'string' ? Buffer.from(d, typeof o === 'string' ? o : o?.encoding ?? 'utf8') : Buffer.isBuffer(d) ? d : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(String(d));",
					"const enospc = (msg, syscall, dest) => Object.assign(new Error(`ENOSPC: no space left on device (${msg}), ${syscall} '${dest}'`), { code: 'ENOSPC', errno: -28, syscall, path: dest });",
					"const checkQuota = (file, addBytes, isOverwrite, syscall) => {",
					"  const raw = typeof file === 'number' ? fdMeta.get(file)?.path : (typeof file === 'string' || file instanceof URL ? (file instanceof URL ? file.pathname : file) : null);",
					"  if (!raw) return;",
					"  const p = path.resolve(raw);",
					"  if (isInside(p, quotaDir)) return;",
					"  const ex = isOverwrite && fs.existsSync(p) && fs.lstatSync(p).isFile() ? fs.lstatSync(p).size : 0;",
					"  if (isInside(p, depDir)) {",
					"    const nextTotal = Math.max(0, dirBytes(depDir, false) - ex) + addBytes;",
					"    if (nextTotal > maxDep) {",
					"      const msg = `dependency cache (${nextTotal} bytes) exceeded maxDepCacheBytes (${maxDep} bytes)`;",
					"      try { origWriteSync(depViol, msg); } catch {}",
					"      throw enospc(msg, syscall, p);",
					"    }",
					"  }",
					"  if (isInside(p, wsDir) && !isInside(p, path.join(wsDir, '.git'))) {",
					"    const nextTotal = Math.max(0, dirBytes(wsDir, true) - ex) + addBytes;",
					"    if (nextTotal > maxWs) {",
					"      const msg = `retained workspace (${nextTotal} bytes) exceeds maxWorkspaceBytes (${maxWs} bytes)`;",
					"      try { origWriteSync(wsViol, msg); } catch {}",
					"      throw enospc(msg, syscall, p);",
					"    }",
					"    if (nextTotal > maxTotal) {",
					"      const msg = `aggregate retained workspaces (${nextTotal} bytes) exceed maxTotalRetainedBytes (${maxTotal} bytes)`;",
					"      try { origWriteSync(wsViol, msg); } catch {}",
					"      throw enospc(msg, syscall, p);",
					"    }",
					"  }",
					"  if (isInside(p, scratchDir)) {",
					"    const nextTotal = Math.max(0, dirBytes(scratchDir, false) - ex) + addBytes;",
					"    if (nextTotal > maxDep) {",
					"      const msg = `scratch directory (${nextTotal} bytes) exceeded maxDepCacheBytes (${maxDep} bytes)`;",
					"      try { origWriteSync(depViol, msg); } catch {}",
					"      throw enospc(msg, syscall, p);",
					"    }",
					"  }",
					"};",
					"const fdWriteGrowth = (fd, writeLen, explicitPos) => {",
					"  const meta = fdMeta.get(fd);",
					"  if (!meta) return { growth: writeLen, nextPos: 0 };",
					"  let curSize = 0;",
					"  try { curSize = fs.fstatSync(fd).size; } catch { try { curSize = fs.lstatSync(meta.path).size; } catch {} }",
					"  const startPos = meta.append ? curSize : (typeof explicitPos === 'number' && explicitPos >= 0 ? explicitPos : meta.pos);",
					"  const endPos = startPos + writeLen;",
					"  const growth = Math.max(0, endPos - curSize);",
					"  const nextPos = typeof explicitPos === 'number' && explicitPos >= 0 ? meta.pos : endPos;",
					"  return { growth, nextPos };",
					"};",
					"const parseFdWriteArgs = (bufOrStr, rest) => {",
					"  if (typeof bufOrStr === 'string') {",
					"    const pos = typeof rest[0] === 'number' ? rest[0] : null;",
					"    const enc = typeof rest[0] === 'string' ? rest[0] : (typeof rest[1] === 'string' ? rest[1] : 'utf8');",
					"    return { len: Buffer.byteLength(bufOrStr, enc), pos };",
					"  }",
					"  if (rest.length > 0 && typeof rest[0] === 'object' && rest[0] !== null && !ArrayBuffer.isView(rest[0])) {",
					"    const o = rest[0];",
					"    const len = typeof o.length === 'number' ? o.length : bufOrStr.byteLength - (typeof o.offset === 'number' ? o.offset : 0);",
					"    const pos = typeof o.position === 'number' ? o.position : null;",
					"    return { len, pos };",
					"  }",
					"  const offset = typeof rest[0] === 'number' ? rest[0] : 0;",
					"  const len = typeof rest[1] === 'number' ? rest[1] : bufOrStr.byteLength - offset;",
					"  const pos = typeof rest[2] === 'number' ? rest[2] : null;",
					"  return { len, pos };",
					"};",
					"fs.openSync = (file, flags, mode) => { const fd = origOpenSync(file, flags, mode); if (typeof file === 'string' || file instanceof URL) fdMeta.set(fd, { path: path.resolve(file instanceof URL ? file.pathname : file), pos: 0, append: isAppendFlag(flags) }); return fd; };",
					"fs.open = function(file, ...rest) { const flags = rest.length > 1 ? rest[0] : 'r'; const cb = rest[rest.length - 1]; if (typeof cb === 'function') { rest[rest.length - 1] = (err, fd) => { if (!err && (typeof file === 'string' || file instanceof URL)) fdMeta.set(fd, { path: path.resolve(file instanceof URL ? file.pathname : file), pos: 0, append: isAppendFlag(flags) }); cb(err, fd); }; } return origOpen(file, ...rest); };",
					"fs.closeSync = (fd) => { fdMeta.delete(fd); return origCloseSync(fd); };",
					"fs.close = (fd, cb) => { fdMeta.delete(fd); return origClose(fd, cb); };",
					"fs.writeFileSync = (file, data, options) => { const buf = toBuf(data, options); checkQuota(file, buf.length, true, 'write'); return origWriteSync(file, data, options); };",
					"fs.appendFileSync = (file, data, options) => { const buf = toBuf(data, options); checkQuota(file, buf.length, false, 'write'); return origAppendSync(file, data, options); };",
					"fs.writeSync = function(fd, bufOrStr, ...rest) { const { len, pos } = parseFdWriteArgs(bufOrStr, rest); const { growth, nextPos } = fdWriteGrowth(fd, len, pos); checkQuota(fd, growth, false, 'write'); const written = origWriteFdSync(fd, bufOrStr, ...rest); const m = fdMeta.get(fd); if (m) m.pos = nextPos; return written; };",
					"fs.write = function(fd, bufOrStr, ...rest) { const cb = rest[rest.length - 1]; const argsNoCb = typeof cb === 'function' ? rest.slice(0, -1) : rest; try { const { len, pos } = parseFdWriteArgs(bufOrStr, argsNoCb); const { growth, nextPos } = fdWriteGrowth(fd, len, pos); checkQuota(fd, growth, false, 'write'); const m = fdMeta.get(fd); if (m) m.pos = nextPos; } catch (e) { if (typeof cb === 'function') { queueMicrotask(() => cb(e)); return; } throw e; } return origWriteFd(fd, bufOrStr, ...rest); };",
					"fs.copyFileSync = (src, dest, mode) => { const sz = fs.statSync(src).size; checkQuota(dest, sz, true, 'copyfile'); return origCopySync(src, dest, mode); };",
					"fs.cpSync = (src, dest, opts) => { const sz = fs.existsSync(src) && fs.lstatSync(src).isDirectory() ? dirBytes(String(src), false) : (fs.existsSync(src) ? fs.lstatSync(src).size : 0); checkQuota(dest, sz, true, 'cp'); return origCpSync(src, dest, opts); };",
					"fs.writeFile = function(file, data, options, callback) { const cb = typeof options === 'function' ? options : callback; try { const buf = toBuf(data, typeof options === 'function' ? undefined : options); checkQuota(file, buf.length, true, 'write'); } catch (e) { if (typeof cb === 'function') { queueMicrotask(() => cb(e)); return; } throw e; } return origWriteFile(file, data, options, callback); };",
					"fs.appendFile = function(file, data, options, callback) { const cb = typeof options === 'function' ? options : callback; try { const buf = toBuf(data, typeof options === 'function' ? undefined : options); checkQuota(file, buf.length, false, 'write'); } catch (e) { if (typeof cb === 'function') { queueMicrotask(() => cb(e)); return; } throw e; } return origAppendFile(file, data, options, callback); };",
					"fs.copyFile = function(src, dest, mode, callback) { const cb = typeof mode === 'function' ? mode : callback; try { const sz = fs.statSync(src).size; checkQuota(dest, sz, true, 'copyfile'); } catch (e) { if (typeof cb === 'function') { queueMicrotask(() => cb(e)); return; } throw e; } return origCopyFile(src, dest, mode, callback); };",
					"fs.promises.writeFile = async (file, data, options) => { const buf = toBuf(data, options); checkQuota(file, buf.length, true, 'write'); return origPromWrite(file, data, options); };",
					"fs.promises.appendFile = async (file, data, options) => { const buf = toBuf(data, options); checkQuota(file, buf.length, false, 'write'); return origPromAppend(file, data, options); };",
					"fs.promises.copyFile = async (src, dest, mode) => { const sz = fs.statSync(src).size; checkQuota(dest, sz, true, 'copyfile'); return origPromCopy(src, dest, mode); };",
					"fs.createWriteStream = function(file, options) { const s = origCreateWriteStream(file, options); const origW = s._write.bind(s); s._write = function(chunk, enc, cb) { try { const b = toBuf(chunk, enc); checkQuota(file, b.length, false, 'write'); } catch (e) { cb(e); return; } return origW(chunk, enc, cb); }; return s; };",
				].join("\n");
				fs.writeFileSync(preloadFile, preloadCode + "\n");
				const importOpt = `--import=${pathToFileURL(preloadFile).href}`;
				const baseNodeOpts = process.env["NODE_OPTIONS"];
				if (inv.extraEnv) {
					inv.extraEnv["NODE_OPTIONS"] = baseNodeOpts ? `${baseNodeOpts} ${importOpt}` : importOpt;
				}
			}

			// Periodic parent monitor across depCacheDir, scratchDir, ws.dir, and run-wide aggregate owned working bytes.
			// `activeWorkingDirs` retains every member's directories until verified archival retires them, so failed/preserved
			// originals, caches, and scratch continue to count toward the owned footprint (0047, B31).
			let monitorTimer: ReturnType<typeof setInterval> | null = null;
			const scanWorkingDirs = (): void => {
				if (toolsMode !== "on") return;
				const dBytes = directoryAllocatedBytes(depCacheDir);
				if (dBytes > maxDepBytes) {
					activeDepViolation ??= `dependency cache for ${member.id} (${dBytes} bytes) exceeded maxDepCacheBytes (${maxDepBytes} bytes) during execution`;
					abortController.abort();
				}
				const sBytes = Math.max(0, directoryAllocatedBytes(scratchDir) - directoryAllocatedBytes(quotaDir));
				if (sBytes > maxDepBytes) {
					activeDepViolation ??= `scratch directory for ${member.id} (${sBytes} bytes) exceeded maxDepCacheBytes (${maxDepBytes} bytes) during execution`;
					abortController.abort();
				}
				const wBytes = directoryAllocatedBytes(ws.dir, { ignoreGit: true });
				if (wBytes > maxWsBytes) {
					activeWsViolation ??= `retained workspace for ${member.id} (${wBytes} bytes) exceeds maxWorkspaceBytes (${maxWsBytes} bytes)`;
					abortController.abort();
				}
				// Aggregate owned footprint across all active and preserved reviewers (ws + depCache + scratch) + retained bytes.
				let activeWsSum = currentTotalRetainedBytes;
				let ownedFootprintSum = currentTotalRetainedBytes;
				for (const dirs of activeWorkingDirs.values()) {
					const mWs = directoryAllocatedBytes(dirs.ws, { ignoreGit: true });
					const mDep = directoryAllocatedBytes(dirs.depCache);
					const mQ = path.join(dirs.scratch, ".context-lab-quota");
					const mScr = Math.max(0, directoryAllocatedBytes(dirs.scratch) - directoryAllocatedBytes(mQ));
					activeWsSum += mWs;
					ownedFootprintSum += mWs + mDep + mScr;
				}
				if (activeWsSum > maxTotalBytes) {
					activeWsViolation ??= `aggregate active workspaces (${activeWsSum} bytes) exceed maxTotalRetainedBytes (${maxTotalBytes} bytes)`;
					abortController.abort();
				}
				if (ownedFootprintSum > maxTotalWorkBytes) {
					activeDepViolation ??= `aggregate owned working footprint (${ownedFootprintSum} bytes) exceeds maxTotalWorkingBytes (${maxTotalWorkBytes} bytes)`;
					abortController.abort();
				}
				if (validatedLimits.minFreeBytes > 0) {
					const avail = availableBytesAt(workDir);
					if (avail.bytes === null) {
						activeDepViolation ??= `available disk space could not be measured (${avail.error ?? "unknown"}) under minFreeBytes (${validatedLimits.minFreeBytes} bytes) during execution`;
						abortController.abort();
					} else if (avail.bytes < validatedLimits.minFreeBytes) {
						activeDepViolation ??= `available disk space (${avail.bytes} bytes) fell below minFreeBytes (${validatedLimits.minFreeBytes} bytes) during execution`;
						abortController.abort();
					}
				}
			};
			if (toolsMode === "on") {
				monitorTimer = setInterval(scanWorkingDirs, 5);
			}

			let out;
			try {
				out = await adapter.invoke(inv);
			} finally {
				if (monitorTimer !== null) clearInterval(monitorTimer);
				scanWorkingDirs();
				if (fs.existsSync(depViolationFile)) {
					activeDepViolation ??= fs.readFileSync(depViolationFile, "utf8");
				}
				if (fs.existsSync(wsViolationFile)) {
					activeWsViolation ??= fs.readFileSync(wsViolationFile, "utf8");
				}
			}

			let archival: WorkspaceArchivalResult | undefined;
			if (toolsMode === "on") {
				const retainedWs = path.join(outDir, "workspaces", member.id);
				recoverInterruptedPublication(retainedWs, member.id);
				const hasPriorValid = verifyArchiveDirectory(retainedWs).valid;
				const depBytes = directoryAllocatedBytes(depCacheDir);
				if (activeDepViolation !== null || depBytes > maxDepBytes || activeWsViolation !== null) {
					preserveWorkOnFailure = true;
					archival = {
						status: "failed",
						retainedPath: hasPriorValid ? retainedWs : null,
						originalWorkspace: ws.dir,
						scratchPath: scratchDir,
						depCachePath: depCacheDir,
						bytes: 0,
						entryCount: 0,
						manifestSha256: null,
						excludedPaths: [],
						preservedPreviousValid: hasPriorValid,
						error: activeDepViolation ?? activeWsViolation ?? `dependency cache for ${member.id} (${depBytes} bytes) exceeded maxDepCacheBytes (${maxDepBytes} bytes)`,
					};
				} else {
					archival = publishRetainedWorkspace({
						member: member.id,
						sourceDir: ws.dir,
						destDir: retainedWs,
						scratchPath: scratchDir,
						depCachePath: depCacheDir,
						...(opts.retainPaths !== undefined ? { retainPaths: opts.retainPaths } : {}),
						...(opts.excludeNames !== undefined ? { excludeNames: opts.excludeNames } : {}),
						maxWorkspaceBytes: validatedLimits.maxWorkspaceBytes,
						maxTotalRetainedBytes: validatedLimits.maxTotalRetainedBytes,
						minFreeBytes: validatedLimits.minFreeBytes,
						currentTotalRetainedBytes,
						now,
						...(opts.archivalFaultHook !== undefined ? { faultHook: opts.archivalFaultHook } : {}),
					});
					if (archival.status === "verified") {
						currentTotalRetainedBytes += archival.bytes;
						// Once workspace evidence is verified, clean the per-attempt scratch and dep-cache directories immediately.
						// Do NOT remove `member.id` from `activeWorkingDirs` while `ws.dir` remains on disk (`directoryAllocatedBytes`
						// returns 0 for the deleted `scratchDir` and `depCacheDir`, while continuing to charge `ws.dir` alongside
						// `currentTotalRetainedBytes` until `workDir` is physically retired; 0048, B31).
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
