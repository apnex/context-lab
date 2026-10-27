// answer-parser - turns a reader's answer into answers per probe (architecture section 5, P2).
//
// Two shapes of answer, as mission-kit's comprehension tool used them: one answer to one probe, and
// a file holding several answers under "### <probe>" headings. Either way, anything after the pack's
// self-explanation marker is cut before judging, because a reader explaining which entries shaped
// its answer can name what only one arm was given.

export function stripSelfExplanation(text: string, marker: string | undefined): string {
	if (marker === undefined || marker === "") return text.trim();
	const i = text.indexOf(marker);
	return (i < 0 ? text : text.slice(0, i)).trim();
}

export interface ResponseBoundRecord {
	limitBytes: number;
	originalBytes: number;
	effectiveBytes: number;
	truncated: boolean;
	reason: string | null;
}

/**
 * Truncates `text` to at most `limitBytes` UTF-8 bytes at a valid UTF-8 code-point boundary,
 * returning the bounded string and its accounting record.
 */
export function boundUtf8(text: string, limitBytes: number): { text: string; bound: ResponseBoundRecord } {
	const buf = Buffer.from(text, "utf8");
	const originalBytes = buf.length;
	if (originalBytes <= limitBytes) {
		return {
			text,
			bound: { limitBytes, originalBytes, effectiveBytes: originalBytes, truncated: false, reason: null },
		};
	}
	let end = Math.max(0, limitBytes);
	// Walk back past UTF-8 continuation bytes (0b10xxxxxx), then check if the leading byte starts a multi-byte sequence that overflows limitBytes.
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
	if (end > 0) {
		const b = buf[end]!;
		const seqLen = (b & 0x80) === 0 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
		if (end + seqLen > limitBytes) {
			// The code point starting at `end` does not fit within `limitBytes`; drop it.
		} else {
			end += seqLen;
		}
	}
	const sliced = buf.subarray(0, end).toString("utf8");
	const effectiveBytes = Buffer.byteLength(sliced, "utf8");
	return {
		text: sliced,
		bound: {
			limitBytes,
			originalBytes,
			effectiveBytes,
			truncated: true,
			reason: `truncated from ${originalBytes} to ${effectiveBytes} UTF-8 bytes (limit ${limitBytes})`,
		},
	};
}

interface Section { hashes: string; rawHeading: string; heading: string; body: string }

/**
 * The sections of a text under Markdown headings (`#` to `######`); text before the first heading
 * belongs to none. Lines inside a CommonMark fenced code block (` ``` ` or `~~~`, up to three
 * leading spaces, closed only by a line of the same character at least as long) are code, not
 * headings (B26, B27).
 */
function sectionsOf(text: string): Section[] {
	const secs: Section[] = [];
	let cur: { hashes: string; rawHeading: string; heading: string; lines: string[] } | null = null;
	let fence: { char: string; len: number } | null = null;
	for (const line of text.split("\n")) {
		if (fence !== null) {
			cur?.lines.push(line);
			const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (m !== null && m[1]![0] === fence.char && m[1]!.length >= fence.len) fence = null;
			continue;
		}
		const fm = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fm !== null && (fm[1]![0] !== "`" || !fm[2]!.includes("`"))) {
			fence = { char: fm[1]![0]!, len: fm[1]!.length };
			cur?.lines.push(line);
			continue;
		}
		const hm = /^(#{1,6}\s+)(.*)$/.exec(line);
		if (hm !== null) {
			if (cur !== null) secs.push({ hashes: cur.hashes, rawHeading: cur.rawHeading, heading: cur.heading, body: cur.lines.join("\n") });
			cur = { hashes: hm[1]!, rawHeading: hm[2]!, heading: hm[2]!.trim(), lines: [] };
		} else {
			cur?.lines.push(line);
		}
	}
	if (cur !== null) secs.push({ hashes: cur.hashes, rawHeading: cur.rawHeading, heading: cur.heading, body: cur.lines.join("\n") });
	return secs;
}

/** Which of `ids` a heading names: exact, then `prefix.id`, then the id as the heading's first token (`Q01: ...`, `suite.Q01 - ...`). */
function headingId(heading: string, ids: string[]): string | undefined {
	const firstToken = heading.split(/[\s:—–-]+/)[0] ?? "";
	return ids.find((x) => heading === x) ?? ids.find((x) => heading.endsWith(`.${x}`)) ?? ids.find((x) => firstToken === x || firstToken.endsWith(`.${x}`));
}

