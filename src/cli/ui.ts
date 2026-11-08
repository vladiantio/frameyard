import picocolors from "picocolors";

/**
 * Human-output styling. Colors are enabled only for a terminal (or when
 * FORCE_COLOR is set), so piped output and `--json` stay byte-clean.
 */
const forcedOn = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0";
const forcedOff = process.env.FORCE_COLOR === "0";
const interactive = process.stdout.isTTY === true || process.stderr.isTTY === true;
const enabled =
  !forcedOff && process.env.NO_COLOR === undefined && (forcedOn || (interactive && process.env.TERM !== "dumb"));

export const colors = picocolors.createColors(enabled);

export function okMark(message: string): string {
  return `${colors.green("✓")} ${message}`;
}

export function failMark(message: string): string {
  return `${colors.red("✗")} ${message}`;
}

export function warnMark(message: string): string {
  return `${colors.yellow("⚠")} ${message}`;
}

export function skipMark(message: string): string {
  return `${colors.dim("○")} ${message}`;
}

export function boldText(message: string): string {
  return colors.bold(message);
}

export function dimText(message: string): string {
  return colors.dim(message);
}

export function pathText(message: string): string {
  return colors.cyan(message);
}

export function errorLabel(code: string): string {
  return colors.red(`error [${code}]`);
}

export function severityText(severity: "error" | "warning", message: string): string {
  return severity === "error" ? colors.red(message) : colors.yellow(message);
}
