import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manager APIs expose client metadata for line-specific decisions", async () => {
  const [jobsRoute, detailRoute, pendingRoute, applicantsRoute] = await Promise.all([
    readFile(new URL("../../app/api/admin/jobs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/applicants/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/confirm/pending/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/applicants/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(jobsRoute, /client\s*:\s*clients\s*\(\s*client_type\s*,\s*uses_slots\s*\)/);
  assert.match(detailRoute, /select\("id, name, client_type, uses_slots"\)/);
  assert.match(detailRoute, /job_client_type:/);
  assert.match(detailRoute, /client_uses_slots:/);
  assert.match(pendingRoute, /client\s*:\s*clients\s*\(\s*client_type\s*\)/);
  assert.match(pendingRoute, /isGeneralLineJob\(/);
  assert.match(applicantsRoute, /uses_bmart_flow:/);
  assert.match(applicantsRoute, /isGeneralLineJob\(/);
});

test("manager UI no longer treats recruit mode as the AI or operating line type", async () => {
  const [jobs, detail, dashboard] = await Promise.all([
    readFile(new URL("../../components/Jobs.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/ApplicantDetailPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/Dashboard.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(jobs, /recruitMode\s*===\s*"internal"/);
  // internal의 게시 링크 비노출은 모집 채널 계약이라 유지한다. 마감·슬롯 분기에만 쓰이지 않아야 한다.
  assert.doesNotMatch(jobs, /closeModal\.job\.recruitMode/);
  assert.doesNotMatch(jobs, /candPanel\?\.recruitMode/);
  assert.doesNotMatch(jobs, /AI는 배민 앱 가입 안내 흐름/);
  assert.match(jobs, /generalLine:\s*isGeneralLineJob\(/);
  assert.match(jobs, /usesSlots:/);

  assert.doesNotMatch(detail, /job_recruit_mode\s*===\s*"internal"/);
  assert.doesNotMatch(detail, /job_recruit_mode\s*!==\s*"internal"/);
  assert.match(detail, /job_client_type/);
  assert.match(detail, /client_uses_slots/);

  assert.doesNotMatch(dashboard, /current_recruit_mode/);
  assert.match(dashboard, /uses_bmart_flow\s*===\s*true/);
});

test("manager UI fails closed when client routing metadata is unavailable", async () => {
  const jobs = await readFile(new URL("../../components/Jobs.tsx", import.meta.url), "utf8");

  assert.match(jobs, /error:\s*clientsError/);
  assert.match(jobs, /isLoading:\s*clientsLoading/);
  assert.match(jobs, /mutate:\s*mutateClients/);
  assert.match(jobs, /routingMetadataUnavailable/);
  assert.match(jobs, /if \(routingMetadataUnavailable\)/);
  assert.match(jobs, /disabled=\{[^}]*routingMetadataUnavailable/);
  assert.match(jobs, /화주사 정보를 불러오지 못했어요/);
  assert.match(jobs, /다시 불러오기/);
});

test("confirmation clears stale branch and slot values when the target does not use them", async () => {
  const detail = await readFile(new URL("../../components/ApplicantDetailPanel.tsx", import.meta.url), "utf8");

  assert.match(detail, /confirmed_slot:\s*confirmTargetUsesSlots\s*\?/);
  assert.match(detail, /confirmed_branch:\s*confirmBranch\.trim\(\)\s*\|\|\s*null/);
  assert.match(detail, /confirmedBranchNames/);
  assert.doesNotMatch(detail, /const editBranchNames = allBranches\.filter\([\s\S]*editClientIds/);
});

test("job rows only show a branch state for clients that have a branch concept", async () => {
  const jobs = await readFile(new URL("../../components/Jobs.tsx", import.meta.url), "utf8");

  assert.match(jobs, /hasBranchConcept/);
  assert.match(jobs, /job\.branch\s*\|\|\s*"지점 미지정"/);
  assert.doesNotMatch(jobs, /branch:\s*j\.branch\s*\?\?\s*"-"/);
});
