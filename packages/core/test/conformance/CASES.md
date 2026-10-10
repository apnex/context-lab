# Runtime adapter conformance - the cases

Delta-1 stage 3 builds three runtime adapters - opencode, Codex, and the external adapter - and criterion E6 requires each to pass every case below.\
By the delta's build order these cases are accepted by the verifier before any adapter is written against them.\
Status: revision 2, after the verifier's first review; for acceptance.

---

## Where a driven runtime runs

Each driven adapter runs its runtime inside a filesystem sandbox: bubblewrap, with the network shared so the runtime can reach its model provider, and every other namespace unshared.\
Visible inside are the system directories read-only, the runtime's own installation read-only, the files that resolve names and verify certificates, the workspace read-write, the invocation's own configuration folder read-write, and the arm's on-request folders read-only - nothing else, and a fresh empty home.\
So a path the arm does not give the agent does not exist for it, whatever the runtime's own sandbox allows.\
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
| `stop.inFlight` | `model`, `tool`, `none` | What was open when it ended: a model call begun and not finished, a tool call begun and not finished, or nothing |
| `cost.seconds` | number | Wall time of the invocation |
| `cost.inputTokens` | number or null | All input tokens, cached or not; null if the runtime reports none |
| `cost.cachedInputTokens` | number or null | The part of input read from cache |
| `cost.outputTokens` | number or null | Output tokens, reasoning included |
| `cost.toolCalls` | number | Tool calls the agent made, whatever their status |
| `tools` | list | One entry per tool call: `name`; `input` as given; `status` - `completed`, `error`, `declined` or `running`; `paths` - every absolute path in the input, `~/` expanded, and every relative path containing `..` resolved against the workspace; `addresses` - every `http(s)` address in the input |
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
| command | `opencode run --format json -m <model>`, and the prompt as its own final argument, after any `--file` options | `codex exec --json --ephemeral --skip-git-repo-check --strict-config --ignore-user-config --ignore-rules -m <model> -C <workspace>`, and the prompt as its final argument, or `-` |
| configuration | a fresh folder per invocation, named by `XDG_CONFIG_HOME`, holding only the operator's provider block, `plugin: []`, the permissions below and the arm's instruction files; fresh data, state and cache folders by `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, the cache seeded from the operator's opencode cache, which holds only provider packages | a fresh folder per invocation, named by `CODEX_HOME`, holding only a copy of the operator's login and a `config.toml` with the arm's instructions in `developer_instructions` |
| permissions with tools on | `edit`, `bash`, `read` allowed; `webfetch`, `websearch`, `task` denied; `external_directory` allowed for the arm's on-request folders only, denied otherwise | sandbox `workspace-write`, its network off; `web_search` disabled; approval `never` |
| tools off | every tool disabled and every permission denied | sandbox `read-only`, `web_search` disabled, and the filesystem sandbox holding an empty workspace - the shell remains, and sees nothing but the system |
| environment | an allowlist: `PATH`, `PWD` (the workspace), the `XDG_*` folders above, `HOME` (the sandbox's empty home), `OPENCODE_DISABLE_CLAUDE_CODE=1`, and the provider credential variables the provider block names | an allowlist: `PATH`, `PWD`, `HOME`, `CODEX_HOME` |

**Stated additions.**\
Codex installs its bundled skills into a fresh `CODEX_HOME` on first run; they are the same in every arm, control included, and are a stated part of every Codex agent's context.

---

## How the cases are run

No case calls a model.\
Each runs the adapter against a **stub runtime**: an executable placed first on the `PATH`, named as the runtime, that records its arguments, environment, standard input and the files in its configuration folder, then replays an event stream.\
Each stream is either a copy of a real stream from an earlier run, named in the case, or a **synthetic** stream for a shape no run has recorded, marked synthetic in its file name.\
Beside each stream, a file states the exact outcome the adapter must return for it - every field above - written from the stream by hand and accepted by the verifier with these cases.\
Each case passes only if the adapter's outcome equals that file.

A stub cannot show that a runtime honours what the adapter wrote.\
So stage 3 also runs, once per runtime version, a live check per configuration claim: instructions arrive; on-request folders are readable and nothing else is; `webfetch` and `websearch` are refused on opencode; web search is absent on Codex; tools off leaves nothing to read.

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
| C11 | **Isolation of the invocation** | The stub's environment holds exactly the allowlist; its configuration folder holds exactly what the invocation table states and is new for this invocation; `HOME` is empty; and inside the sandbox the stub cannot see the operator's home, `/home/apnex/taceng`, or a file placed beside the workspace |
| C12 | **Network** | Codex: sandbox network off and `web_search` disabled in the configuration; opencode: `webfetch` and `websearch` denied, and the adapter declares network as detected, not denied |
| C13 | **Tools off** | opencode: every tool disabled and every permission denied; Codex: `read-only`, `web_search` disabled, and the sandbox's workspace empty |
| C14 | **Timeout** | A stub that starts one child in its own process group and one with `setsid`, then never exits, is stopped at the time limit: `stop.reason` `timeout`, and the stub and both children are gone within two seconds of the limit |
| C15 | **Refusing a setting** | Before anything runs, the adapter refuses, naming it: opencode, a `reasoningEffort` not among the model's `variants` in the provider block; Codex, a `reasoningEffort` other than `minimal`, `low`, `medium`, `high`; external, any setting |
| C16 | **Session** | The session id in the stream is returned in `session`; continuation itself is probed at board item M2.1 |
| C17 | **What was in flight** | For a synthetic stream ending after a model call began, `stop.inFlight` is `model`; after a tool call began, `tool`; after both ended, `none` |
| C18 | **Trace** | The trace holds one normalised event per runtime event the mapping names, in arrival order, each with an `at` that never decreases |

---

## What these cases do not show

- That a runtime's real behaviour matches a replayed stream: a new runtime version can change its events, and a stream recorded from it should be added when it does.
- Codex's content-filter and overflow signals, and opencode's overflow signal, which no run has recorded; their synthetic streams state a belief about their shape, not a measurement.
- That the network is closed to opencode agents: they share the host's network to reach their provider, and an attempt to fetch is detected, not prevented.
