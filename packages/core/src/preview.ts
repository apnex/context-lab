// preview - renders what a run would hand its readers and judges, contacting no runtime (B20).
//
// For each reader cell of run 1 and each of its phases it builds the workspace, the prompt and the
// invocation as a run does, and asks the runtime's adapter to prepare it - the files, command,
// environment and mounts invoke would use - without running it, reading a credential or copying a
// cache. For the judges it takes one sample response as every reader's reply, cuts and extracts it
// as a run does, blinds and masks it as a run does, plans the judge jobs as a run does, and renders
// each job's first prompt and a retry prompt, each prepared by the judge's adapter.
//
// Every step calls the function a run calls: the phase prompt, the reader and judge invocations,
// the phase text, answer extraction, the blinder, the job planner and the judge prompt. What a run
// generates - its work folder, workspaces, sessions, notes, the seed's shuffle - is named as
// generated, and what the preview cannot render is listed, never filled in.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Adapter, PreparedInvocation } from "./adapters.js";
import { Refused } from "./adapters.js";
import { composeArm, type ComposedArm } from "./arm-composer.js";
import type { AnswerExtraction } from "./answer-parser.js";
import { blind } from "./blinder.js";
import { assignTraps, phasePrompt, propertyPhase, readerInvocation } from "./episode.js";
import { runStatus } from "./experiment-register.js";
import { EMPTY_ARM, judgeInvocation, judgePrompt, planJudgeJobs } from "./judge-panel.js";
import type { Outcome } from "./outcome.js";
import { checkPack } from "./pack-checker.js";
import { phasesOf, propertiesOf, type Member, type Scenario } from "./pack-schema.js";
import { answersOf, deliveredOf, phaseText, type CellRecord } from "./run-conductor.js";
import { resolveSuite } from "./selector.js";
import { buildVariant, variantDir, type BuiltVariant } from "./variant-builder.js";
import { createWorkspace } from "./workspace-builder.js";

export interface PreviewOptions {
	adapters: Record<string, Adapter>;
	/** A new folder for the preview: its work folder, PREVIEW.json and PREVIEW.md. */
	out: string;
	/** A sample reader response, given as every reader's reply to render extraction, masking and the judge prompts; a placeholder answering every heading if not given. */
	response?: string;
	/** Only these population members, as readers and judges. */
	members?: string[];
	/** The source revision of variants that pin none; the source's HEAD if not given, as a run. */
	revision?: string;
	timeLimitSeconds?: number;
	judgeTimeLimitSeconds?: number;
	/** The seed judge jobs are shuffled with; a run uses its run id. */
	seed?: string;
}

export interface PreviewReader {
	cell: string;
	scenario: string;
	arm: string;
	member: string;
	phase: string;
	session: "new" | "continue";
	/** The prepared invocation, or why it could not be rendered. */
	prepared: PreparedInvocation | null;
	unrendered: string | null;
	prompt: string;
	promptBytes: number;
	/** Placeholders in the prompt for what a run generates. */
	generated: string[];
}

export interface PreviewAnswer {
	cell: string;
	property: string;
	/** UTF-8 bytes at each step: the sample response, after self-explanation stripping, after the bound, the answer extracted, and the unit judges see. */
	bytes: { response: number; stripped: number; bounded: number; answer: number | null; unit: number | null };
	/** For a property judged with its assigned reading: the reading's UTF-8 bytes as delivered (each file trimmed, joined by a blank line) and as masked in the unit; null otherwise. */
	reading: { original: number; masked: number } | null;
	extraction: AnswerExtraction;
	unit: string | null;
}

export interface PreviewJudgeJob {
	name: string;
	judge: string;
	scenario: string;
	/** The units in the first prompt, with the cell and properties each holds: analyst associations, never in the prompt. */
	units: { id: string; cell: string; properties: string[] }[];
	first: { attempt: 1; prompt: string; bytes: number; local: Record<string, string>; prepared: PreparedInvocation | null; unrendered: string | null };
	/** A retry after the first unit has a valid vote: the same prompt over the rest; null for a job of one unit, whose retry repeats the first prompt. */
	retry: { attempt: 2; prompt: string; bytes: number; local: Record<string, string>; prepared: PreparedInvocation | null; unrendered: string | null } | null;
}

