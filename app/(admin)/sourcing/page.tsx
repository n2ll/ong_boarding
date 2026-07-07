import { redirect } from "next/navigation";

// 파일럿 기간: 데모 대시보드(/sourcing) 직행 차단 — 채용공고 관리로 리다이렉트
export default function Page() {
  redirect("/jobs");
}
