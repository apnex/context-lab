// variant-builder - builds one context variant (architecture section 5, principles P1 and P5).
//
// A variant is a local, read-only copy of a source at one pinned revision. The builder exports the
// source from git at that revision - never from a working tree, which has no revision to repeat -
// drops excluded paths, keeps included ones, runs the project's transform hook if one is declared,
// rewrites every declared address of the source to the copy itself, and plants the variant's
// canaries in one file at its root. The variant's manifest records the revision it came from.
//
// Address rewriting is longest-prefix first, so a declared address that extends another - a raw
// file address under a repository address - is rewritten whole, not by its shorter prefix.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runHook, type HookResult } from "./hook-runner.js";
import { copyContained, isContainedRelative, isInside } from "./paths.js";
import type { LoadedPack, Variant } from "./pack-schema.js";

export const CANARY_FILE = "context-lab-canary.md";
export const VARIANT_MANIFEST = "context-lab-variant.json";

export interface VariantManifest {
	variant: string;
	source: string;
	revision: string;
	canaries: string[];
	rewritten: number;
}

export type BuiltVariant =
	| { ok: true; dir: string; manifest: VariantManifest }
	| { ok: false; variant: string; reason: string; hook?: HookResult };

const git = (cwd: string, ...args: string[]): Buffer => execFileSync("git", args, { cwd, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });

function filesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
	});
}

/** Export a source directory at a revision into an empty folder, through git, so the revision is exact. */
export function exportAt(sourceDir: string, revision: string, into: string): string {
	const sha = git(sourceDir, "rev-parse", "--verify", `${revision}^{commit}`).toString().trim();
	const prefix = git(sourceDir, "rev-parse", "--show-prefix").toString().trim();
	const top = git(sourceDir, "rev-parse", "--show-toplevel").toString().trim();
	const tar = git(top, "archive", "--format=tar", prefix ? `${sha}:${prefix}` : sha);
	fs.mkdirSync(into, { recursive: true });
	execFileSync("tar", ["-x", "-C", into], { input: tar, maxBuffer: 1 << 30 });
	return sha;
}

/** Rewrite every occurrence of each address in a text file to the replacement; returns the count. */
export function rewriteAddresses(dir: string, addresses: string[], to: string): number {
	const ordered = [...addresses].sort((a, b) => b.length - a.length);
	let count = 0;
	for (const f of filesUnder(dir)) {
		const buf = fs.readFileSync(f);
		if (buf.includes(0)) continue; // binary
		let text = buf.toString("utf8");
		let changed = false;
		for (const a of ordered) {
			const parts = text.split(a);
			if (parts.length > 1) {
				count += parts.length - 1;
				text = parts.join(to);
				changed = true;
			}
		}
		if (changed) fs.writeFileSync(f, text);
	}
	return count;
}

