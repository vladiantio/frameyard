# Preview testing

The preview runs the production composition and timeline hosts in a browser. Use
the embedded hosts for deterministic Playwright probes; they are same-origin and
expose the same seek/settle contract the renderer uses.

## Composition preview

- Page: `/__frameyard/?composition=<id>`.
- Stage: the `#stage-frame` iframe.
- API: `window.__frameyardPreview` exposes `load(entry, props?)`, `seek(frame)`,
  `settle()`, and `dispose()`.
- `seek()` is synchronous. Call `await settle()` before reading pixels; `load()`
  resets the host, so apply props through it.
- A static composition reports `metadata: { width, height, static: true }`.
  `seek()` is a no-op, `settle()` resolves, and the page disables the transport.
  Wait for the static composition's own marker instead of `waitForFrame()`,
  which expects a controller-updated `#box`.

## Timeline preview

- Page: `/__frameyard/timeline/<id>`; add `?__fy-embed=1` for the embedded host.
- API: `window.__fyTimeline` exposes `ready`, `format`, `durationInFrames`,
  `load()`, `seek(frame)`, `settle()`, and `dispose()`.
- Order: `await ready`, `await load()`, `await seek(frame)`, `await settle()`.
- The non-embedded page owns transport and audio; only the embedded host exposes
  `window.__fyTimeline`.
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
