// judging-chain - classify-then-verify judging chains across three model families (architecture
// section 5, principle P3; Delta-3 stage 2, criteria G4, G5, G9).
//
// Every outcome passes through three distinct model families:
//   1. the reader's family F_i;
//   2. a classifier from another family F_c != F_i, which reads masked outcomes and quotes up to
//      25 words per finding;
//   3. a verifier from a third family F_v (F_v != F_i and F_v != F_c), which checks whether each
//      quote in context supports the finding.
//
// In live runs (`runJudgingChain`), a code check (`quoteInOutcome`) filters out quotes whose
// `words(quote)` is empty, exceeds 25 words, or contains a word absent from `new Set(words(outcome))`
// before spending stage-2 verifier calls. `countChain` operates on stage-2 verdicts and codeScores
// so both live runs and recorded legacy runs (`l-02`) are counted by the exact same function.

import fs from "node:fs";
import path from "node:path";
import type { Adapter, DeliveryMode, Invocation } from "./adapters.js";
import type { Unit } from "./blinder.js";
import { EMPTY_ARM } from "./judge-panel.js";
import { words } from "./measures.js";
import type { ChainFinding, ChainThreshold, JudgingChain, LoadedPack, Member, Scenario } from "./pack-schema.js";
import type { CellRecord } from "./run-conductor.js";
import { createWorkspace } from "./workspace-builder.js";

export const MAX_QUOTE_WORDS = 25;

/**
 * Checks that a classified quote has between 1 and 25 words (by `words()`) and that every word in
 * it appears in `words(outcomeText)`.
 */
export function quoteInOutcome(quote: string, outcomeText: string): { ok: true } | { ok: false; reason: string } {
	const qw = words(quote);
	if (qw.length === 0) return { ok: false, reason: "quote contains no words" };
	if (qw.length > MAX_QUOTE_WORDS) return { ok: false, reason: `quote has ${qw.length} words, exceeding ${MAX_QUOTE_WORDS}` };
	const ow = new Set(words(outcomeText));
	for (const w of qw) {
		if (!ow.has(w)) return { ok: false, reason: `word "${w}" does not appear in the outcome` };
	}
	return { ok: true };
}

export interface ClassifiedHit {
	unit: string;
	pid: string;
	scenario: string;
	readerFamily: string;
	classifier: string;
	classifierFamily: string;
	finding: string;
	quote: string;
}

export interface CodeRejectedHit extends ClassifiedHit {
	reason: string;
}

export interface VerifiedVerdict {
	unit: string;
	pid: string;
	finding: string;
	quote: string;
	verifier: string;
	verifierFamily: string;
	supports: boolean;
	reason: string;
}

export interface UnlistedItem {
	pid: string;
	family: string;
	scenario: string;
	text: string;
}

export interface ChainRecord {
	findings: ChainFinding[];
	threshold: ChainThreshold;
	classified: ClassifiedHit[];
	codeRejected: CodeRejectedHit[];
	verified: VerifiedVerdict[];
	unclassified: string[];
	news: UnlistedItem[];
}

export interface ChainEvidence {
	pid: string;
	family: string;
	scenario: string;
	/** Alias for scenario, matching zorg's FINDINGS-COUNT.json (`brief`). */
	brief: string;
	quote: string;
	source: "named" | "computed";
	reason?: string;
}

export interface ChainSummaryStats {
	readers: number;
	scenarios: string[];
	briefs: string[];
	heldOut: string[];
	families: string[];
}

export interface ChainFindingRow extends ChainSummaryStats {
	id: string;
	namedOnly: ChainSummaryStats;
	meets: boolean;
	rejected: number;
	unverified: number;
	codeRejected: number;
	evidence: ChainEvidence[];
	rejectedEvidence: ChainEvidence[];
}

export interface ChainCountResult {
	threshold: ChainThreshold;
	heldOut: string[];
	unclassified: string[];
	rows: ChainFindingRow[];
	news: UnlistedItem[];
}

