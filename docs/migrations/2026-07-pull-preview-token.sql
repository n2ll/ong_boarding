-- 지원자 화면 미리보기 토큰 설정 행 시드.
-- category='system_message', title='pull_preview_token', body=테스트 지원자의 access_token.
-- body가 비어 있으면 /api/admin/pull-preview가 최신 지원자 토큰으로 폴백한다.
-- 실제 토큰 값은 운영 DB에서 직접 지정한다(레포에 값 미기재):
--   update prompt_examples set body='<테스트 지원자 access_token>', updated_at=now()
--   where category='system_message' and title='pull_preview_token';

insert into prompt_examples (category, title, body)
select 'system_message', 'pull_preview_token', ''
where not exists (
  select 1 from prompt_examples
  where category = 'system_message' and title = 'pull_preview_token'
);
