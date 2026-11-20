# Edit timelines as validated JSON documents

**Status:** Accepted
**Date:** 2026-11-20

The development preview gains an explicit edit mode for version-1 timeline
documents and the canonical transcripts they reference. Every edit is an
immutable command applied to an in-memory JSON document, validated with the
same schema and resolver the CLI uses, and published by one atomic save
protocol. The editor never writes composition source, a database, or a private
editor format. Preview may show an unsaved working copy; `check`, `still`, and
`render` only ever read the saved file.

## Context

The preview is read-only. It selects clips, seeks frames, and inspects data, but
every structural change means editing timeline JSON by hand. Phase 2 needs a
visual editor without creating a second source of truth or a second way to
resolve a timeline.

Frameyard already has the pieces an editor should reuse:

- version-1 timeline JSON with a strict browser-safe schema and a Node-side
  resolver that validates references, media, props, variables, transitions,
  keyframes, and nested timelines;
- canonical transcript JSON with a browser-safe parser;
- a preview host that projects the resolved timeline through the shared scene
  module;
- a loopback-first development server that serves the project root;
- stable diagnostic codes, error envelopes, and a source-of-truth rule that
  says the saved JSON is what production renders.

The editor must preserve those properties while adding mutation, undo, save,
and conflict handling. In particular:

- **One format.** A visual edit must produce ordinary timeline JSON that an
  agent or a human could have written. No hidden fields, binary sidecar, or
  editor-only normalized document.
- **One resolver.** Interactive feedback may be cheaper, but save and preview
  must not invent validation rules that differ from `check`, `still`, or
  `render`.
- **No silent data loss.** A drag must not corrupt the document, a failed save
  must not truncate the file, and an external edit must not be overwritten
  without a conflict.
- **Deterministic production.** The editor mutates authoring data, never frame
  state. Rendering remains a function of the saved timeline, resolved props,
  and pre-loaded assets.
- **Local-first.** No hosted service, account, database, or browser-only file
  permission is required.

## Decision

### Editable files and authority

The editor writes exactly two kinds of file:

| File | Writable | Rule |
| --- | --- | --- |
| A version-1 timeline listed in `fy.config.js` | Yes | Addressed by timeline ID; saved with the timeline schema and resolver. |
| A canonical transcript JSON document | Yes, only while editing captions | Must be referenced by a `<fy-transcript>` in a composition reachable from the active timeline. |

Everything else is read-only in v1:

- composition fragments, partials, inline or linked CSS, import maps, and
  controllers;
- `fy.config.js`, `fy.fonts.json`, `fy.assets.json`, `fy.policy.json`, the
  package manifest, and project scripts;
- images, video, audio, fonts, generated assets, and `out/`;
- standalone props JSON files passed to `render --props`.

The editor does not create, rename, or delete project files in v1. It edits the
contents of an existing registered timeline or an existing referenced
transcript. A timeline that is nested inside another timeline is edited by
opening its own route, not by expanding it in place.

The **authored document** is the plain JSON value as it will be saved. It is not
the normalized result of `parseTimelineDocument`: omitted optional fields stay
omitted, array order is preserved, and no defaults are added by loading. The
normalized document is disposable validation and preview output.

### Edit mode and session

Editing is an explicit mode, not a second preview:

- The read-only routes and their behavior remain the default.
- `?__fy-edit=1` on `/__frameyard/timeline/<id>` requests edit mode. The page
  shows the edit controls only when the server reports that editing is enabled.
- `?__fy-embed=1` always stays read-only, even if `__fy-edit` is present. The
  embedded host API is unchanged.
- Composition focus (`/__frameyard/`) and its props editor stay read-only for
  persistence. Applying props there remains a preview override.
- Editing is available only from the `dev` server bound to a loopback address.
  A server bound to a non-loopback host, or one started without editing enabled,
  rejects edit routes with `EDIT_FORBIDDEN`.

A **session** is created by the first edit-mode page and identified by an
`HttpOnly`, `SameSite=Strict`, path-scoped cookie. The session holds:

