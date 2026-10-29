// Quick Node smoke test for providers/chatgpt.js (run: node test-chatgpt.js).
// Not shipped.
//
// Why this exists: every ChatGPT bug fixed in 1.5.1 was a READING bug, not a
// parsing one - the parser was fine, the text handed to it was wrong. ChatGPT
// renders code blocks with CodeMirror, which emits one element per line and NO
// newline characters at all, so a naive read glued a whole script onto one line
// ("your code block was empty"), and past a few thousand characters CodeMirror
// stops rendering the rest of a long line, so commands ran truncated. Those are
// exactly the regressions this file guards.
//
// The provider is a browser IIFE, so it is evaluated here against a minimal
// stub DOM (below) - just enough of the Node/Element surface that textWithout
// walks. No jsdom, no npm install: the repo has no dependencies and this test
// keeps it that way.
const fs = require("fs");
const ZSParse = new Function(
  fs.readFileSync(__dirname + "/core/parser.js", "utf8") + "; return ZSParse;"
)();

// ── Stub DOM ────────────────────────────────────────────────────────────────
// el("div", {class, attrs}, children) / txt("…"). Only the members textWithout
// touches are implemented; anything else stays undefined on purpose so a future
// change that needs more DOM fails loudly here instead of silently passing.
function txt(v) {
  return { nodeType: 3, nodeValue: v, childNodes: [] };
}
function el(tag, opts, children) {
  const o = opts || {};
  const classes = (o.class || "").split(/\s+/).filter(Boolean);
  const attrs = o.attrs || {};
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: (children || []).map((c) => (typeof c === "string" ? txt(c) : c)),
    classList: { contains: (c) => classes.includes(c) },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    matches: (sel) => sel.split(",").some((part) => {
      const s = part.trim();
      if (s.startsWith(".") && !s.startsWith("[") && classes.includes(s.slice(1))) return true;
      const classMatch = /^\[class\*=["']([^"']+)["']\]$/.exec(s);
      if (classMatch && classes.some((c) => c.includes(classMatch[1]))) return true;
      const attrMatch = /^\[([-\w]+)\]$/.exec(s);
      return !!attrMatch && attrMatch[1] in attrs;
    }),
  };
  node.querySelector = (sel) => {
    const hit = (n) => {
      if (n.nodeType !== 1) return null;
      if (n.matches(sel)) return n;
      for (const c of n.childNodes) { const r = hit(c); if (r) return r; }
      return null;
    };
    for (const c of node.childNodes) { const r = hit(c); if (r) return r; }
    return null;
  };
  node.querySelectorAll = (sel) => {
    const hits = [];
    const walk = (n) => {
      if (n.nodeType !== 1) return;
      if (n.matches(sel)) hits.push(n);
      for (const c of n.childNodes) walk(c);
    };
    for (const c of node.childNodes) walk(c);
    return hits;
  };
  return node;
}

// ── Load the provider against the stub globals ──────────────────────────────
let composerNodes = [];
let messageNodes = [];
let submitControl = null;
class StubTextArea {}
Object.defineProperty(StubTextArea.prototype, "value", {
  get() { return this._value || ""; },
  set(value) { this._value = String(value); },
});
global.document = {
  querySelector: (selector) => selector.includes("Send message") ? submitControl : null,
  querySelectorAll: (selector) => {
    if (selector.includes("data-message-author-role") || selector.includes("DilResponseRoot")) return messageNodes;
    return selector.includes("mobile-composer-prompt") || selector.includes('role="textbox"') ? composerNodes : [];
  },
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { classList: { contains: () => false } },
  body: null,
};
global.window = { location: { pathname: "/" }, addEventListener: () => {}, HTMLTextAreaElement: StubTextArea };
global.HTMLTextAreaElement = StubTextArea;
global.InputEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
global.location = global.window.location;
global.CustomEvent = class { constructor(t) { this.type = t; } };
global.MutationObserver = class { observe() {} disconnect() {} };
global.getComputedStyle = () => ({});
const P = new Function(
  fs.readFileSync(__dirname + "/providers/chatgpt.js", "utf8") + "; return ZSProvider;"
)();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

// ── The CodeMirror line collapse (the 1.5.1 headline bug) ───────────────────
// A code block is <div class="cm-content"> with one <div class="cm-line"> per
// source line and no newline text nodes anywhere. Reading it with textContent
// returns `###LUA###return 1+1###END_LUA###` - one line, unparseable. Every
// cm-line must terminate.
const cmBlock = (lines, attrs) =>
  el("div", { class: "cm-content", attrs: attrs || {} },
     lines.map((l) => el("div", { class: "cm-line" }, l === "" ? [] : [l])));

const collapsed = P.textWithout(cmBlock(["###LUA###", "return 1+1", "###END_LUA###"]));
ok("cm-lines are newline-terminated", collapsed.includes("###LUA###\nreturn 1+1\n###END_LUA###"));

// A blank source line is an EMPTY cm-line. Swallowing it shifts every Luau
// error line number reported afterwards, so it must survive as "\n".
const blanks = P.textWithout(cmBlock(["local a = 1", "", "return a"]));
ok("empty cm-line survives as a blank line", /local a = 1\n\nreturn a/.test(blanks));

