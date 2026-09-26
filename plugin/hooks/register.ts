import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { normalizeConfig } from '../lib/config.ts'
import { buildFrameText, FRAME_INSTRUCTIONS, selectWindow } from '../lib/frame.ts'
import { decide, normalizeAction, STATE_TOOL, STATE_TOOL_FULL } from '../lib/gate.ts'
import type { PendingAction } from '../lib/gate.ts'
import type { JsonObject } from '../lib/json.ts'
import { truncateResult } from '../lib/observation.ts'
import { transitionState } from '../lib/patch.ts'
import {
  addTurnUsage,
  buildStartContext,
  createRuntime,
  formatStatus,
  parseCommand,
  resetRuntime,
  resolveConfigPath,
  statusLine,
} from '../lib/runtime.ts'
import type { Runtime } from '../lib/runtime.ts'
import {
  buildDomainConfig,
  CEILING_OPTIONS,
  ceilingFromAnswer,
  EXEMPT_OPTIONS,
  exemptFromAnswer,
  EXTRA_FIELD_OPTIONS,
  extraFieldsFromAnswer,
  OVERWRITE_OPTIONS,
  PROCEDURE_OPTIONS,
  procedureFromAnswer,
  REVIEW_OPTIONS,
  START_OPTIONS,
  TEMPLATE_OPTIONS,
  templateFromAnswer,
  validateDomainName,
  WINDOW_OPTIONS,
  windowFromAnswer,
} from '../lib/wizard.ts'
import type { TemplateId, WizardAnswers, WizardField } from '../lib/wizard.ts'

// The runtime lives in $.state for the session and is mirrored to $.store
// under the session id, so a reload or a resumed session finds it again.
const RUNTIME = { plugin: 'skill-state', key: 'runtime' } as const
const STORE_PREFIX = 'runtime:'
const COMMAND = 'skill-state'

// Keys of tool.call's input that are the engine's, not the tool's arguments.
const RESERVED_KEYS: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

// Prompt origins that are a person's own prompt, eligible as the objective.
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

const TOOL_DESCRIPTION = [
  'Update the SKILL.state execution state and bind the next mutating tool call.',
  '`patch` is merged into the state: objects merge, arrays and scalars replace, null deletes a key.',
  'The complete new state must satisfy the domain schema; a rejected patch changes nothing and lists every error.',
  '`action` { tool, input } names exactly the next non-exempt tool call; that call must then be made with that exact input.',
].join(' ')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    patch: { type: 'object', description: 'State changes to merge; null deletes a key.' },
    action: {
      type: 'object',
      description: 'The next mutating tool call, exactly as it will be made.',
      properties: {
        tool: { type: 'string', description: 'Tool name, e.g. Edit or Bash.' },
        input: { type: 'object', description: 'The exact tool input.' },
      },
      required: ['tool', 'input'],
    },
  },
  required: ['patch'],
}

// Reads the runtime from $.state, falling back to the $.store mirror.
async function loadRuntime($: EngineInterface): Promise<Runtime | null> {
  const { value } = await $.state.get(RUNTIME)
  if (value !== undefined) {
    return value
  }
  const stored = await $.store.get(`${STORE_PREFIX}${await $.session.id()}`)
  return (stored as Runtime | undefined) ?? null
}

// Writes the runtime to $.state and $.store and refreshes the status line.
async function saveRuntime($: EngineInterface, runtime: Runtime | null): Promise<void> {
  await $.state.set(RUNTIME, runtime)
  const key = `${STORE_PREFIX}${await $.session.id()}`
  if (runtime === null) {
    await $.store.delete(key)
  } else {
    await $.store.set(key, runtime)
  }
  $.ui.status(statusLine(runtime))
}

// Loads a domain config by bundled name or path and starts a fresh runtime.
async function startRuntime($: EngineInterface, argument: string): Promise<string> {
  if (argument === '') {
    return 'Usage: /skill-state start <domain|path>. Bundled domains: software, ctf.'
  }
  const path = resolveConfigPath(argument, $.plugin.root)
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (error) {
    return `Cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}`
  }
  let runtime: Runtime
  try {
    runtime = createRuntime(normalizeConfig(JSON.parse(text), path), path)
  } catch (error) {
    return `Config rejected: ${error instanceof Error ? error.message : String(error)}`
  }
  await saveRuntime($, runtime)
  return `Started domain ${runtime.config.name}. Your next prompt becomes the objective.`
}

