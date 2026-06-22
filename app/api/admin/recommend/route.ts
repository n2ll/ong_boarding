import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { extractJobInfo } from "@/lib/claude";
import { geocodeAddress } from "@/lib/kakao-geocode";
import {
  rankCandidates,
  CandidateForScoring,
  ScoredCandidate,
} from "@/lib/scoring";

export const dynamic = "force-dynamic";

interface RecommendBody {
  posting: string;
  manualAddress?: string;
  manualVehicleRequired?: boolean;
  topN?: number;
  /** applicants.source 컬럼 필터 — 'danggeun' 지정 시 당근 유입 후보만 풀에 포함하고 legacy는 제외 */
  sourceFilter?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RecommendBody;
    const posting = (body.posting || "").trim();
    if (!posting) {
      return NextResponse.json(
        { error: "공고 내용을 입력해주세요." },
        { status: 400 }
      );
    }

    // 1) 공고 → 주소·조건 추출 (수동 입력 우선)
    let address = body.manualAddress?.trim() || "";
    let vehicleRequired =
      typeof body.manualVehicleRequired === "boolean"
        ? body.manualVehicleRequired
        : true;
    let schedule = "";
    let summary = "";

    if (!address) {
      const extracted = await extractJobInfo(posting, createServiceClient());
      if (!extracted) {
        return NextResponse.json(
          { error: "공고에서 주소를 추출하지 못했습니다. 직접 입력해주세요." },
          { status: 400 }
        );
      }
      address = extracted.address;
      // vehicleRequired는 매니저가 직접 입력한 값 그대로 유지 (Claude 값 무시)
      schedule = extracted.schedule || "";
      summary = extracted.summary || "";
    }

    // 2) 주소 → 좌표
    const geo = await geocodeAddress(address);
    if (!geo) {
      return NextResponse.json(
        { error: `주소 좌표 변환 실패: '${address}'` },
        { status: 400 }
      );
    }

    // 3) 후보 풀: applicants(활성) + legacy_applicants
    const supabase = createServiceClient();

    // applicants(B마트) 중 status가 '확정'/'부적합'이 아니면 모두 풀에 포함
    let activeQuery = supabase
      .from("applicants")
      .select("id, name, phone, lat, lng, own_vehicle, created_at, sigungu, location, status, birth_date")
      .not("status", "in", "(확정,부적합)")
      .not("lat", "is", null);
    if (body.sourceFilter) {
      activeQuery = activeQuery.eq("source", body.sourceFilter);
    }
    const { data: activeRows, error: aErr } = await activeQuery;

    if (aErr) {
      console.error("[recommend] applicants query error", aErr);
      return NextResponse.json({ error: aErr.message }, { status: 500 });
    }

    // sourceFilter가 지정되면 legacy_applicants는 제외 (legacy엔 source 컬럼 없음)
    const legacyRows = body.sourceFilter
      ? []
      : (await supabase
          .from("legacy_applicants")
          .select("id, name, phone, lat, lng, own_vehicle, submitted_at, imported_at, sigungu, location, promoted_applicant_id, birth_date")
          .is("promoted_applicant_id", null)
          .not("disqualified", "is", true)
          .not("lat", "is", null)).data ?? [];

    const candidates: CandidateForScoring[] = [
      ...(activeRows || []).map((r) => ({
        id: r.id as number,
        source: "applicant" as const,
        name: r.name as string,
        phone: r.phone as string,
        lat: Number(r.lat),
        lng: Number(r.lng),
        own_vehicle: r.own_vehicle as string | null,
        created_at: r.created_at as string,
        sigungu: r.sigungu as string | null,
        location: r.location as string | null,
        birth_date: r.birth_date as string | null,
      })),
      ...(legacyRows || []).map((r) => ({
        id: r.id as number,
        source: "legacy" as const,
        name: r.name as string,
        phone: r.phone as string,
        lat: Number(r.lat),
        lng: Number(r.lng),
        own_vehicle: r.own_vehicle as string | null,
        created_at: (r.submitted_at || r.imported_at) as string,
        sigungu: r.sigungu as string | null,
        location: r.location as string | null,
        birth_date: r.birth_date as string | null,
      })),
    ];

    const topN = Math.max(1, Math.min(50, body.topN || 10));
    const ranked: ScoredCandidate[] = rankCandidates(
      candidates,
      geo.lat,
      geo.lng,
      vehicleRequired,
      topN
    );

    return NextResponse.json({
      success: true,
      job: {
        address,
        lat: geo.lat,
        lng: geo.lng,
        sigungu: geo.sigungu,
        vehicle_required: vehicleRequired,
        schedule,
        summary,
      },
      poolSize: candidates.length,
      candidates: ranked,
    });
  } catch (err) {
    console.error("[recommend] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