- an opaque edit token delivered to the page, required on every write;
- one active document and at most one working copy;
- the file hash the working copy was based on;
- the timeline entry and the canonical transcript paths the active timeline may
  edit;
- an in-memory media-probe and composition-validation cache that may be reused
  for preview resolution but never changes the result.

Only one editor tab mutates a session. A per-tab client ID is issued when the
session opens; a second edit-mode tab receives `EDIT_FORBIDDEN` with
`reason: "session-active"` and stays read-only. Taking over requires closing the
first session. The session is destroyed on `DELETE /__frameyard/edit/session`,
on server shutdown, and after 30 minutes without an edit request. Unsaved
working copies are never persisted by the server.

The session opens at most one document at a time:

- opening another timeline or transcript, or leaving edit mode with a dirty
  document, asks Save, Discard, or Cancel;
- the session never holds two dirty documents, so every save is one atomic file
  write;
- history and selection belong to the open document and are discarded when it
  closes.

`beforeunload`, browser back/forward, and in-app selection changes honor the same
dirty guard. A cancelled navigation restores the previous URL and document. An
external file change never auto-reloads a dirty buffer. If the buffer is clean,
the editor offers to reload. If it is dirty, the editor shows a conflict banner
and keeps the buffer until the creator saves, reloads, or explicitly overwrites.

### Working copies and preview

The editor sends its current document to the server after each committed change.
The server validates it with the browser-safe schema, stores it as the session's
working copy, and answers with diagnostics. It does not write the file.

The existing preview data route consults the session working copy:

- `GET /__frameyard/timeline/<id>.json` resolves the working copy when the
  session's active document is that timeline, otherwise the saved file;
- a transcript file referenced by the active timeline is served from the
  working copy, with `Cache-Control: no-store`, when that transcript is the
  active document;
- every other file route ignores working copies;
- the CLI and any request without the edit-session cookie always read saved
  files.

Resolution always uses the same Node-side resolver and scene projection as
production. The session may cache media probes and composition validations by
their immutable inputs, but a fresh resolve of the same document must produce
the same result. Unsaved preview is therefore a working-copy feature, not a
preview-only timeline model.

If preview resolution fails, the editor keeps the last successful preview
payload, shows the diagnostics, and leaves the working copy in place. The
document is still editable and may be repaired. A failed preview never writes
and never marks the document saved.

### Document model and canonical serialization

The editor keeps the authored JSON value as immutable data. A command never
mutates the current value; it returns the next value or a list of diagnostics.
The reducer is browser-safe: `src/editor/` may import `src/contracts.ts`,
`src/timeline/schema.ts`, `src/timeline/keyframes.ts`, `src/timeline/easing.ts`,
`src/transcript.ts`, and other browser-safe modules, but no `node:` built-in.

Saving serializes the document canonically:

- UTF-8, no BOM;
- two-space indentation and LF line endings;
- a single trailing newline;
- object keys in timeline contract order (`version`, `name`,
  `durationInFrames`, `background`, `variables`, `tracks`, `clips`,
  `transitions`; clip order `id`, `track`, `source`, `start`, `duration`,
  `sourceIn`, `props`, `variables`, `transform`, `keyframes`, `blend`, `audio`);
- transcript keys in `schemaVersion`, `text`, `language`, `source`, `segments`,
  `words` order;
- array order preserved, and no insignificant whitespace.

The editor does not add editor metadata to project files. History, selection,
snap state, dirty flags, and the last preview payload live in the page or the
session, never in the JSON.

There are two hashes:

- **file hash**: SHA-256 of the exact bytes on disk when the document was
  loaded. This is the save conflict token.
- **canonical hash**: SHA-256 of the canonical serialization. This is the
  dirty comparison and the published hash.

A file that was hand-formatted with different whitespace has a different file
hash from its canonical hash. Loading it is fine. The first save rewrites it
canonically, so the two hashes converge.

### Command model

Commands are plain JSON objects with a stable `type` and direct fields. They are
serializable, testable, and free of DOM references. The reducer applies a
command to one document kind: timeline commands apply to a timeline, transcript
commands apply to a transcript, and a command from the wrong family returns
`EDIT_COMMAND_INVALID`.

