# Capture timeline layers in parallel with a global limit

**Status:** Accepted. Extends [ADR-0024](./0024-stream-composition-captures-and-skip-trivial-composites.md). Extended by [ADR-0026](./0026-reuse-loaded-composition-sessions-across-segments.md): loaded sessions are reused across segments.
**Date:** 2026-11-06

Segments with more than one visual layer now capture their composition and
static-image layers concurrently. A FIFO semaphore bounds active capture
sessions across the whole render, independent of the segment worker count. The
layer results are reordered before compositing so track order and output pixels
are unchanged.

## Context

The segmented renderer processed `segment.layers` sequentially. A two-layer
60-second gate with streaming FFV1 took 59.60 s: the segment time was the sum of
both captures plus the composite. The same one-layer workload took 43.27 s
before the direct fast path, and 27.64 s after it. The layer captures are
independent, so the serial loop was leaving the second composition idle while
the first encoded.

An unbounded `Promise.all` is not safe: eight workers with three layers could
open twenty-four Chromium sessions and run twenty-four concurrent FFV1
encoders. The segment worker count already bounds the final segment encoders,
but it does not bound capture sessions.

## Decision

- `createSemaphore(limit)` provides a FIFO capture limit.
- The default limit is `min(workers * 2, 12)`. `FRAMEYARD_CAPTURE_CONCURRENCY`
  overrides it for local A/B measurements.
- Every composition and static-composition capture takes a slot for the whole
  session and encoder lifetime. Nested timelines do not hold an outer slot;
  their inner captures take slots from the same semaphore.
- A segment starts all layer tasks together and uses `Promise.allSettled`.
  It reorders successful results by layer index before compositing and throws
  the first failure after every task has settled, so no capture is left writing
  into scratch after the segment fails.
- The direct one-layer segment path is unchanged; it takes one slot.

## Considered Options

- **Keep the sequential layer loop.** Rejected: it serializes independent
  captures and leaves CPU idle during FFV1.
- **Use unbounded `Promise.all`.** Rejected: capture sessions multiply with
  workers and layers, causing memory and encoder oversubscription.
- **Limit only per segment.** Rejected: a per-segment limit still multiplies by
  the worker count, so eight workers with two layers would open sixteen
  sessions.
- **Reuse sessions instead.** Deferred for this change: a pool removes session
  startup but does not shorten the critical path of a multi-layer segment. ADR
  0026 adds the pool as a separate optimization.

## Consequences

- The two-layer 60-second gate fell from 59.60 s to 43.78 s (−26.5%) with four
  workers; the output is byte-identical to the sequential run.
- The one-layer 60-minute gate is unaffected because every segment uses the
  direct path.
- Peak capture sessions are bounded at 12, including eight-worker renders with
  multi-layer segments.
- Captures that share a static-composition cache key still wait for one slot
  each; the capture itself is deduplicated by the existing promise cache.
- A failed layer task settles its siblings before the segment throws; the
  scratch directory is then cleaned by the render's existing failure path.
- The full timeline rendering suite passes with parallel captures, including
  transparent compositions, blends, keyframes, transitions, nested timelines,
  and static layers.
