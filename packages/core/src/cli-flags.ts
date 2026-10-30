// cli-flags - the run, calibrate and preview commands' options, read from their arguments; apart
// from cli.ts so a test can show each flag reaches the run conductor.

import type { LimitOverrides } from "./pack-schema.js";

export interface RunFlags extends LimitOverrides {
	runsPerCell?: number;
	maxAttemptsPerCell?: 1 | 2;
	parallel?: number;
	work?: string;
	revision?: string;
	timeLimitSeconds?: number;
	arm?: string;
	out?: string;
	response?: string;
	calibrate?: boolean;
}

export function runFlags(argv: string[]): RunFlags {
	const flag = (n: string): string | undefined => {
		const i = argv.indexOf(n);
		if (i <= 0) return undefined;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) throw new Error(`${n} requires a value`);
		return next;
	};
	const posInt = (n: string): number | undefined => {
		const raw = flag(n);
		if (raw === undefined) return undefined;
		const v = Number(raw);
		if (!Number.isInteger(v) || v <= 0) throw new Error(`${n} must be a positive integer, got ${JSON.stringify(raw)}`);
		return v;
	};
	const oneTwoThree = (n: string): 1 | 2 | 3 | undefined => {
		const raw = flag(n);
		if (raw === undefined) return undefined;
		const v = Number(raw);
		if (v !== 1 && v !== 2 && v !== 3) throw new Error(`${n} must be 1, 2 or 3, got ${JSON.stringify(raw)}`);
		return v;
	};
	const runs = flag("--runs"), maxAttempts = flag("--max-attempts"), parallel = flag("--parallel"), work = flag("--work"), revision = flag("--revision");
	const arm = flag("--arm"), out = flag("--out"), response = flag("--response");
	let m: 1 | 2 | undefined;
	if (maxAttempts !== undefined) {
		const n = Number(maxAttempts);
		if (n !== 1 && n !== 2) throw new Error(`--max-attempts must be 1 or 2, got ${JSON.stringify(maxAttempts)}`);
		m = n;
	}
	const readerTimeLimitSeconds = posInt("--reader-timeout") ?? posInt("--timeout");
	const judgeTimeLimitSeconds = posInt("--judge-timeout");
	const probeTimeLimitSeconds = posInt("--probe-timeout");
	const maxProbeAttempts = oneTwoThree("--max-probe-attempts");
	const maxJudgeAttempts = oneTwoThree("--max-judge-attempts");
	const maxResponseBytes = posInt("--max-response-bytes");
	const maxReaderInputBytes = posInt("--max-reader-input-bytes");
	const maxJudgeInputBytes = posInt("--max-judge-input-bytes");
	const maxProbeInputBytes = posInt("--max-probe-input-bytes");
	const maxJudgeReplyBytes = posInt("--max-judge-reply-bytes");
	const maxProbeReplyBytes = posInt("--max-probe-reply-bytes");
	const maxStdoutBytes = posInt("--max-stdout-bytes");
	const maxTotalInvocations = posInt("--max-total-invocations");
	return {
		...(runs !== undefined ? { runsPerCell: Number(runs) } : {}),
		...(m !== undefined ? { maxAttemptsPerCell: m } : {}),
		...(parallel !== undefined ? { parallel: Number(parallel) } : {}),
		...(work !== undefined ? { work } : {}),
		...(revision !== undefined ? { revision } : {}),
		...(arm !== undefined ? { arm } : {}),
		...(out !== undefined ? { out } : {}),
		...(response !== undefined ? { response } : {}),
		...(argv.includes("--calibrate") ? { calibrate: true } : {}),
		...(readerTimeLimitSeconds !== undefined ? { readerTimeLimitSeconds, timeLimitSeconds: readerTimeLimitSeconds } : {}),
		...(judgeTimeLimitSeconds !== undefined ? { judgeTimeLimitSeconds } : {}),
		...(probeTimeLimitSeconds !== undefined ? { probeTimeLimitSeconds } : {}),
		...(maxProbeAttempts !== undefined ? { maxProbeAttempts } : {}),
		...(maxJudgeAttempts !== undefined ? { maxJudgeAttempts } : {}),
		...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
		...(maxReaderInputBytes !== undefined ? { maxReaderInputBytes } : {}),
		...(maxJudgeInputBytes !== undefined ? { maxJudgeInputBytes } : {}),
		...(maxProbeInputBytes !== undefined ? { maxProbeInputBytes } : {}),
		...(maxJudgeReplyBytes !== undefined ? { maxJudgeReplyBytes } : {}),
		...(maxProbeReplyBytes !== undefined ? { maxProbeReplyBytes } : {}),
		...(maxStdoutBytes !== undefined ? { maxStdoutBytes } : {}),
		...(maxTotalInvocations !== undefined ? { maxTotalInvocations } : {}),
	};
}
