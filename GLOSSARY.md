# Frameyard

Frameyard is a local-first framework for creating short, parameterized videos with HTML, CSS, and JavaScript. Its domain separates reusable compositions from the timelines that assemble them into a video, and from the fixed inputs and deterministic renders that turn those timelines into output.

## Language

### Authoring

**Project**:
A collection of related compositions, timelines, and the assets and configuration they share.
_Avoid_: Video, render

**Project format**:
The fixed width, height, and frame rate shared by every timeline in a project and inherited by compositions that omit those values.
_Avoid_: Composition metadata, render options

**Composition**:
A uniquely identified, reusable video or still source, content parameterized by props, and a format that is either declared or inherited from the project. An animated composition has a duration in frames; a static composition has no time base.
_Avoid_: Scene, template, video

**Static composition**:
A composition that declares neither `duration-in-frames` nor `fps`. It has no frame clock, audio, or transcripts, is captured once in its initial state, and renders to a PNG. A timeline treats it as an image source whose clip declares the duration.
_Avoid_: Still video, one-frame composition

**Declared format**:
The width, height, and frame rate a composition fragment declares on its root. A value may be absent, in which case it is inherited; a declared value always wins over the project format.
_Avoid_: Composition metadata, defaults

**Resolved format**:
The width, height, and frame rate an animated composition actually renders with, after declared values and the project format are combined. A static composition resolves width and height only. It is part of the immutable frame environment.
_Avoid_: Output options, render settings

**Composition metadata**:
The resolved dimensions plus the frame rate and duration that define an animated composition's source contract, or the dimensions and `static: true` of a static composition.
_Avoid_: Render options, props

**Composition descriptor**:
The fixed facts read from a composition fragment before frame production: declared composition metadata, default props, and the controller declaration. It excludes per-load declarations such as audio clips, transcripts, and animation schedules.
_Avoid_: Composition config, parsed document

**Composition lifecycle**:
The host-driven sequence that loads a composition fragment, optionally seeks it to frames, and releases it. A static composition is loaded, captured once, and released without seeking.
_Avoid_: Render loop, playback lifecycle

**Controller lifecycle**:
The `mount → update → dispose` sequence an animated composition controller uses for per-frame computation. A static composition runs `mount` and `dispose` only.
_Avoid_: Composition lifecycle

**Composition revision**:
A specific version of a composition's source and metadata.
_Avoid_: Build, release

**HTML composition**:
A composition whose source is a partial HTML fragment.
_Avoid_: HTML document, page

**Composition fragment**:
The authoring source of an HTML composition: body content with one top-level `<fy-composition>` root, plus optional top-level props, controller, import maps, and styles. Frameyard generates the document shell.
_Avoid_: HTML document, page

**Composition partial**:
A reusable HTML fragment with one `<fy-partial>` root, optional scoped props and schema, and inline styles. A partial is included by a composition with `<fy-include>` and is not a `fy.config.js` entry. Controller support is pending.
_Avoid_: Component, template, snippet

**Composition include**:
A static `<fy-include>` reference that expands a composition partial into the parent before bindings and frame production. The include gets its own props; it is not a runtime conditional or loop.
_Avoid_: Import, template call

**Include scope**:
The `<fy-partial>` element and its subtree: its own immutable props, binding boundary, and scoped CSS.
_Avoid_: Shadow root, component instance

**Scoped props**:
The props of one include instance, resolved from the partial's schema defaults, partial defaults, and the include's `props` attribute. Parent props do not flow into included bindings; inherited CSS custom properties are separate.
_Avoid_: Local props, component props

**Transparent composition**:
A composition that does not paint a background, so a timeline clip can reveal the layers below it.
_Avoid_: Alpha composition, overlay

**Composition controller**:
An optional JavaScript controller, either inline in the composition fragment or in an external module, that performs per-frame computation an HTML composition's declarative HTML and CSS cannot express.
_Avoid_: Composition module, plugin

**Inline controller**:
A composition controller whose source is embedded in the composition fragment.
_Avoid_: Embedded script

**External controller**:
A composition controller whose source is a separate JavaScript module referenced by the composition fragment.
_Avoid_: Controller file

