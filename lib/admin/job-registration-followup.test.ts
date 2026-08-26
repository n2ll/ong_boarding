import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  beginJobRegistrationFollowup,
  settleJobRegistrationFollowup,
  type JobRegistrationFollowup,
} from "./job-registration-followup.ts";

type Announcement = { targets: number };

test("a successful registration exposes a durable follow-up while announcement targets load", () => {
  assert.deepEqual(
    beginJobRegistrationFollowup<Announcement>({
      jobId: 42,
      title: "강남 배송원 모집",
      note: "상차지 좌표를 확인해 주세요.",
    }),
    {
      jobId: 42,
      title: "강남 배송원 모집",
      note: "상차지 좌표를 확인해 주세요.",
      announcement: { status: "checking" },
    },
  );
});

test("a late announcement lookup cannot revive a dismissed or newer registration follow-up", () => {
  const current = beginJobRegistrationFollowup<Announcement>({
    jobId: 43,
    title: "서초 배송원 모집",
    note: null,
  });
  const ready = { status: "ready", payload: { targets: 3 } } as const;

  assert.equal(settleJobRegistrationFollowup(null, 42, ready), null);
  assert.equal(settleJobRegistrationFollowup(current, 42, ready), current);
});

test("only the matching registration receives its announcement result", () => {
  const current: JobRegistrationFollowup<Announcement> = beginJobRegistrationFollowup({
    jobId: 44,
    title: "송파 배송원 모집",
    note: null,
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

test("same-conditions action keeps the completion modal recoverable while the source job loads", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const duplicateStart = jobsSource.indexOf("const duplicateJob = async (jobId: string) => {");
  const duplicateEnd = jobsSource.indexOf("const handleRegisterJob = async () => {", duplicateStart);
  const duplicateSource = jobsSource.slice(duplicateStart, duplicateEnd);
  const modalStart = jobsSource.indexOf("{/* 등록 완료 후속 단계");
  const modalEnd = jobsSource.indexOf("{/* 새 공고 안내 확인 모달", modalStart);
  const modalSource = jobsSource.slice(modalStart, modalEnd);

  assert.match(duplicateSource, /setRegistrationFollowup\(null\);\s*setAiModalOpen\(true\)/);
  assert.match(duplicateSource, /const controller = new AbortController\(\)/);
  assert.match(duplicateSource, /signal: controller\.signal/);
  assert.match(duplicateSource, /clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(
    modalSource,
    /const jobId = registrationFollowup\.jobId;\s*setRegistrationFollowup\(null\);\s*void duplicateJob/,
  );
  assert.match(
    modalSource,
    /busy=\{duplicatingId === String\(registrationFollowup\.jobId\)\}/,
  );
  assert.match(
    modalSource,
    /isLoading=\{duplicatingId === String\(registrationFollowup\.jobId\)\}/,
  );
});
