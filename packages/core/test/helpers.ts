// Test helpers: a fresh copy of the synthetic pack per test, and JSON edits on it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, from dist/test/ where compiled tests run. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const syntheticPack = path.join(packageRoot, "test", "fixtures", "synthetic-pack");

const made: string[] = [];

/** A scratch directory outside any repository, so nothing above it is a rules file; removed at exit. */
export function scratch(prefix = "cl-test-"): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.push(d);
	return d;
}

// Variants are read-only, so write access is restored before removal - on folders only, found
// without following links, so nothing outside a scratch folder is ever touched.
function restoreWrite(dir: string): void {
	let st: fs.Stats;
	try { st = fs.lstatSync(dir); } catch { return; }
	if (!st.isDirectory()) return;
	fs.chmodSync(dir, 0o755);
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) restoreWrite(path.join(dir, e.name));
}
process.on("exit", () => {
	for (const d of made) {
		try {
			restoreWrite(d);
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			// best effort; a scratch folder left behind is harmless
		}
	}
});

export function copyPack(): string {
	const dir = path.join(scratch(), "pack");
	fs.cpSync(syntheticPack, dir, { recursive: true });
	return dir;
}

export function editJson(file: string, edit: (j: any) => void): void {
	const j = JSON.parse(fs.readFileSync(file, "utf8"));
	edit(j);
	fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
}

import { execFileSync } from "node:child_process";

/** Make a copied pack's directory a git repository with one commit, so its source has a revision. */
export function commitAll(dir: string, message = "fixture"): string {
	const g = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a], { cwd: dir, encoding: "utf8" }).trim();
	if (!fs.existsSync(path.join(dir, ".git"))) g("init", "-q");
	g("add", "-A");
	g("commit", "-q", "--allow-empty", "-m", message);
	return g("rev-parse", "HEAD");
}