// The text every cancelled path of `new` returns; nothing is written by then.
const CANCEL_MESSAGE = 'Cancelled; nothing written.'

// A sentinel distinct from any mapped value, returned by askChoice when a
// typed answer misses the accepted labels twice.
const NO_MATCH: unique symbol = Symbol('skill-state: no matching label')

// Asks a fixed-choice question (steps 1, 4, 5, 6 of `new`): an unmatched
// answer is asked once more naming the accepted labels, and a second miss
// gives up with NO_MATCH. A dismissal ($.ui.ask rejecting) propagates as a
// rejection, unhandled here, so the caller's own cancel path takes over.
async function askChoice<T>(
  $: EngineInterface,
  question: string,
  options: readonly string[],
  header: string,
  map: (answer: string) => T | undefined,
): Promise<T | typeof NO_MATCH> {
  const first = await $.ui.ask(question, { options, header })
  const mapped = map(first)
  if (mapped !== undefined) {
    return mapped
  }
  const retry = await $.ui.ask(`${question} Choose one of: ${options.join(', ')}.`, { options, header })
  const remapped = map(retry)
  return remapped === undefined ? NO_MATCH : remapped
}

// Throws naming the pair when an extra field clashes with template's own
// fields, by way of buildDomainConfig's own check, so the rule lives in one
// place (wizard.ts).
function checkExtraFieldsClash(template: TemplateId, extraFields: WizardField[]): void {
  buildDomainConfig('skill-state-new-probe', {
    template,
    extraFields,
    procedure: 'probe',
    windowTurns: 0,
    exemptTools: [],
    maxObservationChars: undefined,
  })
}

// The guided `new <name>` helper (REQ-1, REQ-3, REQ-4, REQ-5): six dialogs,
// recommended option first, then review, an overwrite guard, the write and
// an offer to start. `$` is passed only here, a top-level function, per
// `claude plugin validate`.
async function newDomain($: EngineInterface, name: string): Promise<string> {
  if (name === '') {
    return `Usage: /skill-state new <name>. ${validateDomainName('') ?? ''}`
  }
  const nameError = validateDomainName(name)
  if (nameError !== null) {
    return nameError
  }
  if ((await $.session.surfaces()).length === 0) {
    return 'skill-state: new needs an interactive session to ask its questions. ' +
      'Copy one of the bundled templates (plugin/domains/software.json or ctf.json) by hand instead; nothing was written.'
  }

  try {
    const templateChoice = await askChoice(
      $,
      'Which template should the new domain start from?',
      TEMPLATE_OPTIONS,
      'Template',
      templateFromAnswer,
    )
    if (templateChoice === NO_MATCH) {
      return CANCEL_MESSAGE
    }
    const template = templateChoice

    let extraFields: WizardField[]
    const firstExtraAnswer = await $.ui.ask(
      "Any extra fields beyond the template's own, as name:type pairs?",
      { options: EXTRA_FIELD_OPTIONS, header: 'Extra fields' },
    )
    try {
      extraFields = extraFieldsFromAnswer(firstExtraAnswer)
      checkExtraFieldsClash(template, extraFields)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const secondExtraAnswer = await $.ui.ask(
        `${message}. Extra fields as name:type pairs, comma-separated?`,
        { options: EXTRA_FIELD_OPTIONS, header: 'Extra fields' },
      )
      try {
        extraFields = extraFieldsFromAnswer(secondExtraAnswer)
        checkExtraFieldsClash(template, extraFields)
      } catch (secondError) {
        const secondMessage = secondError instanceof Error ? secondError.message : String(secondError)
        return `${CANCEL_MESSAGE} ${secondMessage}`
      }
    }

    const procedureAnswer = await $.ui.ask(
      'Which procedure should the domain follow?',
      { options: PROCEDURE_OPTIONS, header: 'Procedure' },
    )
    const procedure = procedureFromAnswer(procedureAnswer, template)

    const windowChoice = await askChoice(
      $,
      'How many turns of transcript to keep after the frame?',
      WINDOW_OPTIONS,
      'Turns',
      windowFromAnswer,
    )
    if (windowChoice === NO_MATCH) {
      return CANCEL_MESSAGE
    }

    const exemptChoice = await askChoice(
      $,
      'Which tools should run without a state update?',
      EXEMPT_OPTIONS,
      'Exempt tools',
      exemptFromAnswer,
    )
    if (exemptChoice === NO_MATCH) {
      return CANCEL_MESSAGE
    }

    const ceilingChoice = await askChoice(
      $,
      'Should a tool result be capped, in characters?',
      CEILING_OPTIONS,
      'Result cap',
      ceilingFromAnswer,
    )
    if (ceilingChoice === NO_MATCH) {
      return CANCEL_MESSAGE
    }

    const answers: WizardAnswers = {
      template,
      extraFields,
      procedure,
      windowTurns: windowChoice,
      exemptTools: exemptChoice,
      maxObservationChars: ceilingChoice.value,
    }

    const path = resolveConfigPath(name, $.plugin.root)
    let config: JsonObject
    try {
      config = buildDomainConfig(name, answers)
      normalizeConfig(config, path)
    } catch (error) {
      return `Config rejected: ${error instanceof Error ? error.message : String(error)}`
    }

    $.ui.log(JSON.stringify(config, null, 2))
    const reviewAnswer = await $.ui.ask(`Write domain ${name}?`, { options: REVIEW_OPTIONS, header: 'Review' })
    if (reviewAnswer !== REVIEW_OPTIONS[0]) {
      return CANCEL_MESSAGE
    }

    let exists = true
    try {
      await $.fs.stat(path)
    } catch {
      exists = false
    }
    if (exists) {
      const overwriteAnswer = await $.ui.ask(`Overwrite ${name}?`, { options: OVERWRITE_OPTIONS, header: 'Overwrite' })
      if (overwriteAnswer !== OVERWRITE_OPTIONS[1]) {
        return `Kept the existing ${path}. Nothing written.`
      }
    }

    try {
      await $.fs.write(path, `${JSON.stringify(config, null, 2)}\n`)
    } catch (error) {
      return `Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`
    }

    let startAnswer: string
    try {
      startAnswer = await $.ui.ask(`Start ${name} now?`, { options: START_OPTIONS, header: 'Start' })
    } catch {
      return `Wrote ${path}. Start it with /skill-state start ${name}.`
    }
    if (startAnswer === START_OPTIONS[0]) {
      return `Wrote ${path}. ${await startRuntime($, name)}`
    }
    return `Wrote ${path}. Start it with /skill-state start ${name}.`
  } catch {
    return CANCEL_MESSAGE
  }
}

