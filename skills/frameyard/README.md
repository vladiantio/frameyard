# Frameyard agent skill

This directory is the optional, host-neutral Frameyard agent skill. Its API version matches the npm package version. The npm package includes this directory.

## Install or reference

Install from the repository with the open agent-skills CLI:

```sh
npx skills add vladiantio/frameyard
```

The skill lives at `skills/frameyard` in the repository and npm package. Alternatively, copy or symlink the whole `skills/frameyard/` directory into the skill location your agent host uses. Examples:

- Claude Code project skills: `.claude/skills/frameyard`
- Agent hosts that read `.agents/skills`: `.agents/skills/frameyard`
- Global installations: place it under your host's documented personal skills directory

The skill is host-neutral: it uses only the normal `frameyard` project format and CLI. There is no agent-only runtime.

Run the CLI with `npx frameyard`. It resolves the latest published version; pin it with `npx frameyard@<version>` or install the package locally when the CLI version must match the skill. When the skill is copied outside the npm package, `scripts/frameyard.mjs` falls back to the `frameyard` command on `PATH`; if that command is unavailable, set `FRAMEYARD_CLI` to an installed CLI path.

## Contents

- `SKILL.md`: trigger description and operating workflow
- `references/deterministic-authoring.md`
- `references/bindings.md`
- `references/controllers.md`
- `references/diagnostics.md`
- `references/common-mistakes.md`
- `references/audio-assets.md`
- `references/subtitles-karaoke.md`
- `references/json-results.md`
- `references/failure-recovery.md`
- `scripts/frameyard.mjs`: thin fallback wrapper for the installed CLI

## Version matching

`SKILL.md` records `frameyard-api-version`. If `npx frameyard --version` reports a different version, pin the CLI (`npx frameyard@<version>`) to the skill version, or use the skill files shipped inside the installed package. Contract changes are documented in the repository README and design baseline.
