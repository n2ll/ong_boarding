/**
 * GET /api/admin/search?q=...
 *
 * 헤더 글로벌 검색(⌘K)용. 지원자(이름/연락처)와 채용공고(제목)를 동시에 조회한다.
 * service_role로 동작하므로 RLS와 무관하게 어드민 검색이 가능하다.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type ApplicantHit = {
  id: number;
  name: string | null;
  phone: string | null;
  status: string | null;
  branch: string | null;
};

export async function GET(req: NextRequest) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ applicants: [], jobs: [] });

  const supabase = createServiceClient();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const phoneLike = `%${q.replace(/[^0-9]/g, "")}%`;

  const [appRes, jobRes] = await Promise.all([
    supabase
      .from("applicants")
      .select("id, name, phone, status, branch, branch1, confirmed_branch")
      .or(
        `name.ilike.${like}` +
          (q.replace(/[^0-9]/g, "") ? `,phone.ilike.${phoneLike}` : "")
      )
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("jobs")
      .select("id, title, status")
      .ilike("title", like)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  const applicants: ApplicantHit[] = (appRes.data ?? [])
    .map((a) => ({
      id: a.id as number,
      name: (a.name as string | null) ?? null,
      phone: (a.phone as string | null) ?? null,
      status: (a.status as string | null) ?? null,
      branch:
        (a.confirmed_branch as string | null) ||
        (a.branch1 as string | null) ||
        (a.branch as string | null) ||
        null,
    }));

  const jobs = (jobRes.data ?? [])
    .filter((j) => !String(j.title ?? "").startsWith("__"))
    .map((j) => ({
      id: j.id as number,
      title: (j.title as string | null) ?? "",
      status: (j.status as string | null) ?? null,
    }));

  return NextResponse.json({ applicants, jobs });
}
