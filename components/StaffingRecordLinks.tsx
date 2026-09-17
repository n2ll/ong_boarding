import Link from "next/link";
import { Button } from "./ui/button";

export function StaffingRecordLinks({ jobId, jobTitle, applicantId }: { jobId: number; jobTitle: string; applicantId: number }) {
  return <section aria-label="선택 공고 진행 기록" className="min-w-0 rounded-2xl border border-border-strong bg-card p-3.5">
    <h3 className="text-sm font-bold text-foreground">이 공고의 진행 기록</h3>
    <p className="mt-1 break-words text-xs text-muted-foreground">{jobTitle}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {([
        ["follow_up", "연락·메모"], ["training", "선탑 일정"], ["participation", "참여·결과"],
      ] as const).map(([mode, label]) => <Button key={mode} asChild variant="secondary" size="sm">
        <Link prefetch={false} href={`/jobs?record_job=${jobId}&record_applicant=${applicantId}&record_mode=${mode}`}>{label}</Link>
      </Button>)}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">공고의 기록창으로 이동합니다. 연락 후 확인한 내용을 팀에 남겨주세요.</p>
  </section>;
}
