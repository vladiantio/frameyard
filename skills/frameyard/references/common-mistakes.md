# Common mistakes

## Using the old authoring model

- **JavaScript composition modules / `defineComposition`** were removed in 0.4. A composition is a `.html` fragment listed in `fy.config.js`.
- **`data-frameyard-*`** media attributes were removed in 0.4. Use `data-fy-*`.

## Document structure

- Adding `<!doctype>`, `<html>`, `<head>`, `<body>`, `<title>`, or `<meta>`; compositions are fragments and the framework owns the shell (`COMPOSITION_DOCUMENT_SHELL`).
- Missing/multiple `<fy-composition>` roots, a root nested inside another element, or missing `duration-in-frames` on an animated composition. `width`, `height`, and `fps` may be omitted when the project declares `format`, but declaring only one of `width` and `height` is an error.
- Forgetting both `duration-in-frames` and `fps` on a composition that should animate; that composition is now static and renders to PNG. Declaring `fps` without `duration-in-frames` is an error.
- Rendering a composition that declares no dimensions in a project without `format`; add `width`/`height` or the project `format` (`COMPOSITION_FORMAT_UNRESOLVED`).
- Missing the top-level `data-fy="props"` block when the composition relies on default props; a nested props block is rejected.
- Putting props, the controller, or an import map inside `<fy-composition>` instead of at the top level.
- Using the reserved `data-fy-host` attribute or `data-fy="format"` block.
- Declaring an import map with `frameyard` or `frameyard/` specifiers; those are reserved (`IMPORT_MAP_INVALID`).
- Visual content outside `<fy-composition>`; it is not captured.
- Using `<base>`, refresh/CSP meta tags, `<iframe>`, `<object>`, or `<embed>`.

## Bindings

- Unknown `data-fy-*` attribute, usually a typo such as `data-fy-txt`.
- A binding path that does not exist in the resolved props. Check the `BINDING_PATH_MISSING` warning and its suggestion.
- Using `data-fy-repeat` on a normal element instead of `<template>`.
- Nesting `data-fy-repeat`; use a controller for nested data.
- Putting `data-fy-if` or `data-fy-text` on a repeat template.
- Putting `data-fy-text` on an `<img>` or another void element.
- Expecting bindings to update every frame or to re-bind controller-created DOM.

## Timing

- Writing seconds where frames are required, or frames where seconds are required.
  - `data-fy-start` and `data-fy-anim-start`/`duration` are frames.
  - `data-fy-trim`/`duration` are seconds.
- Using CSS `animation-delay`/`duration` in seconds and expecting the declarative scheduler to ignore its own attributes. `data-fy-anim-*` overrides the shorthand's delay/duration.
- Adding `data-fy-anim-*` without a CSS animation; this produces `ANIMATION_NOT_FOUND`.
- Using multiple animations on an element with one declarative schedule.

## Controllers

- Declaring both inline source and `src` on the same controller.
- Declaring more than one controller.
- Making `update()` async; do asynchronous work in `mount()`.
- Leaving module-scope state behind in `dispose()`.
- Writing a literal `</script>` inside inline controller source; escape it.
- Importing libraries from executable `<script>` tags; import them from the controller instead.
- Using `Math.random()`, `Date.now()`, `performance.now()`, timers, independent `requestAnimationFrame` loops, or CSS transitions.

## Fonts

- Using a remote Google Fonts `<link>` in a composition that must render reproducibly. Search Fontsource with `font search` and vendor the file; remote fonts produce `FONT_REMOTE`.
- Installing a Fontsource variable family and then expecting static weights from the same record. Use `--static --weight 400,700` for static files, or `--force` to replace the family.
- Passing `--license` with a Fontsource id; the provider supplies the license and the flag is rejected. Use `--license` only with `--file`/`--url`.
- Importing a font by URL without a license. It records `unknown`, warns, and requires `full`; add `--license` and `--license-file` when the license allows redistribution.
- Adding a `.woff2` file but forgetting the license or `--family`; `font add` needs the family name and warns when the license is unknown.
- Hand-editing a path or hash in `fy.fonts.json`. Reinstall the face; `check`, `still`, and `render` verify hashes before Chromium.
- Installing only weight 400 and using `font-weight: 700`, which asks the browser to synthesize a bold face. Add the weight or a variable range.
- Moving or renaming a vendored font file without updating the manifest; `font verify` reports `FONT_FILE_MISSING`.

## Media and transcripts
- Using remote, live, or unseekable media sources.
- Using `<source>` or `<track>` children; use a local `src` and `<fy-transcript>`.
- Adding or changing media in `update()`; prepare it in the fragment or in `mount()`.
- Calling `play()`, `pause()`, or setting `currentTime` on a video.
- Assuming media/transcript `src` is document-relative. It is project-root-relative.
- Assuming the controller `src` is project-root-relative. It is relative to the composition URL.

## Generated audio

- Passing `--talker-model` or `--codec-model` with `--engine supertonic`, or `--model-dir` with `--engine qwen`. Flags are engine-specific.
- Using a speaker name with `--engine supertonic`; `--speaker` is the numeric `--sid`.
- Omitting `--language` with Supertonic or using a code outside its 31-language list.
- Expecting `--style` or `--device` to work with Supertonic; both are qwen-only. Put expression tags in the text.
- Pointing `--model-dir` at individual files instead of the extracted seven-file archive.
- Regenerating an existing speech asset without `--force` and user approval (`OUTPUT_EXISTS`).