export async function buildVariant(loaded: LoadedPack, variantId: string, revision: string, outDir: string): Promise<BuiltVariant> {
	const variant: Variant | undefined = loaded.pack.variants.find((v) => v.id === variantId);
	if (!variant) throw new Error(`no variant ${variantId} in pack ${loaded.pack.id}`);
	const source = loaded.pack.sources.find((s) => s.id === variant.source);
	if (!source) throw new Error(`variant ${variantId} names no declared source`);
	const sourceDir = path.resolve(loaded.dir, source.path);
	if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty`);

	fs.mkdirSync(path.dirname(path.resolve(outDir)), { recursive: true });
	const staging = fs.mkdtempSync(`${path.resolve(outDir)}.export-`);
	let sha: string;
	try {
		sha = exportAt(sourceDir, revision, staging);
	} catch (e) {
		fs.rmSync(staging, { recursive: true, force: true });
		return { ok: false, variant: variantId, reason: `the source could not be exported at ${revision}: ${String(e).slice(0, 300)}` };
	}
	for (const ex of source.exclude ?? []) {
		const target = path.resolve(staging, ex);
		if (!isContainedRelative(ex) || !isInside(target, staging) || target === staging) {
			fs.rmSync(staging, { recursive: true, force: true });
			return { ok: false, variant: variantId, reason: `exclude ${ex} does not name a path inside the source` };
		}
		fs.rmSync(target, { recursive: true, force: true });
	}
	if (variant.include !== undefined) {
		const keep = variant.include;
		for (const f of filesUnder(staging)) if (!keep.some((g) => path.matchesGlob(path.relative(staging, f), g))) fs.rmSync(f);
		removeEmptyDirs(staging);
	}

	if (variant.transform !== undefined) {
		const hook = loaded.pack.hooks.find((h) => h.id === variant.transform);
		if (!hook) throw new Error(`variant ${variantId} names no declared transform hook`);
		// The hook writes into a scratch folder; its output is then copied in with every link
		// resolved inside it, so a link the hook made cannot carry a read past the hook's bounds.
		const hookOut = fs.mkdtempSync(`${path.resolve(outDir)}.hook-`);
		const sourcePaths = loaded.pack.sources.map((s) => path.resolve(loaded.dir, s.path)).filter((p) => fs.existsSync(p));
		const r = await runHook(loaded.dir, hook, { variant: variantId, from: staging, to: hookOut }, { readable: [staging, ...sourcePaths], writable: hookOut });
		fs.rmSync(staging, { recursive: true, force: true });
		if (!r.ok) {
			fs.rmSync(hookOut, { recursive: true, force: true });
			fs.rmSync(outDir, { recursive: true, force: true });
			return { ok: false, variant: variantId, reason: `its transform hook failed (${r.reason}): ${r.detail}`, hook: r };
		}
		try {
			copyContained(hookOut, outDir);
		} catch (e) {
			fs.rmSync(outDir, { recursive: true, force: true });
			return { ok: false, variant: variantId, reason: `its transform hook's output was refused: ${String(e)}` };
		} finally {
			fs.rmSync(hookOut, { recursive: true, force: true });
		}
	} else {
		try {
			copyContained(staging, outDir);
		} catch (e) {
			fs.rmSync(outDir, { recursive: true, force: true });
			return { ok: false, variant: variantId, reason: `the source holds a link that leaves it: ${String(e)}` };
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
		}
	}

	const rewritten = rewriteAddresses(outDir, source.addresses, outDir);
	fs.writeFileSync(path.join(outDir, CANARY_FILE), variant.canaries.map((c) => `${c}\n`).join(""));
	const manifest: VariantManifest = { variant: variantId, source: source.id, revision: sha, canaries: variant.canaries, rewritten };
	fs.writeFileSync(path.join(outDir, VARIANT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
	makeReadOnly(outDir);
	return { ok: true, dir: outDir, manifest };
}

function removeEmptyDirs(dir: string): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const p = path.join(dir, e.name);
		removeEmptyDirs(p);
		if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
	}
}

/** Files and folders alike, so nothing can be added, changed or removed without restoring write access. */
// Neither function follows a symbolic link: chmod on a link changes what it points to, which may be
// anywhere. A variant holds no links once built, but these are exported and must be safe on any tree.
export function makeReadOnly(dir: string): void {
	if (fs.lstatSync(dir).isSymbolicLink()) return;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isSymbolicLink()) continue;
		if (e.isDirectory()) makeReadOnly(p);
		else fs.chmodSync(p, 0o444);
	}
	fs.chmodSync(dir, 0o555);
}

/** Restore write access to a read-only variant, so it can be removed. */
export function makeWritable(dir: string): void {
	if (fs.lstatSync(dir).isSymbolicLink()) return;
	fs.chmodSync(dir, 0o755);
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isSymbolicLink()) continue;
		if (e.isDirectory()) makeWritable(p);
		else fs.chmodSync(p, 0o644);
	}
}
