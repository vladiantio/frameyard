# Render timeless compositions as still images

**Status:** Accepted
**Date:** 2026-11-03

A composition that declares neither `duration-in-frames` nor `fps` is static. It
has no frame clock, no duration, and no audio or transcripts. Frameyard captures
it once in its initial state and publishes a PNG; inside a timeline the same
composition becomes an image layer that the clip's explicit duration controls.
A static composition is visual-only: `<img>`, CSS, SVG, and canvas are allowed;
`<video>`, `<audio>`, and `<fy-transcript>` are validation errors. Its controller
may `mount()` and validate props, but `update()` is not called and frame-state
variables are not set. CSS animations and transitions are paused at time 0 with
a warning. `data-fy-anim-*` is an error.

The metadata matrix is explicit. `duration-in-frames` plus `fps` is animated;
`duration-in-frames` without `fps` is animated with the project frame rate;
neither attribute is static; `fps` without `duration-in-frames` is
`COMPOSITION_INVALID`. `width` and `height` keep their current rules: declared
together or inherited from the project `format`. A static composition with no
dimensions in a project without `format` still fails with
`COMPOSITION_FORMAT_UNRESOLVED`.

`render <static-id>` writes `out/<id>.png` and accepts `--props`, `--overwrite`,
and `--json`. It rejects `--container`, `--codec`, `--encoder`, and
`--concurrency`. The render result is a discriminated union: `kind: "image"`
with `path`, `width`, `height`, `bytes`, `diagnostics`, and `elapsedMs`, or
`kind: "video"` with the existing video fields. `check` returns a matching
`kind: "static"` result with `framesChecked: 1` and no audio or transcript
fields. `still` treats a static composition as exactly frame 0; any other frame
is `FRAME_OUT_OF_RANGE`.

A timeline composition clip whose source is static must declare `duration` and
use `sourceIn: 0`, exactly like an image clip. The resolver gives it no intrinsic
duration and skips the frame-rate comparison. The renderer captures one
transparent PNG per composition/props pair and reuses it across segments and
workers through the existing image input path. The timeline still renders to
video; a fully static timeline is not converted to an image. Nested timelines
remain video layers in this version, although static compositions inside them
are still captured once. Timeline check inspects a static layer once and does
not seek it per frame.

## Context

Composition rendering captured every frame of `duration-in-frames`, even when
the document never changed. Timeline rendering did the same for every active
composition layer in every segment. A long title card or a static background
therefore paid Chromium seeks, PNG captures, FFV1 encoding, and compositing for
identical frames. The existing `still` command already proved the single-capture
path, but it required the author to know the composition was static and to use a
different command.

The composition format had one required time fact, `duration-in-frames`, so
there was no way to express "this document has no time base". Treating missing
duration as an error protected authors from typos. This ADR makes the absence
meaningful and keeps the typo protection through the `fps`-without-duration
error, validation of time drivers, and a clear render output.

## Considered options

- **An explicit `data-fy-static` marker with a frame sample.** Rejected: it keeps
  `duration-in-frames` mandatory, so a still declares meaningless time metadata,
  and it adds a second way to say what the missing attributes already say.
- **Runtime detection by comparing sampled frames.** Rejected: without a clock
  there are no frames to sample, and with a clock the check is probabilistic
  (an animation that only changes between samples escapes). The guarantee is
  structural instead: a static composition has no time base and no time drivers.
- **Keep rendering static compositions as video.** Rejected: it preserves the
  exact cost the change is meant to remove and forces a video container onto an
  artifact that is one image.
- **Add `--video` to force the old path.** Rejected for now: a timeline already
  produces video from an image clip, and the flag would make the output type
  depend on a render flag rather than the composition contract.
- **Allow audio, transcripts, or embedded video in a static composition.**
  Rejected: a PNG cannot carry them, and allowing them would make the same
  source behave differently in a standalone render and in a timeline.
- **Export a fully static timeline as a PNG.** Rejected: a timeline is the
  delivery unit and carries duration, audio, and sequencing even when its visual
  content is constant.

## Consequences

- `duration-in-frames` is no longer required on every composition. A composition
  that declares neither time attribute is static; a composition that declares
  only `fps` is invalid.
- Static compositions cannot use `data-fy-anim-*`, media, or transcripts. The
  host reports `STATIC_ANIMATION_UNSUPPORTED`, `STATIC_MEDIA_UNSUPPORTED`, and
  `STATIC_UPDATE_IGNORED`/`STATIC_ANIMATION_PAUSED` diagnostics.
- `render`, `check`, and `still` gain a static path. The video result keeps its
  fields and adds `kind: "video"`; the image result and static check result are
  new public shapes.
- Timeline composition clips are image-like when their source is static:
  explicit duration, `sourceIn: 0`, no intrinsic source duration, and one
  capture per props variant shared across segments.
- Preview loads a static composition once, disables its transport, and keeps a
  static timeline layer loaded without seeking it.
- The design baseline, glossary, README, official skill, scaffold guide,
  changelog, examples, and tests describe the new contract. Version 0.8.0 marks
  the contract change.
