// arm-composer - composes one arm, runtime-neutral (architecture section 5, principle P6).
//
// An arm says what reaches an agent and how: files given as instructions, files placed in its
// working folder, and copies it may open on request. The composer turns an arm's declaration and
// its built variants into that statement, naming real files, and knows nothing of any runtime;
// each runtime adapter renders it. An arm none of whose variants could be built is not composed,
// and does not run.
//
// Every guided arm also receives its variants' canary files as instructions, so the isolation
// prober can show the arm's instructions arrived; the canary is a small, stated addition to the
// context, the same in every guided arm.

import fs from "node:fs";
import path from "node:path";
import type { BuiltVariant } from "./variant-builder.js";
import { CANARY_FILE } from "./variant-builder.js";
import type { LoadedPack } from "./pack-schema.js";

export interface ComposedArm {
	arm: string;
	/** Files whose text the agent receives as standing instructions, in declared order. */
	instructions: { variant: string; file: string; path: string }[];
	/** Files copied into the agent's working folder, under their declared names. */
	folderFiles: { variant: string; file: string; path: string }[];
	/** Directories the agent may open on request, read-only. */
	onRequest: { variant: string; path: string }[];
	/** Canaries the arm must be able to quote, and canaries of other variants it must not. */
	canaries: string[];
	negativeCanaries: string[];
	/** The revision of each variant the arm uses. */
	revisions: Record<string, string>;
}

export type ComposeResult = { ok: true; arm: ComposedArm } | { ok: false; arm: string; reason: string };

export function composeArm(loaded: LoadedPack, armId: string, built: Map<string, BuiltVariant>): ComposeResult {
	const decl = loaded.pack.arms.find((a) => a.id === armId);
	if (!decl) throw new Error(`no arm ${armId} in pack ${loaded.pack.id}`);
	const out: ComposedArm = { arm: armId, instructions: [], folderFiles: [], onRequest: [], canaries: [], negativeCanaries: [], revisions: {} };
	const used = new Set<string>();
	for (const d of decl.deliver) {
		const v = built.get(d.variant);
		if (v === undefined) return { ok: false, arm: armId, reason: `variant ${d.variant} was not built` };
		if (!v.ok) return { ok: false, arm: armId, reason: `variant ${d.variant} could not be built: ${v.reason}` };
		const p = path.resolve(v.dir, d.file);
		if (!p.startsWith(v.dir) || !fs.existsSync(p)) return { ok: false, arm: armId, reason: `${d.file} is not in variant ${d.variant}` };
		used.add(d.variant);
		out.revisions[d.variant] = v.manifest.revision;
		if (d.as === "instruction") out.instructions.push({ variant: d.variant, file: d.file, path: p });
		else if (d.as === "folder-file") out.folderFiles.push({ variant: d.variant, file: d.file, path: p });
		else out.onRequest.push({ variant: d.variant, path: p });
	}
	for (const id of used) {
		const v = built.get(id);
		if (v?.ok) {
			out.instructions.push({ variant: id, file: CANARY_FILE, path: path.join(v.dir, CANARY_FILE) });
			out.canaries.push(...v.manifest.canaries);
		}
	}
	for (const [id, v] of built) if (!used.has(id) && v.ok) out.negativeCanaries.push(...v.manifest.canaries.filter((c) => !out.canaries.includes(c)));
	return { ok: true, arm: out };
}
