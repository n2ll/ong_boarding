import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the shared radius scale separates controls, cards, panels, and modals", () => {
  const theme = read("../../styles/theme.css");

  assert.match(theme, /--radius-md:\s*12px;\s*\/\* 컨트롤 \*\//);
  assert.match(theme, /--radius-lg:\s*16px;\s*\/\* 카드 하한 \*\//);
  assert.match(theme, /--radius-panel:\s*20px;/);
  assert.match(theme, /--radius-xl:\s*24px;/);
});

test("shared buttons and fields use the control radius instead of the card radius", () => {
  const button = read("../../components/ui/button.tsx");
  const field = read("../../components/ui/field.tsx");

  assert.match(button, /sm: "[^"]*rounded-md"/);
  assert.match(button, /default: "[^"]*rounded-md"/);
  assert.match(button, /lg: "[^"]*rounded-md"/);
  assert.doesNotMatch(button, /(?:sm|default|lg): "[^"]*rounded-2xl"/);
  assert.match(field, /controlBase\s*=\s*\n\s*"[^"]*rounded-md/);
});

test("shared tabs keep a compact nested radius hierarchy", () => {
  const tabs = read("../../components/ui/tabs.tsx");

  assert.match(tabs, /tabs-list[\s\S]*?rounded-md/);
  assert.match(tabs, /tabs-trigger[\s\S]*?rounded-sm/);
});
