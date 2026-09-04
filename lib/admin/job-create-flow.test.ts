import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("new job flow starts from the operating memo, then reviews routing context", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const modalStart = jobsSource.indexOf("{/* AI JD Generator Modal */}");
  const modalEnd = jobsSource.indexOf("{/* 공고 수정 모달", modalStart);

  assert.ok(modalStart >= 0, "new job modal should exist");
  assert.ok(modalEnd > modalStart, "new job modal boundary should exist");

  const modalSource = jobsSource.slice(modalStart, modalEnd);
  const clientField = modalSource.indexOf("value={newJobClientId}");
  const branchField = modalSource.indexOf("value={newJobBranchId}");
  const pickupField = modalSource.indexOf("value={newJobPickupAddress}");
  const dropoffField = modalSource.indexOf("value={newJobDropoffAddress}");
  const aiBrief = modalSource.indexOf("value={aiPrompt}");

  assert.ok(clientField >= 0, "client field should exist in the new job modal");
  assert.ok(aiBrief >= 0, "AI brief should exist in the new job modal");
  assert.ok(clientField > aiBrief, "routing review should follow the pasted operating memo");
  assert.ok(branchField > clientField, "branch field should follow the client field");
  assert.ok(pickupField > branchField, "current pickup should follow reusable routing context");
  assert.ok(dropoffField > pickupField, "current delivery location should follow pickup");

  const generationRequest = jobsSource.slice(
    jobsSource.indexOf('fetch("/api/admin/jobs/generate-posting"'),
    jobsSource.indexOf("const json = await res.json()", jobsSource.indexOf('fetch("/api/admin/jobs/generate-posting"')),
  );
  assert.match(generationRequest, /pickup_address:\s*requestedContext\.pickupAddress/);
  assert.match(generationRequest, /dropoff_address:\s*requestedContext\.dropoffAddress/);
  assert.match(generationRequest, /capacity:\s*requestedContext\.capacity/);
  assert.match(generationRequest, /pay_info:\s*requestedContext\.payInfo/);
});

test("posting generation gives the current job locations precedence over reusable master data", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/admin/jobs/generate-posting/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /body\?\.pickup_address/);
  assert.match(routeSource, /body\?\.dropoff_address/);
  assert.match(routeSource, /body\?\.capacity/);
  assert.match(routeSource, /body\?\.pay_info/);
  assert.match(routeSource, /buildCurrentJobPostingLocationContext\(currentLocation\)/);
  assert.match(routeSource, /buildCurrentJobPostingFactsContext\(currentFacts\)/);
  assert.match(routeSource, /\[masterContext, currentLocationContext, currentFactsContext\]/);
  assert.match(routeSource, /buildMockPosting\(prompt, formatCurrentJobPostingLocation\(currentLocation\), currentFacts\)/);
  assert.match(routeSource, /resolveJobAnnouncementBody\(\{ jobTitle: ai\.title, smsDraft: ai\.sms\.body \}\)/);
  assert.doesNotMatch(routeSource, /\["초보 가능", "주급 지급"\]/);
  assert.doesNotMatch(routeSource, /f\.pay \|\| "협의"/);
  assert.doesNotMatch(routeSource, /f\.schedule \|\| "협의"/);
});

