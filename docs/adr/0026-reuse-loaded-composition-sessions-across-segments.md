# Reuse loaded composition sessions across segments

**Status:** Accepted. Extends [ADR-0025](./0025-capture-timeline-layers-in-parallel-with-a-global-limit.md). Extended by [ADR-0027](./0027-encode-two-full-frame-layers-through-dual-pipes.md): two full-frame layers encode through dual image pipes.
**Date:** 2026-11-06

The timeline renderer keeps a bounded pool of loaded composition sessions and
leases them to segment captures. A session is keyed by composition entry, props,
and transparent-background mode, and is reused across segments and clips that
share those inputs. Sessions are discarded on a capture error and all sessions
are closed when the render ends.

## Context

Every composition layer of every segment opened a new Chromium browser, loaded
the composition, waited for `networkidle` (roughly 450 ms), and closed it. The
one-layer 60-minute gate opened 360 sessions; a two-layer workload opens 720.
The 10-minute one-layer gate without a pool took 211.8 s, and its session stage
was a repeated fixed cost rather than frame work.

The host already has the right reuse semantics: `load` restores the pristine DOM
and mounts the controller once, while `seek` is required to be stateless. A
loaded session with the same props can seek to any frame of any segment.

## Decision

- `CompositionSessionPool` stores idle sessions in a map keyed by
  `entry + props + transparentBackground`.
- `maxIdle` is `max(2, workers)`. Active sessions are already bounded by the
  capture semaphore; the idle cap bounds memory for workloads with many unique
  compositions.
- `captureCompositionFrames` leases a session instead of opening one directly.
  A successful capture releases the lease; a capture, diagnostics, or encoder
  error discards it.
- Nested timelines share the render's pool. Static compositions keep their
  one-shot capture and cache because they are captured once per props variant.
- The render closes the pool before the preview server in its cleanup path.
- The session timing event records `reused: true` when the lease came from the
  pool.

## Considered Options

- **Remove `networkidle` only.** Rejected as the primary change: it removes a
  fixed wait but does not avoid browser launch, navigation, and host load. It
  also weakens the asset-loading boundary for compositions with stylesheet
  background images. Session reuse amortizes the whole startup cost instead.
- **Share one browser process without reusing pages.** Rejected: it saves the
  browser launch but still pays navigation, host load, and `networkidle` per
  segment.
- **Per-worker pools.** Rejected: a shared pool lets any worker reuse an idle
  session and keeps the idle budget independent of worker count.
- **Unbounded idle caching.** Rejected: compositions with many unique props or
  entries could retain an unbounded number of pages and media elements.

## Consequences

- The 10-minute one-layer gate fell from 211.8 s to 192.6 s (−9.0%) with the
  same 8 workers and byte-identical output. The full 60-minute gate fell from
  19.83 to 18.78 minutes (−5.3%) and opened eight sessions for 360 segments
  instead of 360 sessions. Its output is byte-identical to the baseline.
- The two-layer 60-second gate did not show a clear gain (43.78 s to 45.43 s):
  six segments are too few for reuse to pay back the pool's initial opens. The
  long-form workload is the target.
- Reused sessions return accumulated diagnostics; the final merge continues to
  deduplicate them. A page error discards the session so a broken render cannot
  poison later segments.
- The pool is internal to a render. There is no public CLI or JSON contract
  change.
- Tests cover same-key reuse, discard, idle-budget eviction, close, and the
  existing timeline suite with embedded media, controllers, blends, keyframes,
  transitions, and nested timelines.
