/** True when Cmd/Ctrl+Shift+Space should open Ask Growth OS. */
export function isAskGrowthOSHotkey(event: KeyboardEvent): boolean {
  if (event.key !== ' ' && event.code !== 'Space') {
    return false;
  }
  if (!event.shiftKey) {
    return false;
  }
  if (event.repeat) {
    return false;
  }
  return event.metaKey || event.ctrlKey;
}
