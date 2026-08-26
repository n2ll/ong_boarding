import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("new job flow asks for routing context before the AI brief", () => {
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
  assert.ok(branchField > clientField, "branch field should follow the client field");
  assert.ok(pickupField > branchField, "current pickup should follow reusable routing context");
  assert.ok(dropoffField > pickupField, "current delivery location should follow pickup");
  assert.ok(aiBrief > dropoffField, "AI brief should follow the current posting locations");

  const generationRequest = jobsSource.slice(
    jobsSource.indexOf('fetch("/api/admin/jobs/generate-posting"'),
    jobsSource.indexOf("const json = await res.json()", jobsSource.indexOf('fetch("/api/admin/jobs/generate-posting"')),
  );
  assert.match(generationRequest, /pickup_address:\s*requestedContext\.pickupAddress/);
  assert.match(generationRequest, /dropoff_address:\s*requestedContext\.dropoffAddress/);
});

test("posting generation gives the current job locations precedence over reusable master data", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/admin/jobs/generate-posting/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /body\?\.pickup_address/);
  assert.match(routeSource, /body\?\.dropoff_address/);
  assert.match(routeSource, /buildCurrentJobPostingLocationContext\(currentLocation\)/);
  assert.match(routeSource, /\[masterContext, currentLocationContext\]/);
  assert.match(routeSource, /buildMockPosting\(prompt, formatCurrentJobPostingLocation\(currentLocation\)\)/);
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
