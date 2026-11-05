# Quick reference

Use this page when context is limited or when you need one canonical skeleton.
Read a topic reference only when the task needs it; the full contract is in
`SKILL.md` and the linked references.

## Choose the smallest authoring level

1. **Static composition** for a poster, card, or thumbnail: no `duration-in-frames`, no `fps`, renders to PNG.
2. **CSS animation** for timed reveals, wipes, and simple motion: `@keyframes` plus `data-fy-anim-*`.
3. **Bindings** for props-driven text, attributes, classes, conditionals, and repeats.
4. **Controller** for Canvas 2D, WebGL, karaoke, or per-frame math CSS cannot express.
5. **Timeline** when several compositions, media clips, or audio tracks must share one deliverable.

Do not use a controller when CSS or bindings are enough.

## Animated composition

A composition is a partial HTML fragment, never a full document. Props, the
controller, import maps, and styles are top-level siblings of the root.

```html
<script type="application/json" data-fy="props">{ "title": "Hello" }</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; }
  @keyframes rise { from { opacity: 0; } to { opacity: 1; } }
  h1 { animation: rise 1s linear both; font: 8vmin system-ui; color: white; }
  body { background: #101820; display: grid; place-items: center; }
</style>
<fy-composition duration-in-frames="150">
  <h1 data-fy-text="title" data-fy-anim-start="0" data-fy-anim-duration="30"></h1>
</fy-composition>
```

`width`, `height`, and `fps` are optional and inherit the project `format`.
Declare both `width` and `height` together. Never derive metadata from props.

## Static composition

```html
<script type="application/json" data-fy="props">{ "title": "Poster" }</script>
<style>
  body { margin: 0; background: #0c1220; color: #ff7a45; display: grid; place-items: center; }
  h1 { font: 8vmin system-ui; }
</style>
<fy-composition>
  <h1 data-fy-text="title"></h1>
</fy-composition>
```

A static composition has no frame clock: no `data-fy-anim-*`, no `<video>`,
`<audio>`, or `<fy-transcript>`. Its controller runs `mount()` only.

## Fonts

Vendor a local `.woff2`/`.woff`/`.ttf`/`.otf` file; do not rely on a remote
Google Fonts link for a deterministic render.

```sh
npx frameyard font add --file ./fonts/SpaceGrotesk.woff2 \
  --family "Space Grotesk" --weight 300-700 --subset latin \
  --license OFL-1.1 --license-file ./fonts/OFL.txt
```

Then use the family name normally:

```css
h1 { font-family: "Space Grotesk", system-ui, sans-serif; font-weight: 700; }
```

The server injects `@font-face` before author styles, uses `font-display: block`,
and the host waits for `document.fonts.ready`. Run `font verify` after moving
files. Remote font URLs produce `FONT_REMOTE`; a used face that fails to load
produces `FONT_LOAD_FAILED`. See [fonts](fonts.md).

## Timeline

```json
{
  "version": 1,
  "tracks": [
    { "id": "v1", "kind": "video" },
    { "id": "a1", "kind": "audio" }
  ],
  "clips": [
    {
      "id": "intro",
      "track": "v1",
      "source": { "kind": "composition", "id": "intro" },
      "start": 0
    },
    {
      "id": "music",
      "track": "a1",
      "source": { "kind": "audio", "src": "assets/music.wav" },
      "start": 0,
      "duration": 150,
      "audio": { "gain": 0.6 }
    }
  ]
}
```

`start`, `sourceIn`, and `duration` are timeline frames. Image clips and static
composition clips require an explicit `duration`; a static composition clip
needs `sourceIn: 0` and contributes no audio. Source kinds are `composition`,
`timeline`, `video`, `image`, and `audio`.

## Bindings

- `data-fy-text="path"` sets text.
- `data-fy-attr-src="path"` sets an attribute.
- `data-fy-class-active="path"` toggles a class.
- `data-fy-if="path"` removes the element when false.
- `<template data-fy-repeat="items">` clones content; use `item` and `index`.
- Paths are dot-separated; missing paths warn and resolve empty.

Bindings apply once per load, before `mount()`. Controller-created DOM is not
re-bound.

## Controller

```html
<script type="text/fy-controller">
export default {
  mount({ root, props }) {},
  update({ frame, props }) {},
  dispose() {},
};
</script>
```

Exactly one controller is allowed, inline or external. `mount` may be async;
`update` is synchronous and seek-safe. The controller is the only executable
code. Use `random("stable:key")` from `frameyard/runtime`, never `Math.random()`.

## Commands

