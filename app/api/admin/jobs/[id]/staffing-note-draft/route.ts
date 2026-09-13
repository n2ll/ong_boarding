import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createServiceClient } from "@/lib/supabase";
import { generateStaffingNoteProposal } from "@/lib/admin/staffing-note-ai";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };

function validReferenceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value && value <= today;
}

export async function POST(req: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const jobId = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(jobId)) {
      return NextResponse.json({ error: "올바른 공고를 선택해주세요." }, { status: 400 });
    }
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
      body = value;
    } catch { return NextResponse.json({ error: "정리할 메모를 확인해주세요." }, { status: 400 }); }
    const applicantId = body.applicant_id;
    if (typeof applicantId !== "number" || !Number.isSafeInteger(applicantId) || applicantId <= 0
      || typeof body.note !== "string" || !body.note.trim() || body.note.length > 1000 || !validReferenceDate(body.reference_date)) {
      return NextResponse.json({ error: "후보와 메모 기준일을 확인해주세요. 메모는 1000자까지, 기준일은 오늘까지 입력할 수 있어요." }, { status: 400 });
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return NextResponse.json({ error: "로그인 설정을 확인해주세요." }, { status: 503 });
    const auth = createServerClient(url, key, {
      cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
    });
    const { data: { user }, error } = await auth.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "로그인 상태를 확인한 뒤 다시 시도해주세요." }, { status: 401 });
    const allowedEmails = (process.env.ADMIN_ALLOWED_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    if (allowedEmails.length && (!user.email || !allowedEmails.includes(user.email.toLowerCase()))) {
      return NextResponse.json({ error: "메모를 정리할 관리자 권한이 없습니다." }, { status: 403 });
    }
    const db = createServiceClient();
    const candidate = await db.from("job_candidates").select("id").eq("job_id", jobId).eq("applicant_id", applicantId).maybeSingle();
    if (candidate.error) throw candidate.error;
    if (!candidate.data) return NextResponse.json({ error: "이 공고에 연결된 후보의 메모만 정리할 수 있어요." }, { status: 404 });
    const job = await db.from("jobs").select("title").eq("id", jobId).maybeSingle();
    if (job.error) throw job.error;
    if (!job.data) return NextResponse.json({ error: "공고를 확인하지 못했습니다." }, { status: 404 });
    const proposal = await generateStaffingNoteProposal({ jobTitle: job.data.title, note: body.note.trim(), referenceDate: body.reference_date }, db);
    if (!proposal) return NextResponse.json({ error: "메모를 정리하지 못했어요. 잠시 후 다시 시도해주세요." }, { status: 503 });
    return NextResponse.json({ proposal });
  } catch {
    // Request notes and provider errors can contain personal details; return only a fixed message.
    return NextResponse.json({ error: "메모를 정리하지 못했어요. 잠시 후 다시 시도해주세요." }, { status: 503 });
  }
}
