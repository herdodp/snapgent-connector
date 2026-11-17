#!/usr/bin/env python3
"""Cross-platform local WebSocket bridge for Snapgent MCP servers."""

import asyncio
import contextlib
import json
import logging
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import websockets
except ImportError:
    websockets = None


if getattr(sys, "frozen", False):
    # PyInstaller build: config.json and logs live next to the .exe, not in the temp extraction dir.
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
LOG_PATH = ROOT / "logs" / "bridge_debug.log"
HOST = "127.0.0.1"
PORT = int(os.environ.get("ZS_BRIDGE_PORT", "17613"))
# Live progress channel: GET /events (SSE) + GET /status on a plain HTTP port next to
# the websocket, so any consumer (curl, browser, an API wrapper) can watch what the
# bridge is doing while a tool call is still running instead of waiting for the result.
STREAM_PORT = int(os.environ.get("ZS_BRIDGE_STREAM_PORT", str(PORT + 1)))
STREAM_BACKLOG = 200
MCP_PROTOCOL_VERSION = "2024-11-05"
BRIDGE_VERSION = "3.9.7"
MAX_LOG_CHARS = 1000
MAX_CONCURRENT_REQUESTS = 32
BIG_PAYLOAD_THREAD_BYTES = 256 * 1024
# Transport-level replay guard. Two live extension instances can share this bridge
# (the daily Chrome and the CDP test Chrome both load the same unpacked folder), and
# a stale instance keeps re-sending one identical call - measured: the same
# `list_dir` every 30-40 s for over an hour because that process still runs the old
# bundle in memory. Re-running it cannot yield new information, so an identical call
# that arrives AGAIN right after itself is answered from the previous result.
# Deliberately narrow: only a consecutive repeat (list_dir -> write_file -> list_dir
# is never suppressed) and only within this window.
DUPLICATE_CALL_TTL = 300.0

LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)


def log(message: str) -> None:
    logging.info(message)
    print(message, flush=True)


