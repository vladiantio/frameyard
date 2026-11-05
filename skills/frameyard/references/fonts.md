# Fonts

Frameyard vendors font files into the project. A composition uses a font by its
CSS family name; the preview server injects the generated `@font-face` sheet
into every composition before author styles. There is no runtime font CDN
dependency.

## Search Fontsource

```sh
npx frameyard font search "space grotesk" --subset latin --json
npx frameyard font search --category sans-serif --variable --limit 10 --json
```

Filters are `--category`, `--subset`, `--style`, `--variable`, and `--limit`
(1–100). Search returns `id`, `family`, `category`, `variable`, `weights`,
`styles`, `subsets`, `license`, and `type`. Fontsource is the default catalog;
Google Fonts is covered through Fontsource and does not need a separate API key.

## Install a Fontsource family

```sh
npx frameyard font add space-grotesk --subset latin
```

The command fetches the family metadata, pins the Fontsource `npmVersion`,
downloads only the requested WOFF2 files, downloads the package `LICENSE`, and
records the exact CDN URL and SHA-256 in `frameyard.fonts.json`.

- A variable family installs the `wght` axis by default. Use multiple
  `--subset` and `--style` values, for example
  `--subset latin,latin-ext --style normal,italic`.
- `--static` installs static files. `--weight` accepts a comma-separated list,
  for example `--static --weight 400,700`.
- `--family` overrides the CSS family name when a project needs an alias.
- Fontsource supplies the license; do not pass `--license` for a Fontsource id.
- A variable family and a static install of the same family cannot be mixed
  without `--force`, which replaces the family record.

`FONT_PROVIDER_UNAVAILABLE` means the Fontsource API or CDN was unreachable.
`FONT_DOWNLOAD_FAILED` means a response was not a valid WOFF2 file.

## Install a local or URL font

```sh
npx frameyard font add --file ./fonts/SpaceGrotesk.woff2 \
  --family "Space Grotesk" --weight 300-700 --subset latin \
  --license OFL-1.1 --license-file ./fonts/OFL.txt
```

`--weight` is a number (`400`) or a variable range (`300-700`). `--style` is
`normal` or `italic`. `--subset`, `--unicode-range`, `--license`, and
`--license-file` are optional; a missing license is a warning. The command
copies the font and license under `assets/fonts/<id>/`, records the SHA-256 and
byte size, and prints the CSS family to use.

```sh
npx frameyard font add --url https://example.com/Inter.woff2 \
  --family "Inter" --license OFL-1.1 --license-file ./fonts/OFL.txt \
  --sha256 <hash>
```

`--url` requires HTTPS; loopback HTTP is allowed for local tests. `--sha256` is
optional but recommended: the computed hash is always recorded. A URL import
without `--license`/`--license-file` records `license: { "type": "unknown" }`,
warns in
`list`/`verify`/`doctor`, requires the `full` policy, and does not use a shared
cache. Do not point `--url` at a font whose license you cannot redistribute.

Fontsource is the primary catalog. Google Fonts is covered by Fontsource.
Bunny Fonts is not a vendoring source: its catalog is undocumented, it exposes
no license metadata, and its files are not frozen. Fontshare is not a provider:
its Free Font License prohibits redistribution, subsetting, and format
conversion for most of its catalog. Only OFL-licensed Fontshare files may be
vendored, through `font add --url`, with their license text and an explicit
decision by the user.

## Manage the manifest

```sh
npx frameyard font list --json
npx frameyard font verify --json
npx frameyard font remove space-grotesk --json
```

`font list` reports installed families, subset/style labels, license, file
count, bytes, and status. `font verify` checks paths, formats, byte sizes,
SHA-256 values, license files, and orphaned font directories. `font remove`
deletes the manifest entry and `assets/fonts/<id>/`; add `--keep-files` to leave
the binaries in place. `font remove`, `font add --force`, and an unlicensed
`--url` import require the `full` policy.

Adding another subset, style, or weight to the same family merges into the
existing entry. Adding the same face again fails with `OUTPUT_EXISTS`; pass
`--force` to replace it. `frameyard.fonts.json` has `version: 1` and one entry
per family. Commit it with `assets/fonts/` and the license files.

## Use the font

```css
.title {
  font-family: "Space Grotesk", system-ui, sans-serif;
  font-weight: 700;
}
```

The generated sheet uses `font-display: block`. The host waits for
`document.fonts.ready` after `mount()`, then fails with `FONT_LOAD_FAILED` if a
used face reports an error instead of silently capturing fallback text.
`check`, `still`, and `render` verify sizes and hashes before launching
Chromium; `lint` verifies existence and size. A changed file fails with
`FONT_HASH_MISMATCH`.

## Legacy fonts and remote URLs

Existing local `@font-face` rules and `<link rel="stylesheet">` elements keep
working. A remote font URL in inline CSS, linked local CSS, or a remote
stylesheet link produces a `FONT_REMOTE` warning. It may work during the loading
phase, but it is not reproducible and is not covered by the manifest.

## Agent workflow

1. Search Fontsource with `font search` or choose a local/URL source and verify
   its license.
2. Install with `font add`, preferring the variable face or the exact static
   weights the composition uses.
3. Use the returned family name in the composition CSS.
4. Run `font verify`, `context --json`, `lint`, and `still`.
5. Inspect the still when typography or line breaks change.

Do not download fonts from `update()` or `mount()`. Font acquisition is an
authoring operation, not frame production.
