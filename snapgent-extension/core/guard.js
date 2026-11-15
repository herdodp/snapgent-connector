// SPDX-License-Identifier: GPL-3.0-or-later
// core/guard.js - the two bits of execution policy that used to live inline in
// main.js and therefore had no tests. PURE logic, zero DOM, so this file can be
// loaded and checked by node without a browser.
//
// Why they moved out: both decide whether a tool runs, and both were wrong in a
// way nobody could see by reading the diff (see the review of PR #3):
//
//   1. A retried call could repeat a side effect. A dropped socket reported the
//      same "disconnected" whether the request had never left the extension or
//      had reached the bridge and maybe run. Retrying the second case applies
//      write_file / run_command twice.
//   2. A scroll held nothing - it CANCELLED the command, so a call that became
//      ready exactly as the user scrolled up was dropped and reported to the
//      model as "skipped".
const ZSGuard = (() => {
  "use strict";

  // The bridge reports `sent` on every failure it can identify:
  //   sent: true  - the frame went out; the tool MAY have run.
  //   sent: false - it never left (not connected, or ws.send threw).
  //   undefined   - an older bridge, which never sent this field.
  //
  // Undefined is treated as UNSAFE. An old bridge that did deliver the request
  // is indistinguishable from one that did not, and duplicating a write is worse
  // than telling the user the command may already have run.
  function mayRetryAfterDisconnect(res) {
    return !!(res && res.kind === "disconnected" && res.sent === false);
  }

  // The message the model receives when a command was lost mid-flight. It must
  // NOT invite a blind retry: the tool may have completed, so repeating a
  // destructive command would apply it twice.
  function inFlightFailure(name) {
    return (
      `ERROR: the connection dropped after '${name}' was sent, so it may or may ` +
      "not have run. Do not repeat a destructive command blindly - check the " +
      "current state first."
    );
  }

  // ── Scroll hold ───────────────────────────────────────────────────────────
  // A hold, not a cancel: the command waits for the suppression window to lapse
  // and then proceeds. Returns true when the caller may run, false when the user
  // asked to stop while it was parked.
  //
  // `now` and `sleep` are injected so the wait is testable without real time.
  async function holdUntilScrollLapses(opts) {
    const o = opts || {};
    const isSuppressed = o.isSuppressed || (() => false);
    const isStopped = o.isStopped || (() => false);
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = o.now || (() => Date.now());
    const pollMs = o.pollMs == null ? 120 : o.pollMs;
    // Bounded: at most two extra windows, so a pathological scroll loop cannot
    // park a command forever.
    const capMs = o.capMs == null ? 8500 : o.capMs;
    const deadline = now() + capMs;

    while (isSuppressed() && now() < deadline) {
      if (isStopped()) return false;
      await sleep(pollMs);
    }
    return !isStopped();
  }

  // ── Per-element scroll positions ──────────────────────────────────────────
  // The listener is on `document` in the capture phase, so it sees the
  // transcript, the sidebar, code blocks and textareas. One shared "last top"
  // compared values from DIFFERENT elements: sidebar at 900 then transcript at
  // 400 read as an upward move of 500px and held execution for nothing.
  function createScrollTracker(threshold) {
    const min = threshold == null ? 24 : threshold;
    // WeakMap in the page, so a scrollable element that the site removes can be
    // collected instead of being kept alive for the tab's lifetime. A WeakMap
    // only accepts OBJECT keys, so anything else (a string in the tests, or a
    // missing target) falls back to Map - otherwise observe() would throw
    // "Invalid value used as weak map key" and kill the scroll listener.
    const weak = typeof WeakMap === "function";
    // The fallback MUST always exist: a non-object key (a string in the tests,
    // or a missing target) cannot go into a WeakMap, and silently dropping the
    // write would stop the tracker from ever noticing an upward move.
    const fallback = new Map();
    const strong = new WeakMap();
    const isObject = (k) => !!k && (typeof k === "object" || typeof k === "function");
    const useWeak = (k) => weak && isObject(k);
    const store = {
      get: (k) => (useWeak(k) ? strong.get(k) : fallback.get(k)),
      set: (k, v) => {
        if (useWeak(k)) strong.set(k, v);
        else fallback.set(k, v);
      },
      delete: (k) => (useWeak(k) ? strong.delete(k) : fallback.delete(k)),
    };
    const liveKeys = new Set();
    if (!weak) {
      // Without a WeakMap, `last` IS the fallback map; keep them identical.
      store.get = (k) => fallback.get(k);
      store.set = (k, v) => fallback.set(k, v);
      store.delete = (k) => fallback.delete(k);
    }
    return {
      // Returns true when this move counts as an upward scroll.
      observe(key, top) {
        const prev = store.get(key);
        store.set(key, top);
        liveKeys.add(key);
        if (prev == null) return false;
        return top < prev - min;
      },
      forget(key) {
        store.delete(key);
        liveKeys.delete(key);
      },
      size() {
        return liveKeys.size;
      },
    };
  }

  // ── Heartbeat decision ────────────────────────────────────────────────────
  // Should a stale-looking socket be dropped? Time alone is NOT proof: Chrome
  // suspends the MV3 worker and setInterval does not run while suspended, so
  // lastMessageAt is always old right after a wake-up. Only a failed ping may
  // close the socket.
  //
  //   { shouldProbe: true }  - stale, so ask for a pong first
  //   { close: true }        - stale AND the bridge did not answer
  //   { close: false }       - either fresh, or the pong proved it healthy
  function heartbeatDecision(opts) {
    const o = opts || {};
    const now = o.now == null ? Date.now() : o.now;
    const lastMessageAt = o.lastMessageAt || 0;
    const staleMs = o.staleMs == null ? 25000 : o.staleMs;
    const stale = !!lastMessageAt && now - lastMessageAt > staleMs;
    if (!stale) return { shouldProbe: false, close: false };
    // pongAnswered is undefined when the probe has not been made yet.
    if (o.pongAnswered === undefined) return { shouldProbe: true, close: false };
    return { shouldProbe: true, close: !o.pongAnswered };
  }

  return {
    mayRetryAfterDisconnect,
    inFlightFailure,
    holdUntilScrollLapses,
    createScrollTracker,
    heartbeatDecision,
  };
})();
