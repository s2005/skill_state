# skill-state

SKILL.state ([arXiv:2608.26263](https://arxiv.org/abs/2608.26263)) for Claude Code: an explicit, validated execution state that replaces append-only conversation history for long-horizon skills, implemented as a Claude Code function-hook plugin.

While the runtime is active:

- the model keeps its state through the `skill_state_update` tool, validated against the domain's schema;
- every tool call outside the domain's exempt list must first be bound by a state update naming that exact call, and each update permits one call;
- at the end of each turn the conversation is replaced by a frame (objective, procedure, current state, step) followed by the last `windowTurns` turns.

## Requirements

- Node.js 22 or later (development only)
- Claude Code with function hooks; tested with engine **2.1.283**

## Install

Install from this repository's marketplace:

```bash
claude plugin marketplace add s2005/skill_state
claude plugin install skill-state@skill-state
```

Or load the plugin folder from a clone for one session:

```bash
claude --plugin-dir plugin
```

To load it where no flag can be given (the desktop app, an SDK host), name the absolute path of `plugin/` in `CLAUDE_CODE_PLUGIN_DIRS`. In a headless `claude -p` run, set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Commands

| Command | What it does |
| ------- | ------------ |
| `/skill-state start <domain\|path>` | Loads a bundled domain by name (`software`, `ctf`) or a config file by path (anything with a slash, a backslash or a `.json` suffix), and starts a fresh runtime at step 0. The next prompt you type becomes the objective. |
| `/skill-state new <name>` | Asks six questions in Claude Code's question dialog, builds a domain config from the answers, shows it for review and writes it to `plugin/domains/<name>.json`, then offers to start it. See [Creating a domain](#creating-a-domain). Interactive sessions only. |
| `/skill-state status` | Shows the domain, objective, step, pending action, state size in characters, the last frame size, the last compaction outcome, and the input, output and cache-read tokens summed from each turn since `start`. |
| `/skill-state stop` | Turns gating and compaction off; the state, step and objective are kept. |
| `/skill-state resume` | Turns gating and compaction back on for the kept runtime. |
| `/skill-state reset` | Returns to the initial state at step 0 and clears the objective and pending action; the next prompt becomes the new objective. Usage sums are kept. |

While active, the status line shows `skill-state: <domain> step <n>`.

The runtime applies to the main conversation only; subagent tool calls, turns and compactions pass through untouched. It is kept in the session's plugin state and mirrored to the plugin store under the session id, so it survives a plugin reload and a resumed session.

## The state tool

The model sees the tool as `mcp__skill-state__skill_state_update`, with input:

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `patch` | yes | Merged into the state: objects merge recursively, arrays and scalars replace, `null` deletes a key. Keys `__proto__`, `constructor` and `prototype` are rejected. |
| `action` | no | `{ tool, input }`: the next non-exempt tool call, exactly as it will be made. A `functions.` prefix on `tool` is dropped. |

The complete post-patch state is validated against the schema and `maxStateChars`. A rejected patch leaves the state unchanged and returns every error. An accepted patch advances the step and stores `action` as the pending action.

A non-exempt tool call runs only when its tool name and input equal the pending action (deep JSON equality). The pending action is cleared once that call has run, whether it succeeded or failed; any other call is denied with the exact state-tool call to make instead.

## Domain config

A domain config is a JSON file:

| Field | Required | Default | Meaning |
| ----- | -------- | ------- | ------- |
| `name` | yes | - | Domain name shown in `status` and the status line. |
| `instructions` | yes | - | The procedure `P`, repeated in every frame. |
| `schema` | yes | - | JSON Schema for the state, restricted to the keywords `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `maxLength`, `maxItems`. Any other keyword rejects the config, naming the keyword and its schema path. |
| `initialState` | yes | - | The state at step 0; must satisfy `schema` and `maxStateChars`. |
| `exemptTools` | no | `[]` | Tools that run without a state update. The state tool and `ToolSearch` are always exempt: Claude Code may defer the state tool's schema, and `ToolSearch` is how the model loads it. |
| `windowTurns` | no | `1` | Turns kept verbatim after the frame; `0` keeps only the frame (the paper's form). |
| `maxStateChars` | no | `100000` | Ceiling on the state's JSON length in characters. |
| `maxObservationChars` | no | unset | When set, every string in a tool's result longer than this is cut to it and followed by `[Observation truncated: N characters omitted]`. The ceiling applies per string field so the result keeps the shape its tool declares; unset, results pass unchanged. |
| `description`, `version` | no | - | Free-form; ignored by the runtime. |

Any other top-level field rejects the config.

### Bundled domains

| Domain | State fields | Exempt tools | `windowTurns` | `maxStateChars` | `maxObservationChars` |
| ------ | ------------ | ------------ | ------------- | --------------- | --------------------- |
| `software` | `plan`, `facts`, `modified_files`, `dead_ends`, `next_action` | Read, Grep, Glob | 1 | 100000 | unset |
| `ctf` | `discovered_flags`, `tested_hypotheses`, `active_files`, `working_dir`, `cmd_summary` (the paper's InterCode CTF schema) | Read, Grep, Glob | 0 | 50000 | 20000 |

### Creating a domain

`/skill-state new <name>` writes a bundled domain without hand-editing JSON. `<name>` must match `^[a-z][a-z0-9_-]{0,39}$`; `software` and `ctf` are reserved. Each question lists its recommended option first; free text goes under "Other".

| Step | Question | Options | Sets |
| ---- | -------- | ------- | ---- |
| 1 | Template | Coding task (Recommended), Investigation, Operations runbook, Minimal | State fields, procedure, `maxStateChars` |
| 2 | Extra fields | None (Recommended), `notes:list`, or typed `name:type` pairs separated by commas | Added state fields |
| 3 | Procedure | Template procedure (Recommended), Short generic procedure, or typed text | `instructions` |
| 4 | Turns kept after the frame | 1 (Recommended), 0 (frame only), 2 | `windowTurns` |
| 5 | Exempt tools | Read, Grep, Glob (Recommended), Read only, None | `exemptTools` |
| 6 | Tool result ceiling | Unset (Recommended), 20000, 8000 | `maxObservationChars` |

Every procedure is followed by the standard protocol paragraph: update the state before each non-exempt call, bind the exact next action, and record every fact needed later. A typed answer at steps 1, 4, 5 and 6 matches an option by its first word (`coding`, `0`, `read`, `20000`). An answer that does not parse or match is asked once more; a second miss, or dismissing any dialog, cancels without writing anything.

The complete config is then printed to the transcript and `Write domain <name>?` asks for confirmation. If the file already exists, it is kept unless you choose Overwrite. Last, `Start <name> now?` either starts the runtime as `/skill-state start <name>` would, or prints that command.

Templates, every field required and no other fields allowed:

| Template | State fields | `maxStateChars` |
| -------- | ------------ | --------------- |
| Coding task | `plan` list, `facts` list, `modified_files` list, `dead_ends` list, `next_action` text | 100000 |
| Investigation | `question` text, `hypotheses` list, `evidence` list, `ruled_out` list, `sources` list, `next_action` text | 100000 |
| Operations runbook | `phase` text, `completed_steps` list, `environment` map, `incidents` list, `next_action` text | 50000 |
| Minimal | `facts` list, `next_action` text | 20000 |

Field types, for template and extra fields alike. An extra field name must match `^[a-z][a-z0-9_]{0,39}$` and must not repeat a template field:

| Type | Schema | Initial value |
| ---- | ------ | ------------- |
| `text` | `{ "type": "string", "maxLength": 2000 }` | `""` (`next_action`: `"Inspect the task and plan the first step."`) |
| `list` | `{ "type": "array", "items": { "type": "string" }, "maxItems": 200 }` | `[]` |
| `map` | `{ "type": "object", "additionalProperties": { "type": "string" } }` | `{}` |
| `flag` | `{ "type": "boolean" }` | `false` |
| `number` | `{ "type": "number" }` | `0` |

The file lives in the plugin folder next to `software.json` and `ctf.json`, so `/skill-state start <name>` finds it by name. A plugin update or reinstall may replace that folder; keep a copy of any domain you want to keep. If the plugin folder is not writable, the write fails and the helper reports the path.

## Limits

- Compaction runs only in interactive sessions. Claude Code 2.1.283 refuses `$.session.compact()` in headless (`-p` / SDK) sessions; there the plugin keeps the transcript, gating still applies, and `status` shows the refusal under `last compaction`.
- History still grows within one long turn; it is replaced at the turn's end.
- Compaction replaces the engine's own summary with the frame: context not recorded in the state or in the kept window is dropped by design.

## Development

```bash
npm install
npm run check        # lint + typecheck + unit tests
npm run test:plugin  # engine tests: claude plugin test plugin
npm run lint:md      # markdown lint
claude plugin validate plugin
```

`npm run typecheck` also checks `plugin/hooks` against the engine's own type declarations, which Claude Code writes into `plugin/.claude-plugin/types/` (git-ignored) the first time it loads the plugin. On a fresh clone, load it once before typechecking:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p --plugin-dir plugin "Reply OK"
```

Layout:

| Path | Contents |
| ---- | -------- |
| `.claude-plugin/marketplace.json` | Marketplace listing this repository's plugin |
| `plugin/.claude-plugin/plugin.json` | Manifest |
| `plugin/README.md` | Plugin description shown in the plugin directory |
| `plugin/hooks/register.ts` | Hooks module: command, state tool, gating, objective capture, usage, compaction |
| `plugin/hooks/register.test.ts` | Engine tests (`claude plugin test`) |
| `plugin/lib/` | Dependency-free core: schema subset, config, patch, gate, frame, observation, runtime record, domain builder for `new` |
| `plugin/domains/` | Bundled domain configs |
| `plugin/types/index.d.ts` | `$.state` contract |
| `test/` | Unit tests (vitest) for `plugin/lib` |

## Paper

The source paper is kept in [docs/](docs/): PDF and English Markdown.
