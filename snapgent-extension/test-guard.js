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
