import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import {
  buildDomainConfig,
  CEILING_OPTIONS,
  EXEMPT_OPTIONS,
  EXTRA_FIELD_OPTIONS,
  OVERWRITE_OPTIONS,
  PROCEDURE_OPTIONS,
  REVIEW_OPTIONS,
  START_OPTIONS,
  TEMPLATE_OPTIONS,
  TEMPLATES,
  WINDOW_OPTIONS,
} from '../lib/wizard.ts'

// Engine tests for the skill-state hooks: the test's own hooks stand in for
// the engine beneath the plugin (fs, store, session id, registrations).

const STATE_TOOL = 'mcp__skill-state__skill_state_update'

// A small domain config served for any path ending in /domains/mini.json or mini.json.
const MINI = {
  name: 'mini',
  instructions: 'Record facts, bind every mutating call.',
  schema: {
    type: 'object',
    properties: {
      facts: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      next_action: { type: 'string' },
    },
    required: ['facts', 'next_action'],
    additionalProperties: false,
  },
  initialState: { facts: [], next_action: 'look' },
  exemptTools: ['Read'],
  windowTurns: 1,
  maxStateChars: 1000,
}

type Recorded = {
  statuses: (string | undefined)[]
  reads: string[]
  written: Record<string, string>
  logs: string[]
}

// Options controlling the `new`-flow stand-ins: which surfaces the session
// draws on (empty means headless) and which paths `fs.stat` finds already
// there (matched by suffix, as `fs.read`'s `files` are).
type EngineOptions = { surfaces?: readonly RenderSurface[]; existing?: readonly string[] }

