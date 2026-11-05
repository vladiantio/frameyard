# Optional local-model scaffold

Install these files into a workspace when a local model and Frameyard share the
same machine. They are not active in this repository by default.

```sh
npx frameyard add local-models
```

For a new project, install the normal scaffold and the host setup together:

```sh
npx frameyard init my-project --local-models
```

Manual copy is still possible:

```sh
mkdir -p .opencode .pi
cp -R scaffolds/local-models/opencode/. .opencode/
cp -R scaffolds/local-models/pi/. .pi/
cp scaffolds/local-models/frameyard.policy.json .
```

The CLI refuses to overwrite an existing file. If the target workspace already
has an `.opencode/opencode.jsonc` or `.pi/` configuration, merge the scaffold
instead of copying over it.

## What each file does

- `frameyard.policy.json`: the `authoring` tier and `shared-cpu` profile. It
  blocks `tts`, `transcribe`, and `render`; allows `lint`, `context`, `doctor`,
  `add`, `inspect`, `compare`, `font search`, `font list`, `font verify`,
  `font add` without `--force`, `check`, and at most four still frames; and
  denies `--force`/`--overwrite`, `font remove`, and an unlicensed `font add
  --url`. Adjust the tier or profile for the machine. Remove the file to return
  to the default `full` tier.
- `.opencode/opencode.jsonc`: project-local OpenCode permissions for a local
  model session. It denies the common heavy shell forms and protects
  `frameyard.policy.json`, `.opencode/`, `.pi/`, and `skills/frameyard/` from
  edits. It also adds `./skills` as a skill search path, which assumes the
  official skill lives in the workspace; remove that line if it does not.
- `.pi/settings.json`: points Pi at `http://127.0.0.1:9931` and defaults to
  `LFM3-1.7B-Q8_0`, with only `read`, `bash`, `edit`, and `write` enabled.
- `.pi/APPEND_SYSTEM.md`: the local-model workflow: `context` → `lint` →
  `still` → `check` → handoff with `--dry-run`.
- `.pi/sandbox.json`: committed but `enabled: false`. Enable it only after
  testing Chromium, FFmpeg, and the local router with the filesystem/network
  rules you need.

## Human overrides

The policy is a guardrail, not a security boundary. A human who intends to run
a heavy operation can override it:

```sh
FRAMEYARD_POLICY=full npx frameyard render main --props props/main.json
```

The generated example READMEs in this repository use that prefix because they
may be run with the scaffold installed.

## Pi project trust

Pi loads `.pi/` only for trusted projects. Either start Pi with:

```sh
pi --approve
```

or add the project to `~/.pi/agent/trust.json` once. The trust entry is the only
global change; the rest stays in the workspace.

## Opting out

Remove `frameyard.policy.json` and the `.opencode/`/`.pi/` files you copied.
The CLI then defaults to `full`, and the host configuration no longer applies.