The TypeScript below names the authored shapes. Optional fields stay optional as
the schema accepts them, even where a parsed timeline type requires a default.

Timeline commands:

```ts
type TimelineCommand =
  | { type: "clip.add"; clip: TimelineClip; index?: number }
  | { type: "clip.delete"; clipIds: string[] }
  | { type: "clip.move"; moves: Array<{ clipId: string; start: number; track?: string }> }
  | { type: "clip.trim"; clipId: string; edge: "start" | "end"; frame: number }
  | { type: "clip.split"; clipId: string; frame: number }
  | { type: "clip.props.set"; clipId: string; props: Props | null }
  | { type: "clip.transform.set"; clipId: string; transform: TimelineTransform | null }
  | { type: "clip.blend.set"; clipId: string; blend: string | null }
  | { type: "clip.audio.set"; clipId: string; audio: TimelineClipAudio | null }
  | { type: "clip.variable.set"; clipId: string; name: string; value: JsonValue }
  | { type: "clip.variable.delete"; clipId: string; name: string }
  | { type: "keyframe.enable"; clipId: string; channel: TimelineKeyframeChannel }
  | { type: "keyframe.add"; clipId: string; channel: TimelineKeyframeChannel; frame: number; value: number; easing?: string }
  | { type: "keyframe.move"; clipId: string; channel: TimelineKeyframeChannel; fromFrame: number; toFrame: number }
  | { type: "keyframe.update"; clipId: string; channel: TimelineKeyframeChannel; frame: number; value?: number; easing?: string }
  | { type: "keyframe.delete"; clipId: string; channel: TimelineKeyframeChannel; frame: number }
  | { type: "keyframe.clear"; clipId: string; channel: TimelineKeyframeChannel; frame?: number }
  | { type: "track.add"; track: TimelineTrack; index?: number }
  | { type: "track.update"; trackId: string; patch: { name?: string; gain?: number; muted?: boolean } }
  | { type: "track.move"; trackId: string; index: number }
  | { type: "track.delete"; trackId: string }
  | { type: "transition.add"; transition: TimelineTransition }
  | { type: "transition.delete"; from: string; to: string }
  | { type: "timeline.update"; patch: { name?: string | null; durationInFrames?: number | null; background?: string | null } }
  | { type: "timeline.variable.set"; name: string; value: JsonValue }
  | { type: "timeline.variable.delete"; name: string };
```

Transcript commands:

```ts
type TranscriptCommand =
  | { type: "transcript.segment.text.set"; index: number; text: string }
  | { type: "transcript.word.text.set"; index: number; text: string }
  | { type: "transcript.segment.timing.set"; index: number; startMs: number; endMs: number }
  | { type: "transcript.word.timing.set"; index: number; startMs: number; endMs: number };
```

Caption page splits, merges, breaks, and style presets are presentation
overrides, not transcription. Tracking #12 decides whether a page break or
style preset lives in the canonical transcript or in the timeline clip's
`props`; #28 adds those command subtypes once that contract exists. They obey
the same envelope, validation, history, and save rules and never target
composition markup. Settings that exist only in composition HTML or CSS are
shown read-only.

Command semantics:

- Frames are integer timeline frames. Values are never rounded silently;
  non-integers are rejected.
- `clip.add` requires a schema-valid unique ID and a declared track. The caller
  supplies the ID; the UI may generate one.
- `clip.move` is atomic across its `moves`. Each move keeps the clip's
  duration; omitted `track` stays on the current track; cross-track moves are
  allowed only between tracks of the same kind. If any move is invalid, none
  are applied.
- `clip.delete` removes the named clips and every transition that names one of
  them. A missing ID rejects the command.
- `clip.split` requires `0 < frame < clip.duration`, and is rejected for a clip
  that participates in a transition; remove or retarget the transition first.
