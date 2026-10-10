import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Applied, Diagnosis, ModelPick, ModelPrice, PriorityChoice, TurnTokens } from '../types'
import {
  COMMAND,
  DEFAULT_ENDPOINT,
  FALLBACK_PRICES,
  LEDGER_KEY,
  PANE,
  PRICES_KEY,
  PRIORITY_OPTIONS,
  REQUEST_TIMEOUT_MS,
  addTurn,
  bar,
  buildRequest,
  clip,
  dayOf,
  difficultyLabel,
  displayModel,
  emptyLedger,
  endpointUrl,
  failureText,
  firstSet,
  formatTokens,
  formatStars,
  formatUsd,
  installSteps,
  level,
  needWords,
  costBar,
  versusNow,
  isLedger,
  isPriorityChoice,
  isQuota,
  modelIdIn,
  p2,
  parseResponse,
  priceOf,
  pricesFrom,
  priorityLabel,
  reportText,
  riskLabel,
  roleLabel,
  rosterFrom,
  statusLine,
  suggestionLine,
  summarize,
  typeLabel,
} from './lib'

const phase = atom({ plugin: 'cstoken-finops', key: 'phase' } as const, 'idle')
const task = atom({ plugin: 'cstoken-finops', key: 'task' } as const, '')
const priority = atom({ plugin: 'cstoken-finops', key: 'priority' } as const, 'auto')
const diagnosis = atom({ plugin: 'cstoken-finops', key: 'diagnosis' } as const, null)
const failure = atom({ plugin: 'cstoken-finops', key: 'error' } as const, null)
const notice = atom({ plugin: 'cstoken-finops', key: 'notice' } as const, null)
const applied = atom({ plugin: 'cstoken-finops', key: 'applied' } as const, null)
const roster = atom({ plugin: 'cstoken-finops', key: 'roster' } as const, [])
const bandHidden = atom({ plugin: 'cstoken-finops', key: 'bandHidden' } as const, false)
const sessionUsd = atom({ plugin: 'cstoken-finops', key: 'sessionUsd' } as const, null)
const quota = atom({ plugin: 'cstoken-finops', key: 'quota' } as const, null)
const summary = atom({ plugin: 'cstoken-finops', key: 'summary' } as const, null)
const showReport = atom({ plugin: 'cstoken-finops', key: 'showReport' } as const, false)

const TITLE = 'CSTOKEN FinOps'

/** What to do without a key: FinOps is for CSTOKEN customers, who get an organisation key from CSTOKEN. */
const NO_KEY = 'CSTOKEN FinOps는 CSTOKEN 고객사 전용입니다. 담당자에게 받은 조직 키를 /config → cstoken-finops → apiKey에 넣으세요.'

/** Tasks the empty pane offers, so the first diagnosis is one press away. */
const EXAMPLES = ['10만 줄 규모의 코드 분석', 'README 오타 수정', '결제 시스템 보안 취약점 감사 후 수정 PR']

/** What the person set in /config for this plugin, read once at load. */
type Settings = { endpoint?: string; apiKey?: string; shareInstalled: boolean }

type Connection = { endpoint: string; apiKey?: string }

/**
 * Where the Worker is and the organisation key for it: /config first, then
 * the environment. CSTOKEN FinOps is for CSTOKEN customers, so there is no
 * key without one CSTOKEN issued.
 */
async function connection($: EngineInterface, settings: Settings): Promise<Connection> {
  const [envEndpoint, envKey, merged] = await Promise.all([
    $.env.get('CSTOKEN_FINOPS_ENDPOINT'),
    $.env.get('CSTOKEN_FINOPS_API_KEY'),
    $.settings.read().catch(() => ({})),
  ])
  const raw: unknown = (merged as { env?: unknown }).env
  const fromSettings = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const endpoint = firstSet(settings.endpoint, envEndpoint, fromSettings.CSTOKEN_FINOPS_ENDPOINT) ?? DEFAULT_ENDPOINT
  return { endpoint, apiKey: firstSet(settings.apiKey, envKey, fromSettings.CSTOKEN_FINOPS_API_KEY) }
}

