# Preview testing

The preview runs the production composition and timeline hosts in a browser. Use
the embedded hosts for deterministic Playwright probes; they are same-origin and
expose the same seek/settle contract the renderer uses.

## Preview layout

Both non-embedded routes render the same editor-style shell:

- `.assets-panel`: `#composition` and `#timeline` pickers plus
  `#composition-assets`, `#timeline-assets`, and `#media-assets`. Media assets
  come from the selected timeline. Composition tiles use live scaled iframes;
  media tiles use image/video previews or an audio label.
- `.source-panel`: `#source-viewport` holds `#stage-frame` for a composition,
  `#source-timeline-frame` for a nested timeline, `#source-media` for media, or
  `#source-empty`. The source title is `#source-title`.
- `.program-panel`: `#program-viewport` holds `#stage`, the timeline host. The
  program title is `#title`.
- `.props-panel`: `#props-view` holds the JSON editor and apply/format buttons;
  `#inspector-host` holds the docked `#inspector`. The props view hides while
  the inspector is open.
- `.timeline-panel`: `#timeline-inner`, `#ruler-scale`, `#tracks`, and
  `#playhead`.

Composition focus uses the source transport for `#play`, `#frame`, `#duration`,
`#scrub`, `#step-back`, `#step-forward`, `#jump-back`, `#jump-forward`, `#mute`,
and `#volume`; the program transport uses `timeline-` prefixed ids. Timeline
focus reverses that: the program transport owns the unprefixed ids and the
source transport uses `source-` prefixed ids. `#play-button` always drives the
program monitor, and `#play` always drives the source monitor.

## Composition preview

- Page: `/__frameyard/?composition=<id>`.
- Stage: the `#stage-frame` iframe in the source monitor.
- API: `window.__frameyardPreview` exposes `load(entry, props?)`, `seek(frame)`,
  `settle()`, and `dispose()`.
- `seek()` is synchronous. Call `await settle()` before reading pixels; `load()`
  resets the host, so apply props through it.
- A static composition reports `metadata: { width, height, static: true }`.
  `seek()` is a no-op, `settle()` resolves, and the page disables the source
  transport. Wait for the static composition's own marker instead of
  `waitForFrame()`, which expects a controller-updated `#box`.
- Selecting a composition tile or the composition picker loads the source
  monitor. The same page also loads the first timeline into the program monitor
  and timeline strip when the project has one.

## Timeline preview

- Page: `/__frameyard/timeline/<id>`; add `?__fy-embed=1` for the embedded host.
- API: the embedded host exposes `window.__fyTimeline` with `ready`, `format`,
  `durationInFrames`, `load()`, `seek(frame)`, `settle()`, and `dispose()`. The
  non-embedded page also publishes a `window.__fyTimeline` facade over the
  program monitor.
- Order: `await ready`, `await load()`, `await seek(frame)`, `await settle()`.
- The non-embedded page owns transport, audio, clips, keyframe markers, the
  timeline strip, and the docked inspector; the embedded host only exposes the
  stage API.
- Clicking a `.clip[data-clip-id]` selects it, loads its source into the source
  monitor at `sourceIn`, and opens the clip inspector. It does not move the
  program playhead. Use the inspector's jump actions or a keyframe marker to
  seek.
- A static composition source carries `metadata.static: true` and no
  `metadata.durationInFrames`. The host loads the layer once and skips per-frame
  seek; the layer remains visible while the timeline playhead moves.
- The embedded host projects the serialized resolved timeline with the shared
  scene module on every seek. Do not add a preview-only clip or transition
  model; give the scene module what it needs instead.
- A keyframed clip updates the layer wrapper's inline `opacity` and `transform`
  on every seek. Assert those styles or the rendered stage after `settle()`.
  Markers are `.keyframe-marker` elements with a `data-frame` absolute timeline
  frame and a channel/value tooltip; clicking one seeks the playhead.
- Inside a transition window both clips are active. The incoming layer's inline
  `opacity` is `clipOpacity × eased progress` and it stacks above the outgoing
  layer on the same track. The strip draws a `.transition` band with a
  `from → to` tooltip; it is read-only.
