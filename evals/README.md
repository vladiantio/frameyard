# Local model evals

An opt-in harness for measuring how local models author Frameyard projects. It is
not part of `pnpm check` and it never renders a video.

## Prerequisites

- `pnpm build` so `dist/cli.js` is current.
- A llama.cpp router with an OpenAI-compatible API, by default
  `http://127.0.0.1:9931`.
- The models named in the run must appear in `/v1/models`. A model that is
  listed but cannot load is reported as a task error; check the router preset
  and `llama-server` logs.

## Run

Start with one small model and one task:

```sh
pnpm eval:local --model Qwen3.5-2B-Q8_0 --only static-poster --lint-only
```

The default temperature is 0 for comparable runs. Small models can still vary;
record the temperature with the report and prefer `--temperature 0` when
comparing models.

Then run the full matrix:

```sh
pnpm eval:local --json --out out/evals/local-models.json
```

Use `--models <a,b>` or repeat `--model <id>`. The default models are
`LFM3-1.7B-Q8_0`, `Qwen3.5-4B-UD-Q4_K_XL`, and
`Qwen3.6-35B-A3B-MTP-UD-IQ2_XXS`. The 35B model is slow on CPU; filter it while
iterating.

## What it measures

The harness writes each task's seed project to a temporary directory, asks the
model for complete files as one JSON object, applies them, and then runs:

1. `frameyard lint <target> --json`
2. `frameyard check <target> --json` unless `--lint-only`
3. `frameyard still <target> --frame <n> --json`
4. `frameyard inspect <still> --json`

A task passes when lint has no errors and no warnings beyond the task budget,
check passes, the still exists, and inspect reports non-blank content. A failed
lint is fed back for up to `--repairs` turns.

The report includes first-pass status, repair turns, token usage, wall time,
sampled server CPU time, peak RSS, and GPU utilization/memory when `nvidia-smi`
is available. The server PID is auto-detected from `llama-server` or set with
`--server-pid`. Resource sampling reads `/proc` on Linux; other platforms report
`available: false`.

The harness runs CLI commands with `FRAMEYARD_POLICY=authoring`, so `lint`,
`check`, and one still are allowed and `render` stays blocked. It never invokes
`tts`, `transcribe`, or `render`.

## Tasks

- `static-poster`: add a static composition and register it.
- `title-card`: add a 60-frame animated title with CSS animation.
- `lower-third`: add a transparent 60-frame lower third with bindings.
- `timeline-assembly`: add a two-clip timeline with a dissolve.
- `keyframes`: add clip-local `x` and `opacity` keyframes.
- `static-in-timeline`: place a static composition clip with an explicit duration.
- `fix-binding`: fix a `data-fy-text` typo without leaving a warning.
- `fix-timeline`: fix an out-of-range keyframe without extending the clip.

The system prompt includes `skills/frameyard/references/quick-reference.md`, so
the eval exercises the same compact guidance a local agent would receive.

## Options

Run `node evals/runner.mjs --help` for the full list. Useful flags:

- `--only <a,b>`: filter tasks.
- `--repairs <n>`: repair turns after the first answer (default 2).
- `--lint-only`: skip check, still, and inspect for a fast loop.
- `--keep`: keep temporary projects and print their paths.
- `--max-rss-mb`, `--max-cpu-ms`, `--max-gpu-percent`: report `budget.within`.
- `--fail-on-task`: exit 1 when any task fails; infrastructure errors always exit 1.
- `--self-check`: validate task definitions without a server.

The harness is a measurement tool. Passing it is evidence about authoring, not
a reproducibility guarantee for encoded output.
