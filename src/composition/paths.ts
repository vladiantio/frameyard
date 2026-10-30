const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isRemote(value: string): boolean {
  return SCHEME.test(value) || value.startsWith("//");
}

export function isLocalRelative(value: string): boolean {
  return !SCHEME.test(value) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}

/** Normalizes an authoring path to the project-relative form used in clips. */
export function normalizeLocalPath(value: string): string {
  let normalized = value;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}
