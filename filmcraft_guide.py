#!/usr/bin/env python3
"""FilmCraft guide MCP server for Snapgent.

A tiny stdio MCP server that sits next to the FilmCraft MCP entry and gives the
AI agent two things it cannot get anywhere else:

1. ``filmcraft_guide`` - the driving playbook: tool surface, the inspect ->
   edit -> verify loop, command discovery, recipes and troubleshooting.
2. ``topic: "status"`` - a LIVE probe of config.json + the FilmCraft control
   channel, so the agent can tell "bridge mode" (attached to the real app)
   apart from "headless" (editing a separate empty project) by itself.

Python 3.9+, standard library only. Speak 2024-11-05 JSON-RPC on stdio.
"""

from __future__ import annotations

import json
import socket
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "filmcraft-guide"
SERVER_VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent

GUIDE: Dict[str, str] = {
    "overview": (
        "FilmCraft (ArtCraft) is a full non-linear video editor in which EVERY menu item, "
        "button, slider and drag is an engine command with an id and typed parameters "
        "(650+ commands). The MCP entry exposes them, so you can cut, trim, grade, mix "
        "and export exactly the way a person does.\n"
        "Golden rules:\n"
        "1. Inspect before you edit (doc_inspect / sequence_inspect).\n"
        "2. Verify after you edit (render_frame / ui_screenshot) and look at the image.\n"
        "3. Wrong result? edit.undo, adjust, retry.\n"
        "4. First thing in a session: call this tool with topic \"status\" to confirm you "
        "are attached to the real app (bridge mode), not a headless empty project."
    ),
    "tools": (
        "FilmCraft MCP tools (from the filmcraft server, not this guide):\n"
        "Both modes:\n"
        "- command_list {filter?, enabled_only?} - every command: id, label, menu, shortcut, params, enabled now\n"
        "- command_run {id, params} - run one command; edits are undoable\n"
        "- command_batch {steps:[{id,params}...], stop_on_error?} -> {completed, failed, results}\n"
        "- doc_inspect - project tree + active sequence in one call\n"
        "- project_inspect - bins and items with ids, types, durations\n"
        "- sequence_inspect - tracks, clips (start/end, sourceIn/sourceOut, speed, reverse, gainDb), effects, transitions, markers, playhead, selection\n"
        "- media_import {paths:[abs paths], bin?, image_sequence?} - import files\n"
        "- render_frame {seconds} / render_preview - PNG of the program frame (read-only)\n"
        "Bridge mode only (drive the real window):\n"
        "- ui_inspect - tool, workspace, panels, zoom, playback, fps\n"
        "- ui_elements {prefix?} - on-screen elements with id, label, rect\n"
        "- ui_click {id | x,y, button?, count?, modifiers?}\n"
        "- ui_drag - press-move-release between points or element ids\n"
        "- ui_key {key} - 'Space', 'Cmd+K', 'Shift+Delete'\n"
        "- ui_type {text} - type into the focused field\n"
        "- ui_screenshot {panel?} - PNG of the window or one panel\n"
        "- ui_control - call any control-channel method directly (ui.set, ui.scroll, ui.timeline.locate, ...)"
    ),
    "loop": (
        "The typical editing loop:\n"
        "1. doc_inspect or sequence_inspect -> learn ids (bins, items, clips, tracks, markers).\n"
        "2. command_list {filter:\"keyword\"} -> exact command ids, params, enabled state.\n"
        "3. command_run {id, params} (or command_batch for several steps).\n"
        "4. render_frame {seconds} or ui_screenshot -> LOOK at the image.\n"
        "5. Wrong? edit.undo, adjust, retry.\n"
        "Selection: a command that works on the selection is disabled until something is "
        "selected, UNLESS the call names its targets: {\"clips\":[12]} for timeline clips, "
        "{\"item\":4} for project items (e.g. clip.replaceFromBin). Other conditions still apply."
    ),
    "commands": (
        "Command discovery and time:\n"
        "- NEVER guess command ids. command_list {filter:\"razor\"} or {filter:\"export\"} "
        "returns id, label, menu, shortcut, params and whether it is enabled right now.\n"
        "- command_batch {steps:[{id,params}...], stop_on_error:true} runs steps in order and "
        "returns {completed, failed, results}; a failing step is an isError result with the "
        "engine's message.\n"
        "- Time: commands accept seconds, frame or timecode; the engine's internal unit is "
        "ticks (254016000000 per second, exact for every common frame rate).\n"
        "- Tracks: name them \"V1\", \"A2\", ... Naming a track the sequence does not have is "
        "an invalid-parameters error, never a silent fallback."
    ),
    "media": (
        "Media recipes:\n"
        "- Import: media_import {paths:[\"C:/abs/clip.mp4\", ...]} (bin optional, "
        "image_sequence for numbered stills).\n"
        "- Place: timeline.place puts a bin item on the timeline; track is where the picture "
        "goes, audioTrack where the sound goes; the clip snaps to the frame grid.\n"
        "- Move: timeline.move takes linked audio along (pass \"linked\":false to move only "
        "the listed clips); returns {moved:[ids]}.\n"
        "- Before exporting check media.status or media.findMissing: offline media renders a "
        "'media not found' placeholder instead of failing silently."
    ),
    "effects": (
        "Effects recipes:\n"
        "- Apply: effects.apply {effect:\"Gaussian Blur\"}.\n"
        "- Parameters: effects.setParam returns {keyframes, param, value}; keyframes 0 = a "
        "successful STATIC edit, not a failure. A choice by name comes back as its numeric "
        "option index (e.g. blend \"Screen\" -> 8).\n"
        "- Keyframes: effects.addKeyframe TOGGLES ({added:true|false, mediaTime}); "
        "effects.deleteKeyframe returns {removed:true|false}. An explicit time keeps its "
        "place even outside the clip."
    ),
    "export": (
        "Export recipes:\n"
        "- file.exportMedia with wait:true blocks until the file is written (progress via "
        "MCP progress notifications, cancellable). Without wait it returns "
        "{job, path, poll:\"jobs.list\", cancel:\"jobs.cancel\"} at once.\n"
        "- Poll jobs.list: progress, etaSeconds, finished, result. Stop with jobs.cancel "
        "(partial output is deleted).\n"
        "- The result carries offlineMedia (items rendered as placeholders) and warnings "
        "(e.g. 'range covers one frame, use range:\"entire\"'; hardware encoding declined). "
        "Read them.\n"
        "- Image sequences never write the given path: a.png becomes a000.png, a001.png, ...; "
        "result adds lastPath and basePath.\n"
        "- export.queue.add / export.queue.list manage the export queue. export.quick for a "
        "quick render. Markers for review: markers.exportCsv {path}."
    ),
    "ui": (
        "UI automation (bridge mode only) - use when the command surface is not enough:\n"
        "1. ui_elements {prefix:\"tools.\"} -> ids, labels, rects (ids come from the latest "
        "frame; after a layout change retry).\n"
        "2. ui_click {id} or {x,y}, ui_drag, ui_key {key:\"Space\"|\"Cmd+K\"}, ui_type {text}.\n"
        "3. ui_screenshot {panel:\"Timeline\"} to SEE the panel.\n"
        "4. ui_control calls any control-channel method directly: ui.set, ui.scroll, "
        "ui.timeline.locate, ui.elements, ui.click, ui.key, ui.screenshot, ui.inspect.\n"
        "engine.execute also runs UI-only commands (tool.razor, playback.toggle, "
        "window.workspace.color, window.panel.<name>)."
    ),
    "status": "STATUS_PLACEHOLDER",
    "troubleshooting": (
        "Troubleshooting:\n"
        "- HEADLESS means the filmcraft MCP entry runs 'mcp' without --bridge: the AI edits a "
        "SEPARATE empty in-process project and nothing happens in the app window. Fix: close "
        "FilmCraft, run Open-FilmCraft-for-Snapgent.bat (Windows) or "
        "open-filmcraft-for-snapgent.sh (macOS/Linux), confirm topic \"status\" says BRIDGE.\n"
        "- If the app is already open WITHOUT a control channel, it will not be restarted. "
        "Save your work, close it, then run the launcher.\n"
        "- Token errors ('invalid token' from the control channel): the stored "
        "FILMCRAFT_CONTROL_TOKEN does not match the running app. Restart via the launcher.\n"
        "- Tools error 'not available in headless mode': ui_* tools need bridge mode.\n"
        "- Offline media at export: check media.status / media.findMissing; fix or remount "
        "the media folder, or re-import from the real paths.\n"
        "- Long exports feel stuck: they are jobs - poll jobs.list for progress and etaSeconds."
    ),
}

