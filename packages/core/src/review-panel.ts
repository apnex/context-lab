// review-panel - orchestrates an on-demand review prompt across members of distinct model families
// and optionally cross-verifies their findings (architecture section 5, principles P1, P3, P6, P8;
// Delta-3 stage 3, rulings 0025/0026, B18, criteria G7-G8).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Adapter, DeliveryMode, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import { checkPack } from "./pack-checker.js";
import type { LoadedPack, Member } from "./pack-schema.js";
import { makeReadOnly, makeWritable } from "./variant-builder.js";
import { createWorkspace } from "./workspace-builder.js";

export type ReviewSeverity = "blocking" | "should-fix" | "minor";

export interface ExtractedFinding {
	id: string;
	severity: ReviewSeverity;
	title: string;
	evidence: string;
	fix: string;
}

export interface ReviewerReply {
	member: string;
	family: string;
	runtime: string;
	model: string;
	raw: string;
	findings: ExtractedFinding[];
	seconds: number;
	error: string | null;
}

export interface ReviewVerdict {
	item: string; // "<member>:<id>"
	proposer: string;
	proposerFamily: string;
	verifier: string;
	verifierFamily: string;
	supports: boolean;
	reason: string;
}

export interface AggregatedFinding extends ExtractedFinding {
	item: string;
	proposer: string;
	proposerFamily: string;
	verdicts: ReviewVerdict[];
	supportingFamilies: string[];
	familyCount: number;
}

export interface ReviewPacket {
	pack: string;
	createdAt: string;
	promptFile: string;
	files: string[];
	members: { id: string; family: string; runtime: string; model: string }[];
	verified: boolean;
	replies: ReviewerReply[];
	findings: AggregatedFinding[];
}

export interface ReviewOptions {
	promptFile: string;
	files?: string[];
	members?: string[];
	verify?: boolean;
	outDir: string;
	work?: string;
	adapters: Record<string, Adapter>;
	parallel?: number;
	timeLimitSeconds?: number;
	now?: () => Date;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
	const q = items.slice();
	await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (q.length) await fn(q.shift()!); }));
}

/** Extracts the JSON findings array from a reviewer's raw reply. */
export function parseReviewFindings(raw: string): ExtractedFinding[] {
	const fenced: string[] = [];
	// Match each fenced block independently so ```ts ... ``` before ```json ... ``` cannot pair across blocks.
	for (const m of raw.matchAll(/```([^\n`]*)\n([\s\S]*?)\n```/g)) {
		const info = (m[1] ?? "").trim().toLowerCase();
		if ((info === "" || info === "json") && m[2]) fenced.push(m[2].trim());
	}
	const tryBlocks = (blocks: string[]): ExtractedFinding[] | null => {
		let sawEmpty = false;
		for (const c of blocks) {
			try {
				const parsed = JSON.parse(c) as unknown;
				const arr = Array.isArray(parsed)
					? parsed
					: parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings)
						? (parsed as { findings: unknown[] }).findings
						: null;
				if (!arr) continue;
				if (arr.length === 0) { sawEmpty = true; continue; }
				const out: ExtractedFinding[] = [];
				for (const item of arr) {
					if (!item || typeof item !== "object") continue;
					const o = item as Record<string, unknown>;
					if (typeof o["id"] !== "string" || typeof o["title"] !== "string") continue;
					const sev: ReviewSeverity = o["severity"] === "blocking" || o["severity"] === "should-fix" || o["severity"] === "minor" ? o["severity"] : "minor";
					out.push({
						id: o["id"],
						severity: sev,
						title: o["title"],
						evidence: typeof o["evidence"] === "string" ? o["evidence"] : "",
						fix: typeof o["fix"] === "string" ? o["fix"] : "",
					});
				}
				if (out.length > 0) return out;
			} catch {
				// Try next candidate block.
			}
		}
		return sawEmpty ? [] : null;
	};
	const fromFenced = tryBlocks(fenced);
	if (fromFenced !== null) return fromFenced;
	const firstBracket = raw.indexOf("["), lastBracket = raw.lastIndexOf("]");
	if (firstBracket >= 0 && lastBracket > firstBracket) {
		return tryBlocks([raw.slice(firstBracket, lastBracket + 1)]) ?? [];
	}
	return [];
}

function parseVerdictList(raw: string): { item: string; supports: boolean; reason: string }[] {
	const fenced: string[] = [];
	for (const m of raw.matchAll(/```([^\n`]*)\n([\s\S]*?)\n```/g)) {
		const info = (m[1] ?? "").trim().toLowerCase();
		if ((info === "" || info === "json") && m[2]) fenced.push(m[2].trim());
	}
	const tryBlocks = (blocks: string[]): { item: string; supports: boolean; reason: string }[] | null => {
		let sawEmpty = false;
		for (const c of blocks) {
			try {
				const parsed = JSON.parse(c) as unknown;
				const arr = Array.isArray(parsed)
					? parsed
					: parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { verdicts?: unknown }).verdicts)
						? (parsed as { verdicts: unknown[] }).verdicts
						: null;
				if (!arr) continue;
				if (arr.length === 0) { sawEmpty = true; continue; }
				const res: { item: string; supports: boolean; reason: string }[] = [];
				for (const v of arr) {
					if (!v || typeof v !== "object") continue;
					const o = v as Record<string, unknown>;
					if (typeof o["item"] === "string" && typeof o["supports"] === "boolean") {
						res.push({ item: o["item"], supports: o["supports"], reason: typeof o["reason"] === "string" ? o["reason"] : "" });
					}
				}
				if (res.length > 0) return res;
			} catch {
				// continue
			}
		}
		return sawEmpty ? [] : null;
	};
	const fromFenced = tryBlocks(fenced);
	if (fromFenced !== null) return fromFenced;
	const fallbacks: string[] = [];
	const fb = raw.indexOf("["), lb = raw.lastIndexOf("]");
	if (fb >= 0 && lb > fb) fallbacks.push(raw.slice(fb, lb + 1));
	const fo = raw.indexOf("{"), lo = raw.lastIndexOf("}");
	if (fo >= 0 && lo > fo) fallbacks.push(raw.slice(fo, lo + 1));
	return tryBlocks(fallbacks) ?? [];
}

