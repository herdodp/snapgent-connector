import asyncio
import contextlib
import json
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


if __name__ == "__main__":
    unittest.main()
