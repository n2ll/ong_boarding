import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  pipelineExposureJobIdsOnOpen,
  pipelineFillMissionSteps,
  pipelineFocusedActiveJob,
  pipelineFocusedJobIdFromSearch,
  pipelineFocusedJobMessageBody,
  pipelineFocusedJobProjection,
} from "./pipeline-job-context.ts";
import * as pipelineJobContext from "./pipeline-job-context.ts";

type BulkContextHelper = (input: {
  isWaitlist: boolean;
  waitlistJobId: number | null;
  newJobNoticeJobId: number | null;
}) => { purpose: "campaign" | "waitlist" | "new_job"; jobId: number | null };

type InitialSortModeHelper = (job: {
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  distanceBasis: "pickup" | "nearest" | null;
}) => "distance" | null;

type MessageReviewIssueHelper = (input: {
  body: string;
  newJobNoticeJobId: number | null;
}) => string | null;

type HandoffStateHelper = (
  search: string,
  activeJobs: readonly { id: number }[],
  activeJobsLoaded: boolean,
  activeJobsFailed?: boolean,
) => "none" | "invalid" | "loading" | "error" | "active" | "unavailable";

type RecipientStatusAllowedHelper = (input: {
  status: string;
  newJobNoticeJobId: number | null;
}) => boolean;

const activeJobs = [
  { id: 41, title: "성수 새벽 배송" },
  { id: 42, title: "강남 백업 기사" },
];

test("pipeline reads only a positive integer job id from the handoff query", () => {
  assert.equal(pipelineFocusedJobIdFromSearch("?region=capital&job=42&status=스크리닝+전"), 42);

  for (const search of ["", "?job=", "?job=0", "?job=-1", "?job=42.5", "?job=42x"]) {
    assert.equal(pipelineFocusedJobIdFromSearch(search), null);
  }
});

test("pipeline keeps context only while the focused job is still active", () => {
  assert.deepEqual(pipelineFocusedActiveJob("?job=42", activeJobs), activeJobs[1]);
  assert.equal(pipelineFocusedActiveJob("?job=99", activeJobs), null);
  assert.equal(pipelineFocusedActiveJob("?job=42", [activeJobs[0]]), null);
});

test("opening exposure selection preselects only the focused active job", () => {
  assert.deepEqual([...pipelineExposureJobIdsOnOpen("?job=42", activeJobs)], [42]);
  assert.deepEqual([...pipelineExposureJobIdsOnOpen("?job=99", activeJobs)], []);
  assert.deepEqual([...pipelineExposureJobIdsOnOpen("", activeJobs)], []);
});

test("fill mission advances from target selection to exposure and explicit message review", () => {
  assert.deepEqual(pipelineFillMissionSteps({ selectedCount: 0, exposureReady: false }), [
    { label: "조건 확인", state: "done" },
    { label: "대상 선택", state: "current" },
    { label: "공고 노출", state: "upcoming" },
    { label: "문자 검토", state: "upcoming" },
  ]);
  assert.deepEqual(pipelineFillMissionSteps({ selectedCount: 3, exposureReady: false }).map((step) => step.state), [
    "done", "done", "current", "upcoming",
  ]);
  assert.deepEqual(pipelineFillMissionSteps({ selectedCount: 3, exposureReady: true }).map((step) => step.state), [
    "done", "done", "done", "current",
  ]);
});

test("focused job projection preserves only explicit matching facts and never infers a region", () => {
  const projected = pipelineFocusedJobProjection({
    id: 42,
    title: "서울 새벽 배송",
    branch: "강남",
    exposure: "targeted",
    vehicle_required: true,
    slot_keys: ["주말오전", "임의시간", 7],
    pickup_address: "서울특별시 성동구 아차산로",
    pickup_lat: 37.5,
    pickup_lng: 127.04,
    dropoff_address: "경기도 성남시 분당구",
    dropoff_lat: 37.38,
    dropoff_lng: 127.12,
    distance_basis: "nearest",
    recruit_mode: "internal",
  });

  assert.deepEqual(projected, {
    id: 42,
    title: "서울 새벽 배송",
    branch: "강남",
    exposure: "targeted",
    vehicleRequired: true,
    slotKeys: ["주말오전"],
    pickupAddress: "서울특별시 성동구 아차산로",
    pickupLat: 37.5,
    pickupLng: 127.04,
    dropoffAddress: "경기도 성남시 분당구",
    dropoffLat: 37.38,
    dropoffLng: 127.12,
    distanceBasis: "nearest",
    recruitMode: "internal",
  });
  assert.equal("region" in projected, false, "title, branch, or address must not become a region filter");
});