**Declarative binding**:
An HTML attribute that maps a prop into text, an attribute, a class, or element presence.
_Avoid_: Template expression, interpolation

**Props**:
The immutable, JSON-serializable inputs supplied to a composition for one load; a timeline clip can fix the props for its instance of the composition.
_Avoid_: Options, settings, mutable state

**Props schema**:
An optional declarative contract for a composition's props, limited to object properties, primitive types, arrays with item schemas, required keys, enums, and defaults. It is validated before Chromium and at host load.
_Avoid_: Input schema, options, JSON Schema

**Asset**:
A local file required by a composition or timeline, whether static or generated.
_Avoid_: Resource, media file

**Remote asset**:
An image, video, or audio file downloaded during authoring with `asset add`, hashed, and pinned in `fy.assets.json`. Rendering never fetches it.
_Avoid_: URL asset, live media

**Recipe**:
A named, installable bundle of one or more composition or timeline entries, supporting props, and a README, with the exact `fy.config.js` registration entries. A recipe is an authoring convenience, not a separate runtime kind.
_Avoid_: Template, preset, project

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
How a clip source's natural frame is fitted into the project frame or an explicit clip box: contained, covering, or stretched.
_Avoid_: Resize mode, object-fit

**Clip transform**:
The size, position, rotation, and opacity applied to a visual clip. Size is either an explicit `width`/`height` box or a `scale` multiplier. Static transform values and keyframe tracks are separate; a keyed channel cannot also be a static scalar.
_Avoid_: Effect, animation

**Clip keyframes**:
A per-channel animation on a visual clip's presentation: `x`, `y`, `scale`, `rotation`, or `opacity`. Keys use clip-local integer frames and hold before the first and after the last key.
_Avoid_: CSS keyframes, composition animation

**Keyframe**:
One `{ frame, value, easing? }` entry in a clip keyframe track. `frame` is clip-local; `easing` applies to the interval after it.
_Avoid_: Marker, cue

**Keyframe track**:
The ordered keyframes for one presentation channel. Keys are strictly increasing and stay within the clip's `0..duration` range.
_Avoid_: Animation curve, property lane

**Easing**:
A CSS timing function that shapes the interval between two timeline keyframes. Preview evaluates it exactly; production approximates it in the FFmpeg filter graph.
_Avoid_: Interpolation, curve

**Blend mode**:
The static CSS `mix-blend-mode` a visual clip applies against the accumulated backdrop of all lower layers and the timeline background. It respects the clip's source alpha and is not animated.
_Avoid_: Filter, effect, composite mode

**Transition**:
A declared handoff between two clips on one track, written as `{ from, to, kind, easing? }` in the timeline's `transitions` array. `dissolve` is a visual fade on a video track; `crossfade` is an audio gain ramp on an audio track. The clips overlap; an overlap without a declared transition is still an error.
_Avoid_: Overlap

**Crossfade**:
The audio-track transition kind. It ramps the outgoing audio clip down and the incoming clip up with equal power and changes no pixels.
_Avoid_: Dissolve, fade

**Transition window**:
The overlap `to.start .. from.end` where both clips are active. During a dissolve the incoming clip composites above the outgoing clip with `opacity × eased progress`, evaluated at absolute timeline frames.
_Avoid_: Handle, overlap region

**Transition role**:
The side a clip takes in a transition: `out` for the clip being replaced, `in` for the clip replacing it.
_Avoid_: Transition direction, fade side

**Equal-power crossfade**:
The audio gain curve inside either transition kind: the outgoing clip ramps as `sqrt(1 - t)` and the incoming clip as `sqrt(t)` after easing, keeping perceived loudness steady.
_Avoid_: Linear fade

**Nested timeline**:
A timeline used as a clip source inside another timeline.
_Avoid_: Compound composition

### Fonts

**Font manifest**:
The versioned `fy.fonts.json` file that records vendored font families, their CSS family names, providers, licenses, and file hashes. It is the source of truth for the generated `@font-face` sheet.
_Avoid_: Font config, font cache