| Command | Use |
| --- | --- |
| `npx frameyard context --json` | One compact project digest: format, props, timelines, assets, policy, next commands |
| `npx frameyard lint <id> --json` | Fast edit loop: static validation, scene/keyframe projection, controller determinism |
| `npx frameyard check <id> --json` | Full gate: props hooks and every animated frame through Chromium |
| `npx frameyard still <id> --frame <spec> --json` | Inspect representative frames; policy caps the count |
| `npx frameyard inspect <image> --json` | Blank, alpha, colors, content bbox, luminance grid, edge density |
| `npx frameyard compare <a> <b> --json` | Pixel and 3×3 region diff; exits 1 when different |
| `npx frameyard render <id> --dry-run --json` | Handoff plan without Chromium, FFmpeg, or a model |
| `npx frameyard render <id> --json` | Produce the video when the policy allows it |
| `npx frameyard add --list --json` | List project templates |
| `npx frameyard add composition <id> --template <name> --json` | Write a valid fragment and print the config snippet |
| `npx frameyard font add --file <path> --family <name> --json` | Vendor a local font into `assets/fonts/` and update `frameyard.fonts.json` |
| `npx frameyard font list --json` | Installed families, subsets, licenses, files, and status |
| `npx frameyard font verify --json` | Manifest paths, hashes, licenses, and orphaned directories |
| `npx frameyard font remove <id> --json` | Remove a font and its directory; `--keep-files` keeps the binaries |
| `npx frameyard doctor --json` | Environment, integrations, policy, fonts, and resources |

Every non-interactive command accepts `--json`. Parse stdout; read stderr for
progress and diagnostics.

## Resource policy

`frameyard.policy.json` is discovered from the working directory upward,
independent of `video.config.js`.

| Tier | `still` | `check` | `tts`/`transcribe`/`render` | overwrite |
| --- | --- | --- | --- | --- |
| `light` | 1 frame | blocked | blocked | denied |
| `authoring` | 4 frames | low priority | blocked | denied |
| `full` | 32 frames | allowed | allowed | allowed |

`lint`, `context`, `doctor`, `add`, `inspect`, `compare`, and `--dry-run` are
available in every tier. `font list` and `font verify` are available in every
tier; `font add` requires `authoring` or `full`; `font remove` and `font add
--force` require `full`. When a heavy command is blocked, run it with `--dry-run`, report `deferred: true`, and give the user
`commandLine`, `prerequisites`, and `blockers`.

## Ten diagnostics that matter

| Code | Fix |
| --- | --- |
| `COMPOSITION_DOCUMENT_SHELL` | Remove `<!doctype>`, `<html>`, `<head>`, and `<body>`; compositions are fragments |
| `COMPOSITION_FORMAT_UNRESOLVED` | Declare `width`/`height` or add project `format` |
| `COMPOSITION_INVALID` | Check the single `<fy-composition>` root and metadata |
| `CONTROLLER_INVALID` | Exactly one controller; inline XOR `src`; at least one export |
| `SCRIPT_NOT_ALLOWED` | Move executable code into the controller |
| `BINDING_PATH_MISSING` | Fix the props path; use the diagnostic suggestion |
| `BINDING_INVALID` | Unknown `data-fy-*` attribute; use a documented binding |
| `TIMELINE_CLIP_OUT_OF_RANGE` | Keyframes cannot extend a clip; lengthen the clip or move the key |
| `TIMELINE_CLIP_OVERLAP` | Declare a transition or move the clip |
| `RESOURCE_POLICY_BLOCKED` | Use `--dry-run`, or ask the user for `FRAMEYARD_POLICY=full` |

Font diagnostics: `FONT_HASH_MISMATCH` means the vendored file changed; restore
it or reinstall with `font add --force`. `FONT_LOAD_FAILED` means a used face
did not load; check the manifest and `font verify`. `FONT_REMOTE` is a warning
that the composition still depends on a remote font URL.

## Do not

- Use `Date.now()`, `performance.now()`, timers, `requestAnimationFrame` loops, or CSS transitions as animation inputs.
- Call `play()`, `pause()`, or set `currentTime` on embedded media.
- Fetch remote data from `update()`; load during `mount()`.
- Put visual content outside `<fy-composition>`.
- Edit `frameyard.policy.json`, host configuration, or the skill source.
- Claim success when `check` fails, a still is missing, or a render did not run.

## Next

- Full authoring rules: [deterministic authoring](deterministic-authoring.md)
- Fonts: [fonts](fonts.md)
- Timelines and keyframes: [timelines](timelines.md)
- Error codes: [diagnostics](diagnostics.md)
- Result shapes: [JSON results](json-results.md)
- Recovery loops: [failure recovery](failure-recovery.md)
