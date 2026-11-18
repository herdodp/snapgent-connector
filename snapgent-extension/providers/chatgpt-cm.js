// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt-cm.js - ChatGPT CodeMirror tap (runs in the MAIN world).
//
// WHY THIS EXISTS: ChatGPT renders fenced code blocks with CodeMirror, and the
// rendered DOM is NOT the document. Two separate defects stack up:
//
//  1. There is no "\n" text node anywhere - one <div class="cm-line"> per source
//     line - so textContent returns the whole script on ONE line. (Handled in
//     providers/chatgpt.js textWithout, which terminates every .cm-line.)
//  2. Long lines are rendered PARTIALLY. Measured live 2026-08 on this very
//     conversation: a block whose document is 10040 chars over 15 lines had all
//     15 .cm-line nodes present but only 2339 chars of text in them - 7701 chars
//     missing. A second block: 10077 chars of document, 2033 rendered, and the
//     rendered text stopped mid-JSON with no closing brace. Blocks under ~4000
//     chars came out whole, which is why short commands always worked and long
//     ones "cut off" - the user saw the chip's token counter climb to ~1000,
//     drop to ~500 and freeze there while ChatGPT was visibly still generating.
//     That ~500-token ceiling IS this ~2000-char rendering cap.
//     It is NOT caused by our camouflage: revealing the block (removing
//     .zs-tool-hide / .zs-cmd-mask) and re-measuring after a layout + 800ms gave
//     the exact same 2339 chars. CodeMirror simply does not put the whole
//     document in the DOM.
//
// The full text IS available - in CodeMirror's own state. ChatGPT's build hangs
// its view off a `cmTile` expando on the .cm-content node
// (content.cmTile.view.viewState.state.doc). An expando set by page JS is
// invisible from a content script's isolated world, hence this MAIN-world tap:
// it republishes each block's true document into a DOM attribute, which IS
// shared across worlds, so providers/chatgpt.js can read it.
//
// Protocol: the isolated world dispatches a "zs-cm-sync" CustomEvent on
// document; DOM event dispatch runs listeners SYNCHRONOUSLY across worlds, so by
// the time dispatchEvent() returns, every attribute is up to date and can be read
// in the same tick. If this script is not loaded, the attribute is simply absent
// and chatgpt.js falls back to joining .cm-line nodes (correct for short blocks).
(() => {
  "use strict";
  if (window.__zsChatgptCm) return;
  window.__zsChatgptCm = true;

  const ATTR = "data-zs-cm";
  const LEN = "data-zs-cm-len";

  // Republishing a 10k-char attribute on every sample would churn the DOM (the
  // core samples the stream ~8x/s). Only write when the document actually grew
  // or changed length, tracked per node so a re-render starts clean.
  const seen = new WeakMap();

  // The view can hang off the content node directly, or off its own dom's tile.
  function viewOf(content) {
    const t = content && content.cmTile;
    if (!t) return null;
    return t.view || (t.dom && t.dom.cmTile && t.dom.cmTile.view) || null;
  }

  function docOf(content) {
    const v = viewOf(content);
    if (!v) return null;
    // v.state is the public getter; viewState.state is where this build keeps it.
    const st = v.state || (v.viewState && v.viewState.state);
    return st && st.doc ? st.doc : null;
  }

  function syncOne(content) {
    const doc = docOf(content);
    if (!doc) return false;
    const len = doc.length;
    if (seen.get(content) === len && content.hasAttribute(ATTR)) return true;
    let text;
    try { text = doc.toString(); } catch { return false; }
    try {
      content.setAttribute(ATTR, text);
      content.setAttribute(LEN, String(len));
      seen.set(content, len);
    } catch { return false; }
    return true;
  }

  function syncAll() {
    let n = 0;
    for (const c of document.querySelectorAll(".cm-content")) if (syncOne(c)) n++;
    return n;
  }

  document.addEventListener("zs-cm-sync", () => { try { syncAll(); } catch {} }, true);

  // A streaming block changes without anyone asking, and the isolated world only
  // syncs when it reads. That is enough for correctness, but a cheap idle sync
  // keeps the attribute warm so the very first read of a finished block is
  // already current.
  const tick = () => { try { syncAll(); } catch {} };
  setInterval(tick, 1000);
  tick();

  // ── Typing bridge (MAIN world) ────────────────────────────────────────────
  // WHY: the isolated world prints the FIRST message and then loses the ability
  // to type into the ProseMirror composer - execCommand("insertText") returns
  // FALSE forever after while the attribute still reads contenteditable="true"
  // (measured live 2026-11-18: CONTEXT landed 2211/2211, every later send
  // reported len:0/want:2826). The SAME call from the page's own world succeeds
  // on a quiet page, but during a run ChatGPT keeps the edit commands disabled
  // in BOTH worlds, so execCommand is not a dependable transport at all.
  //
  // What IS dependable: ProseMirror's DOMObserver. Replacing the contentDOM with
  // paragraphs makes PM parse the change into a real transaction - measured live
  // 2026-11-18 19:0x: clearing the editor set state to "" and writing two <p>
  // nodes produced state "LINE-ONE\nLINE-TWO". No execCommand, no editing host
  // state, and nothing that ChatGPT can later rewrite as a pasted attachment.
  //
  // Protocol: "zs-type" (detail = JSON string) in, "zs-type-done" (detail = JSON
  // string) out, dispatched asynchronously because the DOM parse lands on the
  // next observer turn.
  document.addEventListener("zs-type", (ev) => {
    let req = null;
    try { req = JSON.parse(ev.detail || "{}"); } catch { return; }
    const id = req.id;
    const text = String(req.text == null ? "" : req.text);
    const done = (out) => {
      try {
        document.dispatchEvent(new CustomEvent("zs-type-done", { detail: JSON.stringify(out) }));
      } catch {}
    };
    const ed = req.sel ? document.querySelector(req.sel) : null;
    if (!ed) { done({ id, ok: false, len: 0, want: text.length, err: "no editor", path: "main" }); return; }
    // PM keeps the authoritative doc on the view desc; innerText is the fallback.
    const read = () => {
      try {
        const d = ed.pmViewDesc;
        if (d && d.node) return d.node.textBetween(0, d.node.content.size, "\n");
      } catch {}
      return ed.innerText || "";
    };

    const finish = (path) => {
      const got = read();
      const ok = got.length > 0 || text.length === 0;
      if (ok) { done({ id, ok: true, len: got.length, want: text.length, err: null, path }); return; }
      // Last resort once the DOM route is proven empty: the old execCommand path.
      let okc = true, errc = null;
      try {
        try { ed.focus(); } catch {}
        const rng = document.createRange();
        rng.selectNodeContents(ed);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(rng); try { document.execCommand("delete"); } catch {} rng.collapse(false); sel.removeAllRanges(); sel.addRange(rng); }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] && !document.execCommand("insertText", false, lines[i])) { okc = false; errc = "insertRejected@" + i; break; }
          if (i < lines.length - 1 && !document.execCommand("insertLineBreak")) { okc = false; errc = "lineBreakRejected@" + i; break; }
        }
      } catch (e) { okc = false; errc = String(e && e.message ? e.message : e).slice(0, 120); }
      const got2 = read();
      done({ id, ok: okc && (got2.length > 0 || text.length === 0), len: got2.length, want: text.length, err: errc, path: path + "+exec" });
    };

    // Route 1: DOM parse by ProseMirror.
    try {
      const frag = document.createDocumentFragment();
      for (const line of text.split("\n")) {
        const p = document.createElement("p");
        if (line) p.textContent = line;
        else p.appendChild(document.createElement("br"));
        frag.appendChild(p);
      }
      while (ed.firstChild) ed.removeChild(ed.firstChild);
      ed.appendChild(frag);
    } catch (e) {
      done({ id, ok: false, len: read().length, want: text.length, err: "domWriteFailed: " + String(e && e.message ? e.message : e).slice(0, 80), path: "main" });
      return;
    }
    // The observer parses on its own turn; 150ms is well past one frame.
    setTimeout(() => finish("dom"), 150);
  }, true);
})();
