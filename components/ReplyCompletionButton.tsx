"use client";

import { isReplyMessageId, type ReplyMessageId } from "@/lib/admin/reply-completion";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

type ReplySnapshot = { message_id?: ReplyMessageId; body: string; created_at: string };

export type ReplyCompletionSelection = { applicantId: number; name: string; preview: ReplySnapshot };

/** 완료 창을 연 순간의 수신 ID를 고정한다. 폴링 중 새 수신을 함께 완료하지 않는다. */
export function ReplyCompletionButton({ applicantId, name, preview, onChanged }: {
  applicantId: number;
  name: string;
  preview: ReplySnapshot;
  onChanged: () => void;
}) {
  const [selection, setSelection] = useState<ReplyCompletionSelection | null>(null);
  if (!isReplyMessageId(preview.message_id)) return null;
  return <>
    <Button variant="secondary" size="sm" className="min-h-11 shrink-0"
      aria-label={`${name}님 응대 완료 기록`}
      onClick={() => setSelection({ applicantId, name, preview: { ...preview } })}>
      <Check size={14} aria-hidden="true" /> 응대 완료
    </Button>
    {selection && <ReplyCompletionDialog selection={selection} onClose={() => setSelection(null)} onChanged={onChanged} />}
  </>;
}

/** 큐 행 밖에서도 유지할 수 있어 자동 갱신이 작성 중인 메모를 지우지 않는다. */
export function ReplyCompletionDialog({ selection, onClose, onChanged }: {
  selection: ReplyCompletionSelection;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { applicantId, name, preview: snapshot } = selection;
  const { mutate } = useSWRConfig();
  const [outcome, setOutcome] = useState<"no_reply" | "call">("no_reply");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function complete() {
    if (!snapshot?.message_id || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/messages/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, message_id: snapshot.message_id, outcome, note }),
      });
      const result = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          onClose();
          onChanged();
          toast.error(result.error || "대화 상태가 바뀌었어요. 최신 내용을 확인해 주세요.");
        } else setError(result.error || "완료 기록을 저장하지 못했어요. 다시 시도해 주세요.");
        return;
      }
      onClose();
      toast.success("응대 완료로 기록했어요. 문자는 발송하지 않았습니다.");
      onChanged();
      void mutate("/api/admin/applicants?scope=dashboard");
      void mutate("/api/admin/applicants?scope=live");
    } catch {
      setError("저장 결과를 확인하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} busy={saving} size="sm"
      title={`${name}님 응대 완료`}
      description="아래 수신까지 확인했고 추가 답장이 필요 없을 때 기록합니다. 새 문자가 오면 다시 표시됩니다."
      footer={<>
        <Button variant="secondary" size="sm" className="min-h-11" disabled={saving} onClick={onClose}>취소</Button>
        <Button size="sm" className="min-h-11" isLoading={saving} onClick={complete}>발송 없이 완료</Button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-xl border border-border-strong bg-background p-3">
          <div className="text-[12px] text-muted-foreground">마지막 수신 · {snapshot && new Date(snapshot.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</div>
          <p className="mt-2 whitespace-pre-wrap break-words text-[14px] text-foreground">{snapshot?.body}</p>
        </div>
        <div role="radiogroup" aria-label="응대 완료 사유" className="grid grid-cols-2 gap-2">
          {([{ id: "no_reply", label: "답장 불필요" }, { id: "call", label: "통화로 해결" }] as const).map((option) =>
            <button key={option.id} type="button" role="radio" aria-checked={outcome === option.id}
              onClick={() => setOutcome(option.id)} disabled={saving}
              className={`min-h-11 rounded-lg border px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${outcome === option.id ? "border-foreground bg-foreground text-background" : "border-border-strong bg-card text-foreground"}`}>
              {option.label}
            </button>)}
        </div>
        <label className="block text-[13px] font-semibold text-foreground">팀에 남길 메모 (선택)
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} rows={2} disabled={saving}
            className="mt-1.5 w-full rounded-lg border border-border-strong bg-card p-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <p className="text-[12px] text-muted-foreground">선탑 일정·공고별 할 일과 AI 응대 설정은 그대로 유지됩니다.</p>
        {error && <p role="alert" className="text-[13px] text-error-strong">{error}</p>}
      </div>
    </Modal>
  );
}
