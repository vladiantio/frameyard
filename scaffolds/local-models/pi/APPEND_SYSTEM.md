# Frameyard resource policy

This workspace uses `frameyard.policy.json` at the repository root. Do not edit that
file, `.pi/`, `.opencode/`, or `skills/frameyard/`.

## Working loop

1. Run `frameyard lint <id> --json` while editing.
2. Inspect at most four representative stills with `frameyard still <id> --frame <spec> --json`.
3. Run `frameyard check <id> --json` once at the end when the active policy allows it.
4. Do not run `frameyard tts`, `frameyard transcribe`, or `frameyard render` unless the
   user explicitly asks. Use `--dry-run` and report `deferred: true` with the exact
   handoff command instead.
5. Read `AGENTS.md` and `skills/frameyard/SKILL.md` before changing public behavior.

The local llama.cpp router is at `http://127.0.0.1:9931`. Use a small text model for
the lint loop and a vision-capable model only for representative stills. Do not
switch to a larger local model just to re-read the same files.
