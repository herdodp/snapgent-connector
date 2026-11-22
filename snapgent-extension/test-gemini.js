// Quick Node smoke test for providers/gemini.js (run: node test-gemini.js).
// Not shipped.
//
// Why this exists: "Start does nothing, the bar stays on Starting…" on
// gemini.google.com was a SENDING bug with no error anywhere. During Start
// Angular remounts the Quill composer, so the .ql-editor handle captured a
// moment earlier is DETACHED - and a detached element can never become
// document.activeElement, so ed.focus() and the execCommand("insertText") that
// follows are both silent no-ops while reporting success. The composer then
// reads EMPTY, and core's submitAndGetBase counts an empty composer as "the
// site accepted and cleared the message" (send.cleared) - a false positive that
// leaves Start waiting for a reply nobody asked for, until the empty-response
// timeout (~60s).
//
// The guards below pin the fix, layer by layer:
//   1. the editor handle is re-resolved and focus retried until one sticks,
//   2. when focus can never be taken the value is written into the DOM instead
//      (Gemini's Quill mirrors external edits, so the send button appears),
//   3. when no usable editor exists typeAndSend reports strict false, so core
//      retries instead of believing a phantom send.
//
// The provider is a browser IIFE, so it is evaluated here against a stub DOM
// that mimics the three behaviours that matter (a focus() that silently fails,
// execCommand no-oping while unfocused, soft breaks adding no "\n" to
// textContent). No jsdom, no npm install: the repo has no dependencies and this
// test keeps it that way.
const fs = require("fs");
const readSource = (rel) => fs.readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
// Optional argv[2] lets the mutation check run the SAME test against an older
// copy of the provider (it must fail there).
const TARGET = process.argv[2] || __dirname + "/providers/gemini.js";
const src = readSource(TARGET);

class StubEvent {
  constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
}

// ── Stub DOM ────────────────────────────────────────────────────────────────
// focusAfter:  undefined → focus works at once; number → focus starts working
//              after that many ms; null → focus NEVER works.
// remountAfter: number → the editor node is DETACHED (replaced by Angular) for
//              that many ms, exactly like the Start remount.
// detachedAlways: the editor stays detached (no usable composer at all).
function makeEnv(opts) {
  const o = opts || {};
  const state = {
    buffer: "",
    sent: 0,
    focusCalls: 0,
    focusAllowed: o.focusAfter === undefined,
    selectAllPending: false,
    connected: !o.detachedAlways,
  };
  if (typeof o.focusAfter === "number") setTimeout(() => { state.focusAllowed = true; }, o.focusAfter);
  if (typeof o.remountAfter === "number") {
    state.connected = false;
    setTimeout(() => { state.connected = true; }, o.remountAfter);
  }

  const doc = {};
  const body = {
    tagName: "BODY",
    blur() {}, focus() {},
    closest() { return null },
  };
  doc.activeElement = body;

  const editor = {
    tagName: "DIV",
    attrs: { contenteditable: "true" },
    offsetParent: {},
    get isConnected() { return state.connected; },
    get textContent() { return state.buffer; },
    set textContent(v) { state.buffer = String(v); },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 10, top: 100, width: 240, height: 40 }; },
    // A detached element cannot take focus - the whole failure in one line.
    focus() {
      state.focusCalls++;
      if (state.focusAllowed && state.connected) doc.activeElement = editor;
    },
    blur() { if (doc.activeElement === editor) doc.activeElement = body; },
    dispatchEvent() { return true; },
    replaceChildren(frag) {
      state.buffer = (frag.childNodes || []).map((c) => c.textContent || "").join("\n");
    },
  };

  doc.createElement = (tag) => {
    const node = { tagName: String(tag).toUpperCase(), textContent: "", childNodes: [], appendChild(c) { this.childNodes.push(c); } };
    return node;
  };
  doc.createDocumentFragment = () => ({
    childNodes: [],
    appendChild(c) { this.childNodes.push(c); },
  });

  const matIcon = {
    getAttribute(n) { return n === "fonticon" ? "arrow_upward" : null; },
    textContent: "",
  };
  // Gemini only renders the send (arrow_upward) button once the composer holds
  // text - that is the "it registered the insert" proof the provider waits for.
  const sendBtn = {
    offsetParent: {},
    querySelector() { return matIcon; },
    click() { state.sent++; },
  };
  const inputArea = {
    querySelector() { return null; }, // no pending attachment preview
    querySelectorAll(sel) {
      if (sel !== "button") return [];
      return state.buffer.trim() ? [sendBtn] : [];
    },
  };

  doc.hidden = false;
  doc.body = body;
  doc.documentElement = { appendChild() {}, style: {} };
  doc.querySelector = (sel) => (sel === "input-area-v2" ? inputArea : null);
  doc.querySelectorAll = (sel) => {
    if (sel === ".ql-editor[contenteditable='true']") {
      return editor.attrs.contenteditable === "true" ? [editor] : [];
    }
    if (sel === ".ql-editor") return [editor];
    return [];
  };
  doc.createRange = () => ({ selectNodeContents() {} });
  // Real execCommand returns TRUE even when it inserts nothing, which is what
  // made the failure invisible.
  doc.execCommand = (cmd, _ui, val) => {
    if (doc.activeElement !== editor || !state.connected) return true; // silent no-op
    if (cmd === "insertText") {
      if (state.selectAllPending) { state.buffer = ""; state.selectAllPending = false; }
      // dropSpaces reproduces a write that silently loses its spaces: the
      // characters are mostly there, so a whitespace-insensitive comparison
      // would call it complete and send a mangled prompt.
      state.buffer += o.dropSpaces ? String(val).replace(/ /g, "") : String(val);
    } else if (cmd === "insertLineBreak") {
      // Quill turns this into a soft <br>: a line break in the message, but no
      // "\n" in textContent.
      state.buffer += "\n";
    }
    return true;
  };

  const win = {
    getSelection: () => ({
      removeAllRanges() {},
      addRange() { state.selectAllPending = true; },
    }),
  };

  const ZS = new Function(
    "document", "window", "MouseEvent", "KeyboardEvent", "InputEvent", "Event",
    src + "\n;return ZSProvider;"
  )(doc, win, StubEvent, StubEvent, StubEvent, StubEvent);

  const diags = [];
  ZS.init({ diag: (name, data) => diags.push({ name, data: data || {} }) });
  return { ZS, state, diags, editor };
}

