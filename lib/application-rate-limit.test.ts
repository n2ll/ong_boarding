import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type AdmissionResult =
  | { kind: "admitted" | "replay" }
  | { kind: "conflict" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "error" };

type ApplicationRateLimitModule = {
  applicationRateLimitHash?: (
    namespace: "phone" | "ip",
    value: string,
    secret: string,
  ) => string;
  applicationInternalSignature?: (input: {
    submissionId: string;
    requestFingerprint: string;
    secret: string;
  }) => string;
  isTrustedApplicationInternalRequest?: (input: {
    source: unknown;
    submissionId: string;
    requestFingerprint: string;
    providedSignature: string | null;
    secret: string | null;
  }) => boolean;
  trustedApplicationClientIp?: (
    request: {
      ip?: unknown;
      headers: { get(name: string): string | null };
    },
    isVercel: boolean,
  ) => string | null;
  claimApplicationSubmissionAdmission?: (
    claim: () => Promise<{ data: unknown; error: unknown }>,
  ) => Promise<AdmissionResult>;
};

async function loadModule(): Promise<ApplicationRateLimitModule> {
  try {
    return await import(new URL("./application-rate-limit.ts", import.meta.url).href) as ApplicationRateLimitModule;
  } catch {
    return {};
  }
}

test("phone and network rate-limit keys are stable non-PII HMACs", async () => {
  const { applicationRateLimitHash } = await loadModule();
  assert.equal(typeof applicationRateLimitHash, "function");

  const phone = "01012345678";
  const phoneHash = applicationRateLimitHash!("phone", phone, "audit-secret");
  const repeat = applicationRateLimitHash!("phone", phone, "audit-secret");
  const ipHash = applicationRateLimitHash!("ip", phone, "audit-secret");

  assert.match(phoneHash, /^[0-9a-f]{64}$/);
  assert.equal(phoneHash, repeat);
  assert.notEqual(phoneHash, ipHash);
  assert.equal(phoneHash.includes(phone), false);
});

test("claim RPC failures and malformed outcomes fail closed", async () => {
  const { claimApplicationSubmissionAdmission } = await loadModule();
  assert.equal(typeof claimApplicationSubmissionAdmission, "function");

  assert.deepEqual(
    await claimApplicationSubmissionAdmission!(async () => ({ data: null, error: { code: "PGRST" } })),
    { kind: "error" },
  );
  assert.deepEqual(
    await claimApplicationSubmissionAdmission!(async () => {
      throw new Error("database unavailable");
    }),
    { kind: "error" },
  );
  assert.deepEqual(
    await claimApplicationSubmissionAdmission!(async () => ({ data: [{ outcome: "unexpected" }], error: null })),
    { kind: "error" },
  );
  assert.deepEqual(
    await claimApplicationSubmissionAdmission!(async () => ({ data: [{ outcome: "admitted" }], error: null })),
    { kind: "admitted" },
  );
  assert.deepEqual(
    await claimApplicationSubmissionAdmission!(async () => ({ data: { outcome: "replay" }, error: null })),
    { kind: "replay" },
  );
  assert.deepEqual(
    await claimApplicationSubmissionAdmission!(async () => ({
      data: [{ outcome: "rate_limited", retry_after_seconds: 87 }],
      error: null,
    })),
    { kind: "rate_limited", retryAfterSeconds: 87 },
  );
});

test("only the signed internal Tally adapter bypasses the shared network bucket", async () => {
  const {
    applicationInternalSignature,
    isTrustedApplicationInternalRequest,
  } = await loadModule();
  assert.equal(typeof applicationInternalSignature, "function");
  assert.equal(typeof isTrustedApplicationInternalRequest, "function");

  const input = {
    submissionId: "11111111-1111-4111-8111-111111111111",
    requestFingerprint: "a".repeat(64),
    secret: "tally-audit-secret",
  };
  const signature = applicationInternalSignature!(input);

  assert.equal(isTrustedApplicationInternalRequest!({
    source: "homepage",
    submissionId: input.submissionId,
    requestFingerprint: input.requestFingerprint,
    providedSignature: signature,
    secret: input.secret,
  }), true);
  assert.equal(isTrustedApplicationInternalRequest!({
    source: "homepage",
    submissionId: input.submissionId,
    requestFingerprint: input.requestFingerprint,
    providedSignature: "forged",
    secret: input.secret,
  }), false);
  assert.equal(isTrustedApplicationInternalRequest!({
    source: "homepage",
    submissionId: input.submissionId,
    requestFingerprint: input.requestFingerprint,
    providedSignature: null,
    secret: input.secret,
  }), false);
  assert.equal(isTrustedApplicationInternalRequest!({
    source: "direct",
    submissionId: input.submissionId,
    requestFingerprint: input.requestFingerprint,
    providedSignature: signature,
    secret: input.secret,
  }), false);
});