test("focused job message is a review draft and never implies assignment or confirmation", () => {
  const body = pipelineFocusedJobMessageBody("성수 새벽 배송");

  assert.match(body, /성수 새벽 배송/);
  assert.match(body, /#\{맞춤링크\}/);
  assert.match(body, /관심 표시는 배정·근무 확정이 아니며/);
  assert.match(body, /매니저가 확인 후 연락/);
  assert.doesNotMatch(body, /관심 표시는 지원·/);
  assert.doesNotMatch(body, /배정됐|확정됐|출근하세요/);
});

test("focused job with a usable location starts candidate review in distance order", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineFocusedJobInitialSortMode?: InitialSortModeHelper;
  }).pipelineFocusedJobInitialSortMode;
  assert.equal(typeof helper, "function");

  assert.equal(helper!({
    pickupLat: 37.5,
    pickupLng: 127.04,
    dropoffLat: null,
    dropoffLng: null,
    distanceBasis: "pickup",
  }), "distance");
  assert.equal(helper!({
    pickupLat: null,
    pickupLng: null,
    dropoffLat: 37.38,
    dropoffLng: 127.12,
    distanceBasis: "nearest",
  }), "distance");
  assert.equal(helper!({
    pickupLat: null,
    pickupLng: null,
    dropoffLat: 37.38,
    dropoffLng: 127.12,
    distanceBasis: "pickup",
  }), null, "pickup-only jobs must not silently use the drop-off coordinate");
});

test("new-job review requires the personalized job link placeholder", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineFocusedJobMessageReviewIssue?: MessageReviewIssueHelper;
  }).pipelineFocusedJobMessageReviewIssue;
  assert.equal(typeof helper, "function");

  assert.equal(helper!({ body: "#{이름}님 #{맞춤링크}", newJobNoticeJobId: 42 }), null);
  assert.match(
    helper!({ body: "#{이름}님 새 공고입니다.", newJobNoticeJobId: 42 }) ?? "",
    /맞춤링크/,
  );
  assert.equal(
    helper!({ body: "일반 캠페인", newJobNoticeJobId: null }),
    null,
    "generic campaigns keep their existing validation contract",
  );
});

test("new-job review excludes already confirmed workers while generic messages keep existing behavior", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineFocusedJobRecipientStatusAllowed?: RecipientStatusAllowedHelper;
  }).pipelineFocusedJobRecipientStatusAllowed;
  assert.equal(typeof helper, "function");

  assert.equal(helper!({ status: "확정인력", newJobNoticeJobId: 42 }), false);
  assert.equal(helper!({ status: "스크리닝 완료", newJobNoticeJobId: 42 }), true);
  assert.equal(helper!({ status: "확정인력", newJobNoticeJobId: null }), true);
});

test("loaded handoff reports a missing or closed focused job instead of silently dropping context", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineFocusedJobHandoffState?: HandoffStateHelper;
  }).pipelineFocusedJobHandoffState;
  assert.equal(typeof helper, "function");

  assert.equal(helper!("", activeJobs, true), "none");
  assert.equal(helper!("?job=42", activeJobs, false), "loading");
  assert.equal(helper!("?job=42", activeJobs, true), "active");
  assert.equal(helper!("?job=99", activeJobs, true), "unavailable");
});

test("a present but malformed focused-job handoff never falls back to generic campaign mode", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineFocusedJobHandoffState?: HandoffStateHelper;
  }).pipelineFocusedJobHandoffState;
  assert.equal(typeof helper, "function");

  assert.equal(helper!("?region=capital", activeJobs, true), "none");
  for (const search of ["?job=", "?job=0", "?job=-1", "?job=42.5", "?job=42x"]) {
    assert.equal(helper!(search, activeJobs, true), "invalid", search);
  }
  assert.equal(helper!("?job=bad", activeJobs, false, true), "invalid");
});

