import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { geocodeAddress } from "@/lib/kakao-geocode";
import { sendSms } from "@/lib/solapi";
import { ensureDanggeunSystemJob } from "@/lib/agent/danggeun-job";
import { ensureBaeminSystemJob } from "@/lib/agent/baemin-job";
import { getSystemMessage, fillTemplate } from "@/lib/agent/system-messages";
import { gatherLiveJobLinks } from "@/lib/candidate-links";
import { gatherMessagePreviews, RECENT_MANUAL_MS } from "@/lib/message-preview";

export const dynamic = "force-dynamic";

// 매니저가 수기로 INSERT 가능한 컬럼 화이트리스트 (시스템 컬럼 제외)
const CREATE_FIELDS = new Set([
  "name", "phone", "birth_date", "location",
  "own_vehicle", "license_type", "vehicle_type",
  "branch1", "branch2", "branch",
  "work_hours", "available_date", "self_ownership",
  "introduction", "experience",
  "source", "status", "filter_pass", "note", "memo",
  "start_date", "confirmed_slot", "confirmed_branch", "current_branch",
  "churn_reason", "marketing_consent", "kakao_channel_friend",
]);

const VALID_STATUS_SET = new Set(["스크리닝 전", "스크리닝 중", "스크리닝 완료", "기타", "확정인력", "대기자", "부적합", "이탈"]);
const VALID_SLOT_SET = new Set(["평일오전", "평일오후", "주말오전", "주말오후"]);

function validConfirmedSlot(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const tokens = v.split(",").map((t) => t.trim()).filter(Boolean);
  return tokens.every((t) => VALID_SLOT_SET.has(t));
}

// 목록(요약) 응답 컬럼. 무거운 자유텍스트(introduction/screening/note/memo/churn_reason)는
// 목록에서 쓰이지 않으므로 제외해 페이로드를 줄인다. 전체 행은 상세 엔드포인트(/[id])에서 제공.
const LIST_COLUMNS = [
  // 아래 11개를 2026-08-14에 걷어냈다 — 목록 소비처 8곳(대시보드·파이프라인·리포트·
  // 슬롯보드·답장큐·지점·자동화·공고탭 피커) 전수 대조에서 참조 0건이었다:
  //   license_type · self_ownership · kakao_channel_friend · available_date · filter_pass
  //   bname · sort_order · branch2 · churned_at · start_date · availability_updated_at
  // 헷갈리기 쉬운 것 — SlotBoard의 sort_order는 '지점'의 것이고, Jobs의 start_date는
  // '공고'의 것이다. Pipeline의 churned_at은 주석에만 나오고,
  // availability_updated_at은 CardData에 담기만 하고 읽는 곳이 없었다(그 필드도 함께 지웠다).
  // 지원자 상세 패널은 별도 상세 GET을 쓰므로 이 목록과 무관하다.
  "id", "created_at", "name", "birth_date", "phone", "location",
  "own_vehicle", "vehicle_type",
  "branch1", "work_hours", "experience", "status", "branch", "source", "last_message_at", "confirmed_slot", "confirmed_branch", "current_branch", "baemin_id", "guide_sent", "onboarding_call_status", "sigungu", "sido", "lat", "lng", "geo_precision",
  // 파일럿 축 — 가용성 필터·수신거부 표시·임포트 구분에 필수 (없으면 UI 필터가 조용히 0명이 된다)
  "availability", "sms_opt_out_at", "airtable_record_id",
  // 재컨택 선별 정확도 — 발송가능 판정(맞춤링크 토큰)·원지원 신선도 정렬/코호트 필터
  "access_token", "applied_at",
  // 답장 큐 공고별 필터 — 진행 중 공고 포인터
  "current_job_id",
  // 희망 시간대 축 — 자기 신고 값(work_hours보다 우선). 없으면 조건 바 '희망 근무'가 옛 값으로 판정된다.
  "available_slots",
].join(", ");

