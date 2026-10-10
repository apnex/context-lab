// pack-schema - the shape of a project pack, version 1.
//
// A project pack holds everything specific to one project (architecture section 6): its
// experiments and suites, context sources and variants, arms, population, masks, isolation
// probes, hooks and where its run records live. Nothing project-specific is read from anywhere
// else. This module declares the shape only; the pack checker validates a pack against it.

export const PACK_SCHEMA = "context-lab.pack/1";
export const PACK_FILE = "pack.json";

export const DELIVERY_KINDS = ["instruction", "folder-file", "on-request"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const HOOK_KINDS = ["declaration-check", "variant-transform", "outcome-measure"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

export const PROPERTY_TYPES = ["adherence", "precision", "comprehension"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const DECIDERS = ["judge", "code"] as const;
export type Decider = (typeof DECIDERS)[number];

export const STATUSES = ["result", "exploration"] as const;
export type Status = (typeof STATUSES)[number];

/** A tag of this form names an entry a scenario exercises; the reverse view is built from it. */
export const EXERCISES_TAG = "exercises:";

export interface Source {
	id: string;
	/** A local directory holding the source, relative to the pack or absolute. */
	path: string;
	/** Every address under which the source is published; rewritten in variants, longest first. */
	addresses: string[];
	/** Paths, relative to the source and inside it, removed from every variant: a folder or a file, literally. */
	exclude?: string[];
}

export interface Variant {
	id: string;
	source: string;
	/** Glob patterns matched against each file's path relative to the source; "*" stays within a folder, "**" crosses folders. */
	include?: string[];
	/** The id of a variant-transform hook. */
	transform?: string;
	canaries: string[];
}

export interface Delivery {
	variant: string;
	/** A path within the variant. */
	file: string;
	as: DeliveryKind;
}

export interface Arm {
	id: string;
	deliver: Delivery[];
}

export interface Member {
	id: string;
	family: string;
	runtime: string;
	model: string;
	settings?: Record<string, string | number | boolean>;
}

export interface Hook {
	id: string;
	kind: HookKind;
	/** A single-file script, relative to the pack. */
	file: string;
	timeLimitSeconds: number;
}

export interface LeakProbe {
	id: string;
	question: string;
	/** A regular expression; an answer matching it shows withheld content leaked. */
	leak: string;
	/** The arms the content is withheld from, where a match is a leak. */
	arms: string[];
}

export interface SuiteSelection {
	/** A scenario is selected if it carries every one of these tags. */
	allTags?: string[];
	/** And, if this is given, at least one of these. */
	anyTags?: string[];
	/** Scenarios selected by id, in addition to those selected by tag. */
	scenarios?: string[];
}

export interface Suite {
	id: string;
	experiment: string;
	select: SuiteSelection;
}

export interface Pack {
	schema: string;
	id: string;
	sources: Source[];
	variants: Variant[];
	arms: Arm[];
	population: Member[];
	hooks: Hook[];
	masks: { identifiers: string[]; selfExplanationMarker?: string };
	/** Forbidden paths are resolved against the pack when relative. */
	isolation: { leakProbes: LeakProbe[]; forbidden: { paths: string[]; addresses: string[] } };
	/** Experiment files, relative to the pack. */
	experiments: string[];
	suites: Suite[];
	/** Where run records are written, relative to the pack; the experiment register lives in the pack's own register/ folder. */
	records: { path: string };
}

export interface Property {
	id: string;
	type: PropertyType;
	decidedBy: Decider;
	key: string;
	scale: [number, number];
	guidance?: string[];
	/** The id of an outcome-measure hook, for a property decided by code. */
	measure?: string;
	/** How a judge turns the key into a score, where the scale has more than two points. */
	rubric?: string;
	/** Anything a reader of the pack needs to know about the property; never shown to an agent or judge. */
	notes?: string;
}

export interface InlineFixture {
	files: Record<string, string>;
}

export interface Scenario {
	id: string;
	tags: string[];
	heldOut?: boolean;
	/** The starting files: a directory relative to the pack, the files inline, or null for none. */
	fixture: string | InlineFixture | null;
	task: string;
	properties: Property[];
	/** The starting state, as a judge is told it. */
	start?: string;
	/** What a judge scores, where it is not the whole outcome. */
	scoring?: string;
	/** A file in the outcome that is scored in place of the final message. */
	scoredFile?: string;
	/** Anything a reader of the pack needs to know; never shown to an agent or judge. */
	notes?: string;
}

export interface Phase {
	id: string;
	session: "new";
}

export interface Experiment {
	id: string;
	declaredStatus: Status;
	/** Scenario files, relative to the pack. */
	scenarios: string[];
	factors: { arms: string[]; population: string[] };
	runsPerCell: number;
	phases: Phase[];
	/** Instructions every agent in the experiment receives before its task. */
	instructions?: string;
	/** Context about the situation, given after the instructions. */
	preamble?: string;
	/** Instructions every judge receives. */
	judgeInstructions?: string;
	notes?: string;
}

/** A pack loaded with its experiments and scenarios, after it has passed the checker. */
export interface LoadedPack {
	dir: string;
	pack: Pack;
	experiments: Map<string, { file: string; experiment: Experiment; scenarios: Map<string, { file: string; scenario: Scenario }> }>;
}
