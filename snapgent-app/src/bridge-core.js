// SPDX-License-Identifier: GPL-3.0-or-later
// In-process replacement for bridge.py. No port, no WebSocket: the app's main
// process talks MCP (JSON-RPC lines) straight to its own child processes over stdio.
// Response shapes match what core/main.js expects from extension background.js.
const { spawn } = require("child_process");

const PROTOCOL = "2024-11-05";
const VERSION = "app-1.0";

class McpServer {
  constructor(id, cfg, log) {
    this.id = id; this.cfg = cfg; this.log = log;
    this.proc = null; this.ready = false; this.tools = []; this.error = null;
    this.pending = new Map(); this.nextId = 1; this.buf = "";
  }
  get alive() { return !!(this.proc && this.proc.exitCode === null && this.ready); }

  async start() {
    await this.stop();
    const { command, args = [], env = {} } = this.cfg;
    if (typeof command !== "string" || !command) { this.error = "MCP server command is missing."; return false; }
    try {
      this.proc = spawn(command, args, {
        cwd: this.cfg.cwd || undefined,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) { this.error = String(e.message || e); return false; }
    const proc = this.proc;
    proc.on("error", (e) => { this.error = String(e.message || e); this._fail(this.error); });
    proc.on("exit", () => { if (this.proc === proc) { this.ready = false; this._fail(`${this.id} MCP server stopped.`); } });
    proc.stdin.on("error", () => {});
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk) => this._onData(chunk));
    proc.stderr.on("data", (d) => this.log(`[${this.id}] stderr: ${String(d).trim().slice(0, 1000)}`));
    try {
      await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "snapgent-app", version: VERSION } }, 12000);
      this._write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const r = await this.request("tools/list", {}, 20000);
      const raw = r && Array.isArray(r.tools) ? r.tools : [];
      this.tools = raw.filter((t) => t && typeof t.name === "string");
      this.ready = true; this.error = null;
      this.log(`[${this.id}] MCP server up (${this.tools.length} tools)`);
      return true;
    } catch (e) {
      this.error = String(e.message || e);
      this.log(`[${this.id}] startup failed: ${this.error}`);
      await this.stop();
      return false;
    }
  }

  async stop() {
    const proc = this.proc;
    this.proc = null; this.ready = false; this.tools = [];
    this._fail(`${this.id} MCP server stopped.`);
    if (!proc || proc.exitCode !== null) return;
    try { proc.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 2000);
      proc.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }

  _fail(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }
  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error(`${this.id} MCP server is offline.`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(typeof msg.error === "object" ? String(msg.error.message || JSON.stringify(msg.error)) : String(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }
  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); const e = new Error(`${method} timed out`); e.timeout = true; reject(e); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
}

class BridgeCore {
  constructor({ log = () => {}, onChange = () => {} } = {}) {
    this.log = log; this.onChange = onChange;
    this.servers = new Map(); this.catalog = [];
  }
  _rebuild() {
    const entries = [];
    for (const s of this.servers.values()) if (s.alive) for (const t of s.tools) entries.push([s.id, t]);
    const counts = {};
    for (const [, t] of entries) counts[t.name] = (counts[t.name] || 0) + 1;
    this.catalog = entries.map(([sid, t]) => ({
      name: counts[t.name] > 1 ? `${sid}/${t.name}` : t.name,
      server: sid,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));
  }
  serverStatus() { return [...this.servers.values()].map((s) => ({ id: s.id, alive: s.alive, tools: s.alive ? s.tools.length : 0 })); }
  mcpAlive() { return [...this.servers.values()].some((s) => s.alive); }

  async start(config) {
    this.servers = new Map(Object.entries(config).map(([id, cfg]) => [id, new McpServer(id, cfg, this.log)]));
    await Promise.all([...this.servers.values()].map(async (s) => {
      try { await s.start(); } catch (e) { s.error = String(e.message || e); }
      this._rebuild(); this.onChange();
    }));
    this._rebuild();
  }
  async stop() {
    await Promise.all([...this.servers.values()].map((s) => s.stop()));
    this.servers.clear(); this.catalog = [];
  }
  async restart(config) {
    try { await this.stop(); await this.start(config); this.onChange(); return { ok: true, alive: this.mcpAlive() }; }
    catch (e) { return { ok: false, alive: false, error: String(e.message || e) }; }
  }

  _resolve(name) {
    if (name.includes("/")) {
      const [sid, bare] = [name.slice(0, name.indexOf("/")), name.slice(name.indexOf("/") + 1)];
      const s = this.servers.get(sid);
      if (s && s.alive && s.tools.some((t) => t.name === bare)) return [s, bare];
    }
    const m = [];
    for (const s of this.servers.values()) if (s.alive) for (const t of s.tools) if (t.name === name) m.push(s);
    return m.length === 1 ? [m[0], name] : [null, name];
  }

  async callTool({ name, arguments: args, timeout, server }) {
    if (typeof name !== "string" || (args != null && typeof args !== "object")) return { ok: false, kind: "tool_error", error: "Invalid tool call." };
    let secs = Number(timeout); secs = Number.isFinite(secs) ? Math.max(1, Math.min(secs / 1000, 300)) : 120;
    const [s, toolName] = this._resolve(name);
    if (!s) return { ok: false, kind: "unknown_tool", error: `Unknown or unavailable MCP tool: ${name}` };
    if (server && s.id !== server) return { ok: false, kind: "unknown_tool", error: `MCP tool not available for the selected server: ${name}` };
    try {
      const result = (await s.request("tools/call", { name: toolName, arguments: args || {} }, secs * 1000)) || {};
      const parts = [], images = [];
      for (const item of Array.isArray(result.content) ? result.content : []) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
        else if (item.type === "image" && typeof item.data === "string") images.push({ data: item.data, mimeType: item.mimeType || "image/png" });
      }
      if (!parts.length && result.structuredContent != null) parts.push(JSON.stringify(result.structuredContent));
      const text = parts.join("\n");
      if (result.isError) return { ok: false, error: text || "MCP tool failed." };
      return { ok: true, text, images };
    } catch (e) {
      return { ok: false, kind: e.timeout ? "timeout" : "tool_error", error: String(e.message || e) };
    }
  }
}

module.exports = { BridgeCore, VERSION };