## Timelines

- Putting `blend` on an audio clip. It is only valid on visual clips.
- Using `hue`, `saturation`, `color`, or `luminosity`. They need cross-channel math and are rejected; use one of the separable CSS modes.
- Expecting a blend on a transparent nested timeline to see the parent's layers. A nested timeline is its own document and blends only against its own backdrop.
- Expecting a blend on a composition with an opaque background to reach lower tracks. The composition's alpha is opaque; leave its background transparent.
- Expecting preview and final render blend pixels to match exactly. CSS is the reference and FFmpeg approximates it; the guarantee is at clip capture.
- Omitting `duration` on a static composition clip, or setting `sourceIn` above 0. A static source has no intrinsic duration or frames.
- Expecting a static composition clip to contribute audio or transcripts. It is visual-only.

## Timeline keyframes

- Treating `frame` as a timeline frame or a source frame. Keyframe frames are clip-local; `0` is the clip start boundary and `duration` is the end boundary.
- Expecting keyframes to extend a clip. A key past `duration` is a `TIMELINE_CLIP_OUT_OF_RANGE` error; declare a longer clip instead.
- Declaring the same channel as a scalar in `transform` and as a keyframe track. Keyed channels and static channels are separate; defaults do not conflict.
- Combining `keyframes.scale` with a `transform.width`/`height` box. Use a keyed scale without a box, or keep the box and animate `x`, `y`, `rotation`, and `opacity`.
- Putting keyframes on an audio clip. Only visual clips have presentation channels.
- Using seconds instead of integer clip-local frames, or putting keys out of order.
- Expecting the final key’s `easing` to do anything. Easing belongs to the interval after a key; the last key has no following interval.
- Expecting preview and encoded keyframe motion to match exactly. Preview uses the exact CSS curve; production approximates it in FFmpeg and may differ by a subpixel.
- Expecting an animated `blend` mode. Blend remains static; only `opacity` can animate the layer’s contribution to a blend.

## Static compositions

- Expecting `update()` or `--fy-*` frame-state variables to run. A static composition only runs `mount()` and prop validation; use CSS, markup, or mount-time canvas drawing.
- Adding `data-fy-anim-*`, `<video>`, `<audio>`, or `<fy-transcript>` to a static composition. These are `STATIC_ANIMATION_UNSUPPORTED` or `STATIC_MEDIA_UNSUPPORTED`.
- Relying on CSS animations or transitions at capture time; they are paused at 0 with `STATIC_ANIMATION_PAUSED`.
- Passing `--container`, `--codec`, `--encoder`, or `--concurrency` to `render` for a static composition. Use a timeline image clip if the deliverable must be video.
- Requesting a still frame other than 0 from a static composition.

## Context, inspection, and templates

- Reading the whole repository before a small edit. Run `npx frameyard context --json` first; it returns the format, props, timelines, assets, policy, and next commands.
- Treating `inspect`/`compare` as a vision model. They return facts such as blank, alpha coverage, bbox, and changed pixels; they do not judge whether a design looks right.
- Expecting `compare` to exit 0 when the images differ. It exits 1 and still returns `ok: true` with `identical: false`.
- Forgetting that `add` does not edit `fy.config.js`. Merge the returned `register` object yourself, then run `lint`.
- Adding a composition template to a project without `format`. Composition templates inherit the project format; add `format { width, height, fps }` first.
- Adding the slideshow timeline before `assets/slide-1.png` through `assets/slide-3.png` exist. `check` will report the missing assets.

## Resource policy and lint

- Using `check` as the edit loop. Use `lint`; it resolves the timeline, projects every scene and keyframe channel, and scans the controller without Chromium.
- Treating a clean `lint` as a successful `check`. Lint does not run `validateProps` or composition runtime.
- Running `tts`, `transcribe`, or `render` while the workspace policy is `authoring` or `light`. Use `--dry-run` and hand off the command.
- Editing `fy.policy.json`, `.opencode/`, `.pi/`, or `skills/frameyard/` to bypass the policy. Those files are protected by host permissions and are not part of the authoring task.
- Passing `--force` or `--overwrite` outside `full`. Ask the user before replacing an output; the CLI will fail with `RESOURCE_POLICY_BLOCKED`.
- Requesting more still frames than the tier allows. The caps are 1 for `light`, 4 for `authoring`, and 32 for `full`; split larger ranges.
- Passing `--workers 8` with `--profile shared-cpu`. The profile caps workers at 2 and fails with `RESOURCE_PROFILE_CONFLICT` instead of clamping.
- Forgetting that the policy is discovered from the working directory upward, independent of `fy.config.js`. Running from a nested directory still finds the workspace file.

## Validation

- Replacing `check` with a single `still`.
- Using `still` as an image-sequence exporter, adding `--step`-style workflows, or requesting more than 32 unique frames in one call.
- Ignoring warnings or `diagnostics` in `--json` output.
- Claiming success after a nonzero exit, a missing still, or skipped visual inspection.
- Using `--overwrite` or `--force` without permission.