/**
 * Assigns a classifier and verifier judge to a reader family `readerFamily` from a pool of judges
 * spanning at least 3 distinct model families.
 */
export function assignChainJudges(readerFamily: string, judges: Member[]): { classifier: Member; verifier: Member } {
	const families = [...new Set(judges.map((j) => j.family))].sort();
	if (families.length < 3) {
		throw new Error(`a classify-then-verify chain requires judges from at least 3 distinct model families, found ${families.length} (${families.join(", ")})`);
	}
	const otherFamilies = families.filter((f) => f !== readerFamily);
	if (otherFamilies.length < 2) {
		throw new Error(`fewer than 2 judge families outside reader family ${readerFamily}`);
	}
	const rIdx = families.indexOf(readerFamily);
	const cFam = rIdx >= 0 ? families[(rIdx + 1) % families.length]! : otherFamilies[0]!;
	let vFam = rIdx >= 0 ? families[(rIdx + 2) % families.length]! : otherFamilies[1]!;
	if (vFam === readerFamily || vFam === cFam) {
		vFam = otherFamilies.find((f) => f !== cFam)!;
	}
	const classifier = judges.find((j) => j.family === cFam)!;
	const verifier = judges.find((j) => j.family === vFam)!;
	return { classifier, verifier };
}

function parseJsonObject(text: string): unknown {
	const t = text.trim();
	const stripped = t.startsWith("```") ? t.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim() : t;
	try {
		return JSON.parse(stripped);
	} catch {
		const i = stripped.indexOf("{"), j = stripped.lastIndexOf("}");
		if (i >= 0 && j > i) {
			try { return JSON.parse(stripped.slice(i, j + 1)); } catch { return null; }
		}
		return null;
	}
}

export interface RunChainOptions {
	loaded: LoadedPack;
	chain: JudgingChain;
	units: Unit[];
	judges: Member[];
	adapters: Record<string, Adapter>;
	recordsDir: string;
	work: string;
	timeLimitSeconds?: number;
}

/**
 * Executes a two-stage classify-then-verify judging chain across at least 3 model families, filters
 * stage-1 quotes by `quoteInOutcome` before stage 2, and writes `judging/chain.json`.
 */
