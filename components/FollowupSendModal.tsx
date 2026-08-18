"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { TextField, TextareaField } from "./ui/field";

/**
 * 확정 후속 안내(만남장소·첫날규칙·앱안내) 발송 모달 — 상세 패널 '후속 안내' 섹션 전용.
 *
 * 실제 문구 조립·발송·비용 계산은 전부 공용 서버 라우트(/api/admin/confirm/send)가 한다(단일 소스).
 * 이 컴포넌트는 그 라우트를 미리보기(preview) → 편집 → 발송 흐름으로 감싸는 UI 셸일 뿐이라,
 * LiveConsole '확정 대기' 발송과 동일한 문구·검증을 재사용한다(라이브 콘솔 코드는 건드리지 않음).
 */

export type FollowupKind = "venue" | "first_day" | "app_guide";

const KIND_LABEL: Record<FollowupKind, string> = {
  venue: "만남장소 안내",
  first_day: "첫날 규칙 안내",
  app_guide: "옹고잉 앱 안내",
};

export function FollowupSendModal({
  applicantId,
  applicantName,
  jobId,
  kind,
  defaultStartDate,
  onClose,
  onSent,
}: {
  applicantId: number;
  applicantName: string;
  jobId: number | null;
  kind: FollowupKind;
  defaultStartDate?: string | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [preview, setPreview] = useState<{ text: string; sms_type: string; cost_krw: number } | null>(null);
  const [editText, setEditText] = useState("");
  const [venueDate, setVenueDate] = useState(String(defaultStartDate ?? "").slice(0, 10));
  const [venueTime, setVenueTime] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 미리보기 본문을 editText에 채워 발송 직전 수정 가능하게 한다(편집 가능 템플릿).
  const fetchPreview = useCallback(
    async (opts?: { startDate?: string; meetingTime?: string }) => {
      setLoading(true);
      setPreview(null);
      try {
        const res = await fetch("/api/admin/confirm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            applicant_id: applicantId,
            kind,
            job_id: jobId ?? undefined,
            start_date: opts?.startDate,
            meeting_time: opts?.meetingTime,
            preview: true,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(json.error || "미리보기 실패");
          return;
        }
        setPreview({ text: json.text, sms_type: json.sms_type, cost_krw: json.cost_krw });
        setEditText(json.text ?? "");
      } finally {
        setLoading(false);
      }
    },
    [applicantId, kind, jobId]
  );

  // 첫날규칙·앱안내는 시작일 불필요 → 즉시 미리보기. 만남장소는 시작일 있어야 미리보기.
  useEffect(() => {
    if (kind === "venue") {
      if (venueDate) void fetchPreview({ startDate: venueDate });
    } else {
      void fetchPreview();
    }
    // 마운트 시 1회만 — 이후 미리보기는 시작일/시각 변경 핸들러에서 재요청.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSend = async () => {
    if (kind === "venue" && !venueDate) return toast.error("시작일을 선택해주세요.");
    if (!editText.trim()) return toast.error("발송할 내용이 비어 있어요.");
    setSaving(true);
    try {
      const res = await fetch("/api/admin/confirm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 수정된 본문(editText)을 그대로 발송. venue는 시작일·집합시각도 함께(기록·재빌드 대비).
        body: JSON.stringify({
          applicant_id: applicantId,
          kind,
          job_id: jobId ?? undefined,
          text: editText.trim(),
          start_date: kind === "venue" ? venueDate : undefined,
          meeting_time: kind === "venue" ? venueTime : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "발송 실패");
      toast.success(`${applicantName}님 — ${KIND_LABEL[kind]}를 발송했어요.`);
      onSent();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "발송 실패");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={saving}
      size="md"
      title={`${KIND_LABEL[kind]} 발송`}
      description="아래 내용 그대로 문자가 나갑니다. 보내기 전에 고칠 수 있습니다."
      className="z-[60]"
      footer={
        <>
          {/* 비용은 '발송' 바로 옆에 둔다 — 누르기 직전에 보여야 판단이 된다 */}
          <span className="mr-auto text-[12px] font-medium text-muted-foreground">
            {preview ? `${preview.sms_type} · 예상 약 ${preview.cost_krw}원` : " "}
          </span>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>취소</Button>
          <Button
            size="sm"
            onClick={doSend}
            isLoading={saving}
            disabled={loading || !editText.trim()}
            className="bg-success-strong text-white hover:bg-success-strong/90"
          >
            <Send size={15} /> 발송
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {kind === "venue" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              label="시작일"
              type="date"
              value={venueDate}
              onChange={(e) => {
                const v = e.target.value;
                setVenueDate(v);
                if (v) void fetchPreview({ startDate: v, meetingTime: venueTime });
                else setPreview(null);
              }}
            />
            <TextField
              label="집합 시각"
              hint="비우면 문구에서 시각이 빠집니다"
              type="time"
              value={venueTime}
              onChange={(e) => {
                const v = e.target.value;
                setVenueTime(v);
                if (venueDate) void fetchPreview({ startDate: venueDate, meetingTime: v });
              }}
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
            <Loader2 size={16} className="animate-spin" /> 미리보기 불러오는 중…
          </div>
        ) : (
          <TextareaField
            label="발송 내용"
            hint="그대로 나갑니다. 자유롭게 고쳐도 됩니다."
            aside={`${editText.length}자`}
            rows={8}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder={kind === "venue" && !venueDate ? "시작일을 선택하면 기본 문안이 채워져요. 직접 작성해도 됩니다." : "발송 내용"}
          />
        )}
      </div>
    </Modal>
  );
}
