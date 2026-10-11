// Parity (Delta-1 criteria E8 and E9): the core's tally, given the votes mission-kit's old tools
// recorded, reproduces the results those tools published. The run records are local to the machine
// that made them, so this is run by hand, not by npm test.
//
// Usage: node packages/core/dist/test/parity/parity.js <eval run dir> <adherence run dir>
// Prints every compared value that differs, and exits 1 if any does.

import fs from "node:fs";
import path from "node:path";
import { tally } from "../../src/index.js";
import { readAdherenceRun, readEvalRun } from "./legacy-readers.js";

const [evalRun, adhRun] = process.argv.slice(2);
if (!evalRun || !adhRun) { console.error("usage: parity <eval run dir> <adherence run dir>"); process.exit(2); }
const diffs: string[] = [];
let compared = 0;
const same = (what: string, got: unknown, want: unknown): void => {
	compared++;
	if (got !== want) diffs.push(`${what}: core ${JSON.stringify(got)}, published ${JSON.stringify(want)}`);
};

// E8: every mean[probe][label] and total[label], rounded as Number.prototype.toFixed(2) rounds.
{
	const want = JSON.parse(fs.readFileSync(path.join(evalRun, "RESULT.json"), "utf8")) as { mean: Record<string, Record<string, number | null>>; total: Record<string, number> };
	const r = tally(readEvalRun(evalRun));
	const round = (x: number | null): number | null => (x === null ? null : Number(x.toFixed(2)));
	for (const [probe, byLabel] of Object.entries(want.mean)) for (const [label, w] of Object.entries(byLabel)) {
		const p = r.properties.find((x) => x.property === probe);
		same(`E8 mean[${probe}][${label}]`, p ? round(p.byArm[label]!.mean) : "missing", w);
	}
	for (const [label, w] of Object.entries(want.total)) same(`E8 total[${label}]`, round(r.totals[label] ?? null), w);
}

// E9: per trap and property, byArm and byArmFam mean/of/incomplete, agreement, and the guesses.
{
	interface Rate { mean: number | null; of: number; incomplete: number }
	const want = JSON.parse(fs.readFileSync(path.join(adhRun, "RESULT.json"), "utf8")) as {
		traps: Record<string, { properties: { id: string; byArm: Record<string, Rate>; byArmFam: Record<string, Record<string, Rate>>; agreement: { agree: number; of: number } }[]; guess: { right: number; all: number; guided: number } }>;
	};
	for (const [tid, input] of readAdherenceRun(adhRun)) {
		const r = tally(input);
		const w = want.traps[tid]!;
		for (const wp of w.properties) {
			const p = r.properties.find((x) => x.property === wp.id)!;
			for (const [arm, wr] of Object.entries(wp.byArm)) for (const f of ["mean", "of", "incomplete"] as const) same(`E9 ${tid} ${wp.id} byArm.${arm}.${f}`, p.byArm[arm]![f], wr[f]);
			for (const [arm, fams] of Object.entries(wp.byArmFam)) for (const [fam, wr] of Object.entries(fams)) for (const f of ["mean", "of", "incomplete"] as const) same(`E9 ${tid} ${wp.id} byArmFam.${arm}.${fam}.${f}`, p.byArmMember[arm]![fam]![f], wr[f]);
			same(`E9 ${tid} ${wp.id} agreement.agree`, p.agreement.agree, wp.agreement.agree);
			same(`E9 ${tid} ${wp.id} agreement.of`, p.agreement.of, wp.agreement.of);
		}
		same(`E9 ${tid} guess.right`, r.guesses.right, w.guess.right);
		same(`E9 ${tid} guess.all`, r.guesses.all, w.guess.all);
		same(`E9 ${tid} guess.guided`, r.guesses.byGuess["guided"] ?? 0, w.guess.guided);
	}
}

for (const d of diffs) console.log(`DIFFERS  ${d}`);
console.log(`${compared} values compared; ${diffs.length} differ.`);
process.exit(diffs.length ? 1 : 0);
