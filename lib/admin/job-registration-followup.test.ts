import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  beginJobRegistrationFollowup,
  settleJobRegistrationFollowup,
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
