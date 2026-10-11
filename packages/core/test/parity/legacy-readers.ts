// Legacy-record readers (Delta-1 stage 6): convert mission-kit's past run records into the core's
// tally input, by format conversion only - no arithmetic is done here, so any number that comes out
// is the core tally's. Each reader mirrors exactly which records its old tool counted.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Absent, CellRecord, Scenario, TallyInput, Unit, Vote } from "../../src/index.js";

const readJSON = <T>(f: string): T => JSON.parse(fs.readFileSync(f, "utf8")) as T;

function cell(id: string, scenario: string, arm: string, member: string): CellRecord {
	return {
		cell: id, scenario, arm, member, run: 1, valid: true, final: null, scoredFile: null, answers: {}, diff: null, codeScores: [],
		attempts: [{ attempt: 1, validity: { valid: true }, outcome: { final: "", exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" }, diff: null }],
	};
}

const scenario = (id: string, props: string[], scale: [number, number]): Scenario => ({
	id, tags: [], fixture: null, task: "", properties: props.map((p) => ({ id: p, type: "comprehension", decidedBy: "judge", key: "", scale })),
});

// --- eval.mjs: sealed/manifest.json, sealed/blind.json, scores/<suite>.txt ---------------------

interface EvalManifest { corpora: { label: string }[]; prompts: { pid: string; label: string; group: string; reader: number; probes: string[] }[] }
interface EvalBlind { suites: string[]; items: { item: string; pid: string; probe: string }[]; absent: { pid: string; probe: string }[] }

/** eval.mjs's score lines: any {...} on a line that parses with a string item, as its parseScores read them. */
function parseScoreLines(text: string): { item: string; score: unknown }[] {
	const out: { item: string; score: unknown }[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/\{.*\}/);
		if (!m) continue;
		try { const o = JSON.parse(m[0]) as { item?: unknown; score?: unknown }; if (typeof o.item === "string") out.push({ item: o.item, score: o.score }); } catch { /* not a score line */ }
	}
	return out;
}

export function readEvalRun(run: string): TallyInput {
	const m = readJSON<EvalManifest>(path.join(run, "sealed", "manifest.json"));
	const b = readJSON<EvalBlind>(path.join(run, "sealed", "blind.json"));
	const labels = [...new Set(m.corpora.map((c) => c.label))];
	const groups = [...new Set(m.prompts.map((p) => p.group))];
	const scenarios = new Map(groups.map((g) => [g, scenario(g, [...new Set(m.prompts.filter((p) => p.group === g).flatMap((p) => p.probes))], [0, 2])]));
	const cells = m.prompts.map((p) => cell(p.pid, p.group, p.label, `r${p.reader}`));
	const groupOf = new Map(m.prompts.map((p) => [p.pid, p]));
	const units: Unit[] = b.items.map((i) => {
		const p = groupOf.get(i.pid)!;
		return { id: i.item, cell: i.pid, scenario: p.group, arm: p.label, member: `r${p.reader}`, family: "reader", properties: [i.probe], text: "", blindedAt: "" };
	});
	const absent: Absent[] = b.absent.map((a) => ({ cell: a.pid, property: a.probe }));
	const probeOf = new Map(b.items.map((i) => [i.item, i.probe]));
	const votes: Vote[] = [];
	for (const s of b.suites) {
		const f = path.join(run, "scores", `${s}.txt`);
		if (!fs.existsSync(f)) continue;
		for (const sc of parseScoreLines(fs.readFileSync(f, "utf8"))) {
			if (!probeOf.has(sc.item) || votes.some((v) => v.unit === sc.item)) continue;
			votes.push({ unit: sc.item, property: probeOf.get(sc.item)!, judge: "scorer", family: "scorer", value: [0, 1, 2].includes(sc.score as number) ? (sc.score as number) : null, reason: "", guess: null, prompt: s });
		}
	}
	return {
		run: path.basename(run), status: "legacy", arms: labels, members: [...new Set(cells.map((c) => c.member))], scenarios, cells, units, absent, votes,
		assigned: () => ["scorer"], guessGroups: {},
	};
}

// --- adherence.mjs: run.json, suite.json, sealed/manifest.json, scores/<prompt>.json ------------

interface AdhRun { traps: string[]; arms: string[]; families: Record<string, unknown> }
interface AdhSuite { traps: { id: string; key: { id: string }[] }[] }
interface AdhManifest { prompts: { name: string }[]; map: Record<string, string> }
interface AdhSheet { promptHash?: string; outcomes?: { id?: string; scores?: Record<string, { v?: unknown }>; guess?: unknown }[] }

const hex12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** One tally input per trap, as adherence.mjs tallied per trap. */
export function readAdherenceRun(run: string): Map<string, TallyInput> {
	const meta = readJSON<AdhRun>(path.join(run, "run.json"));
	const suite = readJSON<AdhSuite>(path.join(run, "suite.json"));
	const man = readJSON<AdhManifest>(path.join(run, "sealed", "manifest.json"));
	// Only sheets whose prompt hash matches their prompt file, as adherence.mjs used.
	const sheets = new Map<string, AdhSheet>();
	for (const p of man.prompts) {
		const f = path.join(run, "scores", `${p.name}.json`);
		if (!fs.existsSync(f)) continue;
		const sh = readJSON<AdhSheet>(f);
		if (sh.promptHash === hex12(fs.readFileSync(path.join(run, "scorer", `${p.name}.txt`), "utf8"))) sheets.set(p.name, sh);
	}
	const out = new Map<string, TallyInput>();
	for (const tid of meta.traps) {
		const trap = suite.traps.find((x) => x.id === tid)!;
		const keys = trap.key.map((k) => k.id);
		const scen = scenario(tid, keys, [0, 1]);
		const units = new Map<string, Unit>();
		const judgesOf = new Map<string, string[]>();
		const votes: Vote[] = [];
		for (const [k, c] of Object.entries(man.map)) {
			const [name, oid] = k.split("/") as [string, string];
			if (!name.startsWith(`${tid}.`)) continue;
			const [, arm, fam] = c.split(".") as [string, string, string];
			const judge = name.split(".")[1]!;
			if (!units.has(c)) units.set(c, { id: c, cell: c, scenario: tid, arm, member: fam, family: fam, properties: keys, text: "", blindedAt: "" });
			judgesOf.set(c, [...(judgesOf.get(c) ?? []), judge]);
			const o = sheets.get(name)?.outcomes?.find((x) => x.id === oid);
			const guess = o?.guess === "guided" || o?.guess === "unguided" ? o.guess : null;
			for (const key of keys) {
				const v = o?.scores?.[key]?.v;
				votes.push({ unit: c, property: key, judge, family: judge, value: v === 0 || v === 1 ? v : null, reason: "", guess, prompt: name });
			}
		}
		const cells = [...units.values()].map((u) => cell(u.cell, tid, u.arm, u.member));
		out.set(tid, {
			run: path.basename(run), status: "legacy", arms: meta.arms, members: Object.keys(meta.families), scenarios: new Map([[tid, scen]]), cells,
			units: [...units.values()], absent: [], votes, assigned: (u) => judgesOf.get(u.id) ?? [], guessGroups: { unguided: ["control"], guided: meta.arms.filter((a) => a !== "control") },
		});
	}
	return out;
}