export interface Preview {
	pack: string;
	experiment: string;
	suite: string | null;
	/** What a run of the experiment would be labelled now, and its registered hash. */
	status: { status: string; reason: string; hash: string | null };
	variants: Record<string, { source: string; revision: string; dir: string } | { failed: string }>;
	arms: Record<string, { composed: boolean; reason?: string }>;
	seed: string;
	response: { given: boolean; bytes: number };
	readers: PreviewReader[];
	answers: PreviewAnswer[];
	judges: PreviewJudgeJob[];
	/** Values a run generates, which differ between runs and from this preview. */
	generated: string[];
	/** What this preview does not reproduce, beside what each prepared invocation lists. */
	notRendered: string[];
	/** Members without an adapter that can prepare, and why. */
	unsupported: { member: string; reason: string }[];
}

const bytes = (t: string): number => Buffer.byteLength(t, "utf8");

/** The placeholder response: every answer heading with a sample answer, and a sample message for the rest. */
function placeholderResponse(scenarios: Scenario[]): string {
	const heads = [...new Set(scenarios.flatMap((s) => propertiesOf(s).map((p) => p.answerHeading).filter((h): h is string => h !== undefined)))];
	return heads.length ? heads.map((h) => `### ${h}\n<sample answer to ${h}>`).join("\n\n") + "\n" : "<sample final message>\n";
}

function tryPrepare(adapter: Adapter, inv: Parameters<NonNullable<Adapter["prepare"]>>[0]): { prepared: PreparedInvocation | null; unrendered: string | null } {
	try {
		return { prepared: adapter.prepare!(inv), unrendered: null };
	} catch (e) {
		if (e instanceof Refused) return { prepared: null, unrendered: e.message };
		throw e;
	}
}

