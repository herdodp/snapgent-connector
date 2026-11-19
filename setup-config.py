#!/usr/bin/env python3
"""Discover supported MCP applications and write the local Snapgent config."""

import argparse
import json
import os
import re
import shlex
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


def _figcraft_cli(
    configured: Optional[Dict[str, object]]
) -> Optional[Tuple[Path, List[str]]]:
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

    on_path = shutil.which("figcraft-cli")
    if on_path:
        candidates.append(Path(on_path))

    home = Path.home()
    candidates.extend(
        [
            Path("/opt/homebrew/bin/figcraft-cli"),
            Path("/usr/local/bin/figcraft-cli"),
            Path("/usr/bin/figcraft-cli"),
            home / "bin" / "figcraft-cli",
            home / ".local" / "bin" / "figcraft-cli",
        ]
    )
    cli = _first_executable(candidates)
    if cli:
        if cli.suffix.lower() == ".appimage":
            return cli, ["cli", "mcp"]
        return cli, ["mcp"]

    if sys.platform != "darwin":
        appimage = _first_executable(
            [
                home / "Applications" / "FigCraft.AppImage",
                home / "Applications" / "FigCraft" / "FigCraft.AppImage",
                Path("/opt/FigCraft/FigCraft.AppImage"),
            ]
        )
        if appimage:
            return appimage, ["cli", "mcp"]
    return None


def _figcraft_app(cli: Path, cli_args: List[str]) -> Optional[Path]:
    # The AppImage is both the CLI ("cli mcp") and the desktop app.
    if cli_args[:1] == ["cli"]:
        return cli
    sibling = cli.with_name("figcraft")
    if _is_executable(sibling):
        return sibling.resolve()
    found = shutil.which("figcraft")
    if found:
        return Path(found).resolve()
    if sys.platform == "darwin":
        for candidate in (
            Path("/Applications/FigCraft.app"),
            Path.home() / "Applications" / "FigCraft.app",
        ):
            if candidate.is_dir():
                return candidate
    return None


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
        print(
            "Save your work, close EffectCraft, then run the Open EffectCraft for "
            "Snapgent helper."
        )
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


def _is_figcraft_process(command: str, app: Optional[Path] = None) -> bool:
    lowered = command.lower().replace("\\", "/")
    try:
        arguments = shlex.split(command)
    except ValueError:
        arguments = command.split()
    if "mcp" in arguments:
        return False
    if app and str(app).lower().replace("\\", "/") in lowered:
        return True
    return bool(
        re.search(r"(?:^|[/\s])figcraft(?:\.appimage)?(?:$|[\s])", lowered)
        or "figcraft.app/contents/macos/" in lowered
    )


def _control_port(command: str) -> Optional[int]:
    try:
        arguments = shlex.split(command)
    except ValueError:
        arguments = command.split()
    for index, argument in enumerate(arguments):
        if argument.startswith("--control="):
            target = argument.split("=", 1)[1]
        elif argument == "--control" and index + 1 < len(arguments):
            target = arguments[index + 1]
        else:
            continue
        text = target.rsplit(":", 1)[-1]
        if text.isdigit() and 1 <= int(text) <= 65535:
            return int(text)
        return None
    return None


def _figcraft_processes(app: Optional[Path]) -> List[Tuple[int, str]]:
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        raise RuntimeError(f"Could not inspect running FigCraft processes: {error}") from error
    if result.returncode:
        detail = result.stderr.strip() or "ps exited with a non-zero status"
        raise RuntimeError(f"Could not inspect running FigCraft processes: {detail}")

    processes = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid != os.getpid() and _is_figcraft_process(fields[1], app):
            processes.append((pid, fields[1]))
    return processes


