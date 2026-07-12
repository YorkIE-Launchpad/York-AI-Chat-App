export function resolveSessionScrollTop(
  savedScrollTop: number | undefined,
  scrollHeight: number,
  clientHeight: number
): number {
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (savedScrollTop === undefined) return maximumScrollTop;
  return Math.min(Math.max(0, savedScrollTop), maximumScrollTop);
}

export function isScrollNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 80
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