// ── The MAIN-world tap wins over the rendered lines ─────────────────────────
// Past ~2000-4000 chars CodeMirror renders only PART of a long line, so the
// visible lines are a truncated copy. providers/chatgpt-cm.js publishes the
// editor's true document on data-zs-cm; when present it must be used verbatim
// and the (short) rendered subtree ignored - this is what made a 21k-character
// command stop executing cut off.
const full = '{"command":"multi_edit","params":{"edits":[{"old_string":"a","new_string":"' + "x".repeat(5000) + '"}]}}';
const tapped = P.textWithout(cmBlock(['{"command":"multi_edit","params":{"edits":[{"old_str'], { "data-zs-cm": full }));
ok("data-zs-cm tap is preferred over rendered lines", tapped.includes(full));
ok("tapped block parses as JSON", (() => {
  const s = tapped.slice(tapped.indexOf("{"), tapped.lastIndexOf("}") + 1);
  try { return JSON.parse(s).params.edits[0].new_string.length === 5000; } catch { return false; }
})());
// An EMPTY tap value is still a real document (an empty editor), not a missing
// attribute: getAttribute must be checked against null, never falsiness.
const emptyTap = P.textWithout(cmBlock(["stale rendered text"], { "data-zs-cm": "" }));
ok("empty tap value is honoured, not treated as absent", !emptyTap.includes("stale"));

// ── Ordinary prose is untouched ─────────────────────────────────────────────
// Block elements break lines; inline text must not gain stray newlines, or the
// core's marker matching sees a shape the model never wrote.
const prose = P.textWithout(
  el("div", {}, [
    el("p", {}, ["Running the command now:"]),
    el("p", {}, ["Done ", el("strong", {}, ["with"]), " no gaps."]),
  ])
);
ok("blocks separate, inline text stays joined", /Running the command now:\nDone with no gaps\./.test(prose));
// (A block closes with a trailing newline of its own - hence the optional \n.)
ok("a <br> is a newline", /^a\nb\n?$/.test(P.textWithout(el("p", {}, ["a", el("br", {}), "b"]))));

// ── excludeSel ──────────────────────────────────────────────────────────────
// The core passes ".zs-chip" so its own injected chip never counts as model
// output (a chip echoing a tool name would otherwise re-trigger the call).
const withChip = P.textWithout(
  el("div", {}, [el("p", {}, ["real reply"]), el("div", { class: "zs-chip" }, ["execute_luau · 2s"])]),
  ".zs-chip"
);
ok("excluded subtree is skipped", withChip.includes("real reply") && !withChip.includes("execute_luau"));

// ChatGPT's current ProseMirror composer is exposed as an accessible textbox.
const proseMirrorComposer = {
  tagName: "DIV",
  id: "",
  textContent: "",
  getAttribute: (name) => ({
    role: "textbox",
    "aria-label": "Ask ChatGPT",
    contenteditable: "true",
  })[name] || null,
  getClientRects: () => [{ width: 300, height: 70 }],
};
composerNodes = [proseMirrorComposer];
ok("accessible ChatGPT composer is detected", P.getEditor() === proseMirrorComposer);

// The current ChatGPT layout renders assistant replies in a DilResponseRoot
// without the classic data-message-author-role/data-message-id attributes.
const dilReply = el("div", { class: "DilResponseRoot-HfQrEh" }, [
  el("p", {}, ['{"command":"list_commands","params":{"server":"vscode"}}']),
]);
messageNodes = [dilReply];
ok("DilResponseRoot is counted as an assistant reply", P.assistantCount() === 1);
const dilReplyText = P.readAssistant().reply;
ok("DilResponseRoot reply text is readable", dilReplyText.includes('"command":"list_commands"'));
const dilReplyCalls = ZSParse.parseToolCalls(dilReplyText);
ok("command in DilResponseRoot reply is parsed", dilReplyCalls.length === 1 && dilReplyCalls[0].tool === "list_commands");

// ChatGPT's newer compact composer is a controlled textarea instead of the
// ProseMirror #prompt-textarea. It still needs the bar anchor and send path.
const composerForm = { closest: () => null };
const mobileComposer = Object.assign(new StubTextArea(), {
  tagName: "TEXTAREA",
  id: "mobile-composer-prompt",
  offsetParent: {},
  attrs: {},
  focus() {},
  getClientRects: () => [{ width: 300, height: 70 }],
  closest: (selector) => selector === "form" ? composerForm : null,
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  getAttribute(name) { return this.attrs[name] ?? null; },
  dispatchEvent() {},
});
submitControl = {
  offsetParent: {},
  disabled: false,
  getAttribute: () => null,
  click() { mobileComposer.value = ""; },
};
composerNodes = [mobileComposer];
ok("mobile ChatGPT composer is detected", P.getEditor() === mobileComposer);
ok("mobile composer provides a bar anchor", P.barAnchor() === composerForm);
ok("mobile textarea text can be read", P.editorText() === "");
(async () => {
  P.setInputLock(true);
  ok("mobile composer locks with readonly", mobileComposer.getAttribute("readonly") === "");
  await P.typeAndSend("startup prompt");
  ok("mobile composer submits injected text", mobileComposer.value === "");
  ok("mobile composer relocks after sending", mobileComposer.getAttribute("readonly") === "");
  P.setInputLock(false);
  ok("mobile composer unlocks after startup", mobileComposer.getAttribute("readonly") === null);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
