import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type ApplicationBranchContext =
  | { mode: "none" }
  | { mode: "fixed"; branch: string }
  | { mode: "choice"; branches: string[] };

type ApplicationBranchModule = {
  applicationBranchName?: (value: string | null | undefined) => string | null;
  applicationSourceRequiresBranchChoice?: (source: string) => boolean;
  applicationUsesLegacyBmartFlow?: (input: {
    source: string;
    branch: string | null | undefined;
  }) => boolean;
  applicationBranchContext?: (input: {
    fixedBranch?: string | null;
    allowChoice: boolean;
    activeBranches?: readonly string[];
  }) => ApplicationBranchContext;
  resolveApplicationBranchSubmission?: (
    context: ApplicationBranchContext,
    requested: { branch1: string; branch2: string },
  ) =>
    | { ok: true; branch1: string; branch2: string | null }
    | { ok: false; field: "branch1" | "branch2"; message: string };
  applicationBranchReceiptLine?: (branch: string | null | undefined) => string | null;
  applicationActiveFixedBranchName?: (input: {
    name: string | null | undefined;
    active: boolean | null | undefined;
    clientId: number | null | undefined;
    jobClientId: number | null;
  }) => string | null;
};

async function loadApplicationBranchModule(): Promise<ApplicationBranchModule> {
  try {
    const modulePath = "./application-branch.ts";
    return await import(modulePath) as ApplicationBranchModule;
  } catch {
    return {};
  }
}

test("a canonical job branch wins and cannot be changed by applicant input", async () => {
  const { applicationBranchContext, resolveApplicationBranchSubmission } = await loadApplicationBranchModule();

  assert.equal(typeof applicationBranchContext, "function");
  assert.equal(typeof resolveApplicationBranchSubmission, "function");
  const context = applicationBranchContext!({
    fixedBranch: "  서대문신촌  ",
    allowChoice: true,
    activeBranches: ["강남", "서대문신촌"],
  });
  assert.deepEqual(context, { mode: "fixed", branch: "서대문신촌" });
  assert.deepEqual(resolveApplicationBranchSubmission!(context, {
    branch1: "강남",
    branch2: "송파",
  }), { ok: true, branch1: "서대문신촌", branch2: null });
});

test("a fixed job branch must still be active and owned by the job client", async () => {
  const { applicationActiveFixedBranchName } = await loadApplicationBranchModule();

  assert.equal(typeof applicationActiveFixedBranchName, "function");
  assert.equal(applicationActiveFixedBranchName!({
    name: "서대문신촌",
    active: true,
    clientId: 7,
    jobClientId: 7,
  }), "서대문신촌");
  assert.equal(applicationActiveFixedBranchName!({
    name: "서대문신촌",
    active: false,
    clientId: 7,
    jobClientId: 7,
  }), null);
  assert.equal(applicationActiveFixedBranchName!({
    name: "서대문신촌",
    active: true,
    clientId: 8,
    jobClientId: 7,
  }), null);
  assert.equal(applicationActiveFixedBranchName!({
    name: "서대문신촌",
    active: true,
    clientId: 8,
    jobClientId: null,
  }), "서대문신촌");
});

test("branchless placeholders never become fixed application branches", async () => {
  const {
    applicationBranchContext,
    applicationBranchName,
    applicationBranchReceiptLine,
  } = await loadApplicationBranchModule();

  assert.equal(typeof applicationBranchContext, "function");
  assert.equal(typeof applicationBranchName, "function");
  assert.equal(typeof applicationBranchReceiptLine, "function");
  for (const placeholder of ["", "-", "미지정", "미확인", "  미지정  "]) {
    assert.equal(applicationBranchName!(placeholder), null);
    assert.deepEqual(applicationBranchContext!({
      fixedBranch: placeholder,
      allowChoice: false,
    }), { mode: "none" });
    assert.equal(applicationBranchReceiptLine!(placeholder), null);
  }
  assert.deepEqual(applicationBranchContext!({
    fixedBranch: "미지정",
    allowChoice: true,
    activeBranches: ["-", "강남", "미확인"],
  }), { mode: "choice", branches: ["강남"] });
});

