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
// slower family is not scored as a weaker agent.

import { isInside } from "./paths.js";
import type { Outcome } from "./outcome.js";

export type Cause = "isolation" | "infrastructure" | "behaviour";
export type Validity = { valid: true } | { valid: false; cause: Cause; detail: string };

export interface Forbidden {
	paths: string[];
	addresses: string[];
}

export const RERUN: Record<Cause, boolean> = { isolation: true, infrastructure: true, behaviour: false };

export function classify(o: Outcome, forbidden: Forbidden): Validity {
	for (const t of o.tools) {
		for (const p of t.paths) {
			const hit = forbidden.paths.find((f) => isInside(p, f));
			if (hit !== undefined) return { valid: false, cause: "isolation", detail: `${t.name} touched ${p}, inside forbidden ${hit}` };
		}
		for (const a of t.addresses) {
			const hit = forbidden.addresses.find((f) => a === f || a.startsWith(f.endsWith("/") ? f : `${f}/`) || a.startsWith(`${f}?`) || a.startsWith(`${f}#`));
			if (hit !== undefined) return { valid: false, cause: "isolation", detail: `${t.name} reached ${a}, a forbidden address` };
		}
	}
	if (o.filtered || o.error?.cause === "filter") return { valid: false, cause: "infrastructure", detail: "the provider's content filter blocked a response" };
	if (o.error?.cause === "provider") return { valid: false, cause: "infrastructure", detail: `the provider failed: ${o.error.message.slice(0, 200)}` };
	if (o.stop.reason === "timeout" && o.stop.inFlight === "model") return { valid: false, cause: "infrastructure", detail: "stopped at its time limit while waiting on a model call" };
	if (o.error?.cause === "overflow") return { valid: false, cause: "behaviour", detail: "the agent's context overflowed" };
	if (o.stop.reason === "timeout") return { valid: false, cause: "behaviour", detail: `stopped at its time limit while ${o.stop.inFlight === "tool" ? "a tool ran" : "working"}` };
	if (o.error !== null) return { valid: false, cause: "infrastructure", detail: `the runtime reported an error: ${o.error.message.slice(0, 200)}` };
	if (o.exit !== 0) return { valid: false, cause: "infrastructure", detail: `the runtime exited ${o.exit}${o.signal ? ` on ${o.signal}` : ""}` };
	if (o.final.trim() === "") return { valid: false, cause: "behaviour", detail: "the agent ended with no message" };
	return { valid: true };
}
