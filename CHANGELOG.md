# Changelog

All notable changes to Frameyard are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Frameyard uses `0.x` versions until the composition, configuration, CLI,
JSON-result, transcript, and skill contracts stabilize. Before `1.0.0`, a
contract change may ship in a minor release and is called out explicitly below.

## [0.3.0] - 2026-10-30

### Added

- Frame-accurate embedded video: local `<video>` elements are preloaded, paused,
  and seeked from the composition frame, with `data-frameyard-start`,
  `data-frameyard-trim`, `data-frameyard-duration`, and
  `data-frameyard-volume` attributes.
- Automatic mixing of unmuted embedded-video audio into the offline FFmpeg
  timeline, mirrored in preview. `muted` or `data-frameyard-audio="off"` keeps a
  video visual-only.
- Deterministic WebGL capture for WebGL 1 and WebGL 2 canvases. Production
  sessions pin SwiftShader so pixels do not vary with the host GPU.
- Media-settle step between `seek()` and capture for embedded video decode and
  browser paint.
- Optional parallel frame capture with `render --concurrency <n>` (1-16).
  Independent browser sessions seek and capture assigned frames while one
  ordered writer feeds a single FFmpeg encoder. Sequential rendering remains the
  default.
- `render --json` reports the effective `concurrency`.
- `MEDIA_INVALID` and `MEDIA_SEEK_FAILED` error codes for embedded-media
  validation and seek failures.

### Changed

- CI and the release workflow share `pnpm check`, and `pnpm verify-release`
  preflights the tag, version locations, changelog, branch, and working tree
  before a release is pushed.

[0.3.0]: https://github.com/vladiantio/frameyard/compare/v0.2.0...v0.3.0

## [0.2.0] - 2026-10-29

### Added

- `init` scaffolds an `AGENTS.md` project guide with the determinism rules and
  the `check`, `still`, and `render` workflow for coding agents.
- `init` scaffolds a private `package.json` whose `dev`, `check`, `render`, and
  `still` scripts pin the scaffolding CLI version, so `pnpm dev` and
  `npm run dev` work without a global install. Project names are normalized to
  valid npm package names.
- `init --json` reports the additional scaffold files.

### Changed

- **Skill contract:** the official agent skill moved from `skill/` to
  `skills/frameyard/` so agent hosts discover it automatically. The npm package
  ships `skills/` instead of `skill/`. Update copied or linked installations
  from the old path.
- User-facing documentation, CLI help, and generated project guides use
  `npx frameyard`; scaffolded scripts pin `npx --yes frameyard@<version>`.
- Development tooling moved to `oxlint` and `oxfmt`, with pre-commit hooks and
  matching CI and release workflow checks.

### Fixed

- Corrected documentation links and command examples after the skill relocation,
  and enforced the `npx frameyard` convention in `test/docs.test.ts`.

[0.2.0]: https://github.com/vladiantio/frameyard/compare/v0.1.0...v0.2.0

## [0.1.0] - 2026-10-28

### Added

- Native JavaScript composition contract with fixed `width`, `height`, `fps`,
  and `durationInFrames`, JSON props, and synchronous seek-safe `update()`.
- Browser runtime with deterministic frame time, keyed `random()`, CSS and Web
  Animations seeking, and preview diagnostics for non-deterministic clocks,
  randomness, and CSS transitions.
- Interactive preview with composition selection, prop editing, frame
  scrubbing, playback, and audio synchronization.
- CLI commands: `init`, `dev`, `check`, `still`, `render`, `tts`, `transcribe`,
  and `doctor`, with `--json` result envelopes and stable error codes.
- Deterministic Chromium capture through Playwright and FFmpeg H.264/AAC
  encoding, with atomic output publication and explicit overwrite flags.
- Audio clips placed on composition frames with source trimming in seconds and
  an offline FFmpeg mix.
- Canonical transcript validation, measured word timings, and SRT/VTT
  formatting, including transcript requirements attached to compositions.
- Local `qwen-tts` speech synthesis and `whisper-cli` transcription wrappers
  with executable resolution, atomic publishing, and a versioned provenance
  manifest.
- `frameyard doctor` environment, integration, and manifest inspection without
  downloading, repairing, or modifying anything.
- Host-neutral agent skill under `skill/`, versioned with the npm package API.
- 30-second reference composition, deterministic render benchmark, public-seam
  test suite, design baseline, and architecture decision records.

[0.1.0]: https://github.com/vladiantio/frameyard/releases/tag/v0.1.0