test("only the explicit B mart source requires the legacy branch chooser", async () => {
  const { applicationSourceRequiresBranchChoice } = await loadApplicationBranchModule();

  assert.equal(typeof applicationSourceRequiresBranchChoice, "function");
  assert.equal(applicationSourceRequiresBranchChoice!("baemin"), true);
  for (const source of ["danggeun", "direct", "homepage", "facebook"]) {
    assert.equal(applicationSourceRequiresBranchChoice!(source), false);
  }
});

test("a generic acquisition source enters the legacy B mart flow only with a real branch", async () => {
  const { applicationUsesLegacyBmartFlow } = await loadApplicationBranchModule();

  assert.equal(typeof applicationUsesLegacyBmartFlow, "function");
  assert.equal(applicationUsesLegacyBmartFlow!({ source: "baemin", branch: "강남" }), true);
  assert.equal(applicationUsesLegacyBmartFlow!({ source: "baemin", branch: "미지정" }), false);
  assert.equal(applicationUsesLegacyBmartFlow!({ source: "danggeun", branch: "강남" }), false);
  assert.equal(applicationUsesLegacyBmartFlow!({ source: "danggeun", branch: "미지정" }), false);
  assert.equal(applicationUsesLegacyBmartFlow!({ source: "danggeun", branch: null }), false);
  assert.equal(applicationUsesLegacyBmartFlow!({ source: "direct", branch: "강남" }), false);
});

test("ordinary general applications ignore stale branch answers", async () => {
  const { applicationBranchContext, resolveApplicationBranchSubmission } = await loadApplicationBranchModule();

  assert.equal(typeof applicationBranchContext, "function");
  assert.equal(typeof resolveApplicationBranchSubmission, "function");
  const context = applicationBranchContext!({
    fixedBranch: null,
    allowChoice: false,
    activeBranches: ["강남"],
  });
  assert.deepEqual(context, { mode: "none" });
  assert.deepEqual(resolveApplicationBranchSubmission!(context, {
    branch1: "구버전 임시저장 값",
    branch2: "임의 값",
  }), { ok: true, branch1: "미지정", branch2: null });
});

test("branch choice is scoped, deduplicated, and validated", async () => {
  const { applicationBranchContext, resolveApplicationBranchSubmission } = await loadApplicationBranchModule();

  assert.equal(typeof applicationBranchContext, "function");
  assert.equal(typeof resolveApplicationBranchSubmission, "function");
  const context = applicationBranchContext!({
    allowChoice: true,
    activeBranches: [" 강남 ", "서초", "강남", ""],
  });
  assert.deepEqual(context, { mode: "choice", branches: ["강남", "서초"] });
  assert.deepEqual(resolveApplicationBranchSubmission!(context, {
    branch1: "강남",
    branch2: "서초",
  }), { ok: true, branch1: "강남", branch2: "서초" });
  assert.deepEqual(resolveApplicationBranchSubmission!(context, {
    branch1: "송파",
    branch2: "",
  }), {
    ok: false,
    field: "branch1",
    message: "선택 가능한 희망 지점을 다시 확인해주세요.",
  });
  assert.deepEqual(resolveApplicationBranchSubmission!(context, {
    branch1: "강남",
    branch2: "미지정",
  }), { ok: true, branch1: "강남", branch2: null });
  assert.deepEqual(resolveApplicationBranchSubmission!(context, {
    branch1: "강남",
    branch2: "강남",
  }), {
    ok: false,
    field: "branch2",
    message: "1순위와 다른 지점을 선택해주세요.",
  });
});

test("branchless receipts do not render an empty branch label", async () => {
  const { applicationBranchReceiptLine } = await loadApplicationBranchModule();

  assert.equal(typeof applicationBranchReceiptLine, "function");
  assert.equal(applicationBranchReceiptLine!(null), null);
  assert.equal(applicationBranchReceiptLine!(""), null);
  assert.equal(applicationBranchReceiptLine!("-"), null);
  assert.equal(applicationBranchReceiptLine!("미지정"), null);
  assert.equal(applicationBranchReceiptLine!("미확인"), null);
  assert.equal(applicationBranchReceiptLine!(" 강남 "), "▶ 지원 근무지: 강남");
});

