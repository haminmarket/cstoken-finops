/**
 * cstoken-finops's type contract: the CSTOKEN FinOps API v1 as the Worker
 * answers it (cstoken-worker/src/contract.ts, types only; change both
 * together), and the pane's own state.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelId = 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-fable-5-1'
export type Priority = 'cost' | 'speed' | 'accuracy'
export type TaskType = 'development' | 'documentation' | 'analysis' | 'automation'
export type Difficulty = 'simple' | 'normal' | 'complex'
export type Risk = 'low' | 'medium' | 'high'
export type Locale = 'ko' | 'en'
export type PickRole = 'economy' | 'balanced' | 'quality'

export type InstalledKind = 'skill' | 'command' | 'agent' | 'mcp' | 'plugin'
export type InstalledItem = { name: string; description: string; kind: InstalledKind }

export type DiagnoseRequest = {
  task: string
  locale?: Locale
  priority?: Priority | 'auto'
  current?: { model?: string; effort?: Effort }
  allowedModels?: ModelId[]
  installed?: InstalledItem[]
  attachments?: { images?: number; files?: number }
}

export type Classification = {
  taskType: { value: TaskType; confidence: number; probabilities: Record<TaskType, number> }
  difficulty: { value: Difficulty; score: number; confidence: number }
  risk: { value: Risk; score: number; confidence: number }
  needs: { longContext: number; reasoning: number; tools: number; vision: number }
  priority: { value: Priority; confidence: number; source: 'user' | 'model' | 'rule' }
  scale?: { text: string; unit: 'lines' | 'files' | 'pages' | 'tokens' | 'chars' | 'words' | 'bytes'; amount: number; tokens: number }
  source: 'clef-flash' | 'rules'
  confidence: number
}

export type CostEstimate = { inputTokens: number; outputTokens: number; usd: number }

export type ModelPick = {
  role: PickRole
  model: ModelId
  modelName: string
  effort: Effort
  estimate: CostEstimate
  reasons: string[]
}

export type Recommendation = {
  primary: PickRole | 'keep-current'
  primaryReason: string
  picks: ModelPick[]
  keepCurrent?: { model?: string; effort?: Effort; reason: string }
  /** The same task priced on the session's model now. */
  current?: { model: ModelId; modelName: string; effort: Effort; estimate: CostEstimate }
  strategy: string[]
  confidence: number
}

export type Market = 'pluginworld' | 'curated'
export type SecurityGrade = 'A+' | 'A' | 'B' | 'C'

export type ToolSuggestion = {
  name: string
  displayName: string
  kind: InstalledKind | 'connector'
  installed: boolean
  score: number
  description: string
  market?: Market
  url?: string
  stars?: number
  author?: string
  qualityScore?: number
  securityGrade?: SecurityGrade
  verified?: boolean
  reviewedBy?: 'anthropic' | null
  source?: string
  install?: string
  version?: string
  license?: string
  permissions?: string[]
  lastMaintained?: string
}

export type DiagnoseResponse = {
  version: string
  locale: Locale
  classification: Classification
  recommendation: Recommendation
  tools: { needed: number; installed: ToolSuggestion[]; catalog: ToolSuggestion[] }
  meta: {
    classifier: 'clef-flash' | 'rules'
    latencyMs: number
    inputTokens?: number
    modelTableVersion: string
    warnings: string[]
    quota?: Quota
  }
}

/** Today's diagnoses on this key (UTC day); `limit` null: unlimited. */
export type Quota = { used: number; limit: number | null; day: string }

/** USD per million tokens, as the Worker's /v1/models lists them. */
export type ModelPrice = {
  input: number
  output: number
  longInput?: number
  longOutput?: number
  longThreshold?: number
  cacheRead?: number
  cacheWrite?: number
}

/** A turn's four token counts, as the engine reports them. */
export type TurnTokens = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type LedgerDay = {
  usd: number
  turns: number
  /** What applied picks saved against the model the person started from; negative when they cost more. */
  savedUsd: number
  byModel: Record<string, { usd: number; turns: number; outputTokens: number }>
}

/** Spend per UTC day, kept in `$.store` across sessions on this machine only. */
export type Ledger = { version: 1; days: Record<string, LedgerDay> }

export type Summary = {
  today: string
  todayUsd: number
  todayTurns: number
  weekUsd: number
  weekSavedUsd: number
  weekDays: number
  models: Array<{ model: string; name: string; usd: number; turns: number }>
}

/** Where the pane stands: nothing asked yet, asking, answered, or failed. */
export type Phase = 'idle' | 'loading' | 'done' | 'error'

export type PriorityChoice = Priority | 'auto'

/** The last answer, with what was asked for it. */
export type Diagnosis = {
  task: string
  priority: PriorityChoice
  response: DiagnoseResponse
  /** Wall time of the whole call from this machine, in ms. */
  roundTripMs: number
  at: number
}

/** A pick the person applied: the session runs on it until they release it. */
export type Applied = {
  model: ModelId
  modelName: string
  effort: Effort
  role: PickRole
  /** The session's model before applying, which a release restores. */
  previousModel?: string
  appliedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'cstoken-finops': {
      phase: Phase
      task: string
      priority: PriorityChoice
      diagnosis: Diagnosis | null
      error: string | null
      notice: string | null
      applied: Applied | null
      roster: InstalledItem[]
      /** The band above the prompt was dismissed; `/cstoken` brings it back. */
      bandHidden: boolean
      /** What the session has cost so far, as Claude Code totals it. */
      sessionUsd: number | null
      quota: Quota | null
      /** The full spend report is unfolded in the pane. */
      showReport: boolean
      summary: Summary | null
    }
  }
}
