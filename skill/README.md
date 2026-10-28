# Frameyard agent skill

This directory is the optional, host-neutral Frameyard agent skill. Its API version matches the npm package version. The npm package includes this directory.

## Install or reference

Copy or symlink the whole `skill/` directory into the skill location your agent host uses. Examples:

- Claude Code project skills: `.claude/skills/frameyard`
- Agent hosts that read `.agents/skills`: `.agents/skills/frameyard`
- Global installations: place it under your host's documented personal skills directory

The skill is host-neutral: it uses only the normal `frameyard` project format and CLI. There is no installer command and no agent-only runtime.

When the skill is copied outside the npm package, `scripts/frameyard.mjs` uses the `frameyard` command on `PATH`. If that command is unavailable, set `FRAMEYARD_CLI` to the installed `dist/cli.js` path.

## Contents

- `SKILL.md`: trigger description and operating workflow
- `references/deterministic-authoring.md`
- `references/audio-assets.md`
- `references/subtitles-karaoke.md`
- `references/json-results.md`
- `references/failure-recovery.md`
- `scripts/frameyard.mjs`: thin fallback wrapper for the installed CLI

## Version matching

`SKILL.md` records `frameyard-api-version`. If it does not match the installed package's version, use the skill files shipped inside that package. Contract changes are documented in the repository README and design baseline.
