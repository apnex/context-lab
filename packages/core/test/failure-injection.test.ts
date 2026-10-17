// Delta-4 stage 1 (M4.1, B4, criterion H1): end-to-end failure injection for the validity
// classifier through conductRun, opencodeAdapter, codexAdapter, and runSandboxed (bwrap).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	codexAdapter, conductRun, opencodeAdapter,
	type Adapter, type CellRecord, type Result,
} from "../src/index.js";
import { commitAll, copyPack, editJson, scratch } from "./helpers.js";

const FORBIDDEN_URL = "https://example.invalid/almanac/GUIDE.md";
const FORBIDDEN_PATH = "/srv/orchard-private/secret.txt";

function writeOpencodeFaultStub(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "opencode");
	const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "opencode-stub 1.0.0"
  exit 0
fi
LAST=""
Prev=""
PROMPT_FILE=""
for a in "$@"; do
  if [ "$Prev" = "--file" ]; then PROMPT_FILE="$a"; fi
  Prev="$a"
  LAST="$a"
done
if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
  PROMPT=$(cat "$PROMPT_FILE")
else
  PROMPT="$LAST"
fi
CFG="$XDG_CONFIG_HOME/opencode/opencode.json"
if grep -q '"tools"' "$CFG" 2>/dev/null; then
  # tools === "off": probeArm or judgeAll
  case "$PROMPT" in
    *"context-lab-canary.md"*)
      CAN=$(cat "$XDG_CONFIG_HOME"/../instructions/*canary* 2>/dev/null || true)
      if [ -n "$CAN" ]; then TXT="$CAN"; else TXT="NONE"; fi
      ;;
    *"=== OUTCOME"*)
      TXT='{"outcomes":[{"id":"o1","scores":{"graft-1":{"v":1,"reason":"ok"}},"guess":"bare"}]}'
      ;;
    *)
      TXT="NONE"
      ;;
  esac
  printf '{"type":"step_start","part":{}}\\n'
  printf '{"type":"text","part":{"messageID":"m1","text":%s}}\\n' "$(printf '%s' "$TXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  printf '{"type":"step_finish","part":{"reason":"stop","tokens":{"input":10,"output":5,"cache":{"read":0}}}}\\n'
  exit 0
fi

# tools === "on": cell execution, inspect FAULT_MODE in PROMPT
case "$PROMPT" in
  *"FAULT_MODE:isolation-address"*)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"tool_use","part":{"tool":"webfetch","state":{"status":"completed","input":{"url":"${FORBIDDEN_URL}"}}}}\\n'
    printf '{"type":"text","part":{"messageID":"m1","text":"Done."}}\\n'
    printf '{"type":"step_finish","part":{"reason":"stop"}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:isolation-path-open"*|*"FAULT_MODE:isolation-path-sandboxed"*)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"tool_use","part":{"tool":"read","state":{"status":"error","input":{"filePath":"${FORBIDDEN_PATH}"}}}}\\n'
    printf '{"type":"text","part":{"messageID":"m1","text":"Done."}}\\n'
    printf '{"type":"step_finish","part":{"reason":"stop"}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:infra-filter"*)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"error","error":{"name":"ContentFilterError","data":{"message":"blocked by content filter"}}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:infra-provider-503"*)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"error","error":{"name":"APIError","data":{"message":"503 Service Unavailable"}}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:infra-crash"*)
    printf '{"type":"step_start","part":{}}\\n'
    exit 2
    ;;
  *"FAULT_MODE:timeout-open-step-0012"*)
    printf '{"type":"step_start","part":{}}\\n'
    sleep 10
    exit 0
    ;;
  *"FAULT_MODE:behaviour-overflow"*)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"error","error":{"name":"APIError","data":{"message":"prompt is too long: 900000 tokens > 872000 maximum context"}}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:behaviour-empty"*)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"step_finish","part":{"reason":"stop"}}\\n'
    exit 0
    ;;
  *)
    printf '{"type":"step_start","part":{}}\\n'
    printf '{"type":"text","part":{"messageID":"m1","text":"Clean reply."}}\\n'
    printf '{"type":"step_finish","part":{"reason":"stop"}}\\n'
    exit 0
    ;;
esac
`;
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return bin;
}

function writeCodexFaultStub(dir: string): string {
	fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
	const bin = path.join(dir, "bin", "codex");
	const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-stub 1.0.0"
  exit 0
fi
LAST=""
for a in "$@"; do LAST="$a"; done
if [ "$LAST" = "-" ]; then
  PROMPT=$(cat)
else
  PROMPT="$LAST"
fi
TOML="$CODEX_HOME/config.toml"
if grep -q 'sandbox_mode = "read-only"' "$TOML" 2>/dev/null; then
  # tools === "off": probeArm or judgeAll
  case "$PROMPT" in
    *"context-lab-canary.md"*)
      if grep -q "The heron counts eleven stones." "$TOML" 2>/dev/null; then
        TXT="The heron counts eleven stones."
      else
        TXT="NONE"
      fi
      ;;
    *"=== OUTCOME"*)
      TXT='{"outcomes":[{"id":"o1","scores":{"graft-1":{"v":1,"reason":"ok"}},"guess":"bare"}]}'
      ;;
    *)
      TXT="NONE"
      ;;
  esac
  printf '{"type":"thread.started","thread_id":"th-1"}\\n'
  printf '{"type":"turn.started"}\\n'
  printf '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":%s}}\\n' "$(printf '%s' "$TXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  printf '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}\\n'
  exit 0
fi

# tools === "on": cell execution
printf '{"type":"thread.started","thread_id":"th-cell"}\\n'
printf '{"type":"turn.started"}\\n'
case "$PROMPT" in
  *"FAULT_MODE:isolation-address"*)
    printf '{"type":"item.completed","item":{"id":"t1","type":"web_search","status":"completed","action":{"type":"open_page","url":"${FORBIDDEN_URL}"}}}\\n'
    printf '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Done."}}\\n'
    printf '{"type":"turn.completed","usage":{}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:isolation-path-open"*|*"FAULT_MODE:isolation-path-sandboxed"*)
    printf '{"type":"item.completed","item":{"id":"t1","type":"command_execution","status":"failed","exit_code":1,"command":"cat ${FORBIDDEN_PATH}"}}\\n'
    printf '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Done."}}\\n'
    printf '{"type":"turn.completed","usage":{}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:infra-filter"*)
    printf '{"type":"error","message":"The response was blocked by the content filter."}\\n'
    exit 0
    ;;
  *"FAULT_MODE:infra-provider-503"*)
    printf '{"type":"error","message":"upstream returned 503 Service Unavailable"}\\n'
    exit 0
    ;;
  *"FAULT_MODE:infra-crash"*)
    exit 2
    ;;
  *"FAULT_MODE:timeout-model"*)
    sleep 10
    exit 0
    ;;
  *"FAULT_MODE:timeout-tool"*)
    printf '{"type":"item.started","item":{"id":"t1","type":"command_execution","command":"sleep 10"}}\\n'
    sleep 10
    exit 0
    ;;
  *"FAULT_MODE:behaviour-overflow"*)
    printf '{"type":"turn.failed","error":{"message":"Codex ran out of room in the models context window."}}\\n'
    exit 0
    ;;
  *"FAULT_MODE:behaviour-empty"*)
    printf '{"type":"turn.completed","usage":{}}\\n'
    exit 0
    ;;
  *)
    printf '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Clean reply."}}\\n'
    printf '{"type":"turn.completed","usage":{}}\\n'
    exit 0
    ;;
esac
`;
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return dir;
}

function makeOperatorFiles(dir: string): { ocConfig: string; ocCache: string; cxAuth: string; cxModels: string } {
	const ocConfig = path.join(dir, "opencode.json");
	fs.writeFileSync(ocConfig, JSON.stringify({
		provider: { test: { npm: "@ai-sdk/anthropic", options: { baseURL: "http://localhost:4000/v1", apiKey: "{env:CL_TEST_KEY}" }, models: { m1: { name: "m1" } } } },
	}));
	const ocCache = path.join(dir, "oc-cache");
	fs.mkdirSync(ocCache, { recursive: true });
	const cxAuth = path.join(dir, "auth.json");
	fs.writeFileSync(cxAuth, JSON.stringify({ tokens: { access_token: "tok-secret" } }));
	const cxModels = path.join(dir, "models.json");
	fs.writeFileSync(cxModels, JSON.stringify({ models: [{ slug: "m2", supported_reasoning_levels: [{ effort: "high" }] }] }));
	return { ocConfig, ocCache, cxAuth, cxModels };
}

async function runInjectedMode(
	mode: string,
	opts: { openFilesystem?: boolean; timeLimitSeconds?: number; runtimeFilter?: "opencode" | "codex" } = {},
): Promise<{ cells: CellRecord[]; result: Result }> {
	const dir = copyPack();
	const stubDir = scratch();
	const op = makeOperatorFiles(stubDir);
	const ocBin = writeOpencodeFaultStub(path.join(stubDir, "oc-bin"));
	const cxVendor = writeCodexFaultStub(path.join(stubDir, "cx-vendor"));
	const env = { ...process.env, CL_TEST_KEY: "secret-key", PATH: "/usr/bin:/bin" };

	let oc: Adapter = opencodeAdapter({ binary: ocBin, operatorConfig: op.ocConfig, operatorCache: op.ocCache, env });
	let cx: Adapter = codexAdapter({ vendor: cxVendor, auth: op.cxAuth, models: op.cxModels, env });
	if (opts.openFilesystem) {
		oc = { ...oc, filesystem: "open" };
		cx = { ...cx, filesystem: "open" };
	}

	editJson(path.join(dir, "pack.json"), (j) => {
		j.population = [
			{ id: "p1", family: "f1", runtime: "opencode", model: "test/m1" },
			{ id: "p2", family: "f2", runtime: "codex", model: "m2" },
		];
		j.experiments = ["experiments/orchard.json"];
		j.comparisons = [];
		j.suites = [{ id: "all-orchard", experiment: "orchard", select: { allTags: ["orchard"] } }];
	});
	editJson(path.join(dir, "scenarios", "graft.json"), (j) => {
		j.task = `Graft the pear scion. FAULT_MODE:${mode}`;
		// Keep only judged property graft-1 so we don't spend bwrap calls on count-words unless needed.
		j.properties = [j.properties[0]];
	});
	editJson(path.join(dir, "experiments", "orchard.json"), (j) => {
		j.runsPerCell = 1;
		j.factors.arms = ["bare"];
		j.factors.population = opts.runtimeFilter === "opencode" ? ["p1"] : opts.runtimeFilter === "codex" ? ["p2"] : ["p1", "p2"];
		j.judging = { judges: ["p1", "p2"] };
		j.scenarios = ["scenarios/graft.json"];
	});
	commitAll(dir);

	const work = path.join(scratch(), "work");
	const records = path.join(scratch(), "records");
	const { dir: rd, record } = await conductRun(dir, {
		experiment: "orchard",
		adapters: { opencode: oc, codex: cx },
		work,
		records,
		timeLimitSeconds: opts.timeLimitSeconds ?? 30,
		parallel: 2,
	});
	const cells = record.cells.map((c) => JSON.parse(fs.readFileSync(path.join(rd, "cells", `${c}.json`), "utf8")) as CellRecord);
	const result = JSON.parse(fs.readFileSync(path.join(rd, "RESULT.json"), "utf8")) as Result;
	return { cells, result };
}

test("H1: end-to-end failure injection across all 9 fault modes through opencodeAdapter and codexAdapter under bwrap", { timeout: 180000 }, async () => {
	// 1. isolation-address: tool call reaching forbidden URL -> classified isolation, re-run once (2 attempts), excluded.
	{
		const { cells, result } = await runInjectedMode("isolation-address");
		assert.equal(cells.length, 2);
		for (const c of cells) {
			assert.equal(c.attempts.length, 2, `${c.cell} should be re-run once on isolation-address`);
			assert.equal(c.valid, false);
			for (const a of c.attempts) {
				assert.equal(a.validity.valid, false);
				if (!a.validity.valid) {
					assert.equal(a.validity.cause, "isolation", JSON.stringify(a));
					assert.match(a.validity.detail, /example\.invalid\/almanac/);
				}
			}
		}
		assert.equal(result.excluded.length, 2);
		assert.ok(result.excluded.every((e) => e.cause === "isolation"));
	}

	// 2. isolation-path-open: tool call touching forbidden path with open filesystem wrapper -> classified isolation, re-run once (2 attempts), excluded.
	{
		const { cells, result } = await runInjectedMode("isolation-path-open", { openFilesystem: true });
		assert.equal(cells.length, 2);
		for (const c of cells) {
			assert.equal(c.attempts.length, 2);
			assert.equal(c.valid, false);
			for (const a of c.attempts) {
				assert.equal(a.validity.valid, false);
				if (!a.validity.valid) {
					assert.equal(a.validity.cause, "isolation");
					assert.match(a.validity.detail, /orchard-private/);
				}
			}
		}
		assert.equal(result.excluded.length, 2);
		assert.ok(result.excluded.every((e) => e.cause === "isolation"));
	}

	// 3. isolation-path-sandboxed (0015): tool call naming forbidden path on sandboxed adapter -> valid on attempt 1, not re-run, path in unreachable.
	{
		const { cells, result } = await runInjectedMode("isolation-path-sandboxed");
		assert.equal(cells.length, 2);
		for (const c of cells) {
			assert.equal(c.attempts.length, 1, "sandboxed forbidden path must not re-run");
			assert.equal(c.valid, true);
			assert.deepEqual(c.attempts[0]!.unreachable, [FORBIDDEN_PATH]);
		}
		assert.equal(result.excluded.length, 0);
		assert.equal(result.unreachable.length, 2);
	}

	// 4. infra-filter: content filter -> classified infrastructure, re-run once (2 attempts), excluded.
	{
		const { cells, result } = await runInjectedMode("infra-filter");
		for (const c of cells) {
			assert.equal(c.attempts.length, 2);
			assert.equal(c.valid, false);
			for (const a of c.attempts) {
				assert.equal(a.validity.valid, false);
				if (!a.validity.valid) {
					assert.equal(a.validity.cause, "infrastructure");
					assert.match(a.validity.detail, /filter/);
				}
			}
		}
		assert.ok(result.excluded.every((e) => e.cause === "infrastructure"));
	}

	// 5. infra-provider-503: provider 503 error -> classified infrastructure, re-run once (2 attempts), excluded.
	{
		const { cells, result } = await runInjectedMode("infra-provider-503");
		for (const c of cells) {
			assert.equal(c.attempts.length, 2);
			assert.equal(c.valid, false);
			for (const a of c.attempts) {
				assert.equal(a.validity.valid, false);
				if (!a.validity.valid) {
					assert.equal(a.validity.cause, "infrastructure");
					assert.match(a.validity.detail, /provider failed/);
				}
			}
		}
		assert.ok(result.excluded.every((e) => e.cause === "infrastructure"));
	}

	// 6. infra-crash: non-zero exit code -> classified infrastructure, re-run once (2 attempts), excluded.
	{
		const { cells, result } = await runInjectedMode("infra-crash");
		for (const c of cells) {
			assert.equal(c.attempts.length, 2);
			assert.equal(c.valid, false);
			for (const a of c.attempts) {
				assert.equal(a.validity.valid, false);
				if (!a.validity.valid) {
					assert.equal(a.validity.cause, "infrastructure");
					assert.match(a.validity.detail, /exited 2/);
				}
			}
		}
		assert.ok(result.excluded.every((e) => e.cause === "infrastructure"));
	}

	// 7. timeout-open-step-0012 (opencode) & Codex timeout-model / timeout-tool:
	//    - On opencode, attempt 1 with open step is infrastructure (re-run), attempt 2 is behaviour (scored 0, not excluded).
	{
		const { cells, result } = await runInjectedMode("timeout-open-step-0012", { runtimeFilter: "opencode", timeLimitSeconds: 1 });
		const ocCell = cells[0]!;
		assert.equal(ocCell.attempts.length, 2);
		assert.equal(ocCell.attempts[0]!.validity.valid === false && ocCell.attempts[0]!.validity.cause, "infrastructure");
		assert.equal(ocCell.attempts[1]!.validity.valid === false && ocCell.attempts[1]!.validity.cause, "behaviour");
		assert.equal(result.excluded.length, 0);
		assert.deepEqual(result.cellValues[ocCell.cell], { "graft-1": 0 });
	}
	//    - On Codex, timeout-model (open turn.started) is infrastructure (re-run once, 2 attempts, excluded);
	//      timeout-tool (open item.started) is behaviour (not re-run, 1 attempt, scored 0).
	{
		const { cells: modelCells, result: modelRes } = await runInjectedMode("timeout-model", { runtimeFilter: "codex", timeLimitSeconds: 1 });
		assert.equal(modelCells[0]!.attempts.length, 2);
		assert.ok(modelCells[0]!.attempts.every((a) => !a.validity.valid && a.validity.cause === "infrastructure"));
		assert.equal(modelRes.excluded.length, 1);

		const { cells: toolCells, result: toolRes } = await runInjectedMode("timeout-tool", { runtimeFilter: "codex", timeLimitSeconds: 1 });
		assert.equal(toolCells[0]!.attempts.length, 1);
		assert.equal(toolCells[0]!.attempts[0]!.validity.valid === false && toolCells[0]!.attempts[0]!.validity.cause, "behaviour");
		assert.deepEqual(toolRes.cellValues[toolCells[0]!.cell], { "graft-1": 0 });
	}

	// 8. behaviour-overflow: context window overflow -> behaviour, NOT re-run (1 attempt), scored 0.
	{
		const { cells, result } = await runInjectedMode("behaviour-overflow");
		for (const c of cells) {
			assert.equal(c.attempts.length, 1, `${c.cell} must not re-run on behaviour-overflow`);
			assert.equal(c.valid, false);
			assert.equal(c.attempts[0]!.validity.valid === false && c.attempts[0]!.validity.cause, "behaviour");
			assert.deepEqual(result.cellValues[c.cell], { "graft-1": 0 });
		}
		assert.equal(result.excluded.length, 0);
	}

	// 9. behaviour-empty: exit 0 with empty final message -> behaviour, NOT re-run (1 attempt), scored 0.
	{
		const { cells, result } = await runInjectedMode("behaviour-empty");
		for (const c of cells) {
			assert.equal(c.attempts.length, 1, `${c.cell} must not re-run on behaviour-empty`);
			assert.equal(c.valid, false);
			assert.equal(c.attempts[0]!.validity.valid === false && c.attempts[0]!.validity.cause, "behaviour");
			assert.deepEqual(result.cellValues[c.cell], { "graft-1": 0 });
		}
		assert.equal(result.excluded.length, 0);
	}
});
