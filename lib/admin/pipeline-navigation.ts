export interface PipelineApplicantNavigation {
  current: number | null;
  total: number;
  previousId: number | null;
  nextId: number | null;
  outsideFilter: boolean;
}

export function getPipelineApplicantNavigation(
  filteredIds: number[],
  selectedId: number | null,
): PipelineApplicantNavigation {
  const index = selectedId == null ? -1 : filteredIds.indexOf(selectedId);
  return {
    current: index < 0 ? null : index + 1,
    total: filteredIds.length,
    previousId: index > 0 ? filteredIds[index - 1] : null,
    nextId: index >= 0 && index < filteredIds.length - 1 ? filteredIds[index + 1] : null,
    outsideFilter: selectedId != null && index < 0,
  };
}

export function recoverPipelineApplicantSelection(
  previousIds: number[],
  currentIds: number[],
  selectedId: number | null,
  refreshState: "success" | "error" | "stale",
): number | null {
  if (refreshState !== "success" || selectedId == null) return selectedId;
  const selectedIndex = previousIds.indexOf(selectedId);
  if (selectedIndex < 0 || currentIds.includes(selectedId)) return selectedId;

  const currentSet = new Set(currentIds);
  for (let index = selectedIndex + 1; index < previousIds.length; index += 1) {
    if (currentSet.has(previousIds[index])) return previousIds[index];
  }
  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    if (currentSet.has(previousIds[index])) return previousIds[index];
  }
  return null;
}
