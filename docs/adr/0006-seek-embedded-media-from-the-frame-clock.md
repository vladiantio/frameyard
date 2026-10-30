# Seek embedded media from the frame clock

Embedded video and WebGL are supported without giving compositions a second clock. A composition places local `<video>` elements in `mount()`, describes their timeline position with `data-frameyard-*` attributes, and the runtime pauses and seeks them to the frame-derived source time after every synchronous `update()`. The renderer and `check` await that media settle before capturing or advancing.

The browser remains the source of truth for video presentation, while production audio stays offline and deterministic: an unmuted video's audio track is inspected and mixed by FFmpeg alongside declarative audio clips. Video elements are silenced in the browser. Live streams, remote media, and sources that cannot be seeked are rejected because they cannot be reproduced from a frame number.

WebGL canvases are redrawn from the current frame and captured through the existing screenshot path. Production Chromium pins SwiftShader so WebGL pixels do not vary with the host GPU. The runtime waits two animation frames after a media seek to ensure the decoded video frame and WebGL drawing are composited before capture.

`update()` stays synchronous and seek-safe. Media preparation happens during loading, and only the settle step is asynchronous. This preserves the existing lifecycle contract while extending deterministic frame production to embedded video and WebGL.
