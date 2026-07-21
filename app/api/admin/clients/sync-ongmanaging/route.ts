/**
 * POST /api/admin/clients/sync-ongmanaging
 *
 * 옹매니징(외부 프로젝트) 화주사를 로컬 clients로 동기화한다.
 * 실제 화주사 원본은 옹매니징에 있고, 공고(jobs.client_id, bigint FK)는 로컬 clients만 참조할 수
 * 있으므로 — 옹매니징 화주사를 로컬 clients로 미러링해 공고 폼 셀렉터·FK 귀속을 성립시킨다.
 *
 * 매핑 규칙(upsert):
 *   1) ongmanaging_client_id(UUID)가 이미 매핑된 로컬 행 → 이름이 바뀌었으면 갱신(rename sync)
 *   2) 없으면 이름이 같은 로컬 행(아직 미매핑) → 그 행에 UUID만 채워 흡수(seed·수동생성 행 어댑트)
 *   3) 그래도 없으면 새 로컬 clients 행 생성(client_type='general', uses_slots=false)
 *
 * uses_slots·client_type 등 로컬 메타는 동기화가 건드리지 않는다(관리자가 화주사 편집에서 설정).
 * 미구성이면 { configured:false } 200 반환(에러 아님 — UI가 미연동 안내).
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchClientsMaster, isOngmanagingConfigured } from "@/lib/ongmanaging";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isOngmanagingConfigured()) {
    return NextResponse.json({ configured: false, error: "옹매니징 연동이 설정되지 않았어요." }, { status: 200 });
  }

  try {
    const master = await fetchClientsMaster();
    const supabase = createServiceClient();

    const { data: locals, error: readErr } = await supabase
      .from("clients")
      .select("id, name, ongmanaging_client_id");
    if (readErr) {
      console.error("[clients/sync-ongmanaging] local read", readErr);
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }

    // 이름 매칭 정규화 — '배민 비마트' vs '배민비마트' 같은 표기차로 중복 로컬 행이 생기지 않게 흡수.
    const norm = (s: string) => s.trim().replace(/\s+/g, "").toLowerCase();

    const byUuid = new Map<string, { id: number; name: string }>();
    const byName = new Map<string, { id: number; ongmanaging_client_id: string | null }>();
    for (const c of locals ?? []) {
      const row = c as { id: number; name: string; ongmanaging_client_id: string | null };
      if (row.ongmanaging_client_id) byUuid.set(row.ongmanaging_client_id, { id: row.id, name: row.name });
      byName.set(norm(row.name), { id: row.id, ongmanaging_client_id: row.ongmanaging_client_id });
    }

    let created = 0;
    let renamed = 0;
    let linked = 0;
    const errors: string[] = [];

    for (const m of master) {
      const uuid = m.id;
      const name = (m.name || "").trim();
      if (!uuid || !name) continue;

      // 1) 이미 UUID로 매핑됨 → 이름 변경 시에만 갱신
      const mapped = byUuid.get(uuid);
      if (mapped) {
        if (mapped.name.trim() !== name) {
          const { error } = await supabase.from("clients").update({ name }).eq("id", mapped.id);
          if (error) errors.push(`rename ${name}: ${error.message}`);
          else renamed++;
        }
        continue;
      }

      // 2) 이름이 같은 미매핑 로컬 행 흡수(seed·수동 생성 행)
      const named = byName.get(norm(name));
      if (named && !named.ongmanaging_client_id) {
        const { error } = await supabase
          .from("clients")
          .update({ ongmanaging_client_id: uuid })
          .eq("id", named.id);
        if (error) {
          errors.push(`link ${name}: ${error.message}`);
        } else {
          linked++;
          // 맵 즉시 갱신 — 동명 후속 마스터 행이 같은 로컬 행을 재링크해 앞 UUID를 조용히 덮어쓰지 않게.
          // (named는 byName에 저장된 객체 참조라 프로퍼티 변형으로 즉시 반영된다.)
          named.ongmanaging_client_id = uuid;
          byUuid.set(uuid, { id: named.id, name });
        }
        continue;
      }

      // 3) 신규 로컬 화주사 생성
      const { data: ins, error } = await supabase
        .from("clients")
        .insert({
          name,
          client_type: "general",
          uses_slots: false,
          ongmanaging_client_id: uuid,
        })
        .select("id")
        .single();
      if (error) {
        // 이름 유니크 충돌(다른 UUID가 같은 이름을 이미 점유) 등은 스킵하고 계속(errors로 노출).
        errors.push(`insert ${name}: ${error.message}`);
      } else if (ins) {
        created++;
        // 맵 갱신 — 순수 신규 경로의 동명 중복도 재사용/충돌로 드러나게(무음 중복 생성 방지).
        byName.set(norm(name), { id: ins.id as number, ongmanaging_client_id: uuid });
        byUuid.set(uuid, { id: ins.id as number, name });
      }
    }

    return NextResponse.json({
      configured: true,
      total: master.length,
      created,
      renamed,
      linked,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    console.error("[clients/sync-ongmanaging] failed", e);
    return NextResponse.json({ error: "옹매니징 동기화에 실패했어요." }, { status: 500 });
  }
}
