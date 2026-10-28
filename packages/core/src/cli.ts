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
//   context-lab run    <pack> <suite|experiment> [--runs N] [--parallel P] [--work DIR]
//                                                  run a suite or experiment on the driven runtimes, to a tallied result
//   context-lab calibrate <pack> <suite|experiment> --response <file> [--arm ARM] [--out DIR] [--parallel P] [--work DIR]
//                                                  run fixed-answer judge calibration with zero reader invocations
//   context-lab resume <pack> <run-dir> [--parallel P] [--work DIR]
//                                                  resume a run that stopped during execution
//   context-lab pick   <pack> <run-dir> [--mode calibration|preference] [--count N] [--with ARM] [--without ARM]
//                                                  run the human panel on a judged run and re-tally
//   context-lab candidates <pack> <run-dir>        write CANDIDATES.json and CANDIDATES.md for a run
//   context-lab review <pack> --prompt <file> [--files <path,...>] --out <dir> [--members <id,...>] [--verify] [--parallel N] [--tools on|off] [--sockets] [--mount-sources] [--ro <path,...>] [--timeout N]
//                                                  run a review prompt across model families and optionally cross-verify

import fs from "node:fs";
import { assertIdenticalArms, calibrateRun, checkPack, codexAdapter, compare, conductRun, deriveThresholds, entryView, opencodeAdapter, pickRun, readTable, readThresholds, recordExperiment, recordExposure, recordThresholds, previewRun, resolveSuite, resumeRun, runReview, runStatus, unrecordedResults, writeRunCandidates, type LoadedPack } from "./index.js";