// Installs the engine stand-ins every test needs and returns what they record.
function engine(
  on: On,
  files: Record<string, string> = {},
  store: Record<string, unknown> = {},
  options: EngineOptions = {},
): Recorded {
  const recorded: Recorded = { statuses: [], reads: [], written: {}, logs: [] }
  mock.store(on, store)
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__skill-state__${e.name}` } }))
  on('ui.status', (_$, e) => {
    recorded.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    recorded.logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  on('fs.read', (_$, e) => {
    const path = e.path.replaceAll('\\', '/')
    recorded.reads.push(path)
    const writtenKey = Object.keys(recorded.written).find(k => k === path)
    if (writtenKey !== undefined) {
      return { value: recorded.written[writtenKey] ?? '' }
    }
    const hit = Object.keys(files).find(name => path.endsWith(name))
    if (hit === undefined) {
      return { deny: `ENOENT ${e.path}` }
    }
    return { value: files[hit] ?? '' }
  })
  on('fs.write', (_$, e) => {
    recorded.written[e.path.replaceAll('\\', '/')] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    const path = e.path.replaceAll('\\', '/')
    const exists = path in recorded.written || (options.existing ?? []).some(name => path.endsWith(name))
    if (!exists) {
      return { deny: `ENOENT ${e.path}` }
    }
    return { value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context ?? [] }))
  on('turn.complete', (_$, e) => (e.usage === undefined ? { text: e.answer } : { text: e.answer, usage: e.usage }))
  return recorded
}

const FILES = { 'mini.json': JSON.stringify(MINI) }

// Runs `/skill-state <args>` as the person typing it would, returning its text.
async function run($: Engine, args: string): Promise<string> {
  const r = await $.command.run({ command: 'skill-state', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return r.text ?? ''
}

// Submits a prompt as the person typing it would.
function prompt($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

// One AskUserQuestion dialog as `newDomain` asked it: its question, header
// and option labels, recommended-first order included.
type AskedQuestion = { question: string; header: string | undefined; options: string[] }

// Answers `$.ui.ask` through a bottom `tool.call` hook of tool
// `AskUserQuestion`, as the engine raises it: `e.questions[0]` carries the
// question, header and options (each `{ label, description }`); `$.ui.ask`
// resolves an answer from `result.answers[question]`, keyed by the question
// text verbatim. A scripted `null` denies the call, which is how a dismissed
// dialog reaches the plugin as a rejection. Every call is recorded in order,
// whether or not the script has an answer left for it. `queue` is mutable so
// a second run in the same test can script more answers, since a hook can
// only be registered once, before the test's first call on `$`.
function scriptAsk(
  on: On,
  answers: ReadonlyArray<string | null | undefined>,
): { asked: AskedQuestion[]; queue: Array<string | null | undefined> } {
  const asked: AskedQuestion[] = []
  const queue: Array<string | null | undefined> = [...answers]
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as {
      questions: ReadonlyArray<{ question: string; header?: string; options: ReadonlyArray<{ label: string }> }>
    }).questions[0]
    if (question === undefined) {
      return { deny: 'no question' }
    }
    asked.push({ question: question.question, header: question.header, options: question.options.map(o => o.label) })
    const answer = queue.length > 0 ? queue.shift() : null
    if (answer === null || answer === undefined) {
      return { deny: 'dismissed' }
    }
    return { result: { answers: { [question.question]: answer } } }
  })
  return { asked, queue }
}

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, model: 'm' }

test('status before start says not started', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  const r = await run($, 'status')
  expect(r).toContain('Not started')
})

test('unknown and missing subcommands print usage', async ($, on) => {
  engine(on)
  expect((await run($, ''))).toContain('Usage: /skill-state')
  expect((await run($, 'bogus'))).toContain('Unknown subcommand "bogus"')
})

test('start by path loads the config and shows domain and step', async ($, on) => {
  const rec = engine(on, FILES)
  const r = await run($, 'start ./cfg/mini.json')
  expect(r).toContain('Started domain mini')
  expect(rec.reads).toHaveLength(1)
  expect(rec.reads[0]).toMatch(/\/cfg\/mini\.json$/)
  const s = await run($, 'status')
  expect(s).toContain('domain: mini')
  expect(s).toContain('step: 0')
  expect(rec.statuses.at(-1)).toBe('skill-state: mini step 0')
})

test('start by bundled name reads plugin domains folder', async ($, on) => {
  const rec = engine(on, { '/domains/mini.json': JSON.stringify(MINI) })
  const r = await run($, 'start mini')
  expect(r).toContain('Started domain mini')
  expect(rec.reads[0]).toMatch(/\/plugin\/domains\/mini\.json$/)
})

test('start rejects a config with an unsupported keyword', async ($, on) => {
  const bad = { ...MINI, schema: { ...MINI.schema, minProperties: 1 } }
  engine(on, { 'bad.json': JSON.stringify(bad) })
  const r = await run($, 'start bad.json')
  expect(r).toContain('Config rejected')
  expect(r).toContain('minProperties')
  const s = await run($, 'status')
  expect(s).toContain('Not started')
})

test('start reports an unreadable config', async ($, on) => {
  engine(on)
  const r = await run($, 'start missing.json')
  expect(r).toContain('Cannot read config')
})

test('first prompt after start becomes the objective with the procedure attached', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  const first = await prompt($, 'Fix the login bug')
  expect(first.context?.join('\n')).toContain('Record facts, bind every mutating call.')
  const second = await prompt($, 'And the logout bug')
  expect(second.context ?? []).toEqual([])
  const s = await run($, 'status')
  expect(s).toContain('objective: Fix the login bug')
})

test('state tool accepts a valid patch, advances the step and binds the action', async ($, on) => {
  const rec = engine(on, FILES)
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: STATE_TOOL, patch: { facts: ['a'] }, action: { tool: 'functions.Edit', input: { file_path: 'x' } } })
  expect(r.deny).toBeUndefined()
  expect(String(r.result)).toContain('Step 1')
  const s = await run($, 'status')
  expect(s).toContain('step: 1')
  expect(s).toContain('pending action: Edit {"file_path":"x"}')
  expect(rec.statuses.at(-1)).toBe('skill-state: mini step 1')
})

test('state tool rejects an invalid patch with every error and keeps the state', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: STATE_TOOL, patch: { facts: ['a', 'b', 'c', 'd'], extra: 1 } })
  expect(r.deny).toContain('patch rejected')
  expect(r.deny).toContain('$.facts must have at most 3 items')
  expect(r.deny).toContain('additional property "extra"')
  const s = await run($, 'status')
  expect(s).toContain('step: 0')
})

test('state tool rejects a bad action and binding the state tool itself', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  const r1 = await $.tool.call({ tool: STATE_TOOL, patch: {}, action: { tool: 'Edit' } })
  expect(r1.deny).toContain('action.input must be a JSON object')
  const r2 = await $.tool.call({ tool: STATE_TOOL, patch: {}, action: { tool: 'skill_state_update', input: {} } })
  expect(r2.deny).toContain('cannot be skill_state_update')
})

test('state tool is refused while the runtime is not active', async ($, on) => {
  engine(on)
  const r = await $.tool.call({ tool: STATE_TOOL, patch: {} })
  expect(r.deny).toContain('not active')
})

test('runtime survives a reload: session.start again keeps it', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  await $.tool.call({ tool: STATE_TOOL, patch: { facts: ['kept'] } })
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  const s = await run($, 'status')
  expect(s).toContain('step: 1')
})

test('runtime is restored from the store on a resumed session', async ($, on) => {
  const saved = {
    isActive: true,
    source: 'mini.json',
    config: MINI,
    objective: 'resume me',
    state: { facts: ['old'], next_action: 'go' },
    step: 4,
    pendingAction: null,
    usage: { input: 1, output: 2, cacheRead: 3, turns: 1 },
    lastFrameChars: null,
    lastCompaction: null,
  }
  const rec = engine(on, {}, { 'runtime:sess-1': saved })
  await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
  const s = await run($, 'status')
  expect(s).toContain('objective: resume me')
  expect(s).toContain('step: 4')
  expect(rec.statuses.at(-1)).toBe('skill-state: mini step 4')
})

test('turn.complete usage is summed and shown by status', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  const done = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' as const, usage: USAGE }
  await $.turn.complete({ ...done, turnId: 't1' })
  await $.turn.complete({ ...done, turnId: 't2' })
  const s = await run($, 'status')
  expect(s).toContain('tokens since start: input 20, output 10, cache read 200 over 2 turns')
  expect(s).toContain('state size:')
  expect(s).toContain('last frame size:')
})

test('a subagent turn is not counted', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: USAGE, turnId: 't1', agentId: 'agent-1' })
  const s = await run($, 'status')
  expect(s).toContain('over 0 turns')
})

test('stop keeps the state, resume reactivates, reset restores the initial state', async ($, on) => {
  const rec = engine(on, FILES)
  await run($, 'start mini.json')
  await prompt($, 'objective one')
  await $.tool.call({ tool: STATE_TOOL, patch: { facts: ['a'] } })

  expect((await run($, 'stop'))).toContain('Stopped')
  expect(rec.statuses.at(-1)).toBeUndefined()
  let s = await run($, 'status')
  expect(s).toContain('runtime: stopped')
  expect(s).toContain('step: 1')
  expect((await $.tool.call({ tool: STATE_TOOL, patch: {} })).deny).toContain('not active')

  expect((await run($, 'resume'))).toContain('Resumed domain mini at step 1')
  expect(rec.statuses.at(-1)).toBe('skill-state: mini step 1')

  expect((await run($, 'reset'))).toContain('Reset')
  s = await run($, 'status')
  expect(s).toContain('step: 0')
  expect(s).toContain('objective: (next prompt)')
  await prompt($, 'objective two')
  s = await run($, 'status')
  expect(s).toContain('objective: objective two')
})

test('a subagent state tool call passes through to the engine', async ($, on) => {
  engine(on, FILES)
  const seen: string[] = []
  on('tool.call', (_$, e) => {
    seen.push(`${e.tool}:${e.agentId ?? 'main'}`)
    return { result: 'engine' }
  })
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: STATE_TOOL, patch: {}, agentId: 'agent-1' })
  expect(r.result).toBe('engine')
  expect(seen).toEqual([`${STATE_TOOL}:agent-1`])
})

// Installs a bottom tool.call hook that stands for the tools themselves and
// records every call that reached them.
function tools(on: On, output: (tool: string) => unknown = () => 'ran'): string[] {
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    ran.push(e.tool)
    return { result: output(e.tool) }
  })
  return ran
}

const EDIT = { tool: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }

test('an unbound mutating call is denied with the call to make', async ($, on) => {
  engine(on, FILES)
  const ran = tools(on)
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: 'Edit', ...EDIT.input })
  expect(r.deny).toContain('Edit is not bound to a state transition')
  expect(r.deny).toContain(STATE_TOOL)
  expect(ran).toEqual([])
})

test('the bound call runs once and a second call needs a new patch', async ($, on) => {
  engine(on, FILES)
  const ran = tools(on)
  await run($, 'start mini.json')
  await $.tool.call({ tool: STATE_TOOL, patch: { facts: ['plan edit'] }, action: EDIT })
  const first = await $.tool.call({ tool: 'Edit', ...EDIT.input })
  expect(first.deny).toBeUndefined()
  expect(first.result).toBe('ran')
  expect(await run($, 'status')).toContain('pending action: none')
  const second = await $.tool.call({ tool: 'Edit', ...EDIT.input })
  expect(second.deny).toContain('No action is bound.')
  expect(ran).toEqual(['Edit'])
})

test('a call that differs from the bound action is denied and keeps the binding', async ($, on) => {
  engine(on, FILES)
  const ran = tools(on)
  await run($, 'start mini.json')
  await $.tool.call({ tool: STATE_TOOL, patch: {}, action: EDIT })
  const r = await $.tool.call({ tool: 'Edit', ...EDIT.input, new_string: 'z' })
  expect(r.deny).toContain('The bound action is Edit')
  expect(await run($, 'status')).toContain('pending action: Edit')
  expect(ran).toEqual([])
})

test('a bound call that fails still consumes the action', async ($, on) => {
  engine(on, FILES)
  on('tool.call', () => ({ isError: true, result: 'boom', text: 'boom' }))
  await run($, 'start mini.json')
  await $.tool.call({ tool: STATE_TOOL, patch: {}, action: EDIT })
  const r = await $.tool.call({ tool: 'Edit', ...EDIT.input })
  expect(r.isError).toBe(true)
  expect(await run($, 'status')).toContain('pending action: none')
})

test('exempt tools run freely without a patch', async ($, on) => {
  engine(on, FILES)
  const ran = tools(on)
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  expect(r.result).toBe('ran')
  expect(ran).toEqual(['Read'])
})

test('ToolSearch runs freely so the deferred state tool can be loaded', async ($, on) => {
  engine(on, FILES)
  const ran = tools(on)
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: 'ToolSearch', query: `select:${STATE_TOOL}`, max_results: 1 })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['ToolSearch'])
})

test('nothing is gated before start, after stop, or in a subagent', async ($, on) => {
  engine(on, FILES)
  const ran = tools(on)
  expect((await $.tool.call({ tool: 'Edit', ...EDIT.input })).result).toBe('ran')
  await run($, 'start mini.json')
  expect((await $.tool.call({ tool: 'Edit', ...EDIT.input, agentId: 'agent-1' })).result).toBe('ran')
  await run($, 'stop')
  expect((await $.tool.call({ tool: 'Edit', ...EDIT.input })).result).toBe('ran')
  expect(ran).toEqual(['Edit', 'Edit', 'Edit'])
})

test('a result over maxObservationChars reaches the model truncated with a marker', async ($, on) => {
  const capped = { ...MINI, maxObservationChars: 20 }
  engine(on, { 'capped.json': JSON.stringify(capped) })
  tools(on, () => ({ stdout: 'o'.repeat(50), stderr: '', interrupted: false }))
  await run($, 'start capped.json')
  const r = await $.tool.call({ tool: 'Read', file_path: 'big.txt' })
  expect(r.result).toEqual({ stdout: `${'o'.repeat(20)}\n[Observation truncated: 30 characters omitted]`, stderr: '', interrupted: false })
})

test('with maxObservationChars unset a long result is unchanged', async ($, on) => {
  engine(on, FILES)
  const long = { stdout: 'o'.repeat(5000) }
  tools(on, () => long)
  await run($, 'start mini.json')
  const r = await $.tool.call({ tool: 'Read', file_path: 'big.txt' })
  expect(r.result).toEqual(long)
})

const FRAME_INSTRUCTIONS = 'skill-state: replace history with the execution frame'

// Two turns of transcript, the first after an earlier frame, each message
// carrying the handle the engine stamps on compaction input.
const TRANSCRIPT = [
  { role: 'user' as const, text: '[SKILL.state frame]\n\nold frame', toolUses: [], handle: 'h0' },
  { role: 'user' as const, text: 'turn one', toolUses: [], handle: 'h1' },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }], handle: 'h2' },
  { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'r', isError: false, result: 'r' }], handle: 'h3' },
  { role: 'assistant' as const, text: 'done one', toolUses: [], handle: 'h4' },
  { role: 'user' as const, text: 'turn two', toolUses: [], handle: 'h5' },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u2', tool: 'Edit', input: {} }], handle: 'h6' },
  { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: 'ok', isError: false, result: 'ok' }], handle: 'h7' },
  { role: 'assistant' as const, text: 'done two', toolUses: [], handle: 'h8' },
]

// Raises a plugin compaction over the transcript, as $.session.compact does.
function compact($: Engine, instructions = FRAME_INSTRUCTIONS, trigger: 'plugin' | 'manual' = 'plugin') {
  return $.session.compact({ trigger, instructions, messages: TRANSCRIPT as never })
}

test('compaction returns the frame plus the last turn for windowTurns 1', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  await prompt($, 'Ship the feature')
  await $.tool.call({ tool: STATE_TOOL, patch: { facts: ['found it'] } })
  const r = await compact($)
  expect(r.skip).toBeUndefined()
  const messages = r.messages ?? []
  expect(messages.map(m => m.handle)).toEqual([undefined, 'h5', 'h6', 'h7', 'h8'])
  const frame = messages[0]?.text ?? ''
  expect(frame.startsWith('[SKILL.state frame]')).toBe(true)
  expect(frame).toContain('Ship the feature')
  expect(frame).toContain('Record facts, bind every mutating call.')
  expect(frame).toContain('"found it"')
  expect(frame).toContain('step 1')
  const s = await run($, 'status')
  expect(s).toContain(`last frame size: ${frame.length} chars`)
  expect(s).toContain('last compaction: frame + 4 message(s) of the last 1 turn(s)')
})

test('compaction keeps only the frame for windowTurns 0', async ($, on) => {
  engine(on, { 'zero.json': JSON.stringify({ ...MINI, windowTurns: 0 }) })
  await run($, 'start zero.json')
  const r = await compact($)
  expect(r.messages?.length).toBe(1)
  expect(r.messages?.[0]?.text.startsWith('[SKILL.state frame]')).toBe(true)
})

test('other compactions and a stopped runtime reach the engine untouched', async ($, on) => {
  engine(on, FILES)
  const reached: string[] = []
  on('session.compact', (_$, e) => {
    reached.push(`${e.trigger}:${e.instructions ?? ''}`)
    return { messages: e.messages }
  })
  expect((await compact($)).messages).toHaveLength(TRANSCRIPT.length)
  await run($, 'start mini.json')
  await compact($, FRAME_INSTRUCTIONS, 'manual')
  await compact($, 'the person asked')
  await run($, 'stop')
  await compact($)
  expect(reached).toEqual([`plugin:${FRAME_INSTRUCTIONS}`, `manual:${FRAME_INSTRUCTIONS}`, 'plugin:the person asked', `plugin:${FRAME_INSTRUCTIONS}`])
})

// The test kit raises a plugin's own $.session.compact() without a transcript
// and refuses it, so the turn-end call is observed through its refusal: the
// frame itself is covered by the direct compaction tests above.
test('turn.complete compacts after a main-loop turn; a refusal keeps the turn result and is reported', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  const out = await $.turn.complete({ answer: 'answer text', durationMs: 1, isAborted: false, reason: 'answer', usage: USAGE, turnId: 't1' })
  expect(out.text).toBe('answer text')
  const s = await run($, 'status')
  expect(s).toContain('last compaction: rejected:')
  expect(s).toContain('over 1 turns')
})

test('no compaction after a subagent turn or while stopped', async ($, on) => {
  engine(on, FILES)
  await run($, 'start mini.json')
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1', agentId: 'agent-1' })
  expect(await run($, 'status')).toContain('last compaction: none')
  await run($, 'stop')
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' })
  expect(await run($, 'status')).toContain('last compaction: none')
})

// /skill-state new <name>: the guided helper.

const RECOMMENDED = [
  TEMPLATE_OPTIONS[0],
  EXTRA_FIELD_OPTIONS[0],
  PROCEDURE_OPTIONS[0],
  WINDOW_OPTIONS[0],
  EXEMPT_OPTIONS[0],
  CEILING_OPTIONS[0],
] as const

const CODING_ALL_RECOMMENDED = buildDomainConfig('demo', {
  template: 'coding',
  extraFields: [],
  procedure: TEMPLATES.coding.procedure,
  windowTurns: 1,
  exemptTools: ['Read', 'Grep', 'Glob'],
  maxObservationChars: undefined,
})

test('new: all-recommended run writes the built config, asks in order with the recommended option first, and starts', async ($, on) => {
  const rec = engine(on)
  const { asked } = scriptAsk(on, [...RECOMMENDED, REVIEW_OPTIONS[0], START_OPTIONS[0]])
  const r = await run($, 'new demo')

  expect(asked).toHaveLength(8)
  expect(asked.map(a => a.header)).toEqual([
    'Template', 'Extra fields', 'Procedure', 'Turns', 'Exempt tools', 'Result cap', 'Review', 'Start',
  ])
  for (const a of asked) {
    expect(a.options[0]).toMatch(/\(Recommended\)$/)
  }
  expect(asked[0]?.options).toEqual(TEMPLATE_OPTIONS)
  expect(asked[4]?.options).toEqual(EXEMPT_OPTIONS)

  const path = Object.keys(rec.written)[0]
  expect(path).toMatch(/\/domains\/demo\.json$/)
  const text = rec.written[path ?? '']
  expect(text?.endsWith('\n')).toBe(true)
  expect(JSON.parse(text ?? '')).toEqual(CODING_ALL_RECOMMENDED)
  expect(text?.split('\n')[1]).toMatch(/^ {2}"/)

  expect(r.replaceAll('\\', '/')).toContain(`Wrote ${path}`)
  expect(r).toContain('Started domain demo')
  const s = await run($, 'status')
  expect(s).toContain('domain: demo')
})

test('new: custom answers land in the config', async ($, on) => {
  const rec = engine(on)
  scriptAsk(on, [
    TEMPLATE_OPTIONS[1],
    'tags:list, done:flag',
    'Track down the intermittent failure.',
    WINDOW_OPTIONS[1],
    EXEMPT_OPTIONS[2],
    CEILING_OPTIONS[1],
    REVIEW_OPTIONS[0],
    START_OPTIONS[1],
  ])
  const r = await run($, 'new demo')

  const expected = buildDomainConfig('demo', {
    template: 'investigation',
    extraFields: [{ name: 'tags', type: 'list' }, { name: 'done', type: 'flag' }],
    procedure: 'Track down the intermittent failure.',
    windowTurns: 0,
    exemptTools: [],
    maxObservationChars: 20000,
  })
  const path = Object.keys(rec.written)[0] ?? ''
  expect(JSON.parse(rec.written[path] ?? '')).toEqual(expected)
  expect(r).toContain('Wrote')
  expect(r).toContain('/skill-state start demo')
})

test('new: an invalid name, a reserved name and a missing name are refused with no dialogs and nothing written', async ($, on) => {
  const rec = engine(on)
  const { asked } = scriptAsk(on, [])

  const missing = await run($, 'new')
  expect(missing).toContain('Usage: /skill-state new <name>')

  const bad = await run($, 'new Bad-Name!')
  expect(bad).toContain('must match')

  const software = await run($, 'new software')
  expect(software).toContain('reserved')

  const ctf = await run($, 'new ctf')
  expect(ctf).toContain('reserved')

  expect(asked).toHaveLength(0)
  expect(rec.written).toEqual({})
})

test('new: a headless session (no surfaces) is refused with no dialogs and nothing written', async ($, on) => {
  const rec = engine(on, {}, {}, { surfaces: [] })
  const { asked } = scriptAsk(on, [])
  const r = await run($, 'new demo')
  expect(r).toContain('interactive session')
  expect(asked).toHaveLength(0)
  expect(rec.written).toEqual({})
})

test('new: a bad extra-fields answer is re-asked once and then succeeds', async ($, on) => {
  const rec = engine(on)
  const { asked } = scriptAsk(on, [
    TEMPLATE_OPTIONS[0],
    'not-a-pair',
    'notes:list',
    PROCEDURE_OPTIONS[0],
    ...RECOMMENDED.slice(3),
    REVIEW_OPTIONS[0],
    START_OPTIONS[1],
  ])
  const r = await run($, 'new demo')

  const extraAsks = asked.filter(a => a.header === 'Extra fields')
  expect(extraAsks).toHaveLength(2)
  expect(extraAsks[1]?.question).toContain('not-a-pair')
  const path = Object.keys(rec.written)[0] ?? ''
  const written = JSON.parse(rec.written[path] ?? '')
  expect(written.schema.required).toContain('notes')
  expect(r).toContain('Wrote')
})

test('new: a second bad extra-fields answer cancels with the error', async ($, on) => {
  const rec = engine(on)
  scriptAsk(on, [TEMPLATE_OPTIONS[0], 'not-a-pair', 'still-not-a-pair'])
  const r = await run($, 'new demo')
  expect(r).toContain('Cancelled; nothing written.')
  expect(r).toContain('not-a-pair')
  expect(rec.written).toEqual({})
})

test('new: an unmatched typed answer at the windowTurns step is re-asked and then cancels', async ($, on) => {
  const rec = engine(on)
  const { asked } = scriptAsk(on, [
    TEMPLATE_OPTIONS[0],
    EXTRA_FIELD_OPTIONS[0],
    PROCEDURE_OPTIONS[0],
    'nonsense',
    'still nonsense',
  ])
  const r = await run($, 'new demo')
  expect(asked.filter(a => a.header === 'Turns')).toHaveLength(2)
  expect(r).toBe('Cancelled; nothing written.')
  expect(rec.written).toEqual({})
})

test('new: dismissing the procedure dialog cancels and writes nothing', async ($, on) => {
  const rec = engine(on)
  scriptAsk(on, [TEMPLATE_OPTIONS[0], EXTRA_FIELD_OPTIONS[0], null])
  const r = await run($, 'new demo')
  expect(r).toBe('Cancelled; nothing written.')
  expect(rec.written).toEqual({})
})

test('new: Cancel at review writes nothing', async ($, on) => {
  const rec = engine(on)
  scriptAsk(on, [...RECOMMENDED, REVIEW_OPTIONS[1]])
  const r = await run($, 'new demo')
  expect(r).toBe('Cancelled; nothing written.')
  expect(rec.written).toEqual({})
})

test('new: an existing file is kept by default and then overwritten with Overwrite', async ($, on) => {
  const rec = engine(on, {}, {}, { existing: ['domains/demo.json'] })
  const { queue } = scriptAsk(on, [...RECOMMENDED, REVIEW_OPTIONS[0], OVERWRITE_OPTIONS[0]])
  const kept = await run($, 'new demo')
  expect(kept).toContain('Kept the existing')
  expect(kept).toContain('Nothing written')
  expect(rec.written).toEqual({})

  queue.push(...RECOMMENDED, REVIEW_OPTIONS[0], OVERWRITE_OPTIONS[1], START_OPTIONS[1])
  const overwritten = await run($, 'new demo')
  expect(overwritten).toContain('Wrote')
  expect(Object.keys(rec.written)).toHaveLength(1)
})

test('new: Not now leaves the runtime untouched and names the start command', async ($, on) => {
  engine(on)
  scriptAsk(on, [...RECOMMENDED, REVIEW_OPTIONS[0], START_OPTIONS[1]])
  const r = await run($, 'new demo')
  expect(r).toContain('Wrote')
  expect(r).toContain('/skill-state start demo')
  const s = await run($, 'status')
  expect(s).toContain('Not started')
})
