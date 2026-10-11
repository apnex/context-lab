// phase-driver - executes a scenario's declared phases; at this stage, one phase in a new session
// (architecture section 5; Delta-1 fences the driver to one phase, no notes, no branches).
//
// The prompt is the experiment's instructions, its preamble and the scenario's task, in that order,
// separated by blank lines, any absent part left out. Two placeholders are filled from the arm:
// {ON_REQUEST} with its on-request folders, one per line, and {WORKSPACE} with the workspace.

import type { Adapter, Invocation } from "./adapters.js";
import type { ComposedArm } from "./arm-composer.js";
import type { Outcome } from "./outcome.js";
import type { Experiment, Member, Scenario } from "./pack-schema.js";

export function promptFor(experiment: Experiment, scenario: Scenario, arm: ComposedArm, workspace: string): string {
	const fill = (t: string): string => t.split("{ON_REQUEST}").join(arm.onRequest.map((o) => o.path).join("\n")).split("{WORKSPACE}").join(workspace);
	return [experiment.instructions, experiment.preamble, scenario.task].filter((x): x is string => x !== undefined && x !== "").map(fill).join("\n\n");
}

export interface PhaseRun {
	adapter: Adapter;
	experiment: Experiment;
	scenario: Scenario;
	arm: ComposedArm;
	member: Member;
	workspace: string;
	work: string;
	timeLimitSeconds: number;
}

export async function runPhase(r: PhaseRun): Promise<Outcome> {
	if (r.experiment.phases.length !== 1 || r.experiment.phases[0]!.session !== "new") throw new Error(`experiment ${r.experiment.id} declares phases this driver does not run: one phase in a new session only`);
	const inv: Invocation = {
		arm: r.arm, workspace: r.workspace, prompt: promptFor(r.experiment, r.scenario, r.arm, r.workspace), mode: r.adapter.modes[0]!,
		member: r.member, tools: "on", timeLimitSeconds: r.timeLimitSeconds, work: r.work,
	};
	return r.adapter.invoke(inv);
}
