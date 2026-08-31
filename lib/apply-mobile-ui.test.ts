import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function applyPageSource(): Promise<string> {
  return readFile(new URL("../app/apply/page.tsx", import.meta.url), "utf8");
}

test("application text fields reserve their ring for keyboard-visible focus", async () => {
  const page = await applyPageSource();
  const inputClasses = page.match(/const inputCls =\s*\n\s*"([^"]+)"/)?.[1] ?? "";

  assert.match(inputClasses, /focus-visible:ring-2/);
  assert.match(inputClasses, /focus-visible:ring-ring\/40/);
  assert.doesNotMatch(inputClasses, /(?:^|\s)focus:ring-/);
  assert.equal(inputClasses.match(/focus-visible:ring-2/g)?.length, 1);
});

test("a validation failure has one live alert while the field keeps its description and focus recovery", async () => {
  const page = await applyPageSource();
  const fieldError = page.slice(
    page.indexOf("function FieldError"),
    page.indexOf("interface JobContext"),
  );
  const stickyErrorStart = page.indexOf("{error && (", page.indexOf("sticky top-0"));
  const stickyError = page.slice(stickyErrorStart, stickyErrorStart + 350);

  assert.match(fieldError, /<p role="alert" id=\{fieldErrorId\(field\)\}/);
  assert.doesNotMatch(stickyError, /role="alert"|aria-live=/);
  assert.match(page, /invalidField === field \? fieldErrorId\(field\) : null/);
  assert.match(page, /field\?\.querySelector<HTMLElement>\("input, select, textarea, button"\)\?\.focus/);
});

test("the application progress panel is never sticky in landscape, including error state", async () => {
  const page = await applyPageSource();
  const progressStart = page.indexOf("sticky top-0");
  const progressClasses = page.slice(progressStart, progressStart + 550);

  assert.ok(progressStart >= 0, "progress panel should remain identifiable");
  assert.match(progressClasses, /landscape:static/);
  assert.doesNotMatch(progressClasses, /\$\{error\s*\?/);
});

test("the Kakao postcode bundle loads only after the address-search action", async () => {
  const page = await applyPageSource();
  const addressAction = page.slice(
    page.indexOf("const openRoadAddressLookup"),
    page.indexOf("const handleSubmit"),
  );

  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*void loadKakaoPostcodeScript/);
  assert.match(addressAction, /await loadKakaoPostcodeScript\(\)/);
});

test("multi-select work-hour choices use square checkbox grammar and a check mark", async () => {
  const page = await applyPageSource();
  const choices = page.slice(
    page.indexOf("APPLICATION_WORK_HOUR_OPTIONS.map"),
    page.indexOf("<FieldError field=\"workHours\"", page.indexOf("APPLICATION_WORK_HOUR_OPTIONS.map")),
  );

  assert.match(choices, /aria-pressed=\{checked\}/);
  assert.match(choices, /w-6 h-6 rounded-\[6px\]/);
  assert.match(choices, /<Check size=\{16\}/);
  assert.doesNotMatch(choices, /<CheckCircle2 size=\{16\}/);
});
