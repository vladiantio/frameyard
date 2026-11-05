# Pin fonts as project assets

**Status:** Accepted
**Date:** 2026-11-05

`frameyard.fonts.json` is a versioned project manifest of vendored font files.
Font files and their licenses live under `assets/fonts/<font-id>/`; the preview
server generates the `@font-face` sheet at `/__frameyard/fonts.css` and injects
it into every composition document before author styles. Fontsource is the
primary acquisition catalog; local files and pinned HTTPS URLs cover fonts that
are not in Fontsource. Fontshare, Google Fonts, and Bunny Fonts are not
providers in the first version.

## Context

Compositions already load fonts through ordinary local `@font-face` rules or a
local `<link rel="stylesheet">`. The preview server serves WOFF2/WOFF/TTF/OTF
with the correct media type, and the host awaits `document.fonts.ready` after
`mount()`. What is missing is a project-level model: there is no inventory, no
way for an agent to search or install a font, no license record, no hash, and no
verification that a captured frame used the intended font. Remote Google Fonts
links work during the loading phase but make a render depend on the network and
on a mutable third-party response.

Fonts are not an FFmpeg concern: text is rasterized in Chromium during
composition capture, and FFmpeg only composites the resulting images. The font
files therefore need to be deterministic inputs to the browser session, not
dependencies of the encoder.

## Considered Options

- **A project manifest with vendored files (chosen).** The CLI can update the
  manifest atomically, record file hashes and licenses, and the server can
  generate one stylesheet without scanning directories. The project remains
  portable and renderable offline.
- **Declare fonts in `video.config.js`.** Fewer files, but the CLI would need to
  edit JavaScript to add a font, and hashes and licenses still need a sidecar.
- **Depend on `@fontsource/*` packages in `node_modules`.** Familiar for web
  projects, but a Frameyard project is not necessarily an npm package, packages
  include every subset and weight, and resolution depends on a package manager
  and bundler.
- **Keep CSS-only fonts with no inventory.** Web-native, but gives the agent no
  discovery, validation, license, or reproducibility surface.

## Consequences

- `frameyard.fonts.json` has `version: 1` and a `fonts` array. Each family
  records its CSS family, provider, optional provider version, license, variable
  axes, and a non-empty `files` array. Each file records a project-relative path
  below `assets/fonts/<font-id>/`, subset, style, weight or weight range, format,
  optional unicode range, SHA-256, byte size, and optional upstream source.
  Unknown fields, duplicate ids, duplicate CSS family names, duplicate faces,
  paths outside the font directory, and invalid weights fail with
  `FONT_MANIFEST_INVALID`.
- Font files and license files are committed with the project. Replacing a font
  face or changing its provider requires `--force`; merging another subset,
  style, or weight into an existing family does not.
- `frameyard font add --file` vendors a local `.woff2`, `.woff`, `.ttf`, or
  `.otf` file with an explicit family, weight, style, optional subset, optional
  unicode range, and optional license. A missing license produces a warning.
  `font list`, `font verify`, and `font remove` manage the manifest;
  `font remove` deletes the font directory unless `--keep-files` is supplied.
- `font search` reads the Fontsource catalog and filters by query, category,
  subset, style, variable, and limit. `font add <id>` pins `npmVersion` from the
  Fontsource API, downloads only the requested subset/style/weight, downloads
  the package `LICENSE`, and records the exact CDN URL and SHA-256. The default
  is the variable `wght` face when the family has one; static faces require
  `--static` and a weight or weight list.
- HTTPS URL imports may include a pinned SHA-256. A URL import without a license
  is recorded as `unknown`, requires the `full` policy, and produces warnings in
  `list`, `verify`, and `doctor`. There is no shared font cache. Fontshare is
  not a provider: its Free Font License prohibits redistribution, subsetting,
  and format conversion for most of its catalog. Only OFL-licensed Fontshare
  files are safe to vendor, and they use the generic URL import.
- The server generates the font sheet on every request from the manifest and
  injects it after the host style and before author styles. Adding a font is
  visible in `dev` on the next request without restarting the server. The
  generated sheet uses `font-display: block` and one `@font-face` per manifest
  file.
- The host awaits `document.fonts.ready`, then fails the load with
  `FONT_LOAD_FAILED` if the browser reports a failed `FontFace`. Static
  validation warns with `FONT_REMOTE` once per remote URL found in inline CSS,
  local linked CSS, or a remote stylesheet link. Remote fonts remain compatible
  but are not deterministic.
- `check`, `still`, and `render` verify manifest file sizes and SHA-256 values
  before launching Chromium. `lint` verifies existence and size. `font verify`
  also checks licenses and orphaned font directories, and `doctor` reports
  manifest integrity. A changed file fails with `FONT_HASH_MISMATCH`.
- The policy operation is `font`. Search, list, and verify are allowed in every
  tier; `font add` requires `authoring` or `full`; `font remove` and
  `font add --force` require `full`.
- `context --json` reports installed families, provider, version, variable axes,
  subsets, styles, license, file count, bytes, and status. The agent skill gains
  a font reference; the scaffold continues to use `system-ui` and teaches
  `font add` instead of bundling a default font.
- Typography roles (`--fy-font-display`, `--fy-font-body`), font pairs, a
  preview font picker, and non-`wght` variable axes are out of scope for the
  first version.
