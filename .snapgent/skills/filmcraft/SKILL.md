---
name: filmcraft
description: Use when the user wants to edit, cut, trim, grade, mix, subtitle or export video with FilmCraft. Gives the full MCP tool surface, the inspect-edit-verify loop, command discovery, recipes and bridge-vs-headless troubleshooting.
---

# FilmCraft full control

FilmCraft (by ArtCraft) turns every UI action into an engine command with an id and
typed parameters (650+ commands). The `filmcraft` MCP server exposes them; this skill
teaches you how to drive it like an editor.

## Step 0 - confirm you are attached to the real app

Call `filmcraft_guide` (its own MCP server) with `{"topic": "status"}` FIRST:

- `PROBE: ATTACHED` / `MODE: BRIDGE` - you drive the real running app. Continue.
- `MODE: HEADLESS` - you would edit a SEPARATE empty project and nothing would happen
  in the user's FilmCraft window. STOP editing. Tell the user: save work, close
  FilmCraft, run `Open-FilmCraft-for-Snapgent.bat` (Windows) or
  `open-filmcraft-for-snapgent.sh`, then re-check status.

## Step 1 - inspect before you edit

- `doc_inspect` - project tree + active sequence in one call
- `sequence_inspect` - tracks, clips (start/end, sourceIn/sourceOut, speed, reverse,
  gainDb), effects, transitions, markers, playhead, selection
- `command_list` with `{"filter": "razor"}` (or any keyword) - exact command ids,
  params, shortcuts and whether each is enabled RIGHT NOW. Never guess ids.

## Step 2 - edit

- One command: `command_run {"id": "...", "params": {...}}`
- Several steps: `command_batch {"steps": [{"id": ..., "params": ...}], "stop_on_error": true}`
- Time: `seconds`, `frame` or `timecode` all accepted (internal ticks are exact:
  254016000000/s). Tracks are named `"V1"`, `"A2"`, ...; wrong track names error out,
  they never silently fall back.
- Selection: a command needing a selection also accepts named targets -
  `{"clips": [12]}` for timeline clips, `{"item": 4}` for project items.
- Common commands: `media_import {paths}`, `timeline.place` (track = picture,
  audioTrack = sound), `timeline.move` (linked audio moves too; `"linked": false` to
  move only the listed clips), `playhead.set {seconds}`, `effects.apply`, `effects.setParam`,
  `file.exportMedia`, `jobs.list`, `edit.undo`, `file.save`, `markers.exportCsv {path}`.

## Step 3 - verify like an editor

- `render_frame {"seconds": N}` - PNG of the program frame (read-only). LOOK at it.
- Bridge mode adds UI tools: `ui_screenshot {"panel": "Timeline"}`, `ui_elements
  {"prefix": "tools."}`, `ui_click {id}`, `ui_key {"key": "Space"}`, `ui_type`,
  `ui_drag`, `ui_control`.
- Wrong result: `edit.undo`, adjust, retry.

## Export

- `file.exportMedia {..., "wait": true}` blocks until written (progress + cancellable).
  Without `wait` it returns `{job, poll: "jobs.list", cancel: "jobs.cancel"}` - poll
  `jobs.list` for `progress` / `etaSeconds` / `finished`.
- Read `result.warnings` and `offlineMedia`: offline media renders a "media not found"
  placeholder. Check `media.status` / `media.findMissing` first.
- Image sequences never write the given path: `a.png` becomes `a000.png, a001.png, ...`.

## Troubleshooting

- Tools error "not available in headless mode" -> you are not attached; Step 0 fix.
- "invalid token" from the control channel -> stored token mismatch; restart via the
  launcher.
- Long export seems stuck -> it is a job; poll `jobs.list` for `etaSeconds`.
- More topics: call `filmcraft_guide` with `topic`: tools, loop, commands, media,
  effects, export, ui, status, troubleshooting.
