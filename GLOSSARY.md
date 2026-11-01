# Frameyard

Frameyard is a local-first framework for creating short, parameterized videos with HTML, CSS, and JavaScript. Its domain separates reusable compositions from the timelines that assemble them into a video, and from the fixed inputs and deterministic renders that turn those timelines into output.

## Language

### Authoring

**Project**:
A collection of related compositions, timelines, and the assets and configuration they share.
_Avoid_: Video, render

**Project format**:
The fixed width, height, and frame rate shared by every timeline in a project.
_Avoid_: Composition metadata, render options

**Composition**:
A uniquely identified, reusable video source with fixed dimensions, frame rate, duration in frames, and content parameterized by props.
_Avoid_: Scene, template, video

**Composition metadata**:
The fixed dimensions, frame rate, and duration in frames that define a composition's source contract.
_Avoid_: Render options, props

**Composition descriptor**:
The fixed facts read from an HTML composition before frame production: composition metadata, default props, and the controller declaration. It excludes per-load declarations such as audio clips, transcripts, and animation schedules.
_Avoid_: Composition config, parsed document

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

**Transparent composition**:
A composition that does not paint a background, so a timeline clip can reveal the layers below it.
_Avoid_: Alpha composition, overlay

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
The immutable, JSON-serializable inputs supplied to a composition for one load; a timeline clip can fix the props for its instance of the composition.
_Avoid_: Options, settings, mutable state

**Asset**:
A local file required by a composition or timeline, whether static or generated.
_Avoid_: Resource, media file

**Timeline**:
A top-level edit that assembles tracks and clips into one video under the project format, with a duration derived from its clips or explicitly overridden.
_Avoid_: Sequence, composition, project

**Timeline document**:
The project-local JSON document that declares a timeline's tracks, clips, optional duration, and background.
_Avoid_: Composition, config

**Track**:
An ordered layer in a timeline. Video tracks composite; audio tracks mix.
_Avoid_: Channel, lane

**Video track**:
A track whose clips contribute visual layers, ordered from bottom to top.
_Avoid_: Visual lane

**Audio track**:
A track whose clips are audio-only and contribute additively to the timeline audio mix.
_Avoid_: Soundtrack

**Clip**:
A placement of a clip source on a track, with a timeline start, source in-point, duration, and presentation settings.
_Avoid_: Segment, item, block

**Clip source**:
The composition, nested timeline, or local media asset that a clip presents.
_Avoid_: Media, asset

**Composition clip**:
A clip whose source is a composition, with fixed props for that instance.
_Avoid_: Composition instance, nested composition

**Media clip**:
A clip whose source is a local video, image, or audio asset.
_Avoid_: Asset clip, raw clip

**Nested timeline clip**:
A clip whose source is another timeline.
_Avoid_: Nested sequence, compound clip

**Source in-point**:
The first source frame a clip uses.
_Avoid_: Trim start, offset

**Timeline frame**:
An integer-addressed position on a timeline's master frame grid.
_Avoid_: Composition frame, timestamp

**Composition frame**:
An integer-addressed position within a composition; the frame a controller receives.
_Avoid_: Timeline frame

**Timeline duration**:
The number of timeline frames a timeline produces, derived from its clips or explicitly overridden.
_Avoid_: Composition duration, length

**Timeline background**:
The optional color behind all layers of a timeline; it is transparent by default and the final video composites it over black.
_Avoid_: Canvas, backdrop

**Fit policy**:
How a clip source's natural frame is scaled into the project format: contained, covering, or stretched.
_Avoid_: Resize mode, object-fit

**Clip transform**:
The static position, scale, rotation, and opacity applied to a visual clip.
_Avoid_: Effect, animation

**Nested timeline**:
A timeline used as a clip source inside another timeline.
_Avoid_: Compound composition

### Deterministic execution

**Frame**:
An integer-addressed position on a timeline or composition frame range; use timeline frame or composition frame when the distinction matters.
_Avoid_: Timestamp, animation tick

**Active clip**:
A clip whose timeline range contains the current timeline frame.
_Avoid_: Visible clip

**Clip capture**:
The pixel frames a composition produces for a timeline clip before the timeline compositor combines layers.
_Avoid_: Screenshot, render

**Timeline composite**:
The deterministic combination of a timeline's layers into output frames.
_Avoid_: Browser composite, preview

**Render segment**:
A bounded span of a timeline that is rendered and encoded independently, then joined in timeline order.
_Avoid_: Chunk, part

**Deterministic execution**:
The rule that a timeline frame's visual state depends only on that timeline frame, its clip sources and their props, and pre-loaded data and assets; a composition frame depends only on its composition frame, props, and pre-loaded data and assets.
_Avoid_: Playback-driven animation

