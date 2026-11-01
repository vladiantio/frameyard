/**
 * A frame-index probe for timeline compositing.
 *
 * The barcode composition encodes the host-provided frame number in nine
 * vertical bars, so a rendered frame can be decoded back to the exact frame the
 * timeline compositor selected. The geometry matches a 320x180 stage with the
 * bars at x=25..294 and y=20..99.
 */
export const BARCODE = {
  width: 320,
  height: 180,
  fps: 30,
  frames: 60,
  bits: 9,
  barWidth: 30,
  barLeft: 25,
  barTop: 20,
  barHeight: 80,
  cropWidth: 270,
  cropHeight: 80,
  sampleY: 40,
  threshold: 128,
} as const;

export function barcodeCompositionHtml(frames: number = BARCODE.frames): string {
  const bars = Array.from(
    { length: BARCODE.bits },
    (_, index) => `<div class="bar" style="left: ${BARCODE.barLeft + index * BARCODE.barWidth}px"></div>`,
  ).join("\n      ");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #808080; }
      .bar { position: absolute; top: ${BARCODE.barTop}px; width: ${BARCODE.barWidth}px; height: ${BARCODE.barHeight}px; background: #000; }
    </style>
  </head>
  <body>
    <fy-composition width="${BARCODE.width}" height="${BARCODE.height}" fps="${BARCODE.fps}" duration-in-frames="${frames}">
      ${bars}
    </fy-composition>
    <script type="text/fy-controller">
let bars = [];
export default {
  mount({ root }) {
    bars = [...root.querySelectorAll(".bar")];
  },
  update({ frame }) {
    bars.forEach((bar, index) => {
      bar.style.background = ((frame >> index) & 1) === 1 ? "#ffffff" : "#000000";
    });
  },
};
    </script>
  </body>
</html>
`;
}

/** FFmpeg filter that crops the barcode region out of a rendered frame. */
export function barcodeCropFilter(): string {
  return `format=gray,crop=${BARCODE.cropWidth}:${BARCODE.cropHeight}:${BARCODE.barLeft}:${BARCODE.barTop}`;
}

export interface BarcodeMismatch {
  frame: number;
  expected: number;
  actual: number;
}

/**
 * Decodes the barcode values from a raw gray buffer and compares them with the
 * expected frame number. The buffer must contain exactly `frames` cropped
 * frames; a short or long buffer is a fixture error, not a render mismatch.
 */
export function decodeBarcodeFrames(
  buffer: Buffer,
  frames: number = BARCODE.frames,
  expected: (frame: number) => number = (frame) => frame,
): { values: number[]; mismatches: BarcodeMismatch[] } {
  const frameBytes = BARCODE.cropWidth * BARCODE.cropHeight;
  if (buffer.length !== frames * frameBytes) {
    throw new Error(
      `Expected ${frames} barcode frames (${frames * frameBytes} bytes), received ${buffer.length} bytes.`,
    );
  }

  const values: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (let bit = 0; bit < BARCODE.bits; bit += 1) {
      const x = bit * BARCODE.barWidth + BARCODE.barWidth / 2;
      const y = BARCODE.sampleY;
      const sample = buffer[frame * frameBytes + y * BARCODE.cropWidth + x] ?? 0;
      if (sample > BARCODE.threshold) {
        value |= 1 << bit;
      }
    }
    values.push(value);
  }

  const mismatches = values.flatMap((actual, frame) => {
    const expectedValue = expected(frame);
    return actual === expectedValue ? [] : [{ frame, expected: expectedValue, actual }];
  });

  return { values, mismatches };
}
