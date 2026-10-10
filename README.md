# CSTOKEN FinOps for Claude Code

CSTOKEN 고객사 전용 FinOps 도구입니다. 작업에 맞는 **Claude 모델·effort**와 **스킬·플러그인**을 추천하고, 버튼 하나로 적용합니다. 턴마다 **지출과 절감액**도 기록합니다.

## 설치

Claude Code 터미널에서 아래 한 줄을 실행합니다.

```
/plugin install cstoken-finops --marketplace haminmarket/cstoken-finops
```

`Add marketplace?`가 나오면 `y`를 누르고, 설치 범위(user 권장)를 고릅니다.

그다음 CSTOKEN 담당자에게 받은 **조직 키**를 넣습니다. 방법은 둘 중 하나입니다.

- `/config` → cstoken-finops → `apiKey` (보안 저장소에 보관됨)
- 환경 변수 `CSTOKEN_FINOPS_API_KEY`

조직 키가 없으면 진단 기능은 동작하지 않습니다. 패널에 키 받는 방법이 안내됩니다.

Claude Code 2.1.295 이상이 필요합니다.

## 사용법

1. 채팅 입력창에 평소처럼 작업을 적습니다. 예: `10만 줄 규모의 코드 분석`
2. 입력창 위 **FinOps** 줄에서 **[진단]**을 누릅니다. 적어 둔 글은 그대로 남습니다.
3. 같은 줄에 추천이 뜹니다.
   ```
   FinOps  ★ Opus 5.5 · high ~$8.9 · 현재보다 $4.4 추가  [적용] [자세히] ↻ ×  · 세션 $0.42
   ```
4. **[적용]**을 누르면 `/model`로 모델이 바뀌고, 이후 메인 요청의 effort가 추천값으로 유지됩니다. **[해제]**를 누르면 원래 모델로 돌아갑니다.

**[자세히]**를 누르면 오른쪽 패널이 열립니다.

- **추천 카드**: ★모델·effort, 예상 비용과 “현재보다 얼마 절약/추가”, 이유 한 줄, [이 설정 적용]
- **다른 선택지**: 경제·품질 안, 그리고 지금 쓰는 모델을 비용 막대로 비교
- **작업 진단**: 종류·난이도·위험·우선 목표를 단어로 표시하고, 필요한 능력과 규모를 함께 표시
- **실행 팁**: 큰 작업을 나누는 방법, 리뷰 단계 등
- **스킬·플러그인**:
  - 설치된 스킬은 [입력창에 넣기]를 누르면 `/스킬명 작업 설명`이 채워집니다.
  - 새 도구는 품질·보안 배지와 함께 [설치 명령 넣기]로 바로 설치할 수 있습니다.
- **지출**: 오늘·7일 지출과 추천으로 아낀 금액. [모델별 리포트]를 누르면 표가 펼쳐집니다.

| 명령 | 하는 일 |
|---|---|
| `/finops` | 상세 패널을 엽니다 |
| `/finops <작업 설명>` | 바로 진단하고 최적안을 한 줄로 보여 줍니다 |
| `/finops report` | 오늘·최근 7일 지출을 모델별로 보여 주고, 추천 적용으로 아낀 금액과 오늘 남은 진단 횟수를 보여 줍니다 |

## 무엇을 추천하나

- **1차, 모델과 effort**: Haiku 5.5 · Sonnet 5.5 · Opus 5.5 · Fable 5.1 × effort low–max에서 경제·균형·품질 3안과 ★최적안을 냅니다.
  - 실패 위험이 높으면 상위 모델을 우선합니다.
  - 분류 신뢰도가 낮으면 현재 모델을 그대로 두라고 권합니다.
- **2차, 스킬·플러그인**:
  - 이미 설치된 명령·스킬·MCP 서버
  - [PluginWorld](https://www.pluginworld.ai)의 플러그인·MCP·스킬. 품질 점수와 보안 등급이 함께 표시되고, 보안 등급 C는 추천하지 않습니다. 설치 명령도 같이 보여 줍니다.
- 분류에는 Cloudflare Workers AI의 `clef-flash`를 씁니다.

## 개인정보

**CSTOKEN FinOps 서버(`finops.cstoken.net`)로 보내는 것**
- 작업 설명(4000자 이하)
- 고른 우선 목표
- 현재 모델 id
- 설치된 명령·스킬·MCP 서버의 이름과 한 줄 설명. `/config`의 `shareInstalled`를 끄면 보내지 않습니다.

**보내지 않는 것**
- 파일 내용, 대화 기록, 프로젝트의 `.env`

**서버에 남는 것**
- 조직 키의 해시와 일자별 진단 횟수만 저장합니다. 작업 내용은 기록하지 않습니다.

**PluginWorld로 가는 것**
- 작업에서 뽑은 영어 검색어 몇 개뿐입니다. 원문은 보내지 않습니다.

**이 PC에만 남는 것**
- 지출 원장(`/finops report`)은 Claude Code 플러그인 저장소에만 있고, 서버로 보내지 않습니다.

## 조직 키와 한도

- 조직 키는 CSTOKEN이 고객사별로 발급합니다. 일일 진단 한도는 계약에 따라 정해지고, 날짜는 UTC 기준입니다.
- 키를 잃어버렸거나 유출됐다면 CSTOKEN 담당자에게 알려 주세요. 기존 키를 폐기하고 새로 발급합니다.

## 비용 표시에 대해

추천 카드의 금액과 리포트의 지출은 **정가 기준 추정치**입니다. 구독 요금제, 할인, 캐시 적중률에 따라 실제 청구와 다를 수 있습니다. 세션 총액은 Claude Code가 집계한 값을 그대로 보여 줍니다.

## 개발

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

- `hooks/register.tsx`: 훅(세션 시작, `/finops`, `turn.step`·`turn.complete`, 패널·입력창 위 줄)
- `hooks/lib.ts`: 순수 함수(요청, 응답 검증, 원장, 표시 문구)
- `types/index.d.ts`: API 타입과 상태 계약

Data: [pluginworld.ai](https://www.pluginworld.ai)



## 문서

- [docs/STATUS.md](docs/STATUS.md): 검증된 것과 남은 것
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): 동작 구조와 데이터 경계
- [docs/DECISIONS.md](docs/DECISIONS.md): 설계 결정과 이유
- [CHANGELOG.md](CHANGELOG.md): 버전별 변경

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요. AI 코딩 에이전트가 이 저장소를 고칠 때 지킬 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.
