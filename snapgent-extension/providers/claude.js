// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js - the Claude (claude.ai) provider.
// Claude's DOM changes periodically; selectors below prefer test IDs and
// semantic attributes, with contenteditable/button fallbacks for the composer.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};
  let locked = false;
  let lockedEditor = null;

  const S = {
    user: '[data-testid="user-message"]',
    assistant: '[data-testid="assistant-message"]',
    editor: [
      '[data-testid="chat-input"] [contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
      '.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
    ].join(","),
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
    ].join(","),
    stop: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
    ].join(","),
    thinking: '[data-testid*="thinking"],[class*="thinking"],[class*="reasoning"]',
    errors: '[role="alert"],[data-testid*="error"],[class*="error-message"]',
  };

  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 60000,
    REASON_NOREPLY_MS: 120000,
    STABLE_MS: 10000,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const without = (root, excludeSel) => {
    if (!root) return "";
    const skip = [".zs-chip", S.thinking, excludeSel].filter(Boolean).join(",");
    let text = "";
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches(skip)) return;
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return text;
  };

  const isAssistantItem = (item) => !!item &&
    (item.matches(S.assistant) || !!item.querySelector(S.assistant));
  const isUserItem = (item) => !!item &&
    (item.matches(S.user) || (!isAssistantItem(item) && !!item.querySelector(S.user)));
  const allItems = () => {
    const items = [...document.querySelectorAll(`${S.user},${S.assistant}`)];
    return items.filter((item) => !item.closest("#zs-root"));
  };
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };
  const bodyOf = (item) => {
    if (!item) return null;
    return item.matches(S.assistant) ? item : item.querySelector(S.assistant);
  };
  const itemText = (item) => isAssistantItem(item)
    ? without(bodyOf(item))
    : without(item);
  const classifyText = (item, excludeSel) => without(
    isAssistantItem(item) ? bodyOf(item) : item,
    excludeSel
  );
  const chatIsEmpty = () => allItems().length === 0;

  function getEditor() {
    if (locked && visible(lockedEditor) &&
        !lockedEditor.closest("#zs-root") && !lockedEditor.closest(S.user) &&
        !lockedEditor.closest(S.assistant)) return lockedEditor;
    for (const editor of document.querySelectorAll(S.editor)) {
      if (!editor.closest("#zs-root") && !editor.closest(S.user) &&
          !editor.closest(S.assistant) && visible(editor)) return editor;
    }
    return null;
  }
  const editorText = () => {
    const editor = getEditor();
    return editor ? (editor.innerText || editor.textContent || "") : "";
  };
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  const composerFrame = () => {
    const editor = getEditor();
    return editor && (editor.closest("form") || editor.parentElement);
  };
  const barMount = () => {
    const frame = composerFrame();
    // Mount ABOVE the whole composer card (outside it) so the bar never overlaps
    // the editor's absolutely-positioned placeholder ("Reply"). The card is the
    // nearest ancestor of the editor with a visible border and a large radius.
    let card = frame;
    const editor = getEditor();
    for (let el = editor, i = 0; el && el !== document.body && i < 12; el = el.parentElement, i++) {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.borderTopLeftRadius) >= 16 && parseFloat(cs.borderTopWidth) > 0) {
        card = el;
        break;
      }
    }
    return card && card.parentElement ? { parent: card.parentElement, before: card } : null;
  };

  const ids = new WeakMap();
  let nextId = 0;
  function lastAssistantId() {
    const item = lastAssistant();
    if (!item) return null;
    if (!ids.has(item)) ids.set(item, ++nextId);
    return ids.get(item);
  }
  const streamText = (item) => without(bodyOf(item));
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;
  let sampledItem = null;
  let sampledLen = 0;
  let grewAt = 0;
  function sampleStream() {
    const item = lastAssistant();
    const length = streamText(item).length;
    const now = Date.now();
    if (item !== sampledItem || length < sampledLen - 400) {
      sampledItem = item;
      sampledLen = length;
      grewAt = now;
    } else if (length > sampledLen) {
      sampledLen = length;
      grewAt = now;
    }
  }
  const stopButton = () => [...document.querySelectorAll(S.stop)].find(visible) || null;
  const isHardGenerating = () => !!stopButton();
  const isGenerating = () => {
    sampleStream();
    return isHardGenerating() || (sampledLen > 0 && Date.now() - grewAt < timings.GEN_IDLE_MS);
  };
  const isBusyNow = isGenerating;

  function snapshot() {
    return { th: 0, rp: streamLen() };
  }
  function readAssistant() {
    const item = lastAssistant();
    return {
      present: !!item,
      reply: item ? without(bodyOf(item)).trim() : "",
      thinking: "",
      item,
    };
  }
  async function waitFor(predicate, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(120);
    }
    return false;
  }

  function setInputLock(on) {
    const editor = on ? getEditor() : (lockedEditor || getEditor());
    locked = on;
    lockedEditor = on ? editor : null;
    if (editor) editor.setAttribute("contenteditable", on ? "false" : "true");
  }
  function writeText(editor, text) {
    editor.focus();
    editor.setAttribute("contenteditable", "true");
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || editorText().trim() !== text.trim()) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }
    if (locked) editor.setAttribute("contenteditable", "false");
  }
  const sendButton = () => [...document.querySelectorAll(S.send)].find(visible) || null;
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Claude input box not found");
    const beforeUsers = userCount();
    writeText(editor, text);
    const ready = await waitFor(() => {
      const button = sendButton();
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }, 10000);
    const button = sendButton();
    if (!ready || !button || button.disabled ||
        button.getAttribute("aria-disabled") === "true") {
      throw new Error("Claude send button did not become available");
    }
    button.click();
    await waitFor(() =>
      editorText().trim() === "" || userCount() > beforeUsers || isHardGenerating(),
    5000);
  }
  function stopGeneration() {
    const button = stopButton();
    if (button) button.click();
  }
  const enforceComposer = () => ({ ready: !!getEditor() });
  async function ensureComposerReady(reason) {
    const ready = !!getEditor();
    diag("mode_ready", { reason, provider: "claude", ready });
    return { ready };
  }

  function scanError() {
    try {
      const conversation = document.querySelector('[data-testid*="conversation"]');
      for (const el of document.querySelectorAll(S.errors)) {
        if (!visible(el) || el.closest("#zs-root")) continue;
        if (conversation && conversation.contains(el)) continue;
        const text = (el.innerText || el.textContent || "").trim();
        if (text.length > 8 && text.length < 600) return text.slice(0, 240);
      }
    } catch (error) {
      diag("error.scanFailed", { message: String(error && error.message || error) });
    }
    return getEditor() ? null : "The Claude input box is not available.";
  }
  const isTooLongMsg = (text) => /conversation.{0,30}(too long|limit)|context.{0,20}limit/i.test(text);
  const isBusyMsg = (text) => /try again later|temporarily unavailable|rate limit|too many requests/i.test(text);
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;
  const conversationKey = () =>
    location.pathname === "/" || location.pathname === "/new" ? "" : location.pathname;

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor || !editor.contains(event.target) || !editorText().trim()) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("button") : null;
      if (!button || !getEditor()) return;
      if (button.matches(S.stop) || button.closest(S.stop)) {
        handlers.onNativeStop();
        return;
      }
      if (!(button.matches(S.send) || button.closest(S.send)) ||
          button.disabled || button.getAttribute("aria-disabled") === "true") return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const commandShape = /"(?:command|tool)"\s*:\s*"|###\s*(?:lua|mcp_tool)/i;
  function findToolBlockSpot(item) {
    const body = bodyOf(item);
    if (!body) return null;
    let found = null;
    body.querySelectorAll("pre,code,p,li").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide")) return;
      const text = (el.textContent || "").trim();
      if (text && commandShape.test(text)) {
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      }
    });
    return found;
  }

  return {
    id: "claude",
    displayName: "Claude",
    sendRetryLimit: 1,
    supportsVision: false,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages: () => false,
    clearAttachments: () => {},
    conversationKey, installSendHooks, findToolBlockSpot,
  };
})();