/** The price table from the Worker, refreshed at most daily; the built-in table until it answers. */
async function prices($: EngineInterface, settings: Settings): Promise<Record<string, ModelPrice>> {
  const held: unknown = await $.store.get(PRICES_KEY).catch(() => undefined)
  const cached = typeof held === 'object' && held !== null ? (held as { day?: string; table?: Record<string, ModelPrice> }) : {}
  const today = dayOf(Date.now())
  if (cached.day === today && cached.table) return cached.table
  const { endpoint, apiKey } = await connection($, settings)
  if (apiKey) {
    const res = await $.http
      .fetch(endpointUrl(endpoint, '/v1/models'), { headers: { authorization: `Bearer ${apiKey}` } })
      .catch(() => null)
    const table = res?.ok ? pricesFrom(res.text) : null
    if (table) {
      await $.store.set(PRICES_KEY, { day: today, table })
      return table
    }
  }
  return cached.table ?? FALLBACK_PRICES
}

/**
 * Books one finished turn: its list-price cost under its model and, while an
 * applied pick ran it, the saving against the model the person started from.
 * Then the session total Claude Code keeps, for the band.
 */
async function record($: EngineInterface, settings: Settings, model: string, tokens: TurnTokens): Promise<void> {
  const table = await prices($, settings)
  const price = priceOf(model, table)
  if (price) {
    const held = await read($, applied)
    const baseline = held && modelIdIn(model) === held.model ? priceOf(held.previousModel, table) : undefined
    const stored: unknown = await $.store.get(LEDGER_KEY).catch(() => undefined)
    const day = dayOf(Date.now())
    const ledger = addTurn(isLedger(stored) ? stored : emptyLedger(), { day, model, tokens, price, baseline })
    await $.store.set(LEDGER_KEY, ledger)
    await update($, summary, () => summarize(ledger, day))
  }
  const usage = await $.session.usage().catch(() => undefined)
  if (usage?.cost) await update($, sessionUsd, () => usage.cost?.usd ?? null)
}

/** The report /finops report prints and the pane shows. */
async function report($: EngineInterface): Promise<string> {
  const stored: unknown = await $.store.get(LEDGER_KEY).catch(() => undefined)
  const ledger = isLedger(stored) ? stored : emptyLedger()
  const usage = await $.session.usage().catch(() => undefined)
  return reportText(summarize(ledger, dayOf(Date.now())), usage?.cost?.usd ?? null, await read($, quota))
}

/** Bumped by every diagnosis, so an answer that lands after a newer question is dropped. */
let asking = 0