/**
 * `?scope=live` — 실시간 응대 화면이 읽는 컬럼만.
 *
 * 행은 한 명도 줄이지 않는다. 컬럼만 줄인다.
 * 실측(실제 전송량, gzip): 기본 응답 95KB → 이 스코프 22KB.
 * (원본 JSON은 689KB → 189KB지만 그 숫자로 판단하지 말 것 — 압축이 걸려 나간다.
 *  같은 값이 649번 반복되는 컬럼은 gzip이 거의 0으로 만들고, 자유텍스트만 그대로 남는다.)
 *
 * 행을 좁히지 않는 이유: 실시간 응대 화면은 좌측에 50명만 그리지만, 서버가 행을 자르면
 * (1) 확정 직후 status가 '확정인력'으로 바뀌는 순간 우측 상세가 사라져 만남장소 안내를
 * 못 보내고, (2) 인계 큐가 마감·시스템 공고 건을 의도적으로 싣는데 그 사람들이 목록에
 * 없으면 카드를 눌러도 대화가 안 열리고, (3) 이 화면엔 '서버가 목록을 잘랐다'는 표시가
 * 없어서 빈 목록이 "모두 응대했어요 👍"라는 정상 화면으로 나온다.
 * 행 좁히기의 추가 이득은 22KB→2KB뿐인데 위험은 전부 그쪽에 있다.
 *
 * 여기 목록은 LiveConsole의 Applicant 인터페이스와 1:1로 맞춘다 —
 * 그 파일은 동적 필드 접근이 없어서 이 목록이 곧 필요 필드 전량이다.
 * 필드를 하나 추가할 땐 양쪽을 같이 고칠 것.
 */
/**
 * `?scope=rollup` — 숫자만 그리는 집계 화면 전용(리포트 · 슬롯보드 · 지점 · 자동화).
 *
 * 이 네 화면은 지원자를 **한 명도 나열하지 않는다.** 카운트·분모·추이만 그린다.
 * 그런데 지금까지 649명의 이름·전화번호·주소·경력을 전부 받고 있었다.
 * route.ts가 access_token에 대해 이미 같은 논리를 적어 뒀다("649명분이 통째로 노출된 셈") —
 * 전화번호·주소도 다를 게 없다. **이름·전화 0개가 이 스코프의 설계 목표다.**
 *
 * 조립 필드(agent_stage · job_links · current_recruit_mode · has_access_token)도 안 붙인다.
 * 네 화면 중 아무도 읽지 않으므로 job_candidates·jobs·gatherLiveJobLinks **조회 3개를 건너뛴다** —
 * 바이트보다 이쪽이 체감에 크다(목록이 1초 걸렸던 원인이 그 3개의 순차 await였다).
 *
 * 실측 전송량(gzip): 기본 85KB → 16KB.
 *
 * ⚠️ 행은 줄이지 않는다. 네 화면 전부 전 행 스캔 카운터다 — 행을 줄이면 확정인력 54명이
 *    12명으로 찍히고 그게 정상 화면으로 보인다. "최근 200명만" 같은 최적화가 가장 위험하다.
 *
 * 컬럼을 하나라도 빼면 나는 증상(그래서 함부로 줄이지 말 것):
 *   id                 슬롯보드 상단 요약의 머릿수 Set 키 — 표 본문은 맞고 요약만 0명인 모순 화면
 *   status             네 화면 공통 축(한글 리터럴 정확 일치 비교 — 값 정규화도 금지)
 *   created_at         리포트 기간 필터·6개월 추이 — 빠지면 전 카드 0명
 *   airtable_record_id 리포트 임포트분 제외 — 빠지면 649명 전원 통과해 특정 월 가짜 급증
 *   work_hours         슬롯보드 '대기 N' 배지가 모든 칸에서 사라진다
 *   confirmed_slot     슬롯보드 확정 슬롯 1순위 — 빠지면 0이 아니라 그럴싸하게 틀린 값
 *   branch/branch1/confirmed_branch  슬롯보드·지점 매칭 OR 체인(branch는 레거시지만 OR 마지막 항)
 *   current_branch     지점 '활동중' 매칭 — 빠지면 전 지점에 '충원 시급' 빨간 배지
 */
