# Gate heavy operations with a workspace resource policy

**Status:** Accepted
**Date:** 2026-11-05

`fy.policy.json` declares a workspace resource tier (`light`, `authoring`, or `full`), an optional `shared-cpu` profile, and stricter still/overwrite limits. The CLI reads the nearest file from the working directory upward, independent of `fy.config.js`; `FRAMEYARD_POLICY` replaces the file for a human override. `tts`, `transcribe`, and `render` are blocked outside `full`; `lint` and `--dry-run` provide a cheap authoring and handoff path. The policy is a guardrail for cooperative agents, not a security boundary.

## Context

Local models, browsers, and FFmpeg often share one CPU and GPU. An agent that runs every validation pass through Chromium, or starts a render while the model is loaded, makes the machine unusable for the human. The existing skill says to confirm inference and avoid heavy work, but an instruction is not enforceable: a local model can ignore it or invoke the CLI directly.

`check` evaluates every frame through Chromium and is the correctness gate, but it is too expensive for a tight edit loop. `still` is bounded but still launches Chromium. `tts` and `transcribe` load local models, and `render` runs Chromium plus FFmpeg with up to sixteen workers. These operations need different treatment.

The Frameyard repository itself has no `fy.config.js`, so a policy tied to the project root would not protect commands that target `examples/*` with `--project`. The policy therefore belongs to the workspace, not the render target.

## Considered Options

- **A workspace policy file with tiers and a shared profile (chosen).** One small JSON document controls operation gating, still limits, overwrite permission, worker caps, and process priority. It applies to direct CLI invocations, is visible in review, and does not require a host-specific integration.
- **Skill instructions only.** No new contract, but unenforceable against a model that ignores the skill or runs the binary directly.
- **A global user configuration.** Stronger against accidental edits, but it breaks the local-first project portability the agent workflows need.
- **A hosted control plane or MCP server.** Out of scope by design; it adds a second public surface for a problem the CLI can solve.
- **A daemon or job queue in v1.** It still consumes the same resources and adds state before the simple handoff is proven.

## Consequences

- The policy is discovered from `cwd` upward. `--project` does not change discovery. `FRAMEYARD_POLICY=light|authoring|full` replaces the file, including its profile and tightened limits.
- `light` allows `lint`, `context`, `doctor`, `init`, `dev`, and one still frame; it blocks `check`, `tts`, `transcribe`, and `render`. `authoring` allows four still frames and `check` at low priority; it blocks the three heavy operations. `full` allows everything up to the existing 32-frame still cap.
- A policy file can only tighten the tier: `maxStillFrames` cannot exceed the tier default, and `allowOverwrite` cannot become true outside `full`. Unknown fields, unsupported versions, and invalid values fail with `POLICY_INVALID`.
- `frameyard lint <id>` runs static validation, timeline resolution, scene and keyframe projection for every timeline frame, controller determinism scanning, and media metadata probing without Chromium. It does not run `validateProps` or evaluate composition runtime; `check` remains the full gate.
- `tts`, `transcribe`, and `render` accept `--dry-run`. They validate inputs and return `{ dryRun: true, plan, commandLine, prerequisites, blockers }` without creating output directories, writing the manifest, or launching Chromium, FFmpeg, or a model. The handoff command includes `FRAMEYARD_POLICY=full` when the active policy is not `full`.
- `--profile shared-cpu` caps timeline workers at two and composition concurrency at one, lowers process priority, and leaves the encoder at `auto`. Explicit values above the cap fail with `RESOURCE_PROFILE_CONFLICT`; they are never clamped silently.
- `authoring` and `light` deny `--overwrite` and `--force`. `still` frames above the limit fail with `RESOURCE_POLICY_LIMIT`.
- `os.setPriority` is best effort. Linux and macOS use the low nice value; Windows uses below-normal. Unsupported platforms continue without failing.
- The policy file is editable by the agent, so it is a guardrail. Host permissions and the CLI environment are the second layer; a hostile process with shell access can still bypass it.
- Tests target `test/policy.test.ts` for parsing, precedence, discovery, tier gates, and profile caps; `test/cli-render.test.ts` for blocked commands, dry-run plans, still limits, and process non-spawn; `test/docs.test.ts`, `test/skill.test.ts`, and `test/scaffold.test.ts` for the contract text.
