// code-measurer - scores what a check can decide (architecture section 5, principle P2).
//
// For each property decided by code, it calls the property's outcome-measure hook on the unmasked
// outcome - the final message, the diff, and the scored file if the scenario names one - and keeps
// the score the hook returns for that property, with the time it was taken. A hook that fails, or
// returns no valid score for a property, leaves that property incomplete; nothing else is affected.

import path from "node:path";
import fs from "node:fs";
import { runHook, type HookResult } from "./hook-runner.js";
import type { LoadedPack, Scenario } from "./pack-schema.js";

export interface MeasuredOutcome {
	final: string;
	/** The raw untruncated final message, when `final` was bounded by `maxResponseBytes`. */
	rawFinal?: string;
	diff: string;
	scored: string | null;
	/** The raw untruncated scored file content, when `scored` was bounded by `maxResponseBytes`. */
	rawScored?: string | null;
	/** Read-only path to the phase's ending workspace snapshot on disk, if present. */
	snapshot?: string | null;
}

export type CodeScore = { property: string; value: number; measuredAt: string } | { property: string; incomplete: string; measuredAt: string };

export async function measure(loaded: LoadedPack, scenario: Scenario, outcome: MeasuredOutcome, now: () => Date = () => new Date()): Promise<CodeScore[]> {
	const byHook = new Map<string, string[]>();
	for (const p of scenario.properties) if (p.decidedBy === "code" && p.measure !== undefined) byHook.set(p.measure, [...(byHook.get(p.measure) ?? []), p.id]);
	const snap = outcome.snapshot && fs.existsSync(outcome.snapshot) ? [path.resolve(outcome.snapshot)] : [];
	const readable = [...loaded.pack.sources.map((s) => path.resolve(loaded.dir, s.path)).filter((p) => fs.existsSync(p)), ...snap];
	const out: CodeScore[] = [];
	for (const [hookId, props] of byHook) {
		const hook = loaded.pack.hooks.find((h) => h.id === hookId);
		const r: HookResult = hook === undefined
			? { ok: false, reason: "exit", detail: `no hook ${hookId}`, seconds: 0 }
			: await runHook(loaded.dir, hook, { scenario: scenario.id, properties: props, outcome }, { readable });
		const at = now().toISOString();
		const scores = r.ok && typeof r.output === "object" && r.output !== null ? (r.output as { scores?: Record<string, unknown> }).scores : undefined;
		for (const id of props) {
			const p = scenario.properties.find((x) => x.id === id)!;
			const v = scores?.[id];
			if (!r.ok) out.push({ property: id, incomplete: `its hook failed (${r.reason}): ${r.detail.slice(0, 200)}`, measuredAt: at });
			else if (typeof v !== "number" || v < p.scale[0] || v > p.scale[1]) out.push({ property: id, incomplete: `its hook returned no score in ${JSON.stringify(p.scale)}`, measuredAt: at });
			else out.push({ property: id, value: v, measuredAt: at });
		}
	}
	return out;
}
