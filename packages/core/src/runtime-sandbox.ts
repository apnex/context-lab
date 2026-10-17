// runtime-sandbox - runs an agent runtime inside a filesystem sandbox (conformance cases, "Where a
// driven runtime runs").
//
// The network is shared, so the runtime can reach its model provider; every other namespace is
// unshared, and the filesystem holds only what the invocation is given, mounted in a fixed order
// because a later mount hides an earlier one beneath it. Event lines are collected as they arrive,
// stamped with the time since start; the runtime is stopped at its time limit by killing the
// sandbox, which, with its own process namespace, takes every process inside with it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Line } from "./outcome.js";

const ETC = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/pki", "/etc/ssl", "/etc/ca-certificates"];
const nodeBinary = (): string => fs.realpathSync(process.execPath);

export interface SandboxSpec {
	/** The runtime's installation, mounted read-only: a binary or a directory. */
	install: string;
	/** Folders mounted read-write: the invocation's own folder and the workspace. */
	writable: string[];
	/** Folders mounted read-only at their own paths: the arm's on-request folders. */
	readOnly: string[];
	/** The empty home the runtime sees. */
	home: string;
	cwd: string;
	command: string[];
	env: Record<string, string>;
	stdin: string | null;
	timeLimitSeconds: number;
}

export interface SandboxResult {
	lines: Line[];
	exit: number | null;
	signal: string | null;
	timedOut: boolean;
	seconds: number;
	stderr: string;
}

export function sandboxMounts(spec: SandboxSpec): string[] {
	const a = [
		"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--share-net",
		"--die-with-parent", "--new-session",
		"--ro-bind", "/usr", "/usr",
		"--symlink", "usr/lib64", "/lib64", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
		"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
	];
	for (const e of ETC) if (fs.existsSync(e)) a.push("--ro-bind", e, e);
	a.push("--tmpfs", "/home");
	a.push("--ro-bind", nodeBinary(), "/usr/bin/node");
	a.push("--ro-bind", spec.install, spec.install);
	for (const w of spec.writable) a.push("--bind", w, w);
	for (const r of spec.readOnly) a.push("--ro-bind", r, r);
	a.push("--dir", spec.home, "--chdir", spec.cwd);
	return a;
}

export function runSandboxed(spec: SandboxSpec): Promise<SandboxResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn("bwrap", [...sandboxMounts(spec), ...spec.command], {
			env: spec.env,
			stdio: [spec.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const lines: Line[] = [];
		let pending = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, spec.timeLimitSeconds * 1000);
		child.stdout?.on("data", (d: Buffer) => {
			const at = Date.now() - started;
			pending += d.toString();
			const parts = pending.split("\n");
			pending = parts.pop() ?? "";
			for (const p of parts) if (p.trim()) lines.push({ at, text: p });
		});
		child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
		if (spec.stdin !== null && child.stdin) {
			child.stdin.on("error", () => { /* the runtime may close its input early */ });
			child.stdin.end(spec.stdin);
		}
		const finish = (exit: number | null, signal: string | null): void => {
			clearTimeout(timer);
			if (pending.trim()) lines.push({ at: Date.now() - started, text: pending });
			resolve({ lines, exit: timedOut ? null : exit, signal: timedOut ? "SIGKILL" : signal, timedOut, seconds: (Date.now() - started) / 1000, stderr });
		};
		child.on("error", (e) => { stderr += String(e); finish(-1, null); });
		child.on("close", (code, signal) => finish(code, signal));
	});
}
