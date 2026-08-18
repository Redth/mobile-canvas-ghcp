export const WINDOWS_APP_HELPER = "windows-app-helper.exe";

const WINDOWS_RIDS = new Set(["win-x64", "win-arm64"]);
const WINDOWS_PLATFORM_KEYS = new Set(["win32-x64", "win32-arm64"]);

export function windowsAppHelperFilesForRid(rid) {
  return WINDOWS_RIDS.has(rid) ? [WINDOWS_APP_HELPER] : [];
}

export function validateWindowsAppHelperEntry(platformKey, entry) {
  const files = entry?.files ?? {};
  const helperIsPresent = Object.hasOwn(files, WINDOWS_APP_HELPER);
  const helpers = entry?.helpers;

  if (!WINDOWS_PLATFORM_KEYS.has(platformKey)) {
    if (helperIsPresent || helpers !== undefined) {
      throw new Error(
        `${platformKey} declares ${WINDOWS_APP_HELPER}, which is only valid for Windows runtimes`,
      );
    }
    return [];
  }

  // Releases produced before the helper existed remain usable for Mobile Canvas.
  // New Windows entries must explicitly declare it so runtime preflight cannot
  // silently accept an incomplete extraction.
  if (helpers === undefined) {
    if (helperIsPresent) {
      throw new Error(
        `${platformKey} includes ${WINDOWS_APP_HELPER} without declaring it in helpers`,
      );
    }
    return [];
  }

  if (!Array.isArray(helpers)) {
    throw new Error(`${platformKey} helpers must be an array`);
  }

  if (!WINDOWS_RIDS.has(entry?.rid)) {
    throw new Error(`${platformKey} has an unsupported Windows runtime identifier: ${entry?.rid}`);
  }

  const expected = windowsAppHelperFilesForRid(entry?.rid);
  if (
    helpers.length !== expected.length
    || helpers.some((helper, index) => helper !== expected[index])
  ) {
    throw new Error(
      `${platformKey} helpers must contain exactly ${expected.join(", ") || "no files"}`,
    );
  }

  for (const helper of helpers) {
    if (!Object.hasOwn(files, helper)) {
      throw new Error(`${platformKey} declares helper ${helper} without a checksummed file`);
    }
  }

  return helpers;
}
