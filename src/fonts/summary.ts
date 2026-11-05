import { uniqueFontValues } from "./manifest.js";
import type { FontFamily } from "./types.js";

export interface FontSummary {
  id: string;
  family: string;
  provider: string;
  version?: string;
  variable: boolean;
  subsets: string[];
  styles: string[];
  license: string;
  files: number;
  bytes: number;
  status: "ok" | "missing" | "invalid";
}

export function summarizeFont(font: FontFamily, status: FontSummary["status"] = "ok"): FontSummary {
  const values = uniqueFontValues(font);
  let bytes = 0;
  for (const file of font.files) {
    bytes += file.bytes;
  }
  return {
    id: font.id,
    family: font.family,
    provider: font.provider,
    ...(font.providerVersion !== undefined ? { version: font.providerVersion } : {}),
    variable: font.variable === true,
    subsets: values.subsets,
    styles: values.styles,
    license: font.license.type,
    files: font.files.length,
    bytes,
    status,
  };
}
