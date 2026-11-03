import type { CompositionFormat, CompositionMetadata, DeclaredCompositionMetadata } from "../contracts.js";

export const COMPOSITION_FORMAT_UNRESOLVED_MESSAGE =
  "The composition does not declare width, height, and fps, and no project format is available. Declare them on <fy-composition> or add format { width, height, fps } to video.config.js.";

/**
 * Resolves declared composition metadata against a project format. Declared
 * values always win; the project format only fills what the document omits.
 * Returns null when a value is neither declared nor available from the
 * project, which makes the composition unrenderable in that context.
 */
export function resolveCompositionMetadata(
  declared: DeclaredCompositionMetadata,
  format: CompositionFormat | null | undefined,
): CompositionMetadata | null {
  const width = declared.format.width ?? format?.width ?? null;
  const height = declared.format.height ?? format?.height ?? null;
  const fps = declared.format.fps ?? format?.fps ?? null;

  if (width === null || height === null || fps === null) {
    return null;
  }

  return { width, height, fps, durationInFrames: declared.durationInFrames };
}