def _json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class MCPServer:
    def __init__(self, server_id: str, config: Dict[str, Any]) -> None:
        self.server_id = server_id
        self.config = config
        self.process: Optional[asyncio.subprocess.Process] = None
        self.tools: List[Dict[str, Any]] = []
        self._next_id = 1
        self._pending: Dict[int, asyncio.Future] = {}
        self._write_lock = asyncio.Lock()
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._start_lock = asyncio.Lock()
        self.error: Optional[str] = None
        self.ready = False

    @property
    def alive(self) -> bool:
        reader_dead = bool(self._reader_task and self._reader_task.done())
        return bool(self.process and self.process.returncode is None and not reader_dead)

    async def start(self) -> bool:
        async with self._start_lock:
            if self.alive and self.ready:
                return True
            await self.stop()
            command = self.config.get("command")
            args = self.config.get("args", [])
            if not isinstance(command, str) or not command.strip():
                self.error = "MCP server command is missing."
                log(f"[{self.server_id}] {self.error}")
                return False
            if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
                self.error = "MCP server args must be an array of strings."
                log(f"[{self.server_id}] {self.error}")
                return False

            env = os.environ.copy()
            server_env = self.config.get("env", {})
            if not isinstance(server_env, dict):
                self.error = "MCP server env must be an object."
                log(f"[{self.server_id}] {self.error}")
                return False
            env.update({str(key): str(value) for key, value in server_env.items()})
            try:
                self.process = await asyncio.create_subprocess_exec(
                    command,
                    *args,
                    cwd=str(ROOT),
                    env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=128 * 1024 * 1024,
                )
            except (OSError, ValueError) as error:
                self.error = str(error)
                log(f"[{self.server_id}] failed to launch: {self.error}")
                return False

            self.tools = []
            self.error = None
            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
            try:
                await self._request(
                    "initialize",
                    {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "snapgent-bridge", "version": BRIDGE_VERSION},
                    },
                    timeout=12,
                )
                await self._notify("notifications/initialized")
                result = await self._request("tools/list", {}, timeout=20)
                raw_tools = result.get("tools", []) if isinstance(result, dict) else []
                if not isinstance(raw_tools, list):
                    raise RuntimeError("MCP tools/list returned an invalid tool list.")
                self.tools = [
                    tool for tool in raw_tools
                    if isinstance(tool, dict) and isinstance(tool.get("name"), str)
                ]
                self.ready = True
                log(f"[{self.server_id}] MCP server up ({len(self.tools)} tools advertised)")
                return True
            except (asyncio.TimeoutError, RuntimeError, OSError, ValueError) as error:
                self.error = str(error)
                log(f"[{self.server_id}] MCP startup failed: {self.error}")
                await self.stop()
                return False

    async def stop(self) -> None:
        process = self.process
        self.process = None
        self.tools = []
        self.ready = False
        for task in (self._reader_task, self._stderr_task):
            if task and not task.done():
                task.cancel()
        tasks = [task for task in (self._reader_task, self._stderr_task) if task]
        self._reader_task = None
        self._stderr_task = None
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError(f"{self.server_id} MCP server stopped."))
        self._pending.clear()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if not process or process.returncode is not None:
            return
        if process.stdin:
            try:
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def _send(self, payload: Dict[str, Any]) -> None:
        process = self.process
        if not process or process.returncode is not None or not process.stdin:
            raise RuntimeError(f"{self.server_id} MCP server is offline.")
        data = (_json_line(payload) + "\n").encode("utf-8")
        async with self._write_lock:
            process.stdin.write(data)
            await process.stdin.drain()

    async def _request(
        self, method: str, params: Dict[str, Any], timeout: float = 30
    ) -> Any:
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                }
            )
            response = await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)
        if "error" in response:
            detail = response["error"]
            if isinstance(detail, dict):
                raise RuntimeError(str(detail.get("message") or detail))
            raise RuntimeError(str(detail))
        return response.get("result")

    async def _notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        await self._send(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
            }
        )

    async def call_tool(
        self, tool_name: str, arguments: Dict[str, Any], timeout: float
    ) -> Dict[str, Any]:
        if not self.alive:
            raise RuntimeError(self.error or f"{self.server_id} MCP server is offline.")
        result = await self._request(
            "tools/call",
            {"name": tool_name, "arguments": arguments},
            timeout=timeout,
        )
        return result if isinstance(result, dict) else {"content": [{"text": str(result)}]}

    async def _read_stdout(self) -> None:
        process = self.process
        if not process or not process.stdout:
            return
        try:
            while True:
                try:
                    line = await process.stdout.readline()
                except ValueError:
                    # Response line exceeded the stream limit. Discard the rest of it,
                    # fail waiting requests with a clear error, and keep the server alive.
                    log(f"[{self.server_id}] MCP response exceeded the buffer limit; discarding it.")
                    while True:
                        chunk = await process.stdout.read(1024 * 1024)
                        if not chunk or b"\n" in chunk:
                            break
                    for future in list(self._pending.values()):
                        if not future.done():
                            future.set_exception(
                                RuntimeError(
                                    f"{self.server_id} MCP response was too large (over 128 MB). "
                                    "Request a smaller range or fewer items."
                                )
                            )
                    continue
                if not line:
                    break
                try:
                    if len(line) > BIG_PAYLOAD_THREAD_BYTES:
                        message = await asyncio.to_thread(lambda raw=line: json.loads(raw.decode("utf-8")))
                    else:
                        message = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    log(f"[{self.server_id}] ignored non-JSON MCP stdout.")
                    continue
                request_id = message.get("id")
                if isinstance(request_id, int):
                    future = self._pending.get(request_id)
                    if future and not future.done():
                        future.set_result(message)
        except asyncio.CancelledError:
            raise
        except (ValueError, asyncio.LimitOverrunError) as error:
            log(f"[{self.server_id}] MCP stdout read failed: {error}")
        finally:
            if self.process is process and process.returncode is None:
                log(f"[{self.server_id}] MCP stdout closed.")
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(RuntimeError(f"{self.server_id} MCP server disconnected."))

    async def _read_stderr(self) -> None:
        process = self.process
        if not process or not process.stderr:
            return
        try:
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    log(f"[{self.server_id}] stderr: {text[:MAX_LOG_CHARS]}")
        except asyncio.CancelledError:
            raise


