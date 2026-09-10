import type { OtherActiveJob } from "./types";
import type { StaffingTraining } from "../admin/staffing-preparation";

/** 매니저 기록의 재질문 방지 문맥. 메모·담당자·연락처·일시는 전달하지 않는다. */
export interface ManagerPreparationContext {
  training_status: StaffingTraining["status"];
  backup_intent: StaffingTraining["backup_intent"];
  training_availability: { has_date: boolean; has_time: boolean };
  training_completed: boolean;
  backup_completed: boolean;
  manager_follow_up_open: boolean;
  last_contact_recorded: boolean;
}

/** 지원자 노출 정책을 통과한 상담용 공고. 상담만으로 단계가 시작되지는 않는다. */
export interface ConsultationJob extends Omit<OtherActiveJob, "stage"> {
  candidate_id: number | null;
  stage: OtherActiveJob["stage"] | null;
  expired: boolean;
  manager_preparation?: ManagerPreparationContext;
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

/** 공고 관심·가용성과 별개인 지역 문의 원문. 동의·거주지·출퇴근 가능성을 뜻하지 않는다. */
export interface RegionPreference {
  source_message_id: string;
  quote: string;
  regions: string[];
}
