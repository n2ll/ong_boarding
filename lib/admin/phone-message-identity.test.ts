import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhoneMessageIdentityIndex,
  fetchPhoneMessageIdentityIndex,
  type PhoneMessageIdentityRow,
} from "./phone-message-identity.ts";

type QueryCall = {
  from: number;
  to: number;
};

function row(
  id: number,
  overrides: Partial<PhoneMessageIdentityRow> = {},
): PhoneMessageIdentityRow {
  return {
    id,
    phone: `010-0000-${String(id).padStart(4, "0")}`,
    marketing_consent: true,
    marketing_consent_at: "2026-08-20T00:00:00.000Z",
    sms_opt_out_at: null,
    status: "온보딩",
    current_job_id: null,
    ...overrides,
  };
}

function createSupabaseStub(
  rows: PhoneMessageIdentityRow[],
  calls: QueryCall[],
  failFrom?: number,
) {
  return {
    from(table: string) {
      assert.equal(table, "applicants");
      return {
        select(columns: string) {
          assert.equal(
            columns,
            "id, phone, marketing_consent, marketing_consent_at, sms_opt_out_at, status, current_job_id",
          );
          return this;
        },
        order(column: string, options?: { ascending?: boolean }) {
          assert.equal(column, "id");
          assert.equal(options?.ascending, true);
          return this;
        },
        async range(from: number, to: number) {
          calls.push({ from, to });
          if (from === failFrom) {
            return { data: null, error: { message: "identity page unavailable" } };
          }
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
    },
  };
}

test("groups duplicate applicant rows by the shared normalized phone", () => {
  const index = buildPhoneMessageIdentityIndex([
    row(1, { phone: "010-1234-5678" }),
    row(2, { phone: "01012345678" }),
  ]);

  const identity = index.byPhone.get("01012345678");
  assert.deepEqual(identity?.applicantIds, [1, 2]);
  assert.equal(index.phoneByApplicantId.get(1), "01012345678");
  assert.equal(index.phoneByApplicantId.get(2), "01012345678");
});

test("an opt-out on any duplicate row blocks the phone when no later explicit consent exists", () => {
  const index = buildPhoneMessageIdentityIndex([
    row(1, {
      phone: "010-1234-5678",
      marketing_consent_at: "2026-08-20T00:00:00.000Z",
    }),
    row(2, {
      phone: "01012345678",
      marketing_consent: false,
      marketing_consent_at: null,
      sms_opt_out_at: "2026-08-21T00:00:00.000Z",
    }),
  ]);

  assert.equal(index.byPhone.get("01012345678")?.hasActiveSmsOptOut, true);
});

test("only a strictly later timestamped explicit re-consent clears a phone-level opt-out", () => {
  const laterConsent = buildPhoneMessageIdentityIndex([
    row(1, {
      phone: "010-1234-5678",
      marketing_consent: false,
      marketing_consent_at: null,
      sms_opt_out_at: "2026-08-21T00:00:00.000Z",
    }),
    row(2, {
      phone: "01012345678",
      marketing_consent: true,
      marketing_consent_at: "2026-08-22T00:00:00.000Z",
    }),
  ]);
  const sameTimestamp = buildPhoneMessageIdentityIndex([
    row(1, {
      phone: "010-1234-5678",
      sms_opt_out_at: "2026-08-21T00:00:00.000Z",
      marketing_consent_at: "2026-08-21T00:00:00.000Z",
    }),
  ]);

  assert.equal(laterConsent.byPhone.get("01012345678")?.hasActiveSmsOptOut, false);
  assert.equal(sameTimestamp.byPhone.get("01012345678")?.hasActiveSmsOptOut, true);
});

test("an invalid opt-out timestamp remains fail-closed", () => {
  const index = buildPhoneMessageIdentityIndex([
    row(1, {
      phone: "010-1234-5678",
      sms_opt_out_at: "invalid",
      marketing_consent_at: "2026-08-30T00:00:00.000Z",
    }),
  ]);

  assert.equal(index.byPhone.get("01012345678")?.hasActiveSmsOptOut, true);
});

test("fetches every applicant identity page past the PostgREST default row cap", async () => {
  const rows = Array.from({ length: 1_001 }, (_, index) => row(index + 1));
  const calls: QueryCall[] = [];

  const index = await fetchPhoneMessageIdentityIndex(
    createSupabaseStub(rows, calls) as never,
  );

  assert.equal(index.phoneByApplicantId.size, 1_001);
  assert.deepEqual(calls, [
    { from: 0, to: 999 },
    { from: 1_000, to: 1_999 },
  ]);
});

test("rejects a later applicant identity page failure instead of using partial policy state", async () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => row(index + 1));
  const calls: QueryCall[] = [];

  await assert.rejects(
    fetchPhoneMessageIdentityIndex(createSupabaseStub(rows, calls, 1_000) as never),
    /identity page unavailable/,
  );
  assert.deepEqual(calls, [
    { from: 0, to: 999 },
    { from: 1_000, to: 1_999 },
  ]);
});
