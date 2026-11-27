// SPDX-License-Identifier: GPL-3.0-or-later
// Proves the app's MCP client can talk to a server that speaks 2025-03-26 and uses
// the bidirectional channel: it must answer ping, reject elicitation with the
// JSON-RPC "method not found" error instead of leaving the server blocked, and apply
// notifications/tools/list_changed to the catalog the assistant chooses tools from.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BridgeCore } = require("./src/bridge-core.js");

const MOCK = `
const readline = require("readline");
const state = { ping: false, elicit: false, swapped: false };
const pending = [];
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const toolsResult = () => {
  const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }];
  if (state.ping) tools.push({ name: "ping_ok", description: "Client answered ping", inputSchema: { type: "object", properties: {} } });
  if (state.elicit) tools.push({ name: "elicit_rejected", description: "Client rejected elicitation", inputSchema: { type: "object", properties: {} } });
  if (state.swapped) tools.push({ name: "extra_tool", description: "Added at runtime", inputSchema: { type: "object", properties: {} } });
  return tools;
};
const flush = () => {
  if (!state.ping || !state.elicit) return;
  while (pending.length) emit({ jsonrpc: "2.0", id: pending.shift(), result: { tools: toolsResult() } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m.method) {
    if (m.id === "srv-ping" && m.result && Object.keys(m.result).length === 0) { state.ping = true; flush(); }
    else if (m.id === "srv-elicit") { state.elicit = !!(m.error && m.error.code === -32601); flush(); }
    return;
  }
  if (m.id === undefined) return;
  if (m.method === "initialize") {
    emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mock", version: "1" } } });
    emit({ jsonrpc: "2.0", id: "srv-ping", method: "ping", params: {} });
    emit({ jsonrpc: "2.0", id: "srv-elicit", method: "elicitation/create", params: { message: "need input" } });
  } else if (m.method === "tools/list") {
    if (state.ping && state.elicit) emit({ jsonrpc: "2.0", id: m.id, result: { tools: toolsResult() } });
    else pending.push(m.id);
  } else if (m.method === "tools/call") {
    const message = (m.params.arguments || {}).message || "ok";
    emit({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: message }] } });
    if (message === "swap") { state.swapped = true; emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} }); }
  } else {
    emit({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapgent-mcp-"));
  const mockPath = path.join(dir, "mock-mcp.js");
  fs.writeFileSync(mockPath, MOCK);
  const logs = [];
  let changes = 0;
  const core = new BridgeCore({ log: (line) => logs.push(line), onChange: () => { changes += 1; } });
  let checks = 0;
  const ok = (condition, label) => {
    assert.ok(condition, label);
    checks += 1;
    console.log("ok - " + label);
  };
  try {
    await core.start({ mock: { command: process.execPath, args: [mockPath] } });
    ok(core.mcpAlive(), "the MCP server starts");
    const server = core.servers.get("mock");
    ok(server.protocol === "2025-03-26", "the negotiated revision is the server's, not the client's default");
    const names = () => core.catalog.map((tool) => tool.name);
    ok(names().includes("ping_ok"), "a server ping is answered before the tool list is accepted");
    ok(names().includes("elicit_rejected"), "an unsupported server request is rejected with -32601");

    const echo = await core.callTool({ name: "echo", arguments: { message: "hi" } });
    ok(echo.ok && echo.text === "hi", "a tool call still returns its text");

    const swapped = await core.callTool({ name: "echo", arguments: { message: "swap" } });
    ok(swapped.ok && swapped.text === "swap", "the tool call that triggers the refresh succeeds");
    const deadline = Date.now() + 5000;
    while (!names().includes("extra_tool") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ok(names().includes("extra_tool"), "tools/list_changed adds the new tool to the catalog");
    ok(changes > 0, "the catalog change is announced to the app");
  } finally {
    await core.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("test-bridge-core: " + checks + " checks OK");
})().catch((error) => {
  console.error("test-bridge-core FAILED: " + (error && error.message ? error.message : error));
  process.exit(1);
});
