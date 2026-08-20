-- 지원서 첫 안내의 공급자 실패 분류를 보수적으로 복구한다.
-- -----------------------------------------------------------------------------
-- 선행(먼저 적용): 2026-08-apply-message-idempotency.sql
--
-- 이 코드 이전의 `failed`에는 공급자의 명시적 등록 거절과 HTTP/응답 유실이 함께
-- 저장될 수 있었다. 기존 행만으로 둘을 증명할 수 없으므로 모두 unknown으로 낮춰
-- "미발송 확정" 오표시를 막는다. 어떤 기존 상태도 자동 재발송되지 않는다.

update public.application_message_send_requests
set
  status = 'unknown',
  updated_at = now()
where status = 'failed';