class EventHub:
    """Fan-out of bridge progress frames to HTTP (SSE) and websocket consumers.

    Nothing here changes the tool result path: a frame is advisory only, so a slow or
    absent subscriber can never block or fail a tool call.
    """

    def __init__(self, backlog: int = STREAM_BACKLOG) -> None:
        self._backlog = backlog
        self._recent: List[Dict[str, Any]] = []
        self._subs: set = set()
        self._seq = 0
        self._busy: Dict[str, Dict[str, Any]] = {}

    def snapshot(self) -> Dict[str, Any]:
        return {
            "seq": self._seq,
            "queue": len(self._busy),
            "busy": [dict(entry) for entry in self._busy.values()],
            "subscribers": len(self._subs),
        }

    def publish(self, event: str, **payload: Any) -> Dict[str, Any]:
        self._seq += 1
        frame = {"seq": self._seq, "at": time.time(), "event": event, **payload}
        self._recent.append(frame)
        if len(self._recent) > self._backlog:
            del self._recent[: len(self._recent) - self._backlog]
        for queue in list(self._subs):
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                # A stalled reader loses frames; it must never stall the bridge.
                pass
        return frame

    def begin(self, call_id: Any, tool: Optional[str], **extra: Any) -> Dict[str, Any]:
        entry = {"id": call_id, "tool": tool, "started": time.time(), **extra}
        self._busy[str(call_id)] = entry
        return self.publish("tool_start", **entry)

    def end(self, call_id: Any, ok: bool = True, **extra: Any) -> Dict[str, Any]:
        entry = self._busy.pop(str(call_id), {})
        started = entry.get("started", time.time())
        frame = {
            "id": call_id,
            "tool": entry.get("tool"),
            "ok": bool(ok),
            "ms": int((time.time() - started) * 1000),
            **extra,
        }
        return self.publish("tool_end", **frame)

    def busy_for(self, call_id: Any) -> Optional[Dict[str, Any]]:
        return self._busy.get(str(call_id))

    @contextlib.asynccontextmanager
    async def subscribe(self, since: int = 0):
        queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
        for frame in self._recent:
            if frame["seq"] > since:
                try:
                    queue.put_nowait(frame)
                except asyncio.QueueFull:
                    break
        self._subs.add(queue)
        try:
            yield queue
        finally:
            self._subs.discard(queue)


