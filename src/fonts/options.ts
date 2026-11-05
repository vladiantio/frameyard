import { FrameyardError } from "../errors.js";
import type { FontFormat, FontStyle, FontWeight } from "./types.js";

export function fontSlug(family: string): string {
  const slug = family
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new FrameyardError("FONT_MANIFEST_INVALID", `Could not derive a font id from "${family}".`);
  }
  return slug;
}

export function parseFontWeight(value: string): FontWeight {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new FrameyardError(
      "USAGE",
      `--weight must be a number or an inclusive range like 100-900; received "${value}".`,
    );
  }
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 1000 || min > max) {
    throw new FrameyardError("USAGE", `--weight must be between 1 and 1000 with min <= max; received "${value}".`);
  }
  return match[2] === undefined ? min : { min, max };
}

export function parseFontStyle(value: string): FontStyle {
  if (value === "normal" || value === "italic") {
    return value;
  }
  throw new FrameyardError("USAGE", `--style must be "normal" or "italic"; received "${value}".`);
}

export function fontFormatForPath(filePath: string): FontFormat {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".woff2":
      return "woff2";
    case ".woff":
      return "woff";
    case ".ttf":
      return "ttf";
    case ".otf":
      return "otf";
    default:
      throw new FrameyardError("USAGE", "Font files must use a .woff2, .woff, .ttf, or .otf extension.");
  }
}

export function formatFontWeight(weight: FontWeight): string {
  return typeof weight === "number" ? String(weight) : `${weight.min}-${weight.max}`;
}

export function fontFileStem(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "font";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

export function safeFontFileName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "font";
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const stem = fontFileStem(name)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (stem.length === 0) {
    throw new FrameyardError("USAGE", `Could not derive a safe destination name from "${filePath}".`);
  }
  return `${stem}${extension}`;
}
