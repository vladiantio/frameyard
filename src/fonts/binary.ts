import type { FontFormat } from "./types.js";

export const FONT_MAGIC: Record<FontFormat, readonly string[]> = {
  woff2: ["wOF2"],
  woff: ["wOFF"],
  ttf: ["\u0000\u0001\u0000\u0000", "true"],
  otf: ["OTTO"],
};

export function hasFontMagic(format: FontFormat, bytes: Uint8Array): boolean {
  const accepted = FONT_MAGIC[format];
  return accepted.some((value) => {
    if (bytes.length < value.length) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (bytes[index] !== value.charCodeAt(index)) {
        return false;
      }
    }
    return true;
  });
}
