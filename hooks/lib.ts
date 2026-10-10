/**
 * Pure helpers for cstoken-router: building the request, reading the answer,
 * and the words the pane draws. Nothing here touches `$`, so every function is
 * tested directly.
 */
import type { CommandInfo, ToolInfo } from 'claude-code'

import type {
  Applied,
  Ledger,
  LedgerDay,
  ModelPrice,
  Quota,
  Summary,
  TurnTokens,
  DiagnoseRequest,
  DiagnoseResponse,
  Difficulty,
  Effort,
  InstalledItem,
  InstalledKind,
  ModelId,
  PickRole,
  Priority,
  PriorityChoice,
  Risk,
  TaskType,
} from '../types'

export const PANE = 'finops'
export const COMMAND = 'finops'

/** The CSTOKEN FinOps Worker this mod talks to when no setting names another. */
export const DEFAULT_ENDPOINT = 'https://finops.cstoken.net'

/** `$.store` keys: the spend ledger and the price table. */
export const LEDGER_KEY = 'ledger.v1'
export const PRICES_KEY = 'prices.v1'

/** Days of spend the ledger keeps. */
export const LEDGER_DAYS = 30

/** The whole call, Worker and clef-flash included; past it the person keeps their model. */
export const REQUEST_TIMEOUT_MS = 9_000

export const TASK_MAX = 4000
export const ROSTER_MAX = 200

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const MODEL_NAMES: Record<ModelId, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}

export function isModelId(v: unknown): v is ModelId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODEL_NAMES, v)
}

/** The model id inside what `/model` shows: "claude-opus-5-5", "claude-opus-5-5[1m]", "Opus (claude-opus-5-5)". */
export function modelIdIn(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return /claude-[a-z0-9-]+/i.exec(raw)?.[0]?.toLowerCase()
}

export function displayModel(raw: string | undefined): string {
  const id = modelIdIn(raw)
  if (isModelId(id)) return MODEL_NAMES[id]
  return raw?.trim() || '알 수 없음'
}

// ---------------------------------------------------------------------------
// What is installed: the roster the Worker ranks.
// ---------------------------------------------------------------------------

