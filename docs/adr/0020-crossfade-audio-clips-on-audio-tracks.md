# Crossfade audio clips on audio tracks

**Status:** Accepted
**Date:** 2026-11-04

A timeline may declare a `crossfade` transition between two clips on one audio track. It uses the same overlap window and geometry as a dissolve, but applies only the equal-power audio gain ramp: the outgoing clip at `sqrt(1 - t)` and the incoming clip at `sqrt(t)`, after easing. A `dissolve` remains video-track only; `crossfade` is audio-track only. The timeline document version remains 1.

## Context

ADR 0019 made same-track overlap the transition window but deferred audio-track transitions. Audio clips could already live directly on audio tracks, and the audio contributed by visual clips already crossfaded inside a dissolve, but two audio clips on one audio track could not overlap. A music or voice edit therefore needed two tracks and hand-tuned gain, and there was no gain envelope contract for arbitrary audio clips. The transition window, geometry, and equal-power curve already exist; only the track-kind gate blocks audio.

## Considered Options

- **Reuse `dissolve` on audio tracks.** Shorter, but "dissolve" names a visual operation. Allowing it on a track with no picture makes the kind/track contract ambiguous and forecloses future visual-only kinds.
- **A dedicated `crossfade` kind.** Keeps the matrix explicit: `dissolve` is video, `crossfade` is audio. The schema already carries `kind`, so this is additive and validation is one comparison.
- **Audio fades inside the composition.** Moves the edit into a reusable asset, so the fade cannot follow clip placement and the same composition cannot be used with a different overlap.
- **Two audio tracks with opposing gain envelopes.** Needs a new per-clip audio-envelope contract and still leaves the relationship implicit. The transition already supplies the window and curve.
- **Linear gain.** Dips in perceived loudness for uncorrelated material. Equal power is already the contributed-audio behavior, so using a different curve for audio-track clips would be surprising.

## Consequences

- `TRANSITION_KINDS` is `dissolve` and `crossfade`. Unknown or missing kinds use `TIMELINE_TRANSITION_KIND`; a dissolve on an audio track uses `TIMELINE_TRANSITION_AUDIO_TRACK`, and a crossfade on a video track uses `TIMELINE_TRANSITION_VIDEO_TRACK`. Both suggest the matching kind.
- The overlap relaxation covers audio tracks with the same pairwise rule: only a declared pair may overlap, a third clip is still an error, and geometry is `from.start < to.start < from.end < to.end`.
- `crossfade` changes no pixels and never reaches the segment planner or the composite filter graph. `collectTimelineAudio` already attaches absolute-frame gain envelopes to every clip with a transition, including audio-track clips, so the existing mix path applies the ramp. Clip and track gain still multiply the envelope, and `audio.muted` still zeroes a side.
- Preview drew the transition band from the resolved timeline already; audio tracks now produce it too. Playback ramps `<audio>` volume from the same envelope.
- `examples/transitions` gains an `audio-crossfade` timeline: the alpha and beta cards are reused with `audio.muted: true`, two audio clips sit on `a1`, and a `crossfade` shares the 15-frame overlap with the visual dissolve. This shows both the direct-audio placement and the kind/track split.
- Timeline documents remain version 1; `crossfade` is additive. The audio-track prohibition in ADR 0019 is superseded.
