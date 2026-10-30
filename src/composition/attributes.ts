export const BINDING_ATTRIBUTES = ["data-fy-text", "data-fy-if", "data-fy-repeat"] as const;

export const ANIMATION_ATTRIBUTES = ["data-fy-anim-start", "data-fy-anim-duration", "data-fy-anim-easing"] as const;

export const MEDIA_ATTRIBUTES = [
  "data-fy-start",
  "data-fy-trim",
  "data-fy-duration",
  "data-fy-volume",
  "data-fy-audio",
] as const;

export const KNOWN_DATA_FY_ATTRIBUTES = [
  "data-fy",
  ...BINDING_ATTRIBUTES,
  ...ANIMATION_ATTRIBUTES,
  ...MEDIA_ATTRIBUTES,
] as const;

const ANIMATION_SET = new Set<string>(ANIMATION_ATTRIBUTES);
const MEDIA_SET = new Set<string>(MEDIA_ATTRIBUTES);

export function isAnimationAttribute(name: string): boolean {
  return ANIMATION_SET.has(name);
}

export function isMediaAttribute(name: string): boolean {
  return MEDIA_SET.has(name);
}
