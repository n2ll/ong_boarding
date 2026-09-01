const PERSONAL_JOB_LINK = "#{맞춤링크}";

/**
 * 기존 인력풀에 새 공고를 알릴 때 쓰는 안전한 기본 문구.
 * 관심 표시는 지원 의향 수집일 뿐 배정·근무 확정이 아니라는 계약을 한곳에서 유지한다.
 */
export function defaultJobAnnouncementBody(title: string): string {
  const safeTitle = title.replace(/\s+/g, " ").trim().slice(0, 80) || "새 일자리";
  return `[옹고잉] #{이름}님, 안녕하세요.

'${safeTitle}' 공고를 확인하실 수 있게 안내드려요. 아래 링크에서 조건을 보시고 괜찮으면 '관심 있음'을 눌러주세요.

${PERSONAL_JOB_LINK}

관심 표시는 배정·근무 확정이 아니며, 매니저가 확인 후 연락드립니다.
궁금하시면 이 문자로 답장해 주세요. (안내 중단: '그만' 회신)`;
}

/**
 * 새 공고 작성 때 매니저가 검토한 문자 초안을 실제 발송에도 그대로 쓴다.
 * 과거 초안처럼 맞춤 링크가 없으면 지원자가 한 번 더 물어야 하므로 안전한 기본 문구로 대체한다.
 */
export function resolveJobAnnouncementBody(input: {
  jobTitle: string;
  smsDraft?: string | null;
}): string {
  const draft = input.smsDraft?.trim() ?? "";
  return draft.includes(PERSONAL_JOB_LINK)
    ? draft
    : defaultJobAnnouncementBody(input.jobTitle);
}
