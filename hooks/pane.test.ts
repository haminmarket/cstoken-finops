import type { On, TurnStepInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { CODE_ANALYSIS } from './fixtures'

const PANE = {
  plugin: 'cstoken-finops',
  component: 'Pane',
  requestId: 'finops',
  props: {
    title: 'CSTOKEN FinOps',
    isFocused: true,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TASK = '10만 줄 규모의 코드 분석'

type World = {
  fetches: Array<{ url: string; auth?: string; body: unknown }>
  runs: Array<{ command: string; args: string }>
  statuses: Array<string | undefined>
  steps: Array<{ model: string; effort: unknown; agentId?: string }>
}

/**
 * What the engine and the Worker would answer beneath the plugin: a session on
 * Sonnet 5.5 whose `/model` really switches, and a Worker that answers `reply`.
 */
function world(
  on: On,
  reply: { status: number; text: string } = { status: 200, text: JSON.stringify(CODE_ANALYSIS) },
  env: Record<string, string> = { CSTOKEN_FINOPS_ENDPOINT: 'https://cstoken.test/', CSTOKEN_FINOPS_API_KEY: 'cst_finops_test' },
): World {
  mock.clock(on)
  mock.store(on, {})
  mock.env(on, env)
  let model = 'claude-sonnet-5-5'
  const w: World = { fetches: [], runs: [], statuses: [], steps: [] }
  on('settings.read', () => ({ value: {} }))
  on('command.list', () => ({ value: [{ name: 'code-review', description: 'Review the current diff', source: 'builtin' as const }] }))
  on('tool.list', () => ({ value: [] }))
  on('session.model', () => ({ value: model }))
  on('session.version', () => ({ value: { version: '2.1.295', base: '2.1.295', builtAt: '2026-10-01T00:00:00Z' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: 0.42 } } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    w.fetches.push({ url: e.url, auth: e.init?.headers?.authorization, body: JSON.parse(e.init?.body ?? 'null') })
    if (e.url.endsWith('/v1/models')) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text: reply.text } }
  })
  on('command.run', ($, e) => {
    w.runs.push({ command: e.command, args: e.args })
    if (e.command === 'model') model = e.args
    return { text: '' }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('turn.step', async function* ($, e) {
    w.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

test('a typed task is sent to the Worker and its picks are drawn, on each surface with an Input', async ($, on) => {
  const w = world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'task', text: TASK })
    expect(await ui.find({ text: /Opus 5\.5 · effort xhigh/ })).toBeDefined()
    expect(await ui.find({ key: 'apply:economy' })).toBeDefined()
    expect(await ui.find({ key: 'apply:balanced' })).toBeDefined()
    expect(await ui.find({ key: 'apply:quality' })).toBeDefined()
    expect(await ui.find({ text: /120만 토큰/ })).toBeDefined()
    expect(await ui.find({ text: /feature-dev/ })).toBeDefined()
    await ui.unmount()
  }
  expect(w.fetches).toHaveLength(2)
  expect(w.fetches[0]).toMatchObject({ url: 'https://cstoken.test/v1/diagnose', auth: 'Bearer cst_finops_test' })
  expect(w.fetches[0]!.body).toMatchObject({
    task: TASK,
    priority: 'auto',
    current: { model: 'claude-sonnet-5-5' },
    installed: [{ name: 'code-review', kind: 'command' }],
  })
})

test('apply switches the model, holds the effort on main-thread steps, and release goes back', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task', text: TASK })
  await ui.press({ key: 'apply:balanced' })

  expect(w.runs).toEqual([{ command: 'model', args: 'claude-opus-5-5' }])
  expect(w.statuses.at(-1)).toBe('FinOps ▸ Opus 5.5 · xhigh')
  expect(await ui.find({ text: /✓ 적용됨/ })).toBeDefined()

  const step = async (input: TurnStepInput) => {
    const stream = $.turn.step(input)
    for await (const _ of stream) {
      // Drained for the result.
    }
    return stream.result
  }
  await step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
  await step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', effort: 'medium', messageCount: 3, agentId: 'a1' })
  await step({ turnId: 't2', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 5 })
  expect(w.steps).toEqual([
    { model: 'claude-opus-5-5', effort: 'xhigh', agentId: undefined },
    { model: 'claude-opus-5-5', effort: 'medium', agentId: 'a1' },
    { model: 'claude-haiku-5-5', effort: 'medium', agentId: undefined },
  ])

  await ui.press({ key: 'release' })
  expect(w.runs.at(-1)).toEqual({ command: 'model', args: 'claude-sonnet-5-5' })
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(await ui.find({ key: 'release' })).toBeUndefined()
  await ui.unmount()
})

test('a Worker failure keeps the current model and says so', async ($, on) => {
  world(on, { status: 401, text: '{"error":{"code":"unauthorized","message":"bad key"}}' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'task', text: TASK })
  expect(await ui.find({ text: /조직 키가 거부되었습니다/ })).toBeDefined()
  expect(await ui.find({ text: /현재 모델\(Sonnet 5\.5\)을 그대로 쓰세요/ })).toBeDefined()
  expect(await ui.find({ key: 'apply:balanced' })).toBeUndefined()
  await ui.unmount()
})

test('/finops with a task diagnoses it and answers the lead pick as its output', async ($, on) => {
  world(on)
  const out = await $.command.run({ command: 'finops', args: TASK, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(out.text).toContain('★ Opus 5.5 · xhigh')
})

test('changing the goal re-asks about the task on screen with that goal', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task', text: TASK })
  await ui.select({ key: 'priority', value: 'cost' })
  expect(w.fetches).toHaveLength(2)
  expect(w.fetches[1]!.body).toMatchObject({ task: TASK, priority: 'cost' })
  await ui.unmount()
})

const BAND = {
  plugin: 'cstoken-finops',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

test('the band above the prompt diagnoses the draft in place and applies the lead pick', async ($, on) => {
  const w = world(on)
  on('prompt.read', () => ({ value: { text: TASK, cursor: TASK.length } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // Before an answer the band offers a diagnosis; after one it offers to ask again.
    const ask = surface === 'terminal' ? 'band:check' : 'band:again'
    expect(await ui.find({ key: ask })).toBeDefined()
    await ui.press({ key: ask })
    expect(await ui.find({ text: /★ Opus 5\.5 · xhigh/ })).toBeDefined()
    expect(await ui.find({ key: 'band:apply' })).toBeDefined()
    await ui.unmount()
  }
  expect(w.fetches).toHaveLength(2)
  expect(w.fetches[0]!.body).toMatchObject({ task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'band:apply' })
  expect(w.runs).toContainEqual({ command: 'model', args: 'claude-opus-5-5' })
  expect(await ui.find({ key: 'band:release' })).toBeDefined()
  await ui.press({ key: 'band:hide' })
  await expect(ui.drawn()).rejects.toThrow()
  await ui.unmount()
})

test('an empty draft asks for a task instead of calling the Worker', async ($, on) => {
  const w = world(on)
  on('prompt.read', () => ({ value: { text: '  ', cursor: 0 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'band:check' })
  expect(w.fetches).toHaveLength(0)
  expect(await ui.find({ text: /채팅 입력창에 작업을 적은 뒤/ })).toBeDefined()
  await ui.unmount()
})

test('without an organisation key it says how to get one and calls nothing', async ($, on) => {
  const w = world(on, undefined, {})
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task', text: TASK })
  expect(await ui.find({ text: /CSTOKEN 고객사 전용입니다/ })).toBeDefined()
  expect(w.fetches).toHaveLength(0)
  await ui.unmount()
})

test('with only CSTOKEN_FINOPS_API_KEY set it calls finops.cstoken.net with that key', async ($, on) => {
  const w = world(on, undefined, { CSTOKEN_FINOPS_API_KEY: 'cst_finops_org' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'task', text: TASK })
  expect(w.fetches[0]).toMatchObject({ url: 'https://finops.cstoken.net/v1/diagnose', auth: 'Bearer cst_finops_org' })
  await ui.unmount()
})

test('a finished turn is booked into the ledger and the report', async ($, on) => {
  world(on)
  await $.turn.complete({
    reason: 'answer',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    usage: { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 },
  } as never)
  const out = await $.command.run({ command: 'finops', args: 'report', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(out.text).toContain('이번 세션: $0.42')
  expect(out.text).toContain('| Opus 5.5 | $0.10 | 1 |')
})

test('a spent daily quota says so and keeps the current model', async ($, on) => {
  world(on, { status: 429, text: '{"error":{"code":"quota_exceeded","message":"daily quota of 100 reached"}}' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'task', text: TASK })
  expect(await ui.find({ text: /오늘 진단 한도를 다 썼습니다/ })).toBeDefined()
  await ui.unmount()
})

test('the pane leads with one card: the pick, its price against the model in use, and the action', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'task', text: TASK })
    expect(await ui.find({ text: /★ 추천 · 균형/ })).toBeDefined()
    // Opus at $9.41 against today's Sonnet at $4.47 for the same task.
    expect(await ui.find({ text: /현재보다 \$4\.9 추가/ })).toBeDefined()
    expect(await ui.find({ text: /현재 Sonnet 5\.5 · high/ })).toBeDefined()
    // Words, not probabilities.
    expect(await ui.find({ text: /필요: 긴 문맥, 깊은 추론, 도구 사용/ })).toBeDefined()
    expect(await ui.find({ text: /신뢰도 보통/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an installed skill goes into the prompt ahead of the typed task', async ($, on) => {
  world(on)
  const fills: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task', text: TASK })
  await ui.press({ key: 'use:code-review' })
  expect(fills).toEqual([`/code-review ${TASK}`])
  await ui.press({ key: 'install:0' })
  expect(fills[1]).toBe('/plugin marketplace add ncoevoet/claude-review-all')
  expect(await ui.find({ text: /다음을 실행하세요: \/plugin install review-all/ })).toBeDefined()
  await ui.unmount()
})

test('the spend report folds out of the pane', async ($, on) => {
  world(on)
  await $.turn.complete({
    reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1',
    usage: { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 },
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /오늘 \$0\.10 · 7일 \$0\.10/ })).toBeDefined()
  expect(await ui.find({ text: /\| Opus 5\.5 \|/ })).toBeUndefined()
  await ui.press({ key: 'report' })
  expect(await ui.find({ text: /\| Opus 5\.5 \|/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow band keeps the pick and its action, dropping the comparison', async ($, on) => {
  world(on)
  on('prompt.read', () => ({ value: { text: TASK, cursor: TASK.length } }))
  const narrow = { ...BAND, props: { ...BAND.props, bodyColumns: 60 } }
  const ui = await $.ui.mount({ ...narrow, surface: 'terminal' })
  await ui.press({ key: 'band:check' })
  expect(await ui.find({ text: /★ Opus 5\.5 · xhigh/ })).toBeDefined()
  expect(await ui.find({ key: 'band:apply' })).toBeDefined()
  expect(await ui.find({ text: /현재보다/ })).toBeUndefined()
  await ui.unmount()
  const wide = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await wide.find({ text: /현재보다 \$4\.9 추가/ })).toBeDefined()
  await wide.unmount()
})
