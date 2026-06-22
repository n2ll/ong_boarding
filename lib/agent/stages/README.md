# `lib/agent/stages/` — 단계 모듈

후보 1명 = `job_candidates` 1행. 그 행의 `agent_stage`에 따라 여기 모듈 중 하나가 호출됨.

## 단계 흐름

```
exploration → screening → onboarding → active
                │           │
                └── paused (자동/수동) ←─ 매니저 [▶ 재개]
                    abort  (자격 미달 → status='부적합')
```

> UI는 2단계로 단순화(`screening`="스크리닝 중", `onboarding`/`active`="스크리닝 완료")지만 내부는 4단계.

## 파일별 책임

| 파일 | 단계 | 목적 |
|---|---|---|
| `exploration.ts` | exploration | 지원의사 미확정. 질문·정보 답변. "지원할게요" 시그널이면 advance |
| `screening.ts` | screening | 7항목 체크리스트 진행. 폼 미입력/엇갈리는 답 보완. 다 채워지면 advance |
| `onboarding.ts` | onboarding | 배민 커넥트 ID 1항목 수집. 받으면 슬랙 '준비 완료' + auto-advance(active) |
| `active.ts` | active | (자유 대화) — 매니저 손에 넘긴 이후 대화 처리 |

## 단계 모듈이 반환하는 것

```ts
interface StageResult {
  reply_text: string | null;        // 발송할 답장 (null이면 침묵)
  state_update: AgentState;         // 갱신된 체크리스트 부분만 (deep-merge)
  transition: StageTransition;      // stay | advance | pause | abort
  reasoning: string;                // 매니저 UI에 표시할 한 줄 근거
  usage?: { model, input_tokens, output_tokens, cache_read_input_tokens };  // 비용 추적용
}
```

## 공통 패턴

각 stage는 Claude `tool_use`로 구조화 출력 강제:
1. 시스템 프롬프트에 단계별 룰·예시 주입
2. 사용자 메시지에 `[지원자 정보] / [현재 체크리스트 상태] / [대화 히스토리] / [방금 받은 메시지]` 포맷팅
3. `{stage}_turn` tool 호출 → reply_text / checklist_update / transition / reasoning 받아옴
4. `data.usage`도 캡쳐해 `result.usage`에 첨부 (router가 ai_usage_daily에 적재)

## 가드 — AI가 잘못 판단해도 시스템이 교정

- screening: AI가 `advance`라 해도 7개 다 안 차면 강제 `stay` / 8개 다 찼는데 AI가 `stay`면 강제 `advance`
- onboarding: 배민 아이디가 이번 턴에 처음 채워지면 자동 active로 advance (AI가 결정 못해도)
- exploration: abort 조건은 명시적 거절만 (애매하면 stay)

## 추가/수정 가이드

새 단계 만들 때:
1. 새 파일 `stages/{name}.ts` — `Stage` 인터페이스 구현
2. `types.ts`의 `StageName`에 추가
3. `router.ts`의 `STAGES` 맵에 등록
4. `transitions.ts`에서 다른 단계로부터의 advance/pause/abort 부수효과 정의

자세한 흐름은 [docs/기능설명서.md](../../../docs/기능설명서.md) §4.