/** Selects the reviewer members from the pack and verifies at least 2 distinct families are present. */
export function selectReviewMembers(loaded: LoadedPack, memberIds?: string[]): Member[] {
	let members: Member[];
	if (memberIds && memberIds.length > 0) {
		const uniqueIds = [...new Set(memberIds)];
		members = uniqueIds.map((id) => {
			const m = loaded.pack.population.find((p) => p.id === id);
			if (!m) throw new Error(`no member ${id} in pack ${loaded.pack.id}`);
			return m;
		});
	} else {
		// Default: first member of each distinct family in pack.population.
		const seenFamilies = new Set<string>();
		members = [];
		for (const m of loaded.pack.population) {
			if (!seenFamilies.has(m.family)) {
				seenFamilies.add(m.family);
				members.push(m);
			}
		}
	}
	const families = new Set(members.map((m) => m.family));
	if (families.size < 2) {
		throw new Error(`context-lab review requires members from at least 2 distinct model families, found ${families.size}`);
	}
	return members;
}

export function reviewMarkdown(packet: ReviewPacket): string {
	const lines = [
		`# Multi-model review (${packet.pack})`, "",
		`Created: ${packet.createdAt}. Verified across families: **${packet.verified ? "yes" : "no"}**.`,
		`Models (${packet.members.length}, ${new Set(packet.members.map((m) => m.family)).size} families): ${packet.members.map((m) => `${m.id} (${m.family}, ${m.model})`).join(", ")}.`, "",
		"## Findings", "",
	];
	if (packet.findings.length === 0) {
		lines.push("No structured finding was reported.");
	} else {
		const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
		lines.push(
			"| Item | Severity | Proposer (family) | Supporting families | Count | Title |",
			"|---|---|---|---|---|---|",
			...packet.findings.map((f) => `| \`${esc(f.item)}\` | ${f.severity} | ${f.proposer} (${f.proposerFamily}) | ${f.supportingFamilies.join(", ")} | ${f.familyCount} | ${esc(f.title)} |`),
		);
	}
	lines.push("", "## Raw replies", "");
	for (const r of packet.replies) {
		lines.push(`### ${r.member} (${r.family} - ${r.model})`, "", r.raw.trim() || "(empty reply)", "");
	}
	return lines.join("\n") + "\n";
}