test("a failed active-job lookup keeps a valid focused handoff fail-closed", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineFocusedJobHandoffState?: HandoffStateHelper;
  }).pipelineFocusedJobHandoffState;
  assert.equal(typeof helper, "function");

  assert.equal(helper!("", activeJobs, false, true), "none");
  assert.equal(helper!("?job=42", [], false, true), "error");
  assert.equal(
    helper!("?job=42", activeJobs, true, true),
    "error",
    "stale active-job data must not re-enable focused actions after refresh fails",
  );
});

test("focused job message review keeps new-job purpose and job ownership", () => {
  const helper = (pipelineJobContext as typeof pipelineJobContext & {
    pipelineBulkMessageContext?: BulkContextHelper;
  }).pipelineBulkMessageContext;
  assert.equal(typeof helper, "function");

  assert.deepEqual(helper!({ isWaitlist: false, waitlistJobId: null, newJobNoticeJobId: 42 }), {
    purpose: "new_job",
    jobId: 42,
  });
  assert.deepEqual(helper!({ isWaitlist: false, waitlistJobId: null, newJobNoticeJobId: null }), {
    purpose: "campaign",
    jobId: null,
  });
  assert.deepEqual(helper!({ isWaitlist: true, waitlistJobId: 17, newJobNoticeJobId: 42 }), {
    purpose: "waitlist",
    jobId: 17,
  });
});