// Runs one /skill-state subcommand and returns the text to show; the engine
// already labels a plugin command's output with the plugin's name.
async function runCommand($: EngineInterface, args: string): Promise<string> {
  const parsed = parseCommand(args)
  if (!parsed.ok) {
    return parsed.error
  }
  if (parsed.subcommand === 'start') {
    return startRuntime($, parsed.argument)
  }
  if (parsed.subcommand === 'new') {
    return newDomain($, parsed.argument)
  }
  const runtime = await loadRuntime($)
  if (parsed.subcommand === 'status') {
    return formatStatus(runtime)
  }
  if (runtime === null) {
    return formatStatus(null)
  }
  if (parsed.subcommand === 'stop') {
    await saveRuntime($, { ...runtime, isActive: false })
    return 'Stopped. Gating and compaction are off; the state is kept. /skill-state resume turns them back on.'
  }
  if (parsed.subcommand === 'resume') {
    await saveRuntime($, { ...runtime, isActive: true })
    return `Resumed domain ${runtime.config.name} at step ${runtime.step}.`
  }
  await saveRuntime($, resetRuntime(runtime))
  return 'Reset to the initial state. Your next prompt becomes the objective.'
}

// Serves one skill_state_update call on the main loop.
async function updateState($: EngineInterface, patch: unknown, action: unknown): Promise<{ deny: string } | { result: string }> {
  const runtime = await loadRuntime($)
  if (runtime === null || !runtime.isActive) {
    return { deny: 'skill-state: the runtime is not active. The person starts it with /skill-state start <domain>.' }
  }
  let pending: PendingAction | null = null
  const errors: string[] = []
  if (action !== undefined && action !== null) {
    try {
      pending = normalizeAction(action)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  const transition = transitionState(runtime, patch ?? {})
  if (!transition.ok) {
    errors.push(...transition.errors)
  }
  if (errors.length > 0 || !transition.ok) {
    return { deny: `skill-state: patch rejected, state unchanged (step ${runtime.step}):\n- ${errors.join('\n- ')}` }
  }
  const next: Runtime = { ...runtime, state: transition.state, step: runtime.step + 1, pendingAction: pending }
  await saveRuntime($, next)
  const bound = pending === null ? 'No action bound; call again with an action before a mutating tool call.' : `Next allowed call: ${pending.tool} ${JSON.stringify(pending.input)}`
  return { result: `State accepted. Step ${next.step}, state ${transition.chars} chars. ${bound}` }
}

// The tool's own arguments from a tool.call input, as the action binds them.
function toolInput(e: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED_KEYS.has(key))) as JsonObject
}

