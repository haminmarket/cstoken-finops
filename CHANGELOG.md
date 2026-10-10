# Changelog

형식: [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) · 버전: [SemVer](https://semver.org/lang/ko/)

## [0.2.2] - 2026-10-10

### Fixed
- 진단 전에 `/finops report`를 실행하면 “오늘 진단 n회” 줄이 빠지던 문제. 이제 `GET /v1/usage`에서 직접 가져옵니다.

## [0.2.1] - 2026-10-10

### Added
- MIT 라이선스(`LICENSE`).
- AI 코딩 에이전트용 작업 규칙 `AGENTS.md`.

## [0.2.0] - 2026-10-10

첫 고객 배포판.

### Added
- 입력창 위 FinOps 줄: 입력 중인 작업을 [진단] → `★ 모델 · effort ~$ · 현재보다 …` → [적용]/[해제].
- 오른쪽 패널: 추천 카드, 비용 막대로 비교하는 다른 선택지(현재 모델 포함), 단어로 보여 주는 작업 진단, 실행 팁, 스킬·플러그인(설치된 것은 [입력창에 넣기], 새것은 품질·보안 배지와 [설치 명령 넣기]), 지출 요약과 펼치는 리포트.
- `/finops`, `/finops <작업 설명>`, `/finops report`.
- 지출 원장: 턴마다 모델별 정가 지출과 추천 적용 절감액 기록(이 PC에만 저장).
- 조직 키: `/config` → `apiKey`(보안 저장소) 또는 `CSTOKEN_FINOPS_API_KEY`.

### Security
- 고객사 전용: 조직 키 없이는 동작하지 않습니다.
- 프로젝트의 `.env`를 읽지 않습니다.
