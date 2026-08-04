---
name: exposure-axis-check
description: 노출 규칙의 축(시군구·차량·시간대·거리 등)이나 판정 재료를 추가·수정할 때 반드시 도는 점검. 이 레포가 같은 방식으로 두 번 사고 낸 지점들의 목록.
---

# 노출 축·판정 재료 변경 점검

이 레포에서 **가장 비싸게 반복된 사고 두 가지**를 막기 위한 체크리스트다. 축을 하나
추가할 때마다 아래를 전부 확인한다. "한 곳만 고쳤는데 잘 되는 것처럼 보이는" 상태가
가장 위험하다 — 매니저 화면에서는 정상으로 보이고 지원자 쪽에서만 깨진다.

## 사고 패턴 1 — 판정 재료를 안 실어 보낸 지점이 남는다

`isExposed`/`matchesRule`는 한 곳(`lib/exposure.ts`)이지만, **재료를 select 해서
넘겨주는 쪽은 여러 곳**이고 각 select 문자열이 손으로 적혀 있다. 한 곳이라도 새 컬럼을
빼먹으면 그 경로에서만 조용히 fail-closed 된다.

M3(거리 축) 실제 사고: `interest`·`notify`가 `lat`/`lng`를 select 하지 않아, 반경 규칙
공고에 관심을 누른 사람이 **전원 "마감된 공고예요"** 를 받았다. 매니저 화면에는 아무
흔적이 없었다.

**판정·미리보기 지점 전체 (변경 시 전부 확인):**
- `app/api/pool/[token]/route.ts` — 지원자 카드 목록
- `app/api/pool/[token]/interest/route.ts` — 관심 누름
- `app/api/pool/[token]/notify/route.ts` — 알림 신청
- `app/api/admin/jobs/[id]/announce-targets/route.ts` — 대기자 안내 대상
- `app/api/admin/jobs/[id]/exposure/route.ts` — 공고별 노출 명단
- `app/api/admin/jobs/[id]/candidates/route.ts` · `.../[id]/route.ts`
- `app/api/admin/exposure/route.ts` · `.../exposure/impact/route.ts` · `.../exposure/bulk/route.ts`
- `lib/agent/engage.ts` — 에이전트 응대 중 판정

`ExposureApplicant`의 새 필드는 **optional로 두지 말고 required로** 만든다. 그래야
빼먹은 지점이 컴파일 에러로 드러난다. 단 `as unknown as` 이중 캐스트가 있으면 이
안전망이 무력화된다 — M3 사고의 진짜 원인이 그것이었다. 변경 후 `grep -rn 'as unknown as'`
로 해당 타입에 캐스트가 끼어 있지 않은지 확인한다.

## 사고 패턴 2 — 노출을 좁히는 경로 / 후보를 만드는 경로가 한 곳이 아니다

축을 추가하면 "이미 이야기 중인 사람이 규칙에서 탈락해 대화가 끊기는" 위험이 새로 생긴다.
보호(자동 include pin)는 **좁히는 쪽·만드는 쪽 양쪽 전부**에 걸려 있어야 한다.

- 좁히는 쪽: `app/api/admin/jobs/[id]/route.ts`(공고 수정) · `app/api/admin/exposure/bulk/route.ts`(일괄)
- 만드는 쪽: `app/api/pool/[token]/interest/route.ts` · `app/api/admin/jobs/[id]/candidates/route.ts`
  · `app/api/admin/inbox/[id]/classify/route.ts` · `lib/agent/router.ts`

M2 실제 사고: AI가 대화 중 `available_slots`를 기록하는 순간 시간대 규칙에서 사람이
빠졌다. 축을 추가할 때 **그 축의 값을 AI·매니저가 나중에 채우는 경로가 있는지** 확인하고,
있으면 `RULE_AXIS_FIELDS`에 넣어 보호가 걸리게 한다.

## 마무리 3줄

1. `npx tsc --noEmit` — required 필드가 실제로 안전망 역할을 했는지(에러가 뜨는지) 확인.
2. 프로덕션 실측: 새 규칙으로 대상이 몇 명 → 몇 명이 되는지 SQL로 숫자를 뽑는다.
   추정치를 보고하지 않는다(`.claude/skills/pre-merge-verify` 참조).
3. fail-closed가 맞다 — 단 매니저가 **'미확인'을 명시적으로 고를 수 있는 선택지**가
   같이 있어야 조용한 탈락이 아니다.
