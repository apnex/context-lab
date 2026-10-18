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

export const HOOK_KINDS = ["declaration-check", "variant-transform", "outcome-measure", "note-generator"] as const;
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
	/** The source revision this variant is built from, overriding the run's: a gate's base and head may be two variants of one source at two revisions. */
	revision?: string;
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
	/**
	 * Runtime settings, each refused before anything runs by a runtime that cannot apply it. opencode:
	 * reasoningEffort, a variant of the model; outputTokenMax, the cap on a reply's tokens (opencode's own
	 * default 32,000), each model still held to its own limit.output. Codex: reasoningEffort.
	 */
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
	/** Comparison rules the pack declares. */
	comparisons?: Comparison[];
	/** Thresholds for writing candidate findings from a run's result. */
	findingRules?: FindingRules;
}

export interface FindingRules {
	/** Scale-normalised fail rate above which a precision property in a guided arm emits a candidate; 0.25 by default. */
	wrongFiringThreshold?: number;
	/** Pairs-weighted metNot rate across guided arms above which a guidance entry emits a candidate; 0.5 by default. */
	knowsNotActsThreshold?: number;
	/** Hydration rate below which a guided arm that could reach an entry only on request emits a routing-miss candidate; 0.5 by default. */
	routingMissThreshold?: number;
	/** Share of hydrating cells not meeting an adherence property above which it emits a hydrated-not-acted candidate; 0.5 by default. */
	hydratedNotActedThreshold?: number;
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
	/** The heading in the scenario's scored file under which this property's answer is written; the answer under it is what is judged. */
	answerHeading?: string;
	/** The question a judge is shown for an answer; the task's text under the answer heading if not given. */
	question?: string;
	/** The phase whose outcome the property is judged on; the scenario's last phase if not given. */
	phase?: string;
	/** What a judge is shown beside the phase's outcome: the note the phase was given, the changes it started from, or the arm's delivered reading ("delivered"). */
	judgedWith?: ("note" | "start" | "delivered")[];
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
	/** Where answers under answerHeading are split from: the scenario's scoredFile, or the phase's final message ("final"). */
	answerSource?: "scored-file" | "final";
	/** Optional UTF-8 byte ceiling applied to the scored response text (after self-explanation stripping, before answer splitting and blinding). */
	maxResponseBytes?: number;
	/** Anything a reader of the pack needs to know; never shown to an agent or judge. */
	notes?: string;
	/** The scenario's own phases, overriding the experiment's; the first phase's task is the scenario's task. */
	phases?: ScenarioPhase[];
	/** Traps declared as pairs of versions, each placed at one of its positions by the rotation rule. */
	trapPairs?: TrapPair[];
}

export interface Phase {
	id: string;
	session: "new";
}

/** A phase of an episode. */
export interface ScenarioPhase {
	id: string;
	/** A new session, or the session of the phase it follows, continued. */
	session: "new" | "continue";
	/** The phase's task; the first phase's is the scenario's task. */
	task?: string;
	/** The phase whose ending state this phase starts from; the phase before it in the list if not given. Phases sharing one are branches. */
	after?: string;
	/** The note a new session is given: a file the earlier phase wrote, or the output of a note-generator hook. */
	note?: { file: string } | { generator: string };
	/** Files removed from a new session's starting workspace. */
	withhold?: string[];
}

export interface TrapVersion {
	id: string;
	/** Text placed at the trap's position, a {SLOT:<position>} marker in a phase's task. */
	text: string;
	/** Files added to the starting workspace of the phase holding the trap's position, and no earlier one. */
	files?: Record<string, string>;
}

export interface TrapPair {
	id: string;
	/** Slot names the trap may take, each a {SLOT:<name>} marker in exactly one phase's task. */
	positions: string[];
	versions: TrapVersion[];
	/** Properties judged on whichever phase holds the trap's position in a cell. */
	properties: Property[];
}

export interface Comparison {
	id: string;
	experiment: string;
	rule: "aa" | "tolerance" | "improve";
	base: string;
	head: string;
	/** Properties a comparison covers, for the A/A rule; every property of the experiment if not given. */
	m?: number;
	tolerance?: number;
}

export interface Experiment {
	id: string;
	declaredStatus: Status;
	/** Scenario files, relative to the pack. */
	scenarios: string[];
	factors: { arms: string[]; population: string[] };
	runsPerCell: number;
	/** Maximum attempts per cell when an infrastructure or isolation failure triggers a re-run (1 for no retries, 2 by default). */
	maxAttemptsPerCell?: 1 | 2;
	/** Optional UTF-8 byte ceiling applied to each phase's scored response text (after self-explanation stripping, before answer splitting and blinding). */
	maxResponseBytes?: number;
	phases: Phase[];
	/** Instructions every agent in the experiment receives before its task. */
	instructions?: string;
	/** Context about the situation, given after the instructions. */
	preamble?: string;
	/** Instructions every judge receives. */
	judgeInstructions?: string;
	/** Who judges, and how judges guess the condition; by default the experiment's population, guessing the arm. */
	judging?: Judging;
	/** The smallest difference in pass rate the experiment means to detect, and its scope; required to record an experiment declared result. */
	variation?: { difference: number; scope: "pooled" | "property" };
	/** The decision taken when no difference is detected. */
	default?: string;
	notes?: string;
}

export interface ChainFinding {
	id: string;
	kind: "named" | "computed" | "named or computed";
	statement: string;
	countsWhen: string;
}

export interface ChainThreshold {
	minScenarios: number;
	minHeldOut: number;
	minFamilies: number;
}

export interface JudgingChain {
	findings: ChainFinding[];
	threshold?: ChainThreshold;
}

export interface Judging {
	/** Population members who judge; each outcome is judged by every one of another family than its agent's. */
	judges?: string[];
	/** The conditions a judge guesses between, each a name for a set of arms; by default each arm is its own. */
	guessGroups?: Record<string, string[]>;
	/** Outcomes per judge prompt; 6 by default. */
	outcomesPerPrompt?: number;
	/** A classify-then-verify judging chain across three model families (Delta-3 stage 2). */
	chain?: JudgingChain;
}

/** A pack loaded with its experiments and scenarios, after it has passed the checker. */
export interface LoadedPack {
	dir: string;
	pack: Pack;
	experiments: Map<string, { file: string; experiment: Experiment; scenarios: Map<string, { file: string; scenario: Scenario }> }>;
}

/** A scenario's phases: its own, or the experiment's. */
export function phasesOf(scenario: Scenario, experiment: Experiment): ScenarioPhase[] {
	return scenario.phases ?? experiment.phases.map((p) => ({ id: p.id, session: p.session }));
}

/** Every property of a scenario: its own and its trap pairs'. */
export function propertiesOf(scenario: Scenario): Property[] {
	return [...scenario.properties, ...(scenario.trapPairs ?? []).flatMap((t) => t.properties)];
}

/** The phase a slot sits in: the phase whose task holds {SLOT:name}; the first phase's task is the scenario's. */
export function phaseOfSlot(scenario: Scenario, phases: ScenarioPhase[], slot: string): string | undefined {
	const marker = `{SLOT:${slot}}`;
	return phases.find((p, i) => (i === 0 ? scenario.task : p.task ?? "").includes(marker))?.id;
}

/** The rotation rule (Delta-2): for run index r from 0, pair index k, member index j. */
export function rotate(pair: TrapPair, r: number, k: number, j: number): { position: string; version: string } {
	return { position: pair.positions[(r + k) % pair.positions.length]!, version: pair.versions[(j + r) % pair.versions.length]!.id };
}
