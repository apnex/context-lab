// validity-classifier - classifies a cell valid, or invalid by cause (architecture section 5, P7).
//
// It reads only the common form, never a runtime's own events. Causes are checked in a fixed order,
// because a cell can show more than one and the first decides what happens to it:
//
//   isolation       a tool touched a forbidden path or address - re-run once; the outcome is void,
//                   whatever else happened, because the agent may have seen what it must not
//   infrastructure  the provider failed or filtered, or the runtime was stopped while waiting on a
//                   model call it had begun - re-run once; not the agent's doing
//   behaviour       the agent ran out its time working, overflowed its context, or ended with no
//                   message - not re-run; every property it had not reached scores 0
//
// "Waiting on a model call" is read from the trace: a timeout with a model call begun and not ended
// is infrastructure, a timeout during a tool call or between calls is behaviour. A slow model and a
// stalled provider look the same from outside, and both are counted against the provider, so a
// slower family is not scored as a weaker agent. Where the trace cannot tell a model call from a
// tool - opencode runs tools inside a step and reports them only when they end - a first timeout is
// infrastructure and a second timeout of the same cell is behaviour.
//
// A forbidden address is found in any string of a tool's input, not only in what parses as an
// address: with or without a scheme, http or https, any case, and a host followed by / or : - which
// covers git's user@host:path form. It fails closed: a string that only mentions the address, or a
// lookalike host ending in the same name, also counts. An address assembled at run time from
// variables, percent-encoded, or reached through a program or mirror that names it another way -
// `gh api repos/...`, api.github.com, a CDN mirror - is not found.

import { isInside } from "./paths.js";
import type { Outcome } from "./outcome.js";

export type Cause = "isolation" | "infrastructure" | "behaviour";
export type Validity = { valid: true } | { valid: false; cause: Cause; detail: string };

export interface Forbidden {
	paths: string[];
	addresses: string[];
	/** Paths inside a forbidden path that this cell may still touch: its own workspace, its arm's on-request folders. */
	allow?: string[];
}

export const RERUN: Record<Cause, boolean> = { isolation: true, infrastructure: true, behaviour: false };

function stringsIn(v: unknown): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.flatMap(stringsIn);
	if (typeof v === "object" && v !== null) return Object.values(v).flatMap(stringsIn);
	return [];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern matching every common written form of a forbidden address. */
export function addressPattern(address: string): RegExp {
	const u = new URL(address);
	const host = u.hostname.replace(/^www\./, "");
	const rest = u.pathname.replace(/\/+$/, "");
	return new RegExp(`(?:https?://)?(?:[\\w.-]+@)?(?:www\\.)?${escape(host)}[/:]${escape(rest.replace(/^\//, ""))}(?![\\w-])`, "i");
}

/**
 * `timeouts` is how many times this cell has now stopped at its limit with an open step whose
 * nature the trace cannot show, this attempt included (0012): the first such is infrastructure,
 * a later one behaviour.
 */
export function classify(o: Outcome, forbidden: Forbidden, timeouts = 1): Validity {
	const patterns = forbidden.addresses.map((a) => ({ a, re: addressPattern(a) }));
	for (const t of o.tools) {
		for (const p of t.paths) {
			const hit = forbidden.paths.find((f) => isInside(p, f));
			if (hit !== undefined && !(forbidden.allow ?? []).some((a) => isInside(p, a))) return { valid: false, cause: "isolation", detail: `${t.name} touched ${p}, inside forbidden ${hit}` };
		}
		for (const text of [...t.addresses, ...stringsIn(t.input)]) {
			for (const { a, re } of patterns) {
				const m = re.exec(text);
				if (m !== null) {
					const full = t.addresses.find((x) => re.test(x)) ?? m[0];
					return { valid: false, cause: "isolation", detail: `${t.name} reached ${full}, forbidden as ${a}` };
				}
			}
		}
	}
	if (o.filtered || o.error?.cause === "filter") return { valid: false, cause: "infrastructure", detail: "the provider's content filter blocked a response" };
	if (o.error?.cause === "provider") return { valid: false, cause: "infrastructure", detail: `the provider failed: ${o.error.message.slice(0, 200)}` };
	if (o.stop.reason === "timeout" && o.stop.inFlight === "model") return { valid: false, cause: "infrastructure", detail: "stopped at its time limit while waiting on a model call" };
	if (o.stop.reason === "timeout" && o.stop.inFlight === "unknown") {
		return timeouts <= 1
			? { valid: false, cause: "infrastructure", detail: "stopped at its time limit with a model call or a tool open, which the trace cannot tell apart; a first timeout counts against the provider" }
			: { valid: false, cause: "behaviour", detail: "stopped at its time limit again on a re-run" };
	}
	if (o.error?.cause === "overflow") return { valid: false, cause: "behaviour", detail: "the agent's context overflowed" };
	if (o.stop.reason === "timeout") return { valid: false, cause: "behaviour", detail: `stopped at its time limit while ${o.stop.inFlight === "tool" ? "a tool ran" : "working"}` };
	if (o.error !== null) return { valid: false, cause: "infrastructure", detail: `the runtime reported an error: ${o.error.message.slice(0, 200)}` };
	if (o.exit !== 0) return { valid: false, cause: "infrastructure", detail: `the runtime exited ${o.exit}${o.signal ? ` on ${o.signal}` : ""}` };
	if (o.final.trim() === "") return { valid: false, cause: "behaviour", detail: "the agent ended with no message" };
	return { valid: true };
}
