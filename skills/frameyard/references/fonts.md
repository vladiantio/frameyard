# Fonts

Frameyard vendors font files into the project. A composition uses a font by its
CSS family name; the preview server injects the generated `@font-face` sheet
into every composition before author styles. There is no runtime font CDN
dependency.

## Install a local font

```sh
npx frameyard font add --file ./fonts/SpaceGrotesk.woff2 \
  --family "Space Grotesk" --id space-grotesk \
  --weight 300-700 --style normal --subset latin \
  --license OFL-1.1 --license-file ./fonts/OFL.txt
```

`--weight` accepts a number (`400`) or an inclusive variable range
(`300-700`). `--style` is `normal` or `italic`. `--subset`, `--unicode-range`,
`--license`, and `--license-file` are optional; a missing license is a warning.
The command copies the font and license under `assets/fonts/<id>/`, records the
SHA-256 and byte size in `frameyard.fonts.json`, and prints the CSS family to
use.

Adding another subset, style, or weight to the same family merges into the
existing entry. Adding the same face again fails with `OUTPUT_EXISTS`; pass
`--force` to replace it. `--force` is denied outside the `full` policy.

```sh
npx frameyard font list --json
npx frameyard font verify --json
npx frameyard font remove space-grotesk --json
```

`font list` reports the installed families, subset/style labels, license, file
count, bytes, and status. `font verify` checks paths, formats, byte sizes,
SHA-256 values, license files, and orphaned font directories. `font remove`
deletes the manifest entry and `assets/fonts/<id>/`; add `--keep-files` to leave
the binaries in place.

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

`frameyard.fonts.json` has `version: 1` and one entry per family. Commit it with
`assets/fonts/` and the license files. Each file entry records its project
relative path, subset, style, weight, format, optional unicode range, SHA-256,
and byte size. `check`, `still`, and `render` verify sizes and hashes before
launching Chromium; `lint` verifies existence and size. A changed file fails
with `FONT_HASH_MISMATCH`.

## Legacy fonts and remote URLs

Existing local `@font-face` rules and `<link rel="stylesheet">` elements keep
working. A remote font URL in inline CSS, linked local CSS, or a remote
stylesheet link produces a `FONT_REMOTE` warning. It may work during the loading
phase, but it is not reproducible and is not covered by the manifest.

## Agent workflow

1. Choose a family and check that its license allows redistribution.
2. Add the file with `font add --file`, or install the family from Fontsource
   once the acquisition command is available.
3. Use the family name in the composition CSS.
4. Run `font verify`, `context --json`, `lint`, and `still`.
5. Inspect the still when typography or line breaks change.

Do not download fonts from `update()` or `mount()`. Font acquisition is an
authoring operation, not frame production.
