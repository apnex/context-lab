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

/**
 * Answers under "### <id>" headings, for each id expected; an id with no heading is absent, and a
 * heading not expected is ignored. A heading may carry a prefix before the id, as "### suite.X1".
 */
export function splitAnswers(text: string, ids: string[], marker?: string): Map<string, string | null> {
	const out = new Map<string, string | null>(ids.map((id) => [id, null]));
	const parts = text.split(/^###\s+/m).slice(1);
	for (const p of parts) {
		const nl = p.indexOf("\n");
		const heading = (nl < 0 ? p : p.slice(0, nl)).trim();
		const body = nl < 0 ? "" : p.slice(nl + 1);
		// The exact heading first, so "explain.X1" is not taken for another id ending the same way.
		const id = ids.find((x) => heading === x) ?? ids.find((x) => heading.endsWith(`.${x}`));
		if (id !== undefined && out.get(id) === null) out.set(id, stripSelfExplanation(body, marker));
	}
	return out;
}
