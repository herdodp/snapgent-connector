// Node smoke test for core/guard.js (run: node test-guard.js). Not shipped.
//
// Covers the three execution-policy fixes requested in the review of PR #3.
// Every assertion below names the bug it prevents.
const fs = require("fs");

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

const G = new Function(
  fs.readFileSync(__dirname + "/core/guard.js", "utf8") + "; return ZSGuard;"
)();

(async () => {
  // ── 1. Retry safety (review point 1) ─────────────────────────────────────
  // Only a request that never left may be re-sent. `runTool` used to retry
  // every disconnected call, which could apply write_file / git_commit twice.
  ok("never-sent request may be retried", G.mayRetryAfterDisconnect({ kind: "disconnected", sent: false }) === true);
  ok("in-flight request must NOT be retried", G.mayRetryAfterDisconnect({ kind: "disconnected", sent: true }) === false);
  ok("a legacy reply without `sent` is treated as unsafe", G.mayRetryAfterDisconnect({ kind: "disconnected" }) === false);
  ok("a timeout is not a retryable disconnect", G.mayRetryAfterDisconnect({ kind: "timeout", sent: false }) === false);
  ok("a success is not a retryable disconnect", G.mayRetryAfterDisconnect({ ok: true }) === false);

  // ── 1b. Per-call execution memory (replay of one identical command) ──────
  // Live bug: one identical `list_dir` was dispatched every 30 s for 20+
  // minutes. The turn-level memory keys on reply TEXT, and the site re-renders
  // that text once a result lands - so startsWith() stopped matching and the
  // call looked fresh forever. This memory keys on the CALL itself.
  {
    const mem = G.createCallMemory({ limit: 4 });
    const dir = { tool: "list_dir", arguments: { path: "immersed-tube-tunnel" } };
    mem.remember("kA", dir);
    ok("a call that already ran is refused", mem.has("kA", dir) === true);
    // The replayed payload from the live log, re-serialised with another key
    // order: the same call, therefore still refused.
    const reordered = { tool: "list_dir", arguments: { path: "immersed-tube-tunnel" } };
    ok("reordered arguments are the same call", mem.has("kA", reordered) === true);
    ok("same call in ANOTHER turn is allowed", mem.has("kB", dir) === false);
    ok("different arguments are allowed", mem.has("kA", { tool: "list_dir", arguments: { path: "other" } }) === false);
    ok("different tool is allowed", mem.has("kA", { tool: "read_file", arguments: dir.arguments }) === false);
    // The model's own schema: command/params instead of tool/arguments.
    const cmd = { command: "read_file", params: { path: "a.html" } };
    mem.remember("kA", cmd);
    ok("command/params shape is remembered too", mem.has("kA", { command: "read_file", params: { path: "a.html" } }) === true);
    // A raw JSON string body and the parsed object are the SAME call - that is
    // the point: a retry that re-sends text instead of an object must not run
    // the command a second time.
    mem.remember("kA", { tool: "x", arguments: "{}" });
    ok("a JSON-string body equals the parsed object body", mem.has("kA", { tool: "x", arguments: {} }) === true);
    // Cap: adding a NEW turn past the cap evicts the oldest one instead of
    // growing without bound.
    mem.remember("kC", dir); mem.remember("kD", dir); mem.remember("kE", dir);
    ok("the memory stays at the cap", mem.size() <= 4);
    mem.remember("kF", dir); // one new turn past the cap
    ok("the oldest turn is evicted at the cap", mem.has("kA", dir) === false);
    ok("the newest turn is still remembered", mem.has("kF", dir) === true);
  }

  // The failure text must warn instead of inviting a blind repeat.
  const msg = G.inFlightFailure("write_file");
  ok("in-flight failure names the tool", msg.includes("write_file"));
  ok("in-flight failure says it may have run", /may or may not have run/.test(msg));
  ok("in-flight failure warns against blind repetition", /Do not repeat/i.test(msg));

  // ── 2. Scroll tracking is PER ELEMENT (review point 3) ────────────────────
  // One shared last-position compared values from different elements: the
  // sidebar at 900 then the transcript at 400 read as a 500px upward scroll and
  // held execution for nothing.
  {
    const t = G.createScrollTracker(24);
    const sidebar = "sidebar";
    const transcript = "transcript";
    t.observe(sidebar, 900);
    ok("first observation of an element never counts as a scroll", t.observe(sidebar, 900) === false);
    // Scroll the sidebar DOWN to 900, then the transcript legitimately at 400:
    // with one shared value this looked like an upward move.
    t.observe(transcript, 380);
    ok("a different element's position is not compared", t.observe(transcript, 400) === false);
    ok("a real upward move in one element IS detected", t.observe(transcript, 300) === true);
    ok("small jitter below the threshold is ignored", t.observe(transcript, 290) === false);
    ok("a downward move is never an upward scroll", t.observe(transcript, 900) === false);
    ok("each element is tracked separately", t.size() === 2);
  }

  // ── 3. Scroll HOLD, not cancel (review point 4) ───────────────────────────
  // The gate used to return "skipped: conversation scrolled up", dropping the
  // command entirely - so a call that became ready as the user scrolled was
  // lost and the task stalled.
  {
    let clock = 0;
    let suppressedUntil = 300;
    const now = () => clock;
    const sleep = async (ms) => { clock += ms; };
    const r = await G.holdUntilScrollLapses({
      isSuppressed: () => clock < suppressedUntil,
      isStopped: () => false,
      sleep,
      now,
      pollMs: 100,
    });
    ok("a held command proceeds once the window lapses", r === true);
    ok("the hold actually waited", clock >= 300);
  }

  {
    // Stop wins over the hold: the command must not run behind the user's back.
    let clock = 0;
    let stopped = false;
    const r = await G.holdUntilScrollLapses({
      isSuppressed: () => clock < 10000,
      isStopped: () => stopped,
      sleep: async (ms) => { clock += ms; stopped = true; },
      now: () => clock,
      pollMs: 100,
    });
    ok("Stop while parked cancels the command", r === false);
  }

  {
    // When nothing is suppressed the hold costs no time at all.
    let clock = 0;
    const r = await G.holdUntilScrollLapses({
      isSuppressed: () => false,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    ok("no suppression means no wait", r === true && clock === 0);
  }

  {
    // A pathological scroll loop cannot park a command forever.
    let clock = 0;
    const r = await G.holdUntilScrollLapses({
      isSuppressed: () => true, // never lapses
      isStopped: () => false,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      pollMs: 100,
      capMs: 500,
    });
    ok("the hold is bounded by capMs", r === true && clock <= 501);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// ── Heartbeat decision (review point: no test for the heartbeat) ─────────────
// Chrome suspends the MV3 worker, so lastMessageAt is ALWAYS stale right after a
// wake-up. Closing on elapsed time alone killed healthy sockets (measured: 203
// connect/disconnect events in a day while a manual ping answered in 1 ms).
{
  const S = 25000;
  // Fresh socket: nothing to do, and certainly no probe.
  const fresh = G.heartbeatDecision({ now: 10000, lastMessageAt: 5000, staleMs: S });
  ok("a fresh socket is not probed and not closed", fresh.shouldProbe === false && fresh.close === false);

  // Stale before any probe: ask for a pong, but do NOT close yet.
  const stale = G.heartbeatDecision({ now: 40000, lastMessageAt: 5000, staleMs: S });
  ok("a stale socket is probed first", stale.shouldProbe === true);
  ok("a stale socket is not closed before the pong", stale.close === false);

  // The exact bug: stale, but the bridge answered → keep the socket.
  const answered = G.heartbeatDecision({ now: 40000, lastMessageAt: 5000, staleMs: S, pongAnswered: true });
  ok("a stale socket that answers the ping is KEPT", answered.close === false);

  // Genuinely dead: stale and no pong → close so onclose reconnects.
  const dead = G.heartbeatDecision({ now: 40000, lastMessageAt: 5000, staleMs: S, pongAnswered: false });
  ok("a stale socket with no pong is closed", dead.close === true);

  // lastMessageAt === 0 means we have never heard from the bridge; that is a
  // connection problem, not a stale socket, so the heartbeat stays out of it.
  const never = G.heartbeatDecision({ now: 999999, lastMessageAt: 0, staleMs: S });
  ok("never-heard-from bridge is not treated as stale", never.shouldProbe === false && never.close === false);
}

// ── The worker uses the shared rule, not a copy ───────────────────────────
  // ── 1c. Adopting a command written on another device (opt-in) ────────────
  // Live gap measured 2026-11-18: a reply typed in the ChatGPT mobile app
  // synced into the web tab with a valid {"command":"list_dir"} block, but the
  // loop read it as plain text and ended (resume answered "no-command").
  {
    const ad = G.createRemoteCommandAdopter({ limit: 4 });
    const base = { enabled: true, started: true, busy: false, generating: false, hasSignature: true, callCount: 1, allExecuted: false };
    ok("first sighting becomes the baseline, never adopted", ad.decide({ ...base, key: "k1" }) === "baseline");
    ok("the reply already on screen is not new", ad.decide({ ...base, key: "k1" }) === "not-new");
    ok("a reply written elsewhere is adopted", ad.decide({ ...base, key: "k2" }) === "adopt");
    ok("one turn is adopted only once", ad.decide({ ...base, key: "k2" }) === "seen");
    ok("a reply without a command is left alone", ad.decide({ ...base, key: "k3", hasSignature: false, callCount: 0 }) === "no-command");
    ok("a command that already ran is not adopted", ad.decide({ ...base, key: "k3", allExecuted: true }) === "already-call");
    ok("that settled turn stays settled", ad.decide({ ...base, key: "k3", allExecuted: true }) === "seen");
    ok("opted out adopts nothing", ad.decide({ ...base, key: "k4", enabled: false }) === "disabled");
    ok("no started session adopts nothing", ad.decide({ ...base, key: "k4", started: false }) === "not-started");
    ok("a busy loop owns the turn", ad.decide({ ...base, key: "k4", busy: true }) === "busy");
    ok("generation in flight is left alone", ad.decide({ ...base, key: "k4", generating: true }) === "generating");
    ok("no assistant turn yet", ad.decide({ ...base, key: null }) === "no-turn");
  }
  {
    // Bounded memory + re-anchoring when the user flips the toggle on: turning
    // it on must not fire the command that was already sitting on screen.
    const ad = G.createRemoteCommandAdopter({ limit: 2 });
    ad.setBaseline("k0");
    for (const key of ["a", "b", "c"]) {
      ad.decide({ enabled: true, started: true, key, hasSignature: true, callCount: 1 });
    }
    ok("the seen list stays bounded", ad.size() <= 2);
    ad.setBaseline("later");
    ok("re-anchoring makes the visible reply the baseline", ad.decide({ enabled: true, started: true, key: "later", hasSignature: true, callCount: 1 }) === "not-new");
  }
  // Wiring: a tested helper the running code never calls is the bug this file
  // exists to catch, so the listener and its toggle must really be in main.js.
  {
    const fs = require("fs");
    const main = fs.readFileSync(__dirname + "/core/main.js", "utf8");
    ok("main.js creates the remote-command adopter", /ZSGuard\.createRemoteCommandAdopter\s*\(/.test(main));
    ok("main.js observes the conversation for new replies", /new MutationObserver\(schedule\)/.test(main));
    ok("main.js adopts through resumePending", /remoteAdopter\.decide\(/.test(main) && /remote\.resume/.test(main));
    ok("the panel exposes the Remote commands toggle", /id="zs-remote-commands"/.test(main) && /setRemoteCommands\(remoteBox\.checked\)/.test(main));
    ok("the setting is persisted", /zsRemoteCommands/.test(main));
  }

// Guards the exact regression the reviewer found in runTool: a helper that the
// tests cover but the running code never calls. background.js must load
// core/guard.js via importScripts and consult ZSGuard.heartbeatDecision.
{
  const fs = require("fs");
  const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
  ok("background.js imports the shared guard", /importScripts\(\s*["']core\/guard\.js["']\s*\)/.test(bg));
  ok("background.js calls ZSGuard.heartbeatDecision", /ZSGuard\.heartbeatDecision\s*\(/.test(bg));
  // The inline elapsed-time gate must be gone, or the worker keeps its own copy.
  ok("no inline elapsed-time socket gate remains",
    !/Date\.now\(\)\s*-\s*lastMessageAt\s*>\s*STALE_SOCKET_MS\s*\)\s*\{/.test(bg));
}
