# Seek embedded media from the frame clock

**Status:** Accepted; placement detail amended by [ADR-0007](./0007-make-html-documents-the-composition-unit.md). Embedded media is now declared in the composition HTML; the frame-clock seek rule is unchanged.

Embedded video and WebGL are supported without giving compositions a second clock. A composition declares local `<video>` elements in its HTML with `data-fy-*` attributes, and the runtime pauses and seeks them to the frame-derived source time after every synchronous `update()`. The renderer and `check` await that media settle before capturing or advancing.

The browser remains the source of truth for video presentation, while production audio stays offline and deterministic: an unmuted video's audio track is inspected and mixed by FFmpeg alongside declarative audio clips. Video elements are silenced in the browser. Live streams, remote media, and sources that cannot be seeked are rejected because they cannot be reproduced from a frame number.

WebGL canvases are redrawn from the current frame and captured through the existing screenshot path. Production Chromium pins SwiftShader so WebGL pixels do not vary with the host GPU. The runtime waits two animation frames after a media seek to ensure the decoded video frame and WebGL drawing are composited before capture.

Capture sessions also keep the composition hidden until the first seek. Chromium can otherwise reuse the video frame painted during load when an ancestor animates opacity, so a still at a later frame shows the load frame even though the seek succeeded. The first visible paint is therefore the requested frame. Interactive preview does not take this capture-only precaution; a full-scene opacity animation above a video can leave the load frame on screen after a large seek. Fade overlay layers instead, and keep videos outside full-scene opacity animations.

WebM frame timestamps are rounded to milliseconds, while composition times are exact frame fractions. Chromium selects the frame at or before `currentTime`, so a 30fps source at 0.067s combined with a composition time of 0.066666s would show the previous source frame. The runtime seeks one millisecond past the frame-derived time so every composition frame selects its intended source frame. `test/video-determinism.test.ts` covers both this mapping and the animated-ancestor capture path.

`update()` stays synchronous and seek-safe. Media preparation happens during loading, and only the settle step is asynchronous. This preserves the existing lifecycle contract while extending deterministic frame production to embedded video and WebGL.