const ROLLUP_COLUMNS = [
  "id", "status", "created_at", "airtable_record_id",
  "work_hours", "confirmed_slot",
  "branch", "branch1", "confirmed_branch", "current_branch",
].join(", ");

/**
 * `?scope=dashboard` — 대시보드 + '내가 답할 차례' 답장 큐.
 *
 * 이 목록은 Dashboard.tsx와 ReplyQueueCard.tsx 두 파일 AppRow의 **합집합**이다.
 * 두 파일은 반드시 **같은 SWR 키**를 써야 한다 — 한쪽만 옮기면 다른 쪽이 기본 키로
 * 67KB를 또 받아 절감이 0이 되고, 답장 큐의 mutate()가 대시보드 통계를 같이
 * 갱신하는 현재 동작(같은 캐시)도 깨진다. 컬럼을 추가할 땐 세 곳(여기 + 두 AppRow)을
 * 같이 고칠 것.
 *
 * 조립 필드는 agent_stage(답장 큐 미착수/응대중 배지 — 빠지면 undefined!=="paused"가
 * 항상 참이라 전원 '미착수'로 뒤집힌다)와 current_recruit_mode(온보딩 게이지의 배민
 * 분모)만 붙인다. job_links는 아무도 안 읽으므로 gatherLiveJobLinks 조회를 건너뛴다.
 * access_token은 select 자체에서 빠진다(has_access_token 변환도 건너뛴다 — 억지로
 * 붙이면 전원 false가 되어 '링크 없음'으로 읽힌다).
 *
 * 실측 전송량(gzip): 기본 67KB → 29KB. 랜딩 화면 + 60초 폴링이라 절감이 반복된다.
 */
const DASHBOARD_COLUMNS = [
  "id", "name", "phone", "status", "created_at",
  "last_message_at", "sms_opt_out_at", "current_job_id",
  "branch", "branch1", "confirmed_branch",
  "airtable_record_id", "guide_sent", "baemin_id", "onboarding_call_status",
  "sigungu", "sido",
].join(", ");

const LIVE_COLUMNS = [
  "id", "name", "phone", "status",
  "availability", "source", "branch", "branch1",
  "created_at", "last_message_at", "sms_opt_out_at",
].join(", ");


/** 목록에 실어 보낼 경력 자유입력의 최대 길이. 파이프라인 표의 그 칸이 좁아 이 이상은 화면에 안 들어간다. */
const EXPERIENCE_PREVIEW_LEN = 24;

/**
 * 경력 자유입력(experience)을 앞 24자까지만 내려보낸다.
 *
 * 왜:
 *  1) 전송량 — 이 컬럼 하나가 목록 응답의 39%였다(gzip 85KB 중 33KB). 506명이 채웠고
 *     평균 61자·최대 499자인 자유텍스트라 압축이 먹지 않는다. 반복값 컬럼과 성질이 다르다.
 *  2) 레이아웃 — 파이프라인 표의 그 칸(Pipeline.tsx:2230)에 truncate가 없어서, 499자짜리
 *     한 명이 표 행 하나를 통째로 늘려 놓는다. 서버에서 자르면 그 문제도 같이 사라진다.
 *
 * 전문이 필요한 곳(지원자 상세 패널)은 별도 상세 GET(`/[id]`)에서 원문을 받으므로 영향 없다.
 * 잘렸다는 표시로 말줄임표를 붙인다 — 매니저가 "이게 전부"라고 오해하지 않게.
 */
