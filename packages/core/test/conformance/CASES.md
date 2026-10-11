# Runtime adapter conformance - the cases

Delta-1 stage 3 builds three runtime adapters - opencode, Codex, and the external adapter - and criterion E6 requires each to pass every case below.\
By the delta's build order these cases are accepted by the verifier before any adapter is written against them.\
Status: revision 9 - continuation cases C20 to C25 added for Delta-2, accepted by the verifier after three reviews; adapters are built against them.\
Revision 6 status follows.\
Revision 4 was accepted by the verifier after three reviews.\
Changed since, each disclosed here and reviewed at stage 3's verification unless marked: the path rule, restated as the word rule both the adapters and the derivation follow, after they disagreed on a `sed` expression; the Codex `[features]` table, after a live check found a hosted connector reaching the web; and, after stage 3's verification, more features switched off, opencode's open step reported as `unknown`, and the login copy removed after each Codex invocation - not yet re-reviewed.

---

## Where a driven runtime runs

Each driven adapter runs its runtime inside a filesystem sandbox: bubblewrap, with the network shared so the runtime can reach its model provider, and every other namespace unshared.\
The mounts, in this order, because a later mount hides an earlier one beneath it:

1. `/usr` read-only, with `/lib64`, `/lib`, `/bin` and `/sbin` as links into it; `/proc`; `/dev`; a private, empty `/tmp`, so the host's sockets under `/tmp` - among them the operator's own Codex daemon - are out of reach.
2. From `/etc`, read-only and only these: `resolv.conf`, `hosts`, `nsswitch.conf`, `pki`, `ssl`, and `ca-certificates` where present.
3. An empty folder over `/home`, so nothing of any home is visible.
4. The runtime's installation, read-only: for opencode its binary; for Codex its vendored native directory, whose binary is run directly rather than through the Node wrapper.
5. The invocation's own folder read-write - configuration, data, state, and for opencode a cache copied fresh from the operator's opencode cache for this invocation - and the workspace read-write.
6. The arm's on-request folders, read-only, at their own paths.

So a path the arm does not give the agent does not exist for it, whatever the runtime's own sandbox allows.\
The network is shared: besides the provider, an agent can reach services listening on the host's loopback address and the host's abstract sockets.\
Probed before these cases, on this machine: Codex and opencode each ran inside it and completed a task; a Codex agent asked to read a file beside its workspace and to list `/home/apnex/taceng` got "No such file or directory" for both; an opencode agent saw only its own folder under `/home`.

---

## The common form

Every adapter, whatever its runtime, returns one `Outcome` per invocation:

| Field | Type | Meaning |
|---|---|---|
| `final` | string | The agent's final message: the text of the last message that carried text; `""` if none did |
| `exit` | number or null | The runtime's exit status; null when killed |
| `signal` | string or null | The signal that ended it, if any |
| `stop.reason` | `completed`, `timeout`, `error` | How the invocation ended |
| `stop.inFlight` | `model`, `tool`, `none`, `unknown` | What was open when it ended: a model call begun and not finished, a tool call begun and not finished, nothing, or - where the stream cannot say which - one or the other. opencode runs tools inside a step and reports a tool only when it ends, so an open opencode step is `unknown` |
| `cost.seconds` | number | Wall time of the invocation |
| `cost.inputTokens` | number or null | All input tokens, cached or not; null if the runtime reports none |
| `cost.cachedInputTokens` | number or null | The part of input read from cache |
| `cost.outputTokens` | number or null | Output tokens, reasoning included |
| `cost.toolCalls` | number | Tool calls the agent made, whatever their status |
| `tools` | list | One entry per tool call: `name`; `input` as given; `status` - `completed`, `error`, `declined` or `running`; `paths` - every word of the input's strings, split on whitespace, quotes and the characters `; | & < > ( ) \` , =` with addresses removed first, that begins with `/`, or with `~/` (expanded against the agent's home), or with `../` or holds `/../` (resolved against the workspace) - a rule that over-counts words inside quoted expressions, such as a `sed` substitution, and never misses a word that is a path; `addresses` - every `http(s)` address in the input |
| `filtered` | boolean | True if the provider's content filter blocked a response |
| `error` | object or null | The first error the runtime reported: `cause` - `filter`, `provider`, `overflow` or `unknown` - with the runtime's own `name` and `message` |
| `session` | string or null | The runtime's session id |
| `trace` | list | Every event in a normalised form - `at` (milliseconds since the invocation began, stamped by the adapter as the event arrived), `kind` (`model-start`, `model-end`, `text`, `tool-start`, `tool-end`, `error`) and the event's own fields - from which the validity classifier works without reading a runtime's own events |
| `events` | string | The path of the raw event stream, kept for diagnosis |

