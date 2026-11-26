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
const vm = require("vm");
// core/config.js is an IIFE that assigns `const ZS`. Evaluate it for real so the
// detection checks below exercise the shipped signature, not a copy of it.
function loadCoreZS() {
  const context = vm.createContext({
    console, window: {}, document: {}, navigator: {}, setTimeout, clearTimeout,
  });
  return vm.runInContext(`${readSource(__dirname + "/core/config.js")}\n;ZS;`, context);
}
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
  // Quill's composer DOM, modelled literally: one <p> per hard line, a <br> per
  // soft break, and NONE of them contributes "\n" to textContent. The provider
  // derives the message's line structure from this DOM, so a stub that only
  // stores a string cannot tell a preserved line break from a dropped one.
  const paras = [{ lines: [""] }];
  const cur = () => paras[paras.length - 1];
  const resetParas = () => { paras.length = 0; paras.push({ lines: [""] }); };
  const setFromString = (s) => {
    const lines = String(s).split("\n");
    paras.length = 0;
    paras.push({ lines });
  };
  const textNow = () => paras.map((p) => p.lines.join("")).join("");
  const state = {
    sent: 0,
    focusCalls: 0,
    focusAllowed: o.focusAfter === undefined,
    selectAllPending: false,
    connected: !o.detachedAlways,
  };
  // What editor.textContent reads (no newlines) - kept as `buffer` so the older
  // assertions keep meaning the same thing.
  Object.defineProperty(state, "buffer", {
    get: () => textNow(),
    set: (v) => setFromString(String(v)),
  });
  // The reconstructed line array, for asserting that formatting survived.
  Object.defineProperty(state, "lines", {
    get: () => paras.flatMap((p) => p.lines),
  });
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
    get textContent() { return textNow(); },
    set textContent(v) { setFromString(String(v)); },
    // <p> blocks with text nodes and <br> separators, exactly like .ql-editor.
    get childNodes() {
      return paras.map((p) => {
        const kids = [];
        p.lines.forEach((ln, i) => {
          if (i) kids.push({ nodeType: 1, tagName: "BR", childNodes: [] });
          if (ln) kids.push({ nodeType: 3, nodeValue: ln });
          else if (!i) kids.push({ nodeType: 1, tagName: "BR", childNodes: [] });
        });
        return { nodeType: 1, tagName: "P", childNodes: kids };
      });
    },
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
      const v = o.dropSpaces ? String(val).replace(/ /g, "") : String(val);
      cur().lines[cur().lines.length - 1] += v;
    } else if (cmd === "insertLineBreak") {
      // Quill turns this into a soft <br>: a line break in the message, but no
      // "\n" in textContent. Live Gemini/Chrome can also insert a literal "\n"
      // inside the <p> text node instead of <br> (measured live 2026-11-26).
      // dropLineBreaks reproduces the failure the owner found - execCommand
      // reporting true while the break never lands.
      if (!o.dropLineBreaks) {
        if (o.textNodeNewlines) cur().lines[cur().lines.length - 1] += "\n";
        else cur().lines.push("");
      }
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
    ok(env.state.lines.join("|") === "line one|line two|line three",
      "the line structure survived (3 lines)", env.state.lines);
    ok(!env.diags.some((d) => d.name === "send.insertMiss"),
      "no false insertMiss on soft breaks", env.diags.map((d) => d.name));
  }

  console.log("\n# multi-line text (Quill text-node newlines)");
  {
    const env = makeEnv({ textNodeNewlines: true });
    const ret = await env.ZS.typeAndSend("line one\nline two\nline three", []);
    ok(ret === true, "typeAndSend reports success on text-node \\n", ret);
    ok(env.state.sent === 1, "send button was clicked once", env.state.sent);
    ok(!env.diags.some((d) => d.name === "send.insertMiss"),
      "no false insertMiss on text-node \\n", env.diags.map((d) => d.name));
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

  // ── 6b. a write that loses a LINE BREAK is not "complete" either ─────────
  // execCommand reports true even when insertLineBreak inserts nothing, and
  // Quill's textContent carries no "\n", so a comparison that strips line breaks
  // accepts "line oneline two" as the requested "line one\nline two" and sends a
  // message with its formatting lost (owner review 2026-11-25).
  console.log("\n# write losing a line break");
  {
    const env = makeEnv({ dropLineBreaks: true });
    const ret = await env.ZS.typeAndSend("line one\nline two", []);
    ok(env.state.buffer === "line oneline two", "the stub really glued the lines", env.state.buffer);
    ok(env.state.lines.length === 1, "one line reached the composer instead of two", env.state.lines);
    ok(ret === false, "typeAndSend returns strict false", ret);
    ok(env.state.sent === 0, "a message with lost formatting is never sent", env.state.sent);
    ok(env.diags.some((d) => d.name === "send.insertMiss"),
      "the miss is diagnosable", env.diags.map((d) => d.name));
  }

  // ── 7. injected result turn: chip goes INSIDE the user bubble ────────────
  // Live complaint (2026-11-23): the result chip rendered as a pill floating
  // above the user's own message. The result payload IS a normal user message
  // in Gemini (the extension sends the tool output as the user's next turn), so
  // the chip must sit in that bubble and only the text line may be masked -
  // masking the bubble itself would hide the chip with it.
  console.log("\n# result chip anchored inside the user bubble");
  {
    const env = makeEnv();
    const textNodeOf = (s) => ({ nodeType: 3, nodeValue: s });
    const mkEl = (tag, cls, kids) => {
      const e = {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
        childNodes: [],
        parentElement: null,
      };
      e.classList = {
        add: (c) => e._cls.add(c),
        remove: (c) => e._cls.delete(c),
        contains: (c) => e._cls.has(c),
      };
      e.matches = (sel) => String(sel).split(",").some((s) => e._cls.has(s.trim().replace(/^\./, "")));
      const findIn = (root, name) => {
        for (const c of root.childNodes) {
          if (c.nodeType !== 1) continue;
          if (c._cls.has(name)) return c;
          const d = findIn(c, name);
          if (d) return d;
        }
        return null;
      };
      e.querySelector = (sel) => {
        for (const part of String(sel).split(",")) {
          const name = part.trim().split(/\s+/).pop().replace(/^\./, "");
          if (!name) continue;
          const hit = findIn(e, name);
          if (hit) return hit;
        }
        return null;
      };
      for (const k of kids || []) {
        if (k && k.nodeType) { k.parentElement = e; e.childNodes.push(k); }
        else { const t = textNodeOf(String(k)); t.parentElement = e; e.childNodes.push(t); }
      }
      return e;
    };
    // <user-query> → .query-content → .query-bubble-anchor →
    //   span.user-query-bubble-with-background → span.horizontal-container →
    //     div.query-text → p.query-text-line  ("Output of …")
    const buildTurn = (label) => {
      const line = mkEl("p", "query-text-line", [label]);
      const qtext = mkEl("div", "query-text", [line]);
      const row = mkEl("span", "horizontal-container", [qtext]);
      const bubble = mkEl("span", "user-query-bubble-with-background", [row]);
      const anchor = mkEl("div", "query-bubble-anchor", [bubble]);
      const content = mkEl("div", "query-content", [anchor]);
      return mkEl("user-query", "ng-star-inserted", [content]);
    };

    const resultTurn = buildTurn('Output of \'list_commands\': {"tools":[1]}');
    const anchor = env.ZS.chipAnchor ? env.ZS.chipAnchor(resultTurn) : null;
    const hide = env.ZS.injectedHideNode ? env.ZS.injectedHideNode(resultTurn) : null;
    ok(!!env.ZS.chipAnchor && !!env.ZS.injectedHideNode,
      "provider exposes chipAnchor + injectedHideNode", Object.keys(env.ZS).length);
    ok(!!anchor && anchor !== resultTurn && anchor.classList.contains("horizontal-container"),
      "chip anchors inside the bubble's row, not at the turn root",
      anchor && anchor.classList.contains("horizontal-container"));
    ok(!!hide && hide.classList.contains("query-text"),
      "only the text line is masked", hide && hide._cls && [...hide._cls]);
    ok(!!anchor && !!hide && anchor !== hide,
      "masked text is not the chip's own container", !!(anchor && hide));

    // Our own system turn must NOT be redirected: hiding only its text line
    // would leave the giant CONTEXT prompt bubble visible.
    const coreZS = loadCoreZS();
    {
      // The signature only fires at the START of a turn. An ordinary message that
      // merely quotes the prompt must stay an ordinary turn - matching it anywhere
      // hid that message as if the whole conversation were a Snapgent session.
      ok(coreZS.isSysPromptText("CONTEXT: snapgentV3 is a browser extension that sends your plain-text JSON commands…"),
        "the real bootstrap prompt is recognised", true);
      ok(coreZS.isSysPromptText("⟦ZS-SYS⟧\nCONTEXT: snapgentV3 is a browser extension…"),
        "a marked bootstrap prompt is still recognised", true);
      // The second bootstrap shape core/mcp produces for a session that starts
      // without a target server.
      ok(coreZS.isSysPromptText("CONTEXT: the user has installed a browser extension called snapgentV3 in their own browser. Here is how it works, so you can use it on their behalf:"),
        "the no-target bootstrap prompt is recognised too", true);
      ok(coreZS.isSysPromptText("Please review this prompt: CONTEXT: you are snapgentV3 in Gemini.") === false,
        "a message that only quotes the prompt is not a Snapgent turn", false);
      // The signature must be the prompt's own opening words, not "CONTEXT:" plus
      // any wording that mentions the extension: this user sentence was still
      // classified as a system turn by the previous [^\n]{0,100} pattern and got
      // hidden across providers (owner review 2026-11-25).
      ok(coreZS.isSysPromptText("CONTEXT: I am discussing the snapgentV3 extension, not sending its prompt.") === false,
        "a CONTEXT sentence merely mentioning snapgentV3 is not a Snapgent turn", false);
      ok(coreZS.isSysPromptText("CONTEXT: snapgentV3 is broken on this page, can you look?") === false,
        "a CONTEXT sentence opening with the app name is not a Snapgent turn", false);
    }
    // The fixture is a REAL bootstrap turn - the two prefixes the extension
    // actually sends. "CONTEXT: you are snapgentV3 in Gemini." is not one of
    // them (and must not be treated as one, see the assertions above).
    const sysTurn = buildTurn("CONTEXT: snapgentV3 is a browser extension that sends your plain-text JSON commands…");
    const prevGlobal = global.ZS;
    global.ZS = { isSysPromptText: coreZS.isSysPromptText };
    const sysAnchor = env.ZS.chipAnchor(sysTurn);
    const sysHide = env.ZS.injectedHideNode(sysTurn);
    global.ZS = prevGlobal;
    ok(sysAnchor === null, "system turn keeps the turn-level chip pin", sysAnchor === null);
    ok(sysHide === null, "system turn still masks the whole turn", sysHide === null);

    // Mutation check: without these two hooks the same turn falls back to a
    // turn-level sticker + whole-turn mask (the reported behaviour).
    ok(env.ZS.chipAnchor(buildTurn("plain user text")) !== null,
      "ordinary user turn is unaffected by the sys guard", true);
  }

  console.log(failures ? `\nFAILED (${failures})` : "\nall Gemini send checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