- Commands never change `durationInFrames` implicitly. A move or trim beyond a
  declared duration is rejected with `TIMELINE_DURATION_INVALID`; the UI offers
  an explicit `timeline.update` to extend it.
- `clip.props.set` and `clip.transform.set` replace the whole object; `null`
  removes the optional object. They never deep-merge. Variable updates are
  separate commands so a reference cannot be accidentally serialized into a
  literal value.
- `keyframe.enable` removes the channel's static transform scalar and writes a
  two-key track at local frames `0` and the clip duration, both holding the
  scalar value or the channel default (`0` for `x`, `y`, and `rotation`; `1` for
  `scale` and `opacity`). `keyframe.add` requires an existing track;
  `keyframe.clear` removes the track and writes the value evaluated at `frame`
  (default `0`) as the static scalar. Keyframes are identified by `frame`, which
  the schema requires to be strictly increasing.
- `track.delete` removes the track, its clips, and transitions that name them.
  The schema rejects an empty track list, so deleting the last track fails.
- `track.move` changes composite order for video tracks; audio order is
  preserved but has no mix effect.
- A command that produces a byte-identical canonical document is a successful
  no-op: it does not add history and does not change dirty state.
- A command that produces an invalid document returns the underlying
  `TIMELINE_*`, `PROPS_*`, or `TRANSCRIPT_*` diagnostics and leaves the
  document, history, selection, and dirty state unchanged.

#### Timing commands and keyframes

Timing commands must keep presentation coherent:

- **Move** changes `start`; `sourceIn` and `duration` are unchanged. Multiple
  moves are validated together.
- **Trim start** to absolute frame `frame` changes `start` and `duration`, and
  shifts `sourceIn` by the same delta for composition, nested-timeline, video,
  and audio sources. `sourceIn` cannot become negative and image/static
  composition clips keep `sourceIn: 0`. Trimming before the available source
  head is rejected.
- **Trim end** to `frame` changes `duration` only. It must stay at least one
  frame and within the available source range.
- **Split** at `frame` keeps the original ID on the first half. The second half
  receives `<id>-split`, or `<id>-split-2`, `<id>-split-3`, and so on until it
  is unique. The command result reports the new ID so the UI can select it.
  Sources and transitions are never silently reassigned.

For a keyed channel, trims and splits rebase keyframe times and insert
interpolated boundary keys so the value at each new edge matches the original
track. Keys outside the new range are dropped. A channel that ends with fewer
than two keys is converted to a static value only when that is exact (a single
remaining key or all frames held by one key); otherwise the boundary keys keep
the track valid. Easing inside a partially trimmed interval is approximated by
the same CSS timing-function model used by playback and render. The reducer
uses `src/timeline/keyframes.ts` and `src/timeline/easing.ts`; it does not
invent a second interpolator.

#### Transcript commands

- Timing edits use integer milliseconds relative to the source audio. Segments
  stay ordered by `startMs`; every `endMs` stays greater than or equal to its
  `startMs`. Words stay ordered the same way and keep non-empty text.
- `transcript.segment.text.set` updates the segment and recomputes the document
  `text` by joining segment texts with a single space.
- `transcript.word.text.set` updates the word timing entry only. It does not
  rewrite `text` or `segments`; word-level consumers read `words`.
- Transcript commands never change `schemaVersion`, `source`, `language`, or the
  source hash. Editing text and timing must not pretend to re-transcribe.
- Splitting and merging caption pages is a presentation command added by #28;
  it does not silently split or merge canonical transcription segments.

### History, dirty state, and undo

Undo and redo are snapshot-based, not inverse-command based. Each committed
command pushes the previous authored document onto a bounded history. Restoring
a snapshot restores the exact JSON, including key order, keyframe arrays,
optional fields, and variable objects.

- The default history bound is 100 committed commands per document. When the
  bound is exceeded, the oldest entry is dropped.
- A gesture produces one command, so a multi-clip drag, a trim, a split, or a
  delete is one undo entry. During a drag the UI may apply a transient command
  to a clone for preview; only the released command is committed.
