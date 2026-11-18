// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt.js - the OpenAI ChatGPT (chatgpt.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js and
// providers/gemini.js; the core (core/main.js) is provider-agnostic. To DISABLE
// ChatGPT support, remove this file from manifest.json (and its URL from
// background.js PROVIDER_URLS + manifest host_permissions + popup.js
// SUPPORTED_HOSTS + main.js AI_SITES).
//
// ChatGPT DOM notes (re-validated live, 2026-08 - chatgpt.com, logged in, fr-FR):
//  - The classic React app uses one <div data-message-author-role="user|assistant">
//    per message, with a stable data-message-id. The newer ChatGPT layout renders
//    assistant replies in a `.DilResponseRoot-*` element without those attributes.
//    Both are treated as turn items; the newer layout uses the assistant count
//    fallback to detect a newly rendered reply.
//  - The reply markdown lives in <div class="markdown">. ChatGPT does NOT prefix
//    text with a screen-reader label (unlike Gemini), but textContent is still
//    NOT usable: code blocks are CodeMirror (.cm-line per line, zero "\n" text
//    nodes), so textContent returns the whole script on one line. Always read a
//    reply through textWithout() - see the note there; this was the single
//    biggest cause of failed tool calls (2026-08).
//    Reasoning (thinking models) renders OUTSIDE .markdown, so reading only the
//    .markdown naturally excludes drafts the model writes while reasoning.
//  - The composer is usually a ProseMirror contenteditable: <div
//    id="prompt-textarea">. Newer layouts may identify it as a textbox labelled
//    "Ask ChatGPT"; compact layouts can instead expose a controlled textarea
//    marked [data-mobile-composer-prompt], which needs its native value setter
//    plus an input event.
//  - The send button is #composer-submit-button (data-testid="send-button"); it
//    appears only once the composer has text. While generating, a stop button
//    data-testid="stop-button" is present for the ENTIRE generation (including
//    any reasoning phase) - a reliable single signal, like Gemini's stop icon.
//  - Fenced code blocks render as ONE outer <pre> inside .markdown (holding the
//    language label + copy bar + the code). A FENCED ###LUA###…###END_LUA### /
//    JSON command block is therefore one atomic <pre>, and hiding it is simple.
//    But the model does not always fence it: seen live 2026-08, a 208-line
//    ###LUA### block written as plain prose was rendered as 68 SIBLING nodes
//    (<p> for the flush lines, <pre> for the indented ones), and only the first
//    carried the marker - so a per-element match hid the opener and left the
//    whole script on screen. findToolBlockSpot hides the marker-to-marker RANGE
//    for that shape; see there.
//  - Image upload: <input type="file" data-testid="upload-photos-input">.
//  - "Analyser" (Think) is a per-message toggle pill in the composer - a <button>
//    with aria-pressed, class __composer-pill. We deliberately do NOT drive it:
//    like the model picker, the reasoning mode is the user's choice. On the free
//    tier it is quota-capped ("l'analyse sont indisponibles jusqu'à la
//    réinitialisation de votre quota"), and when the quota is out the pill stays
//    pressed but the reply comes back non-reasoning - which is harmless here.
//  - NOT YET ESTABLISHED: whether a reasoning-mode reply renders its thinking in
//    a container outside .markdown, and what selects it. Every reply observed so
//    far (2026-08, free tier) had no such element, so `thinkingSel` is not
//    exported. If reasoning ever quotes a command block, the core's
//    "raw command still visible" probe could flap - that is the symptom to watch
//    for, and the fix is to export thinkingSel here (see deepseek.js).
//  - New chat: <a data-testid="create-new-chat-button" href="/">. A blank new
//    chat is exactly "/"; a conversation is /c/<id>.
//  - ChatGPT's free tier caps messages, and caps image/file input SEPARATELY, so
//    vision is disabled here (supportsVision: false) rather than working only
//    part of the day. ChatGPT announces the quota walls itself, in the thread.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    // 2026-11 (desktop): ChatGPT dropped BOTH data-message-author-role AND
    // .markdown. A turn is now a [data-turn-key] container holding a user bubble
    // ([class*="group/user-message"]) and an assistant bubble whose only stable
    // marker is a hashed class. Measured live (Chrome 157, 13 Nov 2026):
    // authorRole=0, DilResponseRoot=0, markdown=0, groupUser=4, turnKey=2 - which
    // is exactly why Start reported
    // "reply was never read (0 chars) - message DOM not matched".
    // The structural probes are APPENDED, so older layouts keep working.
    // 2026-11-18: the newest desktop markup replaced [data-turn-key] with
    // [data-talvt-turn-state] (measured live: turnKey=0, talvt=1 per turn), so the
    // turn wrapper has to be in this list or allItems() is empty and every reply
    // looks like "never read". The role now lives on sr-only headings inside the
    // turn: h4[data-conversation-role="user|assistant"].
    msg: '[data-message-author-role],[class*="DilResponseRoot"],[data-turn-key],[data-talvt-turn-state]',
    userRole: "user",
    assistantRole: "assistant",
    // 2026-11-17: a THIRD desktop variant dropped .markdown entirely. The
    // assistant body is now [data-markdown-text-style="assistant-message"]
    // (inner .MarkdownRoot-*), and its code blocks render with
    // contain-intrinsic-block-size, so innerText reports ~0 chars for content the
    // DOM still holds. Reading only .markdown made the watcher see "reply 0
    // chars" on every new turn: a valid {"command":…} sat on screen and was never
    // parsed, the tool never ran and the session stalled. textContent is already
    // the safe source here (textWithout walks nodeValue).
    reply: '.markdown,[data-markdown-text-style="assistant-message"]',
    editor: '#prompt-textarea,[data-mobile-composer-prompt],textarea[aria-label="Chat with ChatGPT"],[role="textbox"][aria-label="Ask ChatGPT"]',
    // The ONE submit control; its data-testid says whether it is currently a
    // send or a stop button (see isStopBtn). Id first - it survives testid churn.
    // 2026-11-18: ChatGPT's composer send control is now a bare
    // `button[aria-label="Send"]` - no id, no data-testid (measured live: the
    // old `#composer-submit-button` / `data-testid=send-button` are gone). With
    // only "Send message" in this list the click guard found NO button, so the
    // injected message was never submitted and the loop sat on "Starting…"
    // forever with no reply (user report: "ga ngepaste output"). Keep the old
    // selectors too - A/B variants and other locales still use them.
    submitBtn: "#composer-submit-button, button[data-testid='send-button'], button[data-testid='stop-button'], button[aria-label='Send'], button[aria-label='Send message'], button[aria-label='Envoyer'], button[aria-label*='Stop'], button[aria-label*='stop'], button[aria-label*='Interrompre'], button[aria-label*='Arrêter']",
    // Kept for installSendHooks, which needs to recognise a click on the native
    // stop control wherever it lives.
    stopBtn: "button[data-testid='stop-button']",
    codeWrap: "pre",
    // composer frame: the <form> that wraps the ProseMirror editor.
    errorSurfaces: '[role="alert"],[data-testid*="error"],[class*="error-message"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "maximum.{0,20}(context|length)",
        "(token|context).{0,10}limit",
        "the message you submitted was too long",
        "le message.{0,30}trop long",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)|message you submitted was too long/i,
    // ChatGPT errors / rate limits ("something went wrong", "you've reached our
    // limit of messages", quota walls). Kept SHORT-message-gated by the core.
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|reached.{0,20}limit of messages|limite de messages|usage cap|temporarily unavailable/i,
    // The native "Continue generating" affordance after a length truncation.
    continueBtn: /^(continue generating|continuer (?:à|a) générer|continue)$/i,
    // Quota wall / paused conversation. Seen live (fr): "Chat en pause jusqu'à la
    // réinitialisation du quota à 23:03 - Vous avez épuisé le quota de chats avec
    // fichiers ou images."
    paused: /chat en pause|conversation.{0,15}(en pause|paused)|quota de chats|r[ée]initialisation du quota|you.{0,3}ve (?:hit|reached).{0,20}limit|quota (?:reset|exceeded)|out of (?:messages|credits)/i,
  };

  // ChatGPT streams continuously with a hard stop-button signal for the WHOLE
  // generation (including reasoning), so windows can be tight like Gemini.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  // 2026-11 desktop changed the message DOM, so a turn is now identified by its
  // STRUCTURAL container instead of the removed author-role attributes:
  //   <div data-turn-key="…">
  //     <div …><div class="group/user-message">…user text…</div></div>
  //     <div …><h4 class="sr-only"><span>ChatGPT said:</span></h4>…reply…</div>
  //   </div>
  const TURN_SEL = '[data-turn-key],[data-talvt-turn-state]';
  const isTurnKeyItem = (item) => !!(item && item.matches && item.matches(TURN_SEL));
  const role = (item) => {
    const attr = item && item.getAttribute ? item.getAttribute("data-message-author-role") : null;
    if (attr) return attr;
    // New markup: the container itself carries the turn, the role lives inside it.
    if (isTurnKeyItem(item)) return "turn";
    return null;
  };
  // The user bubble is a DESCENDANT of the [data-turn-key] item, so the old
  // `closest('[class*="group/user-message"]')` probe walked ANCESTORS and could
  // never match: role() returned "turn", isAssistantItem() then claimed every
  // turn unconditionally, and classifyText's assistant-first branch read an empty
  // string for user turns (their text is excluded by inUser()). That silently
  // killed, in the new layout only: the injected-feedback chip + .zs-hidden
  // camouflage, SYS_MARKER hiding, preHideWholeItems, the sinceLastSysInDom user
  // tally, the "next is user" fallback and landed()'s preUser check.
  // Detect on the descendant, and treat a turn as the ASSISTANT only when it has
  // no user bubble.
  const turnHasUserBubble = (item) =>
    !!(item && item.querySelector && item.querySelector('[class*="group/user-message"]'));
  const isUserItem = (item) => {
    if (role(item) === S.userRole) return true;
    if (!item) return false;
    // A bare bubble handed to us directly still reports itself.
    if (item.closest && item.closest('[class*="group/user-message"]')) return true;
    return isTurnKeyItem(item) && turnHasUserBubble(item);
  };
  const isDilReply = (item) => !!(item && item.matches && item.matches('[class*="DilResponseRoot"]'));
  const isAssistantItem = (item) => {
    if (role(item) === S.assistantRole || isDilReply(item)) return true;
    if (!isTurnKeyItem(item)) return false;
    // New layout: one container holds BOTH sides, so a turn is the assistant
    // surface only if it carries no user bubble of its own.
    if (turnHasUserBubble(item)) {
      // ...EXCEPT the 2026-11-17 markup, where the reply to a user message lives
      // INSIDE that same [data-turn-key] (siblings under one stack: user-block
      // then reply-block). "No user bubble" then matched no turn at all, so
      // assistantItems() stayed empty, lastAssistant() pointed at an older
      // 731-char turn, and a fresh {"command":…} reply was invisible: the resume
      // watchdog re-fired that historical command every ~30 s instead of running
      // the new one (measured live 2026-11-17: 60 identical list_dir calls).
      // A mixed turn IS the assistant surface when it carries a command block.
      // 2026-11-18 layout: the reply side is marked by an sr-only heading
      // h4[data-conversation-role="assistant"] inside the same turn. Without this a
      // narration-only reply (no command block) was not counted as an assistant
      // turn at all, so the watcher never saw the text.
      if (item.querySelector('[data-conversation-role="assistant"]')) return true;
      return turnAssistantBlocks(item).length > 0;
    }
    return true;
  };

  // Masking a whole turn in the 2026-11 layout erased the model's own answer,
  // because one [data-turn-key] holds our injected user bubble AND the reply the
  // model wrote after reading it. That left "· result" chips with no visible
  // narration between them.
  //
  // First fix (2026-11-13) climbed to the turn's direct child - and that is STILL
  // too high on the 17 Nov markup, where both sides live as SIBLINGS under one
  // stack inside the turn:
  //   [data-turn-key]
  //     div.zs-chip                    ← our chip (visible)
  //     div                            ← box wrapping everything below
  //       div.stack
  //         div.user-block             ← h4 "You said:" + div.group/user-message
  //         div.reply-block            ← h4 "ChatGPT said:" + the answer
  // Masking the stack hid the ANSWER as well: measured live, the masked subtree
  // carried 2043 chars including "ChatGPT said:", so every injected turn
  // collapsed to a 36px chip with no narration (reported 2026-11-17).
  //
  // Climb from the bubble only while the parent adds NO sibling content besides a
  // screen-reader heading, so the masked node is the user block alone. Legacy
  // surfaces (a bare user message element) still return null and the core masks
  // the item itself.
  const injectedHideNode = (item) => {
    if (!item || !item.querySelector || !isTurnKeyItem(item)) return null;
    const bubble = item.querySelector('[class*="group/user-message"]');
    if (!bubble || bubble === item) return null;
    let node = bubble;
    while (node.parentElement && node.parentElement !== item) {
      const parent = node.parentElement;
      const hasOtherSide = [...parent.children].some(
        (child) => child !== node && !/^H[1-6]$/.test(child.tagName)
      );
      if (hasOtherSide) break;
      node = parent;
    }
    return node === item ? null : node;
  };

  // The assistant reply inside a new-style turn comes in TWO shapes, and they
  // alternate between replies:
  //   A) fenced code  → <div class="… zs-cmd-mask"> … <pre>{"command":…}</pre>
  //   B) plain text   → <div class="zs-tool-hide">ChatGPT said:ChatGPTJSON{"command":…}</div>
  //      (NO <pre> at all - measured: preAsst=0, hide=1)
  // Reading only <pre> made the bar sit on "ChatGPT returned an empty reply"
  // while the tool chip spun forever, because shape B yielded zero nodes.
  // .zs-tool-hide must NEVER be excluded: the core itself uses that class to mark
  // the block it already consumed.
  const SR_REPLY = /^\s*(?:chatgpt\s+(?:said|dit))\s*:?\s*/i;
  const turnAssistantBlocks = (item) => {
    if (!isTurnKeyItem(item)) return [];
    const inUser = (el) => !!el.closest('[class*="group/user-message"]');
    // innerText is EMPTY for code blocks rendered with contain-intrinsic-block-size
    // (2026-11-17 variant) while textContent still has the payload, so probe both.
    const bodyText = (el) => (el.innerText || "") + "\n" + (el.textContent || "");
    const pres = [...item.querySelectorAll("pre")].filter(
      (p) => !inUser(p) && /[{[]/.test(bodyText(p))
    );
    if (pres.length) return pres;
    // Shape B: plain text. Take the DEEPEST wrapper that still carries the
    // envelope, i.e. the one whose text starts at the payload.
    return [...item.querySelectorAll("div")]
      .filter((d) => {
        if (inUser(d)) return false;
        const t = bodyText(d);
        if (!/\{/.test(t) || /you\s+said\s*:/i.test(t)) return false;
        return /"(?:command|params|tool)"\s*:/.test(t);
      })
      .slice(-1);
  };
  const replyNodes = (item) => {
    if (isDilReply(item)) return [item];
    const native = [...item.querySelectorAll(S.reply)];
    if (native.length) return native;
    return turnAssistantBlocks(item);
  };

  // Text extraction that can skip our own chip (and any excluded subtree).
  //
  // CRITICAL: this must NOT be `textContent`. ChatGPT renders fenced code blocks
  // with CodeMirror - <div class="cm-content"> holding ONE <div class="cm-line">
  // per line - and there is not a single "\n" text node in the whole block.
  // textContent therefore returns the entire script glued onto ONE line:
  //   "###LUA###local total = 0local count = 1000for i = 1, count do…"
  // Measured live 2026-08 on a 479-line block: textContent 8917 chars with 0
  // newlines; joining the .cm-line children gave 9395 chars, both markers intact
  // (CodeMirror renders every line here - no viewport virtualization observed,
  // checked up to 479 lines). That collapse is what broke MOST tool calls in a
  // real session: the core's parser saw the opening marker fused to the first
  // statement and reported "Failed to parse command code / your code block was
  // empty", and on the runs that did execute, Roblox reported every error at
  // "AssistantCommand:1" because the whole script really was one line.
  // So: emit a newline for every cm-line (even an empty one - blank lines must
  // survive or reported line numbers shift), for <br>, and at block boundaries
  // (which also gives the unfenced-prose shape a usable line structure).
  //
  // Joining the .cm-line nodes is still not enough on its own: CodeMirror renders
  // LONG LINES only partially, so a big block's DOM text stops early (measured:
  // 2339 of 10040 chars, and a sibling block cut off mid-JSON). The real document
  // lives in CodeMirror's state, behind a page-world expando a content script
  // cannot see - providers/chatgpt-cm.js runs in the MAIN world and republishes it
  // into data-zs-cm. syncCM() asks for a refresh; the listener is synchronous, so
  // the attribute is current the moment dispatchEvent returns. If that script is
  // absent the attribute is too, and we fall back to the .cm-line join (which is
  // correct for anything under ~4000 chars).
  const BLOCK_TAGS = /^(?:P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|TR|SECTION|ARTICLE|HR)$/;
  let _cmWarned = false;
  function syncCM(root) {
    if (!root || !root.querySelector || !root.querySelector(".cm-content")) return;
    try { document.dispatchEvent(new CustomEvent("zs-cm-sync")); } catch {}
  }
  function textWithout(root, excludeSel) {
    if (!root) return "";
    syncCM(root);
    let t = "";
    const breakLine = () => { if (t && !t.endsWith("\n")) t += "\n"; };
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (excludeSel && n.matches && n.matches(excludeSel)) return;
      if (n.tagName === "BR") { t += "\n"; return; }
      // The editor's TRUE document, published by the MAIN-world tap. This is the
      // only complete source for a long block - take it and skip the subtree.
      if (n.classList && n.classList.contains("cm-content")) {
        const full = n.getAttribute("data-zs-cm");
        if (full !== null) {
          breakLine();
          t += full;
          breakLine();
          return;
        }
        if (!_cmWarned) {
          _cmWarned = true;
          diag("cm.noTap", { note: "chatgpt-cm.js not loaded; long code blocks may be truncated" });
        }
        // fall through to the .cm-line walk below
      }
      // One CodeMirror line = one source line, ALWAYS terminated - an empty
      // .cm-line is a blank line in the source and must not be swallowed.
      if (n.classList && n.classList.contains("cm-line")) {
        for (const c of n.childNodes) walk(c);
        t += "\n";
        return;
      }
      const isBlock = BLOCK_TAGS.test(n.tagName);
      if (isBlock) breakLine();
      for (const c of n.childNodes) walk(c);
      if (isBlock) breakLine();
    };
    walk(root);
    return t;
  }

  // Non-reasoning reply text only: join the .markdown container(s). Reasoning
  // renders outside .markdown, so this never sees tool blocks the model merely
  // drafts while thinking.
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      // textWithout, never textContent - see the CodeMirror note there.
      return replyNodes(item).map((m) => textWithout(m)).join("\n");
    }
    return isUserItem(item) ? stripSrPrefix(textWithout(item)) : textWithout(item);
  }

  // ChatGPT's user turns can start with a visually hidden screen-reader label
  // ("You said:" / "Vous avez dit :"). It sits in front of the injected
  // "Output of '...'" caption, so the core's ^-anchored isInjectedFeedback test
  // missed the turn and the raw result stayed on screen as a blue bubble.
  const SR_PREFIX = /^\s*(?:you said|vous avez dit|you wrote|tu as dit|usted dijo|du hast gesagt)\s*:?\s*/i;
  const stripSrPrefix = (t) => (t ? t.replace(SR_PREFIX, "") : t);

  // Assistant turns carry the mirrored label. Shape B of the 2026-11 desktop
  // bubble reads, verbatim:
  //   "ChatGPT said:ChatGPTJSON{"command":"read_file","params":{"path":"…"}}"
  // The speaker word is repeated with NO separator, and a bare language label
  // ("JSON") sits between it and the envelope. Left in place, the parser received
  // a payload glued behind that chrome and no command ever matched.
  // GATED to shape B only. Stripping unconditionally mangled shape-A replies:
  // the leading /^chatgpt/i cut a legitimate "ChatGPT ..." opening, the global
  // speaker-word removal ate "{option} ChatGPT said" style examples, and the
  // brace slice chopped markdown before the first "[" - and that corrupted text
  // is exactly what feeds kind:"text" loop context. Parsing does not need it:
  // extractToolAnywhere/CMD_KEY_RE. So strip only when the raw text actually
  // carries the glued 2026-11 chrome.
  // Shape B opens with the speaker word AND/OR the bare language label; both are
  // chrome, never content. Requiring the payload directly behind them keeps
  // ordinary prose ("Python is a language.") untouched.
  // A BARE LANGUAGE LABEL may sit between the speaker chrome and the payload
  // ("ChatGPT said:ChatGPTJSON{...}"). Two traps this pattern has to avoid, both
  // present in the original and both destructive:
  //
  //   1. No word boundary. Without `\b`, a reply starting "Should we proceed?"
  //      was eaten by the `sh` alternative ("ould we proceed?"), and a leading
  //      "Text of the file follows" was consumed whole.
  //   2. Alternation order. `sh` comes before `shell`, so "shell\nls" matched
  //      `sh` first and became "ell\nls". Longest-first ordering fixes that.
  //
  // Requiring a separator after the label (colon, newline, or a payload brace)
  // keeps ordinary prose that merely STARTS with one of these words intact.
  const LANG_LABEL_SEQ =
    "javascript|plaintext|python|shell|bash|json|html|text|xml|sql|lua|yaml|css|js|sh";
  const LANG_LABEL_PREFIX = new RegExp(
    "^\\s*(?:" + LANG_LABEL_SEQ + ")\\b\\s*(?::\\s*|\\n\\s*|(?=[{[]))",
    "i"
  );
  // Detectability probe: is a bare label glued in front of the payload at all?
  const LANG_LABEL = new RegExp("^(?:" + LANG_LABEL_SEQ + ")\\b", "i");
  const LOOKS_GLUED = (t) => {
    if (!t) return false;
    // Burn the chrome in the SAME order the stripper does: speaker word, then a
    // second glued "ChatGPT", then the bare language label (see the verbatim
    // sample above: "ChatGPT said:ChatGPTJSON{…}"). The label pass is the same
    // LANG_LABEL_PREFIX the stripper uses, so detection and removal can never
    // disagree about what counts as chrome.
    const payload = t.slice(0, 96)
      .replace(SR_REPLY, "")
      .replace(/^chatgpt\s*/i, "")
      .replace(LANG_LABEL_PREFIX, "");
    if (!/^\s*[{[]/.test(payload)) return false;
    // Only a string that actually carried some chrome gets stripped.
    return payload.length < t.replace(/^\s+/, "").length;
  };
  // Strip the 2026-11 speaker chrome from the START of a reply, and nothing else.
  //
  // `anything` is a BARE LANGUAGE LABEL glued in front of the payload ("ChatGPT
  // said:ChatGPTJSON{...}"). Both belong to the reply's chrome, never to content.
  //
  // ANCHORED ON PURPOSE. This used to be a GLOBAL replace
  // (/chatgpt\s+(?:said|dit)\s*:?/gi), which deleted the words from the middle of
  // a payload too - a write_file whose content literally contained "ChatGPT
  // said:" lost that text silently. The brace slice below had the same flaw: it
  // cut everything before the first "{" or "[", so any prose that happened to
  // precede a command envelope was destroyed.
  //
  // Takes ONE argument now; the callers used to pass two, so the second (the DOM
  // item) was meaningless.
  const stripAssistantSrPrefix = (t) => {
    if (!t) return t;
    if (!LOOKS_GLUED(t)) return t;
    // Only the leading chrome, in the same order LOOKS_GLUED burns it. SR_REPLY
    // is the speaker word ("ChatGPT said:" / "ChatGPT dit:"); the bare "ChatGPT"
    // pass drops the doubled word the 2026-11 chrome repeats; the label pass
    // removes a glued language name. All three are anchored, so a payload keeps
    // its own text.
    return t
      .replace(SR_REPLY, "")
      .replace(/^chatgpt\s*/i, "")
      .replace(LANG_LABEL_PREFIX, "");
  };

  function classifyText(item, excludeSel) {
    // USER FIRST. In the 2026-11 layout one container holds both sides, so a
    // turn can be user-ness and assistant-ness at once; the assistant branch
    // reads only the reply nodes and returns "" for a user turn, which is what
    // broke the injected-feedback / camouflage / tally logic.
    if (isUserItem(item) && !(role(item) === S.assistantRole || isDilReply(item))) {
      const userSel = `[class*="group/user-message"]`;
      const bubble = isTurnKeyItem(item) ? item.querySelector(userSel) : null;
      return stripSrPrefix(textWithout(bubble || item, excludeSel));
    }
    if (isAssistantItem(item)) {
      return stripAssistantSrPrefix(replyNodes(item)
        .filter((m) => !(excludeSel && m.closest(excludeSel)))
        .map((m) => textWithout(m, excludeSel)).join("\n"));
    }
    return isUserItem(item)
      ? stripSrPrefix(textWithout(item, excludeSel))
      : textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  // 2026-11-18: the desktop markup NESTS the two turn wrappers - the outer
  // [data-turn-key] contains an inner [data-talvt-turn-state] around the same
  // message pair. Querying S.msg returned BOTH, so one real turn counted twice:
  // measured live, users=2 / assistant=3 for a single exchange. That inflates
  // every count-based decision (landed(), sys.tally's user budget - which then
  // "spends" 2 user slots per turn and re-states the prompt early). Collapse
  // nested TURN wrappers onto the outermost one; role-bearing legacy items
  // (data-message-author-role / DilResponseRoot) are never dropped.
  const allItems = () => {
    const list = [...document.querySelectorAll(S.msg)];
    return list.filter((el) => {
      if (!isTurnKeyItem(el)) return true;
      const up = el.parentElement && el.parentElement.closest(TURN_SEL);
      return !up;
    });
  };
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const getEditor = () => {
    const editors = [...document.querySelectorAll(S.editor)];
    return editors.find((ed) => ed.getClientRects().length > 0) || editors[0] || null;
  };
  const editorText = () => {
    const e = getEditor();
    return e ? (e instanceof HTMLTextAreaElement ? e.value : e.textContent || "") : "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };
  // Stable per-turn identity (a UUID assigned at message creation, present while
  // streaming). ChatGPT VIRTUALIZES long conversations - older turns are detached
  // from the DOM as you scroll - so assistantCount() goes flat/drops and a
  // count-based "new reply" test stalls until the user scrolls. Identity of the
  // LAST node is virtualization-proof: we never count detached siblings.
  // The core also uses itemKey to dedupe turns (turnKey) so a scrolled-back old
  // command can't collide with a current one on its list index. It is a UUID, not
  // a monotonic number, so the core's numeric "old id" shortcut simply doesn't
  // apply here (Number(uuid) is NaN and that guard is skipped) - the
  // settled-history guard covers the same case provider-agnostically.
  // The 2026-11 turn no longer carries data-message-id (measured live: 0 turns,
  // 0 descendants), so the key MUST come from data-turn-key. Without it itemKey
  // returned null and core's turnKey() fell back to a POSITIONAL index, which
  // collides as soon as scrolling changes the rendered window - the guard then
  // misses and the resume watchdog re-fires a historical tool.
  const itemKey = (item) => {
    if (!item || !item.getAttribute) return null;
    const direct = item.getAttribute("data-turn-key")
      || item.getAttribute("data-message-id");
    if (direct) return direct;
    // 2026-11-18 layout: the wrapper carries no id, but each bubble does
    // (data-chatgpt-search-message-ids, one per side). Joining them gives a
    // stable per-turn identity, so dedupe keeps working instead of falling back
    // to a positional index that collides when scrolling re-renders turns.
    try {
      const ids = [...item.querySelectorAll("[data-chatgpt-search-message-ids]")]
        .map((n) => n.getAttribute("data-chatgpt-search-message-ids"))
        .filter(Boolean);
      if (ids.length) return ids.join("|");
    } catch {}
    return null;
  };
  const lastAssistantId = () => itemKey(lastAssistant());

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: the "/" route (a conversation is /c/<id>), composer
  // rendered, no turns. An existing conversation that is still loading has a
  // /c/<id> path, so it never gates.
  const isFreshChat = () =>
    chatIsEmpty() && location.pathname === "/" && !!getEditor();

  // The composer box the Start gate hides as one unit (the form around the editor).
  const composerFrame = () => {
    const ed = getEditor();
    return ed ? (ed.closest("form") || ed.parentElement) : null;
  };

  // The scrollable band that actually shows the typed text. The editor node
  // itself GROWS with its content (this box scrolls it, max ~245px), so sizing
  // the "Agent is working…" cover to the editor and clamping it left a strip of
  // raw result peeking above and below the cover on a big send. Covering this box
  // instead matches exactly what is visible. It is its own grid cell, so the "+"
  // button and the right-hand icons stay outside the cover and remain usable.
  const coverTarget = () => {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("[class*='prosemirror-parent']") || ed;
  };

  // Where the snapgentV3 bar lives: INSIDE the rounded composer surface (the
  // element carrying --composer-surface-primary), like DeepSeek - not floating
  // above it, which is narrower than the composer and covers the page's greeting.
  //
  // That surface lays its children out in a CSS grid. A child with no grid-area
  // gets auto-placed into a cell and steals the editor's column - validated live:
  // the input collapsed to zero width. So does a child naming an area the
  // template does NOT define, which is what ChatGPT's 2026-09 redesign caused:
  // the template went from
  //   "header header header" / "leading primary trailing" / ". footer ."
  // to the single-column
  //   "eyebrow" / "controls" / "body"
  // and our `grid-area: header` (overlay.css) suddenly named nothing, so the bar
  // was auto-placed into implicit tracks - a stray row at the bottom right of the
  // composer, editor back to zero width.
  // overlay.css now says `eyebrow`; topArea() re-derives the name from the LIVE
  // template so the next rename costs an inline style, not a broken composer.
  // Both templates put the full-width, empty-by-default row FIRST, which is the
  // slot we want.
  function topArea(box) {
    try {
      const t = getComputedStyle(box).gridTemplateAreas || "";
      const first = t.match(/"([^"]+)"/);
      // Only a first row that is ONE area edge to edge is safe to claim blindly
      // (spelled "eyebrow" today, "header header header" before) - a top row
      // genuinely split between several areas is not a banner slot, so leave the
      // CSS be rather than steal a column.
      if (first) {
        const names = first[1].trim().split(/\s+/);
        if (names[0] !== "." && names.every((n) => n === names[0])) return names[0];
      }
    } catch {}
    return null;
  }

  function barMount() {
    const ed = getEditor();
    if (!ed) return null;
    const box = ed.closest("[class*='composer-surface']");
    if (!box) return null;
    const area = topArea(box);
    if (area) {
      const bar = document.getElementById("zs-bar");
      if (bar && bar.style.gridArea !== area) bar.style.gridArea = area;
    }
    // Skip our own bar if already mounted, otherwise we'd insert it before itself.
    let before = box.firstElementChild;
    if (before && before.id === "zs-bar") before = before.nextElementSibling;
    return { parent: box, before, inside: true };
  }

  function barAnchor() {
    const ed = getEditor();
    if (!ed || !(ed instanceof HTMLTextAreaElement)) return null;
    return ed.closest("form") || ed.closest("[data-composer-primary]") || ed;
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // ProseMirror is a contenteditable: flipping contenteditable=false blocks the
  // user, but typeAndSend temporarily re-enables it so our own injection works.
  let _locked = false;
  // Keyboard lock for a PM composer: stop the USER typing without touching
  // contenteditable (which would also disable execCommand for our injection).
  let _lockKeysBound = false;
  function installLockKeydown() {
    if (_lockKeysBound) return;
    _lockKeysBound = true;
    document.addEventListener("keydown", (e) => {
      if (!_locked) return;
      const ed = getEditor();
      if (ed && ed.contains(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  function setInputLock(on) {
    _locked = on;
    installLockKeydown();
    const ed = getEditor();
    if (!ed) return;
    if (ed instanceof HTMLTextAreaElement) {
      if (on) ed.setAttribute("readonly", "");
      else ed.removeAttribute("readonly");
    }
    // NEVER write contenteditable on a ProseMirror composer. PM owns that
    // attribute and re-applies it from its own state, so our write races the
    // editor: the attribute can read "true" while Chrome has already disabled
    // the editing host, and then execCommand("insertText") returns FALSE and
    // types nothing - the exact silent no-op that stranded every send.
    // Live 2026-11-18 13:50-13:53: probe ret:false / enabled:false through six
    // attempts while ce read "true", and the same probe succeeded on a fresh tab
    // (2293 chars typed). ui.inputCover() already blocks the user with an
    // overlay, so the DOM lock is marked, not enforced by the attribute.
    if (on) ed.setAttribute("data-zs-locked", "1");
    else ed.removeAttribute("data-zs-locked");
  }

  // ── Action buttons (send / stop) ──────────────────────────────────────────
  // ChatGPT's composer has ONE submit control, #composer-submit-button, that
  // FLIPS ROLE in place: data-testid="send-button" when idle,
  // data-testid="stop-button" (aria-label "Interrompre la réponse") while
  // generating. Validated live: the two selectors matched the SAME node. So the
  // send button must be tested by ROLE, never by presence - otherwise
  // sendButton() cheerfully returns the stop square and every guarded click is
  // refused. That is exactly what stranded a tool result in the composer and
  // raised "ChatGPT did not accept the injected message after 4 attempts".
  const isStopBtn = (b) => !!b && (
    b.getAttribute("data-testid") === "stop-button" ||
    /\b(stop|interrompre|arrêter)\b/i.test(b.getAttribute("aria-label") || "")
  );
  const submitButton = () => {
    const b = document.querySelector(S.submitBtn);
    return b && b.offsetParent !== null ? b : null;
  };
  const sendButton = () => {
    const b = submitButton();
    return b && !isStopBtn(b) ? b : null;
  };
  const stopButton = () => {
    const b = submitButton();
    return b && isStopBtn(b) ? b : null;
  };

  // ── Generation detection ──────────────────────────────────────────────────
  // The stop button is present for the ENTIRE generation, so detection is simple.
  // Growth tracking covers the instants around start/end AND the wedged-stop case
  // - which DOES happen on ChatGPT (seen live: the reply had finished, yet the
  // submit control stayed in its "Interrompre la réponse" role, so every send was
  // refused and the tool result was stranded in the composer). See unwedgeStop.
  function streamText(item) {
    return item ? textWithout(item, ".zs-chip") : "";
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    // A swap counts as NEW OUTPUT only when the arriving turn carries MORE text
    // than the one we were tracking (a reply grows as it streams). Scrolling just
    // brings an arbitrary older turn into view, usually at the same or a smaller
    // length, so the idle clock must keep running in that case. Resetting it on
    // every swap made a scroll look like generation for GEN_IDLE_MS, which
    // wrongly showed a Stop button and let the watchdog re-fire old commands.
    if (item !== _streamItem || len < _streamMax - 400) {
      const arrivedLonger = len > _streamMax;
      _streamItem = item;
      _streamMax = len;
      if (arrivedLonger) _streamAt = now;
      return;
    }
    // Same turn: only genuine growth refreshes the clock (a large shrink means
    // the site re-rendered the turn, not that it is streaming).
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // A turn that already has its injected result BELOW it is settled history: it
  // cannot be streaming, no matter what sampleStream's growth clock last saw.
  // Scrolling renders such turns as "last assistant", and without this the bar
  // shows a Stop control and the watchdog considers the old command live.
  const turnSettled = (item) => {
    if (!item) return false;
    try {
      const all = allItems();
      const i = all.indexOf(item);
      if (i < 0) return false;
      for (let j = i + 1; j < all.length; j++) {
        const nx = all[j];
        if (nx === item) continue;
        if (isUserItem(nx) && /^\s*Output of '/.test(classifyText(nx, ".zs-chip") || "")) return true;
        if (!isUserItem(nx)) return false;
      }
    } catch {}
    return false;
  };

  const WEDGE_MS = 10000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    // Settled history is never a live generation - checked FIRST so a scroll into
    // an old command turn can never make the bar show Stop or the watchdog fire.
    if (turnSettled(lastAssistant())) { _stopSince = 0; return false; }
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      // Trust the stop button while the stream advances, or just after it
      // appeared (generation spinning up). Frozen past WEDGE_MS ⇒ treat as done.
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  // Clicking the frozen stop returns the control to its send role, so the pending
  // injection can go out. Guarded by genActive so a genuinely live generation is
  // NEVER aborted - during a real stream every attempt below is refused.
  function unwedgeStop() {
    const stop = stopButton();
    if (stop && !genActive()) {
      diag("send.unwedge", {});
      try { stop.click(); } catch {}
      return true;
    }
    return false;
  }

  // One attempt is not enough: genActive() latches true for 2s from the FIRST
  // moment it sees a stop button (_stopSince), so an attempt made right after the
  // page or the turn came up is refused by that latch alone. Retry across the
  // window, then confirm the send role actually came back. (Same reasoning as
  // gemini.js, where a single attempt let the system prompt sit in the composer.)
  async function unwedgeStopPersistently(totalMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < totalMs) {
      if (sendButton()) return true;
      if (unwedgeStop() && await waitFor(() => !!sendButton(), 1500)) return true;
      await sleep(250);
    }
    return !!sendButton();
  }

  // ChatGPT exposes no reliable per-turn "stopped" marker → never halted.
  const turnHalted = () => false;

  // ── Truncation "Continue generating" button ───────────────────────────────
  function findContinueBtn() {
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue;
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }
  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const md = replyNodes(it)[0];
      return { th: 0, rp: md ? (md.textContent || "").length : 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const mds = replyNodes(item);
    return {
      present: true,
      reply: mds.map((m) => textWithout(m, ".zs-chip")).join("\n").trim(),
      thinking: "", // reasoning is gated by the stop button, not parsed as text
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
  // ProseMirror listens to the browser's native editing pipeline, so
  // document.execCommand("insertText") over a select-all reliably replaces the
  // content and fires the input events that enable the send button. Validated
  // live on chatgpt.com.
  // ChatGPT's ProseMirror has the same failure mode as Gemini's Quill: inserting
  // a large result is one uninterruptible synchronous burst on the main thread.
  // Measured live on chatgpt.com, 2026-08:
  //   - one insertText of a 1500-line / 60k-char string: tab frozen >45s, nothing
  //     clickable, no repaint, Stop button dead.
  //   - LINE COUNT is the entire cost, not size: a single 120 000-char line
  //     inserts in 13ms, because each line becomes its own ProseMirror block and
  //     every insert re-renders the document. So the char cap can stay generous
  //     and the line cap is the real lever.
  //   - line-by-line with a yield every N lines, 1200 lines: N=120 -> 11.9s total
  //     with a 4.4s worst freeze; N=25 -> 7.9s total with a 1.0s worst freeze.
  //   - a synthetic PASTE of the same 1200 lines is far faster (18ms), but it is
  //     UNUSABLE here: ChatGPT turns a pasted message into a file attachment on
  //     send. See pasteEditorText for the full story. Typing it is.
  // ChatGPT's own hard input cap, MEASURED live 2026-08-14 (not a guess, and not
  // the perf limit below): the composer's submit button silently goes `disabled`
  // once the editor holds more than ~139 300 characters - 139 300 sends, 139 500
  // does not, reproducible across repeats. It is a CLIENT-side gate, so an
  // oversized message is not rejected with a visible "too long" error, it simply
  // cannot be sent at all; nothing in the bundles exposes the constant, so the
  // boundary was bracketed by filling the editor and reading button.disabled.
  // 120 000 is kept as our cap: it is chosen for the freeze cost documented
  // above, and it happens to sit comfortably under the real ceiling, so a result
  // we are willing to send is always a result ChatGPT will accept.
  const SEND_HARD_CAP = 139300;  // measured; for reference and headroom checks
  const SEND_MAX_CHARS = 120000; // characters are essentially free (see above)
  const SEND_MAX_LINES = 600;    // the line count is what costs, and we type it
  const INSERT_CHUNK_LINES = 25; // measured sweet spot: 3.0s total, 0.4s worst freeze

  function truncateForSend(text) {
    if (!text) return text;
    const lines = String(text).split("\n");
    if (text.length <= SEND_MAX_CHARS && lines.length <= SEND_MAX_LINES) return text;
    const marker = (what) =>
      `\n\n[…snapgentV3: result truncated (${what}) so it can be pasted into ` +
      `ChatGPT's composer without freezing the page. Do NOT re-run the command; ` +
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

  // Select the whole composer, so whatever we insert REPLACES its contents.
  function selectAll(ed) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // DO NOT USE for injected sends - kept only for reference/fallback.
  //
  // A synthetic paste is by far the fastest way to fill this composer (18ms for
  // 1200 lines vs 7.9s of typing) - but ChatGPT REMEMBERS that the content was
  // pasted and, on submit, materialises it as a "Texte collé.txt" / "Pasted
  // text.txt" DOCUMENT ATTACHMENT instead of an inline message. Seen live: the
  // system prompt went out as a file, which burns the free tier's SEPARATE
  // "chats with files or images" quota and then paused the whole conversation
  // ("Chat en pause jusqu'à la réinitialisation du quota").
  //
  // The conversion is not visible at paste time - the text really is in the
  // composer, and pasting up to 400 lines / 20k chars showed no attachment chip.
  // It happens at SEND. So there is nothing to detect and fall back from: the
  // only safe path is to never paste an injected message in the first place.
  async function pasteEditorText(ed, text) {
    selectAll(ed);
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // ProseMirror applies the paste asynchronously; confirm it actually landed
    // before reporting success, so the caller can fall back if it did not.
    const want = text.trim();
    if (!want) return true;
    return await waitFor(() => (ed.textContent || "").trim().length > 0, 3000);
  }

  // The composer is NOT always open for input. ChatGPT flips its
  // contenteditable attribute to "false" while a reply streams AND during
  // ordinary React re-renders: measured live 2026-11-18 on an idle tab, ce read
  // "false" again 6.3s and 8.4s after a reload with nothing generating. In that
  // window execCommand("insertText") returns FALSE and inserts NOTHING, without
  // throwing - so the old code reported the send as typed while the composer
  // stayed empty (send.insertDone + send.typed len:0/want:2826, then a fake
  // send.cleared and the bar stuck on "Starting…").
  function editorReady(ed) {
    if (!ed || !ed.isConnected) return false;
    if (ed instanceof HTMLTextAreaElement) return !ed.readOnly && !ed.disabled;
    // Only the attribute matters here. queryCommandEnabled("insertText") is
    // NOT usable as the gate: it reports false whenever the tab is not the
    // focused window (measured live 2026-11-18 13:43 - ce was "true" and the
    // first send typed 2211/2211, yet queryCommandEnabled stayed false and
    // blocked every attempt). The real proof stays the execCommand return value
    // plus the length read-back, never this query.
    return ed.getAttribute("contenteditable") === "true";
  }

  async function waitEditorReady(timeout) {
    const t0 = Date.now();
    for (;;) {
      const ed = getEditor();
      // NEVER write contenteditable on a ProseMirror composer, not even as a
      // "heal". PM owns that attribute and re-applies it from its own state, so
      // our write races the editor: the attribute ends up reading "true" while
      // Chrome has already disabled the editing host, and from then on every
      // execCommand("insertText") returns false and types nothing. Live
      // 2026-11-18 (Chrome 157): the heal wrote "true", the first send typed
      // 2211/2211, and every later send was a silent no-op. Typing now goes
      // through the MAIN-world tap (typeViaMain) and the DOM lock is an overlay,
      // so a wedged attribute is left exactly as ChatGPT set it.
      if (editorReady(ed)) {
        try { ed.focus(); } catch {}
        return ed;
      }
      if (Date.now() - t0 >= timeout) return null;
      await sleep(60);
    }
  }

  // Fallback: type it. Yielding does not make this faster - it keeps the page
  // alive while it happens, so the user can still click (and Stop still works).
  // Returns false when the composer REFUSED the input, so the caller retries
  // instead of clicking send on an empty box.
  // Ask the MAIN-world tap (providers/chatgpt-cm.js) to do the typing. See the
  // bridge's header: after the first send, THIS world's execCommand("insertText")
  // returns false for the rest of the page's life while the attribute still reads
  // contenteditable="true", and the identical call from the page's own world
  // succeeds on that same page at that same instant. Returns {ok, len, err} or
  // null when the tap is not installed (the caller then types locally).
  async function typeViaMain(ed, text) {
    if (!ed || !ed.isConnected) return null;
    const id = "zs" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return await new Promise((resolve) => {
      let settled = false;
      const onDone = (ev) => {
        let d = null;
        try { d = JSON.parse(ev.detail || "{}"); } catch { return; }
        if (!d || d.id !== id) return;
        settled = true;
        document.removeEventListener("zs-type-done", onDone, true);
        resolve(d);
      };
      document.addEventListener("zs-type-done", onDone, true);
      try {
        document.dispatchEvent(new CustomEvent("zs-type", {
          detail: JSON.stringify({ id, text: String(text), sel: S.editor }),
        }));
      } catch (e) {
        return resolve({ ok: false, len: 0, err: "dispatchFailed", path: "main" });
      }
      // The bridge answers after ProseMirror's observer turn; never hang the send.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        document.removeEventListener("zs-type-done", onDone, true);
        resolve(null);
      }, 4000);
    });
  }

  async function typeEditorText(ed, text) {
    if (ed instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      if (setter && setter.set) setter.set.call(ed, text);
      else ed.value = text;
      ed.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
      return true;
    }
    // MAIN-world first: this world's execCommand dies after the first send on a
    // long-lived ChatGPT tab (see typeViaMain). Only fall through to the local
    // ladder when the tap is missing or it provably typed nothing.
    const viaMain = await typeViaMain(ed, text);
    if (viaMain) {
      diag("send.typedMain", {
        ok: !!viaMain.ok,
        len: viaMain.len,
        want: String(text).length,
        err: viaMain.err || null,
        path: viaMain.path || null,
      });
      if (viaMain.ok && viaMain.len > 0) return true;
    }
    selectAll(ed);
    // Recovery ladder. A composer that reports contenteditable="true" can still
    // refuse execCommand ("insertText" returns false, nothing lands). Live
    // 2026-11-18 13:50: the extension got ret:false/enabled:false on a page where
    // the very same probe succeeded in BOTH the main and an isolated world via
    // CDP, so the refusal is about this element's editing-host state, not the
    // world. Re-establish it the way a user click would, then place the caret
    // INSIDE the editable instead of selecting at the element boundary.
    let kicked = false;
    const kick = () => {
      kicked = true;
      try {
        ed.scrollIntoView({ block: "nearest" });
      } catch {}
      try {
        const r0 = ed.getBoundingClientRect();
        const o = {
          bubbles: true, cancelable: true, composed: true, view: window, button: 0,
          clientX: r0.left + Math.min(Math.max(r0.width / 2, 8), 60),
          clientY: r0.top + Math.max(r0.height / 2, 8),
        };
        ed.dispatchEvent(new PointerEvent("pointerdown", o));
        ed.dispatchEvent(new MouseEvent("mousedown", o));
        ed.dispatchEvent(new PointerEvent("pointerup", o));
        ed.dispatchEvent(new MouseEvent("mouseup", o));
        ed.dispatchEvent(new MouseEvent("click", o));
      } catch {}
      try { ed.focus(); } catch {}
      try {
        const s = window.getSelection();
        const r = document.createRange();
        r.selectNodeContents(ed);
        r.collapse(false);
        if (s) { s.removeAllRanges(); s.addRange(r); }
      } catch {}
    };
    const lines = String(text).split("\n");
    const t0 = Date.now();
    for (let i = 0; i < lines.length; i++) {
      // execCommand has no failure mode except a false return: a disabled
      // composer, a detached node, or a lost selection all come back as false
      // and are silent no-ops. On the first refusal take one recovery step and
      // retry the line once; if it is refused again, bail out so the caller can
      // wait for readiness and retype on a fresh node.
      let ok = true;
      if (lines[i]) {
        ok = document.execCommand("insertText", false, lines[i]);
        if (!ok && !kicked) {
          kick();
          selectAll(ed);
          ok = document.execCommand("insertText", false, lines[i]);
          diag("send.recover", { ok, line: i, ce: ed.getAttribute("contenteditable") });
        }
        if (!ok) {
          diag("send.insertRejected", { line: i, lines: lines.length, ms: Date.now() - t0 });
          return false;
        }
      }
      // insertLineBreak, never a synthetic Enter: Enter is what SENDS on ChatGPT.
      if (i < lines.length - 1) document.execCommand("insertLineBreak");
      if (i && i % INSERT_CHUNK_LINES === 0) await sleep(0);
    }
    if (lines.length > INSERT_CHUNK_LINES) diag("send.insertDone", { lines: lines.length, ms: Date.now() - t0 });
    return true;
  }

  // Typing is the ONLY path for injected sends: it is slower, but it produces a
  // real inline message instead of a file attachment (see pasteEditorText).
  async function setEditorText(ed, text) {
    return await typeEditorText(ed, text);
  }

  async function typeAndSend(text, images) {
    let ed = getEditor();
    if (!ed) throw new Error("ChatGPT input box not found");
    text = truncateForSend(text);
    const relock = _locked;
    const setEditable = (editable) => {
      if (ed instanceof HTMLTextAreaElement) {
        if (editable) ed.removeAttribute("readonly");
        else ed.setAttribute("readonly", "");
      }
      // A ProseMirror composer is NEVER locked by writing contenteditable:
      // doing that after a send left the editor in a state where Chrome had
      // disabled every edit command while the attribute still read "true", so
      // the NEXT send (the tool output) was a silent no-op. Live 2026-11-18
      // 11:27: CONTEXT typed 2211/2211, then the tool output was rejected with
      // send.typed len:0/want:2826 - because typeAndSend had re-locked the
      // composer right after the first send. The user is blocked by the input
      // cover plus installLockKeydown() instead.
    };
    // Only a <textarea> composer needs its readonly attribute cleared; PM
    // composers must keep their own contenteditable (see setInputLock).
    if (relock && ed instanceof HTMLTextAreaElement) setEditable(true);
    // A WEDGED stop square (submit control stuck in its stop role with nothing
    // generating) used to be discovered only AFTER the whole text was typed:
    // typeAndSend waited 1500ms for a send role that never came, then unwedged,
    // and the core burned a full retry - measured live at Start, that single
    // wasted cycle added ~45s before the system prompt landed (send.cleared
    // arrived at tries:2, 11:11:51, after the click at 11:10:05). Clear the wedge
    // first so the click is ready the moment the text is in.
    try {
      if (stopButton() && !genActive()) await unwedgeStopPersistently();
    } catch {}
    try {
      // React REPLACES the composer node twice per turn: when the reply starts
      // streaming AND again the moment generation ends - which is exactly when
      // the unwedgeStopPersistently() above returns. A handle captured before
      // that remount points at a DETACHED node: ed.focus() moves no selection,
      // execCommand("insertText") is a silent no-op, while editorText() (it
      // re-queries getEditor()) reads the NEW empty composer. Measured live
      // 2026-11-18 11:27: the CONTEXT send typed 2211/2211, then the 82-line
      // tool output reported send.insertDone and len 0/2826 - and the core's
      // "composer is empty" gate called that a successful send (send.cleared),
      // so the reply never came and the bar sat on "Starting…" forever.
      // So: (re)acquire the editor right before typing and retype on a FRESH
      // node until the text is provably in the composer.
      try {
        const eds = [...document.querySelectorAll(S.editor)];
        const ae = document.activeElement;
        const sel = window.getSelection();
        diag("send.edstate", {
          n: eds.length,
          connected: !!(ed && ed.isConnected),
          rects: ed ? ed.getClientRects().length : -1,
          ce: ed ? ed.getAttribute("contenteditable") : null,
          activeIsEd: ae === ed,
          activeTag: ae ? ae.tagName : null,
          selInEd: !!(sel && sel.anchorNode && ed && ed.contains(sel.anchorNode)),
          locked: _locked,
        });
      } catch (e) { diag("send.edstate", { err: String(e).slice(0, 80) }); }
      let got = 0;
      // Typing only counts when the composer actually took it: wait for it to
      // accept input (contenteditable "true" + insertText enabled), retype on a
      // FRESH node, and prove the text landed by reading it back.
      for (let attempt = 0; attempt < 6 && !got; attempt++) {
        if (attempt) await sleep(150 * attempt);
        const ready = await waitEditorReady(attempt ? 1200 : 4000);
        if (!ready) {
          diag("send.notReady", {
            attempt,
            n: document.querySelectorAll(S.editor).length,
            ce: (getEditor() || {}).getAttribute
              ? getEditor().getAttribute("contenteditable")
              : null,
          });
          continue;
        }
        ed = ready;
        const accepted = await setEditorText(ed, text);
        if (!accepted) diag("send.refused", { attempt });
        got = editorText().length;
      }
      diag("send.typed", { len: got, want: text.length });
      // Nothing in the composer means the send would carry an empty message.
      // Report it instead of clicking: the core then retries the whole send
      // (and must NOT read the empty composer as proof of a successful send).
      if (!got) {
        diag("send.typedFailed", { want: text.length });
        return false;
      }
      // Attach images LAST, right before the send click - see gemini.js/deepseek.js
      // typeAndSend for why (attaching first and then retyping the text can sever
      // the site's binding between the pending upload and the message sent).
      if (images && images.length) {
        try { await attachImages(images); } catch {}
        // ChatGPT disables the send button while an upload is still in flight, so
        // poll the click instead of gating on a specific "upload done" node.
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          const b = sendButton();
          if (b && !b.disabled) { try { b.click(); } catch {} }
          if (await waitFor(() => editorText().trim() === "" || !!stopButton(), 1200)) return true;
        }
        return true;
      }
      // Wait for the control to be in its SEND role (proof ProseMirror registered
      // the text, and that no generation is in flight).
      await waitFor(() => !!sendButton(), 1500);
      // Still not a send button? Either a generation really is running (in which
      // case unwedge refuses and we fall through), or the control is stuck in its
      // stop role with nothing generating - the case that stranded the result.
      if (!sendButton()) await unwedgeStopPersistently();
      const btn = sendButton();
      // Disabled send = a quota wall, not a wedge. Clicking it does nothing and
      // Enter is refused too, so return now and let scanError surface the reason
      // instead of burning the caller's retries in silence.
      if (btn && btn.disabled) { diag("send.disabled", {}); return false; }
      if (btn) { btn.click(); return true; }
      // Fallback: Enter sends in ChatGPT's composer.
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
      return true;
    } finally {
      if (relock) setEditable(false);
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  // No site modes to enforce on ChatGPT (model picker is left to the user).
  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "chatgpt" });
    return { ready: !!getEditor() };
  }

  // ── Error / limit detection (site chrome only) ────────────────────────────
  // A quota wall does NOT surface as an error banner: ChatGPT simply DISABLES the
  // send button (disabled=true, opacity .35, still in its send role) and prints a
  // "Chat en pause jusqu'à la réinitialisation du quota" notice. Nothing throws,
  // so without this the loop keeps re-typing into a composer that can never be
  // submitted and the bar sits on "running" forever - which is exactly what has
  // to be avoided. Reported as a normal site error so the core can end the turn
  // and tell the user.
  const sendIsDisabled = () => {
    const b = submitButton();
    return !!b && !isStopBtn(b) && b.disabled;
  };
  // The nastier variant: the control is stuck in its STOP role AND disabled,
  // while nothing is generating. unwedgeStop() cannot help - clicking a disabled
  // button does nothing - and neither does any DOM-side nudge: an input event,
  // blur+focus and a real edit were all tried live and left it at
  // "stop-button (disabled)". Only reloading the page clears it, so the honest
  // move is to say so instead of silently retrying forever.
  const composerWedged = () => {
    const b = submitButton();
    return !!b && isStopBtn(b) && b.disabled && !genActive();
  };
  function pausedNotice() {
    // Only walk the DOM once the cheap signal (a disabled send) already says
    // something is wrong.
    for (const el of document.querySelectorAll("div,p,section")) {
      if (el.offsetParent === null || el.children.length > 6) continue;
      const t = (el.innerText || "").trim();
      if (t.length > 12 && t.length < 400 && RE.paused.test(t)) return t.slice(0, 240);
    }
    return null;
  }
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.msg)) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
      // Composer has our text but ChatGPT refuses to accept it.
      if (editorText().trim() !== "") {
        if (composerWedged()) {
          return "ChatGPT's composer is stuck on \"stop\" and won't send - reload the page to recover this conversation.";
        }
        if (sendIsDisabled()) {
          return pausedNotice() ||
            "ChatGPT will not accept the message - its send button is disabled (quota reached, or the chat is paused).";
        }
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best effort: paste + hidden file input) ─────────────
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
    if (!ed || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // The real upload input (validated live 2026-08); the generic selector is a
    // fallback in case the testid is renamed.
    const fileInput = document.querySelector('input[data-testid="upload-photos-input"]') ||
      document.querySelector('input[type="file"]');
    if (fileInput) {
      try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
    // An upload preview appearing near the composer is the success signal.
    return await waitFor(() => {
      const box = composerFrame();
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']"));
    }, 15000);
  }
  function clearAttachments() {
    try {
      const box = composerFrame();
      if (!box) return;
      box.querySelectorAll("[aria-label*='upprimer'], [aria-label*='emove'], [aria-label*='Remove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  // ── New chat navigation ───────────────────────────────────────────────────
  function findNewChatButton() {
    return document.querySelector('a[data-testid="create-new-chat-button"]') ||
      [...document.querySelectorAll('a[href="/"], button')].find(
        (a) => a.offsetParent !== null && /new chat|nouvelle discussion|nouveau chat/i.test(a.getAttribute("aria-label") || a.textContent || "")
      ) || null;
  }
  async function openNewChat() {
    const btn = findNewChatButton();
    if (!btn) return false;
    const prevPath = location.pathname;
    try { btn.click(); } catch {}
    await waitFor(() => location.pathname !== prevPath && chatIsEmpty() && !!getEditor(), 6000);
    await waitFor(() => chatIsEmpty() && !!getEditor(), 2000);
    return true;
  }

  // "/" = a fresh chat whose conversation id is not assigned yet → "" (transient)
  // so the core never persists it as "started"; /c/<id> = a real conversation.
  const conversationKey = () => (/^\/c\//.test(location.pathname) ? location.pathname : "");

  // ── ChatGPT-only system-prompt rules ──────────────────────────────────────
  // Appended to the shared system prompt via core/config.js's `providerNotes`
  // hook, so no other provider sees a word of this.
  //
  // Why ChatGPT needs the image rule and the others don't: ChatGPT reaches for
  // its own image GENERATION on any turn that carries an image, and answers by
  // producing a new picture instead of doing the Roblox work the image was
  // meant to illustrate. Its native image tool also runs in the sandbox that
  // cannot touch the user's project, so a generated image is a dead end here.
  const PROMPT_EXTRA = `- WHEN THE USER SENDS AN IMAGE: by default it is REFERENCE MATERIAL for the work they want done in their project - a screenshot of a bug, a mockup of the UI they want, a photo of the thing to build, a picture of what is wrong in Studio. Look at it, use it to understand what they want, and then do that work with the snapgentV3 commands. Do NOT generate a new image from it, and do NOT treat it as an image-editing request. Only generate an image when the user EXPLICITLY asks you to create, generate, draw or edit one ("make me an image of...", "generate a texture", "edit this picture"). If what they want from the image is genuinely unclear, ask them in one short sentence rather than guessing - and never guess "they want a picture".`;

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
        // No session yet → nudge toward Start, but NEVER block the send. The
        // user is entitled to just chat with ChatGPT; the extension is opt-in.
        // This used to preventDefault + stopImmediatePropagation (ported from an
        // older, stricter pattern), which made a blank ChatGPT tab impossible to
        // type in until an agent was started - a regression against every other
        // provider. Matches deepseek.js: "nudge only; never block plain chat".
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt();
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
        const t = e.target;
        // Native "Continue generating" = a clear intent to RESUME after truncation.
        const cont = t && t.closest && t.closest("button");
        if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        // Stop is tested FIRST: it is the same node as send, just in its other
        // role, so a stop click would otherwise read as a user send.
        const stop = t && t.closest && t.closest(S.stopBtn);
        if (stop) { handlers.onNativeStop(); return; }
        const btn = t && t.closest && t.closest(S.submitBtn);
        if (!btn || isStopBtn(btn)) return;
        if (handlers.isBlocked()) return;
        // Same as the keydown path: nudge, never block (see the comment there).
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // ChatGPT wraps each fenced code block in ONE <pre> inside .markdown (markers
  // and JSON survive intact in textContent), so a whole ###LUA###…###END_LUA###
  // or JSON command block is one atomic <pre>. Hide every <pre> in the reply
  // whose text carries a command shape, plus any bare top-level paragraph that
  // holds an inline command (the model is told to use code blocks, but this
  // catches a stray inline one). React re-creates these nodes on every token, so
  // - like Gemini - we also mark the .markdown container with .zs-cmd-mask; the
  // overlay.css rule keeps every recreated <pre> hidden with no flash.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  // Marker pair, for the UNFENCED case below. Kept separate from CMD_SHAPE so the
  // opener test can't also match the closer.
  const CMD_OPEN = /###\s*(?:LUA|MCP_TOOL)\s*###/i;
  const CMD_CLOSE = /###\s*END_(?:LUA|MCP_TOOL)\s*###/i;

  function findToolBlockSpot(item /*, chip */) {
    const replies = replyNodes(item);
    let hidAny = null;
    const hide = (el, mc) => {
      el.classList.add("zs-tool-hide");
      if (mc) mc.classList.add("zs-cmd-mask");
      hidAny = hidAny || { parent: el.parentElement, ref: el };
    };
    for (const mc of replies) {
      // 1. Fenced code blocks carrying a command.
      mc.querySelectorAll(S.codeWrap).forEach((pre) => {
        if (pre.closest(".zs-chip")) return;
        if (!CMD_SHAPE.test(pre.textContent || "")) return;
        // 2026-11-18: hide the WHOLE fenced-code CARD, not just its <pre>.
        // ChatGPT now renders every fenced block as a card whose own header row
        // carries the language label ("</> JSON") plus copy/expand buttons. The
        // <pre> is a descendant, so masking only it left an EMPTY grey "JSON"
        // card sitting directly above our chip: the raw payload was gone but a
        // large blank box made the turn look broken/frozen (reported live:
        // "tampilannya masih kayak gini, loadingnya kayak macet"). Marking the
        // card keeps the header hidden too; the .zs-cmd-mask rule in overlay.css
        // re-hides a RE-CREATED card on the next React render (per-element
        // classes are wiped there, the container class is not).
        const card = pre.closest('[class*="CodeBlock-"]') || pre.closest('[class*="InlineCodePane-"]');
        hide(pre, mc);
        if (card && card !== pre && mc.contains(card)) hide(card, mc);
      });
      // 2. Bare top-level blocks with an inline command (no <pre> inside).
      const kids = [...mc.children];
      kids.forEach((el) => {
        if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
        const t = el.textContent || "";
        if (t.length < 600 && CMD_SHAPE.test(t)) hide(el, null);
      });
      // 3. UNFENCED command block spanning MANY siblings. Seen live 2026-08: the
      // model wrote ###LUA###…###END_LUA### as plain prose instead of a fenced
      // block, so ChatGPT's markdown renderer split a 208-line payload into 68
      // sibling <p>/<pre> nodes. Only the first one carries the marker, so the
      // per-element tests above hid the opener and left the whole script on
      // screen. Hide the RANGE: from the opener to the sibling holding the
      // closer (inclusive). Un-closed (still streaming) ⇒ hide to the end, so
      // there is no flash of raw code while it types.
      let ranged = 0;
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el.classList.contains("zs-chip")) continue;
        const t = el.textContent || "";
        if (!CMD_OPEN.test(t)) continue;
        if (CMD_CLOSE.test(t)) { hide(el, mc); ranged++; continue; } // all in one node
        for (let j = i; j < kids.length; j++) {
          const k = kids[j];
          if (k.classList.contains("zs-chip")) continue;
          hide(k, mc); ranged++;
          if (CMD_CLOSE.test(k.textContent || "")) { i = j; break; }
        }
      }
      // Anti-reflash for the ranged case. .zs-cmd-mask only re-hides recreated
      // <pre>; the <p> siblings of an unfenced block carry nothing but their
      // per-element class, which React wipes on every token. When the range
      // covers the WHOLE reply (the observed shape - the message IS the command),
      // mark the container so every child stays hidden through re-renders. If any
      // real prose sits outside the range, we do NOT: hiding it would eat the
      // model's actual answer, and a per-token flash is the lesser evil.
      if (ranged) {
        const body = kids.filter((k) => !k.classList.contains("zs-chip"));
        if (body.length && body.every((k) => k.classList.contains("zs-tool-hide"))) {
          mc.classList.add("zs-cmd-mask-all");
        }
      }
    }
    return hidAny;
  }

  return {
    id: "chatgpt",
    displayName: "ChatGPT",
    timings,
    // Exported for test-chatgpt.js (the Node smoke test drives it against a stub
    // DOM). The core reads replies through itemText/classifyText, not this.
    textWithout,
    // Internal helpers exposed ONLY so the Node tests can pin them down. They
    // are pure string functions with no DOM dependency, and none of them is
    // reachable from the core, so this does not widen the provider's surface.
    __test: { stripAssistantSrPrefix, LOOKS_GLUED, turnSettled },
    // Vision OFF, like DeepSeek's text-only Expert tab. ChatGPT's free tier caps
    // image/file input separately from messages ("les fichiers, les images et
    // l'analyse sont indisponibles jusqu'à la réinitialisation de votre quota"),
    // so screen_capture would work sometimes and fail the rest of the time - the
    // worst kind of behaviour to hand a model. The core blocks the vision tools
    // outright instead (see main.js VISION_TOOLS).
    supportsVision: false,
    // No coverOffsetY: the cover is centred on coverTarget(), the scrolling text
    // band, whose rect centre already lines up with the composer's icons. (Sizing
    // it to the EDITOR needed a -paddingBottom/2 nudge, because that node carries
    // bottom padding as growth headroom - covering the band removes the need.)
    // React re-renders a turn's content subtree on every token, wiping any chip
    // placed inside it. Anchor chips at the turn-element level (the stable
    // data-message-author-role div), where they survive those re-renders.
    chipAtItemLevel: true,
    // ChatGPT's turn elements are semantic (data-message-author-role) and carry
    // a stable id, so the core's "has THIS send produced its reply turn yet?"
    // gate is trustworthy here - it keys off lastAssistantId, which survives the
    // list virtualization that would break a count-based test.
    reliableCounts: true,
    // No unstableWarning: the free-tier caps are real, but the pill it renders is
    // a permanently-visible floating element and it sat ON TOP of ChatGPT's own
    // Settings dialog (seen live). ChatGPT already says so itself, in the thread,
    // when a quota runs out - that is a better place for the message than a badge
    // that outranks the site's modals.
    init({ diag: d } = {}) {
      if (d) diag = d;
      // Version beacon: stamp the loaded build onto <html> so a reload can be
      // confirmed from the page (read document.documentElement.dataset.zsGptVer).
      try { document.documentElement.setAttribute("data-zs-gpt-ver", "2026-08-13_cmtap+toolkey"); } catch {}
    },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    // camouflage: which subtree of a dual-side turn carries the injected text
    injectedHideNode,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount, barAnchor,
    // Cover the scrolling text band, and lift the core's 200px clamp past that
    // band's own ~245px ceiling so a full composer is covered edge to edge.
    coverTarget,
    coverMaxH: 280,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, openNewChat, conversationKey,
    // Selector for a transcript turn, so core can tell a scroll of the
    // conversation from a scroll of unrelated chrome (sidebar, composer).
    msgSel: S.msg,
    // Submit-control selector, so a test can guard the 2026-11-18 markup (the
    // send control lost its id/data-testid and became a bare aria-label).
    submitSel: S.submitBtn,
    installSendHooks, findToolBlockSpot,
    promptExtra: PROMPT_EXTRA,
    // ChatGPT summarises its own context aggressively and loses the "an
    // extension executes this" part, then refuses to call commands at all. No
    // other provider has shown this, so no other provider sets these - they
    // stay on the single bootstrap prompt.
    resendSystemEvery: 6,   // user turns between re-statements
    // Ceiling for "result + system-prompt rider". Measured against the real cap
    // (SEND_HARD_CAP) rather than our 120k perf cap: the rider is added AFTER
    // truncateForSend, so budgeting at 120k would needlessly defer the rider for
    // every result over ~109k even though ChatGPT would accept the pair fine.
    // The margin absorbs the rider growing with a long user custom prompt.
    sendCharBudget: SEND_HARD_CAP - 4000,
  };
})();