/** Asks the Worker about one task and keeps the answer for the pane. */
async function diagnose($: EngineInterface, text: string, settings: Settings): Promise<Diagnosis | null> {
  const asked = text.trim()
  if (!asked) return null
  const ticket = ++asking
  await update($, task, () => asked)
  await update($, failure, () => null)
  await update($, notice, () => null)
  await update($, phase, () => 'loading')

  const fail = async (message: string) => {
    if (ticket !== asking) return null
    const model = await $.session.model().catch(() => undefined)
    await update($, failure, () => `${message}\n현재 모델(${displayModel(model)})을 그대로 쓰세요.`)
    await update($, phase, () => 'error')
    return null
  }

  const { endpoint, apiKey } = await connection($, settings)
  if (!apiKey) return fail(NO_KEY)

  const [commands, tools, currentModel, chosen] = await Promise.all([
    $.command.list().catch(() => []),
    $.tool.list().catch(() => []),
    $.session.model().catch(() => undefined),
    read($, priority),
  ])
  const items = rosterFrom(commands, tools, COMMAND)
  await update($, roster, () => items)
  const body = buildRequest({
    task: asked,
    priority: chosen,
    currentModel,
    roster: items,
    shareInstalled: settings.shareInstalled,
  })

  const startedAt = await $.clock.now()
  let res: Awaited<ReturnType<EngineInterface['http']['fetch']>> | null
  try {
    res = await Promise.race([
      $.http.fetch(endpointUrl(endpoint, '/v1/diagnose'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      }),
      $.clock.sleep(REQUEST_TIMEOUT_MS).then(() => null),
    ])
  } catch (err) {
    return fail(`진단 서버에 연결하지 못했습니다: ${clip(String(err), 120)}`)
  }
  if (res === null) return fail(`진단 서버가 ${REQUEST_TIMEOUT_MS / 1000}초 안에 답하지 않았습니다.`)
  if (!res.ok) return fail(failureText(res.status, res.text))
  const response = parseResponse(res.text)
  if (!response) return fail('진단 서버의 응답 형식이 올바르지 않습니다.')
  if (isQuota(response.meta.quota)) {
    const used = response.meta.quota
    await update($, quota, () => used)
  }

  const done: Diagnosis = {
    task: asked,
    priority: chosen,
    response,
    roundTripMs: (await $.clock.now()) - startedAt,
    at: Date.now(),
  }
  if (ticket !== asking) return done
  await update($, diagnosis, () => done)
  await update($, phase, () => 'done')
  return done
}

/** Diagnoses what the person has typed in the prompt box, leaving the draft where it is. */
async function diagnoseDraft($: EngineInterface, settings: Settings): Promise<void> {
  const { text } = await $.prompt.read()
  if (!text.trim() || text.trim().startsWith('/')) {
    await update($, notice, () => '채팅 입력창에 작업을 적은 뒤 진단을 누르세요.')
    return
  }
  await diagnose($, text, settings)
}

/**
 * Puts a tool into the prompt box for the person to send: a skill ahead of the
 * task already typed (so it runs on it), or one install command in place of
 * the draft. A second install step is said, to run once the first is done.
 */
async function useTool($: EngineInterface, text: string, isSkill: boolean, nextStep?: string): Promise<void> {
  const { text: draft } = await $.prompt.read()
  const asked = (await read($, task)) || draft.trim()
  const fill = isSkill ? `${text} ${draft.trim() || asked}`.trim() : text
  const { isFilled } = await $.prompt.fill({ text: fill, mode: 'replace' })
  await update($, notice, () =>
    !isFilled
      ? `입력창에 넣지 못했습니다. 직접 입력하세요: ${text}`
      : nextStep
        ? `입력창에 설치 1단계를 넣었습니다. Enter로 실행한 뒤 다음을 실행하세요: ${nextStep}`
        : isSkill
          ? `입력창에 ${text}를 넣었습니다. Enter로 실행하세요.`
          : '입력창에 설치 명령을 넣었습니다. Enter로 실행하세요.',
  )
}

/** Switches the session to a pick: the model by `/model`, the effort held by the turn.step hook. */
async function apply($: EngineInterface, pick: ModelPick): Promise<void> {
  const before = await $.session.model().catch(() => undefined)
  const held = await read($, applied)
  // Successive applies keep the model the person started from, so a release goes all the way back.
  const previousModel = held?.previousModel ?? before
  let isSwitched = modelIdIn(before) === pick.model
  if (!isSwitched) {
    try {
      await $.command.run({ command: 'model', args: pick.model })
    } catch {
      // A surface without /model may still take the /config row.
      await $.config.set({ key: 'model', value: pick.model }).catch(() => undefined)
    }
    isSwitched = modelIdIn(await $.session.model().catch(() => undefined)) === pick.model
  }
  const next: Applied = {
    model: pick.model,
    modelName: pick.modelName,
    effort: pick.effort,
    role: pick.role,
    ...(previousModel ? { previousModel } : {}),
    appliedAt: Date.now(),
  }
  await update($, applied, () => next)
  $.ui.status(statusLine(next))
  await update($, notice, () =>
    isSwitched
      ? `${pick.modelName} · effort ${pick.effort} 적용`
      : `effort ${pick.effort}는 적용했지만 모델 전환을 확인하지 못했습니다. /model ${pick.model} 을 직접 실행하세요.`,
  )
}

