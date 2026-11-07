export const ANIMATION_PRESETS = [
  "fade",
  "fade-up",
  "fade-down",
  "slide-left",
  "slide-right",
  "scale-in",
  "blur-in",
] as const;

export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

/** Default duration when data-fy-anim-duration is omitted. */
export const DEFAULT_ANIMATION_PRESET_DURATION_FRAMES = 30;

export type AnimationPresetKeyframe = {
  opacity?: number;
  transform?: string;
  filter?: string;
};

export const ANIMATION_PRESET_KEYFRAMES: Record<AnimationPreset, readonly AnimationPresetKeyframe[]> = {
  fade: [{ opacity: 0 }, { opacity: 1 }],
  "fade-up": [
    { opacity: 0, transform: "translateY(24px)" },
    { opacity: 1, transform: "translateY(0px)" },
  ],
  "fade-down": [
    { opacity: 0, transform: "translateY(-24px)" },
    { opacity: 1, transform: "translateY(0px)" },
  ],
  "slide-left": [
    { opacity: 0, transform: "translateX(48px)" },
    { opacity: 1, transform: "translateX(0px)" },
  ],
  "slide-right": [
    { opacity: 0, transform: "translateX(-48px)" },
    { opacity: 1, transform: "translateX(0px)" },
  ],
  "scale-in": [
    { opacity: 0, transform: "scale(0.92)" },
    { opacity: 1, transform: "scale(1)" },
  ],
  "blur-in": [
    { opacity: 0, filter: "blur(12px)" },
    { opacity: 1, filter: "blur(0px)" },
  ],
};

export function isAnimationPreset(value: string): value is AnimationPreset {
  return (ANIMATION_PRESETS as readonly string[]).includes(value);
}