export async function runJudgingChain(o: RunChainOptions): Promise<ChainRecord> {
	// Refuse immediately if the judge pool has fewer than 3 distinct families.
	const families = [...new Set(o.judges.map((j) => j.family))].sort();
	if (families.length < 3) {
		throw new Error(`a classify-then-verify chain requires judges from at least 3 distinct model families, found ${families.length}`);
	}
	const threshold: ChainThreshold = o.chain.threshold ?? { minScenarios: 3, minHeldOut: 1, minFamilies: 2 };
	const namedFindings = o.chain.findings.filter((f) => f.kind === "named" || f.kind === "named or computed");
	const findingIds = new Set(namedFindings.map((f) => f.id));
	const findingList = namedFindings.map((f) => `${f.id}. ${f.statement} Counts when: ${f.countsWhen}`).join("\n");

	const classified: ClassifiedHit[] = [];
	const codeRejected: CodeRejectedHit[] = [];
	const unclassified: string[] = [];
	const news: UnlistedItem[] = [];

	fs.mkdirSync(path.join(o.recordsDir, "judging"), { recursive: true });

	// Stage 1: classify each unit with a classifier of another family.
	for (const u of o.units) {
		const { classifier } = assignChainJudges(u.family, o.judges);
		const adapter = o.adapters[classifier.runtime];
		if (!adapter) throw new Error(`no adapter for classifier runtime ${classifier.runtime}`);
		const mode: DeliveryMode = adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!;
		const prompt = [
			"You are classifying an outcome against a fixed list of findings.",
			"Apply each finding's condition strictly. For every finding that holds, copy a verbatim quote of at most 25 words from the outcome.",
			"",
			"FINDINGS:",
			findingList,
			"",
			"Do not use any tools. Reply with only a JSON object of this exact shape:",
			JSON.stringify({ findings: { [namedFindings[0]?.id ?? "F1"]: "verbatim quote from outcome" }, new: ["optional short unlisted observation"] }),
			"",
			`=== OUTCOME ${u.id} ===`,
			u.text,
		].join("\n");

		let parsed: { findings?: Record<string, unknown>; new?: unknown[] } | null = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			const ws = createWorkspace(o.loaded, { id: "chain-classify", tags: [], fixture: null, task: "", properties: [] }, EMPTY_ARM, { base: path.join(o.work, "judging", "workspaces"), rulesFiles: adapter.rulesFiles });
			fs.mkdirSync(path.join(o.work, "judging", "invocations"), { recursive: true });
			const invDir = fs.mkdtempSync(path.join(o.work, "judging", "invocations", "jc-"));
			fs.rmdirSync(invDir);
			const inv: Invocation = { arm: EMPTY_ARM, workspace: ws.dir, prompt, mode, member: classifier, tools: "off", timeLimitSeconds: o.timeLimitSeconds ?? 900, work: invDir };
			const out = await adapter.invoke(inv);
			if (out.tools.length > 0) continue;
			const raw = parseJsonObject(out.final);
			if (raw && typeof raw === "object" && "findings" in raw && typeof (raw as { findings: unknown }).findings === "object" && (raw as { findings: unknown }).findings !== null) {
				parsed = raw as { findings?: Record<string, unknown>; new?: unknown[] };
				break;
			}
		}
		if (!parsed) {
			unclassified.push(u.cell);
			continue;
		}
		for (const [fid, q] of Object.entries(parsed.findings ?? {})) {
			if (!findingIds.has(fid) || typeof q !== "string") continue;
			const hit: ClassifiedHit = {
				unit: u.id, pid: u.cell, scenario: u.scenario, readerFamily: u.family,
				classifier: classifier.id, classifierFamily: classifier.family, finding: fid, quote: q,
			};
			const check = quoteInOutcome(q, u.text);
			if (!check.ok) {
				codeRejected.push({ ...hit, reason: check.reason });
			} else {
				classified.push(hit);
			}
		}
		if (Array.isArray(parsed.new)) {
			for (const n of parsed.new) {
				if (typeof n === "string" && n.trim() !== "") {
					news.push({ pid: u.cell, family: u.family, scenario: u.scenario, text: n });
				}
			}
		}
	}

	// Stage 2: verify each surviving quote with a verifier of a third family (F_v != F_reader and F_v != F_classifier).
	const verified: VerifiedVerdict[] = [];
	const unitById = new Map(o.units.map((u) => [u.id, u]));
	for (const hit of classified) {
		const { verifier } = assignChainJudges(hit.readerFamily, o.judges);
		const adapter = o.adapters[verifier.runtime];
		if (!adapter) throw new Error(`no adapter for verifier runtime ${verifier.runtime}`);
		const mode: DeliveryMode = adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!;
		const u = unitById.get(hit.unit)!;
		const fDef = o.chain.findings.find((f) => f.id === hit.finding)!;
		const prompt = [
			"You are checking whether quoted evidence in an outcome supports a finding under its condition.",
			"Be strict: a quote that uses the same words but says something different does not support it.",
			"",
			`FINDING ${fDef.id}: ${fDef.statement} Counts when: ${fDef.countsWhen}`,
			`QUOTE: "${hit.quote}"`,
			"",
			"Do not use any tools. Reply with only a JSON object of this exact shape:",
			JSON.stringify({ supports: true, reason: "one sentence" }),
			"",
			`=== OUTCOME ${u.id} ===`,
			u.text,
		].join("\n");

		for (let attempt = 1; attempt <= 3; attempt++) {
			const ws = createWorkspace(o.loaded, { id: "chain-verify", tags: [], fixture: null, task: "", properties: [] }, EMPTY_ARM, { base: path.join(o.work, "judging", "workspaces"), rulesFiles: adapter.rulesFiles });
			fs.mkdirSync(path.join(o.work, "judging", "invocations"), { recursive: true });
			const invDir = fs.mkdtempSync(path.join(o.work, "judging", "invocations", "jv-"));
			fs.rmdirSync(invDir);
			const inv: Invocation = { arm: EMPTY_ARM, workspace: ws.dir, prompt, mode, member: verifier, tools: "off", timeLimitSeconds: o.timeLimitSeconds ?? 900, work: invDir };
			const out = await adapter.invoke(inv);
			if (out.tools.length > 0) continue;
			const raw = parseJsonObject(out.final);
			if (raw && typeof raw === "object" && typeof (raw as { supports?: unknown }).supports === "boolean") {
				const v = raw as { supports: boolean; reason?: unknown };
				verified.push({
					unit: hit.unit, pid: hit.pid, finding: hit.finding, quote: hit.quote,
					verifier: verifier.id, verifierFamily: verifier.family,
					supports: v.supports, reason: typeof v.reason === "string" ? v.reason : "",
				});
				break;
			}
		}
	}

	const record: ChainRecord = { findings: o.chain.findings, threshold, classified, codeRejected, verified, unclassified, news };
	fs.writeFileSync(path.join(o.recordsDir, "judging", "chain.json"), JSON.stringify(record, null, 2) + "\n");
	return record;
}