/** Renders a suite's or an experiment's reader and judge invocations into `opts.out`, and returns the preview; nothing is invoked. */
export async function previewRun(packDir: string, target: string, opts: PreviewOptions): Promise<Preview> {
	const checked = await checkPack(packDir);
	if (!checked.ok) throw new Error(`the pack fails its check: ${checked.defects.map((d) => `${d.check} ${d.where} ${d.message}`).join("; ")}`);
	const loaded = checked.loaded;
	const suite = loaded.pack.suites.find((s) => s.id === target);
	const experimentId = suite ? suite.experiment : target;
	const exp = loaded.experiments.get(experimentId);
	if (!exp) throw new Error(`no suite or experiment ${target} in pack ${loaded.pack.id}`);
	const scenarioIds = suite ? resolveSuite(loaded, suite.id).scenarios : [...exp.scenarios.keys()];
	const scenarios = scenarioIds.map((id) => exp.scenarios.get(id)!.scenario);
	const status = runStatus(loaded, experimentId);
	const keep = (id: string): boolean => opts.members === undefined || opts.members.includes(id);
	const memberOf = (id: string): Member => loaded.pack.population.find((m) => m.id === id)!;
	const population = exp.experiment.factors.population.filter(keep).map(memberOf);
	const judges = (exp.experiment.judging?.judges ?? exp.experiment.factors.population).filter(keep).map(memberOf);
	const unsupported: Preview["unsupported"] = [];
	for (const m of [...population, ...judges]) {
		const a = opts.adapters[m.runtime];
		if ((!a || a.prepare === undefined) && !unsupported.some((u) => u.member === m.id)) unsupported.push({ member: m.id, reason: a ? `the ${m.runtime} adapter cannot prepare an invocation without running it` : `no adapter for runtime ${m.runtime}` });
	}
	const can = (m: Member): boolean => !unsupported.some((u) => u.member === m.id);

	if (fs.existsSync(opts.out) && fs.readdirSync(opts.out).length) throw new Error(`${opts.out} is not empty`);
	const work = path.join(path.resolve(opts.out), "work");
	fs.mkdirSync(work, { recursive: true });
	const seed = opts.seed ?? "preview";

	// Variants and arms, as a run builds and composes them.
	const built = new Map<string, BuiltVariant>();
	const variants: Preview["variants"] = {};
	const armIds = exp.experiment.factors.arms;
	for (const v of [...new Set(loaded.pack.arms.filter((a) => armIds.includes(a.id)).flatMap((a) => a.deliver.map((d) => d.variant)))]) {
		const decl = loaded.pack.variants.find((x) => x.id === v)!;
		const sourceDir = path.resolve(loaded.dir, loaded.pack.sources.find((s) => s.id === decl.source)!.path);
		const rev = decl.revision ?? opts.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
		const b = await buildVariant(loaded, v, rev, variantDir(work, v));
		built.set(v, b);
		variants[v] = b.ok ? { source: b.manifest.source, revision: b.manifest.revision, dir: b.dir } : { failed: b.reason };
	}
	const arms: Preview["arms"] = {};
	const composed = new Map<string, ComposedArm>();
	for (const a of armIds) {
		const c = composeArm(loaded, a, built);
		arms[a] = c.ok ? { composed: true } : { composed: false, reason: c.reason };
		if (c.ok) composed.set(a, c.arm);
	}

	// Readers: run 1 of every cell, every phase.
	const readers: PreviewReader[] = [];
	const cells: CellRecord[] = [];
	const response = opts.response ?? placeholderResponse(scenarios);
	const marker = loaded.pack.masks.selfExplanationMarker;
	for (const scenario of scenarios) for (const arm of composed.values()) for (const member of population) {
		if (!can(member)) continue;
		const adapter = opts.adapters[member.runtime]!;
		const cell = `${scenario.id}.${arm.arm}.${member.id}.1`;
		const phases = phasesOf(scenario, exp.experiment);
		const traps = assignTraps(scenario, phases, 1, exp.experiment.factors.population.indexOf(member.id));
		const ran: { phase: string; workspace: string; invocation: string }[] = [];
		for (const [i, ph] of phases.entries()) {
			const generated: string[] = [];
			const prev = ph.after !== undefined ? ran.find((r) => r.phase === ph.after) : ran[ran.length - 1];
			const workspace = ph.session === "continue" && prev ? prev.workspace : createWorkspace(loaded, scenario, arm, { base: path.join(work, "workspaces"), rulesFiles: adapter.rulesFiles }).dir;
			let note: string | null = null;
			if (ph.note !== undefined) {
				note = `<note for phase ${ph.id}, ${"file" in ph.note ? `read from ${ph.note.file} after phase ${prev?.phase ?? "?"}` : `written by hook ${ph.note.generator}`} at run time>`;
				generated.push(note);
			}
			const prompt = phasePrompt(exp.experiment, scenario, ph, i === 0, arm, workspace, note, traps.filter((t) => t.phase === ph.id));
			fs.mkdirSync(path.join(work, "invocations"), { recursive: true });
			const inv = fs.mkdtempSync(path.join(work, "invocations", "i-"));
			fs.rmdirSync(inv);
			let continueFrom: { session: string; work: string; workspace: string } | undefined;
			if (ph.session === "continue" && prev) {
				continueFrom = { session: `<session of phase ${prev.phase}, generated at run time>`, work: prev.invocation, workspace: prev.workspace };
				generated.push(continueFrom.session);
			}
			const r = tryPrepare(adapter, readerInvocation(arm, member, adapter, prompt, workspace, inv, opts.timeLimitSeconds ?? 1200, continueFrom));
			readers.push({ cell, scenario: scenario.id, arm: arm.arm, member: member.id, phase: ph.id, session: ph.session, ...r, prompt, promptBytes: bytes(prompt), generated });
			ran.push({ phase: ph.id, workspace, invocation: inv });
		}
		// The sample response as this cell's reply in every phase, cut and extracted as a run does.
		const maxBytes = scenario.maxResponseBytes ?? exp.experiment.maxResponseBytes;
		const phaseOutcomes: NonNullable<CellRecord["phaseOutcomes"]> = {};
		const beforeBound: Record<string, { final: string; scored: string | null }> = {};
		for (const ph of phases) {
			const t = phaseText(scenario, maxBytes, marker, response, scenario.scoredFile !== undefined ? response : null);
			phaseOutcomes[ph.id] = { final: t.final, diff: "", note: null, startDiff: "", scored: t.scored, traps: traps.filter((x) => x.phase === ph.id).map((x) => x.text), ...(t.responseBound ? { responseBound: t.responseBound } : {}) };
			beforeBound[ph.id] = t.pre;
		}
		const propertyPhases: NonNullable<CellRecord["propertyPhases"]> = Object.fromEntries(propertiesOf(scenario).map((p) => [p.id, { phase: propertyPhase(scenario, phases, p.id, traps), state: "valid" as const }]));
		const { answers, extraction } = answersOf(scenario, propertyPhases, phaseOutcomes, beforeBound, marker, 1);
		const last = phases[phases.length - 1]!.id;
		const outcome: Outcome = { final: response, exit: 0, signal: null, stop: { reason: "completed", inFlight: "none" }, cost: { seconds: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, toolCalls: 0 }, tools: [], filtered: false, error: null, session: null, trace: [], events: "" };
		const { deliveredFiles } = deliveredOf(arm);
		cells.push({
			cell, scenario: scenario.id, arm: arm.arm, member: member.id, run: 1, valid: true,
			attempts: [{ attempt: 1, validity: { valid: true }, outcome, diff: null, workspace: ran[ran.length - 1]!.workspace }],
			final: phaseOutcomes[last]!.final, scoredFile: null, answers, ...(Object.keys(extraction).length ? { extraction } : {}), diff: null, codeScores: [],
			traps, propertyPhases, phaseOutcomes, restated: [], ...(deliveredFiles.length ? { deliveredFiles } : {}),
		});
	}

	// Judges: blinded and masked as a run does, jobs planned as a run does.
	const scenarioMap = new Map(scenarios.map((s) => [s.id, s]));
	const families = new Map(loaded.pack.population.map((m) => [m.id, m.family]));
	const canaries = loaded.pack.variants.flatMap((v) => v.canaries);
	const blinded = blind(loaded, scenarioMap, cells, families, seed, () => new Date(), { paths: [work, path.resolve(opts.out), loaded.dir], literals: canaries });
	const answerRows: PreviewAnswer[] = [];
	for (const c of cells) for (const [pid, x] of Object.entries(c.extraction ?? {})) {
		const po = c.phaseOutcomes![x.phase]!;
		const unit = blinded.units.find((u) => u.cell === c.cell && u.properties.includes(pid)) ?? null;
		const stripped = x.source === "final" ? po.final : (po.scored ?? "");
		const withReading = (scenarioMap.get(c.scenario) ? propertiesOf(scenarioMap.get(c.scenario)!).find((q) => q.id === pid)?.judgedWith ?? [] : []).includes("delivered") && (c.deliveredFiles?.length ?? 0) > 0;
		const maskedReading = unit && withReading ? /^--- ASSIGNED READING ---\n([\s\S]*?)\n--- ANSWER ---\n/.exec(unit.text)?.[1] ?? null : null;
		answerRows.push({
			cell: c.cell, property: pid, extraction: x, unit: unit?.id ?? null,
			reading: withReading && maskedReading !== null ? { original: bytes(c.deliveredFiles!.map((d) => d.text.trim()).join("\n\n")), masked: bytes(maskedReading) } : null,
			bytes: { response: bytes(response), stripped: po.responseBound?.originalBytes ?? bytes(stripped), bounded: bytes(stripped), answer: x.answerBytes, unit: unit ? bytes(unit.text) : null },
		});
	}
	const guessGroups = exp.experiment.judging?.guessGroups ?? Object.fromEntries(armIds.map((a) => [a, [a]]));
	const guessOptions = Object.keys(guessGroups);
	const judgeMembers = judges.filter(can);
	const jobs = planJudgeJobs({ experiment: exp.experiment, scenarios: scenarioMap, units: blinded.units, judges: judgeMembers, seed });
	const judgeRows: PreviewJudgeJob[] = [];
	for (const job of jobs) {
		const adapter = opts.adapters[job.judge.runtime]!;
		const render = (attempt: 1 | 2, pending: typeof job.units) => {
			const { text, local } = judgePrompt(exp.experiment, job, pending, guessOptions);
			const ws = createWorkspace(loaded, { id: "judge", tags: [], fixture: null, task: "", properties: [] }, EMPTY_ARM, { base: path.join(work, "judging", "workspaces"), rulesFiles: adapter.rulesFiles });
			fs.mkdirSync(path.join(work, "judging", "invocations"), { recursive: true });
			const inv = fs.mkdtempSync(path.join(work, "judging", "invocations", "j-"));
			fs.rmdirSync(inv);
			const r = tryPrepare(adapter, judgeInvocation(job.judge, adapter, text, ws.dir, inv, opts.judgeTimeLimitSeconds ?? 900));
			return { attempt, prompt: text, bytes: bytes(text), local: Object.fromEntries([...local].map(([k, u]) => [k, u.id])), ...r };
		};
		judgeRows.push({
			name: job.name, judge: job.judge.id, scenario: job.scenario.id,
			units: job.units.map((u) => ({ id: u.id, cell: u.cell, properties: u.properties })),
			first: render(1, job.units) as PreviewJudgeJob["first"],
			retry: job.units.length > 1 ? (render(2, job.units.slice(1)) as NonNullable<PreviewJudgeJob["retry"]>) : null,
		});
	}

	const preview: Preview = {
		pack: loaded.pack.id, experiment: experimentId, suite: suite?.id ?? null,
		status: { status: status.status, reason: status.reason, hash: status.record?.hash ?? null },
		variants, arms, seed, response: { given: opts.response !== undefined, bytes: bytes(response) },
		readers, answers: answerRows, judges: judgeRows,
		generated: [
			"the run's work folder, run- and six random characters, and every path under it: workspaces, invocation folders, variant folders",
			"unit ids and the order of units in a judge prompt, from the run's seed (this preview's seed is given above)",
			"the session a continuing phase resumes, and a phase's note, read or written after the phase before it",
			"each reader's reply: this preview gives every reader the one sample response",
			"which units a retry holds: those without a valid vote after the attempt before",
		],
		notRendered: [
			"workspace contents: a scenario's fixture is copied as a run copies it, but trap files a run places in the first workspace, and a later phase's tree copied from the phase before, are not",
		],
		unsupported,
	};
	fs.writeFileSync(path.join(opts.out, "PREVIEW.json"), JSON.stringify(preview, null, 2) + "\n");
	fs.writeFileSync(path.join(opts.out, "PREVIEW.md"), previewMarkdown(preview));
	return preview;
}