/**
 * Runs an on-demand review prompt across selected members of distinct model families in isolated
 * sandboxes, optionally runs a cross-family verification pass, and writes `REVIEW.json` and
 * `REVIEW.md` in `opts.outDir`.
 */
export async function runReview(packDir: string, opts: ReviewOptions): Promise<ReviewPacket> {
	const now = opts.now ?? (() => new Date());
	const checked = await checkPack(packDir);
	if (!checked.ok) throw new Error(`the pack fails its check: ${checked.defects.map((d) => `${d.check} ${d.where} ${d.message}`).join("; ")}`);
	const loaded = checked.loaded;
	const members = selectReviewMembers(loaded, opts.members);
	const promptText = fs.readFileSync(path.resolve(opts.promptFile), "utf8");
	const inputFiles = (opts.files ?? []).map((f) => path.resolve(f));
	for (const f of inputFiles) {
		if (!fs.existsSync(f)) throw new Error(`review file ${f} does not exist`);
	}

	const workRoot = path.resolve(opts.work ?? path.join(os.homedir(), "context-lab-work"));
	fs.mkdirSync(workRoot, { recursive: true });
	const workDir = fs.mkdtempSync(path.join(workRoot, "review-"));

	// Copy any input files into a read-only folder mounted as onRequest, and inline their contents
	// in the prompt so tools="off" invocations can read them directly with writes and network denied.
	const roFilesDir = path.join(workDir, "files");
	fs.mkdirSync(roFilesDir, { recursive: true });
	const fileBlobs: { name: string; content: string }[] = [];
	for (const [idx, f] of inputFiles.entries()) {
		const base = `${idx + 1}-${path.basename(f)}`;
		const content = fs.readFileSync(f, "utf8");
		fs.writeFileSync(path.join(roFilesDir, base), content);
		fileBlobs.push({ name: f, content });
	}
	makeReadOnly(roFilesDir);

	const arm: ComposedArm = {
		arm: "review",
		instructions: [],
		folderFiles: [],
		onRequest: inputFiles.length ? [{ variant: "review-files", path: roFilesDir }] : [],
		canaries: [],
		negativeCanaries: [],
		revisions: {},
	};

	const filesBlock = fileBlobs.length
		? ["", "=== FILES UNDER REVIEW ===", ...fileBlobs.map((b) => `--- FILE: ${b.name} ---\n${b.content}`)].join("\n")
		: "";

	const reviewerPrompt = [
		promptText.trim(),
		filesBlock,
		"",
		"Emit your findings as a JSON array in a ```json fenced block of this exact shape (or [] if none):",
		'```json\n[{"id": "F1", "severity": "blocking", "title": "one-line summary", "evidence": "file/line or quote", "fix": "concrete fix"}]\n```',
		"Do not use any tools.",
	].join("\n");

	const replies: ReviewerReply[] = [];
	try {
		await pool(members, opts.parallel ?? 4, async (member) => {
			const adapter = opts.adapters[member.runtime];
			if (!adapter) throw new Error(`no adapter for runtime ${member.runtime}`);
			const mode: DeliveryMode = adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!;
			const ws = createWorkspace(loaded, { id: "review", tags: [], fixture: null, task: "", properties: [] }, arm, { base: path.join(workDir, "workspaces"), rulesFiles: adapter.rulesFiles });
			fs.mkdirSync(path.join(workDir, "invocations"), { recursive: true });
			const invDir = fs.mkdtempSync(path.join(workDir, "invocations", "r-"));
			fs.rmdirSync(invDir);
			const inv: Invocation = {
				arm, workspace: ws.dir, prompt: reviewerPrompt, mode, member,
				tools: "off", timeLimitSeconds: opts.timeLimitSeconds ?? 900, work: invDir,
			};
			const out = await adapter.invoke(inv);
			replies.push({
				member: member.id, family: member.family, runtime: member.runtime, model: member.model,
				raw: out.final, findings: parseReviewFindings(out.final),
				seconds: out.cost.seconds, error: out.error?.message ?? null,
			});
		});
		replies.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));

		const allFindings: AggregatedFinding[] = replies.flatMap((r) => {
			const seenIds = new Set<string>();
			return r.findings.map((f) => {
				let id = f.id;
				let suffix = 2;
				while (seenIds.has(id)) {
					id = `${f.id}-${suffix++}`;
				}
				seenIds.add(id);
				return {
					...f,
					id,
					item: `${r.member}:${id}`,
					proposer: r.member,
					proposerFamily: r.family,
					verdicts: [],
					supportingFamilies: [r.family],
					familyCount: 1,
				};
			});
		});

		if (opts.verify && allFindings.length > 0) {
			const families = [...new Set(members.map((m) => m.family))].sort();
			// One verifier member per distinct family, each verifying every finding from other families (F_v != F_r).
			const verifiers = families.map((fam) => members.find((m) => m.family === fam)!);
			const byVerifier = new Map<string, { verifier: Member; items: AggregatedFinding[] }>();
			for (const verifier of verifiers) {
				const items = allFindings.filter((f) => f.proposerFamily !== verifier.family);
				if (items.length > 0) byVerifier.set(verifier.id, { verifier, items });
			}
			await pool([...byVerifier.values()], opts.parallel ?? 4, async ({ verifier, items }) => {
				const adapter = opts.adapters[verifier.runtime];
				if (!adapter) throw new Error(`no adapter for verifier runtime ${verifier.runtime}`);
				const mode: DeliveryMode = adapter.modes.includes("stdin") ? "stdin" : adapter.modes.includes("attachment") ? "attachment" : adapter.modes[0]!;
				const vPrompt = [
					"You are verifying review findings proposed by other model families against the prompt and files under review.",
					"For each finding item below, decide whether the evidence and prompt/files genuinely support the finding.",
					"",
					"=== ORIGINAL REVIEW PROMPT ===",
					promptText.trim(),
					filesBlock,
					"",
					"=== FINDINGS TO VERIFY ===",
					...items.map((it) => `- ${it.item} (${it.severity}): ${it.title} | Evidence: ${it.evidence} | Proposed fix: ${it.fix}`),
					"",
					"Do not use any tools. Reply with a JSON array in a ```json fenced block of this exact shape:",
					'```json\n[{"item": "<member>:<id>", "supports": true, "reason": "one sentence"}]\n```',
				].join("\n");
				const ws = createWorkspace(loaded, { id: "review-verify", tags: [], fixture: null, task: "", properties: [] }, arm, { base: path.join(workDir, "workspaces"), rulesFiles: adapter.rulesFiles });
				const invDir = fs.mkdtempSync(path.join(workDir, "invocations", "rv-"));
				fs.rmdirSync(invDir);
				const inv: Invocation = {
					arm, workspace: ws.dir, prompt: vPrompt, mode, member: verifier,
					tools: "off", timeLimitSeconds: opts.timeLimitSeconds ?? 900, work: invDir,
				};
				const out = await adapter.invoke(inv);
				const parsed = parseVerdictList(out.final);
				for (const it of items) {
					const pv = parsed.find((x) => x.item === it.item);
					const supports = pv?.supports ?? false;
					const verdict: ReviewVerdict = {
						item: it.item, proposer: it.proposer, proposerFamily: it.proposerFamily,
						verifier: verifier.id, verifierFamily: verifier.family,
						supports, reason: pv?.reason ?? "no verdict returned",
					};
					it.verdicts.push(verdict);
					it.verdicts.sort((a, b) => (a.verifier < b.verifier ? -1 : a.verifier > b.verifier ? 1 : 0));
					const famSet = new Set([it.proposerFamily, ...it.verdicts.filter((x) => x.supports).map((x) => x.verifierFamily)]);
					it.supportingFamilies = [...famSet].sort();
					it.familyCount = it.supportingFamilies.length;
				}
			});
		}

		const outDir = path.resolve(opts.outDir);
		fs.mkdirSync(outDir, { recursive: true });
		const packet: ReviewPacket = {
			pack: loaded.pack.id,
			createdAt: now().toISOString(),
			promptFile: path.resolve(opts.promptFile),
			files: inputFiles,
			members: members.map((m) => ({ id: m.id, family: m.family, runtime: m.runtime, model: m.model })),
			verified: Boolean(opts.verify),
			replies,
			findings: allFindings,
		};
		fs.writeFileSync(path.join(outDir, "REVIEW.json"), JSON.stringify(packet, null, 2) + "\n");
		fs.writeFileSync(path.join(outDir, "REVIEW.md"), reviewMarkdown(packet));
		return packet;
	} finally {
		if (fs.existsSync(roFilesDir)) makeWritable(roFilesDir);
	}
}
