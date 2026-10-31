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

const ETC = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/pki", "/etc/ssl", "/etc/ca-certificates"];
const nodeBinary = (): string => fs.realpathSync(process.execPath);

export interface SandboxSpec {
	/** The runtime's installation, mounted read-only: a binary or a directory. */
	install: string;
	/** Folders mounted read-write: the invocation's own folder and the workspace. */
	writable: string[];
	/** Folders mounted read-only at their own paths: the arm's on-request folders. */
	readOnly: string[];
	/** Host folders mounted read-write at another path, after every other folder so none hides them: an invocation's private directories. */
	binds?: { source: string; target: string }[];
	/** The empty home the runtime sees. */
	home: string;
	cwd: string;
	command: string[];
	env: Record<string, string>;
	stdin: string | null;
	timeLimitSeconds: number;
	/** Optional UTF-8 byte cap on retained stdout lines; when exceeded, stops capturing partial trailing data, sends SIGKILL to bwrap, and resolves after child close (0040, B30). */
	maxStdoutBytes?: number;
	/** Optional AbortSignal to terminate the sandboxed process immediately (e.g. when an active working-storage cap is breached, 0046, B31). */
	signal?: AbortSignal;
}

export interface SandboxResult {
	lines: Line[];
	exit: number | null;
	signal: string | null;
	timedOut: boolean;
	stdoutTruncated?: boolean;
	capturedStdoutBytes?: number;
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
	const nb = nodeBinary();
	a.push("--ro-bind", nb, nb);
	a.push("--ro-bind", spec.install, spec.install);
	for (const w of spec.writable) a.push("--bind", w, w);
	for (const r of spec.readOnly) a.push("--ro-bind", r, r);
	for (const b of spec.binds ?? []) a.push("--bind", b.source, b.target);
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
		let aborted = false;
		let stdoutTruncated = false;
		let capturedStdoutBytes = 0;
		const maxStdout = spec.maxStdoutBytes;
		const onAbort = (): void => {
			aborted = true;
			child.kill("SIGKILL");
		};
		if (spec.signal) {
			if (spec.signal.aborted) onAbort();
			else spec.signal.addEventListener("abort", onAbort, { once: true });
		}
		const pushLine = (at: number, l: string): boolean => {
			const trimmed = l.trim();
			if (!trimmed) return true;
			const lineBytes = Buffer.byteLength(l, "utf8") + 1;
			if (maxStdout !== undefined && capturedStdoutBytes + lineBytes > maxStdout) {
				stdoutTruncated = true;
				child.kill("SIGKILL");
				return false;
			}
			capturedStdoutBytes += lineBytes;
			lines.push({ at, text: l });
			return true;
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, spec.timeLimitSeconds * 1000);
		child.stdout?.on("data", (d: Buffer) => {
			if (stdoutTruncated) return;
			const at = Date.now() - started;
			if (maxStdout !== undefined && capturedStdoutBytes + Buffer.byteLength(pending, "utf8") + d.length > maxStdout && !d.includes(0x0a)) {
				stdoutTruncated = true;
				pending = "";
				child.kill("SIGKILL");
				return;
			}
			pending += d.toString("utf8");
			const parts = pending.split("\n");
			pending = parts.pop() ?? "";
			for (const p of parts) {
				if (!pushLine(at, p)) {
					pending = "";
					break;
				}
			}
			if (!stdoutTruncated && maxStdout !== undefined && capturedStdoutBytes + Buffer.byteLength(pending, "utf8") > maxStdout) {
				stdoutTruncated = true;
				pending = "";
				child.kill("SIGKILL");
			}
		});
		child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
		if (spec.stdin !== null && child.stdin) {
			child.stdin.on("error", () => { /* the runtime may close its input early */ });
			child.stdin.end(spec.stdin);
		}
		const finish = (exit: number | null, signal: string | null): void => {
			clearTimeout(timer);
			if (spec.signal) spec.signal.removeEventListener("abort", onAbort);
			if (!stdoutTruncated && pending.trim()) pushLine(Date.now() - started, pending);
			resolve({
				lines,
				exit: timedOut || stdoutTruncated || aborted ? null : exit,
				signal: timedOut || stdoutTruncated || aborted ? "SIGKILL" : signal,
				timedOut,
				...(maxStdout !== undefined || stdoutTruncated ? { stdoutTruncated, capturedStdoutBytes } : {}),
				seconds: (Date.now() - started) / 1000,
				stderr,
			});
		};
		child.on("error", (e) => { stderr += String(e); finish(-1, null); });
		child.on("close", (code, signal) => finish(code, signal));
	});
}