**How each runtime maps to it.**

| Field | opencode (`run --format json`) | Codex (`exec --json`) |
|---|---|---|
| `final` | `text` events, joined per `messageID`, last message | the last `item.completed` whose `item.type` is `agent_message` |
| tokens | sum over `step_finish` `part.tokens`: input = `input` + `cache.write` + `cache.read`; cached = `cache.read`; output = `output` + `reasoning` | sum over `turn.completed` `usage`: input = `input_tokens`, which already includes cached; cached = `cached_input_tokens`; output = `output_tokens`, which already includes reasoning |
| model calls | `step_start` begins one, `step_finish` ends it | `turn.started` begins one, `turn.completed` or `turn.failed` ends it |
| tool calls | `tool_use` events: `part.tool`, `part.state.input`, `part.state.status` | `item.started` and `item.completed` for `command_execution` (`command`), `file_change` (`changes[].path`), `web_search` (`action.url` as an address, the query kept), `mcp_tool_call` and `collab_tool_call`; an item started and never completed is `running` |
| not tools | - | `reasoning`, `todo_list` and `agent_message` items are neither tools nor, except `agent_message`, the final message |
| filter | an `error` event with `error.name` `ContentFilterError`, or a `step_finish` with `part.reason` `content-filter` | not yet observed (`B7`): the adapter sets `filtered` false and `error.cause` from the message text, and this is a stated limit |
| error | the first `error` event; `cause` from its name: `ContentFilterError` filter, `APIError` and `UnknownError` provider | the first `error` item, `error` event or `turn.failed`; only a message is carried, so `cause` is read from its text and `unknown` when it says nothing recognisable |
| overflow | recorded on neither runtime: `cause` is `overflow` only when an error's text says the context window was exceeded, a stated limit |

---

## Invocation

