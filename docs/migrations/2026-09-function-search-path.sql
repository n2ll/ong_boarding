-- 기존 public 함수 6개의 가변 search_path를 고정한다.
-- 함수 본문이 public 객체를 스키마 없이 참조하므로 public을 유지하고,
-- 임시 객체가 먼저 해석되지 않도록 pg_temp를 마지막에 둔다.

alter function public.trg_branches_updated_at()
  set search_path = public, pg_temp;

alter function public.trg_jobs_updated_at()
  set search_path = public, pg_temp;

alter function public.upsert_ai_usage_daily(date, text, text, integer, integer, integer)
  set search_path = public, pg_temp;

alter function public.euc_kr_byte_length(text)
  set search_path = public, pg_temp;

alter function public.classify_outbound_sms()
  set search_path = public, pg_temp;

alter function public.match_applicant_on_message()
  set search_path = public, pg_temp;