class Bridge:
    def __init__(self) -> None:
        self.servers: Dict[str, MCPServer] = {}
        self.clients = set()
        self._client_lock = asyncio.Lock()
        self._catalog: List[Dict[str, Any]] = []
        self._last_studio: Optional[bool] = None
        self.hub = EventHub()

    def load_config(self) -> Dict[str, Dict[str, Any]]:
        if not CONFIG_PATH.exists():
            return {}
        try:
            config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Could not read {CONFIG_PATH.name}: {error}") from error
        servers = config.get("mcpServers") if isinstance(config, dict) else None
        if not isinstance(servers, dict):
            raise RuntimeError(f"{CONFIG_PATH.name} must contain an object named mcpServers.")
        return {
            server_id: value
            for server_id, value in servers.items()
            if isinstance(server_id, str)
            and isinstance(value, dict)
            and re.fullmatch(r"[A-Za-z0-9._-]{1,64}", server_id)
        }

    async def start_servers(self) -> None:
        config = self.load_config()
        self.servers = {
            server_id: MCPServer(server_id, server_config)
            for server_id, server_config in config.items()
        }
        async def _start_one(server: MCPServer) -> None:
            try:
                await server.start()
            except Exception as error:
                server.error = str(error)
                log(f"[{server.server_id}] unexpected startup error: {error}")
            # Publish each server as soon as it is ready so slow ones do not block the rest.
            self._rebuild_catalog()
            await self.broadcast(self._connected_message())

        await asyncio.gather(*(_start_one(server) for server in self.servers.values()))
        self._rebuild_catalog()
        self._log_health()

    async def stop_servers(self) -> None:
        await asyncio.gather(*(server.stop() for server in self.servers.values()))
        self.servers.clear()
        self._catalog = []

    def _rebuild_catalog(self) -> None:
        entries = []
        for server in self.servers.values():
            if server.alive:
                entries.extend((server.server_id, tool) for tool in server.tools)
        name_counts: Dict[str, int] = {}
        for _, tool in entries:
            name_counts[tool["name"]] = name_counts.get(tool["name"], 0) + 1
        self._catalog = []
        for server_id, tool in entries:
            bare_name = tool["name"]
            name = f"{server_id}/{bare_name}" if name_counts[bare_name] > 1 else bare_name
            self._catalog.append(
                {
                    "name": name,
                    "server": server_id,
                    "description": tool.get("description", ""),
                    "inputSchema": tool.get("inputSchema", {"type": "object", "properties": {}}),
                }
            )

    def _server_status(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": server.server_id,
                "alive": server.alive,
                "tools": len(server.tools) if server.alive else 0,
            }
            for server in self.servers.values()
        ]

    def _log_health(self) -> None:
        ids = ", ".join(self.servers) or "none"
        active = ", ".join(server.server_id for server in self.servers.values() if server.alive) or "none"
        log(f"configured {len(self.servers)} MCP server(s): {ids}  (active: {active})")
        total = len(self._catalog)
        log(f"ready {total} tools available ({len(self.servers)} MCP server(s))")

    def _connected_message(self) -> Dict[str, Any]:
        return {
            "type": "connected",
            "bridge_version": BRIDGE_VERSION,
            "mcp_alive": any(server.alive for server in self.servers.values()),
            "tools": self._catalog,
            "servers": self._server_status(),
        }

    async def broadcast(self, message: Dict[str, Any]) -> None:
        async with self._client_lock:
            clients = list(self.clients)
        if not clients:
            return
        await asyncio.gather(
            *(self._send_client(client, message) for client in clients),
            return_exceptions=True,
        )

    async def _send_client(self, client: Any, message: Dict[str, Any]) -> None:
        try:
            text = message.get("text") if isinstance(message, dict) else None
            heavy = bool(
                isinstance(message, dict)
                and (
                    (isinstance(text, str) and len(text) > BIG_PAYLOAD_THREAD_BYTES)
                    or message.get("images")
                )
            )
            payload = await asyncio.to_thread(_json_line, message) if heavy else _json_line(message)
            await client.send(payload)
        except Exception as error:
            log(f"send to client failed: {type(error).__name__}: {str(error)[:200]}")

    async def handle_client(self, websocket: Any, _path: Optional[str] = None) -> None:
        async with self._client_lock:
            self.clients.add(websocket)
        try:
            _hdr = {}
            _req = getattr(websocket, "request", None)
            if _req is not None and getattr(_req, "headers", None) is not None:
                _hdr = {k: _req.headers.get(k) for k in ("Origin", "User-Agent", "Sec-WebSocket-Protocol")}
            _peer = getattr(websocket, "remote_address", None)
        except Exception:
            _hdr, _peer = {}, None
        log(f"extension connected path={_path!r} peer={_peer} nclients={len(self.clients)} hdr={_hdr}")
        await self._send_client(websocket, self._connected_message())
        pending: set = set()
        limiter = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

        async def _run(request: Dict[str, Any]) -> None:
            async with limiter:
                try:
                    await self._handle_request(websocket, request)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    log(f"request handler error: {error}")
                    await self._send_client(
                        websocket,
                        {
                            "type": "tool_result",
                            "id": request.get("id"),
                            "ok": False,
                            "kind": "tool_error",
                            "error": f"Bridge error: {error}",
                        },
                    )

        try:
            async for raw in websocket:
                try:
                    if len(raw) > BIG_PAYLOAD_THREAD_BYTES:
                        request = await asyncio.to_thread(json.loads, raw)
                    else:
                        request = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    await self._send_client(websocket, {"type": "error", "error": "Invalid JSON request."})
                    continue
                if not isinstance(request, dict):
                    await self._send_client(websocket, {"type": "error", "error": "Request must be a JSON object."})
                    continue
                task = asyncio.create_task(_run(request))
                pending.add(task)
                task.add_done_callback(pending.discard)
        finally:
            for task in list(pending):
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            async with self._client_lock:
                self.clients.discard(websocket)
            log("extension disconnected")

    async def _handle_request(self, websocket: Any, request: Dict[str, Any]) -> None:
        request_id = request.get("id")
        kind = request.get("type")
        if kind == "call_tool":
            try:
                peer = getattr(websocket, "remote_address", None)
            except Exception:
                peer = None
            log(f"[call] conn={id(websocket) % 100000} peer={peer} keys={sorted(request.keys())}")
        if kind == "ping":
            await self._send_client(websocket, {"type": "pong", "id": request_id})
        elif kind == "studio_status":
            studio, studio_app, studio_proc = await self._studio_status()
            await self._send_client(
                websocket,
                {
                    "type": "studio_status",
                    "id": request_id,
                    "studio": studio,
                    "studio_app": studio_app,
                    "studio_proc": studio_proc,
                },
            )
        elif kind == "list_tools":
            await self._send_client(
                websocket,
                {
                    **self._connected_message(),
                    "type": "tools",
                    "id": request_id,
                },
            )
        elif kind == "call_tool":
            await self._call_tool(websocket, request)
        elif kind == "restart_mcp":
            try:
                await self.stop_servers()
                await self.start_servers()
                response = {
                    "type": "mcp_status",
                    "id": request_id,
                    "ok": True,
                    "alive": any(server.alive for server in self.servers.values()),
                    "tools": self._catalog,
                    "servers": self._server_status(),
                }
            except (OSError, RuntimeError) as error:
                response = {"type": "mcp_status", "id": request_id, "ok": False, "alive": False, "error": str(error)}
            await self._send_client(websocket, response)
            await self.broadcast(self._connected_message())
        elif kind == "add_server":
            await self._change_server(websocket, request, remove=False)
        elif kind == "remove_server":
            await self._change_server(websocket, request, remove=True)
        elif kind in ("stream", "progress"):
            # Fire-and-forget progress frame (from the extension or any client): relay it
            # to every websocket client and to the HTTP /events subscribers. No reply is
            # sent - the sender already moved on, and a reply would look like a result.
            nested = request.get("frame")
            payload = {k: v for k, v in request.items() if k not in ("type", "frame", "id")}
            if isinstance(nested, dict):
                payload.update(nested)
            event = payload.pop("event", None) or ("stream" if kind == "stream" else "progress")
            self.hub.publish(str(event), **payload)
        elif kind == "stream_status":
            await self._send_client(
                websocket,
                {"type": "stream_status", "id": request_id, **self.hub.snapshot()},
            )
        else:
            await self._send_client(
                websocket,
                {"type": "error", "id": request_id, "error": f"Unknown bridge request: {kind}"},
            )

    async def _call_tool(self, websocket: Any, request: Dict[str, Any]) -> None:
        request_id = request.get("id")
        name = request.get("name")
        arguments = request.get("arguments") or {}
        timeout = request.get("timeout", 120000)
        if not isinstance(name, str) or not isinstance(arguments, dict):
            await self._send_client(
                websocket,
                {"type": "tool_result", "id": request_id, "ok": False, "error": "Invalid tool call."},
            )
            return
        try:
            timeout_seconds = max(1.0, min(float(timeout) / 1000, 300.0))
        except (TypeError, ValueError):
            timeout_seconds = 120.0
        # Replay guard (see DUPLICATE_CALL_TTL): answer an immediately repeated
        # identical call from the result just produced instead of running it again.
        try:
            sig = json.dumps({"n": name, "a": arguments}, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            sig = None
        last = getattr(self, "_last_call", None)
        if sig and last and last.get("sig") == sig and time.time() - last.get("at", 0) <= DUPLICATE_CALL_TTL:
            cached = dict(last.get("response") or {})
            if cached:
                cached["id"] = request_id
                cached["duplicate"] = True
                await self._send_client(websocket, cached)
                log(f"<- {name} (repeated identical call - answered from the previous result)")
                return
        # Any different call breaks the chain, so an ordinary repeat after real work
        # still runs for real.
        self._last_call = None
        server, tool_name = self._resolve_tool(name)
        # Isolation: the extension states which server is selected. The bridge refuses to
        # run a tool that belongs to any other server (requests without the field keep
        # the old behaviour).
        allowed = request.get("server")
        if isinstance(allowed, str) and allowed:
            if server is None and "/" not in name:
                allowed_server = self.servers.get(allowed)
                if allowed_server and allowed_server.alive and any(t["name"] == name for t in allowed_server.tools):
                    server, tool_name = allowed_server, name
            if server is not None and server.server_id != allowed:
                await self._send_client(
                    websocket,
                    {
                        "type": "tool_result",
                        "id": request_id,
                        "ok": False,
                        "kind": "unknown_tool",
                        "error": f"MCP tool not available for the selected server: {name}",
                    },
                )
                return
        if not server:
            await self._send_client(
                websocket,
                {
                    "type": "tool_result",
                    "id": request_id,
                    "ok": False,
                    "kind": "unknown_tool",
                    "error": f"Unknown or unavailable MCP tool: {name}",
                },
            )
            return
        call_id = request_id if request_id is not None else f"{tool_name}-{int(time.time() * 1000)}"
        self.hub.begin(call_id, name, server=server.server_id)
        try:
            result = await server.call_tool(tool_name, arguments, timeout_seconds)
            text_parts = []
            images = []
            for item in result.get("content", []):
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    text_parts.append(item["text"])
                elif item.get("type") == "image" and isinstance(item.get("data"), str):
                    images.append(
                        {
                            "data": item["data"],
                            "mimeType": item.get("mimeType", "image/png"),
                        }
                    )
            structured = result.get("structuredContent")
            if not text_parts and structured is not None:
                text_parts.append(json.dumps(structured, ensure_ascii=False))
            text = "\n".join(text_parts)
            if result.get("isError"):
                await self._send_client(
                    websocket,
                    {"type": "tool_result", "id": request_id, "ok": False, "error": text or "MCP tool failed."},
                )
            else:
                response = {"type": "tool_result", "id": request_id, "ok": True, "text": text, "images": images}
                await self._send_client(websocket, response)
                if sig:
                    self._last_call = {
                        "sig": sig,
                        "at": time.time(),
                        "response": {"type": "tool_result", "ok": True, "text": text, "images": images},
                    }
            self.hub.end(call_id, ok=not result.get("isError"), chars=len(text))
            log(f"<- {name} ({text[:120].replace(chr(10), ' ')})")
        except (asyncio.TimeoutError, RuntimeError, OSError, ValueError) as error:
            message = str(error)
            self.hub.end(call_id, ok=False, error=message[:200])
            await self._send_client(
                websocket,
                {
                    "type": "tool_result",
                    "id": request_id,
                    "ok": False,
                    "kind": "timeout" if isinstance(error, asyncio.TimeoutError) else "tool_error",
                    "error": message,
                },
            )
            log(f"<- {name} ERROR: {message[:MAX_LOG_CHARS]}")

    def _resolve_tool(self, name: str) -> Tuple[Optional[MCPServer], str]:
        if "/" in name:
            server_id, bare_name = name.split("/", 1)
            server = self.servers.get(server_id)
            if server and server.alive and any(tool["name"] == bare_name for tool in server.tools):
                return server, bare_name
        matches = [
            (server, tool)
            for server in self.servers.values()
            if server.alive
            for tool in server.tools
            if tool["name"] == name
        ]
        if len(matches) == 1:
            return matches[0][0], name
        return None, name

    async def _studio_status(self) -> Tuple[Optional[bool], Optional[bool], Optional[bool]]:
        studio_server = self.servers.get("roblox")
        studio_proc = await _process_running("RobloxStudioBeta.exe" if os.name == "nt" else "RobloxStudio")
        if not studio_server or not studio_server.alive:
            return None, None, studio_proc
        if not any(tool["name"] == "get_studio_state" for tool in studio_server.tools):
            return None, None, studio_proc
        try:
            result = await studio_server.call_tool("get_studio_state", {}, 8)
        except (asyncio.TimeoutError, RuntimeError, OSError, ValueError):
            return False, studio_proc, studio_proc
        text = " ".join(
            item.get("text", "")
            for item in result.get("content", [])
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
        if result.get("isError") or re.search(
            r"Unable to find an active Studio instance|previously active Studio has disconnected",
            text,
            re.IGNORECASE,
        ):
            return False, studio_proc, studio_proc
        return True, True, studio_proc

    async def _change_server(
        self, websocket: Any, request: Dict[str, Any], remove: bool
    ) -> None:
        request_id = request.get("id")
        server_id = request.get("server_id")
        if (
            not isinstance(server_id, str)
            or server_id == "roblox"
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", server_id)
        ):
            await self._send_client(
                websocket,
                {"type": "server_changed", "id": request_id, "ok": False, "error": "Invalid or protected MCP server id."},
            )
            return
        try:
            config = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
            servers = config.setdefault("mcpServers", {})
            if not isinstance(servers, dict):
                raise RuntimeError("mcpServers must be a JSON object.")
            if remove:
                if server_id == "vscode":
                    raise RuntimeError("The VS Code MCP server cannot be removed.")
                servers.pop(server_id, None)
            else:
                command = request.get("command")
                args = request.get("args", [])
                env = request.get("env", {})
                if not isinstance(command, str) or not command.strip():
                    raise RuntimeError("MCP server command is required.")
                if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
                    raise RuntimeError("MCP server args must be an array of strings.")
                if not isinstance(env, dict) or not all(isinstance(k, str) for k in env):
                    raise RuntimeError("MCP server env must be an object.")
                servers[server_id] = {"command": command, "args": args, "env": env}
            temp_path = CONFIG_PATH.with_suffix(".json.tmp")
            temp_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            temp_path.replace(CONFIG_PATH)
            await self.stop_servers()
            await self.start_servers()
            await self._send_client(
                websocket,
                {"type": "server_changed", "id": request_id, "ok": True, "restarting": False},
            )
            await self.broadcast(self._connected_message())
        except (OSError, json.JSONDecodeError, RuntimeError) as error:
            await self._send_client(
                websocket,
                {"type": "server_changed", "id": request_id, "ok": False, "error": str(error)},
            )


async def _process_running(process_name: str) -> Optional[bool]:
    try:
        if os.name == "nt":
            result = await asyncio.to_thread(
                subprocess_run,
                ["tasklist", "/FI", f"IMAGENAME eq {process_name}", "/NH"],
                5,
            )
            return process_name.lower() in result.lower()
        result = await asyncio.to_thread(subprocess_run, ["pgrep", "-f", process_name], 5)
        return bool(result.strip())
    except (OSError, subprocess.TimeoutExpired):
        return None


def subprocess_run(command: List[str], timeout: int) -> str:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    return result.stdout


async def _start_stream_server(hub: "EventHub") -> Any:
    """Plain HTTP side channel so progress can be watched while a call is still running.

    GET /events (SSE, also /stream) replays the recent backlog then streams live frames;
    GET /status gives a one-shot snapshot; POST /push lets any local process publish a
    frame. Every write is advisory - a dead reader can never fail a tool call.
    """
    from aiohttp import web

    async def events(request: Any) -> Any:
        try:
            since = int(request.query.get("since", "0"))
        except (TypeError, ValueError):
            since = 0
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)
        async with hub.subscribe(since) as queue:
            await response.write(b": connected\n\n")
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    await response.write(b": ping\n\n")
                    continue
                except asyncio.CancelledError:
                    raise
                body = json.dumps(frame, ensure_ascii=False)
                chunk = f"id: {frame['seq']}\nevent: {frame['event']}\ndata: {body}\n\n"
                await response.write(chunk.encode("utf-8"))
        return response

    async def status(request: Any) -> Any:
        return web.json_response({"version": BRIDGE_VERSION, **hub.snapshot()})

    async def push(request: Any) -> Any:
        try:
            frame = await request.json()
        except (json.JSONDecodeError, ValueError):
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)
        if not isinstance(frame, dict):
            return web.json_response({"ok": False, "error": "object expected"}, status=400)
        event = frame.pop("event", "stream")
        hub.publish(str(event), **frame)
        return web.json_response({"ok": True, **hub.snapshot()})

    app = web.Application()
    app.router.add_get("/events", events)
    app.router.add_get("/stream", events)
    app.router.add_get("/status", status)
    app.router.add_post("/push", push)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, HOST, STREAM_PORT)
    await site.start()
    log(f"progress channel: http://{HOST}:{STREAM_PORT}/events (SSE), /status, POST /push")
    return runner


