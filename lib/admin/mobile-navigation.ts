const GRID_CLASSES = [
  "",
  "grid-cols-1",
  "grid-cols-2",
  "grid-cols-3",
  "grid-cols-4",
  "grid-cols-5",
] as const;

export function mobileNavigationGridClass(itemCount: number): string {
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 5) {
    throw new Error("Mobile primary navigation supports one to five destinations.");
  }
  return GRID_CLASSES[itemCount];
}
