// cli-flags - the run command's options, read from its arguments; apart from cli.ts so a test can
// show each flag reaches the run conductor.

export interface RunFlags { runsPerCell?: number; maxAttemptsPerCell?: 1 | 2; parallel?: number; work?: string; revision?: string }

export function runFlags(argv: string[]): RunFlags {
	const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : undefined; };
	const runs = flag("--runs"), maxAttempts = flag("--max-attempts"), parallel = flag("--parallel"), work = flag("--work"), revision = flag("--revision");
	const m = maxAttempts !== undefined ? Number(maxAttempts) : undefined;
	return {
		...(runs !== undefined ? { runsPerCell: Number(runs) } : {}),
		...(m === 1 || m === 2 ? { maxAttemptsPerCell: m } : {}),
		...(parallel !== undefined ? { parallel: Number(parallel) } : {}),
		...(work !== undefined ? { work } : {}), ...(revision !== undefined ? { revision } : {}),
	};
}
