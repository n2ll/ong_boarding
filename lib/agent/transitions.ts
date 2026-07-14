/**
 * 단계 전이(transition) 부수효과 처리.
 *
 * router.ts가 stage.process() 결과를 받은 뒤, 응답 발송 직후 이 함수가 호출된다.
 * - applicants.status, current_job_id 갱신
 * - job_candidates.agent_stage / agent_state / 타임스탬프 갱신
 * - 자동 발송 (확정 안내, 앱·교육 안내 등)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendNotification } from "../solapi";
import { sendSlackPausedAlert } from "../slack";
import { getSystemMessage, fillTemplate } from "./system-messages";
import { mergeAgentState } from "./checklist";
import {
  buildGeneralCollectedSummary,
  buildGeneralHandoffText,
  buildGeneralScreeningAnnouncement,
  GENERAL_SCREENING_AUTO_TRUE,
  isGeneralLineJob,
  readGeneralCollected,
} from "./general-line";
import type { AgentState, JobContext, ScreeningChecklist, StageName, StageTransition } from "./types";

interface ApplyTransitionInput {
  supabase: SupabaseClient;
  candidate_id: number;
  applicant_id: number;
  applicant_name: string | null;
  applicant_phone: string;
  applicant_branch?: string | null;     // 근무지점 (슬랙 알림용)
  applicant_work_hours?: string | null; // 근무시간대 (슬랙 알림용)
  job_id: number;
  job: JobContext | null;           // exploration → screening 시 조건부 자동 true 판정용
  current_stage: StageName;
  state_update: AgentState;        // stage.process가 만든 새 state (이미 merge 완료된 형태)
  transition: StageTransition;
  /** true면 SOLAPI 발송과 Slack 알림 건너뛰고 DB outbound 기록만 — 연습용 빙의 모드. */
  simulate?: boolean;
}

export interface ApplyTransitionResult {
  next_stage: StageName | null;
  auto_sent_messages: number;       // advance 시 자동 발송된 메시지 수
}

