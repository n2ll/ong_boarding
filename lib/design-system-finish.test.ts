import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function luminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test("resting controls use a dedicated boundary with at least 3:1 contrast", () => {
  const theme = source("styles/theme.css");
  const token = theme.match(/--control-border:\s*(#[0-9A-Fa-f]{6})/)?.[1];

  assert.ok(token, "theme should define --control-border");
  const ratio = (luminance("#FFFDFA") + 0.05) / (luminance(token) + 0.05);
  assert.ok(ratio >= 3, `control boundary contrast was ${ratio.toFixed(2)}:1`);
  assert.match(theme, /--color-control-border:\s*var\(--control-border\)/);

  for (const file of [
    "components/ui/field.tsx",
    "components/ui/input.tsx",
    "components/ui/select.tsx",
    "components/ui/textarea.tsx",
  ]) {
    assert.match(source(file), /border-control-border/, `${file} should consume the control token`);
  }

  const apply = source("app/apply/page.tsx");
  assert.match(apply, /const inputCls =\s*\n\s*"[^"]*border-control-border/);
  assert.doesNotMatch(apply, /border-border-strong bg-card text-gray-700/);
  assert.doesNotMatch(apply, /border-gray-300/);
});

test("shared field errors announce themselves and remain programmatically connected", () => {
  const field = source("components/ui/field.tsx");
  const input = source("components/ui/input.tsx");

  assert.match(field, /aria-describedby=\{describedBy\}/);
  assert.match(field, /aria-invalid=\{invalid \|\| undefined\}/);
  assert.match(field, /role=\{error \? "alert" : undefined\}/);
  assert.match(input, /aria-describedby=\{describedById\}/);
  assert.match(input, /aria-invalid=\{error \? true : undefined\}/);
  assert.match(input, /role=\{error \? "alert" : undefined\}/);
});

test("motion and small controls respect user accessibility preferences", () => {
  const theme = source("styles/theme.css");
  const rootLayout = source("app/layout.tsx");
  const preferences = source("components/MotionPreferences.tsx");
  const modal = source("components/ui/modal.tsx");
  const checkbox = source("components/ui/checkbox.tsx");
  const switchSource = source("components/ui/switch.tsx");

  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(rootLayout, /<MotionPreferences>\{children\}<\/MotionPreferences>/);
  assert.match(preferences, /reducedMotion="user"/);
  assert.match(modal, /size-11/);
  assert.match(checkbox, /after:-inset-3/);
  assert.match(switchSource, /h-7 w-12/);
});

test("operational attention does not borrow destructive red", () => {
  const sos = source("components/SosLedgerCard.tsx");
  const interest = source("components/InterestQueueCard.tsx");

  assert.match(sos, /border-priority-critical\/25 bg-priority-critical-soft/);
  assert.match(sos, /text-priority-critical-ink/);
  assert.doesNotMatch(sos, /bg-error hover:bg-error-strong/);
  assert.match(interest, /<Heart size=\{15\} className="text-priority-attention-ink"/);
  assert.match(interest, /bg-priority-critical-soft/);
  assert.match(interest, /text-priority-critical-ink/);
});

test("high-frequency icon actions use the shared 44px button target", () => {
  const pipeline = source("components/Pipeline.tsx");
  const live = source("components/LiveConsole.tsx");
  const jobs = source("components/Jobs.tsx");

  assert.match(pipeline, /<Button[^>]*size="icon"[^>]*aria-label="일괄 상태 변경 창 닫기"/);
  assert.match(pipeline, /<Button[^>]*size="icon"[^>]*aria-label="문자 보내기 창 닫기"/);
  assert.match(pipeline, /<Button[^>]*size="icon"[^>]*aria-label="이 단계 메뉴 열기"[^>]*aria-expanded=\{menuOpen\}/);
  assert.match(live, /<Button[^>]*size="icon"[^>]*aria-label="지원자 상세 닫기"/);
  assert.match(jobs, /DropdownMenuTrigger asChild>[\s\S]*?<Button[\s\S]*?size="icon"[\s\S]*?더보기/);
  assert.match(jobs, /aria-label="전화번호 복사"[\s\S]*?<Copy[^>]*\/>\s*복사\s*<\/Button>/);
});

test("stage accents describe hiring stages, not operational signals", () => {
  const pipeline = source("components/Pipeline.tsx");
  const jobs = source("components/Jobs.tsx");
  const live = source("components/LiveConsole.tsx");

  assert.match(pipeline, /<Badge[^>]*title="지금 붙어 있는 공고는 없어요[^>]*>\s*지난 공고 ·/);
  assert.doesNotMatch(pipeline, /<StageBadge[^>]*label=\{`지난 공고/);
  assert.match(pipeline, /availabilityMeta\.tone === "success" \? "success" : availabilityMeta\.tone === "info" \? "info"/);

  assert.match(jobs, /job\.reviewReady[\s\S]*?<Badge variant="stage-screening"/);
  assert.match(jobs, /job\.aiInProgress[\s\S]*?<Badge variant="info"/);
  assert.match(jobs, /job\.interestCount[\s\S]*?<Badge variant="priority-attention"/);

  assert.match(live, /pending_draft[\s\S]*?bg-copilot-soft/);
  assert.match(live, /AI 응대 중[\s\S]*?bg-info-soft/);
  assert.match(live, /modeNotice === "off" \? "border-priority-critical\/30 bg-priority-critical-soft/);
  assert.match(live, /modeNotice === "draft" \? "border-copilot\/30 bg-copilot-soft/);
});
