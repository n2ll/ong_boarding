"use client";

import { useId, useRef, useState } from "react";
import { canEditJobOperationsSection, getJobOperationsSection, replaceJobOperationsSection } from "@/lib/admin/job-operations-section";
import { missingJobCreateOperationFields, type JobCreateOperationField } from "@/lib/admin/job-create-followup";
import { Button } from "./ui/button";

const textAreaClass = "w-full rounded-md border border-border-strong bg-input-background px-4 py-3 text-sm leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const operationQuestions: Record<JobCreateOperationField, string> = {
  collectionMode: "수거는 배송 중에 하나요, 별도로 재방문하나요?",
  collectionBagDate: "어느 날 사용한 가방을 수거하나요?",
  returnPlace: "반납 장소는 어디인가요?",
  returnDeadline: "반납은 언제까지 해야 하나요?",
};

/** The short editor edits the saved public body itself, so applicant guidance cannot use an older copy. */
export function JobPostingBodyEditor({ value, onChange, channel, source, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  channel: "albamon" | "sms";
  source?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [fullEditorOpen, setFullEditorOpen] = useState(false);
  const operationsEditorRef = useRef<HTMLTextAreaElement>(null);
  const fullEditorRef = useRef<HTMLTextAreaElement>(null);
  const operations = channel === "albamon" ? getJobOperationsSection(value) : null;
  const useShortEditor = operations !== null && canEditJobOperationsSection(value);
  const missingOperations = channel === "albamon" ? missingJobCreateOperationFields(value) : [];
  const fullEditor = <textarea
    ref={fullEditorRef}
    aria-label={channel === "albamon" ? "공고 원문 전체" : "안내 문자 본문"}
    aria-describedby={operations !== null ? `${id}-scope` : undefined}
    value={value}
    onChange={(event) => {
      // Keep the same visible input when a whole-body edit changes short-editor eligibility.
      setFullEditorOpen(true);
      onChange(event.target.value);
    }}
    disabled={disabled}
    className={`${textAreaClass} min-h-[260px] resize-y whitespace-pre-wrap`}
  />;

  return <div className="space-y-3">
    {missingOperations.length > 0 && <section aria-labelledby={`${id}-questions`} className="rounded-xl border border-warning/35 bg-warning-soft p-3">
      <h3 id={`${id}-questions`} className="text-sm font-bold text-warning-strong">운행 조건 확인</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">본문에서 확인되지 않은 조건입니다. 아는 내용만 보완해 주세요. 미정이어도 등록할 수 있어요.</p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-sm leading-relaxed">
        {missingOperations.map((field) => <li key={field}>{operationQuestions[field]}</li>)}
      </ul>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3 min-h-11 w-full"
        disabled={disabled}
        onClick={() => (useShortEditor ? operationsEditorRef : fullEditorRef).current?.focus()}
      >본문에 조건 보완하기</Button>
    </section>}
    {useShortEditor ? <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-bold">배송·수거·반납 확인</label>
      <p id={`${id}-help`} className="mb-2 text-xs leading-relaxed text-muted-foreground">상차부터 반납까지 이번 라인의 조건을 확인해 주세요. 여기서 고치면 공고 원문에도 바로 반영됩니다.</p>
      <textarea
        ref={operationsEditorRef}
        id={id}
        aria-describedby={`${id}-help ${id}-scope`}
        value={operations}
        onChange={(event) => onChange(replaceJobOperationsSection(value, event.target.value))}
        disabled={disabled}
        rows={7}
        className={`${textAreaClass} min-h-[180px] resize-y`}
      />
    </div> : <div>
      {operations !== null && <p className="mb-2 text-xs leading-relaxed text-muted-foreground">운행 조건이 다른 항목에도 적혀 있어 전체 원문을 보여드립니다. 수정할 조건이 반복되어 있다면 함께 확인해 주세요.</p>}
    </div>}
    {operations !== null && <p id={`${id}-scope`} className="text-xs leading-relaxed text-muted-foreground">수거 방식·대상 가방·반납 기한은 확인된 조건만 적어 주세요. 반납 기한과 상세 주소는 줄을 나눠 입력해 주세요.</p>}
    {channel === "albamon" && <p className="text-xs leading-relaxed text-muted-foreground">안내 문자는 별도 초안이므로 발송 전에 확인해 주세요.</p>}
    {channel === "albamon" && source?.trim() && <details className="rounded-xl border border-border-strong px-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">생성에 사용한 원문과 비교</summary>
      <p className="pb-3 text-xs text-muted-foreground">이번 초안을 생성할 때 사용한 메모입니다.</p>
      <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words pb-3 text-sm leading-relaxed">{source}</p>
    </details>}
    <details
      open={fullEditorOpen || !useShortEditor}
      onToggle={(event) => setFullEditorOpen(event.currentTarget.open)}
      className={useShortEditor ? "rounded-xl border border-border-strong px-3 pb-1" : undefined}
    >
      <summary className={useShortEditor ? "min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : "hidden"}>공고 원문 전체 수정</summary>
      {fullEditor}
    </details>
  </div>;
}
