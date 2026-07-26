/**
 * GET/POST /api/admin/reengagement/switch
 *
 * '다시 부르기(재활용·재편입)' 기능 스위치. 과거 인력(외부 DB)을 인력풀로 편입할 수 있게 하는 게이트로,
 * OFF면 미리보기만 되고 아무 것도 반입되지 않는다(lib/reengagement.isReengagementEnabled).
 *
 * 화면(재활용 탭)은 "법적 검토·승인 후 스위치를 켜세요"라고 안내하는데 콘솔 어디에도 그 스위치가 없어서
 * DB를 직접 고쳐야 했다 → 설정에서 매니저가 켜고 끌 수 있게 이 엔드포인트를 둔다.
 * 저장 위치는 기존과 동일(prompt_examples category='system_message', title='__reengagement_switch__').
 *
 * 값 검증을 위해 전용 라우트로 둔다 — 범용 prompt-examples 쓰기를 설정 토글에 쓰면
 * 임의 지식 항목까지 덮어쓸 수 있는 표면이 생긴다.
 */

import { NextRequest, NextResponse } from "next/server";
import { isReengagementEnabled, setReengagementEnabled } from "@/lib/reengagement";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ enabled: await isReengagementEnabled() });
  } catch (e) {
    console.error("[reengagement/switch GET]", e);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { enabled } = (await req.json()) as { enabled?: unknown };
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled(boolean)는 필수입니다." }, { status: 400 });
    }
    await setReengagementEnabled(enabled);
    return NextResponse.json({ ok: true, enabled });
  } catch (e) {
    console.error("[reengagement/switch POST]", e);
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
}
