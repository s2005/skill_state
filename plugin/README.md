# skill-state

SKILL.state ([arXiv:2608.26263](https://arxiv.org/abs/2608.26263)) for Claude Code: an explicit, validated execution state that replaces append-only conversation history for long-horizon skills. It is a Claude Code function-hook plugin and needs a Claude Code build with function hooks.

While the runtime is active:

- the model keeps its state through the `skill_state_update` tool, validated against the domain's JSON schema;
- every tool call outside the domain's exempt list must first be bound by a state update naming that exact call;
- at the end of each turn the conversation is replaced by a frame (objective, procedure, current state, step) followed by the last few turns.

## Commands

| Command | What it does |
| ------- | ------------ |
| `/skill-state start <domain\|path>` | Starts a runtime from a bundled domain (`software`, `ctf`) or a domain config file. The next prompt becomes the objective. |
| `/skill-state new <name>` | Builds a domain config from six questions and writes it to `domains/<name>.json` in this plugin folder. |
| `/skill-state status` | Shows the domain, objective, step, pending action, state size and token usage. |
| `/skill-state stop` / `resume` | Turns gating and compaction off or back on, keeping the state. |
| `/skill-state reset` | Returns to the initial state at step 0. |

## What the plugin runs, reads and writes

- Runs only the TypeScript hooks module `hooks/register.ts` and the dependency-free code in `lib/`, inside Claude Code. It starts no processes and installs no packages.
- Makes no network requests and sends no data anywhere.
- Reads domain config files: the bundled ones in `domains/`, or a path you pass to `/skill-state start`.
- Writes `domains/<name>.json` only when you confirm it in `/skill-state new`.
- Keeps the runtime record in the session's plugin state and in the plugin store, keyed by session id.
- Registers one tool, `skill_state_update`, and one command, `/skill-state`; denies non-exempt tool calls that were not bound by a state update; and compacts the main conversation to the frame at each turn end in interactive sessions. Subagents are not affected.

Full documentation, domain config reference and development notes: <https://github.com/s2005/skill_state>.

## License

MIT, see [LICENSE](LICENSE).
