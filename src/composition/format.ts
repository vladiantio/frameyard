import type { CompositionFormat, DeclaredCompositionMetadata, ResolvedCompositionMetadata } from "../contracts.js";

export const COMPOSITION_FORMAT_UNRESOLVED_MESSAGE =
  "The composition does not declare width and height, and no project format is available. Declare them on <fy-composition> or add format { width, height, fps } to fy.config.js.";

/**
 * Resolves declared composition metadata against a project format. Declared
 * values always win; the project format only fills what the fragment omits.
 * A composition that declares neither `duration-in-frames` nor `fps` is
 * static: it keeps width/height but has no frame clock or duration.
 * Returns null when a required value is neither declared nor available from
 * the project, which makes the composition unrenderable in that context.
 */
export function resolveCompositionMetadata(
  declared: DeclaredCompositionMetadata,
  format: CompositionFormat | null | undefined,
): ResolvedCompositionMetadata | null {
  const width = declared.format.width ?? format?.width ?? null;
  const height = declared.format.height ?? format?.height ?? null;

  if (width === null || height === null) {
    return null;
  }

  if (declared.durationInFrames === null) {
    if (declared.format.fps !== null) {
      return null;
    }
    return { width, height, static: true };
  }

  const fps = declared.format.fps ?? format?.fps ?? null;
  if (fps === null) {
    return null;
  }

  return { width, height, fps, durationInFrames: declared.durationInFrames };
}