async def run() -> None:
    if websockets is None:
        raise RuntimeError(
            "The 'websockets' package is required. Install it with "
            f"'{sys.executable} -m pip install websockets'."
        )
    bridge = Bridge()
    server = await websockets.serve(
        bridge.handle_client,
        HOST,
        PORT,
        max_size=128 * 1024 * 1024,
        max_queue=256,
        ping_interval=20,
        ping_timeout=90,
    )
    log(f"snapgent bridge v{BRIDGE_VERSION}")
    log(f"listening on ws://{HOST}:{PORT} - load the extension and open a supported AI chat")
    stream_runner = None
    try:
        stream_runner = await _start_stream_server(bridge.hub)
    except Exception as error:  # never let the side channel stop the bridge
        log(f"progress channel disabled: {type(error).__name__}: {error}")
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    async def _startup_then_monitor() -> None:
        # Servers start in parallel after the websocket is already listening;
        # the monitor only begins once the initial startup has finished.
        try:
            await bridge.start_servers()
        except RuntimeError as error:
            log(f"config error: {error}")
        await _monitor_servers(bridge)

    monitor_task = asyncio.create_task(_startup_then_monitor())
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await stop_event.wait()
    finally:
        monitor_task.cancel()
        await asyncio.gather(monitor_task, return_exceptions=True)
        if stream_runner is not None:
            await stream_runner.cleanup()
        server.close()
        await server.wait_closed()
        await bridge.stop_servers()
        log("bridge stopped")