function withTrimmedExperience<T extends object>(rows: T[]): T[] {
  return rows.map((r) => {
    const raw = (r as { experience?: unknown }).experience;
    const exp = typeof raw === "string" ? raw.trim() : null;
    if (!exp) return r;
    return {
      ...r,
      experience:
        exp.length > EXPERIENCE_PREVIEW_LEN ? `${exp.slice(0, EXPERIENCE_PREVIEW_LEN)}…` : exp,
    };
  });
}

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const params = new URL(req.url).searchParams;
  const source = params.get("source");
  const scope = params.get("scope");
  const liveScope = scope === "live";
  const rollupScope = scope === "rollup";
  const dashboardScope = scope === "dashboard";

  let q = supabase
    .from("applicants")
    .select(
      rollupScope ? ROLLUP_COLUMNS : dashboardScope ? DASHBOARD_COLUMNS : liveScope ? LIVE_COLUMNS : LIST_COLUMNS
    )
    .order("created_at", { ascending: false });

  if (source) q = q.eq("source", source);

  // LIST_COLUMNS는 런타임 문자열이라 select 타입 추론이 안 되므로 결과 타입을 명시한다.
  const { data, error } = await q.returns<({ id: number } & Record<string, unknown>)[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 각 applicant의 latest job_candidates.agent_stage를 함께 내려준다.
  // job_candidates가 없는 후보(예: 당근 수동등록)는 null.
  let withStage = data ?? [];

  // rollup은 조립 필드를 아무도 읽지 않으므로 여기서 바로 돌려보낸다 —
  // job_candidates · gatherLiveJobLinks · jobs 조회 3개를 건너뛴다.
  if (rollupScope) {
    return NextResponse.json({ data: withStage });
  }

  if (withStage.length > 0) {
    const ids = withStage.map((a) => a.id);
    const jobIds = [...new Set(withStage.map((a) => a.current_job_id).filter((v): v is number => typeof v === "number"))];

    // 아래 세 조회는 서로 의존하지 않는다(모두 위에서 얻은 ids/jobIds만 필요) —
    // 순차로 await하면 Supabase 왕복 지연이 그대로 더해져 목록이 1초 가까이 걸렸다.
    const [jcRes, linkRes, jobRes] = await Promise.all([
      supabase
        .from("job_candidates")
        .select("id, applicant_id, agent_stage, created_at, updated_at")
        .in("applicant_id", ids)
        .order("created_at", { ascending: false }),
      // dashboard 스코프는 job_links를 아무도 안 읽는다 — 별도 페이징 조회 1개를 건너뛴다.
      dashboardScope
        ? Promise.resolve({ links: new Map<number, never[]>(), error: null })
        : gatherLiveJobLinks(supabase, ids),
      jobIds.length > 0
        ? supabase.from("jobs").select("id, recruit_mode").in("id", jobIds)
        : Promise.resolve({ data: [] as { id: number; recruit_mode: string | null }[] }),
    ]);

    const jcs = jcRes.data;
    const stageByApplicant = new Map<number, { stage: string | null; at: string | null }>();
    for (const jc of jcs ?? []) {
      if (!stageByApplicant.has(jc.applicant_id as number)) {
        stageByApplicant.set(jc.applicant_id as number, {
          stage: jc.agent_stage as string | null,
          at: (jc.updated_at as string | null) ?? null,
        });
      }
    }
    // agent_stage_updated_at — 단계가 바뀐 시각의 근사(행 updated_at). 파이프라인이
    // '사람 확인 필요 · N일' 배지에 쓴다. 마감·시스템 공고의 paused도 인계 큐에 실리므로
    // (큐가 그런 건을 의도적으로 담는다) 살아있는 결속(job_links)만으로는 판정할 수 없다 —
    // 실측: 인계 2건 모두 마감/시스템 공고라 job_links에 없어 배지가 영영 안 떴다.
    withStage = withStage.map((a) => ({
      ...a,
      agent_stage: stageByApplicant.get(a.id)?.stage ?? null,
      agent_stage_updated_at: stageByApplicant.get(a.id)?.at ?? null,
    }));

    // 살아있는 공고 결속(관심 포함)을 함께 내려준다 — 목록 배지 "공고 N건"용.
    // 위 agent_stage는 '가장 최근 행의 단계'(종료·마감 공고 포함)로 예전부터 쓰던 값이라 그대로 둔다.
    // 배지에 쓰는 집합은 응대 화면 탭·상세 포커스와 **같은 함수**여야 해서 여기서 따로 계산한다
    // (목록에 3건이라 적혀 있으면 열었을 때 탭도 3개 — lib/candidate-links.ts).
    const { links, error: linkErr } = linkRes;
    if (linkErr) {
      // 배지가 없어도 목록은 쓸 수 있다 — 500으로 올리지 않고 로그만 남긴다.
      console.error("[applicants] job_links 조회 실패", linkErr);
    }
    if (!dashboardScope) {
      withStage = withStage.map((a) => ({ ...a, job_links: links.get(a.id) ?? [] }));
    }

    // 현재 공고(current_job_id)의 라인 형태(recruit_mode)를 함께 내려준다 — 대시보드·목록의
    // 라인형태별 지표/표시(배민 전용 개념 분기)용. current_job_id 없으면 null.
    if (jobIds.length > 0) {
      const modeByJob = new Map<number, string | null>();
      for (const j of jobRes.data ?? []) modeByJob.set(j.id as number, (j.recruit_mode as string | null) ?? null);
      withStage = withStage.map((a) => ({
        ...a,
        current_recruit_mode: typeof a.current_job_id === "number" ? modeByJob.get(a.current_job_id) ?? null : null,
      }));
    }
  }

  // 맞춤 공고 링크 토큰은 '있는지 없는지'만 내려보낸다.
  //
  // 목록에서 이 값을 쓰는 곳은 파이프라인의 발송 가능 판정 한 군데뿐이고(sendableOf →
  // `if (!c.accessToken)`), 거기서 필요한 건 존재 여부다. 그런데 지금까지는 649명분
  // 토큰 원문이 전부 브라우저로 내려갔다 — 목록을 한 번 열 때마다 개인별 맞춤 공고
  // 링크 649개가 통째로 노출된 셈이다(대시보드·파이프라인·슬롯보드·리포트 4개 화면).
  // 링크 복사가 필요한 상세 패널은 별도 상세 GET에서 원문을 받으므로 영향이 없다.
  //
  // 부수 효과로 응답에서 24KB가 빠진다.
  // scope=live는 애초에 토큰 컬럼을 고르지 않으므로 이 변환을 건너뛴다 —
  // 안 그러면 모두 has_access_token: false가 붙어 '링크 없음'처럼 읽히는 값이 생긴다.
  if (dashboardScope) {
    return NextResponse.json({ data: withStage });
  }

  const safe = liveScope
    ? withStage
    : withStage.map(({ access_token, ...rest }) => ({
        ...rest,
        has_access_token: Boolean(access_token),
      }));

  if (!liveScope) {
    return NextResponse.json({ data: withTrimmedExperience(safe) });
  }

  // 대화 미리보기를 같은 응답에 실어 보낸다 — 실시간 응대 화면의 왕복을 1회로 줄인다.
  //
  // 예전에는 클라이언트가 목록을 받은 뒤 그 안의 id로 미리보기를 다시 물었다. 문제는
  // **목록 통과 조건이 그 두 번째 응답에 걸려 있다**는 것이었다(최근 답장한 풀 응답자,
  // 매니저가 보내고 회신을 기다리는 대화). 그래서 처음 그려지는 명단과 1초 뒤 명단이
  // 서로 달랐다 — 사람이 나타나고 사라지고, 미리보기 줄과 배지가 뒤늦게 붙었다.
  // 느린 게 아니라 두 번 그려지는 것이었다.
  //
  // 조회 대상은 클라이언트의 previewTargets와 **같은 규칙**으로 고른다. 규칙이 갈라지면
  // 목록에 뜨는 사람과 미리보기가 있는 사람이 어긋나 배지가 빈다.
  const ACTIVE_STATUSES = new Set(["스크리닝 중", "스크리닝 완료"]);
  const recentCut = Date.now() - RECENT_MANUAL_MS;
  const isBase = (a: Record<string, unknown>) => {
    const stage = a.agent_stage as string | null;
    return (Boolean(stage) && stage !== "abort") || ACTIVE_STATUSES.has(a.status as string);
  };
  const activityAt = (a: Record<string, unknown>) =>
    new Date((a.last_message_at as string) ?? (a.created_at as string) ?? 0).getTime();

  // 메시지 이력이 있는 전원을 대상에 넣는다(기간 무제한) — 미답 판정(마지막 메시지가 inbound)은
  // 미리보기가 있어야만 가능해서, 여기서 14일로 자르면 오래 방치된 미답이 화면에서 사라진다.
  // recentCut은 '이력은 없지만 최근 활동한 사람'을 추가로 포함하는 보조 조건으로만 남는다.
  const base = safe.filter((a) => isBase(a) || a.last_message_at != null || activityAt(a) > recentCut);
  // 상한 — 실측 이력 보유자 211명(2026-08). 500이면 당분간 잘릴 일이 없고,
  // 잘리기 시작하면 아래 로그가 먼저 알린다.
  const PREVIEW_TARGET_CAP = 500;
  const targets =
    base.length <= PREVIEW_TARGET_CAP
      ? base
      : [...base].sort((x, y) => activityAt(y) - activityAt(x)).slice(0, PREVIEW_TARGET_CAP);
  if (base.length > PREVIEW_TARGET_CAP) {
    console.error(`[applicants scope=live] 미리보기 대상 ${base.length}명이 상한 ${PREVIEW_TARGET_CAP}을 넘어 오래된 쪽이 잘렸다 — 오래 방치된 미답이 목록에서 빠질 수 있다.`);
  }

  // with_manual — '발신만 있고 회신을 기다리는 대화'는 applicants 컬럼만으로 못 찾는다.
  // 매니저 발신은 last_message_at을 올리지 않으므로 서버가 messages를 직접 뒤져 합집합을 만든다.
  const previews = await gatherMessagePreviews(
    supabase,
    targets.map((a) => a.id),
    { withManual: true },
  );

  return NextResponse.json({ data: safe, previews });
}