**Frame clock**:
The single source of animation time within a composition, derived from its composition frame and frame rate; the preview host or the production segment renderer drives it by seeking each active composition clip.
_Avoid_: Wall clock, playback timer

**Frame-state variable**:
A CSS custom property whose value is derived from the current composition frame.
_Avoid_: Animation variable, clock variable

**Seek safety**:
The property that any timeline frame can be produced correctly without depending on previously produced timeline frames, by seeking each active clip to its source frame.
_Avoid_: History-dependent updates

**Deterministic randomness**:
Random values derived statelessly from a key so they do not depend on call order or rendering history.
_Avoid_: Unseeded randomness

**Frame production**:
The phase in which the runtime produces the visual state of a requested timeline frame, without network access or model inference.
_Avoid_: Real-time playback

**Loading phase**:
The phase before frame production when all clip sources, compositions, media, data, and assets become available.
_Avoid_: Per-frame fetching

**Embedded media**:
A local video file placed inside a composition whose presentation time is derived from the composition frame, with optional frame offset and source trim.
_Avoid_: Live stream, video track

**Media settle**:
The asynchronous step after a seek that waits for embedded video decode and browser paint before a frame is captured or checked.
_Avoid_: Playback, buffering

**WebGL canvas**:
A canvas redrawn from the current frame through WebGL, captured by the same screenshot path as DOM and Canvas 2D content.
_Avoid_: GPU animation, live render

### Audio

**Composition audio clip**:
An audio source declared inside a composition and placed by composition frames; it joins the timeline mix when the composition is used as a clip.
_Avoid_: Audio clip, audio track

**Timeline audio clip**:
An audio-only clip placed on a timeline audio track.
_Avoid_: Audio clip, soundtrack

**Audio mix**:
The single offline mix of a timeline's audible clips for one render.
_Avoid_: Soundtrack, audio track, final cut

**Embedded audio**:
The audio track of an embedded video, contributed to the mix unless the video or clip is muted.
_Avoid_: Live audio

### Rendering

**Composition host**:
The injected runtime that loads an HTML composition, applies its bindings, and exposes its frame clock to preview and render.
_Avoid_: Preview runtime, render runtime

**Timeline host**:
The preview runtime that loads a timeline, drives a bounded pool of active clip sources, and exposes the timeline frame clock to the preview.
_Avoid_: Timeline runtime, production renderer, editor

**Timeline renderer**:
The Node-side segmented renderer that captures composition clips, composites and encodes timeline segments, and joins them into one video.
_Avoid_: Timeline host, browser renderer

**Preview**:
An interactive, frame-accurate inspection of a timeline or composition using the same behavior as a render, including a program monitor and a read-only timeline view.
_Avoid_: Visual editor

**Playhead**:
The current timeline frame in preview.
_Avoid_: Cursor, scrubber

**Program monitor**:
The preview surface that shows the timeline at the playhead.
_Avoid_: Stage, canvas

**Check**:
A validation operation that first runs static validation, then loads a timeline or composition and evaluates every frame without capturing or encoding.
_Avoid_: Test render, dry run

**Static composition validation**:
The Node-side validation of a composition document's metadata, bindings, controller declaration, scripts, and asset references before browser frame production.
_Avoid_: Lint, preflight

**Static timeline validation**:
The Node-side validation of a timeline document's tracks, clips, references, nested timelines, media, and referenced compositions before browser frame production.
_Avoid_: Lint, preflight

**Composition diagnostic**:
A structured error or warning about a composition's source, metadata, bindings, controller, assets, or frame production, with a stable code and optional source location.
_Avoid_: Log message, error string

**Timeline diagnostic**:
A structured error or warning about a timeline's source, tracks, clips, references, media, or frame production, with a stable code and optional source location.
_Avoid_: Log message, error string

**Render**:
The production of one complete video from a timeline or a standalone composition with fixed inputs.
_Avoid_: Recording, export

**Render concurrency**:
The optional number of independent browser sessions used to seek and capture frames during a composition render; timeline rendering is sequential in 0.6. Frames are still encoded in timeline order, and concurrency must not change visual state.
_Avoid_: Parallel composition, out-of-order output

**Video**:
The finished audiovisual output of a successful render.
_Avoid_: Composition, project

**Still**:
A single frame captured as a PNG through the production rendering path for a timeline or composition.
_Avoid_: Frame export, image sequence

**Reproducibility**:
The guarantee that, for the same timeline or composition revision, props, assets, and frame under a pinned runtime/browser environment, the visual state is identical. It does not imply identical encoded bytes, even on the same machine; encoded output depends on the encoder and its runtime.
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
A frozen local input produced by speech synthesis or transcription before a timeline or composition is loaded or rendered.
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
