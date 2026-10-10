# Runtime adapter conformance - the cases

Delta-1 stage 3 builds three runtime adapters - opencode, Codex, and the external adapter - and criterion E6 requires each to pass every case below.\
By the delta's build order these cases are accepted by the verifier before any adapter is written against them.\
Status: proposed, for the verifier's acceptance.

---

## The common form

Every adapter, whatever its runtime, returns one `Outcome` per invocation:

| Field | Type | Meaning |
|---|---|---|
| `final` | string | The agent's final message: the text of the last message that carried text |
| `exit` | number or null | The runtime's exit status; null when killed |
| `signal` | string or null | The signal that ended it, if any |
| `timedOut` | boolean | True if the adapter stopped it at its time limit |
| `cost.seconds` | number | Wall time of the invocation |
| `cost.inputTokens` | number or null | All input tokens, cached or not; null if the runtime reports none |
| `cost.cachedInputTokens` | number or null | The part of input read from cache |
| `cost.outputTokens` | number or null | Output tokens, reasoning included |
| `cost.toolCalls` | number | Tool calls the agent made |
| `tools` | list | One entry per tool call: `name`, `input` as given, `paths` - every absolute path in the input - and `addresses` - every `http(s)` address in the input |
| `filtered` | boolean | True if the provider's content filter blocked a response |
| `error` | object or null | The first error the runtime reported: `kind` and `message` |
| `session` | string or null | The runtime's session id, for continuation where an adapter supports it |
| `events` | string | The path of the raw event stream, kept for diagnosis and never scored |

**How each runtime maps to it.**

| Field | opencode (`run --format json`) | Codex (`exec --json`) |
|---|---|---|
| `final` | `text` events, joined per `messageID`, last message | `item.completed` with `item.type` `agent_message`, last one; or the `-o` file |
| tokens | sum over `step_finish` `part.tokens`: input = `input` + `cache.write` + `cache.read`, cached = `cache.read`, output = `output` + `reasoning` | `turn.completed` `usage`: input = `input_tokens`, cached = `cached_input_tokens`, output = `output_tokens` + `reasoning_output_tokens` |
| tool calls | `tool_use` events: `part.tool`, `part.state.input` | `item.completed` with `item.type` `command_execution` (`command`) or `file_change` (`changes[].path`) |
| filter | an `error` event with `error.name` `ContentFilterError` | not yet observed (`B7`); the adapter reports `filtered: false` and records the error, and this is a stated limit |
| error | the first `error` event | the first `error` or `turn.failed` event |

---

## How the cases are run

No case calls a model.\
Each runs the adapter against a **stub runtime**: an executable placed first on the `PATH`, named as the runtime, that records the arguments, environment and standard input it was given and then replays a recorded event stream.\
The replayed streams are copies of real streams from earlier runs, named in each case, so parsing is tested against what the runtimes actually emit.\
A live check that each adapter reaches its model is the isolation prober's, not this suite's.

---

## The cases

Each case runs for each adapter unless it says otherwise.

| # | Case | Passes when |
|---|---|---|
| C1 | **Common form** | The outcome has every field above with its stated type, for a replayed successful stream |
| C2 | **Final message** | `final` equals the last message's text exactly, for a stream with several messages, including one whose text arrives in more than one part |
| C3 | **Cost** | Token fields equal the sums stated above for the replayed stream, computed by hand in the test; `toolCalls` equals the number of tool calls in it |
| C4 | **Tool paths and addresses** | `tools` lists every call, and its `paths` and `addresses` hold exactly the absolute paths and addresses in the call's input - including a path or address inside a shell command, and a `curl` of a raw file |
| C5 | **Content filter** | For opencode, a replayed stream ending in `ContentFilterError` gives `filtered: true`; for Codex, the stated limit holds - `filtered: false`, the error recorded |
| C6 | **Error** | A replayed stream with a provider error gives that error in `error`, and an outcome is still returned |
| C7 | **Rules files** | The adapter declares the rules-file names its runtime loads from the working folder and above: opencode `AGENTS.md` and `CLAUDE.md`; Codex `AGENTS.md` and `AGENTS.override.md`; external none |
| C8 | **Instructions delivered** | Given an arm with instruction files, the stub receives them where the runtime reads instructions: for opencode, listed in the `instructions` of the config file named by `XDG_CONFIG_HOME`; for Codex, their text in `developer_instructions` in the `config.toml` under `CODEX_HOME`; for external, written beside the prompt |
| C9 | **On-request delivery** | Given an arm with on-request folders, the runtime is told it may read them: for opencode, an `external_directory` permission allowing exactly those paths; for Codex, the paths named to the agent in its instructions, since its sandbox reads the whole disk; for external, listed beside the prompt |
| C10 | **Prompt delivery modes** | Each mode the adapter declares reaches the stub as declared: opencode - `inline` as an argument, `attachment` with `--file`; Codex - `inline` as an argument, `stdin` on standard input; external - `file-pointer`. A mode the adapter does not declare is refused before anything runs |
| C11 | **Isolation of the invocation** | The stub's recorded environment holds no variable beginning `OPENCODE`, `CODEX` or `CLAUDE` other than those the adapter sets; `PWD` is the workspace; the config folder the adapter made holds nothing of the operator's but the provider block (opencode) or the login file (Codex) |
| C12 | **Network** | For Codex, the invocation leaves the sandbox's network access off; for opencode, which cannot deny it, `webfetch` is denied in its config and the adapter declares network as detected, not denied |
| C13 | **Tools off** | Given tools off, opencode's config disables every tool and denies every permission, and Codex runs in its read-only sandbox |
| C14 | **Timeout** | A stub that never exits is stopped at the time limit: `timedOut` true, and the stub and any process it started are gone within two seconds of the limit |
| C15 | **Refusing a setting** | A setting the runtime cannot apply - for opencode a `reasoningEffort` not in its variant list; for external any setting - is refused before anything runs, naming the setting |
| C16 | **Session** | The session id in the stream is returned in `session`; continuation itself is probed at board item M2.1, not here |

---

## What these cases do not show

- That an adapter reaches its model: the isolation prober's live probes show that.
- That a runtime's real behaviour matches the replayed stream: a new runtime version can change its events, and a stream recorded from it should be added when it does.
- Codex's content-filter signal, which no run has recorded.