/** Built-in commands that run the session itself; none of them is a tool for a task. */
const SESSION_COMMANDS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort',
  'exit', 'export', 'fast', 'feedback', 'help', 'hooks', 'ide', 'login', 'logout', 'mcp', 'memory',
  'model', 'output-style', 'permissions', 'plugin', 'privacy-settings', 'quit', 'release-notes',
  'reload-plugins', 'resume', 'rewind', 'status', 'statusline', 'terminal-setup', 'theme', 'todos',
  'upgrade', 'usage', 'vim',
])

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Cut to `max` characters, the ellipsis included. */
export function clip(s: string, max: number): string {
  const one = flat(s)
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const kindOf = (c: CommandInfo): InstalledKind => (c.source === 'plugin' || c.source === 'user' ? 'skill' : 'command')

/**
 * The commands, skills and MCP servers the session has, as names and one
 * line each: what the Worker ranks against the task. MCP tools are grouped
 * by server, so a server with forty tools is one entry.
 */
export function rosterFrom(commands: readonly CommandInfo[], tools: readonly ToolInfo[], self: string): InstalledItem[] {
  const out: InstalledItem[] = []
  const seen = new Set<string>()
  const add = (item: InstalledItem) => {
    if (!item.name || seen.has(item.name) || out.length >= ROSTER_MAX) return
    seen.add(item.name)
    out.push({ ...item, name: clip(item.name, 80), description: clip(item.description, 160) })
  }

  for (const c of commands) {
    if (c.name === self || (c.source === 'builtin' && SESSION_COMMANDS.has(c.name))) continue
    if (!c.description.trim()) continue
    add({ name: c.name, description: c.description, kind: kindOf(c) })
  }

  const servers = new Map<string, ToolInfo[]>()
  for (const t of tools) {
    if (!t.mcp) continue
    const server = /^mcp__(.+?)__/.exec(t.name)?.[1]
    if (!server || server === self) continue
    servers.set(server, [...(servers.get(server) ?? []), t])
  }
  for (const [server, list] of servers) {
    const names = list.slice(0, 4).map(t => t.name.replace(/^mcp__.+?__/, '')).join(', ')
    const first = list[0]?.description ?? ''
    add({ name: server, description: `${list.length} tools (${names}): ${first}`, kind: 'mcp' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Settings: where the endpoint and key come from.
// ---------------------------------------------------------------------------

/** The first non-empty value, trimmed. */
export function firstSet(...values: ReadonlyArray<unknown>): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

export function endpointUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

// ---------------------------------------------------------------------------
// The request and the answer.
// ---------------------------------------------------------------------------

export function buildRequest(args: {
  task: string
  priority: PriorityChoice
  currentModel?: string
  roster: readonly InstalledItem[]
  shareInstalled: boolean
}): DiagnoseRequest {
  const current = modelIdIn(args.currentModel)
  return {
    task: args.task.trim().slice(0, TASK_MAX),
    priority: args.priority,
    ...(current ? { current: { model: current } } : {}),
    ...(args.shareInstalled && args.roster.length > 0 ? { installed: args.roster.slice(0, ROSTER_MAX) } : {}),
  }
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

function isPick(v: unknown): boolean {
  return (
    isRec(v) &&
    isStr(v.role) &&
    isModelId(v.model) &&
    isStr(v.modelName) &&
    EFFORTS.includes(v.effort as Effort) &&
    isRec(v.estimate) &&
    isNum(v.estimate.usd) &&
    isStrList(v.reasons)
  )
}

function isSuggestion(v: unknown): boolean {
  return isRec(v) && isStr(v.name) && isStr(v.displayName) && isStr(v.kind) && isNum(v.score) && isStr(v.description)
}

/**
 * The Worker's answer, or null when it is not one. The Worker is ours, but
 * what crosses the network is checked before the pane draws from it.
 */
export function parseResponse(text: string): DiagnoseResponse | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRec(v) || !isRec(v.classification) || !isRec(v.recommendation) || !isRec(v.tools) || !isRec(v.meta)) return null
  const c = v.classification
  const r = v.recommendation
  const t = v.tools
  const ok =
    isRec(c.taskType) && isStr(c.taskType.value) &&
    isRec(c.difficulty) && isNum(c.difficulty.score) &&
    isRec(c.risk) && isNum(c.risk.score) &&
    isRec(c.needs) && isNum(c.needs.longContext) && isNum(c.needs.reasoning) && isNum(c.needs.tools) && isNum(c.needs.vision) &&
    isRec(c.priority) && isStr(c.priority.value) &&
    isNum(c.confidence) &&
    isStr(r.primary) && isStr(r.primaryReason) &&
    Array.isArray(r.picks) && r.picks.length === 3 && r.picks.every(isPick) &&
    isStrList(r.strategy) &&
    isNum(t.needed) &&
    Array.isArray(t.installed) && t.installed.every(isSuggestion) &&
    Array.isArray(t.catalog) && t.catalog.every(isSuggestion) &&
    isNum(v.meta.latencyMs) && isStrList(v.meta.warnings)
  return ok ? (v as unknown as DiagnoseResponse) : null
}

/** Why a call failed, in words the person can act on. */
export function failureText(status: number, body: string): string {
  let message = ''
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRec(parsed) && isRec(parsed.error) && isStr(parsed.error.message)) message = parsed.error.message
  } catch {
    // Not JSON: the status alone says it.
  }
  if (status === 401) return '조직 키가 거부되었습니다 (401). /config의 apiKey를 확인하거나 CSTOKEN 담당자에게 문의하세요.'
  if (status === 413) return '작업 설명이 너무 깁니다 (4000자 이하).'
  if (status === 429) {
    return body.includes('quota_exceeded')
      ? '오늘 진단 한도를 다 썼습니다 (UTC 자정에 초기화). 한도를 늘리려면 CSTOKEN 담당자에게 문의하세요.'
      : '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.'
  }
  if (status === 400) return `요청 형식 오류: ${clip(message || 'bad request', 120)}`
  return `진단 서버 오류 (HTTP ${status})${message ? `: ${clip(message, 120)}` : ''}`
}

// ---------------------------------------------------------------------------
// Words the pane draws.
// ---------------------------------------------------------------------------

export const ROLE_LABEL: Record<PickRole, string> = { economy: '경제', balanced: '균형', quality: '품질' }
export const TYPE_LABEL: Record<TaskType, string> = {
  development: '개발',
  documentation: '문서',
  analysis: '분석',
  automation: '자동화',
}
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { simple: '단순', normal: '일반', complex: '복잡' }
export const RISK_LABEL: Record<Risk, string> = { low: '낮음', medium: '중간', high: '높음' }
export const PRIORITY_LABEL: Record<Priority, string> = { cost: '비용', speed: '속도', accuracy: '정확도' }
export const PRIORITY_OPTIONS: ReadonlyArray<{ value: PriorityChoice; label: string }> = [
  { value: 'auto', label: '자동 판단' },
  { value: 'cost', label: '비용' },
  { value: 'speed', label: '속도' },
  { value: 'accuracy', label: '정확도' },
]

export function isPriorityChoice(v: unknown): v is PriorityChoice {
  return PRIORITY_OPTIONS.some(o => o.value === v)
}

const label = <K extends string>(table: Record<K, string>, key: string): string =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key as K] : key

export const typeLabel = (k: string) => label(TYPE_LABEL, k)
export const difficultyLabel = (k: string) => label(DIFFICULTY_LABEL, k)
export const riskLabel = (k: string) => label(RISK_LABEL, k)
export const priorityLabel = (k: string) => label(PRIORITY_LABEL, k)
export const roleLabel = (k: string) => label(ROLE_LABEL, k)

export function formatUsd(v: number): string {
  if (v >= 10) return `$${v.toFixed(0)}`
  if (v >= 1) return `$${v.toFixed(1)}`
  if (v >= 0.1) return `$${v.toFixed(2)}`
  return `$${v.toFixed(3)}`
}

export function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}억`
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}만`
  return n.toLocaleString('en-US')
}