TOPIC_LIST = ", ".join(sorted(GUIDE.keys()))

TOOL_DEFINITION: Dict[str, Any] = {
    "name": "filmcraft_guide",
    "title": "FilmCraft driving guide",
    "description": (
        "How to fully drive the FilmCraft video editor through MCP: tool surface, the "
        "inspect-edit-verify loop, command discovery, media/timeline/effects/export recipes, "
        "UI automation and live bridge-vs-headless status. Call topic:\"status\" first in a "
        "session to confirm the running app is attached."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "topic": {
                "type": "string",
                "description": (
                    "Guide section to read. Omit for the quickstart (overview + tools + loop)."
                ),
            },
        },
        "additionalProperties": False,
    },
    "annotations": {
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
}

QUICKSTART_TOPICS = ("overview", "tools", "loop")


def _reply(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _result(request_id: Any, result: Dict[str, Any]) -> None:
    _reply({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id: Any, code: int, message: str) -> None:
    _reply({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def _tool_text(text: str, is_error: bool = False) -> Dict[str, Any]:
    result: Dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def _extract_bridge_target(args: List[str]) -> Optional[str]:
    for index, argument in enumerate(args):
        if argument == "--bridge" and index + 1 < len(args):
            return str(args[index + 1])
        if argument.startswith("--bridge="):
            return argument.split("=", 1)[1]
    return None


def _probe_control_channel(host: str, port: int, token: str) -> Dict[str, Any]:
    request = {
        "id": 1,
        "token": token,
        "method": "ui.inspect",
        "params": {},
    }
    try:
        with socket.create_connection((host, port), timeout=3.0) as sock:
            sock.settimeout(3.0)
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
            data = b""
            while b"\n" not in data:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
    except OSError as error:
        return {"ok": False, "error": f"control channel unreachable on {host}:{port}: {error}"}
    line = data.split(b"\n", 1)[0].decode("utf-8", "replace").strip()
    if not line:
        return {"ok": False, "error": f"control channel on {host}:{port} closed without a reply"}
    try:
        reply = json.loads(line)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"control channel on {host}:{port} sent a non-JSON reply"}
    if reply.get("ok") is True:
        return {"ok": True}
    return {"ok": False, "error": str(reply.get("error") or reply)}


def _status_report() -> str:
    lines: List[str] = []
    config_path = ROOT / "config.json"
    if not config_path.is_file():
        return (
            "STATUS: UNKNOWN - no config.json next to this script.\n"
            "Run the Snapgent setup (start.bat or the Open FilmCraft launcher) first."
        )
    try:
        configuration = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return f"STATUS: UNKNOWN - config.json could not be read: {error}"
    servers = configuration.get("mcpServers")
    server = servers.get("filmcraft") if isinstance(servers, dict) else None
    if not isinstance(server, dict):
        return (
            "STATUS: NOT CONFIGURED - config.json has no mcpServers.filmcraft entry.\n"
            "Install FilmCraft, then run the Snapgent setup so the connector detects it."
        )
    args = [str(value) for value in server.get("args", [])]
    target = _extract_bridge_target(args)
    env = server.get("env") if isinstance(server.get("env"), dict) else {}
    token = str(env.get("FILMCRAFT_CONTROL_TOKEN", "") or "")
    lines.append(f"FilmCraft CLI: {server.get('command', '?')}")
    if target is None:
        lines.append(
            "MODE: HEADLESS - the AI edits a SEPARATE empty project, NOT the FilmCraft window.\n"
            "Fix: close FilmCraft and run Open-FilmCraft-for-Snapgent.bat (Windows) or "
            "open-filmcraft-for-snapgent.sh (macOS/Linux), then call this status again."
        )
        return "\n".join(lines)
    host, _, port_text = target.rpartition(":")
    try:
        port = int(port_text)
    except ValueError:
        lines.append(f"MODE: BRIDGE configured, but the target is unparseable: {target}")
        return "\n".join(lines)
    lines.append(f"MODE: BRIDGE -> {target}")
    if not token:
        lines.append("PROBE: FAILED - no FILMCRAFT_CONTROL_TOKEN stored in the filmcraft env block.")
        return "\n".join(lines)
    probe = _probe_control_channel(host or "127.0.0.1", port, token)
    if probe["ok"]:
        lines.append(
            "PROBE: ATTACHED - the control channel answered with the stored token. The AI "
            "drives the real running app: full command surface + UI tools."
        )
    else:
        lines.append(f"PROBE: FAILED - {probe['error']}")
        lines.append(
            "The app is probably not running with this control channel/token. Save your work, "
            "close FilmCraft, run the Open FilmCraft launcher, then retry."
        )
    return "\n".join(lines)


GUIDE["status"] = "Live probe; the server computes this on each call (topic \"status\")."


def _guide_text(topic: Any) -> Dict[str, Any]:
    if topic is None or topic == "":
        text = "\n\n".join(GUIDE[name] for name in QUICKSTART_TOPICS)
        text += f"\n\nFurther topics: {TOPIC_LIST}."
        return _tool_text(text)
    name = str(topic)
    if name not in GUIDE:
        return _tool_text(
            f'Unknown topic "{name}". Available topics: {TOPIC_LIST}.', is_error=True
        )
    if name == "status":
        return _tool_text(_status_report())
    return _tool_text(GUIDE[name])


def _dispatch(request: Dict[str, Any]) -> None:
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        return  # notification: never reply
    if method == "initialize":
        client_version = request.get("params", {}).get("protocolVersion")
        version = client_version if isinstance(client_version, str) else PROTOCOL_VERSION
        _result(
            request_id,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )
    elif method == "ping":
        _result(request_id, {})
    elif method == "tools/list":
        _result(request_id, {"tools": [TOOL_DEFINITION]})
    elif method == "tools/call":
        params = request.get("params", {})
        if params.get("name") != TOOL_DEFINITION["name"]:
            _error(request_id, -32602, f"Unknown tool: {params.get('name')}")
            return
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            _error(request_id, -32602, "arguments must be an object")
            return
        unknown = set(arguments) - {"topic"}
        if unknown:
            _error(
                request_id,
                -32602,
                f'unknown argument "{sorted(unknown)[0]}" for filmcraft_guide; expected: topic',
            )
            return
        _result(request_id, _guide_text(arguments.get("topic")))
    else:
        _error(request_id, -32601, f"Method not found: {method}")


def main() -> int:
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError:
            _error(None, -32700, "Parse error")
            continue
        if isinstance(request, dict):
            _dispatch(request)
    return 0


if __name__ == "__main__":
    sys.exit(main())
