// SPDX-License-Identifier: GPL-3.0-or-later
// providers/gemini.js - the Google Gemini (gemini.google.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Gemini support, simply remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Gemini DOM notes (validated live, 2026-06):
//  - Angular app with SEMANTIC custom elements - far more stable than hashed
//    CSS classes: one exchange = <div.conversation-container> holding a
//    <user-query> AND a <model-response>. We treat each of those two elements
//    as one "turn item" (alternating, in DOM order), which maps 1:1 onto the
//    core's expectations.
//  - The reply markdown lives in <message-content>; thinking-model reasoning
//    lives in <model-thoughts> (absent on non-thinking models).
//  - The composer is a Quill contenteditable (.ql-editor) guarded by Trusted
//    Types CSP: innerHTML assignment THROWS. Inject text via select-all +
//    document.execCommand("insertText") - validated to update Angular state.
//  - The primary action button (in <input-area-v2>) is identified by its
//    <mat-icon fonticon>: "arrow_upward" = send (text present), "stop" =
//    generating (whole stream, start to end - no indicatorless reasoning
//    phase like DeepSeek), "mic" = idle empty. aria-labels are localized,
//    fonticon names are NOT - we anchor on fonticon.
//  - No truncation "Continue" button; no per-turn "stopped" marker we can
//    rely on → findContinueBtn/turnHalted return null/false.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: "user-query",
    assistantItem: "model-response",
    anyItem: "user-query, model-response",
    reply: "message-content",
    thinking: "model-thoughts",
    editor: ".ql-editor[contenteditable='true']",
    inputArea: "input-area-v2",
    codeWrap: "code-block",
    errorSurfaces: 'mat-snack-bar-container,[role="alert"],[class*="error-message"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "limite.{0,20}(de contexte|atteinte)",
        "please.{0,30}start.{0,20}new.{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|temporarily unavailable/i,
  };

  // Gemini streams continuously with a hard stop-icon signal for the WHOLE
  // generation (including thinking), so idle windows can be much tighter than
  // DeepSeek's. Thinking models still get generous reasoning windows.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.tagName === "USER-QUERY";
  const isAssistantItem = (item) => !!item && item.tagName === "MODEL-RESPONSE";

  // Gemini prefixes every turn's textContent with a screen-reader label
  // ("Vous avez dit" / "Gemini a dit", inside .cdk-visually-hidden). That
  // prefix broke the core's anchored matching (e.g. /^Output of '/), so ALL
  // text extraction walks the tree and skips those (and any excluded) subtrees.
  const SR_HIDDEN = ".cdk-visually-hidden, [class*='screen-reader']";
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = SR_HIDDEN + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  // Non-thinking reply text only (tool blocks drafted inside the model's
  // reasoning must never be detected or executed).
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      return md && !md.closest(S.thinking) ? textWithout(md) : "";
    }
    return textWithout(item);
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      if (!md || (excludeSel && md.closest(excludeSel))) return "";
      return textWithout(md, excludeSel);
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => [...document.querySelectorAll(S.assistantItem)];
  const assistantCount = () => assistantItems().length;
  const userCount = () => document.querySelectorAll(S.userItem).length;
  // Scope to the SITE's composer only: skip snapgentV3's own injected UI (the
  // settings textarea #zs-set-text in #zs-root). On login/OAuth pages with no
  // site editor this returns null, keeping the "not on a chat page" guard in
  // the send hooks intact (otherwise our own textarea would defeat it and the
  // hooks could swallow the site's login button).
  const getEditor = () => {
    for (const sel of [S.editor, ".ql-editor"]) {
      for (const e of document.querySelectorAll(sel)) {
        if (!e.closest("#zs-root")) return e;
      }
    }
    return null;
  };
  const editorText = () => {
    const e = getEditor();
    return e ? e.textContent || "" : "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: no turns rendered yet, with the composer mounted.
  // NOTE: we intentionally do NOT also require the bare "/app" route anymore -
  // Gemini's own "New chat" button clears the turn list WITHOUT resetting the
  // address bar (it keeps the PREVIOUS conversation's /app/<id> until the first
  // message is actually sent, validated live 2026-07). Gating on the URL left
  // isFreshChat() - and, transitively, conversationKey() below - still seeing
  // the OLD conversation id on a chat that was visually empty, so the
  // snapgentV3 bar stuck on "Agent active" with no way to start a new session.
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  // The composer box the Start gate hides as one unit.
  const composerFrame = () => document.querySelector(S.inputArea);

  // Where the core mounts its in-flow status bar. The <input-area-v2> composer
  // sits inside a flex-COLUMN <fieldset.input-area-container>, so inserting the
  // bar right before the composer makes it span the full input width and push
  // the composer down (validated live). Returns {parent, before}.
  function barMount() {
    const ia = composerFrame();
    if (!ia) return null;
    const col = ia.parentElement; // fieldset.input-area-container (flex column)
    if (!col) return null;
    return { parent: col, before: ia };
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // Quill is a contenteditable: flipping contenteditable=false would also block
  // our own execCommand injection, so typeAndSend temporarily re-enables it.
  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    ed.setAttribute("contenteditable", on ? "false" : "true");
    const ph = ed.closest("rich-textarea") || ed;
    if (on) ph.setAttribute("data-zs-locked", "1");
    else ph.removeAttribute("data-zs-locked");
  }

  // ── Action button (send / stop / mic) ─────────────────────────────────────
  const iconName = (el) => {
    const i = el && el.querySelector("mat-icon");
    return i ? (i.getAttribute("fonticon") || i.getAttribute("data-mat-icon-name") || (i.textContent || "").trim()) : "";
  };
  function actionButtons() {
    const box = document.querySelector(S.inputArea);
    return box ? [...box.querySelectorAll("button")].filter((b) => b.offsetParent !== null) : [];
  }
  const findButtonByIcon = (name) => actionButtons().find((b) => iconName(b) === name) || null;
  const sendButton = () => findButtonByIcon("arrow_upward");
  const stopButton = () => findButtonByIcon("stop");

  // ── Generation detection ──────────────────────────────────────────────────
  // The stop icon is present for the ENTIRE generation (validated live), which
  // makes detection far simpler than DeepSeek. Growth tracking remains as a
  // belt-and-braces fallback for the instants around start/end.
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return (think ? think.textContent || "" : "") + "\n" + (md ? textWithout(md, ".zs-chip") : "");
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // CRITICAL Gemini quirk (validated live): the stop button can WEDGE in the ON
  // state after a generation finishes - the icon stays "stop" with the text
  // frozen, forever. Trusting it blindly pinned isGenerating() permanently true,
  // which froze the loop (no send, no auto-resume, Stop button stuck on). So the
  // stop button is treated as "live" only while the stream is actually advancing
  // (or it only just appeared - generation spinning up). Frozen past WEDGE_MS ⇒
  // wedged ⇒ not generating.
  const WEDGE_MS = 10000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  // Reset a WEDGED stop button. Gemini's action button can stay frozen on the
  // "stop" icon forever after a generation ENDS (the same quirk genActive guards
  // against for detection). When it does, the send (arrow_upward) button never
  // appears, so typeAndSend can't send and the injected tool result is stranded
  // in the composer (seen live: send.click found:false x4 → "Message could not
  // be sent"). Clicking the frozen stop resets the composer to its idle state and
  // arrow_upward reappears (validated live). Guarded by genActive so a genuinely
  // live generation is NEVER aborted. Returns true if it clicked.
  function unwedgeStop() {
    const stop = stopButton();
    if (stop && !genActive()) {
      diag("send.unwedge", {});
      try { stop.click(); } catch {}
      return true;
    }
    return false;
  }

  // Keep trying to unwedge for a bounded window, then confirm the send button
  // came back. One single attempt was not enough, and that is what made the
  // system prompt occasionally never leave the composer on Start:
  // genActive() latches true for 2s from the FIRST moment it sees a stop button
  // (`_stopSince`), so the very first unwedge attempt on a freshly-loaded page -
  // exactly the bootstrap case - is refused by its own guard. By the time the
  // latch expires, typeAndSend had already fallen through to the Enter fallback,
  // which does nothing on a wedged composer. Retrying across the latch window
  // fixes it without ever touching a genuinely live generation (genActive stays
  // true for the whole of a real stream, so every attempt is refused then).
  async function unwedgeStopPersistently(totalMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < totalMs) {
      if (sendButton()) return true;
      if (unwedgeStop() && await waitFor(() => !!sendButton(), 1500)) return true;
      await sleep(250);
    }
    return !!sendButton();
  }

  // Gemini exposes no reliable per-turn "stopped" marker → never halted.
  const turnHalted = () => false;
  // No truncation Continue button on Gemini.
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = it.querySelector(S.thinking);
      const md = it.querySelector(S.reply);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: md ? (md.textContent || "").length : 0,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return {
      present: true,
      reply: md ? textWithout(md, ".zs-chip").trim() : "",
      thinking: think ? (think.textContent || "").trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // Gemini's composer is a Quill editor wrapped by an Angular ControlValueAccessor.
  // We run in the extension's ISOLATED world, so the page's `window.Quill`
  // (and its instance API) is NOT reachable - we can only touch the shared DOM.
  // document.execCommand("insertText") drives the browser's native editing
  // pipeline, which fires the beforeinput/input events Quill's editor listens
  // to → its model updates, .ql-blank clears, the Angular CVA syncs and the send
  // button appears. This works reliably WHEN the composer is actually visible
  // (the Start gate is removed before the loop sends), which it always is during
  // the agentic loop. A selectAll first guarantees we replace any stale content.
  // PERF + FIDELITY (measured live, 2026): a single execCommand("insertText") of a
  // MULTI-LINE string is catastrophically slow in Gemini's Quill editor - every
  // "\n" makes Quill split the content into a new <p> block and re-normalise the
  // whole document, ~80ms PER LINE (linear). A ~90-line system prompt froze the
  // composer for ~7s under the "Working…" cover (big tool outputs stalled too).
  // We instead insert each line with insertText and join them with insertLineBreak
  // (a SOFT break, like Shift+Enter): the content stays in ONE block (~3ms/line,
  // ~430ms for 150 lines) yet Gemini STILL transmits the message as real, separate
  // lines (validated: the sent turn renders one query-text-line per line). Keeping
  // real line structure matters - an earlier attempt that flattened newlines to
  // U+2028 made the image-capable "Flash" model misfire into GENERATING AN IMAGE
  // at boot, because the prompt arrived as one mangled line. The first op runs over
  // the select-all so any stale content is replaced; empty lines skip insertText
  // (an empty insertText collapses the selection and breaks the following inserts).
  // Gemini has no server-side composer cap worth hitting, but its EDITOR does:
  // the insert cost below is paid per LINE, synchronously, on the page's main
  // thread, and it degrades as the document grows. A big tool result (validated
  // live: a 2599-line http_get) froze the whole page for ~a minute - nothing
  // clickable, the "Agent is working…" cover stuck, then it resumed on its own
  // once the insert finished. So the cap here is about the DOM cost, not the
  // model's context: keep head+tail, drop the middle, and tell the model that
  // content was dropped so it does not re-run the command.
  const SEND_MAX_CHARS = 120000;
  const SEND_MAX_LINES = 1200;   // the line count is what actually hurts
  function truncateForSend(text) {
    if (!text) return text;
    const lines = String(text).split("\n");
    if (text.length <= SEND_MAX_CHARS && lines.length <= SEND_MAX_LINES) return text;
    const marker = (what) =>
      `\n\n[…snapgentV3: result truncated (${what}) so it can be pasted into ` +
      `Gemini's composer without freezing the page. Do NOT re-run the command; ` +
      `work with the head and tail shown here…]\n\n`;
    let out, note;
    if (lines.length > SEND_MAX_LINES) {
      const head = Math.floor(SEND_MAX_LINES * 0.85);
      const tail = SEND_MAX_LINES - head;
      note = `${lines.length - SEND_MAX_LINES} of ${lines.length} lines omitted`;
      out = lines.slice(0, head).join("\n") + marker(note) + lines.slice(lines.length - tail).join("\n");
    } else {
      out = text;
    }
    if (out.length > SEND_MAX_CHARS) {
      const budget = SEND_MAX_CHARS - 300;
      const head = Math.floor(budget * 0.85);
      note = `${out.length - budget} of ${out.length} characters omitted`;
      out = out.slice(0, head) + marker(note) + out.slice(out.length - (budget - head));
    }
    diag("send.truncated", { from: text.length, to: out.length, lines: lines.length });
    return out;
  }

  // Yield to the event loop between chunks. Without this the whole insert is one
  // uninterruptible synchronous burst: the page cannot repaint or respond to a
  // click for its entire duration (the "I can't click anything anymore" report).
  // Yielding does not make the insert faster, it makes the page stay alive while
  // it happens - and lets the Stop button remain usable.
  const INSERT_CHUNK_LINES = 120;
  // ── Line-structure fingerprint ──────────────────────────────────────────
  // Quill turns every insertLineBreak into a soft <br> (a hard newline becomes a
  // fresh <p>), and NEITHER contributes a "\n" to textContent. A comparison that
  // just drops line breaks therefore accepts a write that LOST them: when
  // insertLineBreak silently no-ops, "line one\nline two" reaches the composer
  // as "line oneline two", the stripped strings match, and the message is sent
  // with its formatting gone (owner review 2026-11-25). So the lines are rebuilt
  // from the DOM itself and compared one by one. Only line breaks are derived
  // from structure: a space or tab is real content, and normalising it away would
  // make "read file" compare equal to "readfile".
  const BLOCK_TAGS = /^(P|DIV|LI|PRE|H[1-6]|BLOCKQUOTE|TR)$/;
  const isBlockEl = (n) =>
    !!n && n.nodeType === 1 && BLOCK_TAGS.test(String(n.tagName || "").toUpperCase());
  const isBrEl = (n) =>
    !!n && n.nodeType === 1 && String(n.tagName || "").toUpperCase() === "BR";
  // Lines inside one block: a <br> opens a new line, text accumulates into the
  // current one. An empty Quill line is <p><br></p> - ONE empty line, not two.
  function inlineLines(node) {
    const kids = Array.from(node.childNodes || []);
    if (kids.length === 1 && isBrEl(kids[0])) return [""];
    const lines = [""];
    const walk = (n) => {
      for (const c of Array.from(n.childNodes || [])) {
        if (c.nodeType === 3) {
          const parts = String(c.nodeValue || "").split(/\r\n?|\n/);
          lines[lines.length - 1] += parts[0];
          for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (isBrEl(c)) { lines.push(""); continue; }
        walk(c);
      }
    };
    walk(node);
    // A single trailing <br> inside a non-empty <p> is contenteditable's
    // line-end sentinel, not an extra blank line (an intentional trailing
    // newline is <p>…</p><p><br></p> or <p>…<br><br></p>).
    if (kids.length > 1 && isBrEl(kids[kids.length - 1]) && lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }
  // Every block element is its own line. Inline nodes at the editor root join
  // the line being built, so a composer that is not paragraph-wrapped still
  // works.
  function composerLines(ed) {
    if (!ed) return [""];
    const kids = Array.from(ed.childNodes || []);
    if (!kids.some(isBlockEl)) return inlineLines(ed);
    const lines = [];
    for (const k of kids) {
      if (isBlockEl(k)) { lines.push(...inlineLines(k)); continue; }
      if (isBrEl(k)) { lines.push(""); continue; }
      const ls = inlineLines(k);
      if (lines.length) { lines[lines.length - 1] += ls[0]; lines.push(...ls.slice(1)); }
      else lines.push(...ls);
    }
    return lines.length ? lines : [""];
  }
  const wantedLines = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").split("\n");
  // True only if the editor holds `text` line for line. An all-whitespace payload
  // has no fingerprint; there the only honest check is "no longer empty".
  function editorHolds(ed, text) {
    const want = wantedLines(text);
    const got = composerLines(ed);
    if (!want.join("").trim()) return got.join("").length > 0;
    return want.length === got.length && want.every((line, i) => line === got[i]);
  }
  // Whether the text really landed must be MEASURED, not assumed: execCommand
  // returns true and silently does nothing when the editable does not own focus.
  // Validated live on Gemini's Start path: every insertText returned true while
  // the composer stayed at length 0, no send (arrow_upward) button rendered, and
  // Start sat on "Starting…" until the empty-response timeout.
  //
  // The editor node is RE-RESOLVED on every pass on purpose. Angular remounts
  // the composer (Quill re-init) while a session starts, so the handle captured
  // a moment earlier is detached - and a detached element can never become
  // document.activeElement, so focus() and the insert that follows are both
  // silent no-ops even though the page looks perfectly normal. Same failure
  // class as ChatGPT's ProseMirror remount described in core/main.js.
  const editorUsable = (e) => !!e && e.isConnected !== false && e.offsetParent !== null;
  const focusEditor = async (fallbackEl, timeoutMs = 2500) => {
    const t0 = Date.now();
    let n = 0;
    let ed = getEditor() || fallbackEl;
    while (Date.now() - t0 < timeoutMs) {
      const live = getEditor();
      if (editorUsable(live)) ed = live;
      if (editorUsable(ed)) {
        if (document.activeElement === ed) return ed;
        // Blur whatever holds focus (Gemini parks it on <body> while the page is
        // still hydrating) and then take it.
        try {
          const a = document.activeElement;
          if (a && a !== ed && typeof a.blur === "function") a.blur();
        } catch {}
        try { ed.focus({ preventScroll: true }); } catch { try { ed.focus(); } catch {} }
        if (document.activeElement === ed) return ed;
        // focus() is not always enough: Quill hands the caret to its own text
        // node only after a pointer gesture, so every other pass replays a real
        // click sequence on the editor before focusing again.
        if (n % 2) {
          try {
            const r = ed.getBoundingClientRect();
            const o = {
              bubbles: true, cancelable: true, button: 0,
              clientX: r.left + 12, clientY: r.top + Math.max(8, r.height / 2),
            };
            ed.dispatchEvent(new MouseEvent("mousedown", o));
            ed.dispatchEvent(new MouseEvent("mouseup", o));
            ed.dispatchEvent(new MouseEvent("click", o));
            ed.focus({ preventScroll: true });
          } catch {}
          if (document.activeElement === ed) return ed;
        }
      }
      n++;
      await sleep(50);
    }
    return null;
  };

  // Last resort when focus cannot be taken at all: write the value straight into
  // the DOM and announce it. Gemini's Quill mirrors external DOM edits and emits
  // text-change, so the composer registers the text and the send button appears
  // (validated live in the extension's isolated world). innerHTML is blocked by
  // the page's Trusted Types policy - build nodes instead.
  function setEditorTextDom(ed, text) {
    const lines = String(text).split("\n");
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const p = document.createElement("p");
      if (line) p.textContent = line;
      else p.appendChild(document.createElement("br"));
      frag.appendChild(p);
    }
    if (typeof ed.replaceChildren === "function") ed.replaceChildren(frag);
    else { while (ed.firstChild) ed.removeChild(ed.firstChild); ed.appendChild(frag); }
    const data = String(text);
    ed.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data,
    }));
    ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
    ed.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Returns true only when the editor verifiably holds `text`.
  async function setEditorText(fallbackEl, text) {
    let ed = await focusEditor(fallbackEl);
    if (!ed) {
      // No focus anywhere: fall back to the DOM write rather than reporting a
      // failure that leaves Start stuck (it is also the only path that works in
      // some isolated-world/CSP combinations).
      const live = getEditor();
      if (!editorUsable(live)) return false;
      diag("send.domInsert", {});
      setEditorTextDom(live, text);
      ed = live;
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(range);
      const lines = String(text).split("\n");
      const t0 = Date.now();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) document.execCommand("insertText", false, lines[i]);
        if (i < lines.length - 1) document.execCommand("insertLineBreak");
        if (i && i % INSERT_CHUNK_LINES === 0) await sleep(0);
      }
      if (lines.length > INSERT_CHUNK_LINES) diag("send.insertDone", { lines: lines.length, ms: Date.now() - t0 });
    }
    const ok = editorHolds(getEditor() || ed, text);
    if (!ok) {
      diag("send.insertMiss", {
        focused: !!ed,
        wantLines: wantedLines(text).length,
        gotLines: composerLines(getEditor() || ed).length,
      });
    }
    return ok;
  }

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error("Gemini input box not found");
    // Cap BEFORE any comparison below, so the retry path's `!editorHolds(ed, text)`
    // test compares against what we actually typed.
    text = truncateForSend(text);
    const relock = _locked;
    if (relock) ed.setAttribute("contenteditable", "true"); // injection needs it editable
    try {
      // submitAndGetBase RETRIES this whole function (up to 4x) when the send
      // doesn't land within its window. Naively redoing both steps every retry
      // is destructive: (1) setEditorText's select-all + insertText wipes the
      // editor's internal reference to whatever is already pending, and (2)
      // pasting again attaches ANOTHER duplicate file on top of the first
      // (validated live: 3 retries produced 3 separate attach.dispatchPaste
      // calls with 3 different files, and the model's replies stayed generic
      // - it never got one coherent image). So: only retype if the text isn't
      // already there, and only attach if nothing is pending yet.
      if (!editorHolds(ed, text)) {
        if ((await setEditorText(ed, text)) === false) {
          // One cheap self-retry: a modal/cover can hold focus for a beat while
          // the composer mounts. A verified insert costs ~10ms once the editor
          // really owns focus, which is far cheaper than a core-level send
          // retry (1s sleep + jitter).
          diag("send.insertRetry", {});
          await sleep(150);
          if ((await setEditorText(ed, text)) === false) {
            diag("send.emptyComposer", { why: "insert no-op" });
            // Report the failure instead of leaving an empty composer behind:
            // submitAndGetBase treats an empty editor as "sent and cleared", the
            // false positive that stranded Start on "Starting…" for minutes.
            return false;
          }
        }
      }
      const hasPendingAttachment = () => {
        const box = document.querySelector(S.inputArea);
        return !!(box && box.querySelector("[class*='preview'], [class*='thumbnail']"));
      };
      if (images && images.length && !hasPendingAttachment()) {
        diag("attach.beforeCall", { count: images.length });
        try { const ok = await attachImages(images); diag("attach.afterCall", { ok }); }
        catch (e) { diag("attach.threw", { msg: String((e && e.message) || e) }); }
      }
      // A generation that just ended can leave the action button WEDGED on the
      // stop icon (see unwedgeStop), so arrow_upward never appears and the send
      // fails. If the stream is frozen yet a stop button shows, reset it first.
      if (!sendButton()) await unwedgeStopPersistently();
      // Wait for Angular to render the send (arrow_upward) button - proof that
      // it registered the text. The Quill-API injection (see setEditorText)
      // fires text-change so this resolves; if it doesn't, the send won't work.
      await waitFor(() => !!sendButton(), 3000);
      // Last resort before the Enter fallback: re-type. A composer that was
      // wedged when setEditorText ran can swallow the insert entirely, leaving
      // an empty editor and therefore no send button - the "Start did nothing,
      // the system prompt was never sent" report. Retyping now that the stop is
      // cleared is safe: the editor is either empty or holds our own text.
      if (!sendButton() && !editorHolds(ed, text)) {
        diag("send.retype", {});
        if ((await setEditorText(ed, text)) === false) {
          diag("send.emptyComposer", { why: "retype no-op" });
          return false;
        }
        await waitFor(() => !!sendButton(), 2000);
      }
      const btn = sendButton();
      diag("send.click", { found: !!btn, pending: hasPendingAttachment() });
      if (btn) { btn.click(); return true; }
      // Fallback: Enter sends in Gemini's composer.
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
      return true;
    } finally {
      if (relock) { const e2 = getEditor(); if (e2) e2.setAttribute("contenteditable", "false"); }
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  // No site modes to enforce on Gemini (model picker is left to the user).
  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "gemini" });
    return { ready: !!getEditor() };
  }

  // ── Error / limit detection (site chrome only) ────────────────────────────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.anyItem)) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best effort: paste onto the composer) ──────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `snapgentV3_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    const ed = getEditor();
    if (!ed) { diag("attach.noEditor"); return false; }
    if (!images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) { diag("attach.noDtItems"); return false; }
    diag("attach.dispatchPaste", { items: dt.items.length });
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // An upload preview appearing in the input area is the FAST accepted-signal,
    // but it renders instantly from a local blob: URL - well before Gemini
    // finishes uploading the file to its backend. Sending while the upload's
    // own progress spinner is still up silently drops the attachment (validated
    // live: the message went out text-only and the file sat in the composer,
    // unsent, indefinitely - even though the preview had long since appeared).
    const previewOk = await waitFor(() => {
      const box = document.querySelector(S.inputArea);
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']"));
    }, 15000);
    diag("attach.previewOk", { previewOk });
    if (!previewOk) return false;
    // Gemini's uploader renders a <mat-spinner> (Angular Material) inside the
    // file-preview container while the paste is still uploading to its backend
    // - NOT mat-progress-spinner. Missing it here made the wait resolve instantly,
    // so the send fired mid-upload and the file was dropped (text went out alone,
    // the attachment stuck loading in the composer). Verified live: the mat-spinner
    // is present ~2-4s (grows with file size), then removed on completion.
    const spinnerSel = 'mat-spinner, mat-progress-spinner, progress, [role="progressbar"]';
    const hasSpinner = () => {
      const box = document.querySelector(S.inputArea);
      return !!(box && box.querySelector(spinnerSel));
    };
    // The preview wrapper and the spinner mount in the SAME Angular render, so a
    // "no spinner ⇒ done" check can win a frame before the spinner appears and
    // resolve prematurely. First give the spinner a short window to show up; if it
    // never does (tiny file, instant upload) that's fine - proceed either way.
    await waitFor(hasSpinner, 1500);
    const spinnerCleared = await waitFor(() => !hasSpinner(), 20000);
    diag("attach.spinnerCleared", { spinnerCleared });
    return true;
  }
  function clearAttachments() {
    try {
      const box = document.querySelector(S.inputArea);
      if (!box) return;
      box.querySelectorAll("[aria-label*='upprimer'], [aria-label*='emove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }


  // A conversation with NO turns rendered yet is treated as transient ("") so
  // the core never persists it - and never stays sticky on it - as "started".
  // This covers both the bare "/app" route AND Gemini's "New chat" button,
  // which clears the turn list but keeps the PREVIOUS conversation's /app/<id>
  // in the address bar until the first message is actually sent (see
  // isFreshChat() above for the full story).
  const conversationKey = () =>
    (chatIsEmpty() || /\/app\/?$/.test(location.pathname)) ? "" : location.pathname;

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const btn = e.target && e.target.closest && e.target.closest(`${S.inputArea} button`);
        if (!btn) return;
        const ic = iconName(btn);
        if (ic === "stop") {
          // Only a REAL user click is a native stop. unwedgeStop() clicks this
          // same button programmatically to reset a frozen stop icon before a
          // send - that synthetic click (isTrusted=false) must NOT be mistaken
          // for the user halting the agent, or the next legit command gets
          // marked "stopped" and the loop wrongly winds down (seen live).
          if (!e.isTrusted) return;
          handlers.onNativeStop();
          return;
        }
        if (ic !== "arrow_upward") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // Gemini wraps each fenced code block in a <code-block> element (markers and
  // JSON survive intact in textContent), and a whole ###LUA###…###END_LUA### or
  // ###MCP_TOOL### block is ONE atomic code-block. So hiding is simple and
  // robust: hide every <code-block> in the reply whose text carries a command
  // shape, plus any bare top-level paragraph that holds an inline command (the
  // model is told to use code blocks, but this catches a stray inline one).
  // The host-walk the DeepSeek provider uses is WRONG here - it descends inside
  // a code-block, so hiding the wrapper then fails. The core anchors the chip at
  // the turn level (chipAtItemLevel), so the returned position is unused; this
  // function's real job is applying the .zs-tool-hide classes correctly.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const replies = [...item.querySelectorAll(S.reply)].filter((m) => !m.closest(S.thinking));
    let hidAny = null;
    for (const mc of replies) {
      // 1. Fenced code blocks carrying a command.
      mc.querySelectorAll(S.codeWrap).forEach((cb) => {
        if (cb.closest(".zs-chip")) return;
        if (CMD_SHAPE.test(cb.textContent || "")) {
          cb.classList.add("zs-tool-hide");
          // Angular recreates <code-block> nodes (markdown settle at end of
          // stream + again when the next turn is sent), stripping the class
          // above and flashing the raw command until the next sweep. The
          // <message-content> element KEEPS its identity through those
          // re-renders (validated live), so also mark it: the overlay.css
          // rule `message-content.zs-cmd-mask code-block` keeps every
          // recreated block hidden with zero flash.
          mc.classList.add("zs-cmd-mask");
          hidAny = hidAny || { parent: cb.parentElement, ref: cb };
        }
      });
      // 2. Bare top-level blocks with an inline command (no code-block inside).
      [...mc.children].forEach((el) => {
        if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
        const t = el.textContent || "";
        if (t.length < 600 && CMD_SHAPE.test(t)) {
          el.classList.add("zs-tool-hide");
          hidAny = hidAny || { parent: el.parentElement, ref: el };
        }
      });
    }
    return hidAny;
  }

  // ── Chip column alignment (measured live, 2026-11-23) ─────────────────────
  // Gemini renders the READABLE column separately from the turn box: on the
  // user's window the reply markdown is capped and centered inside
  // <model-response>, while the turn itself keeps the full scroller width. Our
  // chips hang off the TURN edges (the command chip at the model-response root,
  // the result pill justified to the right of the user turn), so in that layout
  // they sit ~80-160px outside the text the user is reading - reported as "chips
  // have no left/right padding that matches Gemini's own text output".
  //
  // The cap is a Gemini-side layout preference (it is 0px wide on a 1072px
  // window and >0 on the user's wider one), so hardcoding an inset would break
  // at the next window size. Instead the inset is MEASURED from a real reply and
  // published as two CSS variables that overlay.css applies to chip turns only:
  //   --zs-gem-col-l  left inset of the text column inside its turn
  //   --zs-gem-col-r  right inset of the text column inside its turn
  // Measured again on resize and on a slow interval (a reply can be re-laid out
  // by Angular without any resize), and cached so a steady page costs nothing.
  const COL_L = "--zs-gem-col-l";
  const COL_R = "--zs-gem-col-r";
  let colSig = "";

  // Pick the reply whose layout the chips must follow. Only a turn that sits in
  // a real `.conversation-container` counts: Gemini also keeps stray
  // <model-response> previews outside the transcript (measured live: one 900px
  // markdown at x362 while every transcript turn was 997px wide with a 48px
  // inset), and measuring that outlier would push every chip off by its delta.
  // The LAST such turn wins so a re-laid-out newest reply is what we follow.
  function currentColumnTurn() {
    // `.markdown` is the box we prefer, but every Gemini build we have seen puts
    // the reply text under `message-content`; falling back to the turn itself
    // keeps the measurement alive if a build renames the wrapper.
    const textOf = (t) => t.querySelector(".markdown, message-content, .response-content") || t;
    let pick = null;
    for (const t of document.querySelectorAll(S.assistantItem)) {
      const text = textOf(t);
      if (!text || text.getBoundingClientRect().width < 24) continue;
      if (!t.closest(".conversation-container")) continue;
      pick = { turn: t, text };
    }
    if (pick) return pick;
    const t = document.querySelector(S.assistantItem);
    if (!t) return null;
    const text = textOf(t);
    return text ? { turn: t, text } : null;
  }

  // Read the readable column of one reply, in two passes.
  //
  // Pass 1 (the `.markdown` box) is enough when Gemini caps that element itself:
  // it measured 900px inside a 1571px turn in the harness, and inset = box edges.
  //
  // Pass 2 exists because the user's real page (23 Nov 2026, 2236px window)
  // reported "still no padding": there `.markdown` spans the WHOLE turn and the
  // cap lives on the blocks inside it, so pass 1 answered 0/0 and the chips stayed
  // at the window edge while the text sat ~340px further in. In that layout the
  // column is measured from the rendered TEXT LINES instead: prose line boxes
  // only (`<pre>`, tables and images legitimately run wider), the left edge taken
  // as the most common line start (4px buckets) so an indented list item or a
  // centred heading cannot drag it, and the right inset mirrored - Gemini centres
  // that column inside the turn, which is exactly why both sides need the same
  // number.
  function textColumnInset(t, text) {
    const x = text.getBoundingClientRect();
    if (!x.width) return { l: 0, r: 0, source: "none", lines: 0 };
    const l0 = Math.max(0, Math.round(x.left - t.left));
    const r0 = Math.max(0, Math.round(t.right - x.right));
    if (l0 >= 4 || r0 >= 4) return { l: l0, r: r0, source: "markdown", lines: 0 };
    const run = document.createRange();
    const lefts = [];
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest("pre, table, code, img, svg, .code-block")) continue;
      run.selectNodeContents(node);
      for (const b of run.getClientRects()) {
        if (b.width < 8) continue;
        lefts.push(Math.round(b.left - t.left));
      }
    }
    // One measured line is enough: a short reply is still a reply, and refusing
    // to measure it is what left the user's chips at the window edge.
    if (!lefts.length) return { l: 0, r: 0, source: "none", lines: 0 };
    const buckets = new Map();
    for (const v of lefts) {
      const k = Math.round(v / 4) * 4;
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    let bestK = 0;
    let bestHits = -1;
    for (const [k, hits] of buckets) {
      if (hits > bestHits || (hits === bestHits && k < bestK)) {
        bestK = k;
        bestHits = hits;
      }
    }
    const l = Math.max(0, bestK);
    return { l, r: l, source: "text", lines: lefts.length };
  }

  function publishChipColumn(force) {
    const pick = currentColumnTurn();
    if (!pick) return;
    const t = pick.turn.getBoundingClientRect();
    if (!t.width) return;
    const m = textColumnInset(t, pick.text);
    // Kept on the page so a live probe (or the user reporting a miss) can read
    // which pass answered without opening the extension's isolated world.
    window.__zsGemColDebug = {
      l: m.l,
      r: m.r,
      source: m.source,
      lines: m.lines,
      turnW: Math.round(t.width),
      textW: Math.round(pick.text.getBoundingClientRect().width)
    };
    // Also mirrored onto the html element: DevTools' default console runs in the
    // page world and cannot see the isolated one, so `$0`-style poking or
    // "document.documentElement.dataset.zsGemCol" is how the user reports a miss.
    document.documentElement.dataset.zsGemCol =
      `${m.source}:${m.l}/${m.r} lines:${m.lines} turnW:${Math.round(t.width)}`;
    const sig = `${m.l}/${m.r}/${m.source}`;
    if (!force && sig === colSig) return;
    colSig = sig;
    const st = document.documentElement.style;
    st.setProperty(COL_L, `${m.l}px`);
    st.setProperty(COL_R, `${m.r}px`);
  }

  function installChipColumnWatch() {
    if (window.__zsGemColWatch) return;
    window.__zsGemColWatch = true;
    const kick = () => {
      try {
        publishChipColumn(false);
      } catch (_) {
        /* layout not ready yet; the next tick retries */
      }
    };
    window.addEventListener("resize", () => publishChipColumn(true), { passive: true });
    // A background tab throttles setInterval (verified live: the value stayed at
    // its first reading until the tab was brought to front), so the cheap
    // listener-driven kicks matter as much as the timer: scrolling and coming
    // back to the tab both re-measure immediately.
    window.addEventListener("scroll", kick, { passive: true, capture: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) publishChipColumn(true);
    });
    setInterval(kick, 1500);
  }

  // ── Chip anchor + mask target for injected USER turns ─────────────────────
  // Gemini's injected tool-result turn is a normal user message: the bubble
  // (span.user-query-bubble-with-background) carries the JSON we sent. Pinning
  // the chip at the turn root made it read like a sticker floating above the
  // bubble, so the chip is anchored INSIDE the bubble instead and only the text
  // inside that bubble is masked. Result: the chip reads as part of the user's
  // own message, exactly where the result payload sits.
  //
  // Not for our own system turns (bootstrap/reminder): those must keep the
  // whole turn masked with the status chip pinned at turn level, otherwise the
  // giant CONTEXT prompt would survive as a visible bubble.
  const BUBBLE_SEL = ".user-query-bubble-with-background, .query-content";
  const BUBBLE_TEXT_SEL = ".query-text, .query-text-line, .query-text-line p";

  function userBubble(item) {
    if (!isUserItem(item)) return null;
    const b = item.querySelector(BUBBLE_SEL);
    if (!b || b === item) return null;
    // Mask target must exist, otherwise masking would hide the bubble that now
    // holds our chip (chip invisible + rebuild loop).
    if (!b.querySelector(BUBBLE_TEXT_SEL)) return null;
    const txt = itemText(item);
    if (typeof ZS !== "undefined" && ZS.isSysPromptText && ZS.isSysPromptText(txt)) return null;
    return b;
  }
  // Chip goes into the bubble's inner flex row, next to where the text was.
  const chipAnchor = (item) => {
    const b = userBubble(item);
    return b ? (b.querySelector(".horizontal-container") || b) : null;
  };
  // Mask only the injected text line inside the bubble - never the bubble.
  const injectedHideNode = (item) => {
    const b = userBubble(item);
    return b ? b.querySelector(BUBBLE_TEXT_SEL) : null;
  };

  return {
    id: "gemini",
    displayName: "Gemini",
    // Gemini's web model is natively multimodal (image understanding), so
    // screen_capture is safe to expose here. Other providers default this
    // to false until confirmed live (see main.js BLOCKED_TOOLS gate).
    supportsVision: true,
    timings,
    // Reasoning-area selector, exported so the CORE's raw-command-visible probes
    // exclude it (same fix as DeepSeek): Gemini's thinking models (2.5 Pro/Flash)
    // render their reasoning in <model-thoughts> and often QUOTE the command
    // JSON/###LUA### there. The camouflage never hides that quote (by design), so
    // without this exclusion the core reads it as "raw block still visible"
    // forever - the chip then FLAPS done→run→done and rebuilds on every sweep.
    thinkingSel: S.thinking,
    // Gemini (Angular) re-renders a turn's content subtree on every update,
    // wiping any chip placed inside it. Tell the core to anchor chips at the
    // turn-element level instead, where they survive those re-renders.
    chipAtItemLevel: true,
    // Result chips live inside the user's bubble (see chipAnchor above) and
    // only the injected text line is masked (injectedHideNode), so the bubble
    // frame keeps the chip visible.
    chipAnchor,
    injectedHideNode,
    // The "Working…" input cover overshoots the editor box by this many px on
    // each side. Gemini's Quill keeps typed text near the rounded corners, so a
    // few px of bleed hides the slivers that would otherwise peek (see placeBar /
    // inputCover). Providers with a native <textarea> omit this (default 0).
    coverPad: 8,
    // Gemini's .ql-editor rect sits a few px below the visual input-box centre,
    // so nudge the "Agent is working…" cover up to read as vertically centred.
    coverOffsetY: -6,
    // Gemini's turn elements are semantic and never virtualized away, so
    // assistantCount() reliably increases for every new reply. The core's
    // watcher uses this to refuse finalizing before this send's reply turn
    // exists (fixes premature loop.end on the previous turn's stable text).
    reliableCounts: true,
    init({ diag: d } = {}) {
      if (d) diag = d;
      // Keep our chip turns on Gemini's readable column (publishChipColumn).
      try {
        installChipColumnWatch();
      } catch (_) {
        /* no DOM yet (unit test harness); harmless */
      }
    },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    // Exported for live probes/tests: re-measure the readable column now, and
    // read which pass answered (markdown box vs text lines) plus the numbers.
    publishChipColumn,
    chipColumnDebug: () => window.__zsGemColDebug || null,
  };
})();
