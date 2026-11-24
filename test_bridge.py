import asyncio
import contextlib
import importlib.util
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import bridge


MOCK_MCP = r"""
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "mock", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [{
                "name": "echo",
                "description": "Echo a message",
                "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}},
            }]
        }
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": request["params"]["arguments"]["message"]}]}
    else:
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": -32601, "message": "Method not found"},
        }), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
"""


MOCK_SLOW_MCP = "import time\n" + MOCK_MCP.replace(
    '    elif method == "tools/call":\n',
    '    elif method == "tools/call":\n'
    '        time.sleep(float(request["params"]["arguments"].get("delay", 0)))\n',
)


# Speaks MCP 2025-03-26 instead of echoing the client's revision, and behaves like a
# spec-compliant server that uses the bidirectional channel: it pings the client and
# asks for elicitation before answering tools/list, then adds a tool at runtime and
# announces it with notifications/tools/list_changed.
MOCK_MCP_COMPAT = r"""
import json
import sys

state = {"ping_ok": False, "elicit_rejected": False, "swapped": False}
pending_list = []


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def tools_result():
    tools = [{
        "name": "echo",
        "description": "Echo a message",
        "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}},
    }]
    if state["ping_ok"]:
        tools.append({"name": "ping_ok", "description": "Client answered ping", "inputSchema": {"type": "object", "properties": {}}})
    if state["elicit_rejected"]:
        tools.append({"name": "elicit_rejected", "description": "Client rejected elicitation", "inputSchema": {"type": "object", "properties": {}}})
    if state["swapped"]:
        tools.append({"name": "extra_tool", "description": "Added at runtime", "inputSchema": {"type": "object", "properties": {}}})
    return {"tools": tools}


def flush_pending():
    if state["ping_ok"] and state["elicit_rejected"]:
        while pending_list:
            emit({"jsonrpc": "2.0", "id": pending_list.pop(0), "result": tools_result()})


for line in sys.stdin:
    try:
        request = json.loads(line)
    except Exception:
        continue
    if request.get("method") is None:
        if request.get("id") == "srv-ping" and request.get("result") == {}:
            state["ping_ok"] = True
            flush_pending()
        elif request.get("id") == "srv-elicit":
            error = request.get("error") or {}
            state["elicit_rejected"] = error.get("code") == -32601
            flush_pending()
        continue
    if "id" not in request:
        continue
    method = request.get("method")
    request_id = request.get("id")
    if method == "initialize":
        emit({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": "2025-03-26",
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": {"name": "mock-compat", "version": "1"},
        }})
        emit({"jsonrpc": "2.0", "id": "srv-ping", "method": "ping", "params": {}})
        emit({"jsonrpc": "2.0", "id": "srv-elicit", "method": "elicitation/create", "params": {"message": "need input"}})
    elif method == "tools/list":
        if state["ping_ok"] and state["elicit_rejected"]:
            emit({"jsonrpc": "2.0", "id": request_id, "result": tools_result()})
        else:
            pending_list.append(request_id)
    elif method == "tools/call":
        message = request.get("params", {}).get("arguments", {}).get("message", "")
        emit({"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": message or "ok"}]}})
        if message == "swap":
            state["swapped"] = True
            emit({"jsonrpc": "2.0", "method": "notifications/tools/list_changed", "params": {}})
    else:
        emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})
"""


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    @contextlib.asynccontextmanager
    async def _ws_client(self, root, script):
        mock_path = root / "mock_mcp.py"
        mock_path.write_text(script, encoding="utf-8")
        config_path = root / "config.json"
        config_path.write_text(
            json.dumps(
                {"mcpServers": {"mock": {"command": sys.executable, "args": [str(mock_path)], "env": {}}}}
            ),
            encoding="utf-8",
        )
        manager = bridge.Bridge()
        with patch.object(bridge, "CONFIG_PATH", config_path):
            await manager.start_servers()
            try:
                async with bridge.websockets.serve(
                    manager.handle_client, "127.0.0.1", 0, max_size=None
                ) as server:
                    port = server.sockets[0].getsockname()[1]
                    async with bridge.websockets.connect(
                        f"ws://127.0.0.1:{port}", max_size=None
                    ) as client:
                        await client.recv()  # initial "connected" message
                        yield client
            finally:
                await manager.stop_servers()

    async def test_stdio_mcp_start_list_call_and_stop(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                self.assertTrue(server.alive)
                self.assertEqual([tool["name"] for tool in server.tools], ["echo"])
                result = await server.call_tool("echo", {"message": "hello"}, 2)
                self.assertEqual(result["content"][0]["text"], "hello")
            finally:
                await server.stop()
            self.assertFalse(server.alive)

    def test_redact_mcp_url_hides_every_credential_parameter(self):
        # A server chooses its own query parameter name, so redaction cannot rely on
        # five known names: `password` and `client_secret` used to reach the log in
        # plain text (owner review 2026-11-25).
        url = (
            "wss://user:usersecret@example.test/ws"
            "?token=tok-value-1&password=pass-value-1&client_secret=secret-value-1"
            "&x-api-key=key-value-1&signature=sig-value-1&transport=websocket"
        )
        redacted = bridge._redact_mcp_url(url)
        for secret in ("usersecret", "tok-value-1", "pass-value-1", "secret-value-1", "key-value-1", "sig-value-1"):
            self.assertNotIn(secret, redacted)
        self.assertNotIn("secret-value-1", redacted)
        self.assertEqual(redacted.count("<redacted>"), 6)
        # A parameter that is not a credential stays readable, otherwise the log
        # cannot be used to tell one server's transport from another's.
        self.assertIn("transport=websocket", redacted)
        self.assertEqual(bridge._redact_mcp_url(123), 123)

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_url_mcp_server_starts_and_never_logs_the_credential(self):
        # The REAL url transport: MCPServer connects to a live MCP-over-WebSocket
        # server, so the redaction is exercised on the path that actually logs the
        # url (startup line) rather than on a helper in isolation.
        async def upstream(websocket, _path=None):
            async for raw in websocket:
                request = json.loads(raw)
                if "id" not in request:
                    continue
                method = request.get("method")
                if method == "initialize":
                    result = {
                        "protocolVersion": request["params"]["protocolVersion"],
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "urlmock", "version": "1"},
                    }
                elif method == "tools/list":
                    result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
                else:
                    result = {}
                await websocket.send(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}))

        logged = []
        with patch.object(bridge, "log", side_effect=lambda message: logged.append(str(message))):
            async with bridge.websockets.serve(upstream, "127.0.0.1", 0, max_size=None) as ws_server:
                port = ws_server.sockets[0].getsockname()[1]
                url = (
                    f"ws://127.0.0.1:{port}/ws?token=tok-value-2"
                    "&password=pass-value-2&client_secret=secret-value-2&transport=websocket"
                )
                server = bridge.MCPServer("urlmock", {"url": url})
                try:
                    self.assertTrue(await server.start())
                    self.assertTrue(server.ready)
                    self.assertEqual([tool["name"] for tool in server.tools], ["echo"])
                finally:
                    await server.stop()
        joined = "\n".join(logged)
        self.assertIn("MCP server up over websocket", joined)
        for secret in ("tok-value-2", "pass-value-2", "secret-value-2"):
            self.assertNotIn(secret, joined)
        self.assertIn("<redacted>", joined)

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_url_transport_error_does_not_leak_the_credential(self):
        # websockets puts the whole URI into an InvalidURI message, so a failed start
        # is the other place a credential would escape into `self.error` and the log.
        logged = []
        with patch.object(bridge, "log", side_effect=lambda message: logged.append(str(message))):
            server = bridge.MCPServer(
                "badurl",
                {"url": "ws://127.0.0.1:99999/ws?password=leaky-pass-1&token=leaky-tok-1"},
            )
            self.assertFalse(await server.start())
        joined = "\n".join(logged) + "\n" + str(server.error)
        self.assertNotIn("leaky-pass-1", joined)
        self.assertNotIn("leaky-tok-1", joined)

    async def test_mcp_server_initiated_requests_are_answered(self):
        # A 2025-03-26 server may ping the client and ask for elicitation before it
        # answers tools/list. Ignoring those requests leaves the server blocked, so
        # startup only succeeds here when ping is answered and elicitation is rejected.
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_compat.py"
            mock_path.write_text(MOCK_MCP_COMPAT, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                self.assertEqual(server.protocol_version, "2025-03-26")
                names = [tool["name"] for tool in server.tools]
                self.assertIn("ping_ok", names)
                self.assertIn("elicit_rejected", names)
            finally:
                await server.stop()

    async def test_mcp_tool_list_refreshes_on_list_changed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_compat.py"
            mock_path.write_text(MOCK_MCP_COMPAT, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                self.assertNotIn("extra_tool", [tool["name"] for tool in server.tools])
                await server.call_tool("echo", {"message": "swap"}, 5)
                deadline = asyncio.get_running_loop().time() + 5
                while "extra_tool" not in [tool["name"] for tool in server.tools]:
                    if asyncio.get_running_loop().time() > deadline:
                        self.fail("tools/list_changed was not applied to the tool list")
                    await asyncio.sleep(0.05)
            finally:
                await server.stop()

    async def test_tool_list_change_republishes_the_bridge_catalog(self):
        # Regression: refresh_tools() only moved MCPServer.tools, so Bridge._catalog —
        # the list the extension is handed — stayed stale and a tool a server added at
        # runtime never reached the UI. Asserted through Bridge, and the broadcast is
        # what proves the extension would actually see it.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_compat.py"
            mock_path.write_text(MOCK_MCP_COMPAT, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {"mcpServers": {"mock": {"command": sys.executable, "args": [str(mock_path)], "env": {}}}}
                ),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    self.assertNotIn("extra_tool", [tool["name"] for tool in manager._catalog])
                    async with bridge.websockets.serve(
                        manager.handle_client, "127.0.0.1", 0, max_size=None
                    ) as server:
                        port = server.sockets[0].getsockname()[1]
                        async with bridge.websockets.connect(
                            f"ws://127.0.0.1:{port}", max_size=None
                        ) as client:
                            await client.recv()  # initial "connected" message
                            await client.send(
                                json.dumps(
                                    {
                                        "id": 1,
                                        "type": "call_tool",
                                        "name": "echo",
                                        "arguments": {"message": "swap"},
                                        "timeout": 5000,
                                    }
                                )
                            )
                            deadline = asyncio.get_running_loop().time() + 5
                            republished = False
                            while asyncio.get_running_loop().time() < deadline:
                                try:
                                    frame = json.loads(
                                        await asyncio.wait_for(client.recv(), timeout=1)
                                    )
                                except asyncio.TimeoutError:
                                    continue
                                if frame.get("type") != "connected":
                                    continue
                                names = [tool["name"] for tool in frame.get("tools", [])]
                                if "extra_tool" in names:
                                    republished = True
                                    break
                            self.assertTrue(
                                republished,
                                "the bridge never broadcast the refreshed catalog",
                            )
                            self.assertIn(
                                "extra_tool", [tool["name"] for tool in manager._catalog]
                            )
                finally:
                    await manager.stop_servers()

    async def test_unknown_protocol_revision_does_not_block_startup(self):
        # A server newer than this client answers with a revision we do not know. The
        # bridge must keep using it instead of failing the whole MCP server, otherwise
        # one MCP package release breaks every tool the assistant could use.
        newer = MOCK_MCP.replace(
            '"protocolVersion": request["params"]["protocolVersion"]',
            '"protocolVersion": "2099-01-01"',
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_mcp.py"
            mock_path.write_text(newer, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                self.assertEqual(server.protocol_version, "2099-01-01")
                self.assertEqual([tool["name"] for tool in server.tools], ["echo"])
            finally:
                await server.stop()

    async def test_large_response_line_is_received(self):
        # Regression: a single JSON line larger than asyncio's default 64 KB
        # stream limit used to kill the stdout reader while the process stayed
        # alive, so every later request timed out.
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                big_message = "x" * 200_000
                result = await server.call_tool("echo", {"message": big_message}, 10)
                self.assertEqual(result["content"][0]["text"], big_message)
                self.assertTrue(server.alive)
                follow_up = await server.call_tool("echo", {"message": "still works"}, 10)
                self.assertEqual(follow_up["content"][0]["text"], "still works")
            finally:
                await server.stop()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_websocket_extension_protocol(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "mock": {
                                "command": sys.executable,
                                "args": [str(mock_path)],
                                "env": {},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    async with bridge.websockets.serve(
                        manager.handle_client, "127.0.0.1", 0
                    ) as server:
                        port = server.sockets[0].getsockname()[1]
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                            connected = json.loads(await client.recv())
                            self.assertEqual(connected["type"], "connected")
                            self.assertEqual(connected["servers"][0]["id"], "mock")

                            await client.send(json.dumps({"id": 1, "type": "list_tools"}))
                            tools = json.loads(await client.recv())
                            self.assertEqual(tools["type"], "tools")
                            self.assertEqual(tools["tools"][0]["server"], "mock")

                            await client.send(
                                json.dumps(
                                    {
                                        "id": 2,
                                        "type": "call_tool",
                                        "name": "echo",
                                        "arguments": {"message": "round trip"},
                                        "timeout": 2000,
                                    }
                                )
                            )
                            result = json.loads(await client.recv())
                            self.assertTrue(result["ok"])
                            self.assertEqual(result["text"], "round trip")
                finally:
                    await manager.stop_servers()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_repeated_identical_call_is_answered_from_previous_result(self):
        # Regression: when ChatGPT re-renders a turn it re-sends the very same tool
        # call, so `list_dir` ran again every ~30 s. A back-to-back identical call
        # must be answered from the result just produced, and a different call in
        # between must break the chain so real work still runs.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "mock": {
                                "command": sys.executable,
                                "args": [str(mock_path)],
                                "env": {},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    mock_server = manager.servers["mock"]
                    calls = []
                    original_call_tool = mock_server.call_tool

                    async def counting_call_tool(tool_name, arguments, timeout):
                        calls.append((tool_name, dict(arguments)))
                        return await original_call_tool(tool_name, arguments, timeout)

                    mock_server.call_tool = counting_call_tool
                    async with bridge.websockets.serve(
                        manager.handle_client, "127.0.0.1", 0
                    ) as server:
                        port = server.sockets[0].getsockname()[1]
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                            await client.recv()  # initial "connected" message
                            payload = {
                                "type": "call_tool",
                                "name": "echo",
                                "arguments": {"message": "same call"},
                                "timeout": 2000,
                                "turn": "convA|1",
                            }

                            await client.send(json.dumps({"id": 1, **payload}))
                            first = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertTrue(first["ok"])
                            self.assertEqual(first["text"], "same call")
                            self.assertFalse(first.get("duplicate"))

                            await client.send(json.dumps({"id": 2, **payload}))
                            second = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertTrue(second["ok"])
                            self.assertEqual(second["text"], "same call")
                            self.assertTrue(second.get("duplicate"))
                            self.assertEqual(second["id"], 2)
                            # The real tool ran once; the repeat came from the cache.
                            self.assertEqual(len(calls), 1)

                            await client.send(
                                json.dumps(
                                    {
                                        "id": 3,
                                        **payload,
                                        "arguments": {"message": "different call"},
                                    }
                                )
                            )
                            third = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertEqual(third["text"], "different call")
                            self.assertFalse(third.get("duplicate"))
                            self.assertEqual(len(calls), 2)

                            # The chain was broken, so the old call runs again.
                            await client.send(json.dumps({"id": 4, **payload}))
                            fourth = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertEqual(fourth["text"], "same call")
                            self.assertFalse(fourth.get("duplicate"))
                            self.assertEqual(len(calls), 3)

                            # This one repeats the call just run, so it is answered
                            # from the cache, and the next one asks for real work.
                            await client.send(json.dumps({"id": 5, **payload}))
                            fifth = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertTrue(fifth.get("duplicate"))
                            self.assertEqual(len(calls), 3)

                            await client.send(json.dumps({"id": 6, **payload, "force": True}))
                            sixth = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertEqual(sixth["text"], "same call")
                            self.assertFalse(sixth.get("duplicate"))
                            self.assertEqual(len(calls), 4)

                        # A second client must not be answered from the first one's
                        # cached result: the replay guard is per connection.
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as other:
                            await other.recv()  # initial "connected" message
                            await other.send(json.dumps({"id": 7, **payload}))
                            seventh = json.loads(await asyncio.wait_for(other.recv(), 5))
                            self.assertEqual(seventh["text"], "same call")
                            self.assertFalse(seventh.get("duplicate"))
                            self.assertEqual(len(calls), 5)
                finally:
                    await manager.stop_servers()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_a_repeated_call_in_a_new_turn_runs_again(self):
        # Regression (review on d2c3bce): the replay cache keyed only on tool +
        # arguments, so an identical call in a LATER turn was answered with the
        # result from up to five minutes earlier. The turn is part of the key now:
        # the same call inside one turn is a retry, in a new turn it is new work.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"mcpServers": {"mock": {"command": sys.executable, "args": [str(mock_path)], "env": {}}}}),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    mock_server = manager.servers["mock"]
                    calls = []
                    original_call_tool = mock_server.call_tool

                    async def counting_call_tool(tool_name, arguments, timeout):
                        calls.append((tool_name, dict(arguments)))
                        return await original_call_tool(tool_name, arguments, timeout)

                    mock_server.call_tool = counting_call_tool
                    async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
                        port = server.sockets[0].getsockname()[1]
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                            await client.recv()  # initial "connected" message
                            payload = {
                                "type": "call_tool",
                                "name": "echo",
                                "arguments": {"message": "same call"},
                                "timeout": 2000,
                                "turn": "convA|1",
                            }
                            await client.send(json.dumps({"id": 1, **payload}))
                            first = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertFalse(first.get("duplicate"))

                            # A retry inside the same turn is answered from the cache.
                            await client.send(json.dumps({"id": 2, **payload}))
                            second = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertTrue(second.get("duplicate"))
                            self.assertEqual(len(calls), 1)

                            # The next turn repeats the call on purpose: it must run.
                            await client.send(json.dumps({"id": 3, **payload, "turn": "convA|2"}))
                            third = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertEqual(third["text"], "same call")
                            self.assertFalse(third.get("duplicate"))
                            self.assertEqual(len(calls), 2)

                            # A client that states no turn cannot use the long cache,
                            # but an identical call right after itself is a re-render
                            # replay and must not become a second real execution.
                            no_turn = {k: v for k, v in payload.items() if k != "turn"}
                            await client.send(json.dumps({"id": 4, **no_turn}))
                            fourth = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertFalse(fourth.get("duplicate"))
                            await client.send(json.dumps({"id": 5, **no_turn}))
                            fifth = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertTrue(fifth.get("duplicate"))
                            self.assertEqual(len(calls), 3)
                finally:
                    await manager.stop_servers()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_a_turnless_repeat_after_the_replay_window_runs_again(self):
        # The turnless window is deliberately short: once it lapses, the same call
        # is new work again (the bridge must not hide a genuine second request).
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"mcpServers": {"mock": {"command": sys.executable, "args": [str(mock_path)], "env": {}}}}),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path), patch.object(
                bridge, "TURNLESS_REPLAY_TTL", 0.05
            ):
                await manager.start_servers()
                try:
                    mock_server = manager.servers["mock"]
                    calls = []
                    original_call_tool = mock_server.call_tool

                    async def counting_call_tool(tool_name, arguments, timeout):
                        calls.append((tool_name, dict(arguments)))
                        return await original_call_tool(tool_name, arguments, timeout)

                    mock_server.call_tool = counting_call_tool
                    async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
                        port = server.sockets[0].getsockname()[1]
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                            await client.recv()  # initial "connected" message
                            payload = {
                                "type": "call_tool",
                                "name": "echo",
                                "arguments": {"message": "no turn here"},
                                "timeout": 2000,
                            }
                            await client.send(json.dumps({"id": 1, **payload}))
                            first = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertFalse(first.get("duplicate"))

                            await asyncio.sleep(0.1)
                            await client.send(json.dumps({"id": 2, **payload}))
                            second = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertFalse(second.get("duplicate"))
                            self.assertEqual(len(calls), 2)
                finally:
                    await manager.stop_servers()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_a_disconnect_drops_the_cached_result(self):
        # Regression (review on d2c3bce): per-connection entries were never removed,
        # and CPython reuses object ids, so a later socket could inherit a stale
        # result. State must die with the connection.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"mcpServers": {"mock": {"command": sys.executable, "args": [str(mock_path)], "env": {}}}}),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    mock_server = manager.servers["mock"]
                    calls = []
                    original_call_tool = mock_server.call_tool

                    async def counting_call_tool(tool_name, arguments, timeout):
                        calls.append((tool_name, dict(arguments)))
                        return await original_call_tool(tool_name, arguments, timeout)

                    mock_server.call_tool = counting_call_tool
                    async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
                        port = server.sockets[0].getsockname()[1]
                        payload = {
                            "type": "call_tool",
                            "name": "echo",
                            "arguments": {"message": "same call"},
                            "timeout": 2000,
                            "turn": "convA|1",
                        }
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                            await client.recv()
                            await client.send(json.dumps({"id": 1, **payload}))
                            first = json.loads(await asyncio.wait_for(client.recv(), 5))
                            self.assertFalse(first.get("duplicate"))
                        # The socket is closed: nothing may be left to answer from.
                        await asyncio.sleep(0.2)
                        self.assertEqual(manager._last_calls, {})
                        self.assertEqual(manager._client_tokens, {})

                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as other:
                            await other.recv()
                            await other.send(json.dumps({"id": 2, **payload}))
                            second = json.loads(await asyncio.wait_for(other.recv(), 5))
                            self.assertEqual(second["text"], "same call")
                            self.assertFalse(second.get("duplicate"))
                            self.assertEqual(len(calls), 2)
                finally:
                    await manager.stop_servers()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_slow_tool_call_does_not_block_ping(self):
        # Regression: requests used to be handled inline in the socket read loop,
        # so one slow tool call stopped the bridge from reading pings/pongs.
        with tempfile.TemporaryDirectory() as temp_dir:
            async with self._ws_client(Path(temp_dir), MOCK_SLOW_MCP) as client:
                await client.send(
                    json.dumps(
                        {
                            "id": 1,
                            "type": "call_tool",
                            "name": "echo",
                            "arguments": {"message": "slow", "delay": 1.5},
                            "timeout": 10000,
                        }
                    )
                )
                await client.send(json.dumps({"id": 2, "type": "ping"}))
                first = json.loads(await asyncio.wait_for(client.recv(), 1.0))
                self.assertEqual(first["type"], "pong")
                second = json.loads(await asyncio.wait_for(client.recv(), 8))
                self.assertTrue(second["ok"])
                self.assertEqual(second["text"], "slow")

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_disconnect_finalises_a_running_tool_call(self):
        # Regression: handle_client cancels pending request tasks when the socket
        # drops. _call_tool() used to call hub.end() only on its normal path, so a
        # cancelled call left its busy entry behind and /status kept reporting a
        # tool that was no longer running. Every begun call must end exactly once.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_SLOW_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {"mcpServers": {"mock": {"command": sys.executable, "args": [str(mock_path)], "env": {}}}}
                ),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    async with bridge.websockets.serve(
                        manager.handle_client, "127.0.0.1", 0, max_size=None
                    ) as server:
                        port = server.sockets[0].getsockname()[1]
                        client = await bridge.websockets.connect(f"ws://127.0.0.1:{port}", max_size=None)
                        try:
                            await client.recv()  # initial "connected" message
                            await client.send(
                                json.dumps(
                                    {
                                        "id": 77,
                                        "type": "call_tool",
                                        "name": "echo",
                                        "arguments": {"message": "blocked", "delay": 30},
                                        "timeout": 60000,
                                    }
                                )
                            )
                            loop = asyncio.get_running_loop()
                            deadline = loop.time() + 10
                            while manager.hub.snapshot()["queue"] == 0:
                                self.assertLess(loop.time(), deadline, "the tool call never started")
                                await asyncio.sleep(0.02)
                            self.assertEqual(
                                [row["tool"] for row in manager.hub.snapshot()["busy"]], ["echo"]
                            )
                            # Dropping the socket is what makes handle_client cancel
                            # the in-flight task - the path that used to leak.
                            await client.close()
                            deadline = loop.time() + 10
                            while manager.hub.snapshot()["queue"]:
                                self.assertLess(loop.time(), deadline, "busy entry was never cleared")
                                await asyncio.sleep(0.02)
                            ends = [
                                frame
                                for frame in manager.hub._recent
                                if frame["event"] == "tool_end" and frame.get("id") == 77
                            ]
                            self.assertEqual(len(ends), 1, "exactly one terminal event per call")
                            self.assertFalse(ends[0]["ok"])
                            self.assertEqual(ends[0]["error"], "cancelled")
                            starts = [
                                frame
                                for frame in manager.hub._recent
                                if frame["event"] == "tool_start" and frame.get("id") == 77
                            ]
                            self.assertEqual(len(starts), 1)
                        finally:
                            # close() is idempotent: the normal path already closed it.
                            await client.close()
                finally:
                    await manager.stop_servers()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_large_tool_result_over_websocket(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            async with self._ws_client(Path(temp_dir), MOCK_MCP) as client:
                big_message = "y" * 400_000
                await client.send(
                    json.dumps(
                        {
                            "id": 1,
                            "type": "call_tool",
                            "name": "echo",
                            "arguments": {"message": big_message},
                            "timeout": 20000,
                        }
                    )
                )
                result = json.loads(await asyncio.wait_for(client.recv(), 20))
                self.assertTrue(result["ok"])
                self.assertEqual(result["text"], big_message)

    async def test_oversized_mcp_line_does_not_kill_server(self):
        # Regression: a response line over the stream limit used to kill the
        # stdout reader, mark the server dead and trigger a restart.
        original = asyncio.create_subprocess_exec

        async def small_limit(*args, **kwargs):
            kwargs["limit"] = 64 * 1024
            return await original(*args, **kwargs)

        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                with patch.object(bridge.asyncio, "create_subprocess_exec", small_limit):
                    self.assertTrue(await server.start())
                with self.assertRaises(RuntimeError) as ctx:
                    await server.call_tool("echo", {"message": "x" * 400_000}, 10)
                self.assertIn("too large", str(ctx.exception))
                self.assertTrue(server.alive)
                follow_up = await server.call_tool("echo", {"message": "still works"}, 10)
                self.assertEqual(follow_up["content"][0]["text"], "still works")
            finally:
                await server.stop()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_stream_frame_is_relayed_without_a_reply(self):
        # A progress frame is advisory: the bridge must publish it and stay silent.
        # Replying would make the extension mistake a progress frame for a result.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            async with self._ws_client(root, MOCK_MCP) as client:
                await client.send(json.dumps({
                    "type": "stream",
                    "frame": {"phase": "tool_loading", "tool": "echo", "id": "call-1"},
                }))
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(client.recv(), timeout=0.5)

    async def test_event_hub_publishes_start_and_end(self):
        hub = bridge.EventHub()
        # A bare advisory frame must not make the bridge look busy.
        hub.publish("stream", phase="tool_loading", tool="echo")
        self.assertEqual(hub.snapshot()["queue"], 0)
        hub.begin("call-2", "echo", server="mock")
        busy = hub.snapshot()
        self.assertEqual(busy["queue"], 1)
        self.assertEqual(busy["busy"][0]["tool"], "echo")
        # The live view needs an age it can print without clock math of its own.
        self.assertIn("elapsed_ms", busy["busy"][0])
        self.assertGreaterEqual(busy["busy"][0]["elapsed_ms"], 0)
        hub.end("call-2", ok=True, chars=4)
        self.assertEqual(hub.snapshot()["queue"], 0)
        events = [frame["event"] for frame in hub._recent]
        self.assertIn("tool_start", events)
        self.assertIn("tool_end", events)
        end_frame = [f for f in hub._recent if f["event"] == "tool_end"][0]
        self.assertGreaterEqual(end_frame["ms"], 0)
        self.assertTrue(end_frame["ok"])
        # chars/4 estimate so "how many tokens did this call get" is answerable
        # from the event alone.
        self.assertEqual(end_frame["tok"], 1)
        # An explicit tok (from the page, which knows the streamed length) wins.
        hub.begin("call-3", "echo")
        hub.end("call-3", ok=True, chars=400, tok=140)
        self.assertEqual([f for f in hub._recent if f.get("id") == "call-3"][-1]["tok"], 140)

    def test_live_view_is_self_contained(self):
        # The dashboard is served from the stream port, so it must not depend on
        # any external asset or build step - only the endpoints this file exposes.
        html = bridge.INDEX_HTML
        self.assertIn("new EventSource('/events')", html)
        self.assertIn("fetch('/status'", html)
        self.assertIn("elapsed_ms", html)

    @unittest.skipIf(importlib.util.find_spec("aiohttp") is None, "aiohttp package is not installed")
    async def test_stream_channel_is_read_only(self):
        # `/push` was new in the previous change and accepted any local POST, so a
        # web page could inject frames into the live view without a CORS preflight.
        # Nothing in the extension used it. Pin the behaviour on a real server:
        # the old route answers 404 and nothing gets published.
        from aiohttp import ClientSession, web

        hub = bridge.EventHub()
        runner = web.AppRunner(bridge._build_stream_app(hub), access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            async with ClientSession() as session:
                async with session.post(
                    f"http://127.0.0.1:{port}/push", json={"event": "tool_start", "tool": "echo"}
                ) as response:
                    self.assertEqual(response.status, 404)
                async with session.get(f"http://127.0.0.1:{port}/status") as response:
                    self.assertEqual(response.status, 200)
                    snapshot = await response.json()
            self.assertEqual(snapshot["version"], bridge.BRIDGE_VERSION)
        finally:
            await runner.cleanup()
        # The rejected POST published nothing.
        self.assertEqual(hub.snapshot()["queue"], 0)
        self.assertEqual(list(hub._recent), [])

    @unittest.skipIf(importlib.util.find_spec("aiohttp") is None, "aiohttp package is not installed")
    async def test_stream_server_starts_and_serves_status(self):
        from aiohttp import ClientSession

        hub = bridge.EventHub()
        with patch.object(bridge, "STREAM_PORT", 0):
            runner = await bridge._start_stream_server(hub)
        try:
            site = next(iter(runner.sites))
            port = site._server.sockets[0].getsockname()[1]
            async with ClientSession() as session:
                async with session.get(f"http://127.0.0.1:{port}/status") as response:
                    self.assertEqual(response.status, 200)
                    status = await response.json()
            self.assertEqual(status["version"], bridge.BRIDGE_VERSION)
            self.assertEqual(status["queue"], 0)
        finally:
            await runner.cleanup()

    def test_bridge_version_matches_the_extension_manifest(self):
        # The popup prints both numbers side by side, so a drifting bridge version
        # makes the display meaningless. One number, two files.
        manifest_path = Path(__file__).parent / "snapgent-extension" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(bridge.BRIDGE_VERSION, manifest["version"])

    def test_launchers_install_the_live_view_dependency(self):
        # aiohttp is imported lazily: when it is missing the bridge only logs
        # "progress channel disabled", so the live view and /status vanish silently.
        # Pin the install *list*, not a bare mention - the warning text contains the
        # word too, so a mention-only assertion would pass on a broken launcher.
        for name in ("Linux_Start.sh", "MacOS_Start.command"):
            text = (Path(__file__).parent / name).read_text(encoding="utf-8")
            self.assertIn(
                "for module in websockets aiohttp;",
                text,
                f"{name} does not include aiohttp in its dependency install list",
            )

    async def test_hub_subscriber_receives_frames_live(self):
        hub = bridge.EventHub()
        async with hub.subscribe() as queue:
            hub.publish("tool_start", tool="echo")
            frame = await asyncio.wait_for(queue.get(), timeout=1)
            self.assertEqual(frame["event"], "tool_start")
            self.assertEqual(frame["tool"], "echo")

    def test_duplicate_tool_names_are_server_qualified(self):
        first = bridge.MCPServer("roblox", {})
        second = bridge.MCPServer("effectcraft", {})
        first.process = SimpleNamespace(returncode=None)
        second.process = SimpleNamespace(returncode=None)
        first.ready = second.ready = True
        first.tools = [{"name": "get_state"}]
        second.tools = [{"name": "get_state"}]

        manager = bridge.Bridge()
        manager.servers = {"roblox": first, "effectcraft": second}
        manager._rebuild_catalog()

        self.assertEqual(
            [tool["name"] for tool in manager._catalog],
            ["roblox/get_state", "effectcraft/get_state"],
        )
        self.assertIs(manager._resolve_tool("effectcraft/get_state")[0], second)
        self.assertIsNone(manager._resolve_tool("get_state")[0])


@unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
class OriginGuardTests(unittest.IsolatedAsyncioTestCase):
    @contextlib.asynccontextmanager
    async def _server(self, with_gate: bool = True):
        manager = bridge.Bridge()
        if with_gate:
            server = await bridge._serve_bridge(manager, 0)
            try:
                ipv4_socket = next(sock for sock in server.sockets if sock.family == socket.AF_INET)
                yield ipv4_socket.getsockname()[1]
            finally:
                server.close()
                await server.wait_closed()
            return
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            yield server.sockets[0].getsockname()[1]

    def test_origin_allowlist(self):
        allowed = [
            None,
            "",
            "chrome-extension://abcdefghijklmnop",
            "CHROME-EXTENSION://ABCDEFGHIJKLMNOP",
            "moz-extension://0f0f0f0f-1111-2222-3333-444444444444",
            "safari-web-extension://A1B2C3D4",
        ]
        rejected = [
            "https://evil.example",
            "http://127.0.0.1:17614",
            "http://localhost:3000",
            "null",
            "file://",
            "app://obsidian.md",
            "chrome-extension://",
            "chrome-extension:/missing-slashes",
        ]
        for origin in allowed:
            self.assertTrue(bridge._origin_allowed(origin), origin)
        for origin in rejected:
            self.assertFalse(bridge._origin_allowed(origin), origin)

    async def test_serve_bridge_rejects_a_page_origin_at_the_handshake(self):
        async with self._server() as port:
            with self.assertRaises(Exception) as caught:
                async with bridge.websockets.connect(
                    f"ws://127.0.0.1:{port}", origin="https://evil.example"
                ):
                    pass
        status = getattr(getattr(caught.exception, "response", None), "status_code", None)
        self.assertEqual(status, 403, f"{type(caught.exception).__name__}: {caught.exception}")

    async def test_serve_bridge_accepts_an_extension_origin(self):
        async with self._server() as port:
            async with bridge.websockets.connect(
                f"ws://127.0.0.1:{port}", origin="chrome-extension://abcdefghijklmnop"
            ) as client:
                connected = json.loads(await client.recv())
        self.assertEqual(connected["type"], "connected")

    async def test_serve_bridge_accepts_a_client_without_an_origin(self):
        async with self._server() as port:
            async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                connected = json.loads(await client.recv())
        self.assertEqual(connected["type"], "connected")

    async def test_legacy_gate_returns_a_tuple_rejection(self):
        # websockets <= 13 calls process_request(path, headers) and expects a response
        # tuple; keep that path working for users who pin an older websockets.
        class LegacyServe:
            __module__ = "websockets.legacy.server"

        with patch.object(bridge.websockets, "serve", LegacyServe), patch.object(bridge, "log"):
            gate = bridge._build_origin_gate()
            self.assertIsNone(await gate("/", {"Origin": "chrome-extension://abc"}))
            self.assertIsNone(await gate("/", {}))
            response = await gate("/", {"Origin": "https://evil.example"})
        self.assertEqual(response, (403, [], b"Origin not allowed.\n"))

    async def test_handler_still_closes_a_page_origin_without_the_gate(self):
        # Defence in depth: a server started without process_request (an older bridge or
        # a third-party wrapper) must not process a single frame from a page origin.
        async with self._server(with_gate=False) as port:
            async with bridge.websockets.connect(
                f"ws://127.0.0.1:{port}", origin="https://evil.example"
            ) as client:
                with self.assertRaises(Exception) as caught:
                    await asyncio.wait_for(client.recv(), 5)
        close_code = getattr(getattr(caught.exception, "rcvd", None), "code", None)
        if close_code is None:
            close_code = getattr(caught.exception, "code", None)
        self.assertEqual(
            close_code,
            1008,
            f"{type(caught.exception).__name__}: {caught.exception}",
        )


if __name__ == "__main__":
    unittest.main()