**Font provider**:
The acquisition source recorded for a font family: `local` for a user-supplied file, `fontsource` for a pinned Fontsource download, or `url` for an explicit HTTPS source.
_Avoid_: Font catalog, font CDN

**Font family entry**:
One manifest entry keyed by a stable id. It contains the CSS family name, provider metadata, license, optional variable axes, and one or more font files.
_Avoid_: Font face, font package

**Font face**:
One file entry inside a family: a subset, style, weight or weight range, format, optional unicode range, SHA-256, and byte size.
_Avoid_: Font variant, font weight

**Font subset**:
A provider-defined slice of a family's glyph coverage, such as `latin` or `latin-ext`. Subsets are recorded per face and may carry a CSS `unicode-range`.
_Avoid_: Language, charset

**Variable font**:
A font file that carries a continuous range for one or more axes instead of separate static weights. Frameyard records the axes and emits a CSS weight range; the first version installs the `wght` axis only.
_Avoid_: Dynamic font, multiple weight font

### Deterministic execution

**Frame**:
An integer-addressed position on a timeline or composition frame range; use timeline frame or composition frame when the distinction matters.
_Avoid_: Timestamp, animation tick

**Animation preset**:
A named, deterministic entrance animation selected with `data-fy-anim-preset` and scheduled by start frame, duration, and easing. It is implemented as a Web Animation, not a separate animation engine.
_Avoid_: Transition, effect, keyframe library

**Render frame range**:
An inclusive start and end frame selected for a render. Video requires a contiguous range; PNG sequences may use an arbitrary ordered list.
_Avoid_: Trim range, time range

**Active clip**:
A clip whose timeline range contains the current timeline frame.
_Avoid_: Visible clip

**Timeline scene**:
The ordered active clips and their presentation at one timeline frame or over one render range, including transition roles and composite order. It is the timeline-level arrangement, not a composition.
_Avoid_: Timeline composition, frame snapshot

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
The injected runtime that loads a composition fragment, applies its bindings, and exposes its frame clock to preview and render.
_Avoid_: Preview runtime, render runtime

**Timeline host**:
The preview runtime that loads a timeline, drives a bounded pool of active clip sources, and exposes the timeline frame clock to the preview.
_Avoid_: Timeline runtime, production renderer, editor

**Timeline renderer**:
The Node-side segmented renderer that captures composition clips, composites and encodes timeline segments, and joins them into one video.
_Avoid_: Timeline host, browser renderer

**Preview**:
An interactive, frame-accurate inspection of a timeline or composition using the same behavior as a render, with a filterable assets list, one tabbed source/program monitor, a docked props and inspector column, a read-only timeline strip, System/Light/Dark theming, monitor zoom and fullscreen, and URL-addressable primary selection and frame.
_Avoid_: Visual editor

**Playhead**:
The current timeline frame in preview.
_Avoid_: Cursor, scrubber

**Source monitor**:
The preview surface that shows the selected composition, timeline clip source, or media asset independently of the timeline playhead.
_Avoid_: Program monitor, stage, canvas

**Program monitor**:
The preview surface that shows the timeline at the playhead.
_Avoid_: Stage, canvas

**Check**:
A validation operation that first runs static validation, then loads a timeline or composition and evaluates every frame without capturing or encoding. A static composition has one state, so it is loaded and inspected once.
_Avoid_: Test render, dry run

**Static composition validation**:
The Node-side validation of a composition fragment's metadata, bindings, controller declaration, scripts, and asset references before browser frame production.
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
The production of one complete video from a timeline or an animated standalone composition, or one PNG from a static standalone composition, with fixed inputs.
_Avoid_: Recording, export

**Static composition render**:
The PNG produced by `render` for a static composition. It has no frame rate, duration, audio, or encoder.
_Avoid_: Still, frame export

**Render concurrency**:
The optional number of independent browser sessions used to seek and capture frames during a composition render; timeline rendering is sequential in 0.6. Frames are still encoded in timeline order, and concurrency must not change visual state.
_Avoid_: Parallel composition, out-of-order output

**Video**:
The finished audiovisual output of a successful render.
_Avoid_: Composition, project

