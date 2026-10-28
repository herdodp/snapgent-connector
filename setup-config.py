#!/usr/bin/env python3
"""Discover supported MCP applications and write the local Snapgent config."""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
VSCODE_MCP = ROOT / "vscode_mcp.py"
EFFECTCRAFT_PORT = 9877


def _is_executable(path: Path) -> bool:
    return path.is_file() and os.access(str(path), os.X_OK)


def _first_executable(paths: List[Path]) -> Optional[Path]:
    for path in paths:
        if _is_executable(path):
            return path.resolve()
    return None


def _effectcraft_cli(configured: Optional[Dict[str, object]]) -> Optional[Path]:
    candidates: List[Path] = []
    configured_command = configured.get("command") if configured else None
    if isinstance(configured_command, str) and configured_command:
        configured_path = Path(configured_command).expanduser()
        if configured_path.is_absolute():
            candidates.append(configured_path)
        else:
            found = shutil.which(configured_command)
            if found:
                candidates.append(Path(found))

    on_path = shutil.which("effectcraft-cli")
    if on_path:
        candidates.append(Path(on_path))

    home = Path.home()
    candidates.extend(
        [
            Path("/opt/homebrew/bin/effectcraft-cli"),
            Path("/usr/local/bin/effectcraft-cli"),
            Path("/usr/bin/effectcraft-cli"),
            home / "bin" / "effectcraft-cli",
            home / ".local" / "bin" / "effectcraft-cli",
            home / "Applications" / "EffectCraft" / "effectcraft-cli",
        ]
    )
    return _first_executable(candidates)


def _roblox_studio_mcp() -> Optional[Path]:
    override = os.environ.get("ZS_STUDIO_MCP_PATH")
    candidates = [Path(override).expanduser()] if override else []
    if sys.platform == "darwin":
        candidates.extend(
            [
                Path("/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"),
                Path.home() / "Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
            ]
        )
    return _first_executable(candidates)


def _effectcraft_app() -> Optional[Path]:
    if sys.platform == "darwin":
        candidates = [
            Path("/Applications/EffectCraft.app"),
            Path.home() / "Applications/EffectCraft.app",
        ]
        for path in candidates:
            if path.is_dir():
                return path
        return None
    for command in ("effectcraft", "EffectCraft"):
        found = shutil.which(command)
        if found:
            return Path(found).resolve()
    return _first_executable(
        [
            Path.home() / "Applications" / "EffectCraft.AppImage",
            Path.home() / "Applications" / "EffectCraft" / "EffectCraft",
            Path("/opt/EffectCraft/EffectCraft"),
        ]
    )


def _port_listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _effectcraft_running() -> bool:
    patterns = (
        [r"EffectCraft\.app/Contents/MacOS/"]
        if sys.platform == "darwin"
        else [r"(^|/)EffectCraft(\.AppImage)?($| )", r"(^|/)effectcraft($| )"]
    )
    return any(
        subprocess.run(
            ["pgrep", "-f", pattern],
            capture_output=True,
            text=True,
            check=False,
        ).returncode == 0
        for pattern in patterns
    )


