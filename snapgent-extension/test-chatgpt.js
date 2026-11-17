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
      // A bare tag name ("pre", "div") was not supported, so the provider's
      // querySelectorAll("pre") silently found nothing.
      if (/^[a-z][\w-]*$/i.test(s)) return tag.toUpperCase() === s.toUpperCase();
      if (s.startsWith(".") && !s.startsWith("[") && classes.includes(s.slice(1))) return true;
      const classMatch = /^\[class\*=["']([^"']+)["']\]$/.exec(s);
      if (classMatch && classes.some((c) => c.includes(classMatch[1]))) return true;
      // [attr="value"] variants matter for the 2026-11-17 markup, whose only
      // assistant marker is data-markdown-text-style="assistant-message".
      const attrVal = /^\[([-\w]+)=["']?([^"'\]]+)["']?\]$/.exec(s);
      if (attrVal) return attrs[attrVal[1]] === attrVal[2];
      const attrMatch = /^\[([-\w]+)\]$/.exec(s);
      // Attribute NAMES may contain hyphens (data-turn-key), so look the raw
      // string up rather than only strlen-safe identifiers.
      return !!attrMatch && attrMatch[1] in attrs;
    }),
  };
  // children: the provider walks a node's ELEMENT children to tell the user
  // block apart from the reply block in the 2026-11 sibling layout, so the stub
  // must expose it the way the DOM does.
  node.children = node.childNodes.filter((c) => c && c.nodeType === 1);
  for (const c of node.childNodes) if (c && c.nodeType === 1) c.parentElement = node;
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
  // Standard descendant semantics: every matching ELEMENT BELOW this node.
  // (Walking `node.childNodes` only - the old code - skipped an element whose
  // own childNodes the walk started from, so a <pre> inside a wrapper was never
  // found.)
  node.querySelectorAll = (sel) => {
    const hits = [];
    const walk = (n) => {
      for (const c of n.childNodes || []) {
        if (c.nodeType !== 1) continue;
        if (c.matches(sel)) hits.push(c);
        walk(c);
      }
    };
    walk(node);
    return hits;
  };
  // querySelector: first descendant match (the old one started at the node
  // itself, which made a turn "contain" its own selector).
  node.querySelector = (sel) => {
    const walk = (n) => {
      for (const c of n.childNodes || []) {
        if (c.nodeType !== 1) continue;
        if (c.matches(sel)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(node);
  };
  // innerText: the provider filters <pre> and shape-B wrappers on it, so the
  // stub must provide it. Concatenate the subtree's text nodes, the way a real
  // one renders them (a text node's `nodeValue`).
  Object.defineProperty(node, "innerText", {
    // configurable so a test can reproduce the 2026-11-17 variant, where a code
    // block renders with contain-intrinsic-block-size and innerText is empty
    // while textContent still holds the payload.
    configurable: true,
    get() {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 3) out.push(n.nodeValue);
        else for (const c of n.childNodes || []) walk(c);
      };
      walk(node);
      return out.join("");
    },
  });
  // closest(): walk up through the parent links the stub sets below.
  node.closest = (sel) => {
    let n = node;
    while (n && n.nodeType === 1) {
      if (n.matches && n.matches(sel)) return n;
      n = n.parent;
    }
    return null;
  };
  // Link children back to their parent so closest()/descendant lookups work.
  for (const c of node.childNodes) if (c && c.nodeType === 1) c.parent = node;
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

// ── Turn identity must be STABLE (the "tools re-run when I scroll up" bug) ──
// core's turnKey() dedupes already-executed commands off-DOM. It prefers
// P.itemKey(item); when that returns null it falls back to a POSITIONAL index,
// which collides as soon as scrolling changes the rendered window, so the guard
// misses and the resume watchdog re-fires a historical tool. The 2026-11 turn no
// longer carries data-message-id (measured live: 0 turns, 0 descendants), so the
// key must come from data-turn-key.
{
  const turn = el("div", { attrs: { "data-turn-key": "f918df91-aaaa-bbbb" } });
  ok("itemKey uses data-turn-key on the 2026-11 turn",
    P.itemKey(turn) === "f918df91-aaaa-bbbb");
  ok("itemKey is never null for a 2026-11 turn (positional fallback is the bug)",
    P.itemKey(turn) != null);
  const legacy = el("div", { attrs: { "data-message-id": "uuid-legacy" } });
  ok("itemKey still honours the legacy data-message-id",
    P.itemKey(legacy) === "uuid-legacy");
  ok("itemKey returns null only when neither attribute exists",
    P.itemKey(el("div", {})) === null);
}

// ── Prefix stripping must touch the START only (review point 2) ─────────────
// The stripper used to run /chatgpt\s+(?:said|dit)\s*:?/gi GLOBALLY, so a payload
// that legitimately contained those words lost them. A write_file whose content
// mentioned "ChatGPT said:" was silently corrupted before it ever reached the
// bridge. A brace slice then cut everything before the first { or [, destroying
// any prose in front of an envelope.
{
  const strip = P.__test.stripAssistantSrPrefix;

  // The chrome the function exists for is still removed.
  ok("glued speaker chrome is stripped",
    strip("ChatGPT said:ChatGPTJSON{\"command\":\"list_dir\"}") === "{\"command\":\"list_dir\"}");
  ok("glued speaker chrome (French) is stripped too",
    strip("ChatGPT dit: JSON{\"command\":\"ping\"}") === "{\"command\":\"ping\"}");

  // ...but the SAME words inside the payload survive untouched.
  const payload = '{"command":"write_file","params":{"content":"ChatGPT said: hello, then ChatGPT dit: halo"}}';
  const out = strip("ChatGPT said:ChatGPTJSON" + payload);
  ok("payload keeps an inner 'ChatGPT said:' (no global wipe)", out.includes("ChatGPT said: hello"));
  ok("payload keeps an inner 'ChatGPT dit:' (no global wipe)", out.includes("ChatGPT dit: halo"));

  // The brace slice is gone: text before an envelope is no longer chopped.
  const withProse = strip("ChatGPT said:ChatGPTJSONHere is the file {\"a\":1}");
  ok("no brace slice - prose before an envelope survives",
    withProse.includes("Here is the file"));

  // Ordinary prose without chrome is returned byte-for-byte.
  const plain = "Python is a language. ChatGPT said: nothing here.";
  ok("plain prose is returned unchanged", strip(plain) === plain);

  // One argument only: a second was accepted before and silently ignored.
  ok("strip takes exactly one argument", strip.length === 1);
}

// ── The THREE-SHAPE fixture (review point 6) ────────────────────────────────
// The commit that fixed the 2026-11 DOM verified against "a three-shape
// fixture": A fenced <pre>, B plain text inside .zs-tool-hide, and the legacy
// .markdown reply. The reviewer asked for it to be included. An assistant reply
// alternates between A and B, so a reader that understands only one of them
// yields "ChatGPT returned an empty reply" for every other turn.
{
  // A) fenced code block: <pre>{"command":…}</pre>
  const shapeA = el("div", { class: "zs-cmd-mask" },
    [el("pre", {}, [`{"command":"create_file","params":{"path":"a.txt"}}`])]);
  // B) plain text, no <pre> at all, behind the glued speaker chrome.
  const shapeB = el("div", { class: "zs-tool-hide" },
    ["ChatGPT said:ChatGPTJSON", el("div", {}, [`{"command":"read_file","params":{"path":"b.txt"}}`])]);
  // Legacy: ordinary .markdown reply.
  const legacy = el("div", { class: "markdown" }, [`{"command":"list_dir","params":{}}`]);

  const turnOf = (child) => el("div", { attrs: { "data-turn-key": "turn-shape" } }, [child]);

  // classifyText is what the core actually reads a turn with, and it takes the
  // turn item directly - no document.querySelectorAll() sweep needed.
  const textA = P.classifyText(turnOf(shapeA));
  const textB = P.classifyText(turnOf(shapeB));
  const textL = P.classifyText(turnOf(legacy));

  ok("shape A (<pre>) yields the create_file command",
    /"command"\s*:\s*"create_file"/.test(textA));
  ok("shape B (plain text) yields the read_file command",
    /"command"\s*:\s*"read_file"/.test(textB));
  ok("legacy .markdown yields the list_dir command",
    /"command"\s*:\s*"list_dir"/.test(textL));

  // Shape B must not leak its chrome into the payload the parser receives.
  ok("shape B has no glued 'ChatGPT said:' left", !/chatgpt\s+said\s*:/i.test(textB));
  ok("shape B has no bare JSON label left", !/^\s*JSON/i.test(textB));

  // All three parse to a real command through the shipped parser.
  const cmdOf = (t) => {
    try {
      const calls = ZSParse.parseToolCalls(t);
      return calls && calls.length ? calls[0] : null;
    } catch { return null; }
  };
  ok("shape A parses to a command", !!(cmdOf(textA) && cmdOf(textA).tool));
  ok("shape B parses to a command", !!(cmdOf(textB) && cmdOf(textB).tool));
  ok("legacy parses to a command", !!(cmdOf(textL) && cmdOf(textL).tool));
}

// ── Language-label regex must not eat prose (review point 3) ────────────────
// The pattern had no word boundary and listed `sh` before `shell`, so:
//   "shell\nls"       -> "ell\nls"      (sh matched first)
//   "Should we go?"   -> "ould we go?"  (sh matched inside Should)
//   "Text of the file"-> "of the file"  (text consumed as a label)
// Prose that merely STARTS with one of those words must survive untouched.
{
  const strip = P.__test.stripAssistantSrPrefix;

  // These are ordinary prose, not chrome: LOOKS_GLUED already refuses them
  // because no payload brace follows, so the stripper must return them as-is.
  ok("'Should we proceed?' is not stripped",
    strip("Should we proceed?") === "Should we proceed?");
  ok("'Text of the file follows' is not stripped",
    strip("Text of the file follows") === "Text of the file follows");
  ok("'Shell commands are listed below' is not stripped",
    strip("Shell commands are listed below") === "Shell commands are listed below");

  // A real glued label in front of a payload IS chrome and must go - and the
  // longest alternative has to win, so "shell" is not cut to "ell".
  const glued = "ChatGPT said:ChatGPTshell\n{\"command\":\"run_command\"}";
  const out = strip(glued);
  ok("a glued 'shell' label is removed whole (not left as 'ell')",
    out.startsWith("{\"command\"") && !out.includes("ell\n"));

  // Same words INSIDE a payload still survive.
  const payload = '{"command":"write_file","params":{"content":"Should we shell out?"}}';
  const kept = strip("ChatGPT said:ChatGPTJSON" + payload);
  ok("payload with 'Should … shell' survives", kept.includes("Should we shell out?"));

  // SR_REPLY is still applied (it was briefly dropped): the speaker word goes.
  ok("the speaker word is still removed", !/^chatgpt\s+said/i.test(kept));
}

// ── turnSettled (review: no test for this) ─────────────────────────────────
// A turn that already has its injected result BELOW it cannot still be
// streaming. Without this, scrolling back through history makes the bar show
// Stop and the watchdog re-fire historical tool calls.
{
  const assistantTurn = (text) =>
    el("div", { attrs: { "data-turn-key": "t-" + text.slice(0, 4) } },
      [el("div", { class: "markdown" }, [text])]);
  // The injected result core writes back is a USER turn carrying "Output of '…'".
  const resultTurn = (tool) =>
    el("div", { class: "group/user-message" }, [`Output of '${tool}':\nok`]);

  const a = assistantTurn("running list_dir");
  const b = assistantTurn("still generating");
  const out = resultTurn("list_dir");

  // allItems() drives turnSettled, so point the stub at a specific transcript.
  const withChat = (nodes) => {
    messageNodes = nodes;
    return messageNodes;
  };

  withChat([a, out]);
  ok("a turn with its injected result below is settled",
    P.__test.turnSettled(a) === true);

  withChat([a, b]);
  ok("a turn followed by another assistant turn is NOT settled",
    P.__test.turnSettled(a) === false);

  withChat([a]);
  ok("the last turn is never settled", P.__test.turnSettled(a) === false);

  ok("a missing item is not settled", P.__test.turnSettled(null) === false);

  // The settled one must be the EARLIER turn: the later turn has nothing below.
  withChat([a, out]);
  ok("the trailing turn is not settled even when an earlier one is",
    P.__test.turnSettled(out) === false);
}

// ── Dual-side turn: mask the injected bubble, never the model's answer ─────
// ChatGPT 2026-11 groups one user message and the reply it produced inside a
// single [data-turn-key]. Hiding that container erased the answer too, so a run
// of tool results rendered as bare result chips with no text between them.
// The provider must point the core at the bubble subtree only.
{
  const bubble = el("div", { class: "group/user-message" }, ["Output of 'read_file': ok"]);
  const bubbleWrap = el("div", { class: "flex w-full" }, [bubble]);
  const reply = el("div", { class: "markdown" }, ["Here is what the file says."]);
  const turn = el("div", { attrs: { "data-turn-key": "t-dual" } }, [bubbleWrap, reply]);

  const masked = P.injectedHideNode(turn);
  ok("dual-side turn masks only the bubble wrapper", masked === bubbleWrap);
  ok("dual-side turn never masks the whole turn", masked !== turn);
  ok("the answer node is outside the masked wrapper", !masked || masked.querySelector(".markdown") === null);

  const direct = el("div", { attrs: { "data-turn-key": "t-direct" } }, [bubble, reply]);
  ok("a bubble that is a direct child is masked itself", P.injectedHideNode(direct) === bubble);

  ok("legacy bare user message falls back to whole-item masking",
    P.injectedHideNode(bubble) === null);
  ok("an assistant-only turn has nothing to mask",
    P.injectedHideNode(el("div", { attrs: { "data-turn-key": "t-a" } },
      [el("div", { class: "markdown" }, ["plain answer"])])) === null);

  // Measured live 2026-11-17: the two sides are SIBLINGS under one stack, so
  // climbing to the turn's direct child masked the answer as well - every
  // injected turn collapsed to a 36px chip (masked subtree held 2043 chars
  // including "ChatGPT said:"). The masked node must be the user block only.
  const youH4 = el("h4", { class: "sr-only m-0" }, ["You said:You"]);
  const userBubble = el("div", { class: "group/user-message flex flex-col items-end gap-2" },
    ["Output of 'run_command': ok"]);
  const userBlock = el("div", { class: "block-BQZwFn" }, [youH4, userBubble]);
  const gptH4 = el("h4", { class: "sr-only m-0" }, ["ChatGPT said:ChatGPT"]);
  const replyBlock = el("div", { class: "block-BQZwFn" },
    [gptH4, el("div", { class: "markdown" }, ["Saya periksa status proses."])]);
  const stack = el("div", { class: "flex flex-col stack-eQ550z" }, [userBlock, replyBlock]);
  const sided = el("div", { class: "flex flex-col gap-1.5" }, [stack]);
  const sidedTurn = el("div", { attrs: { "data-turn-key": "t-sib" } }, [sided]);
  const maskedSib = P.injectedHideNode(sidedTurn);

  ok("sibling layout masks the user block, not the shared stack", maskedSib === userBlock);
  ok("sibling layout keeps the reply block visible",
    !maskedSib || maskedSib.querySelector(".markdown") === null);
  ok("sibling layout never returns the wrapper or the turn",
    maskedSib !== sided && maskedSib !== sidedTurn);

  // Measured live 2026-11-17: a third desktop variant replaced .markdown with
  // [data-markdown-text-style="assistant-message"] whose code blocks carry
  // contain-intrinsic-block-size - innerText reports "" while textContent still
  // holds the envelope. Reading .markdown alone returned 0 chars, the watcher
  // stalled, and a perfectly valid {"command":"read_file"} sat on screen with no
  // chip and no bridge call. Both readers must survive an empty innerText.
  const jsonEnvelope = '{"command":"read_file","params":{"path":"a/b.html"}}';
  const code = el("code", { class: "whitespace-pre" }, [jsonEnvelope]);
  const pre = el("pre", {}, [code]);
  Object.defineProperty(pre, "innerText", { get: () => "" }); // the variant
  pre.textContent = jsonEnvelope;
  const newReply = el("div", { attrs: { "data-markdown-text-style": "assistant-message" } }, [pre]);
  const newTurn = el("div", { attrs: { "data-turn-key": "t-mdroot" } },
    [el("div", { class: "group/user-message" }, ["go"]), newReply]);
  ok("2026-11-17 markdown root is found by the reply selector",
    P.itemText(newTurn).includes('"command":"read_file"'));

  const plain = el("div", { class: "wrap-x" }, [jsonEnvelope]);
  Object.defineProperty(plain, "innerText", { get: () => "" });
  plain.textContent = jsonEnvelope;
  const plainTurn = el("div", { attrs: { "data-turn-key": "t-plain" } },
    [el("div", { class: "group/user-message" }, ["go"]), plain]);
  ok("shape-B fallback reads textContent when innerText is empty",
    P.itemText(plainTurn).includes('"command":"read_file"'));
}
