import assert from "node:assert/strict";
import test from "node:test";

type SettingsSection = "integrations" | "branches" | "team" | "switches";

type SettingsNavigationModule = {
  settingsSectionFromLocation?: (search: string, hash?: string) => SettingsSection;
  settingsSectionHref?: (section: SettingsSection) => string;
};

async function loadModule(): Promise<SettingsNavigationModule> {
  try {
    return await import(new URL("./settings-navigation.ts", import.meta.url).href) as SettingsNavigationModule;
  } catch {
    return {};
  }
}

test("settings opens the operational integration status by default", async () => {
  const { settingsSectionFromLocation } = await loadModule();

  assert.equal(typeof settingsSectionFromLocation, "function");
  assert.equal(settingsSectionFromLocation!(""), "integrations");
  assert.equal(settingsSectionFromLocation!("?section=unknown"), "integrations");
});

test("settings sections use shareable query links", async () => {
  const { settingsSectionFromLocation, settingsSectionHref } = await loadModule();

  assert.equal(typeof settingsSectionFromLocation, "function");
  assert.equal(typeof settingsSectionHref, "function");
  assert.equal(settingsSectionFromLocation!("?section=branches"), "branches");
  assert.equal(settingsSectionFromLocation!("?section=team"), "team");
  assert.equal(settingsSectionHref!("integrations"), "/settings");
  assert.equal(settingsSectionHref!("switches"), "/settings?section=switches");
});

test("legacy settings hashes still resolve to their operational section", async () => {
  const { settingsSectionFromLocation } = await loadModule();

  assert.equal(typeof settingsSectionFromLocation, "function");
  assert.equal(settingsSectionFromLocation!("", "#branches"), "branches");
  assert.equal(settingsSectionFromLocation!("", "#team"), "team");
  assert.equal(settingsSectionFromLocation!("", "#switches"), "switches");
});
