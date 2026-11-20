# Timeline editor

Frameyard's development preview has a read-only default. Phase 2 adds an
explicit edit mode that writes the same version-1 timeline JSON and canonical
transcript JSON an agent or human writes by hand. The contract is accepted in
[ADR 0032](../../../docs/adr/0032-edit-timelines-as-validated-json-documents.md);
the implementation lands in #23-#30. Until then, edit timeline JSON directly.

## What edit mode may write

- A version-1 timeline listed in `fy.config.js`, addressed by timeline ID.
- A canonical transcript JSON referenced by a `<fy-transcript>` in a
  composition reachable from that timeline.

Everything else is read-only: composition fragments, partials, CSS, controllers,
`fy.config.js`, `fy.fonts.json`, `fy.assets.json`, `fy.policy.json`, media,
fonts, props files, and `out/`. The editor never creates, renames, or deletes
project files.

## Activating it

- Edit mode is the timeline route with `?__fy-edit=1`, for example
  `/__frameyard/timeline/main?__fy-edit=1`.
- It is available only from the `dev` server bound to a loopback address.
- `?__fy-embed=1` is always read-only. Composition focus and its props editor
  remain preview-only and never persist.
- One editor tab owns the session. Leaving with unsaved changes prompts Save,
  Discard, or Cancel.

## Commands and history

Every edit is a serializable command applied to an immutable authored JSON
document. The command families are:

- clips: add, delete, move, trim, split;
- clip data: props, transform, blend, audio, nested-instance variables;
- keyframes: enable, add, move, update, delete, clear;
- tracks: add, update, move, delete;
- transitions: add, delete;
- timeline metadata and variables;
- transcription text and timing.

Commands are validated with `parseTimelineDocument` (or `parseTranscript`)
before they commit. An invalid command returns the underlying `TIMELINE_*`,
`PROPS_*`, or `TRANSCRIPT_*` diagnostics and does not change the document,
history, selection, or dirty state. A command that produces the same canonical
document is a no-op.

Undo and redo restore exact authored snapshots, not inverse commands. History is
in memory, bounded to 100 committed commands per document, and discarded when
the document closes. One document is dirty at a time. Dirty compares canonical
hashes, so undoing back to the saved document clears it without a save.

## Preview and save

- Preview resolves the session's unsaved working copy through the same Node
  resolver and scene projection as production. Media and composition
  validation errors keep the last good preview and do not write.
- Save is explicit and atomic. It requires the expected file hash, validates the
  full document without Chromium, writes a temporary file in the same
  directory, and renames it over the target. A failed or conflicting save writes
  nothing.
- The first save rewrites a hand-formatted file canonically: two-space
  indentation, LF, contract key order, and one trailing newline.
- `check`, `still`, and `render` read only the saved file. They never see a
  working copy. A render queue refuses to start while the active document is
  dirty or unresolved.
- Parity is verified by comparing decoded stills or frames, not encoded video
  hashes. Do not add `--props` to a parity comparison.

## Editor diagnostics

| Code | Meaning |
| --- | --- |
| `EDIT_COMMAND_INVALID` | Malformed command, wrong document kind, missing target, or non-integer request |
| `EDIT_INVALID` | Submitted document failed schema or resolution validation; carries underlying diagnostics |
| `EDIT_CONFLICT` | The file changed after it was loaded; nothing was written |
| `EDIT_FORBIDDEN` | Editing disabled, non-loopback request, bad token/origin/client, or disallowed path |

`explain` entries land with the endpoints. Protocol errors have no automatic
fix; correct the command, reload, or save explicitly.

## Working with agents

- The CLI remains the source of truth for checks and renders. Never assume an
  unsaved editor buffer is visible to `npx frameyard check`, `still`, or
  `render`.
- Save, then run the normal `lint`, `check`, `still`, and `render` loop.
- Do not hand-edit editor metadata or add `_editor` fields to timeline JSON.
  History, selection, and snap state never belong in project files.
- Preview-only props typed in composition focus are not persisted by the
  editor. Change the timeline clip's `props` or the composition source instead.