export interface CountChainInput {
	record: ChainRecord;
	cells: Pick<CellRecord, "cell" | "scenario" | "member" | "codeScores">[];
	members: Map<string, string>; // memberId -> family
	heldOutScenarios: Set<string>;
}

export interface LegacyZorgRunOptions {
	runDir: string;
	findings: ChainFinding[];
	heldOutScenarios: string[];
	families?: Record<string, string>;
	threshold?: ChainThreshold;
}

/**
 * Converts a recorded zorg composition-census run (such as `l-02`, with `sealed/manifest.json`,
 * `classify/classify-*.jsonl`, `verify/verify-*.items.json` + `.jsonl`, and `AGGREGATE.json`) into
 * a `CountChainInput` by format conversion only, with no arithmetic (Delta-3 stage 4, G9).
 */
export function readZorgLegacyRun(o: LegacyZorgRunOptions): CountChainInput {
	const families = o.families ?? { c: "claude", g: "gemini", o: "gpt" };
	const threshold = o.threshold ?? { minScenarios: 3, minHeldOut: 1, minFamilies: 2 };
	const manifest = JSON.parse(fs.readFileSync(path.join(o.runDir, "sealed", "manifest.json"), "utf8")) as {
		prompts: { pid: string; label: string; group: string }[];
	};
	const briefOf = (group: string): string => {
		const id = group.replace(/^census-/, "");
		return ({ zorg: "zorg", fleet: "fleet-config", tasks: "task-claims" } as Record<string, string>)[id] ?? id;
	};
	const byPid = new Map(manifest.prompts.map((p) => [p.pid, p]));

	const verified: VerifiedVerdict[] = [];
	const verifyDir = path.join(o.runDir, "verify");
	if (fs.existsSync(verifyDir)) {
		for (const f of fs.readdirSync(verifyDir).filter((x) => /^verify-.*\.items\.json$/.test(x)).sort()) {
			const items = JSON.parse(fs.readFileSync(path.join(verifyDir, f), "utf8")) as { item: string; pid: string; id: string; quote: string; suffix: string }[];
			const outFile = path.join(verifyDir, f.replace(".items.json", ".jsonl"));
			const byItem = new Map<string, { supports: boolean; reason: string }>();
			if (fs.existsSync(outFile)) {
				for (const line of fs.readFileSync(outFile, "utf8").split("\n")) {
					try {
						const v = JSON.parse(line) as { item?: unknown; supports?: unknown; reason?: unknown };
						if (typeof v.item === "string" && typeof v.supports === "boolean") {
							byItem.set(v.item, { supports: v.supports, reason: typeof v.reason === "string" ? v.reason : "" });
						}
					} catch {
						// ignore non-JSON lines
					}
				}
			}
			for (const it of items) {
				const v = byItem.get(it.item);
				if (v) {
					verified.push({
						unit: "", pid: it.pid, finding: it.id, quote: it.quote,
						verifier: f, verifierFamily: "", supports: v.supports, reason: v.reason,
					});
				}
			}
		}
	}

	const classified: ClassifiedHit[] = [];
	const unclassifiedSet = new Set(manifest.prompts.map((p) => p.pid));
	const news: UnlistedItem[] = [];
	const classifyDir = path.join(o.runDir, "classify");
	for (const f of fs.readdirSync(classifyDir).filter((x) => /^classify-[a-z]\d+\.jsonl$/.test(x)).sort()) {
		for (const line of fs.readFileSync(path.join(classifyDir, f), "utf8").split("\n")) {
			let parsed: { pid?: unknown; findings?: Record<string, unknown>; new?: unknown[] };
			try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
			if (typeof parsed.pid !== "string" || !byPid.has(parsed.pid)) continue;
			unclassifiedSet.delete(parsed.pid);
			const promptMeta = byPid.get(parsed.pid)!;
			const suffix = promptMeta.label.split("-").pop() ?? "";
			const readerFamily = families[suffix] ?? suffix;
			const scenario = briefOf(promptMeta.group);
			for (const [fid, quote] of Object.entries(parsed.findings ?? {})) {
				if (typeof quote !== "string") continue;
				classified.push({
					unit: "", pid: parsed.pid, scenario, readerFamily,
					classifier: f, classifierFamily: "", finding: fid, quote,
				});
			}
			for (const n of parsed.new ?? []) {
				if (typeof n === "string") news.push({ pid: parsed.pid, family: readerFamily, scenario, text: n });
			}
		}
	}

	const cells: CountChainInput["cells"] = [];
	const aggFile = path.join(o.runDir, "AGGREGATE.json");
	if (fs.existsSync(aggFile)) {
		const agg = JSON.parse(fs.readFileSync(aggFile, "utf8")) as {
			rows: { pid: string; family: string; brief: string; block: string; census: Record<string, { unused: string[] }> }[];
		};
		for (const r of agg.rows) {
			const codeScores: CellRecord["codeScores"] = [];
			if (r.block === "all used" || r.block === "all unused") {
				codeScores.push({ property: "L1", value: 1, measuredAt: "" });
			}
			if (r.census["agp"]?.unused.includes("request-correlation")) {
				codeScores.push({ property: "L8", value: 1, measuredAt: "" });
			}
			cells.push({ cell: r.pid, scenario: r.brief, member: r.family, codeScores });
		}
	}

	return {
		record: {
			findings: o.findings,
			threshold,
			classified,
			codeRejected: [],
			verified,
			unclassified: [...unclassifiedSet],
			news,
		},
		cells,
		members: new Map(Object.values(families).map((f) => [f, f])),
		heldOutScenarios: new Set(o.heldOutScenarios),
	};
}

