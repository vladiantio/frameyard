/**
 * Browser-safe CSS timing-function parsing and evaluation for timeline
 * keyframes. This is the single source of truth shared by the preview, the
 * static checker, and the FFmpeg expression builder.
 */

export interface CubicBezierEasing {
  kind: "cubic-bezier";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type StepPosition = "jump-start" | "jump-end" | "jump-none" | "jump-both";

export interface StepsEasing {
  kind: "steps";
  steps: number;
  position: StepPosition;
}

export interface LinearEasing {
  kind: "linear";
}

export type Easing = LinearEasing | CubicBezierEasing | StepsEasing;

export const LINEAR_EASING: LinearEasing = { kind: "linear" };

/** Human-readable grammar used in diagnostics and documentation. */
export const EASING_GRAMMAR =
  "linear, ease, ease-in, ease-out, ease-in-out, step-start, step-end, hold, cubic-bezier(x1, y1, x2, y2), or steps(n, jump-start|jump-end|jump-none|jump-both)";

const NAMED_EASINGS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function parseSteps(value: string): StepsEasing | null {
  const match = /^steps\(([^)]*)\)$/i.exec(value);
  if (!match) {
    return null;
  }
  const parts = (match[1] as string).split(",").map((part) => part.trim());
  if (parts.length < 1 || parts.length > 2) {
    return null;
  }
  const count = parseNumber(parts[0] as string);
  if (count === null || !Number.isInteger(count) || count <= 0) {
    return null;
  }
  const positionValue = (parts[1] ?? "jump-end").toLowerCase();
  const position =
    positionValue === "start"
      ? "jump-start"
      : positionValue === "end"
        ? "jump-end"
        : positionValue === "jump-start" ||
            positionValue === "jump-end" ||
            positionValue === "jump-none" ||
            positionValue === "jump-both"
          ? positionValue
          : null;
  if (position === null) {
    return null;
  }
  if (position === "jump-none" && count < 2) {
    return null;
  }
  return { kind: "steps", steps: count, position };
}

function parseCubicBezier(value: string): CubicBezierEasing | null {
  const match = /^cubic-bezier\(([^)]*)\)$/i.exec(value);
  if (!match) {
    return null;
  }
  const parts = (match[1] as string).split(",").map((part) => part.trim());
  if (parts.length !== 4) {
    return null;
  }
  const numbers = parts.map(parseNumber);
  if (numbers.some((number) => number === null)) {
    return null;
  }
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    return null;
  }
  return { kind: "cubic-bezier", x1, y1, x2, y2 };
}

/** Parses a CSS timing function from the supported keyframe vocabulary. */
export function parseEasing(value: string): Easing | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "linear") {
    return LINEAR_EASING;
  }
  if (lower === "hold" || lower === "step-end") {
    return { kind: "steps", steps: 1, position: "jump-end" };
  }
  if (lower === "step-start") {
    return { kind: "steps", steps: 1, position: "jump-start" };
  }
  const named = NAMED_EASINGS[lower];
  if (named) {
    return { kind: "cubic-bezier", x1: named[0], y1: named[1], x2: named[2], y2: named[3] };
  }
  if (lower.startsWith("cubic-bezier(")) {
    return parseCubicBezier(trimmed);
  }
  if (lower.startsWith("steps(")) {
    return parseSteps(trimmed);
  }
  return null;
}

function cubicCoordinate(u: number, first: number, second: number): number {
  const inverse = 1 - u;
  return 3 * inverse * inverse * u * first + 3 * inverse * u * u * second + u * u * u;
}

function cubicDerivative(u: number, first: number, second: number): number {
  const inverse = 1 - u;
  return 3 * inverse * inverse * first + 6 * inverse * u * (second - first) + 3 * u * u * (1 - second);
}

/** Solves x(u) = progress for a CSS cubic-bezier and returns y(u). */
export function cubicBezierProgress(easing: CubicBezierEasing, progress: number): number {
  const target = Math.max(0, Math.min(1, progress));
  if (target === 0 || target === 1) {
    return target;
  }

  let u = target;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const x = cubicCoordinate(u, easing.x1, easing.x2);
    const difference = x - target;
    if (Math.abs(difference) < 1e-9) {
      return cubicCoordinate(u, easing.y1, easing.y2);
    }
    const derivative = cubicDerivative(u, easing.x1, easing.x2);
    if (Math.abs(derivative) < 1e-9) {
      break;
    }
    const next = u - difference / derivative;
    if (!Number.isFinite(next) || next < 0 || next > 1) {
      break;
    }
    u = next;
  }

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    u = (low + high) / 2;
    const x = cubicCoordinate(u, easing.x1, easing.x2);
    if (x < target) {
      low = u;
    } else {
      high = u;
    }
  }
  return cubicCoordinate((low + high) / 2, easing.y1, easing.y2);
}

/** dy/dx of a CSS cubic-bezier at x = progress, used by the Hermite approximation. */
export function cubicBezierSlope(easing: CubicBezierEasing, progress: number): number {
  const target = Math.max(0, Math.min(1, progress));
  let u = target;
  if (target > 0 && target < 1) {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const x = cubicCoordinate(u, easing.x1, easing.x2);
      const derivative = cubicDerivative(u, easing.x1, easing.x2);
      if (Math.abs(derivative) < 1e-9) {
        break;
      }
      const next = u - (x - target) / derivative;
      if (!Number.isFinite(next) || next < 0 || next > 1) {
        break;
      }
      u = next;
    }
  }
  const dx = cubicDerivative(u, easing.x1, easing.x2);
  const dy = cubicDerivative(u, easing.y1, easing.y2);
  if (Math.abs(dx) > 1e-7) {
    return dy / dx;
  }
  // Endpoint limits for curves with a vertical or degenerate tangent. Sample a
  // tiny step on either side and use the secant slope.
  const delta = 1e-5;
  const low = Math.max(0, target - delta);
  const high = Math.min(1, target + delta);
  const lowY = cubicBezierProgress(easing, low);
  const highY = cubicBezierProgress(easing, high);
  return high === low ? 0 : (highY - lowY) / (high - low);
}

function stepsProgress(easing: StepsEasing, progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  if (p >= 1) {
    return 1;
  }
  const n = easing.steps;
  switch (easing.position) {
    case "jump-start":
      return Math.floor(p * n + 1) / n;
    case "jump-end":
      return Math.floor(p * n) / n;
    case "jump-none":
      return Math.floor(p * n) / (n - 1);
    case "jump-both":
      return (Math.floor(p * n) + 1) / (n + 1);
  }
}

/** Evaluates a parsed easing at a normalized progress in `0..1`. */
export function easeProgress(easing: Easing, progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  switch (easing.kind) {
    case "linear":
      return p;
    case "steps":
      return stepsProgress(easing, p);
    case "cubic-bezier":
      return cubicBezierProgress(easing, p);
  }
}

const easingCache = new Map<string, Easing | null>();

/** Caches parsing by the raw string; timelines often repeat the same easing. */
export function easingFor(value: string | undefined): Easing {
  if (value === undefined) {
    return LINEAR_EASING;
  }
  const cached = easingCache.get(value);
  if (cached !== undefined) {
    return cached ?? LINEAR_EASING;
  }
  const parsed = parseEasing(value);
  easingCache.set(value, parsed);
  return parsed ?? LINEAR_EASING;
}
