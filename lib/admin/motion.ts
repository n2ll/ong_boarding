import type { Variants } from "framer-motion";

/*
  옹보딩 공용 모션 프리셋 — DESIGN.md "Motion" 참조.
  entrance(등장)는 fadeUp + stagger, 값은 절제(거리 8~15px, 0.35~0.4s, easeOut).
  과한 스프링/바운스 금지(에디토리얼 톤 유지).
*/

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 15 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

export const fadeUpSm: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};

export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};