- The strip opens with a `.ruler-scale` carrying five `.ruler-tick` labels at
  0/25/50/75/100% of the frame range. One `.playhead` line spans the ruler and
  every track, driven by a `--playhead-factor` custom property on
  `#timeline-inner`; `--progress` on `#scrub` fills the transport rail.
- Both preview pages share the chrome in `src/server/preview-style.ts` and its
  design tokens. The chrome serves its own Figtree and Space Mono from
  `/__frameyard/framework/preview/fonts/` and does not link the project font
  sheet. The embedded host page has none of this chrome.

## Inspector

Both non-embedded preview pages create a read-only inspector as
`<aside id="inspector">` inside `#inspector-host`. It docks into the props
panel and does not float over the stage.

- Composition: clicking an element selects it. Rows show tag, id, classes,
  current frame, frame-state variables, and every `data-fy-*` binding with its
  resolved prop value. Diagnostics that reference the element are listed.
- Timeline: each clip is a `.clip[data-clip-id]` with `tabindex="0"` and
  `role="button"`. Selecting it shows source kind/id/path, track, start,
  duration, end, `sourceIn`, props, transform, keyframes, blend, and audio.
- Actions use `#inspector-jump-start`, `#inspector-jump-end`,
  `#inspector-copy`, and `#inspector-open`. The copy button exposes the exact
  command in `data-copy-text` for tests. Escape or `#inspector-close` closes
  the panel.
- The panel only reads preview state. It must not mutate the composition,
  timeline, or host props.

## Waiting for a frame

- `settle()` waits for video presentation through `requestVideoFrameCallback`
  and then for two animation frames for composition and iframe paint. Do not add
  `waitForTimeout` to assertions.
- For a composition layer, wait for a controller-updated marker. The shared
  helper `test/helpers/preview.ts` exports `waitForFrame(page, frame)`.
- For a video layer, sample the rendered stage after `settle()`; do not trust
  `video.currentTime` alone. `test/timeline-preview-runtime.test.ts` covers this.
- The same helper exports `openEmbeddedTimeline`, `loadTimeline`, and
  `seekTimeline`.

## Capture probes

Production capture uses `openCompositionSession`, not the preview hosts. Probe it
through the same CDP session when testing capture density or scaled output; the
Playwright convenience APIs hide the device metrics:

- `newContext({ deviceScaleFactor })` changes `window.devicePixelRatio` but does
  not change the raw `Page.captureScreenshot` size. `page.screenshot()` also
  returns the CSS-pixel size.
- Send `Emulation.setDeviceMetricsOverride` on the same CDP session used for the
  screenshot. Keep the width and height at the composition format and set
  `deviceScaleFactor` to the capture scale.
- For even delivery dimensions, pass a `clip` in CSS pixels:
  `width: captureWidth / scale`, `height: captureHeight / scale`, `scale: 1`.
- `window.devicePixelRatio` equals the capture scale, so
  `@media (max-resolution: 0.75dppx)` matches a 0.5 capture while
  `@media (max-width: ...)` still sees the authored viewport. Use the resolution
  query to assert capture density and the width query for layout changes.
- See [ADR-0029](adr/0029-capture-renders-at-the-scaled-source-format.md) for
  the capture-scale contract and its alternatives.

## Verification

For preview-only UI changes, run `pnpm check:preview`. It runs the static checks
and then builds before running `test/preview-runtime.test.ts`,
`test/timeline-preview.test.ts`, and `test/timeline-preview-runtime.test.ts`.
Use the full `pnpm check` when the change reaches shared contracts, the runtime,
the renderer, or the CLI, and before pushing or publishing.

## Notes

- Timeline layer iframes pin `color-scheme: light` on both the iframe element
  and the embedded document root to match the production capture context.
  The iframe element's `color-scheme` does not reach the embedded document, so a
  composition that declares a dark scheme would otherwise paint an opaque canvas
  base and hide every layer beneath it.
- A running `dev` server keeps the `dist/` modules it loaded. Restart it after
  `pnpm build`.
- The timeline preview host is not the production compositor; compare pixels at
  the capture boundary, not encoded output.
