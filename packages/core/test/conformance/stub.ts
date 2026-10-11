// The stub runtime the conformance cases run against: a POSIX sh script, named as the runtime, that
// records its arguments, environment, standard input, what it can see inside the sandbox and its
// configuration folder, then replays an event stream embedded in itself - or never exits.

import fs from "node:fs";
import path from "node:path";

export interface StubOptions {
	stream?: string;
	hang?: { tag: string };
	sentinels?: string[];
	visible?: string[];
	configVar?: "XDG_CONFIG_HOME" | "CODEX_HOME";
}

const MARK = "__CONTEXT_LAB_STREAM__";

export function stubScript(o: StubOptions): string {
	const lines = [
		"#!/bin/sh",
		'R="$PWD/.stub-record"',
		'mkdir -p "$R"',
		'for a in "$@"; do printf \'%s\\0\' "$a"; done > "$R/argv"',
		'env | LC_ALL=C sort > "$R/env"',
		'cat > "$R/stdin"',
		': > "$R/sentinels"',
		...(o.sentinels ?? []).map((s) => `if [ -e '${s}' ]; then echo 'visible ${s}' >> "$R/sentinels"; else echo 'absent ${s}' >> "$R/sentinels"; fi`),
		...(o.visible ?? []).map((s) => `if [ -r '${s}' ]; then echo 'readable ${s}' >> "$R/sentinels"; else echo 'unreadable ${s}' >> "$R/sentinels"; fi`),
	];
	if (o.configVar) lines.push(`(cd "$${o.configVar}" && find . -type f | LC_ALL=C sort) > "$R/config-files"`);
	if (o.configVar === "CODEX_HOME") lines.push(': > "$CODEX_HOME/state_5.sqlite"', ': > "$CODEX_HOME/logs_2.sqlite-wal"');
	// A runtime writing a login into its kept data folder, which the adapter must remove (C25).
	if (o.configVar === "XDG_CONFIG_HOME") lines.push('mkdir -p "$XDG_DATA_HOME/opencode" && echo login > "$XDG_DATA_HOME/opencode/auth.json"');
	if (o.hang) {
		lines.push(`sleep ${o.hang.tag}1 &`, `setsid sleep ${o.hang.tag}2 &`, "wait");
	} else {
		const stream = o.stream ? fs.readFileSync(o.stream, "utf8") : "";
		if (stream.includes(MARK)) throw new Error("the stream holds the stub's marker");
		lines.push(`cat <<'${MARK}'`, stream.replace(/\n$/, ""), MARK);
	}
	lines.push("exit 0", "");
	return lines.join("\n");
}

/** A stub opencode binary: one executable file. */
export function opencodeStub(dir: string, o: StubOptions): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "opencode");
	fs.writeFileSync(bin, stubScript({ ...o, configVar: "XDG_CONFIG_HOME" }), { mode: 0o755 });
	return bin;
}

/** A stub Codex vendor directory, holding bin/codex. */
export function codexStub(dir: string, o: StubOptions): string {
	fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(dir, "bin", "codex"), stubScript({ ...o, configVar: "CODEX_HOME" }), { mode: 0o755 });
	return dir;
}

export interface Record {
	argv: string[];
	env: Map<string, string>;
	stdin: string;
	sentinels: string[];
	configFiles: string[];
}

export function readRecord(cwd: string): Record {
	const r = path.join(cwd, ".stub-record");
	const read = (f: string): string => (fs.existsSync(path.join(r, f)) ? fs.readFileSync(path.join(r, f), "utf8") : "");
	const env = new Map<string, string>();
	for (const l of read("env").split("\n")) {
		const i = l.indexOf("=");
		if (i > 0) env.set(l.slice(0, i), l.slice(i + 1));
	}
	return {
		argv: read("argv").split("\0").slice(0, -1),
		env,
		stdin: read("stdin"),
		sentinels: read("sentinels").split("\n").filter(Boolean),
		configFiles: read("config-files").split("\n").filter(Boolean),
	};
}
