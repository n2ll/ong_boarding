import type { OtherActiveJob } from "./types";

/** 지원자 노출 정책을 통과한 상담용 공고. 상담만으로 단계가 시작되지는 않는다. */
export interface ConsultationJob extends Omit<OtherActiveJob, "stage"> {
  candidate_id: number | null;
  stage: OtherActiveJob["stage"] | null;
  expired: boolean;
}

export interface ConsultationSourceMessage {
  id: string;
  body: string;
  created_at: string;
}

/** 과거 안내의 번호 해석만 위한 자료. 과거 조건이나 신규 관찰 원문이 아니다. */
export interface ConsultationNumberedReference {
  source_message_id: string;
  created_at: string;
  options: { number: number; job_id: number; label: string }[];
}

export interface ConsultationObservation {
  job_id: number;
  source_message_id: string;
  kind: "interest" | "availability";
  quote: string;
}
