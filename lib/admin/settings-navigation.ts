export type SettingsSection = "integrations" | "branches" | "team" | "switches";

const SETTINGS_SECTIONS = new Set<SettingsSection>(["integrations", "branches", "team", "switches"]);

export function settingsSectionFromLocation(search: string, hash = ""): SettingsSection {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const querySection = params.get("section") as SettingsSection | null;
  if (querySection && SETTINGS_SECTIONS.has(querySection)) return querySection;

  const legacySection = hash.replace(/^#/, "") as SettingsSection;
  return SETTINGS_SECTIONS.has(legacySection) ? legacySection : "integrations";
}

export function settingsSectionHref(section: SettingsSection): string {
  return section === "integrations" ? "/settings" : `/settings?section=${section}`;
}
