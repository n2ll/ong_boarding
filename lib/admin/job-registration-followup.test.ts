import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  beginJobRegistrationFollowup,
  settleJobRegistrationFollowup,
  shouldOfferSosCandidateSelection,
  type JobRegistrationFollowup,
} from "./job-registration-followup.ts";

type Announcement = { targets: number };
type DuplicateSource = { title: string; body: string };

const duplicateSource: DuplicateSource = {
  title: "강남 배송원 모집",
  body: "공고 본문",
};

test("a successful registration exposes a durable follow-up while announcement targets load", () => {
  assert.deepEqual(
    beginJobRegistrationFollowup<Announcement, DuplicateSource>({
      jobId: 42,
      title: "강남 배송원 모집",
      note: "상차지 좌표를 확인해 주세요.",
      duplicateSource,
    }),
    {
      jobId: 42,
      title: "강남 배송원 모집",
      note: "상차지 좌표를 확인해 주세요.",
      duplicateSource,
      announcement: { status: "checking" },
    },
  );
});

test("an external-only registration starts with an explicit non-applicable announcement state", () => {
  assert.deepEqual(
    beginJobRegistrationFollowup<Announcement, DuplicateSource>({
      jobId: 45,
      title: "외부 채널 전용 공고",
      note: null,
      duplicateSource,
      announcement: {
        status: "empty",
        description: "외부 채널 모집 전용 공고라 인력풀 문자 안내를 보내지 않아요.",
      },
    }),
    {
      jobId: 45,
      title: "외부 채널 전용 공고",
      note: null,
      duplicateSource,
      announcement: {
        status: "empty",
        description: "외부 채널 모집 전용 공고라 인력풀 문자 안내를 보내지 않아요.",
      },
    },
  );
});

test("a late announcement lookup cannot revive a dismissed or newer registration follow-up", () => {
  const current = beginJobRegistrationFollowup<Announcement, DuplicateSource>({
    jobId: 43,
    title: "서초 배송원 모집",
    note: null,
    duplicateSource,
  });
  const ready = { status: "ready", payload: { targets: 3 } } as const;

  assert.equal(settleJobRegistrationFollowup(null, 42, ready), null);
  assert.equal(settleJobRegistrationFollowup(current, 42, ready), current);
});

test("only the matching registration receives its announcement result", () => {
  const current: JobRegistrationFollowup<Announcement, DuplicateSource> = beginJobRegistrationFollowup({
    jobId: 44,
    title: "송파 배송원 모집",
    note: null,
    duplicateSource,
  });

  assert.deepEqual(
    settleJobRegistrationFollowup(current, 44, {
      status: "ready",
      payload: { targets: 5 },
    }),
    {
      ...current,
      announcement: { status: "ready", payload: { targets: 5 } },
    },
  );
});

test("SOS candidate selection is only offered to jobs visible to the existing pool", () => {
  assert.equal(shouldOfferSosCandidateSelection("17", "internal"), true);
  assert.equal(shouldOfferSosCandidateSelection("17", "both"), true);
  assert.equal(shouldOfferSosCandidateSelection("17", "external"), false);
  assert.equal(shouldOfferSosCandidateSelection(null, "internal"), false);
});

test("announcement lookup cannot keep the core registration request pending", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const registrationStart = jobsSource.indexOf("const handleRegisterJob = async () => {");
  const registrationEnd = jobsSource.indexOf("const q = query.trim()", registrationStart);
  const registrationSource = jobsSource.slice(registrationStart, registrationEnd);

  assert.match(registrationSource, /void fetchAnnounceTargets\(newJobId\)/);
  assert.doesNotMatch(registrationSource, /await fetchAnnounceTargets\(newJobId\)/);
});