test("untrusted forwarding headers never become the only network identity", async () => {
  const { trustedApplicationClientIp } = await loadModule();
  assert.equal(typeof trustedApplicationClientIp, "function");

  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });
  assert.equal(trustedApplicationClientIp!({
    headers: headers({ "x-forwarded-for": "198.51.100.20" }),
  }, false), null);
  assert.equal(trustedApplicationClientIp!({
    headers: headers({ "x-real-ip": "198.51.100.21" }),
  }, false), null);
  assert.equal(trustedApplicationClientIp!({
    headers: headers({ "x-real-ip": "198.51.100.21" }),
  }, true), "198.51.100.21");
  assert.equal(trustedApplicationClientIp!({
    ip: "203.0.113.7",
    headers: headers({}),
  }, false), "203.0.113.7");
});

test("the public route claims attribution durably before applicant, geocode, or provider work", async () => {
  const [route, tally, page] = await Promise.all([
    readFile(new URL("../app/api/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/webhooks/tally/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/apply/page.tsx", import.meta.url), "utf8"),
  ]);

  const attributionClaim = route.indexOf('"claim_application_submission_with_attribution"');
  assert.ok(attributionClaim >= 0);
  for (const work of [
    '.from("applicants")',
    "geocodeAddress(",
    "sendSms(",
    "sendNotification(",
  ]) {
    assert.ok(attributionClaim < route.indexOf(work), `${work} must follow durable attribution claim`);
  }
  assert.match(route, /status:\s*429[\s\S]*Retry-After/);
  assert.match(tally, /applicationInternalSignature/);
  assert.match(tally, /\[APPLICATION_INTERNAL_HEADER\]:\s*applicationInternalSignature/);
  assert.match(page, /res\.status\s*===\s*429/);
});

test("the durable admission ledger is service-only and serializes submission, phone, then network", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-apply-public-rate-limit.sql", import.meta.url),
    "utf8",
  ).catch(() => "");

  assert.match(migration, /create table if not exists public\.application_submission_admissions/i);
  assert.match(migration, /submission_id uuid primary key/i);
  assert.match(migration, /request_fingerprint text not null/i);
  assert.match(migration, /phone_hash text not null/i);
  assert.match(migration, /ip_hash text not null/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.application_submission_admissions from public/i);
  assert.match(migration, /revoke all on table public\.application_submission_admissions from anon, authenticated/i);
  assert.match(migration, /grant select on table public\.application_submission_admissions to service_role/i);
  assert.match(migration, /create or replace function public\.claim_application_submission_admission/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = public, pg_temp/i);
  assert.match(migration, /apply:submission:[\s\S]*apply:phone:[\s\S]*apply:ip:/i);
  assert.match(migration, /revoke all on function public\.claim_application_submission_admission[\s\S]*from public/i);
  assert.match(migration, /revoke execute on function public\.claim_application_submission_admission[\s\S]*from anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.claim_application_submission_admission[\s\S]*to service_role/i);
});

const auditDatabaseUrl = process.env.ONG_APPLY_RATE_LIMIT_AUDIT_DATABASE_URL
  ?? process.env.ONG_MIGRATION_AUDIT_DATABASE_URL;