/** Whether a heading names one of `expected`, without regard to case, on the heading or its first token (B24). */
function isExpectedHeading(heading: string, expected: string[]): boolean {
	if (expected.length === 0) return false;
	const lower = heading.toLowerCase();
	const lowIds = expected.map((x) => x.toLowerCase());
	return headingId(lower, lowIds) !== undefined;
}

export interface SplitAnswersOptions {
	/** Non-answer headings the scenario expects (such as `OBSERVATIONS`), which end the preceding answer without firing `ended-at-unrequested-heading` (B24). */
	expectedHeadings?: string[];
	/** Whether an answer ends at any heading (`"any-heading"`, default) or only at a requested `answerHeading` or one of `expectedHeadings` (`"question-or-expected"`, B27). */
	answerTermination?: "any-heading" | "question-or-expected";
}

/**
 * When `answerTermination` is `"question-or-expected"`, merge any section whose heading is neither
 * a requested answer nor an expected heading into the requested answer section before it, keeping
 * its `#` heading line intact (B27).
 */
function foldInternalHeadings(secs: Section[], ids: string[], expected: string[]): Section[] {
	const out: Section[] = [];
	for (const s of secs) {
		const isBoundary = headingId(s.heading, ids) !== undefined || isExpectedHeading(s.heading, expected);
		const last = out[out.length - 1];
		if (!isBoundary && last !== undefined && headingId(last.heading, ids) !== undefined) {
			const sub = `${s.hashes}${s.rawHeading}\n${s.body}`;
			last.body = `${last.body}\n${sub}`;
		} else {
			out.push({ ...s });
		}
	}
	return out;
}

/**
 * Answers under Markdown headings (`#` to `######`), for each id expected; an id with no heading is
 * absent, and a heading not expected (such as `Observations`) is ignored. A heading may carry a
 * prefix before the id, as `### suite.X1`, or trailing title text after the id, as `## Q01 - Routing`.
 * If a heading appears more than once, the first non-empty occurrence is kept. An answer ends at the
 * next heading of any level, or, when `answerTermination` is `"question-or-expected"`, at the next
 * requested or expected heading.
 */
export function splitAnswers(text: string, ids: string[], marker?: string, opts?: SplitAnswersOptions): Map<string, string | null> {
	const out = new Map<string, string | null>(ids.map((id) => [id, null]));
	const rawSecs = sectionsOf(text);
	const secs = opts?.answerTermination === "question-or-expected" ? foldInternalHeadings(rawSecs, ids, opts.expectedHeadings ?? []) : rawSecs;
	for (const sec of secs) {
		const id = headingId(sec.heading, ids);
		if (id === undefined) continue;
		const cleaned = stripSelfExplanation(sec.body, marker);
		const prev = out.get(id);
		if (prev === null || (prev === "" && cleaned !== "")) out.set(id, cleaned);
	}
	return out;
}

/** What extraction found for one answer, beside the answer itself. Findings may overlap. */
export type ExtractionFinding =
	| "no-heading" // no section of the text read has a heading naming the answer
	| "empty-section" // sections matched, and every one was empty
	| "duplicate-heading" // more than one section matched; the first non-empty one was taken
	| "heading-beyond-bound" // the text before the response bound had more matching sections than the text read
	| "cut-by-bound" // the response bound removed bytes of the answer
	| "ended-at-unrequested-heading"; // the answer ended at a heading naming no requested answer, with text under it

export interface AnswerExtraction {
	/** The heading searched for. */
	heading: string;
	/** Where the text came from, and the phase and attempt of the cell it is from. */
	source: "final" | "scored-file";
	phase: string;
	attempt: number;
	/** Whether the response bound truncated the text read. */
	bounded: boolean;
	/** Sections of the text read whose heading names the answer, and how many of them were empty. */
	matched: number;
	emptyMatched: number;
	/** The 1-based place, among the matched sections, of the one taken; null when none was. */
	selected: number | null;
	/** UTF-8 bytes of the answer taken, or null when there is none. */
	answerBytes: number | null;
	/** Matched sections in the text before the response bound; equal to matched when it cut nothing. */
	matchedBeforeBound: number;
	/** UTF-8 bytes of the answer the response bound removed: the answer before the bound less the answer read. */
	cutBytes: number;
	/** The heading that ended the answer taken, whether it names a requested answer, and the UTF-8 bytes under it and any further headings up to the next requested one; null when the answer ran to the end. */
	endedAt: { heading: string; requested: boolean; bytes: number } | null;
	findings: ExtractionFinding[];
}