/** Lets the session go back: the effort hold ends and the model it started from comes back. */
async function release($: EngineInterface): Promise<void> {
  const held = await read($, applied)
  await update($, applied, () => null)
  $.ui.status(undefined)
  // An alias such as "opus" carries no id; /model takes it as it was shown.
  const back = modelIdIn(held?.previousModel) ?? held?.previousModel?.trim()
  if (held && back && back !== held.model) {
    const isBack = await $.command
      .run({ command: 'model', args: back })
      .then(() => true)
      .catch(() => false)
    await update($, notice, () =>
      isBack ? `해제: ${displayModel(back)}로 되돌렸습니다` : `해제했습니다. /model ${back} 로 되돌리세요.`,
    )
    return
  }
  await update($, notice, () => '해제했습니다')
}

/**
 * A pane beside the transcript where the person describes a task; the CSTOKEN
 * Worker classifies it with clef-flash and answers three model + effort picks
 * and the skills that fit. A press applies a pick: `/model` switches the
 * session's model and the `turn.step` hook holds the effort on main-thread
 * requests until the person releases it.
 *
 * Everything fails open: no key, no Worker, a timeout or a bad answer leaves
 * the session exactly as it was, and says so in the pane.
 */
export const register: Register = (on, options) => {
  const shouldAutoOpen = options.autoOpen !== false
  const settings: Settings = {
    endpoint: typeof options.endpoint === 'string' ? options.endpoint : undefined,
    apiKey: typeof options.apiKey === 'string' ? options.apiKey : undefined,
    shareInstalled: options.shareInstalled !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'finops',
      description: 'CSTOKEN FinOps: 작업에 맞는 Claude 모델·effort·스킬 추천과 비용 리포트 (report: 지출·절감 리포트)',
      argumentHint: '[작업 설명 | report]',
    })
    // A reload keeps the state: put the held pick back on the status line.
    const held = await read($, applied)
    if (held) $.ui.status(statusLine(held))
    const stored: unknown = await $.store.get(LEDGER_KEY).catch(() => undefined)
    if (isLedger(stored)) await update($, summary, () => summarize(stored, dayOf(Date.now())))
    if (shouldAutoOpen) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'finops' }, async ($, e) => {
    if (e.args.trim() === 'report') return { text: await report($) }
    await update($, bandHidden, () => false)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    const asked = e.args.trim()
    if (!asked) {
      return { text: opened.isPlaced ? 'CSTOKEN FinOps 패널을 열었습니다.' : `CSTOKEN FinOps 패널이 열릴 자리가 없습니다: ${opened.reason}` }
    }
    const done = await diagnose($, asked, settings)
    if (!done) return { text: (await read($, failure)) ?? '진단하지 못했습니다.' }
    const rec = done.response.recommendation
    const lead = rec.picks.find(p => p.role === rec.primary)
    const head = lead ? `★ ${lead.modelName} · ${lead.effort} (~${formatUsd(lead.estimate.usd)})` : '★ 현재 설정 유지'
    return { text: `CSTOKEN FinOps 진단: ${head} — ${rec.primaryReason}` }
  })

  // Holds the applied effort on the main loop's requests to the applied model.
  // A model the person picked since then, or a subagent, is left alone.
  // Books every finished turn (the main loop's and subagents' alike) into the spend ledger.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.usage) {
      const { model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = e.usage
      await record($, settings, model, { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }).catch(
        () => undefined,
      )
    }
    return done
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const held = await read($, applied)
    if (!held || modelIdIn(e.model) !== held.model || e.effort === held.effort) return yield* next(e)
    return yield* next({ ...e, effort: held.effort })
  })

  // The line above the prompt: one answer and one main action at a time.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [isHidden, now, answer, failed, said, held, spent] = await Promise.all([
      read($, bandHidden),
      read($, phase),
      read($, diagnosis),
      read($, failure),
      read($, notice),
      read($, applied),
      read($, sessionUsd),
    ])
    if (isHidden || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // Room decides how much rides along: the comparison and the session total go first on a narrow line.
    const isRoomy = e.props.bodyColumns >= 90

    const check = <Button key="band:check" variant="primary" label="진단" onPress={() => void diagnoseDraft($, settings)} />
    const again = <Button key="band:again" plain label="↻" onPress={() => void diagnoseDraft($, settings)} />
    const more = (
      <Button key="band:more" label="자세히" onPress={() => void $.ui.open({ id: PANE, title: TITLE, focus: true })} />
    )
    const hide = <Button key="band:hide" plain label="×" onPress={() => void update($, bandHidden, () => true)} />
    const row = (...children: RenderChildren[]) => (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text bold color="claude">
          FinOps
        </Text>
        {children}
        {isRoomy && spent !== null ? <Text dimColor>· 세션 {formatUsd(spent)}</Text> : null}
      </Box>
    )

    if (now === 'loading') return row(<Text color="suggestion">작업을 분석하는 중…</Text>, hide)
    if (held) {
      return row(
        <Text color="success">
          ✓ {held.modelName} · {held.effort} 적용 중
        </Text>,
        <Button key="band:release" label="해제" onPress={() => void release($)} />,
        again,
        hide,
      )
    }
    if (now === 'error' && failed) {
      return row(<Text color="error">{clip(failed.split('\n')[0] ?? failed, isRoomy ? 80 : 44)}</Text>, again, hide)
    }
    if (answer) {
      const rec = answer.response.recommendation
      const lead = rec.picks.find(p => p.role === rec.primary)
      if (!lead) {
        return row(
          <Text>
            <Text bold>현재 설정 유지</Text> <Text dimColor>· 작업 설명이 모호해요</Text>
          </Text>,
          more,
          again,
          hide,
        )
      }
      const vs = versusNow(lead.estimate.usd, rec.current?.estimate.usd)
      return row(
        <Text>
          <Text bold>
            ★ {lead.modelName} · {lead.effort}
          </Text>{' '}
          <Text dimColor>~{formatUsd(lead.estimate.usd)}</Text>
          {isRoomy && vs && vs.tone !== 'same' ? (
            <Text color={vs.tone === 'save' ? 'success' : 'warning'}> · {vs.text}</Text>
          ) : null}
        </Text>,
        <Button key="band:apply" variant="primary" label="적용" onPress={() => void apply($, lead)} />,
        more,
        again,
        hide,
      )
    }
    return row(<Text dimColor>{said ?? '작업을 적고 진단을 누르면 맞는 모델을 추천해요'}</Text>, check, hide)
  })

  on('ui.render', { component: 'Pane', requestId: 'finops' }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = el
    const Input = 'Input' in el ? el.Input : undefined
    const Select = 'Select' in el ? el.Select : undefined

    const [now, asked, chosen, answer, failed, said, held, spent, used, totals, isReportOpen] = await Promise.all([
      read($, phase),
      read($, task),
      read($, priority),
      read($, diagnosis),
      read($, failure),
      read($, notice),
      read($, applied),
      read($, sessionUsd),
      read($, quota),
      read($, summary),
      read($, showReport),
    ])

    const choose = (value: string) => {
      if (!isPriorityChoice(value)) return
      void (async () => {
        await update($, priority, () => value as PriorityChoice)
        // A changed goal re-asks about the task on screen; the Worker answers it from cache.
        const last = await read($, task)
        if (last && (await read($, diagnosis))) await diagnose($, last, settings)
      })()
    }

    // Header: the product and the two numbers a FinOps user checks first.
    const quotaText = used ? (used.limit === null ? `오늘 진단 ${used.used}회` : `오늘 진단 ${used.used}/${used.limit}`) : null
    const header = (
      <Box flexDirection="row" gap={1}>
        <Text bold color="claude">
          CSTOKEN FinOps
        </Text>
        <Text dimColor>{[spent !== null ? `세션 ${formatUsd(spent)}` : null, quotaText].filter(Boolean).join(' · ')}</Text>
      </Box>
    )

    const form = (
      <Box flexDirection="column">
        {Input ? (
          <Input
            key="task"
            placeholder="어떤 작업인가요? 예: 10만 줄 규모의 코드 분석"
            value={asked}
            submitLabel="진단"
            autoFocus
            onSubmit={value => void diagnose($, value, settings)}
          />
        ) : (
          <Text dimColor>이 화면에는 입력창이 없습니다. /finops 작업 설명 으로 진단하세요.</Text>
        )}
        {Select ? (
          <Select key="priority" label="우선" value={chosen} options={PRIORITY_OPTIONS} onSelect={choose} />
        ) : null}
      </Box>
    )

    const heldRow = held ? (
      <Box flexDirection="row" gap={1}>
        <Text color="success">
          ✓ {held.modelName} · effort {held.effort} 적용 중
        </Text>
        <Button key="release" label="해제" onPress={() => void release($)} />
      </Box>
    ) : null

    // Spend: today, the week, and what the applied picks saved; the full report folds out.
    const spend = (
      <Box flexDirection="column">
        <Text bold>지출</Text>
        {totals ? (
          <Text>
            오늘 {formatUsd(totals.todayUsd)} · 7일 {formatUsd(totals.weekUsd)} ·{' '}
            {totals.weekSavedUsd >= 0 ? (
              <Text color="success">추천으로 {formatUsd(totals.weekSavedUsd)} 절약</Text>
            ) : (
              <Text color="warning">품질 선택으로 {formatUsd(-totals.weekSavedUsd)} 추가</Text>
            )}
          </Text>
        ) : (
          <Text dimColor>작업이 끝날 때마다 모델별 지출과 절약액을 기록합니다.</Text>
        )}
        {totals ? (
          <Button
            key="report"
            plain
            label={isReportOpen ? '▾ 리포트 접기' : '▸ 모델별 리포트'}
            onPress={() => void update($, showReport, open => !open)}
          />
        ) : null}
        {totals && isReportOpen ? <Markdown text={reportText(totals, spent, used).split('\n').slice(2).join('\n')} /> : null}
      </Box>
    )

    const status =
      now === 'loading' ? (
        <Text color="suggestion">작업을 분석하는 중… (clef-flash)</Text>
      ) : now === 'error' && failed ? (
        <Box flexDirection="column">
          <Text color="error">{failed.split('\n')[0]}</Text>
          {failed.includes('\n') ? <Text dimColor>{failed.split('\n').slice(1).join(' ')}</Text> : null}
        </Box>
      ) : null

    if (!answer) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          {header}
          {form}
          {status}
          {now === 'idle' ? (
            <Box flexDirection="column">
              <Text dimColor>이렇게 시작해 보세요</Text>
              {EXAMPLES.map((example, i) => (
                <Button key={`example:${i}`} plain label={`› ${example}`} onPress={() => void diagnose($, example, settings)} />
              ))}
              <Text dimColor>채팅 입력창 위 FinOps 줄의 [진단]으로도 바로 진단할 수 있어요.</Text>
            </Box>
          ) : null}
          {heldRow}
          {said ? <Text dimColor>{said}</Text> : null}
          {spend}
        </Box>
      )
    }

    const { classification: c, recommendation: rec, tools, meta } = answer.response
    const lead = rec.picks.find(p => p.role === rec.primary)
    const nowUsd = rec.current?.estimate.usd
    const dearest = Math.max(...rec.picks.map(p => p.estimate.usd), nowUsd ?? 0)
    const isHeldPick = (p: ModelPick) => held?.model === p.model && held.effort === p.effort

    const tone = (vs: ReturnType<typeof versusNow>) => (vs?.tone === 'save' ? 'success' : vs?.tone === 'add' ? 'warning' : undefined)

    // The answer first: one card with the pick, its price against today's model, why, and the action.
    const hero = lead ? (
      <Box key="hero" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Text dimColor>★ 추천 · {roleLabel(lead.role)}</Text>
        <Text bold>
          {lead.modelName} · effort {lead.effort}
        </Text>
        <Text>
          예상 {formatUsd(lead.estimate.usd)}
          {(() => {
            const vs = versusNow(lead.estimate.usd, nowUsd)
            return vs ? <Text color={tone(vs)}> · {vs.text}</Text> : null
          })()}
        </Text>
        <Text dimColor>{rec.primaryReason}</Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key={`apply:${lead.role}`}
            variant="primary"
            label={isHeldPick(lead) ? '✓ 적용됨' : '이 설정 적용'}
            onPress={() => void apply($, lead)}
          />
          {held ? <Button key="release" label="해제" onPress={() => void release($)} /> : null}
        </Box>
      </Box>
    ) : (
      <Box key="hero" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Text dimColor>★ 추천</Text>
        <Text bold>현재 설정 유지 · {displayModel(rec.keepCurrent?.model)}</Text>
        <Text dimColor>작업 설명이 모호해 판단을 미뤘어요. 무엇을, 얼마나 큰 규모로 하는지 적으면 정확해집니다.</Text>
      </Box>
    )

    // The other options, priced as bars against the dearest so the trade-off reads at a glance.
    const others = rec.picks.filter(p => p !== lead)
    const options = (
      <Box flexDirection="column">
        <Text bold>{lead ? '다른 선택지' : '선택지'}</Text>
        {others.map(p => {
          const vs = versusNow(p.estimate.usd, nowUsd)
          return (
            <Box key={`pick:${p.role}`} flexDirection="row" gap={1}>
              <Text dimColor>{roleLabel(p.role)}</Text>
              <Text>
                {p.modelName} · {p.effort}
              </Text>
              <Text dimColor>
                {costBar(p.estimate.usd, dearest, 8)} {formatUsd(p.estimate.usd)}
              </Text>
              {vs && vs.tone !== 'same' ? <Text color={tone(vs)}>{vs.tone === 'save' ? '▼' : '▲'}</Text> : null}
              <Button key={`apply:${p.role}`} label={isHeldPick(p) ? '✓' : '적용'} onPress={() => void apply($, p)} />
            </Box>
          )
        })}
        {rec.current ? (
          <Text dimColor>
            현재 {rec.current.modelName} · {rec.current.effort} {costBar(rec.current.estimate.usd, dearest, 8)}{' '}
            {formatUsd(rec.current.estimate.usd)}
          </Text>
        ) : null}
        <Text dimColor>비용은 정가 기준 대략치예요(캐시 미반영).</Text>
      </Box>
    )

    // What the task is, in words: kind, difficulty, risk, what it needs, how big.
    const chips = [
      typeLabel(c.taskType.value),
      `난이도 ${difficultyLabel(c.difficulty.value)}`,
      `위험 ${riskLabel(c.risk.value)}`,
      `${priorityLabel(c.priority.value)} 우선${c.priority.source === 'user' ? '(지정)' : ''}`,
    ]
    const needs = needWords(c.needs)
    const reading = (
      <Box flexDirection="column">
        <Text bold>작업 진단</Text>
        <Text>{chips.join(' · ')}</Text>
        {needs.length > 0 || c.scale ? (
          <Text dimColor>
            {[needs.length > 0 ? `필요: ${needs.join(', ')}` : null, c.scale ? `규모 ${c.scale.text} ≈ ${formatTokens(c.scale.tokens)} 토큰` : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : null}
        <Text dimColor>
          {c.source === 'clef-flash' ? 'clef-flash' : '규칙 기반(분류 모델 응답 없음)'} · 신뢰도 {level(c.confidence)} ·{' '}
          {(answer.roundTripMs / 1000).toFixed(1)}초
        </Text>
      </Box>
    )

    const tips =
      rec.strategy.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>실행 팁</Text>
          <Markdown text={rec.strategy.map((s, i) => `${i + 1}. ${s}`).join('\n')} />
        </Box>
      ) : null

    // Tools: what is installed comes first and is one press from the prompt; new ones carry their badges.
    const isToolLight = tools.needed < 0.3
    const fromMarket = tools.catalog.some(s => s.market === 'pluginworld')
    const toolBox = (
      <Box flexDirection="column">
        <Text bold>스킬 · 플러그인</Text>
        {isToolLight ? <Text dimColor>이 작업은 추가 도구 없이도 충분해요.</Text> : null}
        {tools.installed.map(s => (
          <Box key={`have:${s.name}`} flexDirection="row" gap={1}>
            <Text bold>{s.kind === 'mcp' ? `MCP ${s.displayName}` : `/${s.displayName}`}</Text>
            <Text dimColor>설치됨 · {clip(s.description, 48)}</Text>
            {s.kind !== 'mcp' ? (
              <Button key={`use:${s.name}`} plain label="› 입력창에 넣기" onPress={() => void useTool($, `/${s.displayName}`, true)} />
            ) : null}
          </Box>
        ))}
        {!isToolLight
          ? tools.catalog.map((s, i) => {
              const steps = installSteps(s.install)
              const badges = [
                s.qualityScore !== undefined ? `품질 ${Math.round(s.qualityScore)}` : null,
                s.securityGrade ? `보안 ${s.securityGrade}` : null,
                s.stars ? `★${formatStars(s.stars)}` : null,
                s.verified ? '검증됨' : '미검증',
              ].filter(Boolean)
              return (
                <Box key={`new:${s.name}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text bold>{s.displayName}</Text>
                    <Text dimColor>{badges.join(' · ')}</Text>
                  </Box>
                  <Text dimColor>{clip(s.description, 90)}</Text>
                  <Box flexDirection="row" gap={1}>
                    {steps[0] ? (
                      <Button
                        key={`install:${i}`}
                        plain
                        label={steps.length > 1 ? '› 설치 1단계 넣기' : '› 설치 명령 넣기'}
                        onPress={() => void useTool($, steps[0]!, false, steps[1])}
                      />
                    ) : null}
                    {s.url ?? s.source ? <Link href={(s.url ?? s.source)!} label="자세히" /> : null}
                  </Box>
                </Box>
              )
            })
          : null}
        {!isToolLight && tools.installed.length === 0 && tools.catalog.length === 0 ? (
          <Text dimColor>맞는 도구를 찾지 못했어요.</Text>
        ) : null}
        {!isToolLight && fromMarket ? (
          <Text dimColor>
            새 도구 출처 <Link href="https://www.pluginworld.ai" label="pluginworld.ai" /> · 보안 등급 C는 제외
          </Text>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {header}
        {form}
        {status}
        {hero}
        {options}
        {reading}
        {tips}
        {toolBox}
        {heldRow && !lead ? heldRow : null}
        {said ? <Text dimColor>{said}</Text> : null}
        {spend}
        {meta.warnings.length > 0 ? <Text dimColor>참고: {meta.warnings.join(' / ')}</Text> : null}
      </Box>
    )
  })
}