**Still**:
One or more requested frames captured as PNGs through the production rendering path for a timeline or composition. A static composition exposes exactly frame 0. A single invocation captures at most 32 inspection frames; this is not image-sequence output.
_Avoid_: Frame export, image sequence

**Reproducibility**:
The guarantee that, for the same timeline or composition revision, props, assets, and frame under a pinned runtime/browser environment, the visual state is identical. It does not imply identical encoded bytes, even on the same machine; encoded output depends on the encoder and its runtime.
_Avoid_: Bit-for-bit encoding equality

### Resource policy

**Resource policy**:
A workspace-local `fy.policy.json` declaration of which CLI operations are allowed and which resource limits apply. It is discovered from the working directory upward, independent of `fy.config.js`, and can only tighten its tier.
_Avoid_: Project config, agent runtime

**Policy tier**:
One of `light`, `authoring`, or `full`. A tier fixes the allowed heavy operations, the still-frame cap (1, 4, or the library cap of 32), and overwrite permission. `FRAMEYARD_POLICY` replaces the policy file for a human override.
_Avoid_: Permission mode, sandbox

**Resource profile**:
A named set of runtime caps and priority settings for a shared machine. `shared-cpu` caps timeline workers at two, composition concurrency at one, and lowers process priority.
_Avoid_: Encoder preset, render mode

**Lint**:
A Node-only validation pass that resolves a composition or timeline, projects every timeline scene and keyframe channel, scans controller source for wall-clock and randomness calls, and probes media metadata without launching Chromium. Lint is not a substitute for `check`.
_Avoid_: Static check, fast render

**Dry run**:
A heavy command mode that validates inputs and returns a plan, handoff command, prerequisites, and blockers without writing outputs, loading a model, launching Chromium, or encoding.
_Avoid_: Preview, partial render

### Inspection and templates

**Project context**:
A compact, read-only digest of a project's format, composition metadata, prop types, timeline clips, assets, installed fonts, diagnostics, active policy, and next commands.
_Avoid_: Project dump, repo summary

**Image inspection**:
Text facts extracted from a decoded still: dimensions, alpha coverage, blank detection, background and dominant colors, content bounding box, luminance grid, and edge density.
_Avoid_: Visual review, AI vision

**Image comparison**:
A pixel and region diff between two decoded images. It reports differing pixels, channel deltas, a bounding box, and a 3×3 region breakdown.
_Avoid_: Pixel hash, visual diff

**Preview inspector**:
A read-only panel in the composition or timeline preview that explains the selected element or clip, its bindings and resolved values, frame state, timing, and matching diagnostics. It never edits the source.
_Avoid_: Editor, properties panel

**Project template**:
A known-good composition or timeline entry that `add` writes while printing the explicit `fy.config.js` registration snippet.
_Avoid_: Generator, project scaffold

### Agent operation

**Agent-assisted authoring and operation**:
The creation and operation of a Frameyard project by an AI agent acting on a user's behalf.
_Avoid_: Built-in generative AI

**Agent skill**:
An API-version-matched set of instructions and resources through which an AI agent uses Frameyard's public authoring and operation contracts.
_Avoid_: Agent runtime, MCP server

**Diagnostic fix**:
An optional structured correction attached to a diagnostic or error, carrying a kind, a short instruction, and optional replacement, command, and documentation fields. Fixes are advisory and never applied automatically.
_Avoid_: Autofix, patch

**Explain**:
The `frameyard explain` command that turns a stable diagnostic code into a cause, examples, and documentation.
_Avoid_: Error lookup, autofix

### Local asset production

**Generated asset**:
A frozen local input produced by speech synthesis or transcription before a timeline or composition is loaded or rendered.
_Avoid_: Per-frame generation

**Provenance manifest**:
A versioned, project-local record of generated assets, their content hashes, and the inputs and processes that produced them.
_Avoid_: Render cache

**Speech synthesis** (TTS):
The local production of a spoken audio asset from text using a named speaker or numeric speaker id.
_Avoid_: Voice generation, voice cloning, voice design

**Speech engine**:
A local executable that turns text into a speech asset. Frameyard supports qwentts.cpp CustomVoice and sherpa-onnx Supertonic 3.
_Avoid_: TTS provider, cloud voice

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
