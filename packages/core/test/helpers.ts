// Test helpers: a fresh copy of the synthetic pack per test, and JSON edits on it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, from dist/test/ where compiled tests run. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const syntheticPack = path.join(packageRoot, "test", "fixtures", "synthetic-pack");

/** A scratch directory outside any repository, so nothing above it is a rules file. */
export function scratch(prefix = "cl-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