def _start_effectcraft_control(app: Optional[Path]) -> None:
    if _port_listening(EFFECTCRAFT_PORT):
        print(f"EffectCraft control channel is already listening on port {EFFECTCRAFT_PORT}.")
        return
    if _effectcraft_running():
        print("EffectCraft is already open without its control channel.")
        print("Save your work, close EffectCraft, then run the Snapgent launcher again.")
        return
    if not app:
        print("EffectCraft desktop app not found; its MCP entry is configured but not started.")
        return

    if sys.platform == "darwin":
        result = subprocess.run(
            ["open", str(app), "--args", "--control", str(EFFECTCRAFT_PORT)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            detail = result.stderr.strip() or result.stdout.strip()
            print(f"Could not start EffectCraft control channel: {detail}")
            return
    else:
        try:
            subprocess.Popen(
                [str(app), "--control", str(EFFECTCRAFT_PORT)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as error:
            print(f"Could not start EffectCraft control channel: {error}")
            return

    for _ in range(60):
        if _port_listening(EFFECTCRAFT_PORT):
            print(f"EffectCraft control channel is ready on port {EFFECTCRAFT_PORT}.")
            return
        time.sleep(0.5)
    print(f"EffectCraft did not open its control channel on port {EFFECTCRAFT_PORT}.")


def _load_config() -> Dict[str, object]:
    if not CONFIG_PATH.exists():
        return {"mcpServers": {}}
    try:
        configuration = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read {CONFIG_PATH.name}: {error}") from error
    if not isinstance(configuration, dict):
        raise RuntimeError(f"{CONFIG_PATH.name} must contain a JSON object.")
    servers = configuration.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise RuntimeError(f"{CONFIG_PATH.name} must contain an object named mcpServers.")
    return configuration


def _set_server(
    servers: Dict[str, object], server_id: str, command: str, args: List[str]
) -> None:
    servers[server_id] = {"command": command, "args": args, "env": {}}


def main() -> int:
    if sys.platform not in {"darwin", "linux"}:
        print("ERROR: setup-config.py supports macOS and Linux.", file=sys.stderr)
        return 1
    try:
        configuration = _load_config()
        servers = configuration["mcpServers"]
        assert isinstance(servers, dict)

        vscode = servers.get("vscode")
        if not isinstance(vscode, dict) or Path(str(vscode.get("command", ""))).name in {
            "",
            "vscode_mcp.exe",
            "vscode_mcp.py",
        }:
            _set_server(servers, "vscode", sys.executable, [str(VSCODE_MCP)])
            print(f"VS Code MCP configured: {VSCODE_MCP}")
        elif not Path(str(vscode.get("command", ""))).exists() and Path(
            str(vscode.get("command", ""))
        ).name in {"python", "python3"}:
            _set_server(servers, "vscode", sys.executable, [str(VSCODE_MCP)])
            print(f"VS Code MCP configured: {VSCODE_MCP}")

        studio_mcp = _roblox_studio_mcp()
        if studio_mcp:
            _set_server(servers, "roblox", str(studio_mcp), [])
            print(f"Roblox Studio MCP detected: {studio_mcp}")
        else:
            existing_roblox = servers.get("roblox")
            if isinstance(existing_roblox, dict) and Path(
                str(existing_roblox.get("command", ""))
            ).name.lower() == "studiomcp.exe":
                servers.pop("roblox", None)
            if sys.platform == "darwin":
                print("Roblox Studio MCP not found; install/update Roblox Studio and enable its MCP server.")
            else:
                print(
                    "Roblox Studio MCP was not auto-detected on Linux. "
                    "If you have a compatible executable, set ZS_STUDIO_MCP_PATH."
                )

        effectcraft_cli = _effectcraft_cli(
            servers.get("effectcraft") if isinstance(servers.get("effectcraft"), dict) else None
        )
        effectcraft_app = _effectcraft_app()
        if effectcraft_cli:
            _set_server(
                servers,
                "effectcraft",
                str(effectcraft_cli),
                ["mcp", "--bridge", str(EFFECTCRAFT_PORT)],
            )
            print(f"EffectCraft MCP detected: {effectcraft_cli}")
            _start_effectcraft_control(effectcraft_app)
        else:
            existing_effectcraft = servers.get("effectcraft")
            if isinstance(existing_effectcraft, dict) and Path(
                str(existing_effectcraft.get("command", ""))
            ).name.lower() == "effectcraft-cli.exe":
                servers.pop("effectcraft", None)
            if sys.platform == "darwin":
                print("EffectCraft CLI not found; install its macOS CLI and put effectcraft-cli on PATH.")
            else:
                print("EffectCraft CLI not found; install its Linux CLI and put effectcraft-cli on PATH.")

        CONFIG_PATH.write_text(
            json.dumps(configuration, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return 0
    except (OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