export async function applyTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult> {
  const {
    supabase,
    candidate_id,
    applicant_id,
    applicant_name,
    applicant_phone,
    job_id,
    job,
    current_stage,
    state_update,
    transition,
    simulate = false,
  } = input;

  // 연습용 빙의 모드에선 실제 SMS·Slack 발송을 건너뛰고 fake-success로 처리해
  // DB outbound 기록과 체크리스트 갱신은 그대로 진행되게 한다.
  const maybeSendNotification: typeof sendNotification = simulate
    ? async () => ({
        success: true,
        via: "sms" as const,
        messageId: undefined,
        templateId: undefined,
      })
    : sendNotification;

  // 직전 outbound와 동일 본문이 이미 발송된 상태면 중복 발송 방지.
  // 시뮬 모드 등에서 transitions가 두 번 도는 케이스 가드.
  const isAlreadySentRecently = async (body: string): Promise<boolean> => {
    const { data: recent } = await supabase
      .from("messages")
      .select("body, created_at")
      .eq("applicant_id", applicant_id)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(3);
    return (recent ?? []).some((m) => (m.body as string) === body);
  };

  let nextStage: StageName | null = current_stage;
  let extraStateUpdate: AgentState = {};
  let autoSent = 0;
  // advance 전이의 크리티컬 자동 발송(SCREENING_ANNOUNCE/GUIDE)이 실패하면 사유를 기록.
  // switch 종료 후 이 값이 있으면 단계 진행을 취소하고 paused로 되돌린다.
  let criticalSendFailure: string | null = null;
  const now = new Date().toISOString();

  switch (transition.kind) {
    // ────────────────────────────────────────────────
    case "stay":
      // 단계 유지, state만 갱신
      break;

    // ────────────────────────────────────────────────
    case "pause":
      nextStage = "paused";
      // 직전 stage를 meta에 저장 → 매니저 답장 후 자동 복귀에 사용.
      // pause 구조화 정보(P1a)도 meta.pause에 함께 저장 → 인계 큐 카테고리·추천액션 1순위 소스.
      extraStateUpdate = {
        meta: {
          paused_from_stage: current_stage,
          paused_at: now,
          pause: {
            category: transition.category ?? null,
            summary: transition.reason,
            suggested_action: transition.suggestedAction ?? null,
          },
        },
      };
      await supabase
        .from("job_candidates")
        .update({ paused_reason: transition.reason })
        .eq("id", candidate_id);
      // 매니저 인계 슬랙 알림 — 연습 모드(simulate)면 skip
      if (!simulate) {
        try {
          // 시스템 더미 공고(__danggeun_system__ 등)는 job.branch가 비어 있으므로
          // 지원자의 희망 1지망(applicant_branch)을 우선 사용.
          await sendSlackPausedAlert({
            applicant_name,
            applicant_phone,
            branch: input.applicant_branch ?? job?.branch ?? null,
            reason: transition.reason,
          });
        } catch (e) {
          console.error("[transitions] slack paused alert failed", e);
        }
      }
      break;

    // ────────────────────────────────────────────────
    case "abort":
      nextStage = "abort";
      // 공고 단위 종료 — 이 공고 후보만 닫는다.
      // applicants.status는 건드리지 않는다: 한 공고에서의 abort가 지원자를 인력풀 전체에서
      // 빼면 안 된다(예비전력 재활용 원칙 — 다른 공고엔 여전히 후보 가능). '인력풀 제외'는
      // 매니저의 명시적 person-level 액션(지원자 상세 '인력풀 제외')으로만 일어난다.
      await supabase
        .from("job_candidates")
        .update({
          closed_at: now,
          closed_reason: `abort: ${transition.reason}`,
        })
        .eq("id", candidate_id);
      // 진행 포인터만 정리 — current_job_id가 이 공고를 가리키고 있었다면 해제(다른 공고 포인터는 유지).
      await supabase
        .from("applicants")
        .update({ current_job_id: null })
        .eq("id", applicant_id)
        .eq("current_job_id", job_id);
      break;

    // ────────────────────────────────────────────────
    case "advance": {
      nextStage = transition.to;

      // ─── exploration → screening: 안내 묶음 자동 발송 + 조건부 자동 true ───
      if (transition.to === "screening") {
        const general = isGeneralLineJob(job);
        // 1) 안내 발송 — 비마트: 안내 묶음(정산/프로모션/업무시간) / 일반 라인: 첫 확인질문(차종·본인명의)
        try {
          const storedAnnounce = await getSystemMessage(
            supabase,
            general ? "general_screening_announce" : "screening_announce"
          );
          const announceText = storedAnnounce
            ? fillTemplate(storedAnnounce, { 이름: applicant_name ?? "지원자" })
            : general
              ? buildGeneralScreeningAnnouncement(applicant_name)
              : buildScreeningAnnouncement(applicant_name);
          if (await isAlreadySentRecently(announceText)) {
            // 이미 발송됨 — 중복 방지
          } else {
          const r = await maybeSendNotification(
            applicant_phone,
            general ? "GENERAL_SCREENING_ANNOUNCE" : "SCREENING_ANNOUNCE",
            { "#{이름}": applicant_name ?? "지원자" },
            announceText
          );
          if (r.success) {
            await supabase.from("messages").insert({
              applicant_id,
              applicant_phone,
              direction: "outbound",
              body: announceText,
              status: "sent",
              sent_by: "system-auto",
              solapi_msg_id: r.messageId ?? null,
              message_type: r.via,
              template_id: r.templateId ?? null,
              job_id,
            });
            autoSent++;
          } else {
            criticalSendFailure = `SCREENING_ANNOUNCE 발송 실패: ${r.error ?? "unknown"}`;
          }
          }
        } catch (e) {
          criticalSendFailure = `SCREENING_ANNOUNCE 발송 예외: ${e instanceof Error ? e.message : "unknown"}`;
          console.error("[transitions] SCREENING_ANNOUNCE send failed", e);
        }

        // 2) 안내 항목 + 조건부 항목 자동 true — 안내 발송이 실패했으면 진행하지 않는다.
        if (!criticalSendFailure) {
          let autoTrue: Partial<ScreeningChecklist>;
          if (general) {
            // 일반 라인: 비마트 전용 안내 항목은 해당 없음 처리.
            // 자차_재확인(=차종 확인)은 렌트 안내 분기가 있어 항상 AI가 확인한다.
            autoTrue = { ...GENERAL_SCREENING_AUTO_TRUE };
          } else {
            autoTrue = {
              프로모션_종료가능성_안내: true,
              정산주기_안내: true,
              업무시간_체계_이해: true,
            };
            // 자차 필요 없는 공고면 자차_재확인 자동 통과
            if (job && job.vehicle_required === false) {
              autoTrue.자차_재확인 = true;
            }
            // 주말 슬롯이 아니면 공휴일 항목 자동 통과
            const slot = job?.slot ?? "";
            if (!slot.includes("주말")) {
              autoTrue.공휴일_업무여부_확인 = true;
            }
          }

          extraStateUpdate = {
            screening: autoTrue,
            meta: { screening_entered_at: now },
          };

          // applicants.status를 자동 AI 상태와 통일 — '스크리닝 중'
          // (매니저가 이미 확정인력/대기자/부적합으로 설정했으면 건드리지 않음)
          await supabase
            .from("applicants")
            .update({ status: "스크리닝 중" })
            .eq("id", applicant_id)
            .in("status", ["스크리닝 전", "스크리닝 중"]);
        }
      }

      if (transition.to === "onboarding") {
        // screening → onboarding: 앱·교육 안내 자동 발송 + applicants.status='스크리닝 완료'
        // (별도 "확정 안내" 메시지는 보내지 않음 — AI의 마지막 응답 + 가이드 본문이 그 역할 대신)
        await supabase
          .from("job_candidates")
          .update({ confirmed_at: now })
          .eq("id", candidate_id);
        // 자동 status는 매니저 미터치 케이스에만 갱신
        await supabase
          .from("applicants")
          .update({ status: "스크리닝 완료" })
          .eq("id", applicant_id)
          .in("status", ["스크리닝 전", "스크리닝 중", "스크리닝 완료"]);

        // ─── 일반 라인(internal 공고): 배민 앱 가이드 발송 금지 ───
        // 스크리닝 통과 = AI 역할 종료. 선탑(동승) 인계 마무리 1통 발송 후 onboarding 대신
        // paused로 전환해 매니저에게 인계한다 (Slack에 수집 요약 포함).
        if (isGeneralLineJob(job)) {
          try {
            const storedHandoff = await getSystemMessage(supabase, "general_screening_handoff");
            const handoffText = storedHandoff
              ? fillTemplate(storedHandoff, { 이름: applicant_name ?? "지원자" })
              : buildGeneralHandoffText(applicant_name);
            if (await isAlreadySentRecently(handoffText)) {
              // 이미 발송됨 — 중복 방지
            } else {
              const r = await maybeSendNotification(
                applicant_phone,
                "GENERAL_SCREENING_HANDOFF",
                { "#{이름}": applicant_name ?? "지원자" },
                handoffText
              );
              if (r.success) {
                await supabase.from("messages").insert({
                  applicant_id,
                  applicant_phone,
                  direction: "outbound",
                  body: handoffText,
                  status: "sent",
                  sent_by: "system-auto",
                  solapi_msg_id: r.messageId ?? null,
                  message_type: r.via,
                  template_id: r.templateId ?? null,
                  job_id,
                });
                autoSent++;
              } else {
                criticalSendFailure = `GENERAL_HANDOFF 발송 실패: ${r.error ?? "unknown"}`;
              }
            }
          } catch (e) {
            criticalSendFailure = `GENERAL_HANDOFF 발송 예외: ${e instanceof Error ? e.message : "unknown"}`;
            console.error("[transitions] GENERAL_HANDOFF send failed", e);
          }

          if (!criticalSendFailure) {
            const summary = buildGeneralCollectedSummary(readGeneralCollected(state_update.meta));
            const reason = `일반 라인 스크리닝 통과 — 선탑(동승) 일정 조율 필요\n${summary}`;
            nextStage = "paused";
            extraStateUpdate = {
              meta: {
                paused_from_stage: "screening",
                paused_at: now,
                screening_passed_at: now,
                pause: {
                  category: "call",
                  summary: reason,
                  suggested_action: "수집 요약(차종·명의·시작일·선탑 가능 시간대·법인차 렌트 희망)을 확인하고 선탑 일정을 잡아 연락하세요.",
                },
              },
            };
            await supabase
              .from("job_candidates")
              .update({ paused_reason: reason })
              .eq("id", candidate_id);
            if (!simulate) {
              try {
                await sendSlackPausedAlert({
                  applicant_name,
                  applicant_phone,
                  branch: input.applicant_branch ?? job?.branch ?? null,
                  reason,
                });
              } catch (e) {
                console.error("[transitions] slack general handoff alert failed", e);
              }
            }
          }
          break;
        }

        // (온보딩 진입 슬랙은 제거 — '준비 완료'(배민 아이디 수신) 시점에
        //  onboarding stage에서 발송한다.)

        // 앱·교육 안내 (가이드 알림톡 ⑥) — 본문은 아래 buildOnboardingGuide 참조
        // 본문 뒤에 발송시각+24h 마감 안내를 자동 부착. 24h 미회신 시 cron으로 리마인더 발송.
        try {
          const deadline = roundDeadlineToHour(new Date(Date.now() + 24 * 60 * 60 * 1000));
          const deadlineStr = formatDeadlineKST(deadline);
          const storedGuide = await getSystemMessage(supabase, "onboarding_guide");
          const baseGuide = storedGuide
            ? fillTemplate(storedGuide, { 이름: applicant_name ?? "지원자", 마감시각: deadlineStr })
            : buildOnboardingGuideText(applicant_name);
          // 본문에 {{마감시각}} placeholder가 없거나 치환 후에도 deadlineStr이 보이지 않으면 끝에 자동 부착.
          const guideText = baseGuide.includes(deadlineStr)
            ? baseGuide
            : `${baseGuide}\n\n⏰ ${deadlineStr}까지 배민 커넥트 아이디를 반드시 회신해주세요.`;
          if (await isAlreadySentRecently(guideText)) {
            // 이미 발송됨 — 중복 방지
          } else {
          const r2 = await maybeSendNotification(
            applicant_phone,
            "GUIDE",
            { "#{이름}": applicant_name ?? "지원자" },
            guideText
          );
          if (r2.success) {
            await supabase.from("messages").insert({
              applicant_id,
              applicant_phone,
              direction: "outbound",
              body: guideText,
              status: "sent",
              sent_by: "system-auto",
              solapi_msg_id: r2.messageId ?? null,
              message_type: r2.via,
              template_id: r2.templateId ?? null,
              job_id,
            });
            autoSent++;

            // 가이드 자동 발송 성공 → applicants.guide_sent 동기화 (대시보드 '가이드 발송' 지표 실측 반영)
            // 실패해도 발송 흐름은 유지 (non-fatal)
            const { error: guideSentErr } = await supabase
              .from("applicants")
              .update({ guide_sent: true })
              .eq("id", applicant_id);
            if (guideSentErr) {
              console.error("[transitions] guide_sent sync failed", guideSentErr);
            }

            // 안내 발송됨 체크리스트 자동 true
            extraStateUpdate = {
              onboarding: { 앱설치_교육_안내발송됨: true },
              meta: { onboarding_entered_at: now },
            };
          } else {
            criticalSendFailure = `GUIDE 발송 실패: ${r2.error ?? "unknown"}`;
          }
          }
        } catch (e) {
          criticalSendFailure = `GUIDE 발송 예외: ${e instanceof Error ? e.message : "unknown"}`;
          console.error("[transitions] GUIDE send failed", e);
        }
      }

      if (transition.to === "active") {
        // onboarding → active: 자동 단계 전이지만 매니저 확정은 아님.
        // 배민 아이디 회신까지 = 스크리닝 완료. 이후 매니저가 통화로 확인 후 '확정인력'으로 직접 변경.
        // 첫 출근 룰/만남장소 자동 발송은 미구현(D-day cron 없음) — 현재 매니저가 수동 발송.
        await supabase
          .from("job_candidates")
          .update({ activated_at: now })
          .eq("id", candidate_id);
        // 자동 status는 매니저 미터치 케이스에만 '스크리닝 완료'로 유지/갱신
        await supabase
          .from("applicants")
          .update({ status: "스크리닝 완료" })
          .eq("id", applicant_id)
          .in("status", ["스크리닝 전", "스크리닝 중", "스크리닝 완료"]);
      }
      break;
    }
  }

  // advance 전이인데 크리티컬 자동 발송(SCREENING_ANNOUNCE/GUIDE)이 실패했으면
  // 단계를 조용히 진행시키지 않고 paused로 되돌려 매니저에게 인계한다.
  // (지원자는 0통 수신 → 확정 뉘앙스 금지 자동 준수. 알림은 매니저 대상.)
  if (transition.kind === "advance" && criticalSendFailure) {
    nextStage = "paused";
    // 일반 라인은 onboarding 단계를 쓰지 않는다 — 재개 시 screening으로 복귀해
    // 완료 체크리스트 기반 자동 재전이(인계 마무리 재시도)가 일어나게 한다.
    const pausedFrom =
      transition.to === "onboarding" && isGeneralLineJob(job) ? "screening" : transition.to;
    extraStateUpdate = mergeAgentState(extraStateUpdate, {
      meta: {
        paused_from_stage: pausedFrom,
        paused_at: now,
        pause: {
          category: "tech",
          summary: `자동 발송 실패 — 수동 발송 필요 (${criticalSendFailure})`,
          suggested_action: "안내 메시지를 수동 발송한 뒤 단계를 재개하세요.",
        },
      },
    });
    await supabase
      .from("job_candidates")
      .update({ paused_reason: `자동 발송 실패: ${criticalSendFailure}` })
      .eq("id", candidate_id);
    if (!simulate) {
      try {
        await sendSlackPausedAlert({
          applicant_name,
          applicant_phone,
          branch: input.applicant_branch ?? job?.branch ?? null,
          reason: `자동 발송 실패 — 수동 발송 필요 (${criticalSendFailure})`,
        });
      } catch (e) {
        console.error("[transitions] slack send-failure alert failed", e);
      }
    }
  }

  // 배민 아이디 수신 시 만남장소 자동 발송은 제거됨.
  // 현 설계: AI는 "감사합니다, 곧 다시 연락드리겠습니다" 마무리 + 슬랙 '온보딩 준비 완료'까지만,
  // 이후 만남장소 안내·확정은 매니저가 직접 진행한다.

  // job_candidates 갱신
  const merged = mergeAgentState(state_update, extraStateUpdate);
  const jcUpdate: Record<string, unknown> = {
    agent_state: merged,
  };
  if (nextStage !== current_stage) {
    jcUpdate.agent_stage = nextStage;
  }
  await supabase.from("job_candidates").update(jcUpdate).eq("id", candidate_id);

  return { next_stage: nextStage, auto_sent_messages: autoSent };
}

