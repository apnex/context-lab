// cli-flags - the run command's options, read from its arguments; apart from cli.ts so a test can
// show each flag reaches the run conductor.

export interface RunFlags { runsPerCell?: number; maxAttemptsPerCell?: 1 | 2; parallel?: number; work?: string; revision?: string }

export function runFlags(argv: string[]): RunFlags {
	const flag = (n: string): string | undefined => {
		const i = argv.indexOf(n);
		if (i <= 0) return undefined;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) throw new Error(`${n} requires a value`);
		return next;
	};
	const runs = flag("--runs"), maxAttempts = flag("--max-attempts"), parallel = flag("--parallel"), work = flag("--work"), revision = flag("--revision");
	let m: 1 | 2 | undefined;
	if (maxAttempts !== undefined) {
		const n = Number(maxAttempts);
		if (n !== 1 && n !== 2) throw new Error(`--max-attempts must be 1 or 2, got ${JSON.stringify(maxAttempts)}`);
		m = n;
	}
	return {
		...(runs !== undefined ? { runsPerCell: Number(runs) } : {}),
		...(m !== undefined ? { maxAttemptsPerCell: m } : {}),
		...(parallel !== undefined ? { parallel: Number(parallel) } : {}),
		...(work !== undefined ? { work } : {}), ...(revision !== undefined ? { revision } : {}),
	};
}
