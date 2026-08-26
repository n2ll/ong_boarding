/** 현재 관심을 표시한 공고의 충원 완료 사실만 알리는 운영 문자. */
export function currentJobWaitlistNotice(name: string, jobTitle: string): string {
  return `${name}님, '${jobTitle}' 관심 감사합니다!\n현재 이 공고는 모집 인원이 모두 차 마감됐어요.\n이번 공고로는 더 진행되지 않으며, 궁금한 점은 이 문자에 답장해 주세요.`;
}
