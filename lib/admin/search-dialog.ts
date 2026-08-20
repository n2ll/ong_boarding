export function nextSearchDialogFocusIndex(
  currentIndex: number,
  focusableCount: number,
  direction: "forward" | "backward",
): number {
  if (focusableCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= focusableCount) {
    return direction === "forward" ? 0 : focusableCount - 1;
  }
  const offset = direction === "forward" ? 1 : -1;
  return (currentIndex + offset + focusableCount) % focusableCount;
}
