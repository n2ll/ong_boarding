/**
 * 시연용 외부 채널 게시 상태 영속화 (클라이언트 전용 / localStorage).
 *
 * (A) 외부 채널 게시형 흐름을 "실제 동작처럼" 보여주기 위한 임시 저장소.
 * 추후 실제 게시 API 연동 시 이 모듈을 서버 상태로 교체하면 된다.
 * SSR 안전: 모든 접근은 typeof window 가드.
 */

export type ExternalChannel = "danggeun" | "albamon" | "jobkorea";

export interface ChannelMeta {
  key: ExternalChannel;
  label: string;
  accent: string;
  soft: string;
  /** 미리보기/리스트 로고 약자 */
  badge: string;
  /** 시연용 예상 도달 */
  reach: string;
  cpa: string;
}

export const EXTERNAL_CHANNELS: Record<ExternalChannel, ChannelMeta> = {
  danggeun: { key: "danggeun", label: "당근알바", accent: "#FF6F0F", soft: "#FFF3EA", badge: "당", reach: "약 1,800명", cpa: "₩6,900" },
  albamon: { key: "albamon", label: "알바몬", accent: "#E8344E", soft: "#FFF0F2", badge: "A", reach: "약 3,200명", cpa: "₩11,300" },
  jobkorea: { key: "jobkorea", label: "잡코리아", accent: "#1F7AE0", soft: "#EAF3FE", badge: "J", reach: "약 2,400명", cpa: "₩9,400" },
};

export interface PublishedChannelStat {
  channel: ExternalChannel;
  /** 게시 결과 mock 노출 URL */
  listingUrl: string;
  reach: string;
  /** 게시 후 유입된(시뮬레이션) 지원자 수 */
  applicants: number;
}

export interface PublishedJob {
  id: string;
  jobTitle: string;
  location: string;
  channels: ExternalChannel[];
  stats: PublishedChannelStat[];
  publishedAt: string;
}

const KEY = "ong_demo_published_jobs";

export function getPublishedJobs(): PublishedJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PublishedJob[]) : [];
  } catch {
    return [];
  }
}

export function savePublishedJob(job: PublishedJob): PublishedJob[] {
  if (typeof window === "undefined") return [];
  const list = getPublishedJobs();
  // 같은 id면 채널 합치고 갱신
  const idx = list.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    const merged = new Set([...list[idx].channels, ...job.channels]);
    list[idx] = { ...job, channels: Array.from(merged) };
  } else {
    list.unshift(job);
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent("ong-published-updated"));
  } catch {
    /* ignore */
  }
  return list;
}

export function buildPublishStats(channels: ExternalChannel[]): PublishedChannelStat[] {
  return channels.map((c) => {
    const meta = EXTERNAL_CHANNELS[c];
    const reachNum = parseInt(meta.reach.replace(/[^\d]/g, ""), 10) || 1500;
    // 도달의 0.8~1.6% 정도가 초기 유입된 것처럼
    const applicants = Math.max(3, Math.round((reachNum * (0.008 + Math.random() * 0.008))));
    return {
      channel: c,
      listingUrl: `https://${c}.example.com/jobs/${Math.random().toString(36).slice(2, 9)}`,
      reach: meta.reach,
      applicants,
    };
  });
}