/** 마감 시각을 정각 단위로 반올림. (30분 이상 → 다음 정각, 미만 → 이전 정각) */
export function roundDeadlineToHour(d: Date): Date {
  const min = d.getMinutes();
  const out = new Date(d);
  if (min >= 30) {
    out.setHours(out.getHours() + 1);
  }
  out.setMinutes(0, 0, 0);
  return out;
}

/** 마감시각 표기 — KST 기준 "M월 D일 오전/오후 H시(분)" */
export function formatDeadlineKST(d: Date): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const m = get("month");
  const day = get("day");
  const ap = get("dayPeriod");
  const h = get("hour");
  const min = get("minute");
  const minPart = min === "00" ? "" : ` ${parseInt(min, 10)}분`;
  return `${m}월 ${day}일 ${ap} ${h}시${minPart}`;
}

function formatStartDate(iso: string): string {
  // iso = "2026-05-07" 형태 가정
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${m}/${day}(${w})`;
}

export function buildVenueGuideText(params: {
  name: string | null;
  start_date: string;
  pickup_address: string;
  site_manager_name: string;
  site_manager_phone: string;
  /** 집합 시각 (예: "07:50", "09:40"). 공고·라인마다 달라 하드코딩하지 않는다. 비면 시각 줄 생략. */
  meeting_time?: string | null;
}): string {
  const n = params.name ?? "지원자";
  const t = (params.meeting_time ?? "").trim();
  const dateLine = t ? `일시: ${formatStartDate(params.start_date)} ${t}` : `일시: ${formatStartDate(params.start_date)}`;
  return [
    `${n}님, 업무 시작 만남 장소 안내드립니다.`,
    "",
    dateLine,
    `위치: ${params.pickup_address}`,
    `현장 담당자: ${params.site_manager_name} 매니저 ${params.site_manager_phone}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// 자동 발송 본문 (운영 텍스트 — prompts/screening-examples.txt 기반)
// ─────────────────────────────────────────────────────────────

/**
 * exploration → screening 진입 시 자동 발송되는 안내 묶음.
 * 매니저가 통화로 풀어주던 6항목 중 "안내" 성격(정산/프로모션/업무시간)을
 * 한 통에 깔끔하게 통보. 이후 AI가 확인질문만 묶어서 진행.
 */
export function buildScreeningAnnouncement(name: string | null): string {
  const n = name ?? "지원자";
  return [
    `${n}님, 본격적인 진행을 위해 몇 가지 안내드릴게요!`,
    "",
    "1) 업무시간은 배차 시간 기준입니다.",
    "   08:00 첫 배차 / 16:00 마지막 배차이고, 배송 시간은 별도로 산정됩니다.",
    "2) 정산은 건당 금액이 매주, 프로모션 비용은 2주 간격으로 진행됩니다.",
    "3) 프로모션 5천원 비용은 1~2개월 후 종료될 수 있는 점 참고 부탁드려요.",
    "",
    "읽어보시고 괜찮으시면 몇 가지만 짧게 여쭤볼게요^^",
  ].join("\n");
}

export function buildOnboardingGuideText(_name: string | null): string {
  // 인사말 없이 바로 본문으로 시작 — 직전 AI 응답("그럼 온보딩 절차로 안내 드릴게요")이 인사 역할을 대신함
  return [
    "업무 진행을 위한 앱설치 및 요청사항을 전달드립니다. 영상교육 수료 후, 회신 부탁드립니다.",
    "",
    "1. 배민 커넥트 앱 설치 후 가입",
    "2. 앱 가입 시 안전보건교육 영상(2시간) 필수 시청 필요",
    "3. 가입 및 교육 수료 후 마이페이지 > 내 정보에서 '아이디' 확인 후, 아이디 회신 부탁드립니다.",
    "",
    "[참고 자료]",
    "가입 가이드: https://www.youtube.com/watch?v=bMM112zT7JY",
    "사용법 가이드: https://www.youtube.com/watch?v=5547PR3fzRs",
  ].join("\n");
}

// 비마트(배민커넥트) 실시간 배차 라인용 첫날 규칙.
function buildFirstDayRulesBaemin(name: string | null): string {
  const n = name ?? "지원자";
  return [
    `${n}님 안녕하세요? 첫 근무 관련 안내사항 전달드립니다!`,
    "",
    "1) 08시 경에 나오셔서 카카오 채널로 건물 또는 주차하신 사진 부탁드립니다 (현재 활동 여부 확인용).",
    "2) 배차 들어오면 수락해 주시고(라우트는 자동), 가까운 곳 우선으로 돌아주시면 감사하겠습니다.",
    "3) 식사는 13시 이후로 진행 부탁드립니다.",
    "4) 배차 시점부터 60분 내 배송 완료 부탁드립니다.",
    "5) 상차지에서 배차 받고 10분 대기 후 출발 부탁드립니다.",
  ].join("\n");
}

// 도시락 등 internal 정기 배송 라인용 첫날 규칙 — 실시간 배차가 아니라 정해진 시간·경로.
// 선탑(동승)에서 배운 동선대로 진행하는 라인이라 배차 문구를 쓰지 않는다.
function buildFirstDayRulesGeneral(name: string | null): string {
  const n = name ?? "지원자";
  return [
    `${n}님, 첫 근무 관련 안내드립니다!`,
    "",
    "1) 안내드린 집합 시간·장소로 나와주세요. 도착하시면 현장 담당자에게 알려주세요.",
    "2) 선탑(동승) 때 익히신 순서·경로대로 상차 후 배송 진행 부탁드립니다.",
    "3) 배송 완료 후 회수품·잔여물은 정해진 반납 절차대로 처리해 주세요.",
    "4) 진행 중 문제가 생기면 바로 현장 담당자에게 연락 주세요.",
  ].join("\n");
}

/** 첫날 규칙 — 라인 형태(general=internal 정기배송)에 맞춰 분기. */
export function buildFirstDayRules(name: string | null, opts?: { general?: boolean }): string {
  return opts?.general ? buildFirstDayRulesGeneral(name) : buildFirstDayRulesBaemin(name);
}

/** 확정 시 발송하는 옹고잉 앱 설치·가이드 안내 기본문(코드 폴백).
 *  실제 운영 문구는 system_message 'ongoing_app_guide'가 우선 — 두뇌 탭에서 편집.
 *  ⚠️ 확정 뉘앙스 금지 규칙 준수: 이 문구는 매니저 확정 후 발송하는 '안내'이므로 확정 통보 자체는 가능하되,
 *  링크·문구는 사장님이 공유한 실제 옹고잉 앱 안내 내용으로 두뇌 탭에서 교체해야 완성된다. */
export function buildOngoingAppGuide(name: string | null): string {
  const n = name ?? "선생님";
  return [
    `${n}님, 함께하게 되어 반갑습니다! 업무 진행을 위해 옹고잉 앱 설치를 안내드립니다.`,
    "",
    "(옹고잉 앱 설치 링크·가이드 내용을 여기에 넣어주세요 — 에이전트 두뇌 탭 > 'ongoing_app_guide'에서 편집)",
  ].join("\n");
}