// Clears the pending action once the bound call has run, unless a newer
// state transition replaced it meanwhile.
async function consumeAction($: EngineInterface, bound: Runtime): Promise<void> {
  const runtime = await loadRuntime($)
  if (runtime !== null && runtime.step === bound.step) {
    await saveRuntime($, { ...runtime, pendingAction: null })
  }
}

// Replaces the transcript with the frame after a main-loop turn; a refusal
// (a headless session, a running turn) is recorded for status, never thrown.
async function compactToFrame($: EngineInterface): Promise<void> {
  let outcome: string | null = null
  try {
    const result = await $.session.compact({ instructions: FRAME_INSTRUCTIONS })
    if (result.skip !== undefined) {
      outcome = `skipped: ${result.skip}`
    }
  } catch (error) {
    outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`
  }
  if (outcome === null) {
    return
  }
  const runtime = await loadRuntime($)
  if (runtime !== null) {
    await saveRuntime($, { ...runtime, lastCompaction: outcome })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'SKILL.state runtime: start <domain|path>, new <name>, status, stop, resume, reset',
      argumentHint: 'start <domain|path> | new <name> | status | stop | resume | reset',
    })
    await $.tool.register({ name: STATE_TOOL, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA })
    const runtime = await loadRuntime($)
    if (runtime !== null) {
      await $.state.set(RUNTIME, runtime)
    }
    $.ui.status(statusLine(runtime))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('tool.call', { tool: 'mcp__skill-state__skill_state_update' }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    return updateState($, e['patch'], e['action'])
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === STATE_TOOL_FULL) {
      return next(e)
    }
    const runtime = await loadRuntime($)
    const decision = decide(runtime, e.tool, toolInput(e))
    if (runtime === null || decision.kind === 'pass') {
      return next(e)
    }
    if (decision.kind === 'deny') {
      return { deny: decision.reason }
    }
    const ran = await next(e)
    if (decision.kind === 'allow') {
      await consumeAction($, runtime)
    }
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const trimmed = truncateResult(ran.result, runtime.config.maxObservationChars)
    if (!trimmed.isTruncated) {
      return ran
    }
    return ran.context === undefined ? { result: trimmed.value } : { result: trimmed.value, context: ran.context }
  })

  on('prompt.submit', async ($, e, next) => {
    const runtime = await loadRuntime($)
    const text = e.text.trim()
    if (runtime === null || !runtime.isActive || runtime.objective !== null || text === '' || text.startsWith('/') || !HUMAN_ORIGINS.has(e.origin.kind)) {
      return next(e)
    }
    const captured: Runtime = { ...runtime, objective: text }
    await saveRuntime($, captured)
    return next({ ...e, context: [...(e.context ?? []), buildStartContext(captured, STATE_TOOL_FULL)] })
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) {
      return out
    }
    const runtime = await loadRuntime($)
    if (runtime === null || !runtime.isActive) {
      return out
    }
    await saveRuntime($, addTurnUsage(runtime, out.usage ?? e.usage))
    await compactToFrame($)
    return out
  })

  on('session.compact', { trigger: 'plugin' }, async ($, e, next) => {
    if (e.agentId !== undefined || e.instructions !== FRAME_INSTRUCTIONS) {
      return next(e)
    }
    const runtime = await loadRuntime($)
    if (runtime === null || !runtime.isActive) {
      return next(e)
    }
    const text = buildFrameText(runtime, STATE_TOOL_FULL)
    const frame: SessionMessage = { role: 'user', text, toolUses: [] }
    const window = selectWindow(e.messages, runtime.config.windowTurns)
    await saveRuntime($, { ...runtime, lastFrameChars: text.length, lastCompaction: `frame + ${window.length} message(s) of the last ${runtime.config.windowTurns} turn(s)` })
    return { messages: [frame, ...window] }
  })
}
