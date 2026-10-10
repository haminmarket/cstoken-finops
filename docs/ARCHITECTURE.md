# 구조

CSTOKEN FinOps는 두 부분으로 나뉩니다. 이 저장소는 **클라이언트(Claude Code 모드)** 하나만 담습니다.

| 구성 요소 | 위치 | 공개 | 역할 |
|---|---|---|---|
| `cstoken-finops` 모드 | 이 저장소 | 공개 (MIT) | 화면(입력창 위 줄, 패널), 설치 목록 수집, [적용]/[해제], 지출 원장 |
| `cstoken-finops` Worker | Cloudflare Workers, `https://finops.cstoken.net` | 비공개 | 인증·한도, clef-flash 분류, 추천 엔진, PluginWorld 검색, 가격표 |
| D1 `cstoken-finops` | Cloudflare D1 | 비공개 | 조직 키 해시, 일자별 사용량 |

## 진단 한 번의 흐름

```
사용자: 입력창에 작업을 적고 [진단]
  │
  ▼  모드 (register.tsx: diagnoseDraft → diagnose)
  │   - $.prompt.read()로 입력창 글을 읽음 (지우지 않음)
  │   - $.command.list() + $.tool.list() → 설치 목록(이름·한 줄 설명, 최대 200개)
  │   - $.session.model() → 현재 모델 id
  │   - POST https://finops.cstoken.net/v1/diagnose  (Bearer 조직 키, 9초 제한)
  │
  ▼  Worker
  │   1. 인증(키 해시 조회) → 일일 한도 차감
  │   2. 규칙 전처리: 규모 추출("10만 줄" → 120만 토큰), 언어, 영어 검색어
  │   3. 병렬 실행
  │      - clef-flash 1회: 작업 분류 8문항 + 설치 도구 선택 (24시간 캐시)
  │      - PluginWorld 검색 1회 → 후보 순위 clef-flash 1회 → 상위 3개만 상세(설치 명령)
  │   4. 추천 엔진: 4개 모델 × effort 5단계 → 경제·균형·품질 3안, ★최적안, 현재 모델 비용
  │
  ▼  모드
      - 응답 형식 검증(parseResponse) → $.state에 저장 → 입력창 위 줄·패널이 다시 그려짐
```

## [적용]과 [해제]

- **[적용]**은 `$.command.run({ command: 'model', args: <id> })`로 모델을 바꿉니다. 실패하면 `$.config.set({ key: 'model' })`을 시도합니다. 그다음 `applied` 상태를 저장합니다.
- **effort 유지**: `turn.step` 훅이 메인 스레드에서 적용한 모델로 가는 요청의 `effort`를 추천값으로 덮어씁니다. 서브에이전트나, 적용 뒤 사람이 직접 바꾼 모델에는 손대지 않습니다.
- **[해제]**는 `applied`를 지우고, 적용 전 모델로 `/model`을 되돌립니다.

## 지출 원장

- `turn.complete` 훅이 매 턴의 `usage`(모델 id, 입력·출력·캐시 읽기·캐시 쓰기 토큰)를 받아 정가로 계산하고 `$.store`의 `ledger.v1`에 일자별로 쌓습니다(30일 보관).
- 가격표는 `GET /v1/models`에서 하루 한 번 받아 `prices.v1`에 둡니다. 실패하면 `FALLBACK_PRICES`를 씁니다.
- [적용] 중인 턴은 적용 전 모델로 같은 토큰을 썼을 때의 비용과 비교해 절감액을 계산합니다. 음수면 품질 선택으로 추가된 지출입니다.
- 원장은 사용자 PC에만 있습니다. 서버로 보내지 않습니다.

## 화면 구성

| 위치 | 엔진 컴포넌트 | 내용 |
|---|---|---|
| 입력창 위 한 줄 | `AbovePrompt` | 상태마다 주 동작 하나: [진단] → `★ 모델 · effort ~$ · 현재보다 …` [적용] [자세히] ↻ × |
| 오른쪽 패널 | `Pane` (id `finops`) | 추천 카드 → 다른 선택지(비용 막대) → 작업 진단 → 실행 팁 → 스킬·플러그인 → 지출 |
| 상태줄 | `$.ui.status` | 적용 중일 때 `FinOps ▸ 모델 · effort` |
| 명령 | `/finops` | 인자 없음: 패널 / 작업 설명: 즉시 진단 / `report`: 지출 리포트 |

## 보내는 것과 남는 것

| 데이터 | 어디로 | 비고 |
|---|---|---|
| 작업 설명(4000자 이하), 우선 목표, 현재 모델 id | Worker | 서버 로그에는 길이·지연·상태만 기록 |
| 설치된 명령·스킬·MCP 이름과 한 줄 설명 | Worker | `shareInstalled`를 끄면 보내지 않음 |
| 영어 검색어 몇 개 | PluginWorld | 작업 원문은 보내지 않음 |
| 키 해시, 일자별 진단 수·토큰 | D1 | 원래 키나 IP는 저장하지 않음 |
| 지출 원장, 가격표 캐시 | 사용자 PC(`$.store`) | 서버로 보내지 않음 |
| 파일 내용, 대화 기록, `.env` | 어디에도 보내지 않음 | |