/**
 * Joins classified evidence, stage-2 verifier verdicts, and code-measured computed findings, and
 * computes per-finding reader, scenario (`brief`), held-out, and family counts against the
 * threshold rule (`minScenarios`, `minHeldOut`, `minFamilies`).
 */
export function countChain(input: CountChainInput): ChainCountResult {
	const { record, cells, members, heldOutScenarios } = input;
	const { threshold } = record;
	const verdictByKey = new Map<string, VerifiedVerdict>();
	for (const v of record.verified) {
		if (v.unit) verdictByKey.set(`${v.unit}|${v.pid}|${v.finding}|${v.quote}`, v);
		verdictByKey.set(`${v.pid}|${v.finding}|${v.quote}`, v);
	}

	const evidence: Record<string, ChainEvidence[]> = {};
	const rejected: Record<string, ChainEvidence[]> = {};
	const unverified: Record<string, ChainEvidence[]> = {};
	const codeRejCount: Record<string, number> = {};

	for (const cr of record.codeRejected) {
		codeRejCount[cr.finding] = (codeRejCount[cr.finding] ?? 0) + 1;
	}

	for (const hit of record.classified) {
		const ev: ChainEvidence = {
			pid: hit.pid, family: hit.readerFamily, scenario: hit.scenario, brief: hit.scenario,
			quote: hit.quote, source: "named",
		};
		const v = (hit.unit ? verdictByKey.get(`${hit.unit}|${hit.pid}|${hit.finding}|${hit.quote}`) : undefined)
			?? verdictByKey.get(`${hit.pid}|${hit.finding}|${hit.quote}`);
		if (!v) {
			(unverified[hit.finding] ??= []).push(ev);
			continue;
		}
		if (!v.supports) {
			(rejected[hit.finding] ??= []).push({ ...ev, reason: v.reason });
			continue;
		}
		(evidence[hit.finding] ??= []).push(ev);
	}

	const computedKinds = new Set(record.findings.filter((f) => f.kind === "computed" || f.kind === "named or computed").map((f) => f.id));
	for (const c of cells) {
		const family = members.get(c.member) ?? c.member;
		for (const cs of c.codeScores) {
			if (computedKinds.has(cs.property) && "value" in cs && cs.value > 0) {
				(evidence[cs.property] ??= []).push({
					pid: c.cell, family, scenario: c.scenario, brief: c.scenario,
					quote: `${cs.property} computed`, source: "computed",
				});
			}
		}
	}

	const summarise = (evs: ChainEvidence[]): ChainSummaryStats => {
		const scenarios = [...new Set(evs.map((e) => e.scenario))];
		return {
			readers: new Set(evs.map((e) => e.pid)).size,
			scenarios,
			briefs: scenarios,
			heldOut: scenarios.filter((s) => heldOutScenarios.has(s)),
			families: [...new Set(evs.map((e) => e.family))],
		};
	};

	const allIds = [...new Set([
		...record.findings.map((f) => f.id),
		...Object.keys(evidence),
		...Object.keys(rejected),
		...Object.keys(unverified),
		...Object.keys(codeRejCount),
	])].filter((id) => (evidence[id]?.length ?? 0) > 0 || (rejected[id]?.length ?? 0) > 0 || (unverified[id]?.length ?? 0) > 0 || (codeRejCount[id] ?? 0) > 0)
		.sort((a, b) => {
			const na = Number(a.slice(1)), nb = Number(b.slice(1));
			if (!Number.isNaN(na) && !Number.isNaN(nb) && a[0] === b[0]) return na - nb;
			return a < b ? -1 : a > b ? 1 : 0;
		});

	const rows: ChainFindingRow[] = allIds.map((id) => {
		const ev = evidence[id] ?? [];
		const s = summarise(ev);
		const namedOnly = summarise(ev.filter((e) => e.source === "named"));
		const meets = s.scenarios.length >= threshold.minScenarios && s.heldOut.length >= threshold.minHeldOut && s.families.length >= threshold.minFamilies;
		return {
			id,
			...s,
			namedOnly,
			meets,
			rejected: (rejected[id] ?? []).length,
			unverified: (unverified[id] ?? []).length,
			codeRejected: codeRejCount[id] ?? 0,
			evidence: ev,
			rejectedEvidence: rejected[id] ?? [],
		};
	});

	return {
		threshold,
		heldOut: [...heldOutScenarios],
		unclassified: record.unclassified,
		rows,
		news: record.news,
	};
}
