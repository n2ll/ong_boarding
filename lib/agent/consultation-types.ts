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

export interface ConsultationObservation {
  job_id: number;
  source_message_id: string;
  kind: "interest" | "availability";
  quote: string;
}