export const p2 = (v: number) => v.toFixed(2)

/** A fixed-width bar for a probability. */
export function bar(p: number, width = 8): string {
  const filled = Math.round(Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function statusLine(a: Applied): string {
  return `FinOps ▸ ${a.modelName} · ${a.effort}`
}

export const MARKET_LABEL: Record<string, string> = { pluginworld: 'PluginWorld', curated: '검수 목록' }

/** "1.2k" for a star count. */
export function formatStars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** A suggestion's one-line label: how to reach it, and where it stands. */
export function suggestionLine(s: {
  displayName: string
  kind: string
  installed: boolean
  score: number
  verified?: boolean
  reviewedBy?: 'anthropic' | null
  market?: string
  stars?: number
  qualityScore?: number
  securityGrade?: string
}): string {
  const handle = s.kind === 'mcp' || s.kind === 'connector' ? `MCP ${s.displayName}` : s.installed ? `/${s.displayName}` : s.displayName
  const marks = [p2(s.score)]
  if (!s.installed) {
    if (s.market) marks.push(MARKET_LABEL[s.market] ?? s.market)
    if (s.qualityScore !== undefined) marks.push(`품질 ${Math.round(s.qualityScore)}`)
    if (s.securityGrade) marks.push(`보안 ${s.securityGrade}`)
    if (s.stars !== undefined && s.stars > 0) marks.push(`★${formatStars(s.stars)}`)
    marks.push(s.verified ? '검증됨' : '미검증')
    if (s.reviewedBy === 'anthropic') marks.push('Anthropic 검토')
  }
  return `${handle}  ${marks.join(' · ')}`
}

// ---------------------------------------------------------------------------
// FinOps: what the session's turns cost, and what applied picks saved.
// ---------------------------------------------------------------------------

/**
 * List prices (USD per million tokens) used until the Worker's /v1/models
 * answers: the same table the Worker recommends from, cache rates included.
 */
export const FALLBACK_PRICES: Record<ModelId, ModelPrice> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longThreshold: 100_000, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
}

/** The price of the model a turn names, or undefined for a model outside the table. */
export function priceOf(model: string | undefined, prices: Partial<Record<string, ModelPrice>>): ModelPrice | undefined {
  const id = modelIdIn(model)
  return id ? prices[id] : undefined
}

/** The prices in a /v1/models answer, or null when it is not one. */
export function pricesFrom(text: string): Record<string, ModelPrice> | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRec(v) || !Array.isArray(v.models)) return null
  const out: Record<string, ModelPrice> = {}
  for (const m of v.models) {
    if (isRec(m) && isStr(m.id) && isRec(m.price) && isNum(m.price.input) && isNum(m.price.output)) {
      out[m.id] = m.price as unknown as ModelPrice
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * What one turn cost at list price: fresh input, output, cache reads and
 * writes each at their own rate. Long-context rates apply to a turn whose
 * prompt (fresh + cached) passed the model's threshold.
 */
export function turnCost(t: TurnTokens, price: ModelPrice): number {
  const prompt = t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens
  const isLong = price.longThreshold !== undefined && prompt > price.longThreshold
  const input = isLong ? (price.longInput ?? price.input) : price.input
  const output = isLong ? (price.longOutput ?? price.output) : price.output
  const read = price.cacheRead ?? input * 0.1
  const write = price.cacheWrite ?? input * 1.25
  return (
    (t.input_tokens * input + t.output_tokens * output + t.cache_read_input_tokens * read + t.cache_creation_input_tokens * write) / 1e6
  )
}

/** The UTC day a time falls on, as the Worker's quota counts days. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const emptyDay = (): LedgerDay => ({ usd: 0, turns: 0, savedUsd: 0, byModel: {} })

export const emptyLedger = (): Ledger => ({ version: 1, days: {} })

export function isLedger(v: unknown): v is Ledger {
  return isRec(v) && v.version === 1 && isRec(v.days)
}

/**
 * The ledger with one more turn: its cost under its model and, when an
 * applied pick ran it, the difference from what the model the person started
 * from would have cost for the same tokens (negative when the pick costs more).
 */
export function addTurn(
  ledger: Ledger,
  turn: { day: string; model: string; tokens: TurnTokens; price: ModelPrice; baseline?: ModelPrice },
): Ledger {
  const usd = turnCost(turn.tokens, turn.price)
  const saved = turn.baseline ? turnCost(turn.tokens, turn.baseline) - usd : 0
  const day = ledger.days[turn.day] ?? emptyDay()
  const id = modelIdIn(turn.model) ?? turn.model
  const m = day.byModel[id] ?? { usd: 0, turns: 0, outputTokens: 0 }
  const next: LedgerDay = {
    usd: day.usd + usd,
    turns: day.turns + 1,
    savedUsd: day.savedUsd + saved,
    byModel: { ...day.byModel, [id]: { usd: m.usd + usd, turns: m.turns + 1, outputTokens: m.outputTokens + turn.tokens.output_tokens } },
  }
  const days: Record<string, LedgerDay> = { ...ledger.days, [turn.day]: next }
  const kept = Object.keys(days).sort().slice(-LEDGER_DAYS)
  return { version: 1, days: Object.fromEntries(kept.map(d => [d, days[d]!])) }
}

/** Today and the last seven days on record, for the pane and the report. */
export function summarize(ledger: Ledger, today: string): Summary {
  const days = Object.keys(ledger.days).sort().filter(d => d <= today).slice(-7)
  const week = days.map(d => ledger.days[d]!)
  const byModel: Record<string, { usd: number; turns: number }> = {}
  for (const day of week) {
    for (const [id, m] of Object.entries(day.byModel)) {
      const acc = byModel[id] ?? { usd: 0, turns: 0 }
      byModel[id] = { usd: acc.usd + m.usd, turns: acc.turns + m.turns }
    }
  }
  const todayDay = ledger.days[today]
  return {
    today,
    todayUsd: todayDay?.usd ?? 0,
    todayTurns: todayDay?.turns ?? 0,
    weekUsd: week.reduce((a, d) => a + d.usd, 0),
    weekSavedUsd: week.reduce((a, d) => a + d.savedUsd, 0),
    weekDays: days.length,
    models: Object.entries(byModel)
      .map(([model, m]) => ({ model, name: displayModel(model), usd: m.usd, turns: m.turns }))
      .sort((a, b) => b.usd - a.usd),
  }
}

/** The /finops report: spend by model, what applied picks saved, today's diagnoses. */
export function reportText(summary: Summary, sessionUsd: number | null, quota: Quota | null): string {
  const lines = [
    '**CSTOKEN FinOps 리포트**',
    '',
    `- 이번 세션: ${sessionUsd === null ? '알 수 없음' : formatUsd(sessionUsd)} (Claude Code 집계)`,
    `- 오늘(${summary.today} UTC): ${formatUsd(summary.todayUsd)} · ${summary.todayTurns}턴`,
    `- 최근 ${summary.weekDays}일: ${formatUsd(summary.weekUsd)}`,
    summary.weekSavedUsd >= 0
      ? `- 추천 적용으로 절감: ${formatUsd(summary.weekSavedUsd)} (적용 전 모델 대비, 같은 토큰 기준)`
      : `- 추천 적용으로 추가 지출: ${formatUsd(-summary.weekSavedUsd)} (품질 우선 선택, 적용 전 모델 대비)`,
  ]
  if (summary.models.length > 0) {
    lines.push('', '| 모델 | 지출 | 턴 |', '|---|---:|---:|')
    for (const m of summary.models) lines.push(`| ${m.name} | ${formatUsd(m.usd)} | ${m.turns} |`)
  }
  if (quota) lines.push('', `오늘 진단 ${quota.used}${quota.limit === null ? '회 (무제한)' : ` / ${quota.limit}회`}`)
  lines.push('', '_정가 기준 추정치입니다. 실제 청구는 구독·할인·캐시 정책에 따라 다를 수 있습니다._')
  return lines.join('\n')
}

export function isQuota(v: unknown): v is Quota {
  return isRec(v) && isNum(v.used) && (v.limit === null || isNum(v.limit)) && isStr(v.day)
}

// ---------------------------------------------------------------------------
// Plain words for the numbers: what the person reads instead of probabilities.
// ---------------------------------------------------------------------------

/** 높음 / 보통 / 낮음 for a probability or confidence. */
export function level(p: number): '높음' | '보통' | '낮음' {
  return p >= 0.66 ? '높음' : p >= 0.33 ? '보통' : '낮음'
}

/** What the task needs, as the few words that matter (only the likely ones). */
export function needWords(needs: { longContext: number; reasoning: number; tools: number; vision: number }): string[] {
  const out: string[] = []
  if (needs.longContext >= 0.5) out.push('긴 문맥')
  if (needs.reasoning >= 0.5) out.push('깊은 추론')
  if (needs.tools >= 0.5) out.push('도구 사용')
  if (needs.vision >= 0.5) out.push('이미지')
  return out
}

/**
 * A pick against the model in use now: what it saves or adds, or that it is
 * the same; undefined with nothing to compare. Differences under a cent and
 * under 2% read as the same.
 */
export function versusNow(usd: number, now: number | undefined): { text: string; tone: 'save' | 'add' | 'same' } | undefined {
  if (now === undefined) return undefined
  const d = usd - now
  if (Math.abs(d) < 0.01 || Math.abs(d) < now * 0.02) return { text: '현재와 비슷', tone: 'same' }
  return d < 0 ? { text: `현재보다 ${formatUsd(-d)} 절약`, tone: 'save' } : { text: `현재보다 ${formatUsd(d)} 추가`, tone: 'add' }
}

/** A cost as a bar against the dearest option shown, so the picks compare at a glance. */
export function costBar(usd: number, max: number, width = 10): string {
  return bar(max > 0 ? usd / max : 0, width)
}

/** An install hint as its steps: a plugin may need its marketplace added first. */
export function installSteps(install: string | undefined): string[] {
  return (install ?? '').split('\n').map(s => s.trim()).filter(Boolean)
}
