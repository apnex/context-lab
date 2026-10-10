// hook-runner - runs one project hook under its contract (decision 0003).
//
// A hook receives one JSON document on standard input and returns one on standard output. It runs
// with no network, reads only the paths it is given, writes only to the folder it is given, and is
// stopped at its time limit. The bounds are enforced by the operating system, not by asking: the
// hook runs in a bubblewrap sandbox with every namespace unshared, the system directories and the
// Node installation bound read-only, and nothing else visible but the hook file, its readable
// inputs and its writable folder.
//
// Linux only, by construction: it depends on user and network namespaces and bubblewrap.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Hook, HookKind } from "./pack-schema.js";

export interface HookRun {
	/** Paths the hook may read, bound read-only at the same path. */
	readable?: string[];
	/** The one folder the hook may write, bound read-write at the same path. */
	writable?: string;
}

export type HookResult =
	| { ok: true; output: unknown; seconds: number }
	| { ok: false; reason: "timeout" | "exit" | "output" | "sandbox"; detail: string; seconds: number };

/** What each kind of hook's failure does to a run (architecture section 6). */
export const HOOK_FAILURE_RESULT: Record<HookKind, string> = {
	"declaration-check": "the pack fails its check",
	"variant-transform": "the arm is not built, and does not run",
	"outcome-measure": "the hook's properties are incomplete",
};

const nodeBinary = (): string => fs.realpathSync(process.execPath);
const nodeInstall = (): string => path.dirname(path.dirname(nodeBinary()));

/** The bubblewrap arguments that bound a hook. Exported so the bounds can be inspected in tests. */
export function sandboxArgs(hookFile: string, run: HookRun): string[] {
	const args = [
		"--unshare-all", "--die-with-parent", "--new-session",
		"--ro-bind", "/usr", "/usr",
		"--symlink", "usr/lib64", "/lib64",
		"--symlink", "usr/lib", "/lib",
		"--symlink", "usr/bin", "/bin",
		"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
		"--ro-bind", nodeInstall(), nodeInstall(),
		"--ro-bind", hookFile, hookFile,
	];
	for (const p of run.readable ?? []) args.push("--ro-bind", p, p);
	if (run.writable !== undefined) args.push("--bind", run.writable, run.writable);
	args.push("--chdir", "/tmp", nodeBinary(), hookFile);
	return args;
}

/** The last line of standard output that parses as JSON is the hook's output. */
function lastJson(stdout: string): unknown {
	const lines = stdout.trim().split("\n").reverse();
	for (const line of lines) {
		try {
			return JSON.parse(line) as unknown;
		} catch {
			// not this line
		}
	}
	throw new Error("no JSON line on standard output");
}

export function runHook(packDir: string, hook: Hook, input: unknown, run: HookRun = {}): Promise<HookResult> {
	const hookFile = path.resolve(packDir, hook.file);
	const started = Date.now();
	const seconds = (): number => Math.round((Date.now() - started) / 100) / 10;
	for (const p of [hookFile, ...(run.readable ?? []), ...(run.writable !== undefined ? [run.writable] : [])]) {
		if (!fs.existsSync(p)) return Promise.resolve({ ok: false, reason: "sandbox", detail: `${p} does not exist`, seconds: 0 });
	}
	return new Promise((resolve) => {
		const child = spawn("bwrap", sandboxArgs(hookFile, run), { stdio: ["pipe", "pipe", "pipe"], env: {} });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, hook.timeLimitSeconds * 1000);
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, reason: "sandbox", detail: String(e), seconds: seconds() });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return resolve({ ok: false, reason: "timeout", detail: `stopped at ${hook.timeLimitSeconds}s`, seconds: seconds() });
			if (code !== 0) return resolve({ ok: false, reason: "exit", detail: `exit ${code}: ${stderr.slice(-500)}`, seconds: seconds() });
			try {
				resolve({ ok: true, output: lastJson(stdout), seconds: seconds() });
			} catch (e) {
				resolve({ ok: false, reason: "output", detail: String(e), seconds: seconds() });
			}
		});
		child.stdin.on("error", () => { /* the hook may exit without reading its input */ });
		child.stdin.end(JSON.stringify(input));
	});
}
