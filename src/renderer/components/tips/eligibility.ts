export const alwaysEligible = async () => true;

/** Screen Snap runs on macOS only; `supported` is false elsewhere. */
export async function isSnapSupported(): Promise<boolean> {
  const snapApi = window.electronAPI?.snap;
  if (!snapApi) return false;
  return (await snapApi.getShortcut()).supported;
}
