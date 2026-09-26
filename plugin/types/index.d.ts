// Type contract of the skill-state plugin: the runtime it keeps in $.state.

/** A JSON value as the runtime stores it. */
export type SkillStateJson = null | boolean | number | string | SkillStateJson[] | { [key: string]: SkillStateJson }

/** A loaded domain config (REQ-1). */
export type SkillStateConfig = {
  name: string
  instructions: string
  schema: { [key: string]: SkillStateJson }
  initialState: { [key: string]: SkillStateJson }
  exemptTools: string[]
  windowTurns: number
  maxStateChars: number
  maxObservationChars?: number
}

/** The next mutating tool call a validated patch permits (REQ-3, REQ-4). */
export type SkillStateAction = {
  tool: string
  input: { [key: string]: SkillStateJson }
}

/** Token sums from turn.complete usage since start (REQ-8). */
export type SkillStateUsage = {
  input: number
  output: number
  cacheRead: number
  turns: number
}

/** The whole runtime, persisted in $.state and mirrored to $.store. */
export type SkillStateRuntime = {
  isActive: boolean
  source: string
  config: SkillStateConfig
  objective: string | null
  state: { [key: string]: SkillStateJson }
  step: number
  pendingAction: SkillStateAction | null
  usage: SkillStateUsage
  lastFrameChars: number | null
  lastCompaction: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'skill-state': { runtime: SkillStateRuntime | null }
  }
}