export function previewMarkdown(p: Preview): string {
	const lines = [
		`# Preview - ${p.pack} ${p.suite ? `suite ${p.suite}` : `experiment ${p.experiment}`}`, "",
		"Rendered without contacting any runtime or reading any credential. `PREVIEW.json` holds every prompt, prepared invocation, extraction and judge prompt; the files each invocation writes are under `work/`.", "",
		`A run now would be **${p.status.status}**: ${p.status.reason}.`, "",
		`- Readers: ${p.readers.length} invocation(s), ${p.readers.filter((r) => r.prepared === null).length} not rendered.`,
		`- Answers extracted from the ${p.response.given ? "given" : "placeholder"} response (${p.response.bytes} bytes): ${p.answers.length}, ${p.answers.filter((a) => a.extraction.findings.length > 0).length} with findings.`,
		`- Judge jobs: ${p.judges.length}, each with its first prompt${p.judges.some((j) => j.retry) ? " and, where it holds more than one unit, a retry" : ""}.`,
		...(p.unsupported.length ? [`- Not rendered for: ${p.unsupported.map((u) => `${u.member} (${u.reason})`).join(", ")}.`] : []),
		"", "## Generated at run time", "", ...p.generated.map((g) => `- ${g}`), "",
	];
	const invs = [...p.readers, ...p.judges.flatMap((j) => [j.first, ...(j.retry ? [j.retry] : [])])];
	const notes = [...new Set([...p.notRendered, ...invs.flatMap((x) => [...(x.prepared?.notRendered ?? []), ...(x.prepared?.outsideControl ?? [])])])];
	if (notes.length) lines.push("## Not rendered, or outside context-lab's control", "", ...notes.map((n) => `- ${n}`), "");
	return lines.join("\n");
}