- A new committed command after undo clears the redo stack.
- Undo/redo does not restore the playhead or selection. Selection is pruned to
  clips that still exist; focus returns to the nearest surviving clip.
- Dirty means the canonical hash differs from the saved canonical hash.
  Undoing back to the saved document clears dirty without a save.
- History is in memory only. Reload, session close, and browser restart discard
  it.

The server never executes commands or stores an undo log. It accepts a full
validated document and saves it. The command reducer is the only mutation path;
tests exercise it without a browser or server.

### Validation boundaries

There are three levels, each with a distinct job:

1. **Command validation (browser).** Before a command is committed, the reducer
   runs `parseTimelineDocument` (or `parseTranscript`) on the candidate. Schema,
   overlap, transition, keyframe, source-kind, and variable-reference errors
   reject the command. This is fast enough for a drag preview.
2. **Preview resolution (Node, no Chromium).** The working-copy route runs
   `resolveProjectTimeline` against the posted document. It validates references,
   nested cycles, media, source ranges, composition props schemas, includes, and
   timeline variables, and returns the same preview payload as the saved file.
   Errors keep the last good preview and are shown in the editor.
3. **Save validation (Node, no Chromium).** The save route reruns schema
   validation and full resolution against the submitted document, including
   composition static validation. It writes only when there are no error
   diagnostics. Warnings are preserved in the response and do not block.

`check` remains the full runtime gate. A successful save does not prove that a
controller mounts, a font loads, or a browser can capture; it proves the
authoring document is structurally and statically valid. The editor never
launches Chromium or FFmpeg to validate a save.

### Save protocol

