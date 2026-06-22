-- 진행상태 최종 정리 (배포 후 1회 실행).
-- ----------------------------------------------------------------
-- 신규 6개 status:
--   자동(AI): 스크리닝 전 / 스크리닝 중 / 스크리닝 완료
--   수동(매니저): 확정인력 / 대기자 / 부적합
--
-- 기존 매핑:
--   스크리닝         → 스크리닝 중
--   온보딩            → 스크리닝 완료
--   온보딩 완료       → 스크리닝 완료
--   확정              → 확정인력
--   이탈              → 부적합 (의도와 다르면 매니저가 개별 조정)
--   부적합            → 부적합 (그대로)
-- 'NULL' 이거나 그 외는 → 스크리닝 전 (안전한 디폴트)

UPDATE applicants SET status = '스크리닝 중'   WHERE status = '스크리닝';
UPDATE applicants SET status = '스크리닝 완료' WHERE status IN ('온보딩', '온보딩 완료');
UPDATE applicants SET status = '확정인력'      WHERE status = '확정';
UPDATE applicants SET status = '부적합'        WHERE status = '이탈';
-- 그 외(NULL, 빈 문자열, 알 수 없는 값)은 '스크리닝 전'로
UPDATE applicants
   SET status = '스크리닝 전'
 WHERE status IS NULL
    OR status NOT IN ('스크리닝 전', '스크리닝 중', '스크리닝 완료', '확정인력', '대기자', '부적합');