/**
 * POST /api/admin/applicants — 매니저 수기 등록.
 * 필수: name, phone, branch1. 그 외는 옵셔널 (어떤 컬럼도 비워둘 수 있음).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    const phone = String(body.phone ?? "").replace(/-/g, "");
    const branch1 = String(body.branch1 ?? "").trim();

    if (!name) return NextResponse.json({ error: "이름은 필수입니다." }, { status: 400 });
    // 매니저 수기 등록은 이름만 필수. phone/branch1는 빈 값 허용 — 추후 미니 상세에서 매니저가 직접 채움.
    // 단, phone이 입력됐으면 형식 검증.
    if (phone && !/^\d{10,11}$/.test(phone)) {
      return NextResponse.json({ error: "전화번호 형식이 올바르지 않습니다." }, { status: 400 });
    }

    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!CREATE_FIELDS.has(k)) continue;
      row[k] = v === "" ? null : v;
    }
    if (row.status && !VALID_STATUS_SET.has(row.status as string)) {
      return NextResponse.json({ error: `invalid status: ${row.status}` }, { status: 400 });
    }
    if (row.confirmed_slot && !validConfirmedSlot(row.confirmed_slot)) {
      return NextResponse.json({ error: "invalid confirmed_slot" }, { status: 400 });
    }

    // 기본값 보강 — 빈 값은 null로 정규화 (이름만 필수)
    row.name = name;
    row.phone = phone || null;
    row.branch1 = branch1 || null;
    row.branch = row.branch ?? (branch1 || null);
    row.source = row.source ?? "manual";
    // 기본 상태: 당근·배민(자동 AI 응대) → '스크리닝 중', 그 외 → '스크리닝 전'
    if (!row.status) {
      row.status = (row.source === "danggeun" || row.source === "danggeun_practice" || row.source === "baemin")
        ? "스크리닝 중"
        : "스크리닝 전";
    }
    if (row.marketing_consent === true) {
      row.marketing_consent_at = new Date().toISOString();
    }

    // 주소 지오코딩 (실패해도 INSERT 진행)
    const location = (row.location as string | null) ?? null;
    if (location && location.trim()) {
      try {
        const geo = await geocodeAddress(location);
        if (geo) {
          row.lat = geo.lat;
          row.lng = geo.lng;
          row.sido = geo.sido;
          row.sigungu = geo.sigungu;
          row.bname = geo.bname;
          row.road_address = geo.road_address;
        }
      } catch (e) {
        console.warn("[applicants POST] geocode skipped", e);
      }
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase.from("applicants").insert(row).select().single();
    if (error) {
      console.error("[applicants POST] insert error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 자동 흐름 트리거:
    //   - 당근/연습용 당근: 시작 멘트 SMS 발송 + job_candidates 생성 (당근은 매니저가 먼저 보냄)
    //   - 배민: 시작 멘트 SMS 발송 X (지원자가 먼저 보냄) + job_candidates만 생성
    //   - 기타 source(manual/facebook/naver/direct): 자동 흐름 없음
    const source = data.source as string | null;
    const isDanggeun = source === "danggeun" || source === "danggeun_practice";
    const isBaemin = source === "baemin";
    const isWeekendSlot = String(data.work_hours ?? "").includes("주말");
    const screeningAutoTrue: Record<string, boolean> = {
      프로모션_종료가능성_안내: true,
      정산주기_안내: true,
      업무시간_체계_이해: true,
      ...(isWeekendSlot ? {} : { 공휴일_업무여부_확인: true }),
    };

    if (isDanggeun && data.status === "스크리닝 중") {
      try {
        const startMsg = (await getSystemMessage(supabase, "danggeun_start"))?.trim();
        if (startMsg) {
          const filled = fillTemplate(startMsg, {
            이름: data.name ?? "",
            지점: data.branch ?? data.branch1 ?? "",
            시간대: shortWorkHours(data.work_hours ?? null),
          });
          let messageId: string | null = null;
          if (source === "danggeun") {
            const r = await sendSms(data.phone, filled);
            if (!r.success) {
              console.error("[applicants POST] danggeun start SMS fail", r.error);
            }
            messageId = r.messageId ?? null;
          }

          let jobIdForMsg: number | null = null;
          try {
            const jobId = await ensureDanggeunSystemJob(supabase);
            jobIdForMsg = jobId;
            await supabase.from("job_candidates").insert({
              job_id: jobId,
              applicant_id: data.id,
              agent_stage: "screening",
              agent_state: {
                screening: screeningAutoTrue,
                meta: { screening_entered_at: new Date().toISOString() },
              },
            });
          } catch (e) {
            console.error("[applicants POST] danggeun system job ensure failed", e);
          }

          await supabase.from("messages").insert({
            applicant_id: data.id,
            applicant_phone: data.phone,
            direction: "outbound",
            body: filled,
            status: source === "danggeun" ? "sent" : "simulated",
            sent_by: source === "danggeun" ? "danggeun-start" : "danggeun-practice-start",
            solapi_msg_id: messageId,
            message_type: "sms",
            job_id: jobIdForMsg,
          });
        } else {
          console.warn("[applicants POST] danggeun_start system message empty — auto flow skipped");
        }
      } catch (e) {
        console.error("[applicants POST] danggeun auto flow failed", e);
      }
    }

    if (isBaemin && data.status === "스크리닝 중") {
      // 배민은 지원자가 먼저 보낸 흐름이라 시작 멘트 발송 없음 — job_candidates만 생성해
      // 인입 라우터가 다음 답장부터 스크리닝 stage로 처리할 수 있게 한다.
      try {
        const jobId = await ensureBaeminSystemJob(supabase);
        await supabase.from("job_candidates").insert({
          job_id: jobId,
          applicant_id: data.id,
          agent_stage: "screening",
          agent_state: {
            screening: screeningAutoTrue,
            meta: { screening_entered_at: new Date().toISOString() },
          },
        });
      } catch (e) {
        console.error("[applicants POST] baemin auto flow failed", e);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[applicants POST] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

// 희망 시간대 축약 — "평일오전, 주말오후" 등을 그대로 사용. 빈 값 대비.
function shortWorkHours(wh: string | null): string {
  if (!wh || wh === "미확인") return "";
  return wh
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}
