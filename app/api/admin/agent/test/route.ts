import { NextRequest, NextResponse } from "next/server";
import { generateDraftReply, AgentApplicantContext, AgentTurn } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface TestBody {
  inbound_text: string;
  job_posting?: string | null;
  manual_history?: AgentTurn[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TestBody;
    const inboundText = (body.inbound_text || "").trim();
    if (!inboundText) {
      return NextResponse.json(
        { error: "인입 메시지를 입력해주세요." },
        { status: 400 }
      );
    }

    // 빈 컨텍스트 — 공고만으로 응대 시뮬레이션
    const applicant: AgentApplicantContext = {
      id: null,
      name: null,
      phone: "(테스트번호)",
      branch1: null,
      branch2: null,
      confirmed_branch: null,
      current_branch: null,
      work_hours: null,
      status: null,
      available_date: null,
      own_vehicle: null,
      introduction: null,
    };

    const history: AgentTurn[] = Array.isArray(body.manual_history)
      ? body.manual_history
      : [];

    const draft = await generateDraftReply({
      applicant,
      history,
      latestInbound: inboundText,
      jobPosting: body.job_posting || null,
    });

    if (!draft) {
      return NextResponse.json(
        { error: "Claude 호출 실패 (서버 로그 확인)" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      draft,
      context: {
        applicant,
        history_turn_count: history.length,
      },
    });
  } catch (err) {
    console.error("[admin/agent/test] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
