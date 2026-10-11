// experiment-register - fixes an experiment before it runs (architecture section 5, principle P4).
//
// Recording an experiment stores a content hash over everything that decides how it is run and
// judged: its declaration; every scenario it lists, with their keys; every fixture file; every hook
// file it reaches; and the pack's declarations of the arms, variants and population it uses, its
// masks and its isolation probes. A run's status is then a fact, not a claim: a run of an
// experiment that is unrecorded, or whose content has changed since it was recorded, is
// exploration, whatever status it declares.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LoadedPack, Status } from "./pack-schema.js";

export interface Record {
	experiment: string;
	hash: string;
	recordedAt: string;
	declaredStatus: Status;
}

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = path.join(d, e.name);
			// A symbolic link is followed, so the content it points to is what is hashed.
			const st = fs.statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) out.push(p);
		}
	};
	walk(dir);
	return out;
}

/** JSON with object keys sorted, so a hash does not depend on key order. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (typeof v === "object" && v !== null) {
		const o = v as { [k: string]: unknown };
		return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(v);
}

/** What the hash covers, as named parts, so a test can show each part moves it. */
export function hashedParts(loaded: LoadedPack, experimentId: string): Map<string, string> {
	const { dir, pack } = loaded;
	const e = loaded.experiments.get(experimentId);
	if (!e) throw new Error(`no experiment ${experimentId} in pack ${pack.id}`);
	const parts = new Map<string, string>();
	const read = (p: string): string => fs.readFileSync(path.resolve(dir, p), "utf8");
	parts.set(`experiment:${e.file}`, read(e.file));
	const hookIds = new Set<string>();
	for (const { file, scenario } of e.scenarios.values()) {
		parts.set(`scenario:${file}`, read(file));
		if (typeof scenario.fixture === "string") {
			const root = path.resolve(dir, scenario.fixture);
			for (const f of filesUnder(root)) parts.set(`fixture:${path.relative(dir, f)}`, fs.readFileSync(f).toString("base64"));
		}
		for (const p of scenario.properties) if (p.measure !== undefined) hookIds.add(p.measure);
	}
	const arms = pack.arms.filter((a) => e.experiment.factors.arms.includes(a.id));
	const variantIds = new Set(arms.flatMap((a) => a.deliver.map((d) => d.variant)));
	const variants = pack.variants.filter((v) => variantIds.has(v.id));
	for (const v of variants) if (v.transform !== undefined) hookIds.add(v.transform);
	// The declaration-check hook decides whether the pack is valid at all, so it is always covered.
	for (const h of pack.hooks) if (h.kind === "declaration-check") hookIds.add(h.id);
	const hooks = pack.hooks.filter((h) => hookIds.has(h.id));
	for (const h of hooks) parts.set(`hook:${h.file}`, read(h.file));
	const sourceIds = new Set(variants.map((v) => v.source));
	parts.set("rules", canonical({
		arms,
		variants,
		sources: pack.sources.filter((s) => sourceIds.has(s.id)),
		hooks,
		population: pack.population.filter((m) => e.experiment.factors.population.includes(m.id)),
		masks: pack.masks,
		isolation: pack.isolation,
		suites: pack.suites.filter((s) => s.experiment === experimentId),
	}));
	return parts;
}

export function contentHash(loaded: LoadedPack, experimentId: string): string {
	const h = createHash("sha256");
	for (const [k, v] of [...hashedParts(loaded, experimentId)].sort(([a], [b]) => a.localeCompare(b))) h.update(`${k}\0${v}\0`);
	return h.digest("hex");
}

// The register lives with the pack, not with run records: it is the evidence that an experiment was
// fixed before its outcomes existed, so the project keeps it alongside the experiment itself.
// It is append-only: recording again adds an entry and never replaces one, so every recording, and
// when it was made, stays visible against the runs that followed it (B13).
const registerFile = (loaded: LoadedPack, experimentId: string): string =>
	path.resolve(loaded.dir, "register", `${experimentId}.json`);

interface RegisterFile {
	experiment: string;
	records: Record[];
}

export function recordHistory(loaded: LoadedPack, experimentId: string): Record[] {
	const file = registerFile(loaded, experimentId);
	if (!fs.existsSync(file)) return [];
	const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RegisterFile | Record;
	// A register written before the history form held a single record.
	return "records" in raw ? raw.records : [raw];
}

export function recordExperiment(loaded: LoadedPack, experimentId: string, now: Date = new Date()): Record {
	const e = loaded.experiments.get(experimentId);
	if (!e) throw new Error(`no experiment ${experimentId}`);
	const rec: Record = { experiment: experimentId, hash: contentHash(loaded, experimentId), recordedAt: now.toISOString(), declaredStatus: e.experiment.declaredStatus };
	const history = recordHistory(loaded, experimentId);
	const last = history[history.length - 1];
	if (last !== undefined && last.recordedAt >= rec.recordedAt) throw new Error(`a record of ${experimentId} at ${last.recordedAt} is not earlier than ${rec.recordedAt}`);
	const file = registerFile(loaded, experimentId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ experiment: experimentId, records: [...history, rec] }, null, 2) + "\n");
	return rec;
}

/** The latest record, which governs runs made now. */
export function readRecord(loaded: LoadedPack, experimentId: string): Record | null {
	const h = recordHistory(loaded, experimentId);
	return h.length ? h[h.length - 1]! : null;
}

/** The status a run of this experiment carries now, and the record it rests on. */
export function runStatus(loaded: LoadedPack, experimentId: string): { status: Status; reason: string; record: Record | null } {
	const e = loaded.experiments.get(experimentId);
	if (!e) throw new Error(`no experiment ${experimentId}`);
	const rec = readRecord(loaded, experimentId);
	if (rec === null) return { status: "exploration", reason: "the experiment is not recorded", record: null };
	if (rec.hash !== contentHash(loaded, experimentId)) return { status: "exploration", reason: "the experiment changed after it was recorded", record: rec };
	return { status: e.experiment.declaredStatus, reason: "recorded, unchanged", record: rec };
}