test("external-only registration never opens an announcement lookup whose pull link cannot show the job", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const registrationStart = jobsSource.indexOf("const handleRegisterJob = async () => {");
  const registrationEnd = jobsSource.indexOf("const q = query.trim()", registrationStart);
  const registrationSource = jobsSource.slice(registrationStart, registrationEnd);

  assert.match(registrationSource, /newJobRow\?\.recruitMode === "external"[\s\S]*외부 채널 모집 전용/);
  assert.match(
    registrationSource,
    /newJobId !== null && !sosSnapshot\.id && newJobRow\?\.recruitMode !== "external"/,
  );
});

test("same-conditions completion action reuses the successful POST snapshot without another GET", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const directStart = jobsSource.indexOf("const duplicateRegisteredJob = (source: JobDuplicateSource) => {");
  const directEnd = jobsSource.indexOf("const duplicateJob = async (jobId: string) => {", directStart);
  const directSource = jobsSource.slice(directStart, directEnd);
  const modalStart = jobsSource.indexOf("{/* 등록 완료 후속 단계");
  const modalEnd = jobsSource.indexOf("{/* 새 공고 안내 확인 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.ok(directStart >= 0 && directEnd > directStart, "direct duplicate handler should exist");
  assert.ok(
    directSource.indexOf("duplicateRequestIdRef.current += 1") < directSource.indexOf("applyJobDuplicateSource(source)"),
    "the direct path must invalidate older duplicate requests before applying the POST snapshot",
  );
  assert.match(modalSource, /duplicateRegisteredJob\(registrationFollowup\.duplicateSource\)/);
  assert.doesNotMatch(modalSource, /duplicateJob\(String\(jobId\)\)/);
  assert.doesNotMatch(modalSource, /isLoading=\{duplicatingId === String\(registrationFollowup\.jobId\)\}/);
});

test("registration completion does not promote an unsupported Danggeun publishing step", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const modalStart = jobsSource.indexOf("{/* 등록 완료 후속 단계");
  const modalEnd = jobsSource.indexOf("{/* 새 공고 안내 확인 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.doesNotMatch(modalSource, /당근에 공고 게시하기/);
  assert.doesNotMatch(modalSource, /당근 게시 내용 · 지원 링크 복사/);
  assert.match(modalSource, /우리 인력에게 새 공고 안내/);
});

test("job announcements preview and send one resolved draft and stay open while sending", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const announcementStart = jobsSource.indexOf("{/* 새 공고 안내 확인 모달");
  const announcementEnd = jobsSource.indexOf("{/* 공고별 지원자 보드", announcementStart);
  const announcementSource = jobsSource.slice(announcementStart, announcementEnd);

  assert.doesNotMatch(jobsSource, /NEW_JOB_NOTICE/);
  assert.match(jobsSource, /body: at\.sms_body/);
  assert.match(jobsSource, /sendBulkNotices\(targetsToSend, body, "new_job"/);
  assert.match(announcementSource, /busy=\{announcing\}/);
  assert.match(announcementSource, /\{announceModal\.body\}/);
});

test("job notice chunks share one confirmed outbox batch key and never recommend retrying uncertain sends", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const sendStart = jobsSource.indexOf("const sendBulkNotices = async (");
  const sendEnd = jobsSource.indexOf("// 미선발 관심자에게", sendStart);
  const sendSource = jobsSource.slice(sendStart, sendEnd);
  const batchKey = sendSource.indexOf("const bulkRequestId = crypto.randomUUID()");
  const chunkLoop = sendSource.indexOf("for (let i = 0; i < targets.length; i += 50)");
  const retryAdvice = sendSource.indexOf("미시도 대상만 다시 시도할 수 있어요.");

  assert.ok(batchKey >= 0 && batchKey < chunkLoop, "one batch key must cover every notice chunk");
  assert.match(sendSource, /bulk_request_id: bulkRequestId/);
  assert.match(sendSource, /bulkSendChunkResults\(json, chunk\.length\)/);
  assert.match(sendSource, /httpBulkFailureKind\(res\.status, json\)/);
  assert.match(sendSource, /recordRecoveryCount \+= 1/);
  assert.match(sendSource, /기록 복구 중 \$\{recordRecoveryCount\}명/);
  assert.ok(retryAdvice >= 0, "retry advice should remain for declared failures");
  assert.match(
    sendSource,
    /catch \{[\s\S]{0,420}?attentionTargets\.push\(\.\.\.chunk\)/,
    "a lost HTTP response is uncertain, not a retryable unsent chunk",
  );
  assert.match(
    sendSource,
    /if \(!chunkResults\)[\s\S]{0,320}?attentionTargets\.push\(\.\.\.chunk\)/,
    "an empty or malformed successful response must stay uncertain",
  );
});

