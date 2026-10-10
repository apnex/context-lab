// workspace-builder - creates an isolated workspace (architecture section 5, principle P1).
//
// An agent works in a fresh git repository under an opaque name, holding the scenario's starting
// files and any files its arm places in the folder, committed once, so the outcome is the diff
// against that commit. Agent runtimes load rules files from every directory above where they start,
// so the builder refuses a base that has one above it; and it refuses a base inside any path the
// pack forbids agents to touch.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ComposedArm } from "./arm-composer.js";
import type { LoadedPack, Scenario } from "./pack-schema.js";

export interface Workspace {
	dir: string;
	/** The initial commit; an outcome's diff is taken against it. */
	init: string;
}

export interface WorkspaceOptions {
	/** Where workspaces are made; each gets a fresh, opaque name under it. */
	base: string;
	/** The rules-file names the runtime adapters declare they load from directories above. */
	rulesFiles: string[];
}

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.name=context-lab", "-c", "user.email=fixture@context-lab.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Every rules file at or above a directory. */
export function rulesFilesAbove(dir: string, names: string[]): string[] {
	const hits: string[] = [];
	for (let d = path.resolve(dir); ; d = path.dirname(d)) {
		for (const n of names) if (fs.existsSync(path.join(d, n))) hits.push(path.join(d, n));
		if (d === path.dirname(d)) break;
	}
	return hits;
}

export function forbiddenPaths(loaded: LoadedPack): string[] {
	return loaded.pack.isolation.forbidden.paths.map((p) => path.resolve(loaded.dir, p));
}

export function createWorkspace(loaded: LoadedPack, scenario: Scenario, arm: ComposedArm, opts: WorkspaceOptions): Workspace {
	const base = path.resolve(opts.base);
	const above = rulesFilesAbove(base, opts.rulesFiles);
	if (above.length) throw new Error(`a rules file is above the workspace base: ${above.join(", ")}`);
	for (const f of forbiddenPaths(loaded)) {
		if (base === f || base.startsWith(f + path.sep)) throw new Error(`the workspace base ${base} is inside a forbidden path ${f}`);
	}
	fs.mkdirSync(base, { recursive: true });
	const dir = fs.mkdtempSync(path.join(base, "w-"));

	if (typeof scenario.fixture === "string") {
		fs.cpSync(path.resolve(loaded.dir, scenario.fixture), dir, { recursive: true, dereference: true });
	} else if (scenario.fixture !== null) {
		for (const [rel, body] of Object.entries(scenario.fixture.files)) {
			const p = path.resolve(dir, rel);
			if (!p.startsWith(dir + path.sep)) throw new Error(`fixture file ${rel} escapes the workspace`);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, body);
		}
	}
	for (const f of arm.folderFiles) {
		const p = path.resolve(dir, f.file);
		if (!p.startsWith(dir + path.sep)) throw new Error(`folder file ${f.file} escapes the workspace`);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.copyFileSync(f.path, p);
		fs.chmodSync(p, 0o644);
	}
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", "initial");
	return { dir, init: git(dir, "rev-parse", "HEAD") };
}
