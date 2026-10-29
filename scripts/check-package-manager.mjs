#!/usr/bin/env node

const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error(
    "frameyard: this repository uses pnpm. Run `corepack enable && pnpm install` " +
      "(or `pnpm publish`) instead of npm.",
  );
  process.exit(1);
}