All edit endpoints are same-origin, JSON-only, and available only when editing
is enabled:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/__frameyard/edit/session` | Open an edit session; returns token and client ID; sets the session cookie. |
| `DELETE` | `/__frameyard/edit/session` | Close the session, discard working copies, clear the cookie. |
| `GET` | `/__frameyard/edit/document?kind=timeline&id=<id>` | Read the authored timeline, entry, and file hash. |
| `GET` | `/__frameyard/edit/document?kind=transcript&path=<entry>` | Read an allowlisted canonical transcript. |
| `PUT` | `/__frameyard/edit/document` | Validate and store the session working copy; no file write. |
| `POST` | `/__frameyard/edit/save` | Validate and atomically save one timeline or transcript. |
| `POST` | `/__frameyard/edit/discard` | Drop the working copy and return to the saved file. |

Write requests require the edit token, an `Origin` equal to the server origin,
an allowed client ID, `Content-Type: application/json`, and a body no larger
than 8 MiB. The session cookie is not sufficient by itself; the token prevents a
cross-site form or fetch from authoring an edit. Requests from non-loopback
peers are rejected even if the server was misconfigured. The checks are a
guardrail against accidental exposure and browser CSRF, not a sandbox against a
hostile local process.

The save request is:

```json
{
  "kind": "timeline",
  "id": "main",
  "document": { "version": 1, "...": "..." },
  "expectedHash": "64 lowercase hex characters",
  "force": false
}
```

`kind` is `timeline` or `transcript`. A timeline uses `id`; a transcript uses
`path`, a project-relative entry. `expectedHash` is the file hash loaded by the
editor and is required unless `force` is true. `force` is only for an explicit
overwrite after a conflict.

The save sequence is:

1. Resolve the target to an allowed entry. Timelines must be registered in
   `fy.config.js`. Transcripts must be canonical transcript files referenced
   by a composition reachable from the active timeline, and the referenced
   composition must still be reachable at save time.
2. Reject paths that escape the project root, symlinks whose real target
   escapes it, directories, and non-regular files.
3. Read the current file and hash its bytes. Unless `force` is true, a mismatch
   with `expectedHash` returns `EDIT_CONFLICT` and writes nothing. The response
   includes the expected and actual hashes.
4. Validate the submitted document. A schema or resolution error returns
   `EDIT_INVALID` with the full diagnostics and writes nothing. Warnings do not
   block.
5. Serialize canonically and write a temporary file in the same directory,
   flush it, and rename it over the target. Preserve the existing file mode.
   Remove the temporary file on any failure. If the platform cannot replace
   atomically, fail instead of truncating the target.
6. Return `{ ok: true, kind, entry, hash, bytes, diagnostics }`. `hash` and
   `bytes` describe the published file. Clear the working copy and mark the
   editor clean.

The save result and every edit error use the existing envelope:

```json
{ "ok": false, "command": "edit.save", "error": { "code": "EDIT_CONFLICT", "message": "..." }, "diagnostics": [] }
```

HTTP status mapping:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `EDIT_COMMAND_INVALID` | Malformed request JSON, missing `kind`/`id`/`document`, or malformed command. |
| 403 | `EDIT_FORBIDDEN` | Editing disabled, non-loopback, bad token/origin/client, or disallowed path. |
| 409 | `EDIT_CONFLICT` | File hash mismatch; nothing written. |
| 413 | `EDIT_COMMAND_INVALID` | Request body exceeds 8 MiB. |
| 422 | `EDIT_INVALID` | Schema or resolution errors; nothing written. |
| 500 | `INTERNAL` | Unexpected server failure. |

A failed save keeps dirty state and the working copy. A successful save clears
dirty and the working copy. The editor may continue editing from the returned
hash.

### Worked examples

A move is one command and one undo entry:

```json
{ "type": "clip.move", "moves": [{ "clipId": "intro", "start": 120 }] }
```

It keeps the clip's duration and source in-point. If the document declares a
`durationInFrames` shorter than the new clip end, the command is rejected; the
editor offers a separate `timeline.update` to extend the declared duration.

Trimming the left edge to absolute frame 100:

```json
{ "type": "clip.trim", "clipId": "intro", "edge": "start", "frame": 100 }
```

The delta changes `start` and `duration`, and shifts `sourceIn` for a source
with an intrinsic in-point. Trimming before the available source head is
rejected.

Splitting at absolute frame 130:

```json
{ "type": "clip.split", "clipId": "intro", "frame": 130 }
```

The first half keeps `intro`; the second becomes `intro-split` (or the next free
suffix). Both halves keep the source mapping, and keyed channels receive
boundary keys at the cut.

A save names the authored document and the file hash it was based on:

```json
{
  "kind": "timeline",
  "id": "main",
  "document": {
    "version": 1,
    "tracks": [{ "id": "v1", "kind": "video" }],
    "clips": [
      {
        "id": "intro",
        "track": "v1",
        "source": { "kind": "image", "src": "assets/card.png" },
        "start": 120,
        "duration": 60,
        "sourceIn": 0
      }
    ]
  },
  "expectedHash": "b1f0c6f2f0f4f9a4b7c2d1e8a6f3c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70",
  "force": false
}
```

If another process changed the file, the response is:

```json
{
  "ok": false,
  "command": "edit.save",
  "error": {
    "code": "EDIT_CONFLICT",
    "message": "timelines/main.json changed on disk after it was loaded.",
    "details": {
      "entry": "timelines/main.json",
      "expectedHash": "b1f0c6f2f0f4f9a4b7c2d1e8a6f3c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70",
      "actualHash": "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
    }
  }
}
```

The editor keeps its buffer, shows the conflict, and offers reload or explicit
overwrite. Undo is not a command: after the move, one history entry holds the
exact previous authored JSON. Undo restores that snapshot, prunes selection to
surviving clips, and clears dirty if the snapshot is the saved document.

### Selection, pointer, keyboard, and snapping

Selection is editor state, not document state. It supports one or more clips,
Shift/Cmd/Ctrl to extend, click-empty to clear, and synchronization with the
inspector. Selected clips expose `aria-selected="true"`; one clip owns the
roving `tabindex="0"`.

When the timeline strip or a clip has focus:

- Left/Right nudges the selection by one frame; Shift+Left/Right by ten.
- Alt+Left/Right trims the focused edge by one frame; Alt+Shift by ten.
- `S` splits the selected clip at the playhead.
- Delete/Backspace deletes the selection.
- Cmd/Ctrl+Z undoes; Cmd/Ctrl+Shift+Z or Ctrl+Y redoes.
- Escape cancels an in-progress drag, then clears selection.

The existing transport shortcuts stay on the transport and page: arrows step
the playhead, Shift+arrows jump one second, and Space plays or pauses. Editor
shortcuts are suppressed while a text field or the raw JSON editor has focus.

Pointer editing uses the clip body to move and an edge hit area of at least
eight CSS pixels to trim. Snapping targets integer frames, the playhead, every
clip edge on any track, and the timeline start/end. The snap threshold is eight
CSS pixels; the UI draws a vertical indicator and the target frame. Holding Alt
disables snapping for that gesture. A drag that ends on an invalid state is
rejected as one command and leaves the document unchanged.

Every pointer action has a keyboard equivalent, every control has an accessible
name, and diagnostics render in an `aria-live="polite"` region. Focus returns to
the nearest surviving clip after delete or undo. Touch editing is not a v1
target.

### Audio, captions, props, variables, and assets

These slices reuse the same command, history, working-copy, and save path:

- **Audio mixer (#27):** track and clip gain/mute, audio-track solo (a schema
  addition in #27), fades and ducking from tracking #12, and a compact waveform.
  Waveforms are generated from media and cached in memory; they are never saved
  and never change the mix. Preview and production use the same resolved audio
  settings.
- **Captions (#28):** transcript text and timing commands, plus page split,
  merge, break, and style-preset controls. The transcript working copy is served
  to the session's composition iframes so unsaved captions preview. Saving
  writes the canonical transcript, never re-runs transcription, and never writes
  composition markup.
- **Props, variables, and assets (#29):** schema-driven forms for composition
  clip props, a raw JSON fallback, root timeline variables, nested-instance
  overrides, and a read-only asset catalog that inserts project-relative paths.
  Deleting a referenced variable warns with the referencing clips; saving an
  unresolved reference fails. No upload, rename, or delete.
- **Render queue (#30):** enqueues the last saved timeline through the
  programmatic render API from tracking #13. It refuses to start while the
  active document is dirty or has unresolved errors, applies the workspace
  policy before starting, and reports progress, cancellation, and diagnostics.
  It never renders a working copy and never spawns the CLI.

### Diagnostics

The editor adds four stable codes to the existing diagnostic catalog:

| Code | Meaning | Details |
| --- | --- | --- |
| `EDIT_COMMAND_INVALID` | A command is malformed, addresses a missing target, uses the wrong document kind, or is a non-integer/unsupported request. | `command`, `reason`, and the target clip/track/path when known. |
| `EDIT_INVALID` | The submitted document failed schema or resolution validation. | The full underlying diagnostics; `entry`, `kind`. |
| `EDIT_CONFLICT` | The file changed after it was loaded. | `entry`, `expectedHash`, `actualHash`. |
| `EDIT_FORBIDDEN` | Editing is disabled or the request is not authorized/allowed. | `reason`: `disabled`, `loopback`, `token`, `origin`, `client`, `session-active`, `path`, or `kind`. |

Document-shape failures keep their existing codes (`TIMELINE_*`, `PROPS_*`,
`TRANSCRIPT_*`) as the diagnostics inside an `EDIT_INVALID` response. The
editor does not wrap every schema error in a new code. `explain` gains entries
for the four new codes when the endpoints land; they are protocol errors, not
authoring errors, so their fixes are commands or values, not automatic patches.

### Determinism and parity

- The editor changes only the saved timeline or transcript. Frame production
  still depends only on the integer frame, immutable props, and pre-loaded
  assets.
- Preview shows the session working copy through the same resolver and scene
  projection as production. There is no preview-only clip model.
- `check`, `still`, `render`, and the render queue read the saved file. They
  never see the working copy.
- After a successful save, canonical bytes are identical for preview and CLI.
  Parity is verified by comparing decoded stills or captured frames, not
  encoded MP4 hashes.
- A parity test does not pass `--props`; render-time props overrides are a
  separate explicit input and are not part of the editor baseline.
- A failed save, failed preview, or cancelled render publishes no partial file
  and leaves the previous saved document or output intact.

## Alternatives considered

- **Write files directly from the browser with the File System Access API.**
  Rejected: permissions are browser-specific, there is no shared resolver
  validation, conflict detection is weak, and a coding agent or CLI cannot use
  the same path.
- **Autosave every command.** Rejected: every intermediate gesture would write,
  invalid intermediate documents would need suppression rules, and conflicts
  would be harder to explain. Save is explicit.
- **Inverse-command undo.** Rejected: inverse commands drift from the forward
  command as the schema grows. Snapshots restore the exact JSON.
- **Persist a command log or a SQLite/binary project.** Rejected: the saved
  timeline must remain the reviewable source of truth and must render without
  the editor.
- **Edit the normalized parse result.** Rejected: normalization adds defaults
  and drops authored omissions, making saves noisy and potentially lossy.
- **Resolve timelines in the browser.** Rejected: media probing and composition
  static validation are Node-side. Preview uses the same server resolver.
- **A separate editor-only timeline format with an export step.** Rejected: it
  forks the source of truth and invites preview/render drift.
- **Send each command to the server for execution.** Rejected: the reducer must
  be instant and testable without I/O; the server validates the resulting full
  document, not a command stream.
- **Edit composition HTML and CSS in the browser.** Rejected for v1: the
  composition remains a source file, and the editor's write allowlist stays
  small enough to audit.

## Consequences

- A creator can move, trim, split, keyframe, mix, caption, and parameterize a
  timeline without hand-editing JSON, while the project stays ordinary files in
  git.
- The first save of a hand-formatted timeline rewrites it in canonical form,
  so the diff may show whitespace and key-order changes even when the document
  is semantically unchanged.
- The save endpoint is a new local server surface. It is limited to loopback,
  token-authorized, allowlisted, validated, atomic, and hash-checked, but it is
  still a development convenience rather than a security boundary.
- Preview route behavior depends on the edit-session cookie while editing.
  Read-only, embedded, CLI, and production requests are unaffected.
- The resolver gains an in-memory working-copy input. It must keep the same
  result as resolving the saved file.
- Undo history is intentionally ephemeral. Reloading loses it; the saved file
  is the durable state.
- Caption editing depends on the canonical transcript and the `<fy-transcript>`
  contract from tracking #12; the editor does not invent caption rendering.
- Render queueing depends on the public render API from tracking #13; the
  editor does not spawn the CLI or duplicate the renderer.

## Out of scope

- Editing composition HTML, partials, CSS, controllers, import maps, or
  composition-level props schema blocks.
- Editing media, fonts, manifests, `fy.config.js`, or package files.
- Ripple, slip, roll, magnetic timelines, track effects, transitions beyond the
  existing dissolve/crossfade contract, filters, masks, or NLE parity.
- Collaborative editing, multi-user locking, merge UI, or hosted storage.
- Multiple open documents, tabs, or timelines per session.
- Autosave, background save, or save on every keystroke.
- A binary project format, a command log as the source of truth, or editor-only
  metadata in project files.
- Automatic transcription or asset generation from the editor.

## Implementation map

- **#23** adds `src/editor/` with the browser-safe command reducer, history,
  dirty state, and the timeline/transcript command families. It has no I/O.
- **#24** adds the session, working-copy, preview-resolution, atomic save,
  conflict, and dirty-guard surfaces to the development server.
- **#25** adds edit mode, selection, move/trim/split/delete, snapping, keyboard,
  and accessibility to the timeline strip.
- **#26** adds the keyframe lanes and marker editing.
- **#27** adds the audio mixer and the audio-track solo schema field.
- **#28** adds the caption workspace and transcript working copy.
- **#29** adds schema-driven prop and variable forms plus the asset picker.
- **#30** adds the render queue on top of the programmatic render API.

Tests at each slice cover the public seam: reducer behavior without a browser,
server save/preview behavior with real files, and a saved edit rendered by the
CLI that matches the editor preview. Read-only preview tests must continue to
pass unchanged.