def _running_figcraft_control_port(
    app: Optional[Path],
) -> Tuple[Optional[int], bool]:
    processes = _figcraft_processes(app)
    ports = [
        port
        for _, command in processes
        if (port := _control_port(command)) is not None
    ]
    if not ports:
        return None, bool(processes)

    for _ in range(60):
        for port in ports:
            if _port_listening(port):
                print(f"FigCraft control channel is already listening on port {port}.")
                return port, True
        time.sleep(0.5)
    print("FigCraft was started with a control port, but the port is not responding.")
    return None, True


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _start_figcraft_control(app: Path, port: int) -> bool:
    print(f"Starting FigCraft control channel on port {port}...")
    try:
        if sys.platform == "darwin" and app.suffix.lower() == ".app":
            subprocess.Popen(
                ["open", "-a", str(app), "--args", "--control", str(port)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        else:
            subprocess.Popen(
                [str(app), "--control", str(port)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
    except OSError as error:
        print(f"Could not start FigCraft control channel: {error}")
        return False

    for _ in range(60):
        if _port_listening(port):
            print(f"FigCraft control channel is ready on port {port}.")
            return True
        time.sleep(0.5)
    print(f"FigCraft did not open its control channel on port {port}.")
    return False


def _figcraft_base_args(
    detected_args: List[str], existing_server: Optional[Dict[str, object]]
) -> List[str]:
    existing_args = existing_server.get("args") if existing_server else None
    if not isinstance(existing_args, list) or not all(
        isinstance(argument, str) for argument in existing_args
    ):
        return list(detected_args)
    if existing_args[: len(detected_args)] != detected_args:
        return list(detected_args)

    arguments = []
    index = 0
    while index < len(existing_args):
        argument = existing_args[index]
        if argument == "--attach":
            index += 2
        elif argument.startswith("--attach="):
            index += 1
        else:
            arguments.append(argument)
            index += 1
    return arguments if arguments[: len(detected_args)] == detected_args else list(detected_args)


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


def main(
    launch_figcraft: bool = False, launch_effectcraft: bool = False
) -> int:
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
            if launch_effectcraft:
                _start_effectcraft_control(effectcraft_app)
            else:
                print(
                    "EffectCraft will stay closed. Use the Open EffectCraft for "
                    "Snapgent launcher when you want to connect it."
                )
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

        existing_figcraft = servers.get("figcraft")
        existing_figcraft_server = (
            existing_figcraft if isinstance(existing_figcraft, dict) else None
        )
        figcraft = _figcraft_cli(existing_figcraft_server)
        if figcraft:
            figcraft_path, detected_args = figcraft
            figcraft_app = _figcraft_app(figcraft_path, detected_args)
            figcraft_args = _figcraft_base_args(
                detected_args, existing_figcraft_server
            )
            control_port, figcraft_running = _running_figcraft_control_port(
                figcraft_app
            )
            if (
                control_port is None
                and not figcraft_running
                and figcraft_app
                and launch_figcraft
            ):
                candidate_port = _available_port()
                if _start_figcraft_control(figcraft_app, candidate_port):
                    control_port = candidate_port
            elif control_port is None and not figcraft_running and figcraft_app:
                print(
                    "FigCraft is not running and will stay closed. "
                    "Use the Open FigCraft for Snapgent launcher when you want to connect it."
                )
            elif control_port is None and figcraft_running:
                print(
                    "FigCraft is already open without a reachable control channel. "
                    "It will not be restarted; its MCP entry will run headless."
                )
                print(
                    "Save your work, close FigCraft, then run the Open FigCraft for "
                    "Snapgent helper."
                )
            elif control_port is None:
                print("FigCraft desktop app was not found; its MCP entry will run headless.")

            if control_port is not None:
                figcraft_args.extend(["--attach", str(control_port)])

            if existing_figcraft_server:
                existing_figcraft_server["command"] = str(figcraft_path)
                existing_figcraft_server["args"] = figcraft_args
                existing_figcraft_server.setdefault("env", {})
            else:
                _set_server(servers, "figcraft", str(figcraft_path), figcraft_args)
            print(f"FigCraft MCP detected: {figcraft_path}")
        elif isinstance(existing_figcraft, dict):
            print(
                "Configured FigCraft MCP executable was not found: "
                f"{existing_figcraft.get('command', '')}"
            )
            print("Update mcpServers.figcraft.command in config.json to match your installation.")
        else:
            print(
                "FigCraft not found; install it from "
                "https://github.com/storytold/figcraft/releases to enable its MCP."
            )

        uvx_path = shutil.which("uvx")
        if uvx_path:
            _set_server(
                servers,
                "word",
                uvx_path,
                ["--from", "office-word-mcp-server", "word_mcp_server"],
            )
            print(f"Word MCP detected (uvx): {uvx_path}")
        else:
            print("uv not found; Word MCP not configured. Install uv from https://docs.astral.sh/uv/ and run this script again.")

        CONFIG_PATH.write_text(
            json.dumps(configuration, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return 0
    except (OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--launch-figcraft",
        action="store_true",
        help="start FigCraft in control mode if it is not already running",
    )
    parser.add_argument(
        "--launch-effectcraft",
        action="store_true",
        help="start EffectCraft in control mode if it is not already running",
    )
    arguments = parser.parse_args()
    raise SystemExit(
        main(
            launch_figcraft=arguments.launch_figcraft,
            launch_effectcraft=arguments.launch_effectcraft,
        )
    )
