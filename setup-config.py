#!/usr/bin/env python3
"""Configure the Linux-scoped workspace MCP server in the local Snapgent config."""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
WORKSPACE_MCP = ROOT / "workspace_mcp.py"


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
    servers: Dict[str, object], server_id: str, command: str, args: List[str],
    env: Optional[Dict[str, str]] = None,
) -> None:
    servers[server_id] = {"command": command, "args": args, "env": env or {}}


def main() -> int:
    if sys.platform != "linux":
        print("ERROR: setup-config.py supports Linux only.", file=sys.stderr)
        return 1
    try:
        configuration = _load_config()
        servers = configuration["mcpServers"]
        assert isinstance(servers, dict)

        root = os.environ.get("ZS_WORKSPACE_ROOT") or os.getcwd()
        _set_server(
            servers, "repo", sys.executable, [str(WORKSPACE_MCP)],
            {"ZS_WORKSPACE_ROOT": str(Path(root).expanduser().resolve())},
        )
        print(f"workspace MCP configured: {WORKSPACE_MCP} (root: {root})")

        for stale in ("vscode", "roblox", "effectcraft"):
            servers.pop(stale, None)

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