test("a pasted operating memo can generate first and autofill structured job fields", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const generationStart = jobsSource.indexOf("const handleGenerateJD = async () => {");
  const generationEnd = jobsSource.indexOf("const copyChannel", generationStart);
  const generationSource = jobsSource.slice(generationStart, generationEnd);

  assert.doesNotMatch(
    generationSource,
    /validateJobCreateWorkLocation/,
    "blank locations must not block AI extraction from the pasted memo",
  );
  assert.match(generationSource, /p\.fields\?\.pickupAddress/);
  assert.match(generationSource, /p\.fields\?\.dropoffAddress/);
  assert.match(generationSource, /p\.fields\?\.capacity/);
  assert.match(generationSource, /p\.fields\?\.vehicleRequired/);
  assert.match(generationSource, /p\.fields\?\.workPeriod/);
  assert.match(generationSource, /p\.fields\?\.slotKeys/);
  assert.match(generationSource, /setGeneratedContext\(createJobGenerationContext\(\{/);
  assert.match(jobsSource, /메모에서 찾지 못한 필수 정보/);
  assert.match(jobsSource, /AI가 확인할 내용/);
  assert.match(jobsSource, /답변 반영해 초안 업데이트/);
  assert.match(jobsSource, /비워두면 붙여넣은 메모에서 AI가 찾아 채워요/);
  assert.ok(
    jobsSource.indexOf("AI에 전달할 배송 스케줄·라인 메모")
      < jobsSource.indexOf('id="new-job-context-title"'),
    "the paste-first AI brief must appear before manual context review",
  );
});

test("restoring a saved draft preserves its locations on the next AI generation", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const restoreStart = jobsSource.indexOf("const restoreNewJobDraft = async () => {");
  const restoreEnd = jobsSource.indexOf("const discardRecoverableNewJobDraft", restoreStart);
  const restoreSource = jobsSource.slice(restoreStart, restoreEnd);

  assert.match(restoreSource, /aiPrefilledPickupRef\.current = null/);
  assert.match(restoreSource, /aiPrefilledDropoffRef\.current = null/);
  assert.match(restoreSource, /newJobPickupAddressValueRef\.current = draft\.pickupAddress/);
  assert.match(restoreSource, /newJobDropoffAddressValueRef\.current = draft\.dropoffAddress/);
});

test("new-job close protects meaningful work and cannot race an in-flight registration", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const closeStart = jobsSource.indexOf("const closeRegisterModal = async () => {");
  const closeEnd = jobsSource.indexOf("// 공고 복제", closeStart);
  const modalStart = jobsSource.indexOf("{/* AI JD Generator Modal */}");
  const modalEnd = jobsSource.indexOf("{/* 공고 수정 모달", modalStart);

  assert.match(jobsSource, /const draftBody = jobCreateDraftBody\(channelDrafts\)/);
  assert.match(jobsSource, /const hasUnsavedNewJobDraft = hasJobCreateDraft\(\{/);
  assert.ok(closeStart >= 0 && closeEnd > closeStart, "new-job close handler should exist");

  const closeSource = jobsSource.slice(closeStart, closeEnd);
  assert.match(closeSource, /if \(registering \|\| closeRegisterConfirmPendingRef\.current\) return/);
  assert.match(closeSource, /if \(hasUnsavedNewJobDraft\)/);
  assert.match(closeSource, /cancelText: "계속 작성"/);

  const modalSource = jobsSource.slice(modalStart, modalEnd);
  assert.match(modalSource, /onClose=\{closeRegisterModal\} busy=\{registering\}/);
  assert.match(modalSource, /aria-label="공고 등록 창 닫기"[\s\S]*?disabled=\{registering\}/);
  assert.match(modalSource, />닫기<\/Button>/);
});

test("the latest new-job entry owns the form and query prefills start from empty defaults", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );

  const queryStart = jobsSource.indexOf("// 헤더 '공고 등록' 버튼");
  const queryEnd = jobsSource.indexOf("// 공고 목록은 SWR 캐시로", queryStart);
  const querySource = jobsSource.slice(queryStart, queryEnd);
  const invalidateCopy = querySource.indexOf("duplicateRequestIdRef.current += 1");
  const clearCopyLoading = querySource.indexOf("setDuplicatingId(null)");
  const resetForm = querySource.indexOf("resetNewJobForm()");
  const firstSosPrefill = querySource.indexOf("if (line) setPostingTitle");

  assert.ok(invalidateCopy >= 0, "query entry should invalidate a pending duplicate request");
  assert.ok(
    invalidateCopy < clearCopyLoading && clearCopyLoading < resetForm && resetForm < firstSosPrefill,
    "query entry must stop duplicate loading and reset before applying SOS values",
  );

  const duplicateStart = jobsSource.indexOf("const duplicateJob = async (jobId: string) => {");
  const duplicateEnd = jobsSource.indexOf("const handleRegisterJob", duplicateStart);
  const duplicateSource = jobsSource.slice(duplicateStart, duplicateEnd);
  const claimRequest = duplicateSource.indexOf("const requestId = ++duplicateRequestIdRef.current");
  const request = duplicateSource.indexOf("await fetch(");
  const parsed = duplicateSource.indexOf("await res.json()");
  const staleGuard = duplicateSource.indexOf("if (requestId !== duplicateRequestIdRef.current) return");
  const applyCopy = duplicateSource.indexOf("applyJobDuplicateSource(jobDuplicateSource(json.job))");

  assert.ok(claimRequest >= 0 && claimRequest < request, "duplicate should claim ownership before fetching");
  assert.ok(parsed < staleGuard && staleGuard < applyCopy, "a stale duplicate must return before touching form state");
  assert.match(
    duplicateSource,
    /catch \([^)]*\) \{[\s\S]*?if \(requestId === duplicateRequestIdRef\.current\) \{[\s\S]*?toast\.error/,
  );
  assert.match(
    duplicateSource,
    /finally \{[\s\S]*?if \(requestId === duplicateRequestIdRef\.current\) setDuplicatingId\(null\)/,
  );

  const blankOpenStart = jobsSource.indexOf("const openBlankNewJobForm = () => {");
  const blankOpenEnd = jobsSource.indexOf("};", blankOpenStart);
  const blankOpenSource = jobsSource.slice(blankOpenStart, blankOpenEnd);
  assert.match(blankOpenSource, /duplicateRequestIdRef\.current \+= 1/);
  assert.match(blankOpenSource, /resetNewJobForm\(\)/);

  assert.match(querySource, /const capacity = searchParams\.get\("capacity"\)/);
  assert.match(querySource, /setNewJobCapacity\(parsedCapacity\)/);

  assert.equal(
    jobsSource.match(/onClick=\{openBlankNewJobForm\}/g)?.length,
    2,
    "both in-page blank new-job actions should use the ownership-safe entry",
  );
});

test("a delayed duplicate action cannot replace an already-open new-job draft", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const duplicateStart = jobsSource.indexOf("const duplicateJob = async (jobId: string) => {");
  const duplicateEnd = jobsSource.indexOf("const handleRegisterJob", duplicateStart);
  const duplicateSource = jobsSource.slice(duplicateStart, duplicateEnd);
  const openDraftGuard = duplicateSource.indexOf("if (aiModalOpenRef.current)");
  const claimRequest = duplicateSource.indexOf("const requestId = ++duplicateRequestIdRef.current");

  assert.match(jobsSource, /const aiModalOpenRef = useRef\(aiModalOpen\)/);
  assert.match(jobsSource, /aiModalOpenRef\.current = aiModalOpen/);
  assert.ok(
    openDraftGuard >= 0 && openDraftGuard < claimRequest,
    "duplicate should refuse the action before claiming a request when a new-job draft is open",
  );
  assert.match(duplicateSource, /작성 중인 공고를 먼저 등록하거나 닫아 주세요/);
});

test("the primary toolbar can start from the most recent job", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const toolbarStart = jobsSource.indexOf('title="테스트 지원자의 맞춤 공고 링크');
  const toolbarEnd = jobsSource.indexOf("</div>", jobsSource.indexOf("openBlankNewJobForm", toolbarStart));
  const toolbarSource = jobsSource.slice(toolbarStart, toolbarEnd);

  assert.match(toolbarSource, /jobs\.length > 0/);
  assert.match(toolbarSource, /duplicateJob\(jobs\[0\]\.id\)/);
  assert.match(toolbarSource, /최근 공고로 시작/);
});