const [cmd, packDir, arg, arg2] = process.argv.slice(2);
const usage = "usage: context-lab check|record|status|suite|entries|expose|thresholds|compare|run|calibrate|resume|pick|candidates|review|preview <pack> [experiment|suite|scenario|comparison|run-dir] [change|run-dir] [--runs N] [--parallel P] [--work DIR] [--revision REV] [--prompt FILE] [--files PATH,...] [--out DIR] [--members ID,...] [--verify] [--response FILE] [--arm ARM]";
import { runFlags } from "./cli-flags.js";
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
	case "check": {
		const l = await load();
		console.log(`clean: pack ${l.pack.id}, ${l.experiments.size} experiment(s)`);
		for (const u of unrecordedResults(l)) console.log(`note: ${u.experiment} declares result, but a run of it now would be exploration: ${u.reason}; record it before its next run`);
		break;
	}
	case "record": { const r = recordExperiment(await load(), need(arg)); console.log(`recorded ${r.experiment} ${r.hash}`); break; }
	case "status": { const s = runStatus(await load(), need(arg)); console.log(`${s.status}: ${s.reason}`); break; }
	case "suite": { const s = resolveSuite(await load(), need(arg)); console.log(JSON.stringify(s, null, 2)); break; }
	case "expose": { const e = recordExposure(await load(), need(arg), need(arg2)); console.log(`exposed ${e.scenario} to ${e.change} at ${e.recordedAt}`); break; }
	case "thresholds": {
		const l = await load();
		const c = comparisonOf(l, need(arg));
		const table = readTable(need(arg2));
		assertIdenticalArms(l, c, table.record);
		const set = deriveThresholds(table, c);
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
		const l = await load();
		const target = need(arg);
		const isSuite = l.pack.suites.some((s) => s.id === target);
		const { dir, record } = await conductRun(packDir ?? "", {
			...(isSuite ? { suite: target } : { experiment: target }),
			adapters: { opencode: opencodeAdapter(), codex: codexAdapter() },
			...runFlags(process.argv),
		});
		console.log(`run ${record.run}: ${record.status} (${record.statusReason}); ${record.cells.length} cell(s); probes ${record.probes.filter((p) => p.pass).length}/${record.probes.length} passed; record at ${dir}`);
		break;
	}
	case "calibrate": {
		const l = await load();
		const target = need(arg);
		const isSuite = l.pack.suites.some((s) => s.id === target);
		const flags = runFlags(process.argv);
		const responseFile = need(flags.response);
		const { dir, record } = await calibrateRun(packDir ?? "", {
			...(isSuite ? { suite: target } : { experiment: target }),
			responseFile,
			adapters: { opencode: opencodeAdapter(), codex: codexAdapter() },
			...flags,
		});
		console.log(`calibrate ${record.run}: ${record.status} (${record.statusReason}); ${record.cells.length} synthetic cell(s); judgeProbes ${record.judgeProbes.filter((p) => p.pass).length}/${record.judgeProbes.length} passed; invocations ${record.invocationSummary?.dispatchedTotal ?? 0}; record at ${dir}`);
		break;
	}
	case "resume": {
		const flags = runFlags(process.argv);
		const { dir, record } = await resumeRun(packDir ?? "", need(arg), {
			adapters: { opencode: opencodeAdapter(), codex: codexAdapter() },
			...flags,
		});
		console.log(`resumed ${record.run}: ${record.status} (${record.statusReason}); ${record.cells.length} cell(s); probes ${record.probes.filter((p) => p.pass).length}/${record.probes.length} passed; record at ${dir}`);
		break;
	}
	case "pick": {
		await load();
		const modeFlag = flag("--mode") as "calibration" | "preference" | undefined;
		const countFlag = flag("--count"), withArm = flag("--with"), withoutArm = flag("--without");
		const { picks } = await pickRun(need(arg), {
			...(modeFlag !== undefined ? { mode: modeFlag } : {}),
			...(countFlag !== undefined ? { count: Number(countFlag) } : {}),
			...(withArm !== undefined ? { withArm } : {}),
			...(withoutArm !== undefined ? { withoutArm } : {}),
		});
		console.log(`picked ${picks.answers.length} item(s) (${picks.complete ? "complete" : "incomplete"})`);
		break;
	}
	case "preview": {
		const flags = runFlags(process.argv);
		const outDir = need(flags.out);
		const responseFile = flags.response, members = flag("--members"), revision = flags.revision;
		const p = await previewRun(packDir ?? "", need(arg), {
			...flags,
			adapters: { opencode: opencodeAdapter(), codex: codexAdapter() }, out: outDir,
			...(responseFile !== undefined ? { response: fs.readFileSync(responseFile, "utf8") } : {}),
			...(members !== undefined ? { members: members.split(",").filter(Boolean) } : {}),
			...(revision !== undefined ? { revision } : {}),
		});
		console.log(`preview ${p.suite ?? p.experiment}: ${p.readers.length} reader invocation(s), ${p.judges.length} judge job(s), nothing invoked; written to ${outDir}`);
		break;
	}
	case "candidates": {
		const packet = await writeRunCandidates(packDir ?? "", need(arg));
		console.log(`candidates ${packet.run}: ${packet.candidates.length} candidate(s) written`);
		break;
	}
	case "review": {
		const promptFile = need(flag("--prompt")), outDir = need(flag("--out"));
		const filesArg = flag("--files"), membersArg = flag("--members"), parallelArg = flag("--parallel"), workArg = flag("--work");
		const toolsArg = flag("--tools") as "on" | "off" | undefined;
		const roArg = flag("--ro"), timeoutArg = flag("--timeout");
		const verify = process.argv.includes("--verify");
		const mountSources = process.argv.includes("--mount-sources");
		const sockets = process.argv.includes("--sockets");
		const packet = await runReview(packDir ?? "", {
			promptFile, outDir, verify, mountSources, sockets,
			...(filesArg !== undefined ? { files: filesArg.split(",").filter(Boolean) } : {}),
			...(membersArg !== undefined ? { members: membersArg.split(",").filter(Boolean) } : {}),
			...(parallelArg !== undefined ? { parallel: Number(parallelArg) } : {}),
			...(workArg !== undefined ? { work: workArg } : {}),
			...(toolsArg === "on" || toolsArg === "off" ? { tools: toolsArg } : {}),
			...(roArg !== undefined ? { ro: roArg.split(",").filter(Boolean) } : {}),
			...(timeoutArg !== undefined ? { timeLimitSeconds: Number(timeoutArg) } : {}),
			adapters: { opencode: opencodeAdapter(), codex: codexAdapter() },
		});
		console.log(`review ${packet.pack}: ${packet.members.length} model(s), ${packet.findings.length} finding(s), written to ${outDir}`);
		break;
	}
	default: console.error(usage); process.exit(2);
}