test("job announcement mixed results keep the modal open and retry only confirmed-not-sent targets", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const sendStart = jobsSource.indexOf("const sendAnnounce = async () => {");
  const sendEnd = jobsSource.indexOf("// 마감 확정", sendStart);
  const sendSource = jobsSource.slice(sendStart, sendEnd);
  const modalStart = jobsSource.indexOf("{/* 새 공고 안내 확인 모달");
  const modalEnd = jobsSource.indexOf("{/* 공고별 지원자 보드", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.match(sendSource, /announceSendReport\?\.retryableTargets/);
  assert.match(sendSource, /nextReport\.attentionTargets\.length > 0 \|\| nextReport\.retryableTargets\.length > 0/);
  assert.match(sendSource, /setAnnounceSendReport/);
  assert.match(modalSource, /발송 결과 확인 중/);
  assert.match(modalSource, /재발송하지 마세요/);
  assert.match(modalSource, /announceSendReport\.retryableTargets\.length/);
  assert.match(modalSource, /미시도 대상만 다시 시도/);
});

test("job notice 504 and malformed 2xx responses never become retryable", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const classifierStart = jobsSource.indexOf("function httpBulkFailureKind(");
  const classifierEnd = jobsSource.indexOf("\n}\n", classifierStart) + 3;
  const classifier = jobsSource.slice(classifierStart, classifierEnd);

  assert.match(classifier, /status === 503/);
  assert.match(classifier, /status === 504/);
  assert.match(classifier, /return "attention"/);
  assert.match(jobsSource, /function bulkSendChunkResults\(/);
  assert.match(jobsSource, /results\.length !== expectedCount/);
});

test("closing a job cannot dismiss its in-flight status or optional SMS operation", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const closeStart = jobsSource.indexOf("{/* 공고 마감 확인 모달");
  const closeEnd = jobsSource.indexOf("{/* 등록 완료 후속 단계", closeStart);
  const closeSource = jobsSource.slice(closeStart, closeEnd);

  assert.match(closeSource, /busy=\{closing\}/);
  assert.match(closeSource, /onClose=\{\(\) => \{ if \(!closing\) setCloseModal\(null\); \}\}/);
});

test("SOS registration persists the job link and keeps candidate selection as a durable next step", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const registrationStart = jobsSource.indexOf("const handleRegisterJob = async () => {");
  const registrationEnd = jobsSource.indexOf("const q = query.trim()", registrationStart);
  const registrationSource = jobsSource.slice(registrationStart, registrationEnd);
  const modalStart = jobsSource.indexOf("{/* 등록 완료 후속 단계");
  const modalEnd = jobsSource.indexOf("{/* 새 공고 안내 확인 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.match(registrationSource, /fetch\(`\/api\/admin\/sos\/\$\{sosSnapshot\.id\}`/);
  assert.match(registrationSource, /body: JSON\.stringify\(\{ job_id: newJobId \}\)/);
  assert.match(registrationSource, /shouldOfferSosCandidateSelection\(sosSnapshot\.id, newJobRow\?\.recruitMode\)/);
  assert.match(modalSource, /긴급 건에 맞는 인력 선별/);
  assert.match(jobsSource, /params\.set\("job", String\(registrationSosContext\.jobId\)\)/);
});