test("Pipeline wires the focused job to a visible safe handoff and exposure picker", async () => {
  const source = await readFile(new URL("../../components/Pipeline.tsx", import.meta.url), "utf8");

  assert.match(source, /const focusedActiveJob = pipelineFocusedActiveJob\(/);
  assert.match(source, /aria-label="공고별 내부 충원 단계"[\s\S]*?fillMissionSteps\.map\(/);
  assert.match(source, /focusedActiveJob[\s\S]*?\{selectedRows\.size\}명에게 공고 노출[\s\S]*?문자 보내기/);
  assert.match(source, /노출만으로 후보 등록·문자 발송·배정·근무 확정이 이루어지지 않습니다/);
  assert.match(source, /setExposureJobIds\(pipelineExposureJobIdsOnOpen\(/);
  assert.match(source, /pipelineFocusedJobInitialSortMode\(focusedActiveJob\)[\s\S]*?setSortMode\(focusedSortMode\)/);
  assert.match(source, /setBulkMsgBody\(pipelineFocusedJobMessageBody\(focusedActiveJob\.title\)\)[\s\S]*?setBulkMsgModalOpen\(true\)/);
  assert.match(source, /setNewJobNoticeJobId\(focusedActiveJob\.id\)[\s\S]*?setBulkMsgModalOpen\(true\)/);
  assert.match(source, /purpose: bulkMessageContext\.purpose[\s\S]*?job_id: bulkMessageContext\.jobId/);
  assert.match(source, /const closeBulkMessageModal = \(\) => \{[\s\S]*?setNewJobNoticeJobId\(null\)/);
  assert.match(source, /const closeBulkMessageModal = \(\) => \{[\s\S]*?if \(bulkSending\) return/);
  assert.match(source, /<Modal bare open=\{bulkMsgModalOpen\}[\s\S]*?busy=\{bulkSending\}/);
  assert.match(source, /aria-label="문자 보내기 창 닫기"[\s\S]*?disabled=\{bulkSending\}/);
  assert.match(source, /variant="secondary" size="lg" onClick=\{closeBulkMessageModal\} disabled=\{bulkSending\}>취소/);
  assert.match(source, /focusedActiveJob \?[\s\S]*?이 공고에만 노출[\s\S]*?: activeJobs\.map/);
  assert.match(source, /newJobNoticeJobId === null && \([\s\S]*?메시지 템플릿/);
  assert.match(source, /pipelineFocusedJobMessageReviewIssue\([\s\S]*?newJobNoticeJobId/);
  assert.match(source, /aria-invalid=\{Boolean\(newJobMessageReviewIssue\)\}/);
  assert.match(source, /id="pipeline-new-job-message-issue"[\s\S]*?\{newJobMessageReviewIssue\}/);
  assert.match(source, /disabled=\{modalRecipientCount === 0 \|\| applicantActionsBlocked \|\| focusedJobActionsBlocked \|\| waitlistContextMissing \|\| activeCheckBlocking \|\| Boolean\(newJobMessageReviewIssue\)\}/);
  assert.match(source, /bulkSendableOf\(c, isWaitlist, newJobNoticeJobId\)/);
  assert.match(source, /새 공고 안내 대상에서 제외됩니다/);
  assert.match(source, /focusedJobHandoffState === "unavailable"[\s\S]*?마감되었거나 찾을 수 없어요[\s\S]*?href="\/jobs"/);
  assert.match(source, /focusedJobHandoffState === "invalid"[\s\S]*?공고 연결 정보가 올바르지 않아요[\s\S]*?href="\/jobs"/);
  assert.match(source, /error: jobsError[\s\S]*?pipelineFocusedJobHandoffState\([\s\S]*?Boolean\(jobsError\)/);
  assert.match(source, /focusedJobHandoffState === "error"[\s\S]*?공고 정보를 확인하지 못했어요[\s\S]*?mutateJobs/);
  assert.match(source, /const focusedJobActionsBlocked =\s*focusedJobHandoffState !== "none" && focusedJobHandoffState !== "active"/);
  assert.match(source, /if \(focusedJobActionsBlocked\)[\s\S]{0,220}진행 중인 공고를 다시 선택한 뒤 작업해 주세요\.[\s\S]{0,120}공고 정보를 다시 확인한 뒤 작업해 주세요\./);
  assert.match(source, /focusedJobActionsBlocked \? \([\s\S]*?공고 확인 전에는 문자·후보 등록·노출 지정을 시작하지 않아요/);
  assert.match(source, /focusedJobHandoffState === "unavailable"[\s\S]*?진행 중인 공고가 아니라 문자·후보 등록·노출 지정을 시작하지 않아요/);
  assert.match(source, /disabled=\{modalRecipientCount === 0 \|\| applicantActionsBlocked \|\| focusedJobActionsBlocked \|\| waitlistContextMissing/);
  const missionSection = source.slice(
    source.indexOf('aria-label="공고별 내부 충원 단계"'),
    source.indexOf("{/* 조건 바", source.indexOf('aria-label="공고별 내부 충원 단계"')),
  );
  assert.doesNotMatch(missionSection, /onClick=\{openFocusedJobMessageReview\}/);
  const exposureModal = source.slice(
    source.indexOf("{/* J 타겟 노출"),
    source.indexOf("<ApplicantDetailPanel", source.indexOf("{/* J 타겟 노출")),
  );
  assert.match(exposureModal, /focusedActiveJob \? \([\s\S]*?이 공고에만 노출 대상을 추가합니다/);
  assert.match(exposureModal, /!focusedActiveJob && \([\s\S]*?노출 제외/);
  assert.match(exposureModal, /!focusedActiveJob && exposureFlipJobs\.length > 0/);
  assert.match(source, /make_targeted: focusedActiveJob \? true : exposureMakeTargeted/);
  assert.match(exposureModal, /size="default"/);
  assert.doesNotMatch(source, /useEffect\([\s\S]*?setExposureJobIds\(new Set\(\)\)[\s\S]*?\[exposurePickerOpen\]\)/);
});

test("Pipeline keeps desktop actions usable when the detail panel narrows the list", async () => {
  const source = await readFile(new URL("../../components/Pipeline.tsx", import.meta.url), "utf8");

  assert.match(source, /sticky top-0[^\"]*flex flex-wrap items-center gap-x-4 gap-y-2/);
  assert.match(source, /placeholder="지금 조건을 이름 붙여 저장[^\n]+[\s\S]*?rounded-md/);
  assert.match(source, /<label[^>]*>메시지 템플릿<\/label>[\s\S]*?<select[\s\S]*?rounded-md/);
  assert.match(source, /<label[^>]*>메시지 본문<\/label>[\s\S]*?<textarea[\s\S]*?rounded-md/);
  assert.match(source, /title=\{newJobNoticeJobId !== null \? "새 공고 안내 문자 검토" : "선택 인원 대상 문자\(SMS\) 캠페인 발송"\}/);
  assert.match(source, /<h2 aria-hidden="true" className="text-\[16px\] font-bold text-foreground">/);
});
