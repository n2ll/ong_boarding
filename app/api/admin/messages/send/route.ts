import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";
import { detectManualOutboundSafetyViolation } from "@/lib/agent/outbound-safety";
import { classifyManualSmsCategory, smsRecipientBlockReason } from "@/lib/sms-consent-policy";
import {
  deliverManualMessage,
  manualDraftSendEligibility,
  manualMessageJobBindingEligibility,
  manualMessageRecipientEligibility,
  manualMessagePostprocessResult,
  type ExistingManualMessageRequest,
  type ManualMessageFingerprint,
  validateManualMessageIdempotencyKey,
} from "@/lib/manual-message-send";
import { retryManualMessagePostprocess } from "@/lib/manual-message-recovery";

export async function POST(req: NextRequest) {
  let deliveryAtFailure: "not_attempted" | "sent" = "not_attempted";
  let recordedAtFailure = false;
  let messageAtFailure: Record<string, unknown> | null = null;
  let deduplicatedAtFailure = false;
  let pausedSkippedAtFailure: "ambiguous" | "changed" | null = null;
  let pausedJobIdAtFailure: number | null = null;
  try {
    const {
      applicant_id,
      phone,
      body,
      sent_by,
      draft_id,
      draft_was_edited,
      job_id,
      purpose,
      idempotency_key,
    } = await req.json();
    // 매니저 답장의 공고 컨텍스트 — 스레드 job_id 필터·인계 큐 매칭이 어긋나지 않게 함께 저장.
    const jobId: number | null = typeof job_id === "number" && Number.isFinite(job_id) ? job_id : null;
    const applicantId: number | null = typeof applicant_id === "number" && Number.isFinite(applicant_id)
      ? applicant_id
      : null;
    const targetPhone = typeof phone === "string" ? phone.trim() : "";
    const messageBody = typeof body === "string" ? body.trim() : "";
    const sender = typeof sent_by === "string" && sent_by.trim() ? sent_by.trim() : "관리자";
    const messagePurpose = typeof purpose === "string" ? purpose.trim() : "";

    if (!targetPhone || !messageBody) {
      return NextResponse.json(
        { error: "phone과 body는 필수입니다.", delivery: "not_attempted", retryable: true },
        { status: 400 }
      );
    }

    const safetyViolation = detectManualOutboundSafetyViolation(messageBody);
    if (safetyViolation) {
      return NextResponse.json(
        {
          error: "개인정보 보호를 위해 신분증 이미지는 문자로 요청할 수 없습니다. 승인된 제출 방법을 안내해주세요.",
          delivery: "not_attempted",
          retryable: true,
        },
        { status: 400 }
      );
    }

    const validatedKey = validateManualMessageIdempotencyKey(idempotency_key);
    if (!validatedKey.ok) {
      return NextResponse.json(
        {
          error: validatedKey.reason === "required"
            ? "발송 요청 키가 필요합니다. 화면을 새로고침한 뒤 다시 시도해주세요."
            : "유효하지 않은 발송 요청 키입니다.",
          delivery: "not_attempted",
          retryable: true,
        },
        { status: 400 }
      );
    }
    const idempotencyKey = validatedKey.key;
    const supabase = createServiceClient();
    const draftId = typeof draft_id === "string" && draft_id.trim() ? draft_id.trim() : null;
    const draftWasEdited = draft_was_edited === true;
    const requestFingerprint: ManualMessageFingerprint = {
      applicantId,
      phone: targetPhone,
      body: messageBody,
      jobId,
      sentBy: sender,
      draftId,
      draftWasEdited,
    };

    const delivery = await deliverManualMessage<Record<string, unknown>>({
      key: idempotencyKey,
      request: requestFingerprint,
      claim: async () => {
        const claim = await supabase
          .from("manual_message_send_requests")
          .insert({
            idempotency_key: idempotencyKey,
            applicant_id: applicantId,
            applicant_phone: targetPhone,
            body: messageBody,
            job_id: jobId,
            sent_by: sender,
            draft_id: draftId,
            draft_was_edited: draftWasEdited,
            status: "sending",
            provider_correlation_attached: true,
            provider_reconcile_status: "pending",
          })
          .select("*")
          .single();
        if (!claim.error) return { kind: "claimed" as const };
        const claimErrorCode = (claim.error as { code?: string }).code;
        if (claimErrorCode === "23514") {
          return { kind: "conflict" as const };
        }
        if (claimErrorCode !== "23505") {
          console.error("[manual message outbox claim error]", claim.error);
          return { kind: "error" as const };
        }

        const existing = await supabase
          .from("manual_message_send_requests")
          .select("*")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (existing.error) {
          console.error("[manual message outbox replay lookup error]", existing.error);
          // 충돌 행은 존재하지만 상태 조회가 실패했다. 불명확 상태로 고정해 재발송을 막는다.
          const unknown: ExistingManualMessageRequest = {
            applicant_id: applicantId,
            applicant_phone: targetPhone,
            body: messageBody,
            job_id: jobId,
            sent_by: sender,
            draft_id: draftId,
            draft_was_edited: draftWasEdited,
            status: "unknown",
            provider_message_id: null,
          };
          return { kind: "existing" as const, request: unknown };
        }
        if (existing.data) {
          return {
            kind: "existing" as const,
            request: existing.data as ExistingManualMessageRequest,
          };
        }

        // draft_id partial unique index가 다른 요청 키의 동시 승인을 막은 경우다.
        // 그 요청을 현재 key의 replay로 취급하면 provider id를 다른 key로 기록할 수 있으므로
        // 명시적 conflict로 끝내고 공급자를 절대 호출하지 않는다.
        if (draftId) {
          const competing = await supabase
            .from("manual_message_send_requests")
            .select("idempotency_key")
            .eq("draft_id", draftId)
            .neq("status", "failed")
            .limit(1);
          if (competing.error) {
            console.error("[manual message draft claim lookup error]", competing.error);
            return { kind: "error" as const };
          }
          if ((competing.data ?? []).length > 0) return { kind: "conflict" as const };
        }
        console.error("[manual message outbox unique conflict without owner]", claim.error);
        return { kind: "error" as const };
      },
      send: async () => {
        // 같은 key의 recorded replay는 deliverManualMessage가 이 callback을 건너뛴다.
        // 신규 외부 발송 직전에만 초안의 지원자·공고·미처리 상태를 재검증한다.
        let hasVerifiedCurrentJobContext = false;
        if (draftId) {
          const draftResult = await supabase
            .from("message_drafts")
            .select("applicant_id, job_id, status, send_claim_key")
            .eq("id", draftId)
            .maybeSingle();
          if (draftResult.error) {
            console.error("[manual message draft validation error]", draftResult.error);
            return {
              success: false as const,
              failureKind: "declared" as const,
              error: "초안 상태를 확인하지 못해 문자를 보내지 않았습니다.",
            };
          }
          const eligibility = manualDraftSendEligibility(draftResult.data, {
            applicantId,
            jobId,
          }, idempotencyKey);
          if (!eligibility.ok) {
            return {
              success: false as const,
              failureKind: "declared" as const,
              error: eligibility.reason === "resolved"
                ? "이미 처리된 초안이라 문자를 보내지 않았습니다. 대화를 새로고침해주세요."
                : "현재 지원자·공고의 초안이 아니라 문자를 보내지 않았습니다. 대화를 새로고침해주세요.",
            };
          }
          hasVerifiedCurrentJobContext = jobId !== null;
        }
        let recipientLookup: {
          phone: string | null;
          marketingConsent: boolean | null;
          smsOptOutAt: string | null;
          failed: boolean;
        } = {
          phone: null,
          marketingConsent: null,
          smsOptOutAt: null,
          failed: false,
        };
        if (applicantId !== null) {
          try {
            const recipient = await supabase
              .from("applicants")
              .select("phone, marketing_consent, sms_opt_out_at")
              .eq("id", applicantId)
              .maybeSingle();
            recipientLookup = {
              phone: typeof recipient.data?.phone === "string" ? recipient.data.phone : null,
              marketingConsent: recipient.data?.marketing_consent === true
                ? true
                : recipient.data?.marketing_consent === false
                  ? false
                  : null,
              smsOptOutAt: typeof recipient.data?.sms_opt_out_at === "string"
                ? recipient.data.sms_opt_out_at
                : null,
              failed: Boolean(recipient.error),
            };
            if (recipient.error) {
              console.error("[manual message recipient validation error]", recipient.error);
            }
          } catch (error) {
            console.error("[manual message recipient validation exception]", error);
            recipientLookup = {
              phone: null,
              marketingConsent: null,
              smsOptOutAt: null,
              failed: true,
            };
          }
        }
        const recipientEligibility = manualMessageRecipientEligibility(
          { applicantId, phone: targetPhone },
          recipientLookup,
        );
        if (!recipientEligibility.ok) {
          const failureCode = recipientEligibility.reason === "mismatch"
            ? "recipient_mismatch" as const
            : recipientEligibility.reason === "lookup_failed"
              ? "recipient_unavailable" as const
              : "applicant_required" as const;
          return {
            success: false as const,
            failureKind: "declared" as const,
            failureCode,
            error: recipientEligibility.reason === "mismatch"
              ? "화면의 연락처가 현재 지원자 정보와 일치하지 않아 문자를 보내지 않았습니다. 대화를 새로고침해주세요."
              : recipientEligibility.reason === "lookup_failed"
                ? "지원자 연락처를 확인하지 못해 문자를 보내지 않았습니다. 잠시 뒤 다시 시도해주세요."
                : "지원자 정보를 확인할 수 없어 문자를 보내지 않았습니다. 대화를 새로고침해주세요.",
          };
        }
        if (!draftId && jobId !== null) {
          let lookup = { found: false, failed: false };
          if (applicantId !== null) {
            try {
              const binding = await supabase
                .from("job_candidates")
                .select("id")
                .eq("applicant_id", applicantId)
                .eq("job_id", jobId)
                .limit(1)
                .maybeSingle();
              lookup = {
                found: Boolean(binding.data),
                failed: Boolean(binding.error),
              };
              if (binding.error) {
                console.error("[manual message job binding validation error]", binding.error);
              }
            } catch (error) {
              console.error("[manual message job binding validation exception]", error);
              lookup = { found: false, failed: true };
            }
          }
          const eligibility = manualMessageJobBindingEligibility({ applicantId, jobId }, lookup);
          if (!eligibility.ok) {
            const failureCode = eligibility.reason === "mismatch"
              ? "job_scope_mismatch" as const
              : eligibility.reason === "lookup_failed"
                ? "job_scope_unavailable" as const
                : "applicant_required" as const;
            return {
              success: false as const,
              failureKind: "declared" as const,
              failureCode,
              error: eligibility.reason === "mismatch"
                ? "선택한 공고가 이 지원자와 연결되어 있지 않아 문자를 보내지 않았습니다. 대화를 새로고침해주세요."
                : eligibility.reason === "lookup_failed"
                  ? "지원자와 공고 연결을 확인하지 못해 문자를 보내지 않았습니다. 잠시 뒤 다시 시도해주세요."
                  : "지원자 정보를 확인할 수 없어 문자를 보내지 않았습니다. 대화를 새로고침해주세요.",
            };
          }
          hasVerifiedCurrentJobContext = true;
        }
        const smsCategory = classifyManualSmsCategory({
          purpose: messagePurpose,
          hasVerifiedCurrentJobContext,
          body: messageBody,
        });
        const consentBlock = smsRecipientBlockReason({
          category: smsCategory,
          recipientPhone: targetPhone,
          applicant: {
            phone: recipientLookup.phone,
            marketingConsent: recipientLookup.marketingConsent,
            smsOptOutAt: recipientLookup.smsOptOutAt,
          },
        });
        if (consentBlock) {
          return {
            success: false as const,
            failureKind: "declared" as const,
            failureCode: "marketing_consent_required" as const,
            error: consentBlock === "opt_out"
              ? "문자 수신거부 상태라 보내지 않았습니다. 필요하면 유선 연락을 이용해주세요."
              : "신규 일자리 문자 미동의·미확인 상태라 보내지 않았습니다. 캠페인 발송에서 동의 대상을 선택해주세요.",
          };
        }
        return sendSms(
          targetPhone,
          messageBody,
          undefined,
          { clientRequestId: idempotencyKey }
        );
      },
      markUnknown: async (error) => {
        const result = await supabase
          .from("manual_message_send_requests")
          .update({ status: "unknown", last_error: error, updated_at: new Date().toISOString() })
          .eq("idempotency_key", idempotencyKey)
          .eq("status", "sending");
        if (result.error) console.error("[manual message outbox unknown error]", result.error);
      },
      markFailed: async (error) => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const result = await supabase.rpc("fail_manual_message_send_request", {
            p_idempotency_key: idempotencyKey,
            p_error: error,
          });
          if (!result.error && result.data === "failed") return true;
          console.error("[manual message outbox failed error]", {
            attempt,
            error: result.error,
            outcome: result.data,
          });
        }
        return false;
      },
      markSent: async (providerMessageId) => {
        const result = await supabase
          .from("manual_message_send_requests")
          .update({
            status: "sent",
            provider_message_id: providerMessageId,
            sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_error: null,
            provider_reconcile_status: "matched",
            provider_reconciled_at: new Date().toISOString(),
            provider_reconcile_last_error: null,
          })
          .eq("idempotency_key", idempotencyKey)
          .eq("status", "sending")
          .select("idempotency_key")
          .maybeSingle();
        if (result.error || !result.data) {
          console.error("[manual message outbox sent error]", result.error);
          return false;
        }
        return true;
      },
      record: async (providerMessageId) => {
        const inserted = await supabase
          .from("messages")
          .insert({
            applicant_id: applicantId,
            applicant_phone: targetPhone,
            direction: "outbound",
            body: messageBody,
            status: "sent",
            sent_by: sender,
            solapi_msg_id: providerMessageId,
            job_id: jobId,
            client_request_id: idempotencyKey,
          })
          .select("*")
          .single();

        let message = inserted.data as Record<string, unknown> | null;
        if (inserted.error || !message) {
          // INSERT 응답이 끊겼거나 replay unique 충돌이어도 이미 기록된 행을 복구한다.
          const existing = await supabase
            .from("messages")
            .select("*")
            .eq("client_request_id", idempotencyKey)
            .maybeSingle();
          if (existing.error || !existing.data) {
            console.error("[manual message record error]", inserted.error, existing.error);
            return null;
          }
          message = existing.data as Record<string, unknown>;
        }

        const recordedUpdate = await supabase
          .from("manual_message_send_requests")
          .update({
            status: "recorded",
            recorded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("idempotency_key", idempotencyKey)
          .in("status", ["sent", "recorded"]);
        if (recordedUpdate.error) {
          // messages unique key가 최종 중복 방어이므로 실제 기록 성공은 그대로 반환한다.
          console.error("[manual message outbox recorded error]", recordedUpdate.error);
        }
        return message;
      },
    });

    if (delivery.delivery === "not_attempted") {
      return NextResponse.json(
        {
          success: false,
          error: delivery.conflict
            ? draftId
              ? "이 초안은 이미 다른 발송 요청으로 처리 중이거나 완료됐습니다. 대화를 새로고침해주세요."
              : "같은 발송 요청 키를 다른 내용이나 처리 조건에 사용할 수 없습니다."
            : "발송 요청을 안전하게 저장하지 못해 문자를 보내지 않았습니다.",
          delivery: "not_attempted",
          recorded: false,
          retryable: delivery.retryable,
          deduplicated: delivery.deduplicated,
        },
        { status: delivery.conflict ? 409 : 503 }
      );
    }
    if (delivery.delivery === "unknown") {
      return NextResponse.json(
        {
          success: false,
          error: "이 문자의 발송 결과를 확인할 수 없어 자동 확인 대기 상태로 보관했습니다. 중복 발송을 막기 위해 같은 요청은 다시 보내지 않습니다.",
          delivery: "unknown",
          recorded: false,
          retryable: false,
          deduplicated: delivery.deduplicated,
        },
        { status: 202 }
      );
    }
    if (delivery.delivery === "failed") {
      if (delivery.failureCode === "job_scope_mismatch") {
        return NextResponse.json(
          {
            success: false,
            code: "job_scope_mismatch",
            error: delivery.providerError,
            delivery: "failed",
            recorded: false,
            retryable: delivery.retryable,
            deduplicated: delivery.deduplicated,
          },
          { status: 409 },
        );
      }
      if (delivery.failureCode === "job_scope_unavailable") {
        return NextResponse.json(
          {
            success: false,
            code: "job_scope_unavailable",
            error: delivery.providerError,
            delivery: "failed",
            recorded: false,
            retryable: delivery.retryable,
            deduplicated: delivery.deduplicated,
          },
          { status: 503 },
        );
      }
      if (delivery.failureCode === "recipient_mismatch") {
        return NextResponse.json(
          {
            success: false,
            code: "recipient_mismatch",
            error: delivery.providerError,
            delivery: "failed",
            recorded: false,
            retryable: delivery.retryable,
            deduplicated: delivery.deduplicated,
          },
          { status: 409 },
        );
      }
      if (delivery.failureCode === "recipient_unavailable") {
        return NextResponse.json(
          {
            success: false,
            code: "recipient_unavailable",
            error: delivery.providerError,
            delivery: "failed",
            recorded: false,
            retryable: delivery.retryable,
            deduplicated: delivery.deduplicated,
          },
          { status: 503 },
        );
      }
      if (delivery.failureCode === "applicant_required") {
        return NextResponse.json(
          {
            success: false,
            code: "applicant_required",
            error: delivery.providerError,
            delivery: "failed",
            recorded: false,
            retryable: delivery.retryable,
            deduplicated: delivery.deduplicated,
          },
          { status: 400 },
        );
      }
      if (delivery.failureCode === "marketing_consent_required") {
        return NextResponse.json(
          {
            success: false,
            code: "marketing_consent_required",
            error: delivery.providerError,
            delivery: "failed",
            recorded: false,
            retryable: false,
            deduplicated: delivery.deduplicated,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: delivery.retryable
            ? delivery.providerError
              ? `문자 발송 실패: ${delivery.providerError}`
              : "이 발송 시도는 실패했습니다. 다시 보내려면 새 발송으로 시도해주세요."
            : "문자는 발송되지 않았지만 실패 상태를 안전하게 저장하지 못했습니다. 같은 초안을 다시 보내지 말고 잠시 뒤 대화 상태를 확인해주세요.",
          delivery: "failed",
          recorded: false,
          retryable: delivery.retryable,
          deduplicated: delivery.deduplicated,
        },
        { status: delivery.deduplicated ? 409 : delivery.retryable ? 502 : 503 }
      );
    }

    const data = delivery.message;
    const recorded = delivery.recorded;
    const deduplicated = delivery.deduplicated;
    deliveryAtFailure = "sent";
    recordedAtFailure = recorded;
    messageAtFailure = data;
    deduplicatedAtFailure = deduplicated;

    // AI 중단·초안 처리는 outbox 행 잠금 아래 한 DB 트랜잭션에서만 커밋한다.
    // 일시 DB 오류는 요청 안에서 세 번까지만 즉시 재시도하고, 이후에도 pending이면 cron이 이어받는다.
    const postprocessRecovery = recorded
      ? await retryManualMessagePostprocess(
          async () => await supabase.rpc("complete_manual_message_postprocess", {
            p_idempotency_key: idempotencyKey,
          }),
          manualMessagePostprocessResult
        )
      : {
          result: manualMessagePostprocessResult(null),
          attempts: 0,
          lastError: null,
        };
    if (!postprocessRecovery.result.completed) {
      console.error("[manual message postprocess pending]", {
        idempotencyKey,
        attempts: postprocessRecovery.attempts,
        error: postprocessRecovery.lastError,
      });
    }
    const postprocess = postprocessRecovery.result;
    const postprocessFailed = !recorded || !postprocess.completed;
    const pausedSkipped = postprocess.completed ? postprocess.pausedSkipped : null;
    const pausedJobId = postprocess.completed ? postprocess.pausedJobId : null;
    pausedSkippedAtFailure = pausedSkipped;
    pausedJobIdAtFailure = pausedJobId;

    return NextResponse.json({
      success: true,
      delivery: "sent",
      recorded,
      retryable: false,
      deduplicated,
      message: data,
      paused_skipped: pausedSkipped,
      paused_job_id: pausedJobId,
      ...(!recorded || postprocessFailed
        ? {
            ...(postprocessFailed ? { postprocess_failed: true } : {}),
            warning: !recorded
              ? "문자는 발송됐지만 대화 기록을 완료하지 못해 자동 복구 대기 상태로 보관했습니다. 같은 문자를 다시 보내지 말고 대화 상태를 확인해주세요."
              : "문자는 발송됐지만 AI·초안 상태 처리를 완료하지 못해 자동 복구 대기 상태로 보관했습니다. 같은 문자를 다시 보내지 말고 현재 AI 상태를 확인해주세요.",
          }
        : {}),
    });
  } catch (err) {
    console.error("[send message error]", err);
    if (deliveryAtFailure === "sent") {
      return NextResponse.json({
        success: true,
        delivery: "sent",
        recorded: recordedAtFailure,
        retryable: false,
        deduplicated: deduplicatedAtFailure,
        postprocess_failed: true,
        warning: "문자는 발송됐지만 후속 상태 처리를 완료하지 못해 자동 복구 대기 상태로 보관했습니다. 같은 문자를 다시 보내지 말고 대화 상태를 확인해주세요.",
        message: messageAtFailure,
        paused_skipped: pausedSkippedAtFailure,
        paused_job_id: pausedJobIdAtFailure,
      });
    }
    return NextResponse.json(
      { error: "서버 오류", delivery: "not_attempted", retryable: true },
      { status: 500 }
    );
  }
}
