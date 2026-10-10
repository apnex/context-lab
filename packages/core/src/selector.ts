// selector - chooses scenarios by their declared tags, and resolves a suite by name (decision 0008).
//
// A suite is a named, saved selection of scenarios with the experiment that runs them, held in the
// pack. Resolving it is deterministic: the same pack gives the same scenario list, in the order the
// experiment lists its scenarios, and the list changes only as the selection rule says it should.

import { entryView, selectScenarios } from "./pack-checker.js";
import type { LoadedPack, SuiteSelection } from "./pack-schema.js";

export interface ResolvedSuite {
	suite: string;
	experiment: string;
	scenarios: string[];
}

export function resolveSuite(loaded: LoadedPack, suiteId: string): ResolvedSuite {
	const suite = loaded.pack.suites.find((s) => s.id === suiteId);
	if (!suite) throw new Error(`no suite ${suiteId} in pack ${loaded.pack.id}`);
	return { suite: suite.id, experiment: suite.experiment, scenarios: select(loaded, suite.experiment, suite.select) };
}

export function select(loaded: LoadedPack, experimentId: string, selection: SuiteSelection): string[] {
	const e = loaded.experiments.get(experimentId);
	if (!e) throw new Error(`no experiment ${experimentId} in pack ${loaded.pack.id}`);
	return selectScenarios([...e.scenarios.values()].map((x) => x.scenario), selection);
}

export { entryView };