| | opencode | Codex |
|---|---|---|
| command | `opencode run --format json -m <model>`, and the prompt as its own final argument, after any `--file` options | `codex exec --json --skip-git-repo-check --strict-config --ignore-rules -m <model> -C <workspace>` (`--ephemeral` dropped by revision 7), and the prompt as its final argument, or `-`; its configuration is read, and checked strictly, from the fresh `CODEX_HOME`, which holds nothing of the operator's |
| configuration | a fresh folder per invocation, named by `XDG_CONFIG_HOME`, holding only the operator's provider block, `plugin: []`, the permissions below and the arm's instruction files; fresh data, state and cache folders by `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, the cache copied from the operator's opencode cache, which holds provider packages, the operator's plugin packages - not loaded, since `plugin` is empty, an inference - a search binary and a model list | a fresh folder per invocation, outside `/tmp`, named by `CODEX_HOME`, holding only a copy of the operator's login and a `config.toml` with the arm's instructions in `developer_instructions`, `web_search = "disabled"`, `project_doc_fallback_filenames = []`, and a `[features]` table switching off every hosted tool that reaches outside the sandbox or starts another agent - `apps`, `browser_annotation_api`, `browser_use`, `browser_use_external`, `browser_use_full_cdp_access`, `computer_use`, `daemon_auto_start`, `image_generation`, `in_app_browser`, `multi_agent`, `plugin_sharing`, `plugins`, `remote_plugin`, `skill_mcp_dependency_install`, `tool_suggest` - after a live check found Codex opening a web page through its apps connector with web search disabled |
| permissions with tools on | `edit`, `bash`, `read` allowed; `webfetch`, `websearch`, `task` denied; `external_directory` allowed for the arm's on-request folders only, denied otherwise | `sandbox_mode = "workspace-write"` in `config.toml`, its network off; `web_search` disabled; approval `never` |
| tools off | every tool disabled and every permission denied | `sandbox_mode = "read-only"` in `config.toml`, `web_search` disabled, and the filesystem sandbox holding an empty workspace - the shell remains, and sees the system, the invocation's own folder - its configuration and login - and the arm's on-request folders |
| environment | an allowlist: `PATH`, `PWD` (the workspace), the `XDG_*` folders above, `HOME` (the sandbox's empty home), `OPENCODE_DISABLE_CLAUDE_CODE=1`, and the provider credential variables the provider block names | an allowlist: `PATH`, `PWD`, `HOME`, `CODEX_HOME` |

**Stated additions and exposures.**\
Codex installs its bundled skills into a fresh `CODEX_HOME` on first run - among them `imagegen` and `skill-installer` - and its prompt still carries a multi-agent role block with `multi_agent` off; both are the same in every arm, control included, and are a stated part of every Codex agent's context.\
A Codex agent's shell can read its own configuration, the arm's instructions included, even with tools off; the isolation prober therefore counts an answer only if the agent made no tool call.\
After each Codex invocation the login copy and Codex's own databases are removed from its folder.\
An agent can read the credentials its runtime needs - the provider key in its environment, the login file in `CODEX_HOME` - so the adapter removes every known credential value from the raw events and the trace before writing either.\
Inside the sandbox there is no git identity, so a task asking the agent to commit would need one given to it.

---

## How the cases are run

No case calls a model.\
Each runs the adapter against a **stub runtime**: an executable placed first on the `PATH`, named as the runtime, that records its arguments, environment, standard input and the files in its configuration folder, then replays an event stream.\
Each stream is either a copy of a real stream from an earlier run, named in the case, or a **synthetic** stream for a shape no run has recorded, marked synthetic in its file name.\
Beside each stream, a file states the exact outcome the adapter must return for it - every field above - written from the stream by hand and accepted by the verifier with these cases.\
Each case passes only if the adapter's outcome equals that file in every field but three, which depend on the run and are constrained instead: `cost.seconds` is at least 0; each `trace[].at` is at least the one before; `events` names a file that exists.

A stub cannot show that a runtime honours what the adapter wrote.\
So stage 3 also runs, once per runtime version, a live check per configuration claim: instructions arrive; on-request folders are readable and nothing else is; `webfetch` and `websearch` are refused on opencode; web search is absent on Codex; a Codex agent's shell cannot reach the network; tools off leaves nothing to read.

---

## The cases

Each case runs for each adapter unless it says otherwise.

| # | Case | Passes when |
|---|---|---|
| C1 | **Common form** | For a real successful stream - opencode `adherence-03/A2.on-trigger.c.1`, Codex `adherence-03/A2.on-trigger.o.1` - the outcome equals its expected file in every field |
| C2 | **Final message** | For a synthetic stream with three messages, the last arriving in two text parts, `final` is the last message whole; for a stream with no text, `final` is `""` |
| C3 | **Cost** | For the C1 streams and for a synthetic Codex stream with two turns, the token fields and `toolCalls` equal the expected file |
| C4 | **Tool paths and addresses** | For a synthetic stream holding a read by absolute path, a `~/` path, a `../` path in a shell command, a `curl` of a raw file, a Codex `web_search` with a URL, and a call still running, `tools` equals the expected file - each call, its status, its paths and addresses |
| C5 | **Content filter** | opencode: the recorded stream `zorg isolation claude-opus-5-5.s15` gives `filtered` true and `error.cause` `filter`; Codex: a synthetic stream with a filter message gives the stated limit |
| C6 | **Error** | opencode: the recorded `adherence-03/A13.on-trigger.g.2` gives `error.cause` `provider`; Codex: a synthetic `turn.failed` gives its message; an overflow message on each gives `overflow` |
| C7 | **Rules files** | The adapter declares the rules files its runtime loads: opencode `AGENTS.md` and `CLAUDE.md`; Codex `AGENTS.md` and `AGENTS.override.md`, with `project_doc_fallback_filenames` set empty in its configuration; external none. These are the runtimes' documented names, an inference; a declared name is enough to refuse a workspace below one |
| C8 | **Instructions delivered** | For an arm with two instruction files, the stub's configuration holds them as the expected file states: opencode, their paths in `instructions` in that order; Codex, `developer_instructions` equal to each file's text, in order, each wrapped `<file name="NAME">` and `</file>`, joined by a blank line; external, each written beside the prompt |
| C9 | **On-request delivery** | For an arm with an on-request folder, it is bound read-only into the sandbox at its own path; opencode's `external_directory` allows exactly that path; no instruction text is added for it on either runtime; external lists it beside the prompt |
| C10 | **Prompt delivery modes** | opencode declares `inline` and `attachment`: inline puts the prompt as the final argument; attachment passes the file with `--file` and the prompt still as its own final argument. Codex declares `inline` and `stdin`: inline puts the prompt as the final argument and leaves standard input empty and closed; stdin passes `-` and the prompt on standard input. External declares `file-pointer`. An undeclared mode is refused before anything runs |
| C11 | **Isolation of the invocation** | The stub - a POSIX `sh` script, since Node is not under `/usr` - records that its environment holds exactly the allowlist; its configuration folder holds exactly what the invocation table states - and, for a continuing invocation, the session store copied as C21 states - and is new for this invocation; and, inside the sandbox, three sentinel files are absent - one placed in the operator's real home, one in the folder above the workspace, one beside the workspace - while the workspace and each on-request folder are present |
| C12 | **Network** | Codex: sandbox network off and `web_search` disabled in the configuration; opencode: `webfetch` and `websearch` denied, and the adapter declares network as detected, not denied |
| C13 | **Tools off** | opencode: every tool disabled and every permission denied; Codex: `read-only`, `web_search` disabled, and the sandbox's workspace empty |
| C14 | **Timeout** | A stub that starts one child in its own process group and one with `setsid`, then never exits, is stopped at the time limit: `stop.reason` `timeout`, and the stub and both children are gone within two seconds of the limit |
| C15 | **Refusing a setting** | Before anything runs, the adapter refuses, naming it: opencode, a `reasoningEffort` not among the model's `variants` in the provider block - today every model's list is empty, so every effort is refused; Codex, a `reasoningEffort` not among the efforts Codex's own model metadata lists for that model; external, any setting |
| C16 | **Session** | The session id in the stream is returned in `session`; continuation itself is probed at board item M2.1 |
| C17 | **What was in flight** | For a synthetic stream ending after a model call began, `stop.inFlight` is `model` for Codex and `unknown` for opencode; for Codex, after a tool call began, `tool`; after both ended, `none` |
| C18 | **Trace** | The trace holds one normalised event per runtime event the mapping names, in arrival order, each with an `at` that never decreases |
| C19 | **Credentials removed** | For a synthetic stream in which a tool's output prints the provider key, neither the raw events written nor the trace contain the key |

---

## Continuation - cases added for Delta-2

Added by Delta-2 stage 1, after the live probes recorded in `docs/probes/2026-10-11-sessions.json`, for the verifier's acceptance before any adapter changes.

**What the probes showed.**\
Both runtimes resumed a session from a copy of its store, inside the filesystem sandbox, in the same git workspace, opencode with tools off and Codex read-only, each with no tool call, and returned the token given only in the first invocation; an invocation with its own empty store and another workspace, asked to resume the same session, failed - opencode "Session not found", Codex "no rollout found for thread id"; opencode's session list from that folder did not show the session, and Codex's `exec resume --last` ran without recalling the token.\
A resume from another workspace was not tried, so a continuing invocation runs in the workspace of the invocation it continues.\
Both compacted a session on demand - opencode through its server's `POST /session/<id>/summarize`, Codex through its app-server's `thread/compact/start`, its compaction identified by an item naming compaction.\
After compaction, asked for an instruction file's canary not quoted before: opencode quoted it when the file was delivered again and not when it was not, so its instructions come from each invocation's configuration; Codex quoted it with the file not delivered again, so its session carries its instructions, and declined to quote "internal instructions" once when the file was delivered again.\
One sample each.

**The design that follows.**\
An invocation may carry `continueFrom: { session, work, workspace }`: an earlier invocation's session id, its folder, and its workspace.\
The adapter copies the earlier session store - opencode's `data` folder, Codex's `codex-home/sessions` - into the new invocation's own folder and resumes, in the same workspace; the earlier folder is never mounted.\
The run conductor runs at most one invocation continuing from any earlier invocation, only within the same episode attempt, and a branch point holds at most one continuing branch.

| | opencode | Codex |
|---|---|---|
| resume | `opencode run --format json -m <model> -s <session> -- <prompt>` | `codex exec resume --json --skip-git-repo-check --strict-config --ignore-rules -m <model> <session> <prompt>` |
| session store | `<work>/data` | the files under `<work>/codex-home/sessions` |
| persistence | the `data` folder is kept after every invocation, as now | no invocation passes `--ephemeral`, so every session can be resumed; the sandbox mode is set by `sandbox_mode` in `config.toml`, since `exec resume` takes no `--sandbox` |

**Declared capabilities.**\
Each adapter declares `continue` and `compaction: { onDemand, instructionsAfterCompaction }`. opencode: `continue: true`, `onDemand: true`, `instructionsAfterCompaction: "when delivered again"`.\
Codex: `continue: true`, `onDemand: true`, `instructionsAfterCompaction: "carried by the session"`.\
External: `continue: false`, `onDemand: false`, `instructionsAfterCompaction: "unknown"`.\
Each value rests on one probe and is re-measured with each runtime version.

**Amendments to the accepted cases.**\
The Codex row of the Invocation table drops `--ephemeral` and `--sandbox`, and its configuration gains `sandbox_mode`; C12 and C13 read the sandbox mode from `config.toml`, not the argument list; C16's deferral to M2.1 is answered by C20 to C25.\
Delta-1 stage 3's live configuration checks are re-run under this configuration before the Codex adapter is accepted.

| # | Case | Passes when |
|---|---|---|
| C20 | **Capabilities declared** | Each adapter declares `continue` and `compaction` as stated above |
| C21 | **Resume delivered** | Given `continueFrom: { session, work, workspace }` and an invocation whose workspace equals `workspace`: the stub's argv is exactly the resume command above with the given session id and the prompt as its final argument; the stub's working directory is the workspace; before the stub runs, the new folder's session store is byte for byte the earlier folder's; for Codex, `codex-home/auth.json` is a fresh copy of the operator's login and is absent after the invocation; every file name and content under the earlier folder is the same after the invocation as before it |
| C22 | **No ephemeral Codex session** | No Codex invocation, first or continuing, passes `--ephemeral` or `--sandbox`; its `config.toml` sets `sandbox_mode = "workspace-write"` when tools are on and `sandbox_mode = "read-only"` when tools are off; and the re-run live checks pass: a Codex agent writes only its workspace, cannot reach the network, and with tools off finds nothing to read |
| C23 | **Continuation refused** | Before anything runs - the stub never started - the adapter refuses, naming the reason: a continuing invocation on an adapter declaring `continue: false`; a continuing invocation with tools off; a `continueFrom.work` with no `data` folder (opencode), or with no file under `codex-home/sessions` whose name holds the session id (Codex); a `continueFrom.workspace` different from the invocation's workspace; a continuing invocation in a delivery mode no probe resumed in - opencode `attachment`, Codex `stdin` |
| C24 | **Earlier folder unseen** | Inside the sandbox of a continuing invocation, a sentinel file placed in the earlier invocation's folder is absent, and the copied store is present |
| C25 | **Kept stores** | After every invocation, first or continuing, no `auth.json` remains in the invocation folder, and the copied store holds none; no file under a run's records folder is a copy of, or written from, a session store |

**Stated exposure.**\
Codex keeps every invocation's transcript under `codex-home/sessions`, and opencode under `data`.\
Neither is scrubbed of credentials an agent printed, since rewriting opencode's database would corrupt it; both stay in the working folder, outside run records.

---

## What these cases do not show

- That a runtime's real behaviour matches a replayed stream: a new runtime version can change its events, and a stream recorded from it should be added when it does.
- Codex's content-filter and overflow signals, and opencode's overflow signal, which no run has recorded; their synthetic streams state a belief about their shape, not a measurement.
- That the network is closed to opencode agents: they share the host's network to reach their provider, and an attempt to fetch is detected, not prevented.