async def _monitor_servers(bridge: Bridge) -> None:
    failures: Dict[str, int] = {}
    next_try: Dict[str, float] = {}

    def _state() -> Tuple[Tuple[str, bool], ...]:
        return tuple(sorted((s.server_id, s.alive) for s in bridge.servers.values()))

    last_state = _state()
    while True:
        await asyncio.sleep(5)
        for server in list(bridge.servers.values()):
            sid = server.server_id
            if server.alive:
                failures.pop(sid, None)
                next_try.pop(sid, None)
                continue
            if time.monotonic() < next_try.get(sid, 0.0):
                continue
            count = failures.get(sid, 0)
            if count < 3 or count % 20 == 0:
                log(f"[{sid}] MCP server disconnected; restarting (attempt {count + 1}).")
            try:
                ok = await server.start()
            except Exception as error:
                server.error = str(error)
                log(f"[{sid}] unexpected restart error: {error}")
                ok = False
            if ok:
                failures.pop(sid, None)
                next_try.pop(sid, None)
            else:
                failures[sid] = count + 1
                delay = min(300.0, 5.0 * (2 ** min(count, 6)))
                next_try[sid] = time.monotonic() + delay
        state = _state()
        if state != last_state:
            last_state = state
            bridge._rebuild_catalog()
            bridge._log_health()
            await bridge.broadcast(bridge._connected_message())


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except (OSError, RuntimeError, ValueError) as error:
        log(f"FATAL: {error}")
        raise SystemExit(1)