test("recruitment route cards use a roving radio group with arrow-key selection", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const fieldStart = jobsSource.indexOf("function RecruitModeField");
  const fieldEnd = jobsSource.indexOf("// 단가 형태 옵션", fieldStart);
  const fieldSource = jobsSource.slice(fieldStart, fieldEnd);

  assert.match(jobsSource, /import \* as RadioGroupPrimitive from "@radix-ui\/react-radio-group"/);
  assert.match(fieldSource, /<RadioGroupPrimitive\.Root/);
  assert.match(fieldSource, /<RadioGroupPrimitive\.Item/);
  assert.doesNotMatch(fieldSource, /role="radiogroup"/);
  assert.doesNotMatch(fieldSource, /role="radio"/);
});

test("new-job modal starts from the existing pool without expanding external recruitment choices", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const modalStart = jobsSource.indexOf("{/* AI JD Generator Modal */}");
  const modalEnd = jobsSource.indexOf("{/* 공고 수정 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);
  const recruitFieldStart = modalSource.indexOf("<RecruitModeField");
  const recruitFieldEnd = modalSource.indexOf("/>", recruitFieldStart);
  const recruitFieldSource = modalSource.slice(recruitFieldStart, recruitFieldEnd);

  assert.match(jobsSource, /const DEFAULT_RECRUIT_MODE: RecruitMode = "internal"/);
  assert.match(modalSource, /initialFocusRef=\{aiPromptRef\}/);
  assert.doesNotMatch(recruitFieldSource, /defaultOpen/);
  assert.doesNotMatch(recruitFieldSource, /initialFocusRef/);
});

