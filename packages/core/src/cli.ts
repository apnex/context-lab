#!/usr/bin/env node
// context-lab - the command line over the core.
//
//   context-lab check  <pack>                     validate a pack; exit 1 with every defect
//   context-lab record <pack> <experiment>        fix an experiment in the pack's register
//   context-lab status <pack> <experiment>        the status a run of it would carry now
//   context-lab suite  <pack> <suite>             the scenarios a suite resolves to
//   context-lab entries <pack>                    the generated entry-to-scenario view
//   context-lab run    <pack> <suite> [--runs N] [--parallel P] [--work DIR]
//                                                  run a suite on the driven runtimes, through measured

import { checkPack, codexAdapter, conductRun, entryView, opencodeAdapter, recordExperiment, resolveSuite, runStatus, type LoadedPack } from "./index.js";

const [cmd, packDir, arg] = process.argv.slice(2);
const usage = "usage: context-lab check|record|status|suite|entries|run <pack> [experiment|suite] [--runs N] [--parallel P] [--work DIR]";

async function load(): Promise<LoadedPack> {
	if (packDir === undefined) throw new Error(usage);
	const r = await checkPack(packDir);
	if (!r.ok) {
		for (const d of r.defects) console.log(`DEFECT  ${d.check}  ${d.where}  ${d.message}`);
		process.exit(1);
	}
	return r.loaded;
}

const need = (v: string | undefined): string => { if (v === undefined) { console.error(usage); process.exit(2); } return v; };

switch (cmd) {
	case "check": { const l = await load(); console.log(`clean: pack ${l.pack.id}, ${l.experiments.size} experiment(s)`); break; }
	case "record": { const r = recordExperiment(await load(), need(arg)); console.log(`recorded ${r.experiment} ${r.hash}`); break; }
	case "status": { const s = runStatus(await load(), need(arg)); console.log(`${s.status}: ${s.reason}`); break; }
	case "suite": { const s = resolveSuite(await load(), need(arg)); console.log(JSON.stringify(s, null, 2)); break; }
	case "entries": { console.log(JSON.stringify(Object.fromEntries(entryView(await load())), null, 2)); break; }
	case "run": {
		const flag = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
		const runs = flag("--runs"), parallel = flag("--parallel"), work = flag("--work");
		const { dir, record } = await conductRun(packDir ?? "", {
			suite: need(arg), adapters: { opencode: opencodeAdapter(), codex: codexAdapter() },
			...(runs !== undefined ? { runsPerCell: Number(runs) } : {}), ...(parallel !== undefined ? { parallel: Number(parallel) } : {}), ...(work !== undefined ? { work } : {}),
		});
		console.log(`run ${record.run}: ${record.status} (${record.statusReason}); ${record.cells.length} cell(s); probes ${record.probes.filter((p) => p.pass).length}/${record.probes.length} passed; record at ${dir}`);
		break;
	}
	default: console.error(usage); process.exit(2);
}
