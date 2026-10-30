# Frameyard

Frameyard is a local-first framework for creating short, parameterized videos with HTML, CSS, and JavaScript. Its domain separates reusable compositions from the fixed inputs and deterministic renders that turn them into videos.

## Language

### Authoring

**Project**:
A collection of related compositions and the assets and configuration they share.
_Avoid_: Video, render

**Composition**:
A uniquely identified, reusable video definition with fixed dimensions, frame rate, duration in frames, and content parameterized by props.
_Avoid_: Scene, template, video

**Composition metadata**:
The fixed dimensions, frame rate, and duration in frames that define a composition's output contract.
_Avoid_: Render options, props

**Composition lifecycle**:
The host-driven sequence that loads an HTML composition, seeks it to frames, and releases it.
_Avoid_: Render loop, playback lifecycle

**Controller lifecycle**:
The `mount → update → dispose` sequence a composition controller uses for per-frame computation.
_Avoid_: Composition lifecycle

**Composition revision**:
A specific version of a composition's source and metadata.
_Avoid_: Build, release

**HTML composition**:
A composition whose source is an HTML document.
_Avoid_: HTML template, page

**Composition controller**:
An optional JavaScript controller, either inline in the composition document or in an external module, that performs per-frame computation an HTML composition's declarative HTML and CSS cannot express.
_Avoid_: Composition module, plugin

**Inline controller**:
A composition controller whose source is embedded in the composition document.
_Avoid_: Embedded script

**External controller**:
A composition controller whose source is a separate JavaScript module referenced by the composition document.
_Avoid_: Controller file

**Declarative binding**:
An HTML attribute that maps a prop into text, an attribute, a class, or element presence.
_Avoid_: Template expression, interpolation

**Props**:
The immutable, JSON-serializable inputs supplied to a composition for one render.
_Avoid_: Options, settings, mutable state

**Asset**:
A local file required by a composition, whether static or generated.
_Avoid_: Resource, media file

### Deterministic execution

**Frame**:
An integer-addressed position on a composition's timeline.
_Avoid_: Timestamp, animation tick

**Deterministic execution**:
The rule that a composition's visual state at any frame depends only on that frame, its props, and pre-loaded data and assets.
_Avoid_: Playback-driven animation

**Frame clock**:
The single source of animation time, derived from the current frame and the composition's frame rate.
_Avoid_: Wall clock, playback timer

**Frame-state variable**:
A CSS custom property whose value is derived from the current composition frame.
_Avoid_: Animation variable, clock variable

**Seek safety**:
The property that any frame can be produced correctly without depending on previously produced frames.
_Avoid_: History-dependent updates

**Deterministic randomness**:
Random values derived statelessly from a key so they do not depend on call order or rendering history.
_Avoid_: Unseeded randomness

**Frame production**:
The phase in which the runtime produces the visual state of a requested frame, without network access or model inference.
_Avoid_: Real-time playback

**Loading phase**:
The phase before frame production when required data and assets become available.
_Avoid_: Per-frame fetching

**Embedded media**:
A local video file placed in a composition whose presentation time is derived from the composition frame, with optional frame offset and source trim.
_Avoid_: Live stream, video track

**Media settle**:
The asynchronous step after a seek that waits for embedded video decode and browser paint before a frame is captured or checked.
_Avoid_: Playback, buffering

**WebGL canvas**:
A canvas redrawn from the current frame through WebGL, captured by the same screenshot path as DOM and Canvas 2D content.
_Avoid_: GPU animation, live render

### Audio

**Audio clip**:
An audio source placed on a composition's timeline with a start frame, source trim, and volume.
_Avoid_: Audio track

**Audio mix**:
The single offline mix of a composition's audio clips for one render.
_Avoid_: Soundtrack, audio track, final cut

### Rendering

**Composition host**:
The injected runtime that loads an HTML composition, applies its bindings, and exposes its frame clock to preview and render.
_Avoid_: Preview runtime, render runtime

**Preview**:
An interactive, frame-accurate inspection of a composition using the same composition behavior as a render.
_Avoid_: Visual editor

**Check**:
A validation operation that first runs static composition validation, then loads a composition and evaluates every frame without capturing or encoding.
_Avoid_: Test render, dry run

**Static composition validation**:
The Node-side validation of a composition document's metadata, bindings, controller declaration, scripts, and asset references before browser frame production.
_Avoid_: Lint, preflight

**Composition diagnostic**:
A structured error or warning about a composition's source, metadata, bindings, controller, assets, or frame production, with a stable code and optional source location.
_Avoid_: Log message, error string

**Render**:
The production of one complete video from a composition and a fixed set of props.
_Avoid_: Recording, export

**Render concurrency**:
The optional number of independent browser sessions used to seek and capture frames during a render. Frames are still encoded in timeline order, and concurrency must not change visual state.
_Avoid_: Parallel composition, out-of-order output

**Video**:
The finished audiovisual output of a successful render.
_Avoid_: Composition, project

**Still**:
A single frame captured as a PNG through the production rendering path for debugging.
_Avoid_: Frame export, image sequence

**Reproducibility**:
The guarantee that, for the same composition revision, props, assets, and frame under a pinned runtime/browser environment, the visual state is identical. It does not imply identical encoded bytes, even on the same machine; encoded output depends on the encoder and its runtime.
_Avoid_: Bit-for-bit encoding equality

### Agent operation

**Agent-assisted authoring and operation**:
The creation and operation of a Frameyard project by an AI agent acting on a user's behalf.
_Avoid_: Built-in generative AI

**Agent skill**:
An API-version-matched set of instructions and resources through which an AI agent uses Frameyard's public authoring and operation contracts.
_Avoid_: Agent runtime, MCP server

### Local asset production

**Generated asset**:
A frozen local input produced by speech synthesis or transcription before a composition is loaded or rendered.
_Avoid_: Per-frame generation

**Provenance manifest**:
A versioned, project-local record of generated assets, their content hashes, and the inputs and processes that produced them.
_Avoid_: Render cache

**Speech synthesis** (TTS):
The local production of a spoken audio asset from text using a named speaker.
_Avoid_: Voice generation, voice cloning, voice design

**Transcription**:
The local production of timed text from source audio or video.
_Avoid_: Subtitle rendering

**Transcript**:
The canonical, versioned artifact containing full text, source identity, and source-relative timed segments, with optional word timings.
_Avoid_: Subtitle file, raw generator output

**Transcript segment**:
A timed span of transcript text with source-relative start and end times.
_Avoid_: Subtitle cue, line

**Word timing**:
The measured, source-relative start and end of a word in source audio.
_Avoid_: Interpolated segment timing

**Karaoke subtitle**:
A subtitle presentation pattern that highlights words according to actual word timings.
_Avoid_: Segment-timed highlighting