test("recruitment mode offers external sourcing as a later supplement to the existing pool", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const modeStart = jobsSource.indexOf("const RECRUIT_MODE_META");
  const modeEnd = jobsSource.indexOf("function asRecruitMode", modeStart);
  const modeSource = jobsSource.slice(modeStart, modeEnd);
  const fieldStart = jobsSource.indexOf("function RecruitModeField");
  const fieldEnd = jobsSource.indexOf("// 단가 형태 옵션", fieldStart);
  const fieldSource = jobsSource.slice(fieldStart, fieldEnd);

  assert.match(jobsSource, /const DEFAULT_RECRUIT_MODE: RecruitMode = "internal"/);
  assert.match(modeSource, /both:\s*\{\s*label: "외부 모집도 추가"/);
  assert.match(modeSource, /우리 인력에게 먼저 안내하고 부족한 인원은 외부 지원 링크로 모집해요/);
  assert.doesNotMatch(fieldSource, /HIDDEN_RECRUIT_MODE/);
});

test("external-only job drafting keeps the editor on the posting body without a pool-SMS promise", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const modalStart = jobsSource.indexOf("{/* AI JD Generator Modal */}");
  const modalEnd = jobsSource.indexOf("{/* 공고 수정 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.match(jobsSource, /const visibleDraftChannel = newJobMode === "external" \? "albamon" : activeChannel/);
  assert.match(jobsSource, /const showPoolSmsDraft = newJobMode !== "external"/);
  assert.match(modalSource, /filter\(\(ch\) => newJobMode !== "external" \|\| ch\.id !== "sms"\)/);
  assert.match(modalSource, /channelDrafts\[visibleDraftChannel\]/);
  assert.match(
    jobsSource,
    /showPoolSmsDraft\s*\? "AI가 공고 원문과 문자 안내를 완성했어요\."\s*: "AI가 공고 원문을 완성했어요\."/,
  );
  assert.match(
    modalSource,
    /showPoolSmsDraft\s*\? "조건을 입력하면 AI가 공고 원문과 문자 안내를 다시 써줍니다"\s*: "조건을 입력하면 AI가 공고 원문을 다시 써줍니다"/,
  );
  assert.match(
    modalSource,
    /showPoolSmsDraft\s*\? "AI 옹봇이 공고 원문과 안내 문자를 작성하고 있습니다\.\.\."\s*: "AI 옹봇이 공고 원문을 작성하고 있습니다\.\.\."/,
  );
  assert.match(
    modalSource,
    /showPoolSmsDraft\s*\? "공고 원문 · 문자 안내"\s*: "공고 원문"/,
  );
  assert.doesNotMatch(jobsSource, /채널별 초안/);
  assert.match(jobsSource, /공고 원문과 안내 문구/);
});

test("a recoverable draft banner never overlaps the generated-copy editor", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const modalStart = jobsSource.indexOf("{/* AI JD Generator Modal */}");
  const modalEnd = jobsSource.indexOf("{/* 공고 수정 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.match(modalSource, /shadow-sm xl:col-span-2/);
  assert.match(modalSource, /aria-labelledby="new-job-context-title"[^>]+xl:col-span-2/);
  assert.doesNotMatch(
    modalSource,
    /recoverableNewJobDraft \? "xl:row-start/,
    "grid auto-placement should keep the generated editor after every full-width banner",
  );
  assert.equal(
    modalSource.match(/htmlFor="new-job-branch" className=/g)?.length,
    1,
    "the branch field must render one visible label",
  );
});
