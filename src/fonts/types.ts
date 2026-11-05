/** Project-local font manifest shared by the CLI, server, and context digest. */
export const FONT_MANIFEST_FILENAME = "frameyard.fonts.json";
export const FONT_MANIFEST_VERSION = 1 as const;
export const FONT_ASSET_PREFIX = "assets/fonts/";

export type FontProvider = "local" | "fontsource" | "url";
export type FontStyle = "normal" | "italic";
export type FontFormat = "woff2" | "woff" | "ttf" | "otf";

export interface FontWeightRange {
  min: number;
  max: number;
}

export type FontWeight = number | FontWeightRange;

export interface FontLicense {
  /** SPDX identifier, a license name, or "unknown". */
  type: string;
  /** Project-relative license file when the source provides one. */
  file?: string;
  attribution?: string;
}

export interface FontAxis {
  min: number;
  max: number;
  default: number;
}

export interface FontFile {
  /** Project-relative path below assets/fonts/<font-id>/. */
  path: string;
  subset?: string;
  style: FontStyle;
  weight: FontWeight;
  format: FontFormat;
  /** CSS unicode-range for this face, when the provider exposes one. */
  unicodeRange?: string;
  sha256: string;
  bytes: number;
  /** Upstream URL or identifier recorded for provenance. */
  source?: string;
}

export interface FontFamily {
  id: string;
  /** CSS font-family name. */
  family: string;
  provider: FontProvider;
  providerId?: string;
  providerVersion?: string;
  license: FontLicense;
  variable?: boolean;
  axes?: Record<string, FontAxis>;
  files: FontFile[];
}

export interface FontManifest {
  version: typeof FONT_MANIFEST_VERSION;
  fonts: FontFamily[];
}

export function emptyFontManifest(): FontManifest {
  return { version: FONT_MANIFEST_VERSION, fonts: [] };
}
