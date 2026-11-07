# Capture bounded multi-frame stills for inspection

**Status:** Accepted
**Date:** 2026-11-01

> **Amendment (2026-11-07):** `render --sequence` is now the production
> image-sequence path. This ADR's cap and non-goal apply to `still`; `still`
> remains a bounded inspection tool.

`still` will accept a bounded set of frames in one invocation. `--frame` becomes a spec: a frame number (`42`), an inclusive range (`2-12`), or a comma-separated list (`0,118-126,240`). Ranges are only shorthand for lists. Duplicates are removed preserving the first occurrence, order is preserved, and a single invocation captures at most 32 unique frames. There is no step, start/end flag, fps flag, output pattern, or general image-sequence mode. With one frame, `--out` remains a `.png` file. With multiple frames, `--out` is a directory and the files are named `still-<id>-<frame>.png`; when `--out` is omitted the current working directory is used.

The batch uses one preview server and one composition session with sequential seeks. Timeline stills resolve the timeline once, start one server, reuse one scratch directory, and call the existing frame composite path for each requested frame. All frames are validated against the target duration and all output paths are checked for conflicts before Chromium starts. Capture is all-or-nothing at the capture boundary: every frame is captured to a temporary file first, and only after all captures succeed are the files published. Publication is atomic per file. A disk or I/O failure during publication can leave a prefix of already-published files; strict batch atomicity is not promised.

JSON results always add `frames: [{ frame, path }]`, including for a single frame. `frame` and `path` remain only when exactly one frame was captured. `diagnostics`, `width`, `height`, and `elapsedMs` stay shared at the top level; diagnostics are merged and deduplicated, and timing is for the whole invocation. Grammar and cap failures are `USAGE`; out-of-range frames are `FRAME_OUT_OF_RANGE` with all invalid frames and the valid range; output conflicts are `OUTPUT_EXISTS` with every conflicting path; capture failures keep their underlying code and add the attempted frames and the failing frame. The preflight order is parse/expand, cap, bounds, output conflicts, then Chromium.

## Context

Agents and humans inspect several representative frames when validating motion, easing, transitions, video seeking, and visual regressions. The previous `still` contract captured exactly one frame per invocation, so inspecting a short animation required one command per frame or an external loop. That multiplied tool calls, repeated static validation, preview-server startup, and Chromium startup, and fragmented the structured diagnostics across several JSON envelopes. The agent skill already asked for several representative frames, so the CLI fought the documented workflow.

At the same time, general image-sequence output is a documented non-goal. The boundary is scale and intent, not syntax: a list or short range for inspection is useful, while exporting an arbitrary sequence should use a video render or a separate downstream tool.

## Considered Options

- **Keep one frame per invocation.** Rejected: simple, but every inspection of motion pays one process, server, and browser per frame and forces the agent to loop or make several calls.
- **Allow unbounded batch capture or a `--step`/`--fps` sequence.** Rejected: this turns `still` into an image-sequence exporter and makes it easy to generate hundreds of files and unreadable inspection workloads. A hard cap keeps the feature in the debugging-artifact category.
- **Capture a contact sheet (one PNG grid).** Rejected for now: one image is cheaper to inspect, but it loses per-frame resolution and adds layout and compositing decisions that are not part of the rendering contract.
- **Open a fresh session per frame.** Rejected: slower, and it hides state or media-seek bugs that production sequential seeking would expose. One session also makes batch pixels comparable to single-frame captures, which the tests assert.
- **Add a separate `--frames` flag or a `stills` command.** Rejected: it duplicates the concept and forces callers to choose a tool based on frame count. Extending `--frame` keeps one grammar and one command.
- **Strict batch atomicity with a staging directory and a directory rename.** Rejected: it requires a new output-directory protocol and cannot restore files already replaced under `--overwrite` without a swap. Capture-level all-or-nothing plus per-file atomic publication covers the realistic failure mode for an inspection tool.

## Consequences

- `still` remains a debugging artifact. The cap is per invocation; repeated invocations can still produce more files, but the CLI does not advertise or support image-sequence export.
- Single-frame output paths, PNG bytes, human output, and the existing JSON fields are unchanged; `frames` is additive. Multi-frame results omit the singular `frame` and `path`.
- A failed batch publishes no files and removes temporary files. If the CLI created the output directory, it removes the empty directory on failure. Existing directories are left in place.
- Output naming is one rule everywhere: `still-<id>-<frame>.png` without zero-padding. Composition and timeline IDs are already valid filename components.
- The cap, range grammar, output rules, and publication caveat are documented in the design baseline, README, CLI help, glossary, and official skill. Tests cover grammar, dedupe, order, cap boundaries, bounds, conflicts, output modes, all-or-nothing failure, batch-versus-single pixels for compositions and timelines, embedded video, and WebGL.
