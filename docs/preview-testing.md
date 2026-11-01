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

## Timeline preview

- Page: `/__frameyard/timeline/<id>`; add `?__fy-embed=1` for the embedded host.
- API: `window.__fyTimeline` exposes `ready`, `format`, `durationInFrames`,
  `load()`, `seek(frame)`, `settle()`, and `dispose()`.
- Order: `await ready`, `await load()`, `await seek(frame)`, `await settle()`.
- The non-embedded page owns transport and audio; only the embedded host exposes
  `window.__fyTimeline`.

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

## Notes

- A running `dev` server keeps the `dist/` modules it loaded. Restart it after
  `pnpm build`.
- The timeline preview host is not the production compositor; compare pixels at
  the capture boundary, not encoded output.
