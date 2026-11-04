# Make same-track overlap the transition window

**Status:** Accepted
**Date:** 2026-11-04
**Amended by:** [ADR 0020](./0020-crossfade-audio-clips-on-audio-tracks.md) adds the `crossfade` kind for audio tracks; the audio-track prohibition in this record is superseded.

A timeline may declare a `transitions` array. Each entry names a `from` clip, a `to` clip, and a `kind`. A dissolve requires the two clips to overlap on one video track; the overlap `[to.start, from.end)` is the transition window. Only the incoming clip carries animated alpha, `opacity × eased progress`, and both clips' contributed audio crossfades with equal power. The annotation is explicit: an overlap without a declared transition is still `TIMELINE_CLIP_OVERLAP`. The timeline document version remains 1.

## Context

ADR 0010 rejected same-track overlap because transitions were deferred and overlap would make visual and audio precedence ambiguous. Crossfades used separate tracks plus opposing opacity keyframes, which is valid but doubles the track count and leaves the relationship implicit. The roadmap now needs transitions as a first-class authoring feature.

The renderer is segmented: every segment has a fixed layer set, and the segment plan builds layers from visual clips that fully cover the range. Preview activates clips pointwise. Both paths already evaluate presentation against absolute timeline frames, which is what keeps segments independent. A transition must not introduce a second timing model, retiming, or media handles.

## Considered Options

- **Explicit overlap.** The clips visibly overlap by the transition length and the overlap is the window. Every clip's visible range stays exactly its declared range, so the planner, preview active set, `still`, and `check` all agree with the JSON. Authors move the incoming clip earlier by the transition duration. No handles are needed: the outgoing clip's declared duration already covers its side, and the incoming clip starts at its own `start`.
- **Cut-centered implicit extension.** Clips stay butt-joined and the renderer extends one or both past its declared bounds. This needs media handles that video and nested timelines may not have, and creates frames where a clip is visible outside `[start, end)`. `still`, `check`, and the preview would disagree with the document.
- **Transition inserts time and retimes downstream clips.** Timeline duration would depend on transition declarations, and every later clip would shift. Declarative JSON should not hide retiming.
- **Overlap alone implies a dissolve.** An accidental two-frame overlap would silently become a fade instead of failing. Explicit declaration keeps overlap an error unless intended.
- **FFmpeg `xfade` or a catalog of effects.** `xfade` is relative to a filter offset, not the absolute timeline frame, and most modes have no CSS equivalent. Preview parity would silently break.
- **Both clips fade (`1 - t` and `t`).** Background leaks through partially transparent clips and the formula depends on both clips' opacity. Overlaying the incoming clip at alpha `t` over a normally rendered outgoing clip is exact when the incoming clip is opaque and is the same alpha product the keyed-opacity path already uses.
- **Linear audio gain.** Equal-power (`sqrt`) keeps perceived loudness constant through the overlap; linear gain dips for uncorrelated material. `sqrt` is exact in both the browser and FFmpeg expressions.
- **Audio-track transitions in the same change.** Audio tracks have a separate overlap and gain contract. Deferred.

## Consequences

- `transitions` entries are `{ from, to, kind, easing? }`. `kind` is required and must be `dissolve` (ADR 0020 extends the accepted kinds with `crossfade` for audio tracks); `easing` defaults to `linear` and uses the keyframe CSS timing-function grammar. There is no `duration`: the overlap is the single source of truth. A clip may be the `to` of one transition and the `from` of another, but not twice on the same side.
- Valid geometry is `from.start < to.start < from.end < to.end`. Anything else is `TIMELINE_TRANSITION_GEOMETRY` (ordering or containment) or `TIMELINE_TRANSITION_NOT_OVERLAPPING` (touching or later). Reference errors are `TIMELINE_TRANSITION_UNKNOWN_CLIP`, `TIMELINE_TRANSITION_WRONG_TRACK`, and `TIMELINE_TRANSITION_AUDIO_TRACK`; duplicate participation is `TIMELINE_TRANSITION_DUPLICATE`; an unsupported kind is `TIMELINE_TRANSITION_KIND`. Structural entry errors use `TIMELINE_TRANSITION_INVALID`.
- The pairwise overlap rule now allows only declared pairs on the same track. A third clip that overlaps either side is still an error, so at most two clips are active on a video track at any frame.
- During the window the incoming clip composites above the outgoing clip on the same track. Its alpha is `clipOpacity × t`, where `t = clamp(ease((frame - to.start) / (from.end - to.start)))`. Clip opacity may be static or keyframed and multiplies rather than being overridden. Blend modes compose with transition alpha because it is the same multiplier the keyed-opacity mask already applies.
- Production adds the transition factor to the existing `geq` alpha mask (`N + frameOffset` evaluates absolute frames) and does not split segments at transition edges: the edges are already clip boundaries. Segments chopped by `maxSegmentFrames` produce identical values.
- Contributed audio uses gain `sqrt(1 - t)` for the outgoing clip and `sqrt(t)` for the incoming clip, evaluated after easing. Envelopes are absolute frames and multiply through nested timelines, so a transition on a group clip fades its group audio. `audio.muted` still zeroes its side. Audio-track clips are untouched.
- Preview multiplies the incoming layer's CSS opacity by the same eased progress, stacks it above the outgoing clip via a per-track z-index pair, ramps `<audio>` volume from wall-clock playback, and draws a read-only hatched band on the strip. Production and preview agree at the composite stage; encoded pixels keep the existing scaling, alpha, and color-conversion differences.
- `check` sweeps every transition frame and exposes `transitions` in the timeline check result. `still` composites a frame inside the window through the same path as `render`.
- Timeline documents remain version 1; `transitions` is additive. Documentation and the `examples/transitions` reference project cover the contract. The documented 0.8 non-goal is removed.
