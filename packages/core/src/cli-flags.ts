// cli-flags - the run command's options, read from its arguments; apart from cli.ts so a test can
// show each flag reaches the run conductor.

export interface RunFlags { runsPerCell?: number; parallel?: number; work?: string; revision?: string }

export function runFlags(argv: string[]): RunFlags {
	const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : undefined; };
	const runs = flag("--runs"), parallel = flag("--parallel"), work = flag("--work"), revision = flag("--revision");
	return {
		...(runs !== undefined ? { runsPerCell: Number(runs) } : {}), ...(parallel !== undefined ? { parallel: Number(parallel) } : {}),
		...(work !== undefined ? { work } : {}), ...(revision !== undefined ? { revision } : {}),
	};
}
