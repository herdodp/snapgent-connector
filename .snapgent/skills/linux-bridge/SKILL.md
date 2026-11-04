---
name: linux-bridge
description: Use when building, running, configuring, or debugging the Linux-scoped MCP workspace server and its WebSocket bridge.
---

# Linux bridge — build, run, configure

This Linux build targets the client-agnostic `workspace-mcp` server (28 tools), scoped to `ZS_WORKSPACE_ROOT`. Linux only; stdlib Python plus `websockets` for the bridge.

## Build

No build step. The check is:

```
python3 -m unittest
```

## Run

```
bash Linux_Start.sh
```

The bridge listens on `ws://127.0.0.1:17613`. Keep the terminal open while using the extension.

## Configure a client

Register `workspace_mcp.py` with `ZS_WORKSPACE_ROOT` set to the project folder:

```json
{
  "mcpServers": {
    "repo": {
      "command": "/usr/bin/python3",
      "args": ["/path/to/workspace_mcp.py"],
      "env": { "ZS_WORKSPACE_ROOT": "/path/to/project" }
    }
  }
}
```

Or generate `config.json` locally:

```
bash Linux_Start.sh   # runs setup-config.py, writing the `repo` entry
```

## Add a target

Edit `config.json` `mcpServers`. Server ids must match `[A-Za-z0-9._-]{1,64}`; `vscode`, `roblox`, `effectcraft` no longer exist.

## Sync upstream

```
bash sync-upstream.sh
```

Merge policy (see script header): purged artifacts stay deleted; renamed files (`vscode_mcp.py` -> `workspace_mcp.py`) are resolved by hand.

## Troubleshoot

- Missing root: `get_root()` raises `Configured workspace root is not set.` Set `ZS_WORKSPACE_ROOT`.
- Port in use: `Linux_Start.sh` refuses a non-bridge process on `17613`; set `ZS_BRIDGE_PORT` or close that process.
- Server listed with 0 tools: restart the bridge (`restart_mcp`) so the catalog rebuilds.
