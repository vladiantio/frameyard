# Make timelines the render unit and compositions clip sources

**Status:** Accepted
**Date:** 2026-10-31

Frameyard will render timelines as its primary output unit. A timeline is a project-local JSON document with a project-fixed width, height, and frame rate, ordered video and audio tracks, and clips sourced from HTML compositions, local media, or other timelines. A composition remains the reusable HTML authoring unit and becomes a clip source whose source range and props are fixed by each clip. Standalone composition renders remain supported on the existing direct path.

## Considered Options

- **Keep compositions as the render unit and add a playlist.** Rejected because a playlist produces separate videos, not one composited output, and cannot express layers, trims, or nested timelines.
- **Make every composition render an implicit one-clip timeline.** Rejected as the internal path because wrapping the existing composition capture in iframes and a stage would risk pixel and result-schema changes for existing projects. Composition renders keep the direct path; the CLI exposes both targets under one ID space.
- **Make the timeline a composition.** Rejected because it would conflate a reusable, prop-parameterized source with an edit that has tracks, clips, and a project format, and would invite ambiguous recursion. Timelines nest through clips, not through the composition contract.
- **Allow per-timeline formats.** Rejected because one project format removes frame-rate conversion from clip mapping and makes nested timelines and media composition straightforward. Standalone compositions keep their own metadata.
- **Allow overlapping clips on one track.** Rejected for 0.6 because transitions are deferred; overlap would create ambiguous audio and visual precedence. Crossfades can use separate tracks until transitions exist.

## Consequences

- `video.config.js` gains an optional project `format` and an explicit `timelines` map. IDs are unique across compositions and timelines so `render <id>`, `check <id>`, and `still <id>` stay unambiguous.
- A composition used in a timeline must share the project frame rate exactly; a different size is fitted and transformed by the clip.
- Timeline duration is derived from the last clip end, with an optional override. A timeline with no clips is invalid; an audio-only timeline is valid and renders black video with audio.
- Nested timelines are visual and audio sources, are cycle-checked, and do not accept prop overrides for their internal compositions in 0.6.
- Timeline clips use static fit, position, scale, rotation, and opacity. Transitions, keyframes, effects, track solo/hidden, and audio fades are deferred.
- Composition rendering keeps its existing result schema; timeline rendering returns a new timeline result schema.
- The design baseline, glossary, agent skill, scaffold, examples, and tests gain timeline language; existing composition projects remain valid without migration.