test(
  "the database atomically admits one concurrent phone request and preserves same-key replay",
  { skip: !auditDatabaseUrl },
  async () => {
    const pg = await import("pg");
    const Client = pg.default.Client;
    const admin = new Client({ connectionString: auditDatabaseUrl });
    const firstClient = new Client({ connectionString: auditDatabaseUrl });
    const secondClient = new Client({ connectionString: auditDatabaseUrl });
    await Promise.all([admin.connect(), firstClient.connect(), secondClient.connect()]);

    const firstId = randomUUID();
    const secondId = randomUUID();
    const cleanupIds = [firstId, secondId];
    const phoneHash = randomUUID().replaceAll("-", "").padEnd(64, "a");
    const ipHash = randomUUID().replaceAll("-", "").padEnd(64, "b");
    const firstFingerprint = "1".repeat(64);
    const secondFingerprint = "2".repeat(64);
    try {
      const marker = await admin.query<{ marker: string | null }>(
        "select current_setting('ongboarding.migration_audit', true) as marker",
      );
      assert.equal(
        marker.rows[0]?.marker,
        "enabled",
        "refusing to run admission migration test outside a disposable audit database",
      );

      for (const role of ["anon", "authenticated", "service_role"]) {
        await admin.query(`create role ${role} nologin`).catch((error: unknown) => {
          if ((error as { code?: string }).code !== "42710") throw error;
        });
      }
      const migration = await readFile(
        new URL("../docs/migrations/2026-08-apply-public-rate-limit.sql", import.meta.url),
        "utf8",
      );
      await admin.query(migration);

      const query = (
        client: import("pg").Client,
        submissionId: string,
        fingerprint: string,
      ) => client.query<{ outcome: string; retry_after_seconds: number }>(
        `select * from public.claim_application_submission_admission($1, $2, $3, $4, false)`,
        [submissionId, fingerprint, phoneHash, ipHash],
      );
      const concurrent = await Promise.all([
        query(firstClient, firstId, firstFingerprint),
        query(secondClient, secondId, secondFingerprint),
      ]);
      assert.deepEqual(
        concurrent.map((result) => result.rows[0]?.outcome).sort(),
        ["admitted", "rate_limited"],
      );

      const admittedIndex = concurrent.findIndex((result) => result.rows[0]?.outcome === "admitted");
      const admittedId = admittedIndex === 0 ? firstId : secondId;
      const admittedFingerprint = admittedIndex === 0 ? firstFingerprint : secondFingerprint;
      const replay = await query(admin, admittedId, admittedFingerprint);
      assert.equal(replay.rows[0]?.outcome, "replay");
      const conflict = await query(admin, admittedId, "f".repeat(64));
      assert.equal(conflict.rows[0]?.outcome, "conflict");

      const directIpHash = randomUUID().replaceAll("-", "").padEnd(64, "c");
      const directOutcomes: string[] = [];
      for (let index = 0; index < 11; index += 1) {
        const id = randomUUID();
        cleanupIds.push(id);
        const result = await admin.query<{ outcome: string }>(
          `select * from public.claim_application_submission_admission($1, $2, $3, $4, false)`,
          [
            id,
            index.toString(16).padStart(64, "0"),
            randomUUID().replaceAll("-", "").padEnd(64, "d"),
            directIpHash,
          ],
        );
        directOutcomes.push(result.rows[0]?.outcome ?? "missing");
      }
      assert.deepEqual(directOutcomes, [
        ...Array.from({ length: 10 }, () => "admitted"),
        "rate_limited",
      ]);

      const trustedIpHash = randomUUID().replaceAll("-", "").padEnd(64, "e");
      for (let index = 0; index < 12; index += 1) {
        const id = randomUUID();
        cleanupIds.push(id);
        const trusted = await admin.query<{ outcome: string }>(
          `select * from public.claim_application_submission_admission($1, $2, $3, $4, true)`,
          [
            id,
            (index + 20).toString(16).padStart(64, "0"),
            randomUUID().replaceAll("-", "").padEnd(64, "f"),
            trustedIpHash,
          ],
        );
        assert.equal(trusted.rows[0]?.outcome, "admitted");
      }
    } finally {
      await admin.query(
        "delete from public.application_submission_admissions where submission_id = any($1::uuid[])",
        [cleanupIds],
      ).catch(() => undefined);
      await Promise.allSettled([admin.end(), firstClient.end(), secondClient.end()]);
    }
  },
);
