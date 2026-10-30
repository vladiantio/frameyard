const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isRemote(value: string): boolean {
  return SCHEME.test(value) || value.startsWith("//");
}

export function isLocalRelative(value: string): boolean {
  return !SCHEME.test(value) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");
}
