import {
  cubicBezierProgress,
  cubicBezierSlope,
  easeProgress,
  easingFor,
  type CubicBezierEasing,
  type Easing,
} from "../timeline/easing.js";
import type { TimelineKeyframe } from "../timeline/schema.js";

export interface KeyframeExpressionOptions {
  /** FFmpeg frame variable: `n` for overlay/scale/rotate, `N` for geq. */
  frameVariable: "n" | "N";
  /** Absolute timeline frame corresponding to output frame 0. */
  frameOffset: number;
  /** Timeline frame where the clip starts. */
  clipStart: number;
}

interface HermiteSegment {
  start: number;
  end: number;
  c0: number;
  c1: number;
  c2: number;
  c3: number;
}

const SEGMENT_CACHE = new Map<string, HermiteSegment[]>();
const APPROXIMATION_TOLERANCE = 5e-5;
const MAX_DEPTH = 12;

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot serialize non-finite keyframe value ${String(value)}.`);
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function evaluateSegment(segment: HermiteSegment, progress: number): number {
  const t = (Math.max(segment.start, Math.min(segment.end, progress)) - segment.start) / (segment.end - segment.start);
  return ((segment.c3 * t + segment.c2) * t + segment.c1) * t + segment.c0;
}

function evaluateSegments(segments: readonly HermiteSegment[], progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const segment =
    segments.find((candidate) => p >= candidate.start && p < candidate.end) ?? (segments.at(-1) as HermiteSegment);
  return evaluateSegment(segment, p);
}

function makeSegment(
  easing: CubicBezierEasing,
  start: number,
  end: number,
  startValue: number,
  startSlope: number,
  endValue: number,
  endSlope: number,
): HermiteSegment {
  const h = end - start;
  const c3 = 2 * startValue + startSlope * h - 2 * endValue + endSlope * h;
  const c2 = -3 * startValue - 2 * startSlope * h + 3 * endValue - endSlope * h;
  const c1 = startSlope * h;
  return { start, end, c0: startValue, c1, c2, c3 };
}

function segmentError(easing: CubicBezierEasing, segment: HermiteSegment): number {
  let maximum = 0;
  for (const fraction of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
    const x = segment.start + (segment.end - segment.start) * fraction;
    maximum = Math.max(maximum, Math.abs(evaluateSegment(segment, x) - cubicBezierProgress(easing, x)));
  }
  return maximum;
}

function cubicSegments(easing: CubicBezierEasing): HermiteSegment[] {
  const key = `${easing.x1},${easing.y1},${easing.x2},${easing.y2}`;
  const cached = SEGMENT_CACHE.get(key);
  if (cached) {
    return cached;
  }

  const segments: HermiteSegment[] = [];
  const refine = (
    start: number,
    startValue: number,
    startSlope: number,
    end: number,
    endValue: number,
    endSlope: number,
    depth: number,
  ): void => {
    const segment = makeSegment(easing, start, end, startValue, startSlope, endValue, endSlope);
    if (segmentError(easing, segment) <= APPROXIMATION_TOLERANCE || depth >= MAX_DEPTH) {
      segments.push(segment);
      return;
    }
    const middle = (start + end) / 2;
    const middleValue = cubicBezierProgress(easing, middle);
    const middleSlope = cubicBezierSlope(easing, middle);
    refine(start, startValue, startSlope, middle, middleValue, middleSlope, depth + 1);
    refine(middle, middleValue, middleSlope, end, endValue, endSlope, depth + 1);
  };

  refine(0, 0, cubicBezierSlope(easing, 0), 1, 1, cubicBezierSlope(easing, 1), 0);
  segments.sort((left, right) => left.start - right.start);
  SEGMENT_CACHE.set(key, segments);
  return segments;
}

/** Evaluates the same adaptive Hermite approximation the FFmpeg expressions use. */
export function approximateEasing(easing: Easing, progress: number): number {
  if (easing.kind !== "cubic-bezier") {
    return easeProgress(easing, progress);
  }
  return evaluateSegments(cubicSegments(easing), progress);
}

function easingExpression(easing: Easing, progressExpression: string): string {
  if (easing.kind === "linear") {
    return progressExpression;
  }
  if (easing.kind === "steps") {
    const n = easing.steps;
    switch (easing.position) {
      case "jump-start":
        return `floor(${progressExpression}*${n}+1)/${n}`;
      case "jump-end":
        return `floor(${progressExpression}*${n})/${n}`;
      case "jump-none":
        return `floor(${progressExpression}*${n})/${n - 1}`;
      case "jump-both":
        return `(floor(${progressExpression}*${n})+1)/${n + 1}`;
    }
  }

  const segments = cubicSegments(easing);
  const renderSegment = (segment: HermiteSegment): string => {
    const h = segment.end - segment.start;
    const t = `((${progressExpression}-${formatNumber(segment.start)})/${formatNumber(h)})`;
    const c0 = formatNumber(segment.c0);
    const c1 = formatNumber(segment.c1);
    const c2 = formatNumber(segment.c2);
    const c3 = formatNumber(segment.c3);
    return `(((${c3})*${t}+(${c2}))*${t}+(${c1}))*${t}+(${c0})`;
  };
  let expression = renderSegment(segments[segments.length - 1] as HermiteSegment);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index] as HermiteSegment;
    expression = `if(lt(${progressExpression},${formatNumber(segment.end)}),${renderSegment(segment)},${expression})`;
  }
  return expression;
}

function frameExpression(options: KeyframeExpressionOptions): string {
  const delta = options.frameOffset - options.clipStart;
  const variable = options.frameVariable;
  if (delta === 0) {
    return `(${variable})`;
  }
  return delta > 0 ? `(${variable}+${delta})` : `(${variable}-${Math.abs(delta)})`;
}

/** Builds an FFmpeg expression for one keyframe channel at absolute timeline frames. */
export function keyframeValueExpression(keys: readonly TimelineKeyframe[], options: KeyframeExpressionOptions): string {
  if (keys.length < 2) {
    throw new Error("Keyframe expressions require at least two keys.");
  }
  const frame = frameExpression(options);
  const last = keys[keys.length - 1] as TimelineKeyframe;
  let expression = formatNumber(last.value);
  for (let index = keys.length - 2; index >= 0; index -= 1) {
    const from = keys[index] as TimelineKeyframe;
    const to = keys[index + 1] as TimelineKeyframe;
    let interval: string;
    if (from.value === to.value) {
      interval = formatNumber(from.value);
    } else {
      const progress = `((${frame}-${from.frame})/${to.frame - from.frame})`;
      const eased = easingExpression(easingFor(from.easing), progress);
      const difference = to.value - from.value;
      interval = `(${formatNumber(from.value)}+${formatNumber(difference)}*(${eased}))`;
    }
    expression = `if(lt(${frame},${to.frame}),${interval},${expression})`;
  }
  const first = keys[0] as TimelineKeyframe;
  return `if(lt(${frame},${first.frame}),${formatNumber(first.value)},${expression})`;
}

/** Builds a clamped expression for opacity, or a scale expression with a visibility gate. */
export function keyframeChannelExpression(
  channel: "x" | "y" | "scale" | "rotation" | "opacity",
  keys: readonly TimelineKeyframe[],
  options: KeyframeExpressionOptions,
): string {
  const value = keyframeValueExpression(keys, options);
  if (channel === "opacity") {
    return `min(1,max(0,${value}))`;
  }
  if (channel === "scale") {
    return `max(0,${value})`;
  }
  return value;
}

export { formatNumber as formatKeyframeNumber };
