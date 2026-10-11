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
		const id = ids.find((x) => heading === x || heading.endsWith(`.${x}`));
		if (id !== undefined && out.get(id) === null) out.set(id, stripSelfExplanation(body, marker));
	}
	return out;
}
