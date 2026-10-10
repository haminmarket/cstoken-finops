import { expect, test } from 'claude-code/testing'

import { CODE_ANALYSIS } from './fixtures'
import {
  addTurn,
  buildRequest,
  emptyLedger,
  FALLBACK_PRICES,
  pricesFrom,
  reportText,
  summarize,
  turnCost,
  clip,
  displayModel,
  failureText,
  formatTokens,
  formatUsd,
  modelIdIn,
  parseResponse,
  rosterFrom,
  ROSTER_MAX,
  suggestionLine,
} from './lib'

test('the roster keeps work commands and MCP servers, not the session plumbing', async () => {
  const roster = rosterFrom(
    [
      { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
      { name: 'model', description: 'Set the model', source: 'builtin' },
      { name: 'code-review', description: 'Review the current diff for correctness bugs', source: 'builtin' },
      { name: 'docx', description: 'Create and edit Word documents', source: 'plugin', plugin: 'anthropic-skills' },
      { name: 'finops', description: 'This mod itself', source: 'plugin' },
      { name: 'blank', description: '   ', source: 'user' },
    ],
    [
      { name: 'Read', description: 'Reads a file', mcp: false },
      { name: 'mcp__slack__send_message', description: 'Send a Slack message', mcp: true },
      { name: 'mcp__slack__list_channels', description: 'List channels', mcp: true },
      { name: 'mcp__finops__noop', description: 'own tool', mcp: true },
    ],
    'finops',
  )
  expect(roster.map(r => `${r.kind}:${r.name}`)).toEqual(['command:code-review', 'skill:docx', 'mcp:slack'])
  expect(roster[2]!.description).toContain('2 tools (send_message, list_channels)')
})

test('the roster is capped and its texts are clipped', async () => {
  const many = Array.from({ length: ROSTER_MAX + 50 }, (_, i) => ({
    name: `skill-${i}`,
    description: 'x'.repeat(400),
    source: 'user' as const,
  }))
  const roster = rosterFrom(many, [], 'finops')
  expect(roster.length).toBe(ROSTER_MAX)
  expect(roster.every(r => r.description.length <= 160)).toBe(true)
  expect(clip('a  b\n c', 10)).toBe('a b c')
  expect(clip('abcdefghijk', 5)).toBe('abcd…')
})

test('the request carries the task, the goal, the model id and, when allowed, the roster', async () => {
  const roster = [{ name: 'code-review', description: 'Review', kind: 'command' as const }]
  const shared = buildRequest({
    task: '  10만 줄 규모의 코드 분석  ',
    priority: 'auto',
    currentModel: 'Opus 5.5 (claude-opus-5-5[1m])',
    roster,
    shareInstalled: true,
  })
  expect(shared).toEqual({
    task: '10만 줄 규모의 코드 분석',
    priority: 'auto',
    current: { model: 'claude-opus-5-5' },
    installed: roster,
  })
  const kept = buildRequest({ task: 'x', priority: 'cost', roster, shareInstalled: false })
  expect(kept).toEqual({ task: 'x', priority: 'cost' })
})

test('a Worker answer is read only when it has the shape the pane draws from', async () => {
  expect(parseResponse(JSON.stringify(CODE_ANALYSIS))?.recommendation.primary).toBe('balanced')
  const broken: unknown[] = [
    'not json',
    null,
    {},
    { ...CODE_ANALYSIS, recommendation: { ...CODE_ANALYSIS.recommendation, picks: [] } },
    {
      ...CODE_ANALYSIS,
      recommendation: {
        ...CODE_ANALYSIS.recommendation,
        picks: CODE_ANALYSIS.recommendation.picks.map(p => ({ ...p, model: 'gpt-x' })),
      },
    },
    { ...CODE_ANALYSIS, tools: { ...CODE_ANALYSIS.tools, installed: [{ name: 1 }] } },
    { ...CODE_ANALYSIS, meta: { latencyMs: 'fast', warnings: [] } },
  ]
  for (const b of broken) expect(parseResponse(typeof b === 'string' ? b : JSON.stringify(b))).toBeNull()
})

test('failures read as something to do', async () => {
  expect(failureText(401, '')).toContain('조직 키')
  expect(failureText(413, '')).toContain('4000자')
  expect(failureText(500, '{"error":{"code":"internal","message":"boom"}}')).toBe('진단 서버 오류 (HTTP 500): boom')
})

test('model names and numbers read the way the pane shows them', async () => {
  expect(modelIdIn('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(modelIdIn('Opus')).toBeUndefined()
  expect(displayModel('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(displayModel(undefined)).toBe('알 수 없음')
  expect(formatTokens(1_200_000)).toBe('120만')
  expect(formatTokens(8_000)).toBe('8,000')
  expect(formatUsd(9.41)).toBe('$9.4')
  expect(formatUsd(0.0213)).toBe('$0.021')
  expect(suggestionLine({ displayName: 'code-review', kind: 'command', installed: true, score: 0.42 })).toBe('/code-review  0.42')
  expect(
    suggestionLine({ displayName: 'feature-dev', kind: 'plugin', installed: false, score: 0.31, verified: false, market: 'pluginworld', qualityScore: 78.6, securityGrade: 'A', stars: 42 }),
  ).toBe('feature-dev  0.31 · PluginWorld · 품질 79 · 보안 A · ★42 · 미검증')
})

const TOKENS = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }

test('a turn costs fresh input, output and cache reads each at their own rate', async () => {
  // Opus 5.5: 10K x $4 + 2K x $20 + 100K x $0.20 per million = 0.04 + 0.04 + 0.02.
  expect(Math.abs(turnCost(TOKENS, FALLBACK_PRICES['claude-opus-5-5']) - 0.1)).toBeLessThan(1e-9)
  // Haiku 5.5 past 100K prompt tokens bills at the long rate.
  const long = turnCost(TOKENS, FALLBACK_PRICES['claude-haiku-5-5'])
  const short = turnCost({ ...TOKENS, cache_read_input_tokens: 0 }, FALLBACK_PRICES['claude-haiku-5-5'])
  expect(long).toBeGreaterThan(short)
})

test('the ledger books spend by model and what an applied pick saved', async () => {
  let ledger = addTurn(emptyLedger(), {
    day: '2026-10-10',
    model: 'claude-sonnet-5-5',
    tokens: TOKENS,
    price: FALLBACK_PRICES['claude-sonnet-5-5'],
    baseline: FALLBACK_PRICES['claude-opus-5-5'],
  })
  ledger = addTurn(ledger, { day: '2026-10-10', model: 'claude-opus-5-5', tokens: TOKENS, price: FALLBACK_PRICES['claude-opus-5-5'] })
  const s = summarize(ledger, '2026-10-10')
  expect(s.todayTurns).toBe(2)
  // Sonnet costs 0.02 + 0.02 + 0.02 = 0.06 against Opus's 0.10 for the same tokens.
  expect(Math.abs(s.weekSavedUsd - 0.04)).toBeLessThan(1e-9)
  expect(s.models.map(m => m.name)).toEqual(['Opus 5.5', 'Sonnet 5.5'])
  const text = reportText(s, 1.23, { used: 3, limit: 100, day: '2026-10-10' })
  expect(text).toContain('이번 세션: $1.2')
  expect(text).toContain('추천 적용으로 절감: $0.040')
  expect(text).toContain('오늘 진단 3 / 100회')
})

test('the ledger keeps the last 30 days', async () => {
  let ledger = emptyLedger()
  for (let d = 1; d <= 40; d++) {
    const day = `2026-09-${String(d).padStart(2, '0')}`
    ledger = addTurn(ledger, { day, model: 'claude-haiku-5-5', tokens: TOKENS, price: FALLBACK_PRICES['claude-haiku-5-5'] })
  }
  expect(Object.keys(ledger.days)).toHaveLength(30)
})

test('prices come from a /v1/models answer, or not at all', async () => {
  const table = pricesFrom(JSON.stringify({ models: [{ id: 'claude-opus-5-5', price: { input: 4, output: 20 } }] }))
  expect(table?.['claude-opus-5-5']?.input).toBe(4)
  expect(pricesFrom('{"models":[]}')).toBeNull()
  expect(pricesFrom('nope')).toBeNull()
})
