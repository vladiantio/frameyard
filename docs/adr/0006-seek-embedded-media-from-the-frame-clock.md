# Seek embedded media from the frame clock

**Status:** Accepted; placement detail amended by [ADR-0007](./0007-make-html-documents-the-composition-unit.md). Embedded media is now declared in the composition HTML; the frame-clock seek rule is unchanged.

Embedded video and WebGL are supported without giving compositions a second clock. A composition declares local `<video>` elements in its HTML with `data-fy-*` attributes, and the runtime pauses and seeks them to the frame-derived source time after every synchronous `update()`. The renderer and `check` await that media settle before capturing or advancing.

The browser remains the source of truth for video presentation, while production audio stays offline and deterministic: an unmuted video's audio track is inspected and mixed by FFmpeg alongside declarative audio clips. Video elements are silenced in the browser. Live streams, remote media, and sources that cannot be seeked are rejected because they cannot be reproduced from a frame number.

WebGL canvases are redrawn from the current frame and captured through the existing screenshot path. Production Chromium pins SwiftShader so WebGL pixels do not vary with the host GPU. The runtime waits two animation frames after a media seek to ensure the decoded video frame and WebGL drawing are composited before capture.

`update()` stays synchronous and seek-safe. Media preparation happens during loading, and only the settle step is asynchronous. This preserves the existing lifecycle contract while extending deterministic frame production to embedded video and WebGL.
