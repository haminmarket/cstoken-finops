import type { DiagnoseResponse } from '../types'

/** A Worker answer shaped like the live one for "10만 줄 규모의 코드 분석". */
export const CODE_ANALYSIS: DiagnoseResponse = {
  version: '2026-10-10',
  locale: 'ko',
  classification: {
    taskType: {
      value: 'analysis',
      confidence: 0.72,
      probabilities: { development: 0.04, documentation: 0.03, analysis: 0.89, automation: 0.04 },
    },
    difficulty: { value: 'complex', score: 1.95, confidence: 0.88 },
    risk: { value: 'medium', score: 1.28, confidence: 0.09 },
    needs: { longContext: 0.9, reasoning: 0.8, tools: 0.69, vision: 0.01 },
    priority: { value: 'accuracy', confidence: 0.34, source: 'model' },
    scale: { text: '10만 줄', unit: 'lines', amount: 100_000, tokens: 1_200_000 },
    source: 'clef-flash',
    confidence: 0.63,
  },
  recommendation: {
    primary: 'balanced',
    primaryReason: '난이도에 맞춘 최소 충분 모델',
    picks: [
      {
        role: 'economy',
        model: 'claude-sonnet-5-5',
        modelName: 'Sonnet 5.5',
        effort: 'xhigh',
        estimate: { inputTokens: 2_007_000, outputTokens: 69_120, usd: 4.71 },
        reasons: ['한 단계 아래 Sonnet 5.5, effort를 한 단계 올려 보완'],
      },
      {
        role: 'balanced',
        model: 'claude-opus-5-5',
        modelName: 'Opus 5.5',
        effort: 'xhigh',
        estimate: { inputTokens: 2_007_000, outputTokens: 69_120, usd: 9.41 },
        reasons: ['필요 능력 3.3/4 → Opus 5.5', '난이도 복잡 · 추론 0.80 → effort xhigh'],
      },
      {
        role: 'quality',
        model: 'claude-fable-5-1',
        modelName: 'Fable 5.1',
        effort: 'xhigh',
        estimate: { inputTokens: 2_007_000, outputTokens: 69_120, usd: 23.5 },
        reasons: ['한 단계 위 Fable 5.1로 실패 위험 축소'],
      },
    ],
    current: {
      model: 'claude-sonnet-5-5',
      modelName: 'Sonnet 5.5',
      effort: 'high',
      estimate: { inputTokens: 2_007_000, outputTokens: 46_080, usd: 4.47 },
    },
    strategy: ['자료 약 120만 토큰: 1M 컨텍스트를 넘어 한 번에 읽을 수 없습니다. 디렉터리·모듈 단위로 나눠 처리하세요'],
    confidence: 0.63,
  },
  tools: {
    needed: 0.71,
    installed: [
      { name: 'code-review', displayName: 'code-review', kind: 'command', installed: true, score: 0.42, description: 'Review the current diff for correctness bugs' },
    ],
    catalog: [
      {
        name: 'feature-dev',
        displayName: 'feature-dev',
        kind: 'plugin',
        installed: false,
        score: 0.31,
        description: 'Guided feature development with codebase exploration',
        verified: false,
        reviewedBy: 'anthropic',
        market: 'pluginworld',
        stars: 42,
        qualityScore: 78.6,
        securityGrade: 'A',
        url: 'https://www.pluginworld.ai/plugins/claude-code/ncoevoet/claude-review-all',
        install: '/plugin marketplace add ncoevoet/claude-review-all\n/plugin install review-all',
      },
    ],
  },
  meta: { classifier: 'clef-flash', latencyMs: 640, inputTokens: 2100, modelTableVersion: '2026-10-06', warnings: [] },
}