// ── assertions ──────────────────────────────────────────────────────────────
let failures = 0;
function ok(cond, label, extra) {
  if (cond) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + (extra === undefined ? "" : "  → " + JSON.stringify(extra)));
}

async function main() {
  console.log("provider: " + TARGET);

  // ── 1. composer remounted by Angular while Start begins ──────────────────
  // The live failure: the handle was detached for the first ~250ms, so focus()
  // was a no-op and every insertText reported success while inserting nothing.
  console.log("\n# composer remounted (detached editor) during Start");
  {
    const env = makeEnv({ remountAfter: 250 });
    const ret = await env.ZS.typeAndSend("hello gemini", []);
    ok(env.state.buffer.trim() === "hello gemini", "text landed in the composer", env.state.buffer);
    ok(env.state.sent === 1, "send button was clicked exactly once", env.state.sent);
    ok(ret === true, "typeAndSend reports success", ret);
    ok(!env.diags.some((d) => d.name === "send.emptyComposer"),
      "no phantom empty-composer report", env.diags.map((d) => d.name));
    ok(!env.diags.some((d) => d.name === "send.domInsert"),
      "focus path was enough (no DOM fallback needed)", env.diags.map((d) => d.name));
  }

  // ── 2. focus refused for a while, then accepted ──────────────────────────
  console.log("\n# focus refused, then accepted");
  {
    const env = makeEnv({ focusAfter: 300 });
    const ret = await env.ZS.typeAndSend("hello gemini", []);
    ok(env.state.buffer.trim() === "hello gemini", "text landed in the composer", env.state.buffer);
    ok(env.state.sent === 1, "send button was clicked once", env.state.sent);
    ok(ret === true, "typeAndSend reports success", ret);
  }

  // ── 3. focus impossible → write the DOM instead of failing ───────────────
  console.log("\n# focus impossible (DOM fallback)");
  {
    const env = makeEnv({ focusAfter: null });
    const ret = await env.ZS.typeAndSend("hello gemini", []);
    ok(ret === true, "typeAndSend reports success", ret);
    ok(env.state.sent === 1, "send button was clicked once", env.state.sent);
    ok(/hello gemini/.test(env.state.buffer), "text reached the composer", env.state.buffer);
    ok(env.diags.some((d) => d.name === "send.domInsert"), "DOM fallback used", env.diags.map((d) => d.name));
  }

  // ── 4. multi-line insert counts as landed ────────────────────────────────
  // Quill renders every soft break as <br>, so textContent has NO "\n". A naive
  // equality check on the inserted text would call a good insert a failure and
  // retype forever.
  console.log("\n# multi-line text (Quill soft breaks)");
  {
    const env = makeEnv();
    const ret = await env.ZS.typeAndSend("line one\nline two\nline three", []);
    ok(ret === true, "typeAndSend reports success", ret);
    ok(env.state.sent === 1, "send button was clicked once", env.state.sent);
    ok(/line one/.test(env.state.buffer) && /line three/.test(env.state.buffer),
      "every line reached the composer", env.state.buffer);
    ok(!env.diags.some((d) => d.name === "send.insertMiss"),
      "no false insertMiss on soft breaks", env.diags.map((d) => d.name));
  }

  // ── 5. no usable composer at all → report, never a phantom send ──────────
  // Core (submitAndGetBase) retries ONLY on a strict false. Anything else lets
  // an empty composer through as "sent and cleared" - the stuck Starting… bug.
  console.log("\n# no usable composer");
  {
    const env = makeEnv({ detachedAlways: true });
    const ret = await env.ZS.typeAndSend("hello gemini", []);
    ok(ret === false, "typeAndSend returns strict false", ret);
    ok(env.state.sent === 0, "nothing was sent", env.state.sent);
    ok(env.state.buffer === "", "composer left empty", env.state.buffer);
    ok(env.diags.some((d) => d.name === "send.emptyComposer"),
      "failure is diagnosable", env.diags.map((d) => d.name));
  }

  // ── 6. a write that loses a SPACE is not "complete" ──────────────────────
  // Quill glues soft breaks, so line breaks are normalized away; a space is
  // content, and a comparison that strips all whitespace would call "readfile"
  // equal to "read file" and send a mangled prompt (owner review 2026-11-22).
  console.log("\n# write losing a space");
  {
    const env = makeEnv({ dropSpaces: true });
    const ret = await env.ZS.typeAndSend("read file", []);
    ok(ret === false, "typeAndSend returns strict false", ret);
    ok(env.state.sent === 0, "nothing was sent", env.state.sent);
  }

  console.log(failures ? `\nFAILED (${failures})` : "\nall Gemini send checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