test("public application routes scope and enforce branch context on the server", async () => {
  const [applyRoute, jobRoute, branchesRoute, adminApplicantsRoute] = await Promise.all([
    readFile(new URL("../app/api/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/apply/job/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/branches/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/applicants/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(applyRoute, /resolveApplicationBranchSubmission/);
  assert.match(applyRoute, /applicationActiveFixedBranchName/);
  assert.match(applyRoute, /select\("id, title, status, closes_at, exposure, recruit_mode, vehicle_required, branch, branch_id, client_id"\)/);
  assert.match(applyRoute, /branch1:\s*resolvedBranch\.branch1/);
  assert.match(applyRoute, /branch2:\s*resolvedBranch\.branch2/);
  assert.match(applyRoute, /applicationBranchReceiptLine/);
  assert.match(applyRoute, /applicationUsesLegacyBmartFlow/);
  assert.match(applyRoute, /road_address:\s*trustedInternal \? geo\?\.road_address \?\? null : normalizedLocation/);
  assert.doesNotMatch(applyRoute, /`▶ 지원지점:/);
  assert.doesNotMatch(applyRoute, /source === "danggeun" \|\| source === "baemin"/);
  assert.ok(
    applyRoute.indexOf("const submissionFingerprint") < applyRoute.indexOf("const normalizedLocation"),
    "normalizing persisted location must not change the durable request fingerprint",
  );

  assert.match(jobRoute, /branch_mode:/);
  assert.match(jobRoute, /applicationActiveFixedBranchName/);
  assert.match(jobRoute, /select\("name, active, client_id"\)/);
  assert.match(jobRoute, /branches:/);
  assert.match(jobRoute, /\.from\("branches"\)/);
  assert.match(jobRoute, /\.eq\("client_id", job\.client_id\)/);

  assert.match(branchesRoute, /\.eq\("client_type", "baemin_bmart"\)/);
  assert.match(branchesRoute, /\.in\("client_id", clientIds\)/);
  assert.match(adminApplicantsRoute, /const manualLegacyBmartFlow = applicationUsesLegacyBmartFlow/);
  assert.match(adminApplicantsRoute, /const isDanggeun = source === "danggeun_practice"/);
});

test("the applicant UI renders branches only from an explicit server-backed context", async () => {
  const page = await readFile(new URL("../app/apply/page.tsx", import.meta.url), "utf8");

  assert.match(page, /branch_mode:\s*"none" \| "fixed" \| "choice"/);
  assert.match(page, /branchMode === "choice"/);
  assert.match(page, /branchMode === "fixed"/);
  assert.match(page, /validateApplicationSubmission\(form, vehicleRequired, branchChoiceRequired\)/);
  assert.match(page, /applicationSubmissionProgress\(form, vehicleRequired, branchChoiceRequired\)/);
  assert.doesNotMatch(page, /직접 입력 가능/);
  assert.doesNotMatch(page, /placeholder="희망 지점을 입력해주세요"/);
  assert.match(page, /applicationSourceRequiresBranchChoice\(source\)/);
  assert.match(page, /!draftReady \|\| pendingSubmissionReplay \|\| !branchContextReady/);
  assert.match(page, /setBranchListLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(page, /secondBranchDetailsRef\.current\?\.setAttribute\("open", ""\)/);
  assert.match(page, /kakao-postcode-script/);
  assert.match(page, /embedApplicantPostcode\(\{/);
  assert.match(page, /readOnly=\{!addressManualEntry\}/);
  assert.match(page, /도로명 주소 직접 입력/);
  assert.match(page, /min-h-12 min-w-12/);
  assert.match(page, /예: 모닝 \/ 아반떼 \/ 스타렉스 \/ 포터/);
  assert.match(page, /배송에 사용할 차량 모델명을 입력해주세요/);
  assert.match(page, /<p role="alert" id=\{fieldErrorId\(field\)\}/);
});
