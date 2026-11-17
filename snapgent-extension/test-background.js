// Node smoke test for background.js (run: node test-background.js). Not shipped.
//
// Why this exists: the review of PR #3 asked for one specific guarantee that
// cannot be checked by reading the diff - a retried call_tool must never repeat
// a side effect that already happened. `send()` therefore reports whether the
// frame actually left the extension:
//
//   sent: false - it never reached the bridge (failed while waiting for the
//                 socket, or ws.send threw), so re-sending is safe.
//   sent: true  - the frame went out; the bridge may have executed the tool,
//                 so the caller must NOT silently retry a write.
//
// These tests drive the REAL send()/failAllPending() against a stub WebSocket,
// so the behaviour is pinned to the code that ships rather than a copy of it.
const fs = require("fs");

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

// ── Minimal chrome + WebSocket stubs ───────────────────────────────────────
const listeners = [];
const noEvent = { addListener: () => {} };
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onStartup: noEvent,
    onInstalled: noEvent,
    sendMessage: () => Promise.resolve(),
  },
  tabs: { query: (_f, cb) => cb && cb([]), sendMessage: () => Promise.resolve() },
  storage: { local: { get: (_k, cb) => cb && cb({}), set: () => {} } },
  alarms: { create: () => {}, onAlarm: noEvent, clear: () => {} },
};

// A WebSocket that never opens and never delivers: lets us exercise the
// "waiting for a connection" path deterministically.
class DeadSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    DeadSocket.last = this;
  }
  send() {
    throw new Error("send on a closed socket");
  }
  close() {}
  addEventListener() {}
}
global.WebSocket = DeadSocket;

// background.js runs as an IIFE-less module body; evaluate it and grab the
// internals we need through a trailing export hook.
//
// ZSGuard is injected here exactly as the worker gets it via importScripts, so
// the heartbeat in the test runs the same rule the service worker runs.
const guardSrc = fs.readFileSync(__dirname + "/core/guard.js", "utf8");
const ZSGuard = (0, eval)(guardSrc + "\n; ZSGuard;");
const src = fs.readFileSync(__dirname + "/background.js", "utf8");
const internals = new Function(
  "chrome",
  "WebSocket",
  "ZSGuard",
  src + "\n; return { send, failAllPending, pending, pushFrame, setConnected: (v) => { connected = v; }, setWs: (w) => { ws = w; } };"
)(global.chrome, global.WebSocket, ZSGuard);

const { send, failAllPending, pending } = internals;

(async () => {
  // ── 1. Nothing connected: the request never left ─────────────────────────
  // waitForConnection runs for CONNECT_WAIT_MS, so keep this short by using a
  // fast probe type (CONNECT_WAIT_MS is 2500, well inside a test budget).
  {
    const t0 = Date.now();
    const r = await send({ type: "ping" }, 2000);
    ok("unconnected socket reports disconnected", r.ok === false && r.kind === "disconnected");
    ok("unconnected socket is NOT marked sent", r.sent === false);
    ok("the wait is bounded by CONNECT_WAIT_MS", Date.now() - t0 < 6000);
  }

  // ── 2. Frame went out, then the socket died ──────────────────────────────
  // This is the dangerous case: the bridge may already have run the tool.
  {
    const live = { readyState: 1, send: () => {}, close: () => {} };
    internals.setConnected(true);
    internals.setWs(live);
    const p = send({ type: "call_tool", name: "write_file", arguments: { path: "a.txt" } }, 5000);
    // Let send() register the pending entry before failing it.
    await new Promise((r) => setTimeout(r, 10));
    ok("a delivered request is pending", pending.size === 1);
    const [entry] = [...pending.values()];
    ok("the pending entry records that it was sent", entry.sent === true);
    failAllPending("connection lost");
    const r = await p;
    ok("dropped mid-flight reports disconnected", r.kind === "disconnected");
    ok("dropped mid-flight IS marked sent (no blind retry)", r.sent === true);
  }

  // ── 3. ws.send throws: nothing reached the bridge ────────────────────────
  {
    const throwing = {
      readyState: 1,
      send: () => { throw new Error("boom"); },
      close: () => {},
    };
    internals.setConnected(true);
    internals.setWs(throwing);
    const r = await send({ type: "call_tool", name: "list_dir", arguments: {} }, 5000);
    ok("a failed ws.send reports disconnected", r.kind === "disconnected");
    ok("a failed ws.send is NOT marked sent (safe to retry)", r.sent === false);
    ok("the failed entry is cleaned out of pending", pending.size === 0);
  }

  // ── 4. Ping has a real case in the dispatcher ────────────────────────────
  // Before the fix, bg({type:"ping"}) fell through to `default:` and answered
  // {ok:false,error:"unknown message"}, which every caller reads as "bridge
  // down" even though a manual ping answered in 1 ms.
  {
    ok("the dispatcher registered a listener", listeners.length > 0);
    const handler = listeners[0];
    const reply = await new Promise((resolve) => {
      // Bridge is disconnected: the honest answer is ok:false with a kind, NOT
      // an "unknown message" error from the default branch.
      handler({ type: "ping" }, {}, resolve);
      setTimeout(() => resolve({ timedOut: true }), 9000);
    });
    ok("ping is a known message type", !(reply && reply.error === "unknown message"));
    ok("ping answers a structured failure when the bridge is down",
      reply && (reply.ok === true || typeof reply.kind === "string"));
  }
  // ── progress frames (pushFrame) ──────────────────────────────────────
  // A progress frame is advisory: it must go out, it must carry no id (the
  // bridge sends no reply), and it must NEVER register a pending request -
  // otherwise a successful run would later "time out" for no reason.
  {
    const sent = [];
    internals.setConnected(true);
    internals.setWs({ readyState: 1, send: (t) => sent.push(t), close() {}, addEventListener() {} });
    const before = pending.size;
    const pushed = internals.pushFrame({ phase: "tool_loading", tool: "run_command" });
    let frame = {};
    try { frame = JSON.parse(sent[0] || "{}"); } catch (e) { frame = {}; }
    ok("stream: pushFrame puts a frame on the socket",
      pushed === true && frame.type === "stream");
    ok("stream: the frame keeps its phase", frame.frame && frame.frame.phase === "tool_loading");
    ok("stream: no id is attached (bridge must stay silent)", frame.id === undefined);
    ok("stream: no pending request is registered", pending.size === before);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