const bytesOf = (t: string): number => Buffer.byteLength(t, "utf8");

/** The answer splitAnswers takes for `id` from `secs`, with the matched sections' places. */
function pick(secs: Section[], id: string, marker: string | undefined): { answer: string | null; matched: number[]; empty: number; selected: number | null } {
	const matched = secs.flatMap((s, i) => (headingId(s.heading, [id]) !== undefined ? [i] : []));
	const bodies = matched.map((i) => stripSelfExplanation(secs[i]!.body, marker));
	const k = bodies.findIndex((b) => b !== "");
	return { answer: k >= 0 ? bodies[k]! : matched.length ? "" : null, matched, empty: bodies.filter((b) => b === "").length, selected: k >= 0 ? k + 1 : null };
}

/**
 * Extracts one answer as splitAnswers does, and reports how: `text` is what extraction reads (after
 * self-explanation stripping and the response bound), `beforeBound` the same text before the bound,
 * and `requested` every answer heading of the scenario, so an answer ending at another requested
 * heading is told from one ending at a heading that names none.
 */
export function extractAnswer(
	text: string, beforeBound: string, id: string, requested: string[], marker: string | undefined,
	where: { source: "final" | "scored-file"; phase: string; attempt: number },
	opts?: SplitAnswersOptions,
): { answer: string | null; extraction: AnswerExtraction } {
	const expected = opts?.expectedHeadings ?? [];
	const fold = (s: Section[]): Section[] => (opts?.answerTermination === "question-or-expected" ? foldInternalHeadings(s, requested, expected) : s);
	const secs = fold(sectionsOf(text));
	const got = pick(secs, id, marker);
	const bounded = beforeBound !== text;
	const before = bounded ? pick(fold(sectionsOf(beforeBound)), id, marker) : got;
	const cutBytes = bounded ? Math.max(0, bytesOf(before.answer ?? "") - bytesOf(got.answer ?? "")) : 0;
	const isKnownBoundary = (h: string): boolean => headingId(h, requested) !== undefined || isExpectedHeading(h, expected);
	let endedAt: AnswerExtraction["endedAt"] = null;
	if (got.matched.length > 0) {
		const endOf = (mIdx: number): { heading: string; requested: boolean; bytes: number } | null => {
			const at = mIdx + 1;
			if (at >= secs.length) return null;
			const next = secs[at]!;
			const requestedNext = headingId(next.heading, requested) !== undefined;
			let bytes = 0;
			if (!requestedNext) for (let i = at; i < secs.length && headingId(secs[i]!.heading, requested) === undefined; i++) bytes += bytesOf(secs[i]!.body.trim());
			return { heading: next.heading, requested: requestedNext, bytes };
		};
		if (got.selected !== null) {
			endedAt = endOf(got.matched[got.selected - 1]!);
		} else {
			endedAt = got.matched.map(endOf).find((e) => e !== null && !isKnownBoundary(e.heading) && e.bytes > 0) ?? endOf(got.matched[got.matched.length - 1]!);
		}
	}
	const findings: ExtractionFinding[] = [];
	if (got.matched.length === 0) findings.push("no-heading");
	if (got.matched.length > 0 && got.selected === null) findings.push("empty-section");
	if (got.matched.length > 1) findings.push("duplicate-heading");
	if (before.matched.length > got.matched.length) findings.push("heading-beyond-bound");
	if (cutBytes > 0) findings.push("cut-by-bound");
	if (endedAt !== null && !isKnownBoundary(endedAt.heading) && endedAt.bytes > 0) findings.push("ended-at-unrequested-heading");
	return {
		answer: got.answer,
		extraction: {
			heading: id, ...where, bounded, matched: got.matched.length, emptyMatched: got.empty, selected: got.selected,
			answerBytes: got.answer === null ? null : bytesOf(got.answer), matchedBeforeBound: before.matched.length, cutBytes, endedAt, findings,
		},
	};
}
