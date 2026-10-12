#!/usr/bin/env node
// context-lab - the command line over the core.
//
//   context-lab check  <pack>                     validate a pack; exit 1 with every defect
//   context-lab record <pack> <experiment>        fix an experiment in the pack's register
//   context-lab status <pack> <experiment>        the status a run of it would carry now
//   context-lab suite  <pack> <suite>             the scenarios a suite resolves to
//   context-lab entries <pack>                    the generated entry-to-scenario view
//   context-lab expose <pack> <scenario> <change> record that a change was informed by a held-out scenario
//   context-lab thresholds <pack> <comparison> <run-dir>
//                                                  derive an A/A rule's thresholds from an A/A run, and record them
//   context-lab compare <pack> <comparison> <base-run-dir> [--head DIR] [--runs K] [--nine DIR] [--nine-head DIR] [--out FILE]
//                                                  compare the rule's base and head arms; the head's run is the base's if not given
//   context-lab run    <pack> <suite> [--runs N] [--parallel P] [--work DIR]
//                                                  run a suite on the driven runtimes, to a tallied result

import fs from "node:fs";
import { checkPack, codexAdapter, compare, conductRun, deriveThresholds, entryView, opencodeAdapter, readTable, readThresholds, recordExperiment, recordExposure, recordThresholds, resolveSuite, runStatus, type LoadedPack } from "./index.js";

const [cmd, packDir, arg, arg2] = process.argv.slice(2);
const usage = "usage: context-lab check|record|status|suite|entries|expose|thresholds|compare|run <pack> [experiment|suite|scenario|comparison] [change|run-dir] [--runs N] [--parallel P] [--work DIR] [--revision REV]";
const flag = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const comparisonOf = (l: LoadedPack, id: string) => { const c = (l.pack.comparisons ?? []).find((x) => x.id === id); if (!c) { console.error(`no comparison ${id} in pack ${l.pack.id}`); process.exit(2); } return c; };

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
	case "expose": { const e = recordExposure(await load(), need(arg), need(arg2)); console.log(`exposed ${e.scenario} to ${e.change} at ${e.recordedAt}`); break; }
	case "thresholds": {
		const l = await load();
		const set = deriveThresholds(readTable(need(arg2)), comparisonOf(l, need(arg)));
		recordThresholds(l, set);
		console.log(JSON.stringify(set, null, 2));
		break;
	}
	case "compare": {
		const l = await load();
		const c = comparisonOf(l, need(arg));
		const runs = flag("--runs"), headDir = flag("--head"), nineDir = flag("--nine"), nineHead = flag("--nine-head"), out = flag("--out");
		const sets = readThresholds(l, c.id);
		const k = runs === undefined ? undefined : Number(runs);
		const r = compare({
			comparison: c, base: { dir: need(arg2), arm: c.base, ...(k !== undefined ? { runs: k } : {}) }, head: { dir: headDir ?? arg2!, arm: c.head, ...(k !== undefined ? { runs: k } : {}) },
			...(nineDir !== undefined ? { nine: { base: { dir: nineDir, arm: c.base }, head: { dir: nineHead ?? nineDir, arm: c.head } } } : {}),
			...(sets.length ? { thresholds: sets[sets.length - 1]! } : {}),
		});
		const text = JSON.stringify(r, null, 2) + "\n";
		if (out !== undefined) fs.writeFileSync(out, text);
		process.stdout.write(text);
		break;
	}
	case "entries": { console.log(JSON.stringify(Object.fromEntries(entryView(await load())), null, 2)); break; }
	case "run": {
		const runs = flag("--runs"), parallel = flag("--parallel"), work = flag("--work"), revision = flag("--revision");
		const { dir, record } = await conductRun(packDir ?? "", {
			suite: need(arg), adapters: { opencode: opencodeAdapter(), codex: codexAdapter() },
			...(runs !== undefined ? { runsPerCell: Number(runs) } : {}), ...(parallel !== undefined ? { parallel: Number(parallel) } : {}), ...(work !== undefined ? { work } : {}),
			...(revision !== undefined ? { revision } : {}),
		});
		console.log(`run ${record.run}: ${record.status} (${record.statusReason}); ${record.cells.length} cell(s); probes ${record.probes.filter((p) => p.pass).length}/${record.probes.length} passed; record at ${dir}`);
		break;
	}
	default: console.error(usage); process.exit(2);
}
