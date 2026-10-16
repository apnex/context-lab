// human-panel - obtains a person's picks on paired outcomes (architecture section 5, principle P3;
// Delta-3 stage 1, criteria G2-G3).
//
// Presents each pair (A, B) over an input/output stream (terminal or pipe) without revealing which
// arm or score each side came from, accepts "a", "b" or "=" (Ctrl-D / EOF stops early while keeping
// all picks made so far), and for a non-tie pick optionally records one fault tag.

import readline from "node:readline";
import type { CalibrationPair, PreferencePair } from "./pair-chooser.js";

export type FaultTag = "point buried" | "too long" | "unclear label" | "other";

const FAULT_TAGS: Record<string, FaultTag> = {
	"1": "point buried",
	"2": "too long",
	"3": "unclear label",
	"4": "other",
};

export interface PickAnswer {
	id: string;
	move?: string;
	scenario: string;
	property?: string;
	shownA: string;
	pick: "a" | "b" | "=";
	chose: string;
	choseHigher?: boolean | null;
	tag: FaultTag | null;
}

export interface PicksRecord {
	mode: "preference" | "calibration";
	seed: string;
	created: string;
	complete: boolean;
	answers: PickAnswer[];
}

export interface HumanPicksTally {
	mode: "preference" | "calibration";
	complete: boolean;
	byMove: Record<string, { with: number; without: number; same: number; tags: Record<string, number> }>;
	totals: { with: number; without: number; same: number };
	agreement: { agree: number; of: number; rate: number | null } | null;
}

const rule = (label: string): string => `--- ${label} ${"-".repeat(Math.max(3, 62 - label.length))}`;

function createLineReader(input: NodeJS.ReadableStream): { next: () => Promise<string | null>; close: () => void } {
	const rl = readline.createInterface({ input, terminal: false });
	const queue: (string | null)[] = [];
	const waiting: ((line: string | null) => void)[] = [];
	let closed = false;
	rl.on("line", (l) => {
		if (waiting.length) waiting.shift()!(l);
		else queue.push(l);
	});
	rl.on("close", () => {
		closed = true;
		while (waiting.length) waiting.shift()!(null);
	});
	return {
		next: () => (queue.length ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve(null) : new Promise((r) => waiting.push(r))),
		close: () => rl.close(),
	};
}

async function ask(
	reader: { next: () => Promise<string | null> },
	output: { write: (s: string) => unknown },
	prompt: string,
	valid: string[],
): Promise<string | null> {
	for (;;) {
		output.write(prompt);
		const l = await reader.next();
		if (l === null) return null;
		const v = l.trim().toLowerCase();
		if (valid.includes(v)) return v;
		output.write(`  please type one of: ${valid.filter(Boolean).join(" ")}${valid.includes("") ? " (or Enter to skip)" : ""}\n`);
	}
}

export interface HumanPanelOptions {
	pairs: (PreferencePair | CalibrationPair)[];
	seed: string;
	input?: NodeJS.ReadableStream;
	output?: { write: (s: string) => unknown };
	now?: () => Date;
}

/** Runs a person through paired outcomes and returns the recorded picks. */
export async function runHumanPanel(opts: HumanPanelOptions): Promise<PicksRecord> {
	const input = opts.input ?? process.stdin;
	const output = opts.output ?? process.stdout;
	const now = opts.now ?? (() => new Date());
	const mode: "preference" | "calibration" = opts.pairs[0]?.kind === "calibration" ? "calibration" : "preference";
	const reader = createLineReader(input);
	const answers: PickAnswer[] = [];
	output.write(`\n${opts.pairs.length} items. For each, pick the outcome that helps you more.\nType a, b or = and press Enter. Ctrl-D stops early; answers so far are kept.\n`);
	for (const [n, pair] of opts.pairs.entries()) {
		const header = pair.kind === "preference" ? `Scenario: ${pair.scenario}` : `Scenario: ${pair.scenario} (${pair.property})`;
		output.write(`\nItem ${n + 1} of ${opts.pairs.length}\n\n${header}\n\n${rule("A")}\n${pair.textA}\n\n${rule("B")}\n${pair.textB}\n\n`);
		const pick = (await ask(reader, output, "Which helps you more?   [a] A   [b] B   [=] same\n> ", ["a", "b", "="])) as "a" | "b" | "=" | null;
		if (pick === null) break;
		let tagCode = "";
		if (pick !== "=") {
			const t = await ask(reader, output, "What was wrong with the other? (optional)\n  [1] point buried  [2] too long  [3] unclear label  [4] other\n> ", ["1", "2", "3", "4", ""]);
			if (t !== null) tagCode = t;
		}
		const tag = FAULT_TAGS[tagCode] ?? null;
		if (pair.kind === "preference") {
			const other: "with" | "without" = pair.shownA === "with" ? "without" : "with";
			const chose = pick === "=" ? "same" : pick === "a" ? pair.shownA : other;
			answers.push({ id: pair.id, move: pair.move, scenario: pair.scenario, shownA: pair.shownA, pick, chose, tag });
		} else {
			const chose = pick === "=" ? "same" : pick === "a" ? pair.unitA : pair.unitB;
			const choseHigher = pick === "=" ? null : pick === pair.higher;
			answers.push({ id: pair.id, scenario: pair.scenario, property: pair.property, shownA: pair.shownA, pick, chose, choseHigher, tag });
		}
	}
	reader.close();
	return {
		mode,
		seed: opts.seed,
		created: now().toISOString(),
		complete: answers.length === opts.pairs.length,
		answers,
	};
}

/** Converts a legacy eval-human.mjs result.json object into a PicksRecord without arithmetic. */
export function readLegacyHumanRun(raw: {
	suite?: string;
	seed: string;
	created: string;
	complete: boolean;
	answers: { item: string; move: string; shownA: string; pick: "a" | "b" | "="; chose: string; tag: FaultTag | null }[];
}): PicksRecord {
	return {
		mode: "preference",
		seed: raw.seed,
		created: raw.created,
		complete: raw.complete,
		answers: raw.answers.map((a) => ({
			id: a.item,
			move: a.move,
			scenario: a.item,
			shownA: a.shownA,
			pick: a.pick,
			chose: a.chose,
			tag: a.tag,
		})),
	};
}

/** Tallies a PicksRecord into per-move preference counts or judge-person calibration agreement. */
export function tallyHumanPicks(record: PicksRecord): HumanPicksTally {
	const byMove: HumanPicksTally["byMove"] = {};
	const totals = { with: 0, without: 0, same: 0 };
	if (record.mode === "preference") {
		for (const a of record.answers) {
			const move = a.move ?? a.scenario;
			const row = (byMove[move] ??= { with: 0, without: 0, same: 0, tags: {} });
			if (a.chose === "with" || a.chose === "without" || a.chose === "same") {
				row[a.chose]++;
				totals[a.chose]++;
			}
			// Matching eval-human.mjs: fault tags on the rejected version when "with" was chosen.
			if (a.tag !== null && a.chose === "with") {
				row.tags[a.tag] = (row.tags[a.tag] ?? 0) + 1;
			}
		}
		return { mode: "preference", complete: record.complete, byMove, totals, agreement: null };
	}
	const nonTie = record.answers.filter((a) => a.pick !== "=" && typeof a.choseHigher === "boolean");
	const agree = nonTie.filter((a) => a.choseHigher === true).length;
	const of = nonTie.length;
	return {
		mode: "calibration",
		complete: record.complete,
		byMove,
		totals,
		agreement: { agree, of, rate: of > 0 ? agree / of : null },
	};
}
